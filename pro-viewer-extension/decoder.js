// Decodes the plain-text POU source embedded inside a CoDeSys V2 / TwinCat PLC .pro
// binary project file. Validated against a manual CoDeSys "Export" of the SecurityDoor
// POU - the declaration + implementation text reconstructs byte-for-byte.
//
// The .pro format stores each POU's declarations and implementation as contiguous
// runs of printable ASCII/CRLF text, separated from each other (and from surrounding
// binary metadata / Visualization objects) by short non-printable framing bytes.

const POU_KEYWORDS = ["PROGRAM ", "FUNCTION_BLOCK ", "FUNCTION "];
const MIN_RUN_LENGTH = 20;

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

function cleanRange(buf, start, end) {
	const bytes = [];
	for (let i = start; i < end; i++) {
		if (isPrintable(buf[i])) bytes.push(buf[i]);
	}
	return Buffer.from(bytes).toString("latin1");
}

/**
 * Decodes every POU found in the .pro binary buffer.
 * Returns an array of { name, text, truncated } in file order.
 */
function decodePro(buf) {
	const starts = findPouStarts(buf);
	const results = [];

	for (let idx = 0; idx < starts.length; idx++) {
		const start = starts[idx];
		const end = idx + 1 < starts.length ? starts[idx + 1] : Math.min(start + 4000, buf.length);
		let text = cleanRange(buf, start, end);

		// A single stray framing byte is sometimes left between the declaration's
		// END_VAR and the start of the implementation text - drop it.
		text = text.replace(/END_VAR([^\s\r\n])/g, "END_VAR\r\n$1");

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
				}
			}
		}

		results.push({ name, text: text.trim(), truncated });
	}

	return results;
}

module.exports = { decodePro };
