// Validates the new stcheck.js against the REAL ground-truth ST POUs from a
// CoDeSys export (.EXP). This is the key test: real code must not produce
// false positives. Run with: node validate_real_pous.js
const fs = require("fs");
const { checkSt } = require("./stcheck");

const expPath = process.argv[2] || "../TEST CORPUS/EXPORT.EXP";
const text = fs.readFileSync(expPath, "utf8");
const lines = text.split(/\r?\n/);

// Extract each POU's source between its header (PROGRAM/FUNCTION/FUNCTION_BLOCK)
// and its terminator (END_PROGRAM/END_FUNCTION/END_FUNCTION_BLOCK).
const pouStartRe = /^(PROGRAM|FUNCTION_BLOCK|FUNCTION)\s+([A-Za-z0-9_]+)/;
const pouEndRe = /^END_(PROGRAM|FUNCTION_BLOCK|FUNCTION)\b/;

const pous = [];
let cur = null;
for (let i = 0; i < lines.length; i++) {
	const line = lines[i];
	if (!cur) {
		const m = line.match(pouStartRe);
		if (m) cur = { kind: m[1], name: m[2], start: i, body: [] };
	} else {
		if (pouEndRe.test(line)) {
			cur.body = cur.body.join("\n");
			pous.push(cur);
			cur = null;
		} else {
			cur.body.push(line);
		}
	}
}

let pass = 0, fail = 0;
const failures = [];
for (const pou of pous) {
	// Skip ladder POUs (they're not ST - the export stores them as binary
	// _FUNCTIONBLOCK markers or a _LD_BODY marker, so their body is non-ST).
	if (pou.body.trim().length === 0) continue;
	if (pou.body.includes("_LD_BODY")) continue;
	const r = checkSt(pou.body);
	const errs = r.diagnostics.filter((d) => d.severity === "error");
	if (errs.length) {
		fail++;
		failures.push({ name: pou.name, errs });
	} else {
		pass++;
	}
}

console.log(`Validated ${pass + fail} ST POUs from ${expPath}`);
console.log(`PASS: ${pass}  FAIL: ${fail}`);
for (const f of failures) {
	console.log(`\nFAIL ${f.name}:`);
	f.errs.slice(0, 5).forEach((e) => console.log(`   line ${e.line}: ${e.message}`));
}