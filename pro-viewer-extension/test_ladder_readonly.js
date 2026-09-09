// Test that ladder POUs are correctly read-only
const assert = require("assert");
const fs = require("fs");
const { decodePro, applyPouEdit } = require("./decoder");

const PRO_PATH = "../docs/Phase 3/DEMO_FIXTURE.pro";

if (!fs.existsSync(PRO_PATH)) {
  console.log(`Skipping ladder read-only test: ${PRO_PATH} not found`);
  process.exit(0);
}

const buf = fs.readFileSync(PRO_PATH);
const pous = decodePro(buf);

// Find a ladder POU
const ladderPous = pous.filter((p) => !p.editable && p._kind === "LD");
if (ladderPous.length === 0) {
  console.log("No ladder POUs found in fixture (unexpected)");
  process.exit(1);
}

const ladderPou = ladderPous[0];
console.log(`Testing ladder read-only on ${ladderPou.name}...`);
console.log(`  Text snippet: ${ladderPou.text.substring(0, 100)}...`);

// Try to edit it - should fail with a clear error
try {
  applyPouEdit(buf, ladderPou, ladderPou.text.replace("IF", "IF"));
  console.log("  ✗ FAILED: Should have thrown for ladder POU edit");
  process.exit(1);
} catch (err) {
  if (err.message.includes("not editable")) {
    console.log(`  ✓ PASSED: Correctly rejected with: ${err.message}`);
  } else if (err.message.includes("ladder write-back")) {
    console.log(`  ✓ PASSED: Correctly rejected with: ${err.message}`);
  } else {
    console.log(`  ✗ FAILED: Wrong error message: ${err.message}`);
    process.exit(1);
  }
}

// Verify the exported text shows the ladder comment
if (!ladderPou.text.includes("LADDER DIAGRAM")) {
  console.log("  ✗ FAILED: Ladder POU text should include 'LADDER DIAGRAM' comment");
  process.exit(1);
} else {
  console.log("  ✓ Ladder text includes LADDER DIAGRAM read-only marker");
}

console.log("\nAll ladder read-only checks passed!");
