// Simulates the virtualfs read/write flow against a real .pro file, without
// needing the vscode runtime. Exercises: decodePro (read), applyPouEdit
// (write), and the round-trip safety net - the exact logic virtualfs.js uses.
// Run with: node test_virtualfs.js
const assert = require("assert");
const fs = require("fs");
const { decodePro, applyPouEdit } = require("./decoder");
const { checkSt } = require("./stcheck");
const { rootUri, pouUri, proPathFromUri, pouNameFromUri } = require("./uri");

const PRO_PATH = "../TEST CORPUS/101079 BSL.pro";

// 1. URI helpers round-trip (via vscode-uri, which is what VS Code uses).
const root = rootUri(PRO_PATH);
const pou = pouUri(PRO_PATH, "SecurityDoor");
assert.ok(root.scheme === "codesys-pou", "root URI scheme");
assert.ok(pou.path.endsWith("SecurityDoor.st"), "pou URI ends with .st");
assert.strictEqual(proPathFromUri(pou), PRO_PATH, "pro path round-trips");
assert.strictEqual(pouNameFromUri(pou), "SecurityDoor", "pou name round-trips");

// 2. Read path: decode the real .pro, find an editable ST POU.
const buf = fs.readFileSync(PRO_PATH);
const pous = decodePro(buf);
const editable = pous.filter((p) => p.editable);
assert.ok(editable.length > 0, "expected at least one editable ST POU");
console.log(`Decoded ${pous.length} POUs, ${editable.length} editable.`);

// 3. Write path: pick an editable POU, make a length-changing edit INSIDE the
//    body (not at the very end - trailing whitespace is trimmed on re-decode),
//    apply it, and verify the round-trip safety net passes (the edited POU
//    comes back exactly, no other POU changed).
const target = editable[0];
const anchor = target.text.includes(":= TRUE") ? ":= TRUE" : ":= FALSE";
const newText = target.text.replace(anchor, anchor + " (* virtualfs test edit *)");
assert.notStrictEqual(newText, target.text, "test fixture: edit must change the text");
const newBuf = applyPouEdit(buf, target, newText);
const verify = decodePro(newBuf);
const verifyPou = verify.find((p) => p.name === target.name);
assert.strictEqual(verifyPou.text, newText, "edited POU must round-trip exactly");
assert.ok(
	verify.length === pous.length && pous.every((p, i) => p === target || p.text === verify[i].text),
	"no other POU may change"
);
console.log(`Write-back round-trip OK for ${target.name} (grew by ${newText.length - target.text.length} bytes).`);

// 4. Syntax gate: the checker must accept the edited text (no errors).
const syntax = checkSt(newText);
const errors = syntax.diagnostics.filter((d) => d.severity === "error");
assert.strictEqual(errors.length, 0, `syntax gate must pass for a valid edit, got: ${JSON.stringify(errors)}`);

// 5. Syntax gate blocks invalid text.
const badText = target.text.replace("END_VAR", "END_VAR\r\nIF X THEN"); // unbalanced IF
const badSyntax = checkSt(badText);
assert.ok(badSyntax.diagnostics.some((d) => d.severity === "error"), "syntax gate must reject unbalanced IF");

console.log("All virtualfs-flow self-checks passed.");