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
const LD_FBINST_TAGS = new Set([0x05, 0x45]);
const LD_TIMELIT_TAG = 0x41;

/** Renders one node of a parsed AND/OR tree (see decodeLadderBody). A leaf is
 * a contact ({name, negated}); a group node is {type: "AND"|"OR", children}. */
function renderTreeNode(node) {
	if (!("children" in node)) return node.negated ? `NOT ${node.name}` : node.name;
	const parts = node.children.map((child) => {
		const rendered = renderTreeNode(child);
		return "children" in child && child.children.length > 1 ? `(${rendered})` : rendered;
	});
	if (parts.length <= 1) return parts[0] || "";
	return parts.join(node.type === "AND" ? " AND " : " OR ");
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

	function finalizeCurrent() {
		// A group that's still open when the network's last contact is reached
		// needs no explicit close byte - real data shows the outermost (and
		// often several nested) groups routinely rely on this instead of a
		// trailing 0x40. So simply auto-close whatever's left open; a *broken*
		// tree (invalid gap byte, or a close popping past the root mid-network)
		// was already flagged via treeOk=false above and stays flagged.
		if (current) stack.length = 1;
	}

	for (const rec of records) {
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
			current = { contacts: [], output: null, fbInstances: [], tree: root, treeOk: true };
			networks.push(current);
			stack = [root];
			freshNetwork = true;
		} else {
			gap = buf.subarray(lastEnd, rec.offset);
		}

		const base = rec.tag & ~(LD_CONTACT_NEGATED_BIT | 0x40);
		if (base === LD_CONTACT_BASE_TAG) {
			// Only trust gap bytes as AND/OR grammar when they sit directly between
			// two contacts (or right after a network's "08 FF" marker). If the
			// previous record was an FB-instance/time-literal, the bytes since then
			// are that record's own parameter data (e.g. a TON's preset/output
			// bits), not open/close bytes - a real network (HybridControl net 16)
			// has an FB instance and timer sitting between two plain-AND contacts,
			// and its trailing parameter bytes would otherwise look like garbage
			// "open" bytes and wrongly kill the whole network's tree.
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
			const leaf = { name: rec.name, negated: (rec.tag & LD_CONTACT_NEGATED_BIT) !== 0 };
			current.contacts.push(leaf);
			if (current.treeOk) {
				stack[stack.length - 1].children.push(leaf);
				if (rec.tag & 0x40) {
					if (stack.length <= 1) current.treeOk = false;
					else stack.pop();
				}
			}
		} else if (Object.prototype.hasOwnProperty.call(LD_OUTPUT_TAGS, rec.tag)) {
			current.output = { name: rec.name, ...LD_OUTPUT_TAGS[rec.tag] };
		} else if (LD_FBINST_TAGS.has(rec.tag)) {
			current.fbInstances.push(rec.name);
		} else if (rec.tag === LD_TIMELIT_TAG) {
			current.fbInstances.push(`T#${rec.name}`);
		}
		prevWasContact = base === LD_CONTACT_BASE_TAG;
		lastEnd = rec.offset + 2 + rec.name.length;
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
		if (!net.contacts.length) {
			condStr = "(no contacts decoded)";
		} else if (net.treeOk) {
			condStr = renderTreeNode(net.tree);
		} else {
			condStr = net.contacts.map((c) => (c.negated ? `NOT ${c.name}` : c.name)).join(" <AND/OR: MIXED, unresolved> ");
		}
		lines.push(`NETWORK ${idx + 1}:`);
		lines.push(`  IF ${condStr} THEN`);
		if (net.output) {
			const neg = net.output.polarity === "NEGATIV" ? "NOT " : "";
			lines.push(`    ${net.output.name} := ${neg}TRUE; // ${net.output.mode}`);
		} else {
			lines.push("    (no output decoded)");
		}
		if (net.fbInstances.length) {
			lines.push(`    // referenced FB instances / literals: ${net.fbInstances.join(", ")}`);
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
