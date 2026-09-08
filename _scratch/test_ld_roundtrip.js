// Round-trip test for LD write-back. The save path (applyLdPouEdit) preserves
// unchanged networks byte-for-byte and re-encodes changed ones. This test:
//   1. Decodes each LD POU, re-applies its OWN text (no edits) -> must be
//      byte-identical to the original .pro.
//   2. Makes a real edit to one network -> the edited POU must re-decode to
//      the edited text, and every OTHER POU must be byte-identical.
"use strict";
const fs = require("fs");
const { decodePro, applyLdPouEdit } = require("../pro-viewer-extension/decoder");

const LD_NAMES = ["CanopyControl", "ControlledBuffer", "HybridControl", "GlobalFlags", "Intrusion", "RearTrack"];
let pass = 0, fail = 0;

for (const f of fs.readdirSync("TEST CORPUS").filter((f) => f.endsWith(".pro"))) {
  const orig = fs.readFileSync("TEST CORPUS/" + f);
  const pous = decodePro(orig);
  for (const name of LD_NAMES) {
    const pou = pous.find((p) => p.name === name);
    if (!pou) { console.log(`SKIP ${f}: ${name} not found`); continue; }

    // Test 1: no-op save must be byte-identical.
    try {
      const newBuf = applyLdPouEdit(orig, pou, pou.text);
      if (newBuf.length === orig.length && newBuf.equals(orig)) {
        pass++;
        console.log(`PASS ${f}: ${name} no-op save byte-identical`);
      } else {
        fail++;
        const n = Math.min(newBuf.length, orig.length);
        let diff = -1;
        for (let k = 0; k < n; k++) if (newBuf[k] !== orig[k]) { diff = k; break; }
        console.log(`FAIL ${f}: ${name} no-op save differs (len ${newBuf.length} vs ${orig.length}, first diff at ${diff})`);
        if (diff >= 0) {
          console.log(`  orig: ${Array.from(orig.subarray(Math.max(0,diff-8), diff+12)).map((b)=>b.toString(16).padStart(2,"0")).join(" ")}`);
          console.log(`  new : ${Array.from(newBuf.subarray(Math.max(0,diff-8), diff+12)).map((b)=>b.toString(16).padStart(2,"0")).join(" ")}`);
        }
      }
    } catch (e) {
      fail++;
      console.log(`FAIL ${f}: ${name} no-op save threw: ${e.message}`);
    }

    // Test 2: real edit - change a coil name in the first network.
    const coilRe = /^(\s*)([A-Za-z_]\w*)(\s*:=\s*(DIRECT|SET|RESET)\s*;)$/m;
    const coilMatch = pou.text.match(coilRe);
    if (coilMatch) {
      const newName = coilMatch[2] + "_Edited";
      const edited2 = pou.text.replace(coilRe, `$1${newName}$3`);
      try {
        const newBuf = applyLdPouEdit(orig, pou, edited2);
        const reDecoded = decodePro(newBuf);
        const rePou = reDecoded.find((p) => p.name === name);
        if (rePou && rePou.text.includes(newName)) {
          const otherChanged = reDecoded.some((p, i) => p.name !== name && p.text !== pous[i].text);
          if (!otherChanged) {
            pass++;
            console.log(`PASS ${f}: ${name} edit round-trips (coil ${coilMatch[2]} -> ${newName})`);
          } else {
            fail++;
            console.log(`FAIL ${f}: ${name} edit changed another POU`);
          }
        } else {
          fail++;
          console.log(`FAIL ${f}: ${name} edit did not round-trip (newName=${newName} found=${rePou && rePou.text.includes(newName)})`);
        }
      } catch (e) {
        fail++;
        console.log(`FAIL ${f}: ${name} edit threw: ${e.message}`);
      }
    } else {
      console.log(`SKIP ${f}: ${name} no coil found for edit test`);
    }
  }
}
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);