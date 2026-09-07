// Minimal self-check for decoder.js. Run with: node test_decoder.js
const assert = require("assert");
const { decodePro, applyPouEdit, decodeLadderBody, renderLadderNetworks, checkStSyntax } = require("./decoder");

function buildFakePro() {
	const noise = Buffer.from([0x00, 0x01, 0x02, 0x00, 0x00, 0x00]);
	const pouA = Buffer.from("PROGRAM Foo\r\nVAR\r\n\tX: BOOL;\r\nEND_VAR\r\nX := TRUE;\r\n", "latin1");
	// Synthetic ladder body: 08 FF network marker, a CONTACT record (tag 0x0b,
	// len 3, "Foo") then an OUTPUT record (tag 0x02 = POSITIV/SET, len 3, "Bar").
	const pouBHeader = Buffer.from("PROGRAM HybridControl\r\nVAR\r\nEND_VAR", "latin1");
	const ladderBody = Buffer.from([0x08, 0xff, 0x0b, 0x03, 0x46, 0x6f, 0x6f, 0x02, 0x03, 0x42, 0x61, 0x72]); // "Foo", "Bar"
	const pouB = Buffer.concat([pouBHeader, ladderBody]);
	return Buffer.concat([noise, pouA, noise, pouB, noise]);
}

// 1. Basic decode finds both POUs.
const buf = buildFakePro();
const pous = decodePro(buf);
assert.strictEqual(pous.length, 2, "expected 2 POUs");
assert.strictEqual(pous[0].name, "Foo");
assert.strictEqual(pous[1].name, "HybridControl");

// 2. ST POU is editable; known LD POU name is forced read-only.
assert.strictEqual(pous[0].editable, true, "Foo should be editable");
assert.strictEqual(pous[1].editable, false, "HybridControl should be forced read-only");

// 3. Same-length edit round-trips: text changes, everything else untouched.
const okEdit = pous[0].text.replace("X := TRUE;", "X := FALSE");  // same length (11 chars either way)
assert.strictEqual(okEdit.length, pous[0].text.length, "test fixture bug: edit must be same length");
const newBuf = applyPouEdit(buf, pous[0], okEdit);
assert.strictEqual(newBuf.length, buf.length, "same-length edit must not change file length");
const reDecoded = decodePro(newBuf);
assert.strictEqual(reDecoded[0].text, okEdit, "round-trip must reproduce the exact edit");
assert.strictEqual(reDecoded[1].text, pous[1].text, "untouched POU must be byte-identical");

// 3b. Length-changing edits now work: growing and shrinking a POU shifts
// everything after it, and the other POU is unaffected.
const growEdit = pous[0].text.replace("X: BOOL;", "X: BOOL; Y: BOOL;");
const grownBuf = applyPouEdit(buf, pous[0], growEdit);
assert.strictEqual(grownBuf.length, buf.length + (growEdit.length - pous[0].text.length), "file must grow by exactly the added byte count");
const growDecoded = decodePro(grownBuf);
assert.strictEqual(growDecoded[0].text, growEdit, "grown POU must round-trip exactly");
assert.strictEqual(growDecoded[1].text, pous[1].text, "other POU must survive a shift untouched");

const shrinkEdit = pous[0].text.replace("PROGRAM Foo", "PROGRAM F");
const shrunkBuf = applyPouEdit(buf, pous[0], shrinkEdit);
assert.strictEqual(shrunkBuf.length, buf.length - 2, "file must shrink by exactly the removed byte count");
const shrinkDecoded = decodePro(shrunkBuf);
assert.strictEqual(shrinkDecoded[0].text, shrinkEdit, "shrunk POU must round-trip exactly");
assert.strictEqual(shrinkDecoded[1].text, pous[1].text, "other POU must survive a shrink untouched");

// 4. Editing a non-editable POU must throw and must not be silently accepted.
assert.throws(() => applyPouEdit(buf, pous[1], pous[1].text), /not editable/);

// 5. Known LD POU's decoded text includes a readable rendering of its ladder
// body (synthetic CONTACT "Foo" + OUTPUT "Bar" bytes from buildFakePro).
assert.ok(pous[1].text.includes("NETWORK 1:"), "expected a decoded NETWORK line");
assert.ok(pous[1].text.includes("Foo"), "expected decoded contact name Foo");
assert.ok(pous[1].text.includes("Bar := TRUE"), "expected decoded output Bar := TRUE");

// 6. Network-boundary regression check: real HybridControl data showed the
// "08 FF" network marker separated from the next record's tag byte by 0-3
// filler bytes (not always 0), which silently merged all networks into one
// under the old exact-2-byte-adjacency check. Build two synthetic networks
// with different filler-byte counts and confirm they still split correctly.
const net1 = Buffer.from([0x08, 0xff, 0x09, 0x0a, 0x0b, 0x03, 0x41, 0x41, 0x41]); // 2 filler bytes, contact "AAA"
const net2 = Buffer.from([0x08, 0xff, 0x0b, 0x03, 0x42, 0x42, 0x42]); // 0 filler bytes, contact "BBB"
const ladderBody2 = Buffer.concat([net1, net2]);
const networks = decodeLadderBody(Buffer.concat([Buffer.from("PROGRAM X\r\nVAR\r\nEND_VAR", "latin1"), ladderBody2]), 0, 23 + ladderBody2.length);
assert.strictEqual(networks.length, 2, "expected 2 separate networks despite differing filler-byte counts");
assert.strictEqual(networks[0].elements[0].name, "AAA");
assert.strictEqual(networks[1].elements[0].name, "BBB");

// 7. AND/OR tree: validated against many real controlled edits (see decoder.js
// comment) - a stray byte before a contact opens a group (0x09=AND, 0x0A=OR),
// and 0x40 on a contact's own tag closes the innermost open group. A single
// contact needs no open/close at all.
const orNet = Buffer.from([0x08, 0xff, 0x0a, 0x0b, 0x03, 0x41, 0x41, 0x41, 0x4b, 0x03, 0x42, 0x42, 0x42]); // OR(AAA, BBB)
const andNet = Buffer.from([0x08, 0xff, 0x09, 0x0b, 0x03, 0x41, 0x41, 0x41, 0x4b, 0x03, 0x42, 0x42, 0x42]); // AND(AAA, BBB)
const singleNet = Buffer.from([0x08, 0xff, 0x0b, 0x03, 0x43, 0x43, 0x43]); // just CCC, no open byte
const nestedNet = Buffer.from([
	0x08, 0xff, 0x0b, 0x03, 0x41, 0x41, 0x41, // AAA (plain, top-level AND)
	0x4a, 0x09, 0x0a, 0x0b, 0x03, 0x42, 0x42, 0x42, // open OR, open AND, open OR -> BBB
	0x4b, 0x03, 0x43, 0x43, 0x43, // CCC, closes innermost OR
	0x4b, 0x03, 0x44, 0x44, 0x44, // DDD, closes AND
	0x4b, 0x03, 0x45, 0x45, 0x45, // EEE, closes outer OR
]); // AAA AND (((BBB OR CCC) AND DDD) OR EEE)
for (const [bytes, expected] of [
	[orNet, "AAA OR BBB"],
	[andNet, "AAA AND BBB"],
	[singleNet, "CCC"],
	[nestedNet, "AAA AND (((BBB OR CCC) AND DDD) OR EEE)"],
]) {
	const nets = decodeLadderBody(Buffer.concat([Buffer.from("PROGRAM X\r\nVAR\r\nEND_VAR", "latin1"), bytes]), 0, 23 + bytes.length);
	assert.strictEqual(nets[0].treeOk, true, "expected a fully-balanced tree");
	assert.strictEqual(renderLadderNetworks(nets).includes(expected), true, `expected rendered text to include "${expected}"`);
}

// 7b. A group left open when the network ends needs no explicit close (real
// data relies on this - see decoder.js comment) - it must still parse cleanly.
const openEndedNet = Buffer.from([0x08, 0xff, 0x0a, 0x0b, 0x03, 0x41, 0x41, 0x41, 0x0b, 0x03, 0x42, 0x42, 0x42]); // OR(AAA, BBB), no trailing close
const openEndedNets = decodeLadderBody(Buffer.concat([Buffer.from("PROGRAM X\r\nVAR\r\nEND_VAR", "latin1"), openEndedNet]), 0, 23 + openEndedNet.length);
assert.strictEqual(openEndedNets[0].treeOk, true, "an implicitly-closed trailing group must still be trusted");
assert.strictEqual(renderLadderNetworks(openEndedNets).includes("AAA OR BBB"), true);

// 7c. Genuine errors still fall back to flat MIXED text: a close that pops
// past the root (over-closing) and an unrecognized gap byte value.
const overClosedNet = Buffer.from([0x08, 0xff, 0x4b, 0x03, 0x41, 0x41, 0x41, 0x0b, 0x03, 0x42, 0x42, 0x42]); // AAA closes with nothing open
const overClosedNets = decodeLadderBody(Buffer.concat([Buffer.from("PROGRAM X\r\nVAR\r\nEND_VAR", "latin1"), overClosedNet]), 0, 23 + overClosedNet.length);
assert.strictEqual(overClosedNets[0].treeOk, false, "over-closing must not be trusted");

const badByteNet = Buffer.from([0x08, 0xff, 0x99, 0x0b, 0x03, 0x41, 0x41, 0x41, 0x0b, 0x03, 0x42, 0x42, 0x42]); // unrecognized gap byte
const badByteNets = decodeLadderBody(Buffer.concat([Buffer.from("PROGRAM X\r\nVAR\r\nEND_VAR", "latin1"), badByteNet]), 0, 23 + badByteNet.length);
assert.strictEqual(badByteNets[0].treeOk, false, "an unrecognized gap byte must not be trusted");

// 7d. Timer (TON) FB-instance decoding: instance name, PT literal and type name
// (bare Pascal-string when a PT operand is present), reproduced from the exact
// bytes of a real corpus rung (ControlledBuffer NETWORK 6 in TEST CORPUS/101079
// BSL.pro - RunToRearTimer(PT:=T#6000ms), IN chained off contact BRRunToPE,
// output BRRunToPE NEGATIV/SET). Cross-checked against TEST CORPUS/EXPORT.EXP.
const timerNet = Buffer.from([
	0x08, 0xff, 0x09, // network marker + AND-group open
	0x0b, 0x09, ...Buffer.from("BRRunToPE"), // contact, non-terminal
	0x45, 0x0e, ...Buffer.from("RunToRearTimer"), // FB instance, terminal (closes group)
	0x00, 0x41, 0x08, ...Buffer.from("T#6000ms"), // PT literal
	0x03, ...Buffer.from("TON"), // bare Pascal-string type name (no tag byte)
	0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // fixed 8-byte trailer
	0x01, 0x00, 0x03, 0x09, ...Buffer.from("BRRunToPE"), // 1-entry output list: NEGATIV/SET
]);
const timerNets = decodeLadderBody(Buffer.concat([Buffer.from("PROGRAM X\r\nVAR\r\nEND_VAR", "latin1"), timerNet]), 0, 23 + timerNet.length);
assert.strictEqual(timerNets[0].treeOk, true, "timer rung must produce a fully-balanced tree");
const timerRendered = renderLadderNetworks(timerNets);
assert.ok(timerRendered.includes("RunToRearTimer(IN:=BRRunToPE, PT:=T#6000ms);"), "expected a labeled ST-style FB call statement, IN wired from the preceding contact");
assert.ok(timerRendered.includes("IF (BRRunToPE AND RunToRearTimer.Q) THEN"), "expected the condition to reference the FB's .Q output");
assert.ok(timerRendered.includes("BRRunToPE := NOT TRUE; // SET"), "expected the network's NEGATIV/SET output coil");

// 7e. Cascaded timers with a nested group right after a non-terminal FB's own
// trailing bytes (PT + type name + 8-byte trailer) must not be misread as
// AND/OR grammar, and the real gap byte immediately after that trailer must
// still be trusted (reproduced from HybridControl NETWORK 16 in the same
// corpus file - RunRelJamTimer OR (InductPE1 AND RunToReleaseTimer)).
const cascadeNet = Buffer.from([
	0x08, 0xff, 0x09, // network marker + AND-group open
	0x0b, 0x08, ...Buffer.from("BRRunRel"), // contact, non-terminal
	0x4a, // OR-group open (with rightmost-spine bit)
	0x05, 0x0e, ...Buffer.from("RunRelJamTimer"), // FB, non-terminal (first child of OR)
	0x00, 0x41, 0x08, ...Buffer.from("T#4000ms"),
	0x03, ...Buffer.from("TON"),
	0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // trailer
	0x49, // AND-group open (with rightmost-spine bit) - must still be trusted after the trailer
	0x0b, 0x09, ...Buffer.from("InductPE1"), // contact, non-terminal
	0x45, 0x11, ...Buffer.from("RunToReleaseTimer"), // FB, terminal (closes AND; OR auto-closes at network end)
	0x00, 0x41, 0x08, ...Buffer.from("T#1000ms"),
	0x03, ...Buffer.from("TON"),
	0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x01, 0x00, 0x03, 0x08, ...Buffer.from("BRRunRel"),
]);
const cascadeNets = decodeLadderBody(Buffer.concat([Buffer.from("PROGRAM X\r\nVAR\r\nEND_VAR", "latin1"), cascadeNet]), 0, 23 + cascadeNet.length);
assert.strictEqual(cascadeNets[0].treeOk, true, "cascaded-timer rung must produce a fully-balanced tree");
const cascadeRendered = renderLadderNetworks(cascadeNets);
assert.ok(
	cascadeRendered.includes("IF (BRRunRel AND (RunRelJamTimer.Q OR (InductPE1 AND RunToReleaseTimer.Q))) THEN"),
	"expected the nested OR(FB, AND(contact, FB)) tree, not a flattened 3-way OR"
);
// Each FB's IN is the rail's accumulated power at its exact position: the
// first (non-terminal, OR-branch) timer sees just the AND-chain before the
// OR split; the second (terminal, nested inside the AND branch) additionally
// sees the contact preceding it within that branch.
assert.ok(cascadeRendered.includes("RunRelJamTimer(IN:=BRRunRel, PT:=T#4000ms);"), "expected first timer's IN wired from the preceding contact only");
assert.ok(
	cascadeRendered.includes("RunToReleaseTimer(IN:=BRRunRel AND InductPE1, PT:=T#1000ms);"),
	"expected second timer's IN to include both the outer contact and its own branch's contact"
);

// 8. Syntax checker: balanced text passes, a dropped END_IF / stray paren fails.
assert.strictEqual(checkStSyntax("IF X THEN\r\nY := (A + B);\r\nEND_IF\r\n").ok, true);
assert.strictEqual(checkStSyntax("IF X THEN\r\nY := TRUE;\r\n").ok, false, "missing END_IF must fail");
assert.strictEqual(checkStSyntax("Y := (A + B;\r\n").ok, false, "unbalanced paren must fail");

console.log("All decoder self-checks passed.");
