// Decodes the plain-text POU source embedded inside a CoDeSys V2 / TwinCat PLC .pro
// binary project file. Validated against a manual CoDeSys "Export" of the SecurityDoor
// POU - the declaration + implementation text reconstructs byte-for-byte.
//
// The .pro format stores each POU's declarations and implementation as contiguous
// runs of printable ASCII/CRLF text, separated from each other (and from surrounding
// binary metadata / Visualization objects) by short non-printable framing bytes.

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
const LD_OUTPUT_TAGS = {
	0x00: { polarity: "POSITIV", mode: "NO_SET" },
	0x02: { polarity: "POSITIV", mode: "SET" },
	0x03: { polarity: "NEGATIV", mode: "SET" },
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
 * pin, since that (not the call itself) is what continues the rail forward -
 * confirmed against the real project's own convention for chaining FB
 * outputs, e.g. "UpperPEEdge(CLK:=OpenPEFilter.Q)".
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

/** Renders an FB-instance leaf as a standalone call statement, ST-style,
 * using the `inExpr` wiring computed by assignFbWiring. */
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
		if (current) stack.length = 1;
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
			finalizeCurrent();
			gap = markerPos !== -1 ? buf.subarray(markerPos + 2, rec.offset) : Buffer.alloc(0);
			const root = { type: "AND", children: [] };
			current = { elements: [], outputs: [], fbInstances: [], tree: root, treeOk: true };
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
				stack[stack.length - 1].children.push(node);
				stack.push(node);
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
					if (stack.length <= 1) current.treeOk = false;
					else stack.pop();
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

/** Renders decoded networks as a readable, clearly-labeled best-effort text block. */
function renderLadderNetworks(networks) {
	if (!networks.length) return "";
	const lines = [
		"",
		"// --- Best-effort decoded ladder logic (read-only, NOT validated for safety-critical use) ---",
		"// Cross-check against a real TwinCAT/CoDeSys export before relying on this. Contact/output/FB",
		"// roles, contact negation, and AND/OR are decoded from confirmed binary tag/header bytes; a",
		"// MIXED network's exact grouping could not be fully recovered and is left unresolved (see README).",
	];
	networks.forEach((net, idx) => {
		let condStr;
		let fbCalls = [];
		if (!net.elements.length) {
			condStr = "(no contacts decoded)";
		} else if (net.treeOk) {
			condStr = assignFbWiring(net.tree, "TRUE");
			// Emit each FB instance as its own labeled call statement (IN/CLK + PT
			// wiring, ST-style - matches how the real project's own ST source calls
			// these same FB types), in rung order, before the IF that uses their .Q.
			fbCalls = net.elements.filter((el) => el.fb).map(renderFbCall);
		} else {
			condStr = net.elements.map(renderLeaf).join(" <AND/OR: MIXED, unresolved> ");
		}
		lines.push(`NETWORK ${idx + 1}:`);
		for (const call of fbCalls) lines.push(`  ${call}`);
		lines.push(`  IF ${condStr} THEN`);
		if (net.outputs.length) {
			for (const out of net.outputs) {
				const neg = out.polarity === "NEGATIV" ? "NOT " : "";
				lines.push(`    ${out.name} := ${neg}TRUE; // ${out.mode}`);
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
function findPouStarts(buf) {
	const runs = findPrintableRuns(buf);
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
	const starts = findPouStarts(buf);
	const results = [];

	for (let idx = 0; idx < starts.length; idx++) {
		const start = starts[idx];
		const end = idx + 1 < starts.length ? starts[idx + 1] : Math.min(start + 4000, buf.length);
		let { text, positions } = cleanRangeWithPositions(buf, start, end);

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

		// Name of this POU, read off its own header line.
		const headerMatch = text.match(/^(PROGRAM|FUNCTION_BLOCK|FUNCTION)\s+([A-Za-z0-9_]+)/);
		const name = headerMatch ? headerMatch[2] : `Unknown_${start}`;

		// Trailing bytes often carry the *next* POU's name (an internal database
		// forward-link) swept up by our scan. Only trim it if it's clearly marked
		// off by a comma shortly beforehand, to avoid cutting real code that
		// legitimately references another POU's name.
		let truncated = false;
		if (idx + 1 < starts.length) {
			const nextHeader = buf.toString("latin1", starts[idx + 1], starts[idx + 1] + 60);
			const nextNameMatch = nextHeader.match(/^(PROGRAM|FUNCTION_BLOCK|FUNCTION)\s+([A-Za-z0-9_]+)/);
			const nextName = nextNameMatch ? nextNameMatch[2] : null;
			if (nextName) {
				const tailStart = Math.max(0, text.length - 400);
				const commaIdx = text.lastIndexOf("," + nextName);
				if (commaIdx >= tailStart) {
					const head = text.slice(0, commaIdx);
					const terminatorRe = /(END_IF|END_CASE|END_WHILE|END_FOR|END_REPEAT|;)\s*/g;
					let m, last = null;
					while ((m = terminatorRe.exec(head)) !== null) last = m;
					text = last ? head.slice(0, last.index + last[0].length) : head;
					truncated = true;
					// This trim only shortens text from the end (a prefix slice), so
					// positions[i] still maps to text[i] for every surviving
					// character - keep it editable.
					if (editable) positions = positions.slice(0, text.length);
				}
			}
		}

		// Trim leading/trailing whitespace, keeping `positions` in lockstep so
		// positions[i] still maps to text[i] for the surviving editable case.
		const trimmedStart = text.length - text.trimStart().length;
		const trimmed = text.trim();
		if (editable) positions = positions.slice(trimmedStart, trimmedStart + trimmed.length);
		text = trimmed;

		if (KNOWN_LD_POUS.has(name)) {
			editable = false;
			try {
				const networks = decodeLadderBody(buf, start, end);
				text += renderLadderNetworks(networks);
			} catch (e) {
				// Best-effort only - if the scan fails, keep just the declaration text.
			}
		}

		results.push({ name, text, truncated, editable, positions: editable ? positions : null });
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
	return Buffer.concat([buf.subarray(0, spliceStart), middleBytes, buf.subarray(spliceEnd)]);
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
 * Lazy sanity check for edited Structured Text: not a real parser, just
 * confirms the block keywords and bracket/paren nesting this codebase
 * actually uses (see EXPORT.EXP keyword survey) are still balanced after an
 * edit. Catches the common slip (deleted an END_IF, mismatched parens) before
 * it's written to disk; does not catch every possible syntax error and is not
 * a substitute for a Rebuild in TwinCat. Returns { ok: true } or
 * { ok: false, error }.
 */
function checkStSyntax(text) {
	for (const [openRe, closeRe] of ST_BLOCK_PAIRS) {
		const opens = (text.match(openRe) || []).length;
		const closes = (text.match(closeRe) || []).length;
		if (opens !== closes) {
			const keyword = closeRe.source.replace(/\\b/g, "");
			return { ok: false, error: `Unbalanced ${keyword}: ${opens} opening keyword(s) vs ${closes} closer(s).` };
		}
	}
	for (const [open, close, label] of [["(", ")", "parentheses"], ["[", "]", "brackets"]]) {
		let depth = 0;
		for (const ch of text) {
			if (ch === open) depth++;
			else if (ch === close) {
				depth--;
				if (depth < 0) return { ok: false, error: `Unbalanced ${label}: closed one that was never opened.` };
			}
		}
		if (depth !== 0) return { ok: false, error: `Unbalanced ${label}: ${depth} unclosed.` };
	}
	return { ok: true };
}

module.exports = { decodePro, applyPouEdit, decodeLadderBody, renderLadderNetworks, checkStSyntax };
