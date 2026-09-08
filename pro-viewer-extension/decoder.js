// Decodes the plain-text POU source embedded inside a CoDeSys V2 / TwinCat PLC .pro
// binary project file. Validated against a manual CoDeSys "Export" of the SecurityDoor
// POU - the declaration + implementation text reconstructs byte-for-byte.
//
// The .pro format stores each POU's declarations and implementation as contiguous
// runs of printable ASCII/CRLF text, separated from each other (and from surrounding
// binary metadata / Visualization objects) by short non-printable framing bytes.

const { checkSt } = require("./stcheck");

const POU_KEYWORDS = ["PROGRAM ", "FUNCTION_BLOCK ", "FUNCTION "];
const MIN_RUN_LENGTH = 20;

// Ladder Diagram POUs use a different, only partially-cracked binary encoding
// (see README "Status / caveats"): most contact/coil references have no
// discoverable name marker at all, and no network/AND-OR delimiter byte was
// found. Editing these would risk silently corrupting real ladder logic, so
// they are never offered as editable regardless of how cleanly they decode.
const KNOWN_LD_POUS = new Set([
	"CanopyControl",
	"ControlledBuffer",
	"HybridControl",
	"GlobalFlags",
	"Intrusion",
	"RearTrack",
]);

// Confirmed tag taxonomy for the LD binary body (see _scratch/decode_ld.py
// Task 1 validation): CONTACT base tag 0x0b, with 0x80 = negated (100% match,
// 0 contradictions across all 6 known LD POUs).
//
// AND/OR grouping is a real nested tree, recovered via many controlled A/B
// edits in TwinCat (2026-09 investigation) by reasoning about rail splits and
// joins rather than "networks have one combinator": between two contact
// records there can be one or more stray bytes that the old scanner silently
// skipped - each such byte OPENS a new bracketed group: 0x09 = AND-group,
// 0x0A = OR-group (optionally OR'd with 0x40, see below). A contact's own tag
// byte can carry 0x40 - this CLOSES the innermost open group, with that
// contact as its last member, popping back to the enclosing group/root. This
// is a simple stack-based grammar and was validated against many real edits,
// including ones deliberately swapping which variable sits in which branch
// and moving whole groups' positions - the tree always reconstructs exactly.
//
// The 0x40 bit also appears standalone on some group-open bytes (0x0A -> 0x4A,
// 0x09 -> 0x49). This looked at first like "not the first group" or "OR not
// AND", but controlled swap tests falsified both: it tracks neither content
// nor top-level position. Best current read: it's set on an open whenever
// that group's eventual close chains, with no further open in between,
// straight through to the network's last contact - i.e. it's on the
// "rightmost spine" of the tree. That looks like a redundant/derivable
// serialization artifact (the kind you'd emit for a variable-length list's
// last item) rather than fresh logical content, so the decoder does NOT rely
// on it: only the low nibble (0x09 vs 0x0A) of an open byte is used to build
// the tree. If a network's bytes don't parse into a fully-closed tree (an
// unrecognized open byte, or unbalanced opens/closes), the whole network
// falls back to the old flat "MIXED, unresolved" rendering rather than
// guessing - see decodeLadderBody's treeOk flag.
const LD_CONTACT_BASE_TAG = 0x0b;
const LD_CONTACT_NEGATED_BIT = 0x80;
// Output coil tags. The `mode` is the ladder coil type, using the IEC 61131-3
// names (the coil type is the meaningful flag for a text editor, not the
// boolean value it drives):
//   DIRECT = direct coil ( )  - coil follows the rung condition (TRUE)
//   SET    = set coil (S)     - coil latches TRUE when rung is true
//   RESET  = reset coil (R)   - coil latches FALSE when rung is true
// The 0x03 tag (NEGATIV/SET) is the reset coil - it was previously mislabeled
// "SET", which rendered `:= NOT TRUE; // SET` instead of the correct
// `:= FALSE; // RESET`. Confirmed against the real ladder view: networks
// 13/14/16/17 are (R) reset, 8/9 are (S) set, 4/5/6 are ( ) direct.
const LD_OUTPUT_TAGS = {
	0x00: { polarity: "POSITIV", mode: "DIRECT" },
	0x02: { polarity: "POSITIV", mode: "SET" },
	0x03: { polarity: "NEGATIV", mode: "RESET" },
};
const LD_TIMELIT_TAG = 0x41;
// FB type name (e.g. "TON", "R_TRIG") when the instance has no PT/time-literal
// operand: stored as an ordinary tagged [tag][len][ascii] record like any
// contact/output. When a PT operand IS present (timer types), the type name
// instead follows the PT record as a bare, tag-less length-prefixed string
// (see readPascalTypeName) - two different encodings for the same field,
// confirmed against BagFound (R_TRIG, no PT) vs RunToRearTimer (TON, has PT).
const LD_FBTYPE_TAG = 0x40;

/** Renders a leaf node as a flat fallback string (used only when the tree
 * couldn't be trusted - see renderLadderNetworks' !treeOk branch): a contact
 * ({name, negated}) or a timer/FB-instance ({name, fb: true, fbType, pt}). */
function renderLeaf(node) {
	if (!node.fb) return node.negated ? `NOT ${node.name}` : node.name;
	const type = node.fbType ? `:${node.fbType}` : "";
	const pt = node.pt ? `PT:=${node.pt}` : "";
	return `${node.name}${type}(${pt})`;
}

// R_TRIG/F_TRIG only have a single boolean input pin, named CLK (see the real
// project's own ST source, e.g. "UpperPEEdge(CLK:=OpenPEFilter.Q);") - every
// other FB type seen in this format (TON/TOF/TP) uses IN/PT like a timer.
const LD_FB_EDGE_TYPES = new Set(["R_TRIG", "F_TRIG"]);

/**
 * Renders a trusted AND/OR tree (see decodeLadderBody) as a single boolean
 * expression, emitting each FB-instance leaf as an inline one-line call
 * (`RunToRearTimer(IN:=BRRunToPE, PT:=T#6000ms)`) whose `IN`/`CLK` is wired
 * from the *immediately preceding* element in the same branch - NOT the whole
 * accumulated chain. The FB's `.Q` output then continues the rail, exactly
 * like the real project's own ST convention (SecurityDoor:
 * "OpenTriggerFilter(IN:=OpenDoor, PT:=t#100ms);"). Returns the rendered
 * expression string; the caller emits the FB calls as their own statements
 * before the IF that references the `.Q` outputs.
 */
function renderTree(node) {
	if (!("children" in node)) {
		if (node.fb) return `${node.name}.Q`;
		return node.negated ? `NOT ${node.name}` : node.name;
	}
	// A single-child group is a redundant wrapper (the parser nests
	// AND[ AND[ ... ] ] around chains) - unwrap it so the FB-collapse below
	// can see through to the real chain.
	if (node.children.length === 1) return renderTree(node.children[0]);
	if (node.type === "AND") {
		// An FB leaf consumes the siblings before it in the same AND chain
		// (they're its IN wiring, already emitted in the FB call statement).
		// So the FB's .Q replaces that whole feeding chain - the condition
		// references only the .Q, not the duplicated input. Mirrors the real
		// project's ST convention (OpenTriggerFilter(IN:=OpenDoor, PT:=t#100ms);
		// then IF OpenTriggerFilter.Q THEN). The collapse must recurse through
		// nested single-child ANDs (the parser often wraps a chain in
		// AND[ AND[ ... ] ]), so find the deepest FB in the AND spine.
		let lastFbIdx = -1;
		for (let i = 0; i < node.children.length; i++) {
			const child = node.children[i];
			if (!("children" in child) && child.fb) lastFbIdx = i;
		}
		if (lastFbIdx >= 0) {
			const parts = [];
			for (let i = lastFbIdx; i < node.children.length; i++) {
				parts.push(renderTree(node.children[i]));
			}
			return parts.length <= 1 ? parts[0] : parts.join(" AND ");
		}
	}
	const parts = [];
	for (const child of node.children) {
		const childStr = renderTree(child);
		const wrapped = "children" in child && child.children.length > 1 ? `(${childStr})` : childStr;
		parts.push(wrapped);
	}
	return parts.length <= 1 ? parts[0] || "" : parts.join(node.type === "AND" ? " AND " : " OR ");
}

/**
 * Renders an FB-instance leaf as a standalone one-line call statement,
 * ST-style, wired from the immediately preceding element in its branch.
 * `inExpr` is the boolean expression of the element(s) directly before the FB
 * in the same AND-chain (or "TRUE" if none) - the rail's power at that point.
 */
function renderFbCall(leaf) {
	const pin = LD_FB_EDGE_TYPES.has(leaf.fbType) ? "CLK" : "IN";
	const args = [`${pin}:=${leaf.inExpr}`];
	if (leaf.pt) args.push(`PT:=${leaf.pt}`);
	return `${leaf.name}(${args.join(", ")});`;
}

/**
 * Best-effort, read-only scan of a LD POU's binary ladder body (the region
 * after its last declaration END_VAR). Reuses the tag taxonomy and
 * multi-VAR-block-aware END_VAR skip discovered in _scratch/decode_ld.py.
 * Returns an array of networks: { contacts: [{name, negated}], tree, treeOk,
 * output: {name, polarity, mode} | null, fbInstances: [string] }. `tree` is a
 * nested {type: "AND"|"OR", children} structure (see the taxonomy comment
 * above); trust it only when `treeOk` is true.
 */
function decodeLadderBody(buf, startOffset, endOffset) {
	// Multiple VAR/VAR_INPUT/VAR_OUTPUT/VAR CONSTANT/... blocks can each be
	// closed by their own textual END_VAR; only the LAST one precedes the
	// binary body, the rest are followed by more textual "VAR..." blocks.
	let pos = startOffset;
	for (;;) {
		const idx = buf.indexOf("END_VAR", pos, "latin1");
		if (idx === -1 || idx >= endOffset) break;
		const after = idx + "END_VAR".length;
		const tail = buf.toString("latin1", after, Math.min(after + 16, endOffset)).replace(/^[\r\n]+/, "");
		if (tail.startsWith("VAR")) {
			pos = after;
			continue;
		}
		pos = after;
		break;
	}
	const bodyStart = pos;

	// Generic [tag][len][ascii-name] scanner, non-overlapping greedy left-to-right.
	const records = [];
	let i = bodyStart;
	while (i < endOffset - 2) {
		const len = buf[i + 1];
		if (len >= 1 && len <= 40 && i + 2 + len <= endOffset) {
			let allPrintable = true;
			for (let k = i + 2; k < i + 2 + len; k++) {
				if (!(buf[k] >= 32 && buf[k] < 127)) {
					allPrintable = false;
					break;
				}
			}
			if (allPrintable) {
				records.push({ offset: i, tag: buf[i], name: buf.toString("ascii", i + 2, i + 2 + len) });
				i += 2 + len;
				continue;
			}
		}
		i++;
	}

	// A network boundary is marked by the byte pair 08 FF preceding the first
	// record of that network -- but NOT always immediately adjacent to it.
	// Validated against a real TwinCAT screenshot of HybridControl (see
	// _scratch/decode_ld.py investigation, 2026-09): the gap between "08 FF"
	// and the next record's tag byte is 0-3 filler bytes (bookkeeping bytes
	// like 09/0A, or a preceding network comment's raw bytes), not always 0.
	// The old exact-"last 2 bytes == 08 FF" check missed every HybridControl
	// boundary (its filler run is never 0) and silently merged networks 1-6
	// into one. Searching a small lookback window for the 08 FF pair (instead
	// of requiring adjacency) fixes this without regressing POUs where the
	// filler happened to be 0 bytes (CanopyControl/Intrusion spot checks).
	const BOUNDARY_LOOKBACK = 8;
	const networks = [];
	let current = null;
	let stack = null; // stack of open group nodes for the current network's tree
	let lastEnd = bodyStart;
	let prevWasContact = false;
	const consumedByFb = new Set(); // indices of TIMELIT records folded into a preceding FB leaf as its PT

	// FB-instance records (a TON/TOF/TP/R_TRIG/... call site) are followed by,
	// in order: optionally a single-gap-byte TIMELIT record (the PT operand -
	// only present for timer types), then a Pascal-style length-prefixed type
	// name (e.g. 03 54 4f 4e = "TON") and an 8-byte trailer, neither of which
	// the generic [tag][len][name] scanner above can parse (they're not that
	// shape) so they're read directly from the buffer here. See README/task
	// notes: confirmed byte-for-byte against RunToRearTimer/RunRelJamTimer/
	// RunToReleaseTimer in the real corpus.
	function readPascalTypeName(offset, limit) {
		if (offset + 1 > limit) return null;
		const len = buf[offset];
		if (len < 1 || len > 20 || offset + 1 + len > limit) return null;
		let name = "";
		for (let k = 0; k < len; k++) {
			const c = buf[offset + 1 + k];
			if (!((c >= 65 && c <= 90) || c === 95)) return null; // A-Z or '_' (e.g. R_TRIG)
			name += String.fromCharCode(c);
		}
		return name;
	}

	function finalizeCurrent() {
		// A group that's still open when the network's last contact is reached
		// needs no explicit close byte - real data shows the outermost (and
		// often several nested) groups routinely rely on this instead of a
		// trailing 0x40. So simply auto-close whatever's left open; a *broken*
		// tree (invalid gap byte, or a close popping past the root mid-network)
		// was already flagged via treeOk=false above and stays flagged.
		if (current) {
			stack.length = 1;
			// The last network's body ends at the end of its output records.
			// There is NO comment block after the last network (the POU's
			// trailing metadata follows immediately), so commentBytes is empty.
			if (current.endOffset === undefined) {
				current.endOffset = lastEnd;
				current.commentBytes = Buffer.alloc(0);
			}
		}
	}

	for (let ri = 0; ri < records.length; ri++) {
		if (consumedByFb.has(ri)) continue;
		const rec = records[ri];
		const windowStart = Math.max(lastEnd, rec.offset - BOUNDARY_LOOKBACK);
		const between = buf.subarray(windowStart, rec.offset);
		let markerPos = -1;
		for (let k = 0; k + 1 < between.length; k++) {
			if (between[k] === 0x08 && between[k + 1] === 0xff) {
				markerPos = windowStart + k;
				break;
			}
		}
		let gap;
		let freshNetwork = false;
		if (current === null || markerPos !== -1) {
			// A new network's 08 FF marker: the previous network ends here.
			// The bytes between its last record and the marker are its comment
			// block ([len] [00 00 00] [comment] [00], or 00 00 00 00 00 when
			// empty) - captured so the encoder can re-emit them verbatim.
			if (current) {
				current.endOffset = markerPos;
				current.commentBytes = buf.subarray(lastEnd, markerPos);
			}
			finalizeCurrent();
			gap = markerPos !== -1 ? buf.subarray(markerPos + 2, rec.offset) : Buffer.alloc(0);
			const root = { type: "AND", children: [] };
			current = { elements: [], outputs: [], fbInstances: [], tree: root, treeOk: true, startOffset: markerPos !== -1 ? markerPos : bodyStart };
			networks.push(current);
			stack = [root];
			freshNetwork = true;
		} else {
			gap = buf.subarray(lastEnd, rec.offset);
		}

		const base = rec.tag & ~(LD_CONTACT_NEGATED_BIT | 0x40);
		const isContact = base === LD_CONTACT_BASE_TAG;
		const isFb = (rec.tag & ~0x40) === 0x05; // 0x05 = non-terminal instance, 0x45 = terminal (closes group)
		let fbTrailerConsumed = false; // did we precisely locate the end of this FB's own trailing bytes?
		if (isContact || isFb) {
			// Only trust gap bytes as AND/OR grammar when they sit directly between
			// two contacts/FB-instances (or right after a network's "08 FF"
			// marker). Otherwise the bytes since the last one are that record's
			// own parameter data (PT literal, type name, trailer), not open/close
			// bytes - a real network (HybridControl net 16) has an FB instance and
			// timer sitting between two plain-AND contacts, and its trailing
			// parameter bytes would otherwise look like garbage "open" bytes and
			// wrongly kill the whole network's tree.
			if (!freshNetwork && !prevWasContact) gap = Buffer.alloc(0);
			for (const g of gap) {
				const opType = (g & ~0x40) === 0x09 ? "AND" : (g & ~0x40) === 0x0a ? "OR" : null;
				if (opType === null) {
					current.treeOk = false;
					continue;
				}
				const node = { type: opType, children: [] };
				const parent = stack[stack.length - 1];
				parent.children.push(node);
				stack.push(node);
				// 0x40 on an OPEN marks the PARENT as "closes after this group"
				// (this group is the parent's last child). When the group closes
				// (via a leaf's 0x40 or the network end), the marked parent closes
				// too - a cascade up through all marked ancestors. This is the
				// "last child of the current list" rule from the 2026-09 analysis,
				// and it fixes HybridControl NET 15 + Intrusion NET 2 (the old
				// "ignore 0x40 on opens" model silently produced wrong nesting).
				if (g & 0x40) parent._marked = true;
			}

			let leaf;
			let consumedEnd = rec.offset + 2 + rec.name.length;
			if (isContact) {
				leaf = { name: rec.name, negated: (rec.tag & LD_CONTACT_NEGATED_BIT) !== 0 };
			} else {
				// A single-gap-byte TIMELIT record immediately following is this
				// FB's PT operand (timer types only - e.g. R_TRIG has none).
				let pt = null;
				let fbType = null;
				const nextRec = records[ri + 1];
				if (nextRec && nextRec.tag === LD_TIMELIT_TAG && nextRec.offset - consumedEnd <= 4) {
					pt = nextRec.name;
					consumedEnd = nextRec.offset + 2 + nextRec.name.length;
					consumedByFb.add(ri + 1);
					// With a PT operand present, the type name follows as a bare
					// tag-less length-prefixed string, not a normal tagged record.
					fbType = readPascalTypeName(consumedEnd, endOffset);
					if (fbType) {
						const typeEnd = consumedEnd + 1 + fbType.length;
						// The 8-byte trailer (01 00 00 00 00 00 00 00) is identical in
						// every timer instance seen across the whole test corpus - skip
						// it exactly so the real gap bytes for the *next* element (which
						// can legitimately open an AND/OR group - see HybridControl net
						// 16, RunRelJamTimer OR (InductPE1 AND RunToReleaseTimer)) aren't
						// drowned out by this FB's own trailing bytes.
						const trailer = buf.subarray(typeEnd, typeEnd + 8);
						if (trailer.length === 8 && trailer[0] === 1 && trailer.subarray(1).every((b) => b === 0)) {
							consumedEnd = typeEnd + 8;
							fbTrailerConsumed = true;
						}
					}
				} else if (nextRec && nextRec.tag === LD_FBTYPE_TAG && nextRec.offset - consumedEnd <= 4) {
					fbType = nextRec.name;
					consumedEnd = nextRec.offset + 2 + nextRec.name.length;
					consumedByFb.add(ri + 1);
					// FB types with no operand (e.g. R_TRIG/F_TRIG) have a shorter,
					// all-zero 6-byte trailer instead of the timer types' 8-byte one -
					// confirmed identical across every R_TRIG instance in the corpus
					// (BagFound, PEHit1, PEHit2). Same reasoning as the timer case:
					// skip it exactly so the real gap byte for the next element (e.g.
					// Intrusion NETWORK 2's second AND-group, opened right after
					// PEHit1) isn't drowned out by this FB's own trailing bytes.
					const trailer = buf.subarray(consumedEnd, consumedEnd + 6);
					if (trailer.length === 6 && trailer.every((b) => b === 0)) {
						consumedEnd += 6;
						fbTrailerConsumed = true;
					}
				}
				leaf = { name: rec.name, fb: true, fbType, pt };
			}
			current.elements.push(leaf);
			if (current.treeOk) {
				stack[stack.length - 1].children.push(leaf);
				if (rec.tag & 0x40) {
					// 0x40 on a leaf: it's the last child of the innermost group,
					// which closes. Then cascade: any marked ancestor (a group
					// whose last child was the group we just closed) closes too.
					if (stack.length <= 1) current.treeOk = false;
					else {
						stack.pop();
						while (stack.length > 1 && stack[stack.length - 1]._marked) stack.pop();
					}
				}
			}
			lastEnd = consumedEnd;
		} else if (Object.prototype.hasOwnProperty.call(LD_OUTPUT_TAGS, rec.tag)) {
			current.outputs.push({ name: rec.name, ...LD_OUTPUT_TAGS[rec.tag] });
			lastEnd = rec.offset + 2 + rec.name.length;
		} else if (rec.tag === LD_TIMELIT_TAG) {
			// A PT literal not immediately following an FB-instance record -
			// shouldn't happen in valid data, kept only as a diagnostic fallback.
			current.fbInstances.push(rec.name);
			lastEnd = rec.offset + 2 + rec.name.length;
		} else {
			lastEnd = rec.offset + 2 + rec.name.length;
		}
		// An FB-instance record is followed by its own trailing param bytes
		// (optional PT, Pascal-style type name, trailer) before the next real
		// record - those must never be trusted as AND/OR grammar. Once we've
		// precisely located the end of that trailer (fbTrailerConsumed), lastEnd
		// already points past it, so the *next* gap is genuine and safe to trust
		// (needed for e.g. HybridControl net 16's nested group right after a
		// timer). Otherwise stay conservative and suppress, as before.
		prevWasContact = isContact || (isFb && fbTrailerConsumed);
	}
	finalizeCurrent();

	return networks;
}

/**
 * Walks a trusted AND/OR tree (see decodeLadderBody) computing, for every
 * FB-instance leaf, the boolean expression actually wired to its input pin
 * (`leaf.inExpr`) - i.e. the ladder rail's accumulated power at that exact
 * position: the AND of every element preceding it in the same AND-chain,
 * unaffected by sibling branches of an enclosing OR (a parallel split feeds
 * the same incoming power to every branch, not an accumulation across them).
 * Mirrors how the real project's ST source wires these same FB types
 * (SecurityDoor: "OpenTriggerFilter(IN:=OpenDoor, PT:=t#100ms);"). Returns the
 * node's own rendered contribution to its parent's expression - for a plain
 * contact that's its name; for an FB leaf it's `<name>.Q`, the FB's output
 * pin, since that (not the call itself) is what continues the rail forward.
 */
function assignFbWiring(node, incoming) {
	if (!("children" in node)) {
		if (node.fb) {
			node.inExpr = incoming;
			return `${node.name}.Q`;
		}
		return node.negated ? `NOT ${node.name}` : node.name;
	}
	const parts = [];
	let acc = incoming;
	for (const child of node.children) {
		const childStr = assignFbWiring(child, node.type === "AND" ? acc : incoming);
		const wrapped = "children" in child && child.children.length > 1 ? `(${childStr})` : childStr;
		parts.push(wrapped);
		if (node.type === "AND") acc = acc === "TRUE" ? wrapped : `${acc} AND ${wrapped}`;
	}
	return parts.length <= 1 ? parts[0] || "" : parts.join(node.type === "AND" ? " AND " : " OR ");
}

/** Renders decoded networks as a readable, clearly-labeled best-effort text block. */
function renderLadderNetworks(networks) {
	if (!networks.length) return "";
	const lines = [""];
	networks.forEach((net, idx) => {
		let condStr;
		let fbCalls = [];
		if (!net.elements.length) {
			condStr = "(no contacts decoded)";
		} else if (net.treeOk) {
			// First walk the tree to compute each FB leaf's IN wiring (the
			// accumulated rail power at its position), then render the clean
			// condition (FB .Q outputs only, no duplicated input chain).
			assignFbWiring(net.tree, "TRUE");
			condStr = renderTree(net.tree);
			// Emit each FB instance as its own one-line call statement (IN/CLK +
			// PT wiring, ST-style - matches how the real project's own ST source
			// calls these same FB types), in rung order, before the IF that uses
			// their .Q. Each FB's IN is the accumulated rail power at its exact
			// position (the AND of everything preceding it in the same branch).
			fbCalls = net.elements.filter((el) => el.fb).map(renderFbCall);
		} else {
			condStr = net.elements.map(renderLeaf).join(" <AND/OR: MIXED, unresolved> ");
		}
		lines.push(`NETWORK ${idx + 1}:`);
		for (const call of fbCalls) lines.push(`  ${call}`);
		lines.push(`  IF ${condStr} THEN`);
		if (net.outputs.length) {
			for (const out of net.outputs) {
				// The coil type (DIRECT/SET/RESET) IS the operation - the boolean
				// value it drives is fully determined by it (DIRECT/SET -> TRUE,
				// RESET -> FALSE), so emitting both would be redundant and
				// contradictory (e.g. "TRUE; // RESET" is nonsense).
				lines.push(`    ${out.name} := ${out.mode};`);
			}
		} else {
			lines.push("    (no output decoded)");
		}
		if (net.fbInstances.length) {
			lines.push(`    // unattached PT literal(s), unexpected: ${net.fbInstances.join(", ")}`);
		}
	});
	return lines.join("\r\n");
}

function isPrintable(byte) {
	return (byte >= 32 && byte < 127) || byte === 9 || byte === 10 || byte === 13;
}

/** Finds [start,length] runs of contiguous printable bytes, in file order. */
function findPrintableRuns(buf) {
	const runs = [];
	let curStart = null;
	for (let i = 0; i < buf.length; i++) {
		if (isPrintable(buf[i])) {
			if (curStart === null) curStart = i;
		} else if (curStart !== null) {
			const length = i - curStart;
			if (length >= MIN_RUN_LENGTH) runs.push([curStart, length]);
			curStart = null;
		}
	}
	if (curStart !== null) {
		const length = buf.length - curStart;
		if (length >= MIN_RUN_LENGTH) runs.push([curStart, length]);
	}
	return runs;
}

/** Finds runs that begin (after stripping leading whitespace) with a POU keyword. */
function findPouStarts(buf, runs) {
	const hits = [];
	for (const [start, length] of runs) {
		let s = start;
		const limit = start + length;
		while (s < limit && (buf[s] === 0x0d || buf[s] === 0x0a || buf[s] === 0x09 || buf[s] === 0x20)) s++;
		const slice = buf.toString("latin1", s, Math.min(limit, s + 20));
		if (POU_KEYWORDS.some((kw) => slice.startsWith(kw))) {
			hits.push(start);
		}
	}
	return hits;
}

/**
 * Finds the implementation-body run that follows a POU's header+declaration
 * run. In this format an ST POU's source is split across two printable runs:
 * the header+VAR block, then a short non-printable gap containing the 0x12
 * separator byte, then a 16-bit little-endian length, then the implementation
 * body (exactly `len` bytes). `start` is the end of the header run (the first
 * non-printable byte after it); `limit` is the next POU's start (or end of
 * file). Returns { start, end } of the implementation body, or null if no
 * valid 0x12 + length-prefixed body is found before `limit`.
 */
function findImplementationRun(buf, start, limit) {
	// Scan the gap after the header run for the 0x12 separator byte.
	let sep = -1;
	for (let i = start; i < Math.min(start + 64, limit); i++) {
		if (buf[i] === 0x12) { sep = i; break; }
	}
	if (sep === -1) return null;
	// 16-bit little-endian length at sep+1..sep+2, then 2 zero bytes, then the
	// body. Verified across all 13 ST POUs in the corpus (single-byte lengths
	// like UPS's 187 and multi-byte like MAIN's 3072 both decode correctly).
	const len = buf[sep + 1] + (buf[sep + 2] << 8);
	const implStart = sep + 5;
	const implEnd = implStart + len;
	if (len <= 0 || implEnd > limit) return null;
	// Sanity: the body must be printable text (it's ST source).
	for (let i = implStart; i < implEnd; i++) {
		if (!isPrintable(buf[i])) return null;
	}
	return { start: implStart, end: implEnd };
}

/**
 * Format-based ladder detection: a real LD POU's binary body is marked by the
 * confirmed `08 FF` network-boundary byte pair (see decodeLadderBody). That is
 * a specific, positive structural signature - plain Structured Text (even
 * "poor" ST with dropped framing bytes or interleaved junk) does not contain
 * the `08 FF` pair, because 0x08 and 0xFF are non-printable and never appear
 * inside a text run. So: if the post-END_VAR region contains at least one
 * `08 FF` pair, treat the POU as ladder and keep it read-only. This is
 * deliberately conservative - an unlisted ladder POU with no marker would be
 * left editable (and can be added to KNOWN_LD_POUS), but a real ST POU is
 * never wrongly locked as read-only.
 */
function looksLikeLadderBody(buf, start, end) {
	let pos = start;
	for (;;) {
		const idx = buf.indexOf("END_VAR", pos, "latin1");
		if (idx === -1 || idx >= end) break;
		const after = idx + "END_VAR".length;
		const tail = buf.toString("latin1", after, Math.min(after + 16, end)).replace(/^[\r\n]+/, "");
		if (tail.startsWith("VAR")) {
			pos = after;
			continue;
		}
		pos = after;
		break;
	}
	for (let i = pos; i + 1 < end; i++) {
		if (buf[i] === 0x08 && buf[i + 1] === 0xff) return true;
	}
	return false;
}

/** Like the old cleanRange, but also returns the exact source offset of every
 * kept byte, so an edit can be written back to precisely those positions
 * (and nowhere else) without disturbing anything surrounding it. */
function cleanRangeWithPositions(buf, start, end) {
	const bytes = [];
	const positions = [];
	for (let i = start; i < end; i++) {
		if (isPrintable(buf[i])) {
			bytes.push(buf[i]);
			positions.push(i);
		}
	}
	return { text: Buffer.from(bytes).toString("latin1"), positions };
}

/**
 * Decodes every POU found in the .pro binary buffer.
 * Returns an array of { name, text, truncated, editable, positions } in file order.
 * `positions[i]` is the buffer offset that produced `text[i]`, present only
 * when `editable` is true (see applyPouEdit).
 */
function decodePro(buf) {
	const runs = findPrintableRuns(buf);
	const starts = findPouStarts(buf, runs);
	const results = [];

	for (let idx = 0; idx < starts.length; idx++) {
		const start = starts[idx];
		// The POU's text is the printable run that begins at `start`. Its true
		// end is where that run ends (the next non-printable framing byte) -
		// NOT the next POU's start, which can sweep the next POU's header (and
		// any forward-link) into this POU's text (the UPS/TwinSafe leak). The
		// next POU's start is only a hard safety cap in case a run is malformed.
		const run = runs.find(([rs]) => rs === start);
		const runEnd = run ? run[0] + run[1] : buf.length;
		const nextStart = idx + 1 < starts.length ? starts[idx + 1] : buf.length;
		// `textEnd` bounds the ST text: the printable run's own end (the next
		// non-printable framing byte), capped at the next POU's start. This is
		// what stops the next POU's header from leaking into this POU's text.
		const textEnd = Math.min(runEnd, nextStart);
		// `scanEnd` bounds the ladder body scan: a ladder POU's binary body
		// lives OUTSIDE its printable run (it's non-printable), so it must be
		// scanned up to the next POU's start (or a generous window for the last
		// POU), not just to the run end.
		const scanEnd = nextStart !== buf.length ? nextStart : Math.min(runEnd + 20000, buf.length);
		let { text, positions } = cleanRangeWithPositions(buf, start, textEnd);

		// A POU's ST source is stored as TWO printable runs: the header +
		// declarations (this run), then a short non-printable gap containing the
		// 0x12 separator byte, then the implementation body (a second run). The
		// run-based boundary above correctly stops at the first run's end, but
		// that would drop the implementation. So: after the header run, look for
		// the 0x12 separator and append the following implementation run. This
		// is what recovers the full ST body (e.g. UPS_CX80xx's FB call) without
		// sweeping in the Visualization data that follows the implementation.
		const impl = findImplementationRun(buf, textEnd, nextStart);
		if (impl) {
			const implClean = cleanRangeWithPositions(buf, impl.start, impl.end);
			text += "\r\n" + implClean.text;
			positions = positions.concat([null, null], implClean.positions);
		}

		// A single stray non-printable framing byte is sometimes dropped between
		// the declaration's END_VAR and whatever immediately follows it in the
		// real source (commonly a same-line comment, e.g. "END_VAR(*foo*)") -
		// reinsert the CRLF that recovers the real formatting. The two inserted
		// characters don't come from any single source byte, so they get a
		// `null` position: still safe to leave editable, applyPouEdit just
		// refuses to let an edit touch those two characters.
		let editable = true;
		if (/END_VAR[^\s\r\n]/.test(text)) {
			const re = /END_VAR([^\s\r\n])/g;
			let newText = "", newPositions = [], lastIndex = 0, m;
			while ((m = re.exec(text)) !== null) {
				newText += text.slice(lastIndex, m.index) + "END_VAR\r\n" + m[1];
				newPositions.push(...positions.slice(lastIndex, m.index + "END_VAR".length), null, null, positions[m.index + m[0].length - 1]);
				lastIndex = m.index + m[0].length;
			}
			newText += text.slice(lastIndex);
			newPositions.push(...positions.slice(lastIndex));
			text = newText;
			positions = newPositions;
		}

		// Name of this POU, read off its own header line. The run may begin
		// with leading CRLF (the printable run starts at the first printable
		// byte, which can be a newline before the PROGRAM keyword), so strip
		// leading whitespace before matching.
		const headerMatch = text.match(/^\s*(PROGRAM|FUNCTION_BLOCK|FUNCTION)\s+([A-Za-z0-9_]+)/);
		const name = headerMatch ? headerMatch[2] : `Unknown_${start}`;

		// Trim leading/trailing whitespace, keeping `positions` in lockstep so
		// positions[i] still maps to text[i] for the surviving editable case.
		const trimmedStart = text.length - text.trimStart().length;
		const trimmed = text.trim();
		if (editable) positions = positions.slice(trimmedStart, trimmedStart + trimmed.length);
		text = trimmed;

		// Read-only if the POU is a known ladder name OR its post-END_VAR body
		// is majority binary (format-based detection - catches unlisted LD/FBD
		// POUs that would otherwise be mis-decoded as editable ST).
		const isLadder = KNOWN_LD_POUS.has(name) || looksLikeLadderBody(buf, start, scanEnd);
		if (isLadder) {
			editable = false;
			try {
				const networks = decodeLadderBody(buf, start, scanEnd);
				text += renderLadderNetworks(networks);
			} catch (e) {
				// Best-effort only - if the scan fails, keep just the declaration text.
			}
		}

		results.push({ name, text, truncated: false, editable, positions: editable ? positions : null, _startOffset: start, _endOffset: nextStart });
	}

	return results;
}

/**
 * Re-encodes an edited POU's text back into the buffer, growing or shrinking
 * the file if the edit changes length. Finds the common prefix/suffix between
 * the old and new text (both anchored to real source byte positions - see
 * `positions`) and replaces only the byte range spanned by the differing
 * middle, shifting everything after it. Investigated 2026-09 against a real
 * project resave: no absolute-offset table or whole-file checksum was found
 * referencing POU text locations (POU "directory" entries only carry a name
 * and timestamps), so a straight insert/delete-with-shift appears safe - but
 * this is NOT the same as a confirmed-safe guarantee. Every save is verified
 * by re-decoding the whole file afterwards (see extension.js) and refusing to
 * write if the edited POU doesn't decode back to exactly what was typed, or
 * if any *other* POU's decoded text changed as a side effect.
 */
function applyPouEdit(buf, pou, newText) {
	if (!pou.editable) {
		throw new Error(`${pou.name} is not editable (ladder logic POUs and ambiguously-decoded POUs are read-only).`);
	}
	for (let i = 0; i < newText.length; i++) {
		if (newText.charCodeAt(i) > 0x7f) throw new Error(`Cannot save ${pou.name}: non-ASCII character not supported by this format.`);
	}

	const oldText = pou.text;
	const minLen = Math.min(oldText.length, newText.length);
	let prefixLen = 0;
	while (prefixLen < minLen && oldText[prefixLen] === newText[prefixLen]) prefixLen++;
	let suffixLen = 0;
	while (suffixLen < minLen - prefixLen && oldText[oldText.length - 1 - suffixLen] === newText[newText.length - 1 - suffixLen]) {
		suffixLen++;
	}

	// Never splice through a synthetic (position === null, e.g. a reinserted
	// END_VAR CRLF) character - widen the replaced middle span to swallow it
	// instead. The character is identical in old/new text by definition of
	// common prefix/suffix, so this never changes what gets written.
	while (prefixLen > 0 && pou.positions[prefixLen] === null) prefixLen--;
	while (suffixLen > 0 && pou.positions[oldText.length - suffixLen - 1] === null) suffixLen--;

	if (prefixLen === 0 && suffixLen === oldText.length) {
		throw new Error(`Cannot save ${pou.name}: edit has no unchanged anchor text next to it - make a smaller, more localized edit.`);
	}

	const hasOldMiddle = prefixLen < oldText.length - suffixLen;
	const spliceStart = hasOldMiddle ? pou.positions[prefixLen] : pou.positions[prefixLen - 1] + 1;
	const spliceEnd = hasOldMiddle ? pou.positions[oldText.length - suffixLen - 1] + 1 : spliceStart;

	const middleBytes = Buffer.from(newText.slice(prefixLen, newText.length - suffixLen), "latin1");
	let result = Buffer.concat([buf.subarray(0, spliceStart), middleBytes, buf.subarray(spliceEnd)]);

	// Two-run ST POUs store their implementation body as a SECOND printable run
	// whose length is recorded in a 16-bit little-endian prefix (0x12 separator
	// byte, then the length, then 2 zero bytes, then the body). If the edit
	// changed the body's length, that prefix must be patched or the decoder
	// will read a stale length and truncate the body on re-decode.
	//
	// Detect the two-run structure by searching BACKWARD from the splice for
	// the 0x12 separator + length prefix that immediately precedes a printable
	// body. (findImplementationRun searches forward from a start offset, which
	// is the wrong direction here - the separator is before the body.)
	const impl = findImplRunBefore(buf, spliceStart);
	if (impl && spliceEnd > impl.start) {
		// The splice touched the implementation run. Recompute the new body
		// length: it's the distance from the run start to the end of the new
		// body. The body's end in the new buffer is the old body end shifted by
		// the length delta of the splice.
		const delta = middleBytes.length - (spliceEnd - spliceStart);
		const newImplEnd = impl.end + delta;
		const newLen = newImplEnd - impl.start;
		if (newLen < 0 || newLen > 0xffff) {
			throw new Error(`Cannot save ${pou.name}: implementation body too large for the format's 16-bit length field.`);
		}
		// Patch the length prefix (little-endian) at sep+1..sep+2.
		const sep = impl.start - 5; // body starts at sep+5
		result[sep + 1] = newLen & 0xff;
		result[sep + 2] = (newLen >> 8) & 0xff;
	}

	return result;
}

/**
 * Finds the two-run implementation body that ends at or before `beforeOffset`,
 * by scanning backward for the 0x12 separator + 16-bit LE length + 2 zero
 * bytes + printable body pattern. Returns { start, end } of the body, or null.
 * This is the reverse-direction counterpart to findImplementationRun (which
 * scans forward from a start offset) - needed by applyPouEdit to locate the
 * length prefix that precedes a splice point inside the body.
 */
function findImplRunBefore(buf, beforeOffset) {
	// Scan backward a bounded window for a 0x12 separator byte.
	const windowStart = Math.max(0, beforeOffset - 4096);
	for (let i = beforeOffset - 1; i >= windowStart; i--) {
		if (buf[i] !== 0x12) continue;
		const len = buf[i + 1] + (buf[i + 2] << 8);
		const bodyStart = i + 5;
		const bodyEnd = bodyStart + len;
		if (len <= 0 || bodyEnd > buf.length) continue;
		// The body must be printable text and must contain the splice point.
		if (bodyStart > beforeOffset || bodyEnd < beforeOffset) continue;
		let printable = true;
		for (let j = bodyStart; j < bodyEnd; j++) {
			if (!isPrintable(buf[j])) { printable = false; break; }
		}
		if (printable) return { start: bodyStart, end: bodyEnd };
	}
	return null;
}

// Block keywords that must balance 1:1 with their closer within a single
// POU's text. Decoded POU text never includes a trailing END_PROGRAM /
// END_FUNCTION_BLOCK / END_FUNCTION (confirmed empirically - the binary
// simply doesn't store one), so those are deliberately not checked here.
const ST_BLOCK_PAIRS = [
	[/\bVAR(_INPUT|_OUTPUT|_IN_OUT|_GLOBAL|_EXTERNAL|_STAT|_TEMP)?\b/gi, /\bEND_VAR\b/gi],
	[/\bIF\b/gi, /\bEND_IF\b/gi],
	[/\bCASE\b/gi, /\bEND_CASE\b/gi],
	[/\bFOR\b/gi, /\bEND_FOR\b/gi],
	[/\bWHILE\b/gi, /\bEND_WHILE\b/gi],
	[/\bREPEAT\b/gi, /\bEND_REPEAT\b/gi],
];

/**
 * Thin wrapper around the full ST syntax checker in stcheck.js (see
 * docs/syntax-checker-plan.md). Kept for backward compatibility with the
 * extension's save path and existing tests: returns { ok: true } or
 * { ok: false, error } where `error` is the first error diagnostic's message.
 * The richer { ok, diagnostics } shape (line/col/severity/code) is available
 * directly from stcheck.js's checkSt().
 */
function checkStSyntax(text) {
	const { ok, diagnostics } = checkSt(text);
	if (ok) return { ok: true };
	const first = diagnostics.find((d) => d.severity === "error") || diagnostics[0];
	return { ok: false, error: `Line ${first.line}: ${first.message}` };
}

// ---------------------------------------------------------------------------
// LD write-back: encode a decoded network tree back into the binary LD body.
//
// Serialization (confirmed 2026-09 against the real corpus + a TwinCat ladder
// printout): every element is [gap bytes] [tag] [name]. Gap bytes are the
// structure nodes (09 = series/AND open, 0a = parallel/OR open); the tag is
// the element record (0b = contact, 0x80 = negated, 0x45/0x05 = FB instance,
// 0x41 = literal). The 0x40 bit marks the LAST child of the current list:
// on a leaf it terminates its block, on an open it marks the parent as
// closing after this group (the cascade-close model). Coils are NOT
// distinguished by the tag byte - they are a trailing pin-reference list:
// [count] [00] then per output [coiltype] [len] [name] (coiltype 0 = DIRECT,
// 2 = SET, 3 = RESET). FB instances: [tag] [len] [name] [00] [0x41] [len]
// [PT] [len] [type] [8-byte trailer] for timers, or [tag] [len] [name]
// [0x40] [len] [type] [6-byte trailer] for edge-detect types. Network
// comments are stored between networks as [len] [00 00 00] [comment] [00]
// (or 00 00 00 00 00 when empty) and are re-emitted verbatim.
// ---------------------------------------------------------------------------

/** Serializes a decoded network tree back into LD binary bytes.
 * `networks` is the array produced by decodeLadderBody (each has `.tree`,
 * `.outputs`, `.commentBytes`). Returns a Buffer of the full LD body bytes
 * (starting at the first network's 08 FF marker). */
function encodeLadderNetworks(networks) {
	const out = [];
	const push = (b) => out.push(b);
	const pushName = (name) => {
		const bytes = Buffer.from(name, "latin1");
		if (bytes.length < 1 || bytes.length > 40) throw new Error(`LD name too long: ${name}`);
		push(bytes.length);
		for (const b of bytes) push(b);
	};
	const pushRecord = (tag, name) => {
		push(tag);
		pushName(name);
	};

	// Depth-first serialization. `isLast` = this node is the last child of its
	// parent group; `isRootChild` = this node is a direct child of the root
	// (root children never carry 0x40 - the network end implies their close).
	function emitNode(node, isLast, isRootChild) {
		if (!("children" in node)) {
			// Leaf: contact or FB instance.
			if (node.fb) {
				let tag = 0x05;
				if (isLast && !isRootChild) tag |= 0x40;
				pushRecord(tag, node.name);
				if (node.pt) {
					// Timer: [00] [0x41] [len] [PT] [len] [type] [8-byte trailer].
					push(0x00);
					pushRecord(0x41, node.pt);
					const typeBytes = Buffer.from(node.fbType || "TON", "latin1");
					push(typeBytes.length);
					for (const b of typeBytes) push(b);
					push(0x01);
					for (let i = 0; i < 7; i++) push(0);
				} else {
					// Edge-detect: [0x40] [len] [type] [6-byte trailer].
					pushRecord(0x40, node.fbType || "R_TRIG");
					for (let i = 0; i < 6; i++) push(0);
				}
			} else {
				let tag = 0x0b;
				if (node.negated) tag |= 0x80;
				if (isLast && !isRootChild) tag |= 0x40;
				pushRecord(tag, node.name);
			}
			return;
		}
		// Group node: emit its open byte, then children.
		let openByte = node.type === "AND" ? 0x09 : 0x0a;
		if (isLast && !isRootChild) openByte |= 0x40;
		push(openByte);
		for (let i = 0; i < node.children.length; i++) {
			emitNode(node.children[i], i === node.children.length - 1, false);
		}
	}

	for (const net of networks) {
		// Network boundary marker.
		push(0x08);
		push(0xff);
		// The tree root is a synthetic AND wrapper - emit its children.
		const root = net.tree || { type: "AND", children: net.elements || [] };
		const children = root.children && root.children.length ? root.children : net.elements || [];
		for (let i = 0; i < children.length; i++) {
			emitNode(children[i], i === children.length - 1, true);
		}
		// Outputs: [count] [00] then per output [coiltype] [len] [name].
		const outputs = net.outputs || [];
		if (outputs.length) {
			push(outputs.length);
			push(0x00);
			for (const out of outputs) {
				const tag = out.mode === "SET" ? 0x02 : out.mode === "RESET" ? 0x03 : 0x00;
				pushRecord(tag, out.name);
			}
		}
		// Re-emit the network's comment block verbatim (empty for the last
		// network - the POU's trailing metadata follows immediately).
		if (net.commentBytes && net.commentBytes.length) {
			for (const b of net.commentBytes) push(b);
		}
	}
	return Buffer.from(out);
}

/**
 * Applies an edited LD POU's text back into the buffer. The edited text is
 * the rendered form (NETWORK n: / FB calls / IF ... THEN / coil := ...).
 * Strategy: decode the ORIGINAL body into networks (with exact byte ranges),
 * then for each network compare the ORIGINAL rendered form against the
 * corresponding block of the edited text. Unchanged networks keep their
 * original bytes verbatim (so the imperfectly-understood 0x40 corner cases
 * can never corrupt them); changed networks are re-encoded from their parsed
 * tree. Returns the new buffer.
 */
function applyLdPouEdit(buf, pou, newText) {
	const start = pou._startOffset;
	const limit = pou._endOffset;
	if (start === undefined) throw new Error(`Cannot save ${pou.name}: missing offset info.`);

	// Decode the original body into networks with byte ranges.
	const oldNetworks = decodeLadderBody(buf, start, limit);
	if (!oldNetworks.length) throw new Error(`Cannot save ${pou.name}: no ladder networks found.`);

	// Split the edited text into per-network blocks (NETWORK n: ... up to the
	// next NETWORK line or end).
	const newBlocks = splitNetworkBlocks(newText);
	if (!newBlocks.length) throw new Error(`Cannot save ${pou.name}: no NETWORK blocks found in edited text.`);

	// Render each original network for comparison (network numbers normalized
	// to 1-based index so the comparison is position-based, not label-based).
	const oldRendered = oldNetworks.map((net, idx) =>
		renderLadderNetworks([net]).trim().replace(/^NETWORK \d+:/, `NETWORK ${idx + 1}:`)
	);

	const parts = [];
	for (let i = 0; i < newBlocks.length; i++) {
		const oldNet = i < oldNetworks.length ? oldNetworks[i] : null;
		const newBlock = newBlocks[i];
		const oldRender = i < oldRendered.length ? oldRendered[i] : null;
		if (oldNet && oldRender && oldRender === newBlock.trim()) {
			// Unchanged: preserve the original bytes. The network's bytes run
			// from its 08 FF marker to the NEXT network's marker (or the body
			// end for the last network) - the comment block sits between them.
			const end = i + 1 < oldNetworks.length ? oldNetworks[i + 1].startOffset : oldNet.endOffset;
			parts.push(buf.subarray(oldNet.startOffset, end));
		} else {
			// Changed (or added): re-encode, preserving the original comment.
			const parsed = parseRenderedLadder(newBlock);
			if (!parsed.length) throw new Error(`Cannot save ${pou.name}: could not parse NETWORK ${i + 1}.`);
			const encoded = encodeLadderNetworks(parsed);
			const comment = oldNet && oldNet.commentBytes ? oldNet.commentBytes : Buffer.alloc(0);
			parts.push(Buffer.concat([encoded, comment]));
		}
	}

	// Splice the new body over the old body region.
	const bodyStart = oldNetworks[0].startOffset;
	const lastEnd = oldNetworks[oldNetworks.length - 1].endOffset;
	const newBody = Buffer.concat(parts);
	return Buffer.concat([buf.subarray(0, bodyStart), newBody, buf.subarray(lastEnd)]);
}

/** Splits rendered ladder text into per-network blocks. The POU header
 * (PROGRAM/VAR blocks) precedes the first NETWORK line and is skipped. */
function splitNetworkBlocks(text) {
	const lines = text.split(/\r?\n/);
	const blocks = [];
	let current = null;
	for (const line of lines) {
		if (/^\s*NETWORK\s+\d+:\s*$/.test(line)) {
			if (current) blocks.push(current.join("\r\n"));
			current = [line];
		} else if (current) {
			current.push(line);
		}
	}
	if (current) blocks.push(current.join("\r\n"));
	return blocks;
}

/** Structural equality of two decoded networks (tree + outputs). Trees are
 * normalized first (single-child groups flattened) because the decoder wraps
 * chains in explicit groups while the parser produces flat trees - both are
 * the same ladder logic and must compare equal. */
function networksEqual(a, b) {
	if (a.outputs.length !== b.outputs.length) return false;
	for (let i = 0; i < a.outputs.length; i++) {
		if (a.outputs[i].name !== b.outputs[i].name || a.outputs[i].mode !== b.outputs[i].mode) return false;
	}
	return treesEqual(normalizeTree(a.tree), normalizeTree(b.tree));
}

/** Flattens single-child groups (the renderer emits them unwrapped). */
function normalizeTree(node) {
	if (!("children" in node)) return node;
	const children = node.children.map(normalizeTree);
	// A single-child group renders identically to its child - flatten it.
	if (children.length === 1) return children[0];
	return { type: node.type, children };
}

function treesEqual(a, b) {
	if (("children" in a) !== ("children" in b)) return false;
	if (!("children" in a)) {
		if (!!a.fb !== !!b.fb) return false;
		if (a.name !== b.name) return false;
		if (!!a.negated !== !!b.negated) return false;
		if (a.fb && (a.fbType !== b.fbType || (a.pt || null) !== (b.pt || null))) return false;
		return true;
	}
	if (a.type !== b.type || a.children.length !== b.children.length) return false;
	for (let i = 0; i < a.children.length; i++) {
		if (!treesEqual(a.children[i], b.children[i])) return false;
	}
	return true;
}

/** Parses the rendered ladder text (NETWORK n: / FB calls / IF ... THEN /
 * coil := ...) back into a network tree. This is the inverse of
 * renderLadderNetworks. */
function parseRenderedLadder(text) {
	const networks = [];
	const lines = text.split(/\r?\n/);
	let current = null;
	for (const line of lines) {
		const netMatch = line.match(/^\s*NETWORK\s+(\d+):\s*$/);
		if (netMatch) {
			current = { elements: [], outputs: [], fbCalls: [], ifExpr: null, tree: null };
			networks.push(current);
			continue;
		}
		if (!current) continue;
		const fbCall = line.match(/^\s*(\w+)\s*\(\s*(IN|CLK):=([^,]+?)(?:,\s*PT:=([^)]+))?\)\s*;\s*$/);
		if (fbCall) {
			current.fbCalls.push({
				name: fbCall[1],
				inExpr: fbCall[3].trim(),
				pt: fbCall[4] ? fbCall[4].trim() : null,
				fbType: fbCall[2] === "CLK" ? "R_TRIG" : "TON",
			});
			continue;
		}
		const ifMatch = line.match(/^\s*IF\s+(.+?)\s+THEN\s*$/);
		if (ifMatch) {
			current.ifExpr = ifMatch[1].trim();
			continue;
		}
		const coilMatch = line.match(/^\s*(\w+)\s*:=\s*(DIRECT|SET|RESET)\s*;\s*$/);
		if (coilMatch) {
			current.outputs.push({ name: coilMatch[1], mode: coilMatch[2] });
			continue;
		}
	}
	for (const net of networks) {
		net.tree = buildTreeFromRendered(net.ifExpr, net.fbCalls);
	}
	return networks;
}

/** Builds a network tree from the rendered IF expression + FB call lines.
 * The IF expression carries the structure (with .Q references as FB leaves);
 * the FB calls supply each FB's type and PT. The FB's IN wiring is derived
 * from the tree on re-decode (assignFbWiring), so the encoder only needs the
 * FB leaf in the right tree position - but the IN chain elements that feed
 * the FB must be present in the tree, so they are reconstructed from the
 * call's IN expression when missing. */
function buildTreeFromRendered(ifExpr, fbCalls) {
	if (!ifExpr) return { type: "AND", children: [] };
	let tree = parseBooleanExpr(ifExpr);
	// Always keep a group at the top so the encoder's emitNode has a root.
	if (!("children" in tree)) tree = { type: "AND", children: [tree] };
	// Convert .Q leaves into FB leaves with type/PT from the calls.
	convertFbLeaves(tree, fbCalls);
	// Reconstruct IN chains: the rendered IF expression references only the
	// FB's .Q output, but the binary tree carries the FB's IN elements as
	// siblings in the same AND chain. Insert them before the FB leaf.
	reconstructInChains(tree, fbCalls);
	return tree;
}

function convertFbLeaves(node, fbCalls) {
	if (!("children" in node)) {
		if (node.name && node.name.endsWith(".Q")) {
			const fbName = node.name.slice(0, -2);
			const call = fbCalls.find((c) => c.name === fbName);
			node.fb = true;
			node.name = fbName;
			node.fbType = call ? call.fbType : "TON";
			node.pt = call ? call.pt : null;
		}
		return;
	}
	for (const child of node.children) convertFbLeaves(child, fbCalls);
}

/** Reconstructs FB IN chains: for each FB leaf, insert the elements of its
 * IN expression (from the call line) as siblings immediately before it in
 * the same AND group. The rendered IF only references the FB's .Q, but the
 * binary tree carries the IN elements as part of the rail. */
function reconstructInChains(tree, fbCalls) {
	function walk(node) {
		if (!("children" in node)) return;
		for (let i = 0; i < node.children.length; i++) {
			const child = node.children[i];
			if (!("children" in child) && child.fb) {
				const call = fbCalls.find((c) => c.name === child.name);
				if (call && call.inExpr && call.inExpr !== "TRUE") {
					const inElements = parseInElements(call.inExpr);
					// Insert missing IN elements before the FB in the same group.
					const existing = node.children
						.slice(0, i)
						.filter((c) => !("children" in c))
						.map((c) => (c.negated ? "NOT " : "") + c.name);
					const missing = inElements.filter((el) => !existing.includes(el));
					if (missing.length) {
						node.children.splice(i, 0, ...missing);
						i += missing.length;
					}
				}
			} else {
				walk(child);
			}
		}
	}
	walk(tree);
}

/** Parses an FB IN expression into a list of AND-separated element names. */
function parseInElements(expr) {
	const parts = [];
	let depth = 0, last = 0;
	for (let i = 0; i < expr.length; i++) {
		const c = expr[i];
		if (c === "(") depth++;
		else if (c === ")") depth--;
		else if (depth === 0 && expr.startsWith("AND", i)) {
			parts.push(expr.slice(last, i).trim());
			i += 2;
			last = i + 1;
		}
	}
	parts.push(expr.slice(last).trim());
	return parts.filter((p) => p.length).map((p) => {
		const neg = p.startsWith("NOT ");
		const name = neg ? p.slice(4).trim() : p.trim();
		return { name, negated: neg };
	});
}

/** Parses a boolean expression (AND/OR/NOT/parens) into a tree. This is the
 * inverse of renderTree. Handles the subset the renderer emits. */
function parseBooleanExpr(expr) {
	// Tokenize: identifiers, NOT, AND, OR, parens.
	const tokens = [];
	let i = 0;
	while (i < expr.length) {
		const c = expr[i];
		if (c === " " || c === "\t") { i++; continue; }
		if (c === "(") { tokens.push("("); i++; continue; }
		if (c === ")") { tokens.push(")"); i++; continue; }
		if (/[A-Za-z_]/.test(c)) {
			let j = i;
			while (j < expr.length && /[A-Za-z0-9_.]/.test(expr[j])) j++;
			const word = expr.slice(i, j);
			if (word === "AND" || word === "OR" || word === "NOT") tokens.push(word);
			else tokens.push({ name: word });
			i = j;
			continue;
		}
		throw new Error(`Cannot parse ladder expression near: ${expr.slice(i, i + 20)}`);
	}
	// Recursive descent: OR -> AND -> NOT -> primary.
	let pos = 0;
	function peek() { return tokens[pos]; }
	function next() { return tokens[pos++]; }
	function parseOr() {
		let left = parseAnd();
		while (peek() === "OR") { next(); const right = parseAnd(); left = { type: "OR", children: [left, right] }; }
		return left;
	}
	function parseAnd() {
		let left = parseNot();
		while (peek() === "AND") { next(); const right = parseNot(); left = { type: "AND", children: [left, right] }; }
		return left;
	}
	function parseNot() {
		if (peek() === "NOT") { next(); const child = parseNot(); return { type: "AND", children: [{ name: child.name, negated: true }] }; }
		return parsePrimary();
	}
	function parsePrimary() {
		const t = next();
		if (t === "(") {
			const inner = parseOr();
			if (next() !== ")") throw new Error("Unbalanced parens in ladder expression");
			return inner;
		}
		if (t && typeof t === "object" && t.name) return { name: t.name };
		throw new Error("Unexpected token in ladder expression");
	}
	return parseOr();
}

module.exports = { decodePro, applyPouEdit, decodeLadderBody, renderLadderNetworks, checkStSyntax, encodeLadderNetworks, applyLdPouEdit, parseRenderedLadder, networksEqual, splitNetworkBlocks };
