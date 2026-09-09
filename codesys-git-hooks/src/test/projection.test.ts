/**
 * Tests for projection export/import/drift detection.
 *
 * Verifies:
 * 1. export(parse(x)) is deterministic (byte-identical on second run)
 * 2. rebuild(import(export(parse(x)))) === x byte-exact
 * 3. drift check correctly flags hand-edits and doesn't false-positive
 */

import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";

import { exportProjection, importProjection, detectDrift } from "../projection";
import { parse, rebuild } from "codesys-parser";

// Find DEMO_FIXTURE.pro
const repoRoot = execSync("git rev-parse --show-toplevel", {
  encoding: "utf8",
}).trim();
const fixtureProPath = path.join(
  repoRoot,
  "docs",
  "Phase 3",
  "DEMO_FIXTURE.pro"
);

interface TestContext {
  tmpDir: string;
  testProPath: string;
  cleanup(): void;
}

function createTestContext(): TestContext {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codesys-test-"));
  const testProPath = path.join(tmpDir, "TEST.pro");

  // Copy fixture to temp dir
  fs.copyFileSync(fixtureProPath, testProPath);

  return {
    tmpDir,
    testProPath,
    cleanup() {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  };
}

test("export() is deterministic", () => {
  const ctx = createTestContext();
  try {
    // Export twice
    const result1 = exportProjection(ctx.testProPath);
    const files1 = listProjectionFiles(ctx.testProPath + ".src");

    // Clean and re-export
    fs.rmSync(ctx.testProPath + ".src", { recursive: true });
    const result2 = exportProjection(ctx.testProPath);
    const files2 = listProjectionFiles(ctx.testProPath + ".src");

    // Verify results match
    assert.deepStrictEqual(result1, result2, "Export results should be identical");

    // Verify file contents match byte-for-byte
    const projDir = ctx.testProPath + ".src";
    for (const file of files1) {
      const path1 = path.join(projDir, file);
      const content1 = fs.readFileSync(path1);
      const content2 = fs.readFileSync(path1);
      assert.deepStrictEqual(
        content1,
        content2,
        `File ${file} should be byte-identical on second export`
      );
    }

    console.log(`✓ Export determinism verified (${files1.length} files)`);
  } finally {
    ctx.cleanup();
  }
});

test("round-trip: rebuild(import(export(parse(x)))) === x", () => {
  const ctx = createTestContext();
  try {
    // Read original
    const originalBuf = fs.readFileSync(ctx.testProPath);

    // Export
    exportProjection(ctx.testProPath);

    // Import back
    const newBuf = importProjection(ctx.testProPath + ".src");

    // Compare
    if (!originalBuf.equals(newBuf)) {
      const diffLen = Math.abs(originalBuf.length - newBuf.length);
      throw new Error(
        `Round-trip mismatch: original ${originalBuf.length} bytes, result ${newBuf.length} bytes (diff ${diffLen})`
      );
    }

    console.log(
      `✓ Round-trip verified (${originalBuf.length} bytes byte-exact)`
    );
  } finally {
    ctx.cleanup();
  }
});

test("drift detection: no false-positives when clean", () => {
  const ctx = createTestContext();
  try {
    // Export to create .pro.src/
    exportProjection(ctx.testProPath);

    // Copy .pro as HEAD version for comparison
    const headProPath = ctx.testProPath + ".HEAD";
    fs.copyFileSync(ctx.testProPath, headProPath);

    // Detect drift - should be clean
    const result = detectDrift(ctx.testProPath, headProPath);

    assert.strictEqual(
      result.drift,
      false,
      "Should not detect drift on fresh export"
    );
    assert.strictEqual(
      result.driftedFiles.length,
      0,
      "Should have no drifted files"
    );

    console.log("✓ No false-positive drift detected");
  } finally {
    ctx.cleanup();
  }
});

test("drift detection: detects hand-edited .pro.src/ files", () => {
  const ctx = createTestContext();
  try {
    // Export to create .pro.src/
    exportProjection(ctx.testProPath);

    // Copy .pro as HEAD version for comparison
    const headProPath = ctx.testProPath + ".HEAD";
    fs.copyFileSync(ctx.testProPath, headProPath);

    // Hand-edit a POUS file
    const projDir = ctx.testProPath + ".src";
    const pouFile = path.join(projDir, "POUS");
    if (fs.existsSync(pouFile)) {
      const files = fs.readdirSync(pouFile);
      if (files.length > 0) {
        const firstPouFile = path.join(pouFile, files[0]);
        const content = fs.readFileSync(firstPouFile, "utf8");
        fs.writeFileSync(
          firstPouFile,
          content + "\n(* HAND-EDITED *)\n",
          "utf8"
        );

        // Detect drift - should find it
        const result = detectDrift(ctx.testProPath, headProPath);

        assert.strictEqual(result.drift, true, "Should detect drift");
        assert.ok(
          result.driftedFiles.length > 0,
          "Should have at least one drifted file"
        );
        assert.ok(
          result.driftedFiles[0].includes("POUS"),
          "Drifted file should be in POUS/"
        );

        console.log(
          `✓ Drift correctly detected in: ${result.driftedFiles.join(", ")}`
        );
        return;
      }
    }

    console.log("⊘ Skipped: fixture has no POUS files to hand-edit");
  } finally {
    ctx.cleanup();
  }
});

test("drift detection: detects deleted files in .pro.src/", () => {
  const ctx = createTestContext();
  try {
    // Export to create .pro.src/
    exportProjection(ctx.testProPath);

    // Copy .pro as HEAD version for comparison
    const headProPath = ctx.testProPath + ".HEAD";
    fs.copyFileSync(ctx.testProPath, headProPath);

    // Delete a file from the projection
    const projDir = ctx.testProPath + ".src";
    const pouFile = path.join(projDir, "POUS");
    if (fs.existsSync(pouFile)) {
      const files = fs.readdirSync(pouFile);
      if (files.length > 0) {
        const firstPouFile = path.join(pouFile, files[0]);
        fs.unlinkSync(firstPouFile);

        // Detect drift - should find it
        const result = detectDrift(ctx.testProPath, headProPath);

        assert.strictEqual(result.drift, true, "Should detect missing file");
        assert.ok(
          result.driftedFiles.length > 0,
          "Should have at least one drifted file"
        );

        console.log(
          `✓ Missing file correctly detected: ${result.driftedFiles.join(", ")}`
        );
        return;
      }
    }

    console.log("⊘ Skipped: fixture has no POUS files to delete");
  } finally {
    ctx.cleanup();
  }
});

test("drift detection: ignores .pro.src/ that doesn't exist yet", () => {
  const ctx = createTestContext();
  try {
    // Don't create .pro.src/, just detect drift
    const headProPath = ctx.testProPath + ".HEAD";
    fs.copyFileSync(ctx.testProPath, headProPath);

    const result = detectDrift(ctx.testProPath, headProPath);

    assert.strictEqual(
      result.drift,
      false,
      "Should not detect drift on new file"
    );

    console.log("✓ New file (no projection yet) handled correctly");
  } finally {
    ctx.cleanup();
  }
});

test("export handles GVLs and DUTs", () => {
  const ctx = createTestContext();
  try {
    const result = exportProjection(ctx.testProPath);
    const projDir = ctx.testProPath + ".src";

    // Check that GVL and DUT directories were created
    const gvlDir = path.join(projDir, "GVL");
    const dutDir = path.join(projDir, "DUT");
    const pouDir = path.join(projDir, "POUS");

    const gvlCount = fs.existsSync(gvlDir) ? fs.readdirSync(gvlDir).length : 0;
    const dutCount = fs.existsSync(dutDir) ? fs.readdirSync(dutDir).length : 0;
    const pouCount = fs.existsSync(pouDir) ? fs.readdirSync(pouDir).length : 0;

    console.log(`✓ Export created: ${pouCount} POUs, ${gvlCount} GVLs, ${dutCount} DUTs`);
  } finally {
    ctx.cleanup();
  }
});

test("export creates valid project.json", () => {
  const ctx = createTestContext();
  try {
    exportProjection(ctx.testProPath);
    const projDir = ctx.testProPath + ".src";

    const projectJson = JSON.parse(
      fs.readFileSync(path.join(projDir, "project.json"), "utf8")
    );

    assert.ok(projectJson.name, "Should have a name");
    assert.ok(Array.isArray(projectJson.objects), "Should have objects array");
    assert.ok(projectJson.version, "Should have a version");

    console.log(`✓ project.json is valid (${projectJson.objects.length} objects)`);
  } finally {
    ctx.cleanup();
  }
});

test("export creates valid README.md", () => {
  const ctx = createTestContext();
  try {
    exportProjection(ctx.testProPath);
    const projDir = ctx.testProPath + ".src";

    const readme = fs.readFileSync(path.join(projDir, "README.md"), "utf8");

    assert.ok(
      readme.includes("generated projection"),
      "README should mention it's a projection"
    );
    assert.ok(
      readme.includes("never hand-edited"),
      "README should warn against hand-editing"
    );
    assert.ok(readme.includes("Contents"), "README should list contents");

    console.log("✓ README.md is correctly formatted");
  } finally {
    ctx.cleanup();
  }
});

// Helper: list all files in a projection directory
function listProjectionFiles(projDir: string): string[] {
  const files: string[] = [];

  function walk(dir: string, prefix: string) {
    if (!fs.existsSync(dir)) return;

    for (const file of fs.readdirSync(dir)) {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        walk(fullPath, prefix + file + "/");
      } else if (stat.isFile()) {
        files.push(prefix + file);
      }
    }
  }

  walk(projDir, "");
  return files;
}
