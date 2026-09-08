// Simulates the exact sequence VS Code performs when resolving a mounted
// workspace folder backed by our virtual FS:
//   1. stat(root)          -> must return Directory (this was the "unable to
//                             resolve workspace folder" bug)
//   2. readDirectory(root) -> lists POU_NAME.st entries
//   3. stat(pou)           -> must return File
//   4. readFile(pou)       -> returns the decoded ST text
//   5. writeFile(pou)      -> re-encodes back into the .pro (round-trip)
//
// The vscode module isn't available outside the extension runtime, so this
// tests the pure logic in uri.js + decoder.js that the provider uses.
// Run with: node test_mount_flow.js
const assert = require("assert");
const fs = require("fs");
const { decodePro, applyPouEdit } = require("./decoder");
const { rootUri, pouUri, proPathFromUri, pouNameFromUri } = require("./uri");

const PRO_PATH = "../TEST CORPUS/101079 BSL.pro";

// 1. Root URI resolves to a directory (empty POU name).
const root = rootUri(PRO_PATH);
assert.strictEqual(proPathFromUri(root), PRO_PATH, "root -> pro path");
assert.strictEqual(pouNameFromUri(root), "", "root -> empty POU name (directory)");

// 2. readDirectory equivalent: decode the .pro and list POU names.
const buf = fs.readFileSync(PRO_PATH);
const pous = decodePro(buf);
assert.ok(pous.length > 0, "expected POUs");
const names = pous.map((p) => p.name + ".st");
assert.ok(names.includes("SecurityDoor.st"), "expected SecurityDoor.st in listing");

// 3. A POU URI resolves to a file.
const pou = pouUri(PRO_PATH, "SecurityDoor");
assert.strictEqual(proPathFromUri(pou), PRO_PATH, "pou -> pro path");
assert.strictEqual(pouNameFromUri(pou), "SecurityDoor", "pou -> name");

// 4. readFile equivalent: find the POU and return its text.
const target = pous.find((p) => p.name === "SecurityDoor");
assert.ok(target, "SecurityDoor POU exists");
assert.ok(target.text.includes("PROGRAM SecurityDoor"), "decoded text has the header");

// 5. writeFile equivalent: apply an edit and verify round-trip.
const newText = target.text.replace(":= TRUE", ":= FALSE");
const newBuf = applyPouEdit(buf, target, newText);
const verify = decodePro(newBuf);
const verifyPou = verify.find((p) => p.name === "SecurityDoor");
assert.strictEqual(verifyPou.text, newText, "edited POU round-trips exactly");
assert.ok(
	verify.length === pous.length && pous.every((p, i) => p === target || p.text === verify[i].text),
	"no other POU changed"
);

console.log("Mount flow OK: root resolves as directory, POUs list, read + write round-trip.");
console.log(`  ${pous.length} POUs, ${pous.filter((p) => p.editable).length} editable.`);