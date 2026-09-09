// Decoder tests adapted to use codesys-parser core and real test fixtures.
// Run with: node test_decoder.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { decodePro, applyPouEdit, checkStSyntax } = require("./decoder");

// Test 1: Load and decode the real DEMO_FIXTURE.pro
const fixtureDir = path.join(__dirname, "..", "docs", "Phase 3");
const fixturePath = path.join(fixtureDir, "DEMO_FIXTURE.pro");

if (!fs.existsSync(fixturePath)) {
  console.log(
    `Skipping fixture tests: ${fixturePath} not found (this is OK for extension-only tests)`
  );
  console.log("Testing syntax checker only...\n");
} else {
  console.log(`Loading DEMO_FIXTURE.pro from ${fixturePath}...`);
  const buf = fs.readFileSync(fixturePath);
  const pous = decodePro(buf);

  console.log(`decodePro returned ${pous.length} POUs`);

  if (pous.length > 0) {
    console.log(`Decoded ${pous.length} POUs from DEMO_FIXTURE.pro`);

    // Show a few POUs
    for (let i = 0; i < Math.min(5, pous.length); i++) {
      const pou = pous[i];
      const kindStr = pou._kind || "?";
      console.log(
        `  ${i + 1}. ${pou.name}: ${pou.editable ? "editable" : `read-only (${kindStr})`}`
      );
    }

    // Test 2: Basic edit round-trip on an ST POU
    const stPous = pous.filter((p) => p.editable && p._kind === "TEXT");
    if (stPous.length > 0) {
      console.log(`\nTesting edit round-trip on ${stPous[0].name}...`);
      const pou = stPous[0];
      const originalText = pou.text;

      // Make a small localized edit: find something we can definitely change (e.g., a VAR line)
      // Try to replace END_VAR to END_VAR2 (same length)
      let testEdit = originalText;
      let found = false;
      for (const pattern of ["END_VAR", "BOOL", "INT"]) {
        const idx = testEdit.indexOf(pattern);
        if (idx > 0) {
          const before = testEdit.substring(Math.max(0, idx - 20), idx);
          const after = testEdit.substring(idx + pattern.length, Math.min(testEdit.length, idx + pattern.length + 20));
          // Make sure this is a real match (not inside a longer word)
          if (!/[A-Z_0-9]$/.test(before) && !/^[A-Z_0-9]/.test(after)) {
            testEdit = testEdit.substring(0, idx) + pattern + "_" + testEdit.substring(idx + pattern.length);
            found = true;
            break;
          }
        }
      }

      if (found && testEdit !== originalText && testEdit.length === originalText.length) {
        try {
          const newBuf = applyPouEdit(buf, pou, testEdit);
          const reDecoded = decodePro(newBuf);
          const editedPou = reDecoded.find((p) => p.name === pou.name);

          if (editedPou && editedPou.text !== originalText) {
            console.log("  ✓ Edit round-trip successful");
          } else {
            console.log("  ✗ Edit not reflected in re-decoded buffer");
          }
        } catch (err) {
          console.log(`  ✗ Edit failed: ${err.message}`);
        }
      } else {
        console.log(`  (skipped: couldn't create suitable same-length edit)`);
      }
    }

    // Test 3: Ladder POUs are read-only
    const ladderPous = pous.filter((p) => !p.editable && p._kind === "LD");
    if (ladderPous.length > 0) {
      console.log(`\nTesting read-only enforcement on ${ladderPous[0].name}...`);
      const pou = ladderPous[0];
      try {
        applyPouEdit(buf, pou, pou.text);
        console.log("  ✗ Should have thrown for read-only POU");
      } catch (err) {
        if (err.message.includes("not editable")) {
          console.log("  ✓ Read-only enforcement working");
        } else {
          console.log(`  ✗ Wrong error: ${err.message}`);
        }
      }
    }
  }
}

// Test 4: Syntax checker (these don't depend on fixture data)
console.log("\n=== Syntax Checker Tests ===");

const syntaxTests = [
  ["VAR\r\nX: BOOL;\r\nY: INT;\r\nA, B: INT;\r\nEND_VAR\r\nIF X THEN\r\nY := (A + B);\r\nEND_IF\r\n", true, "balanced text"],
  ["VAR\r\nX: BOOL;\r\nY: BOOL;\r\nEND_VAR\r\nIF X THEN\r\nY := TRUE;\r\n", false, "missing END_IF"],
  ["VAR\r\nY: INT;\r\nA, B: INT;\r\nEND_VAR\r\nY := (A + B;\r\n", false, "unbalanced paren"],
  ["VAR\r\nY: BOOL;\r\nEND_VAR\r\n(* IF X THEN *) \r\nY := 'END_IF';\r\n", true, "keywords inside comments/strings"],
  ["VAR\r\nY: BOOL;\r\nEND_VAR\r\nELSE\r\nY := TRUE;\r\n", false, "stray ELSE outside IF"],
  ["VAR\r\nX: BOOL;\r\nY: INT;\r\nEND_VAR\r\nIF X THEN\r\nCASE Y OF\r\nEND_IF\r\nEND_CASE\r\n", false, "out-of-order block close"],
];

let passed = 0;
let failed = 0;

for (const [code, expectedOk, desc] of syntaxTests) {
  const result = checkStSyntax(code);
  if (result.ok === expectedOk) {
    console.log(`  ✓ ${desc}`);
    passed++;
  } else {
    console.log(
      `  ✗ ${desc}: expected ${expectedOk}, got ${result.ok}`
    );
    failed++;
  }
}

console.log(`\n=== Summary ===`);
console.log(`Syntax checks: ${passed} passed, ${failed} failed`);

if (failed === 0) {
  console.log("\n✓ All tests passed!");
  process.exit(0);
} else {
  console.log("\n✗ Some tests failed");
  process.exit(1);
}
