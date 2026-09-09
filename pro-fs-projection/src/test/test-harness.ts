/**
 * Test harness for pro-fs-projection library
 *
 * Tests against DEMO_FIXTURE.pro:
 * - List the fake directory
 * - Read a POU file
 * - Edit and write one back
 * - Re-parse the real .pro and confirm only that POU changed
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import ProFsProjection from "../index";
import { parse, diff, validate } from "codesys-parser";

interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  error?: string;
  details?: string;
}

const results: TestResult[] = [];

function log(msg: string) {
  console.log(msg);
}

function logSection(title: string) {
  console.log("\n" + "=".repeat(60));
  console.log(`  ${title}`);
  console.log("=".repeat(60));
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runTest(name: string, fn: () => Promise<void> | void): Promise<void> {
  const start = Date.now();
  try {
    await fn();
    const duration = Date.now() - start;
    results.push({ name, passed: true, duration });
    log(`✓ ${name} (${duration}ms)`);
  } catch (err) {
    const duration = Date.now() - start;
    const error = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, duration, error });
    log(`✗ ${name} (${duration}ms)`);
    log(`  Error: ${error}`);
  }
}

async function main() {
  const fixtureDir = path.resolve(__dirname, "..", "..", "..", "docs", "Phase 3");
  const fixturePath = path.join(fixtureDir, "DEMO_FIXTURE.pro");

  logSection("Pro-FS-Projection Test Harness");
  log(`\nFixture: ${fixturePath}`);
  log(`Exists: ${fs.existsSync(fixturePath)}`);

  if (!fs.existsSync(fixturePath)) {
    console.error(`\nFATAL: DEMO_FIXTURE.pro not found at ${fixturePath}`);
    process.exit(1);
  }

  const stats = fs.statSync(fixturePath);
  log(`Size: ${stats.size} bytes\n`);

  // Never operate on the shared fixture directly - it's the canonical test
  // asset every piece's tests depend on. writeFile below mutates whatever
  // .pro path the projection was constructed with, so copy to a scratch
  // path first and point the projection at that instead.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pro-fs-projection-test-"));
  const workingPath = path.join(tmpDir, "DEMO_FIXTURE.pro");
  fs.copyFileSync(fixturePath, workingPath);

  const projection = new ProFsProjection({ proPath: workingPath });

  // Test 1: List root directory
  await runTest("List root directory", () => {
    const entries = projection.readDirectory(".");
    log(`  Found categories: ${entries.map((e) => e.name).join(", ")}`);
    assert(entries.length >= 4, "Should have at least 4 categories");
    assert(entries.some((e) => e.name === "POUS"), "Should have POUS");
    assert(entries.some((e) => e.name === "GVL"), "Should have GVL");
  });

  // Test 2: List POUs
  let pouList: any[] = [];
  await runTest("List POUs", () => {
    pouList = projection.readDirectory("POUS");
    log(`  Found ${pouList.length} POUs`);
    assert(pouList.length > 0, "Should have at least one POU");
    pouList.forEach((p) => log(`    - ${p.name}`));
  });

  // Test 3: Read a POU
  let firstPouName = "";
  let originalContent = "";
  await runTest("Read a POU file", () => {
    if (pouList.length === 0) throw new Error("No POUs found");

    firstPouName = pouList[0].name;
    const filePath = `POUS/${firstPouName}`;
    originalContent = projection.readFile(filePath);

    log(`  Read ${firstPouName} (${originalContent.length} bytes)`);
    assert(originalContent.length > 0, "POU should have content");
    log(`  First 100 chars: ${originalContent.substring(0, 100).replace(/\r\n/g, "\\r\\n")}...`);
  });

  // Test 4: Get original project for comparison
  let originalProject: any = null;
  await runTest("Load and parse original .pro", () => {
    const buf = fs.readFileSync(workingPath);
    originalProject = parse(buf);
    log(`  Parsed ${originalProject.objects.length} objects`);
  });

  // Test 5: Edit a POU (make a trivial change - add a comment)
  let editedContent = "";
  let edited = false;
  await runTest("Edit POU and write back", () => {
    if (!originalContent) throw new Error("No original content");

    // Add a comment to the declaration section
    editedContent = originalContent.replace(
      "(* @END_DECLARATION := '0' *)",
      "(* @END_DECLARATION := '0' *)\n(* TEST EDIT - pro-fs-projection test *)"
    );

    assert(editedContent !== originalContent, "Edit should change content");

    const filePath = `POUS/${firstPouName}`;
    projection.writeFile(filePath, editedContent);
    edited = true;

    log(`  Successfully wrote ${firstPouName}`);
    log(`  Original: ${originalContent.length} bytes`);
    log(`  Edited: ${editedContent.length} bytes`);
  });

  // Test 6: Reload and parse the updated .pro
  let updatedProject: any = null;
  await runTest("Load and parse updated .pro", () => {
    if (!edited) throw new Error("Previous edit failed");

    const buf = fs.readFileSync(workingPath);
    updatedProject = parse(buf);
    log(`  Re-parsed ${updatedProject.objects.length} objects`);
  });

  // Test 7: Verify only the edited POU changed
  await runTest("Verify diff shows only edited POU", () => {
    if (!originalProject || !updatedProject) throw new Error("Projects not loaded");

    const projectDiff = diff(originalProject, updatedProject);
    const totalObjects = projectDiff.added.length + projectDiff.removed.length + projectDiff.changed.length + projectDiff.unchanged.length;
    log(`  Total objects: ${totalObjects}`);
    log(`  Changed objects: ${projectDiff.changed.length}`);

    if (projectDiff.changed.length !== 1) {
      throw new Error(`Expected 1 changed object, got ${projectDiff.changed.length}`);
    }

    const changed = projectDiff.changed[0];
    log(`  Changed object: ${changed.name}`);
    assert(changed.name.toLowerCase() === firstPouName.replace(/\.(st|ld)$/i, "").toLowerCase(),
      "Changed object should be the edited POU");
  });

  // Test 8: List GVLs
  await runTest("List GVLs", () => {
    const gvls = projection.readDirectory("GVL");
    log(`  Found ${gvls.length} GVLs`);
    if (gvls.length > 0) {
      gvls.slice(0, 3).forEach((g) => log(`    - ${g.name}`));
    }
  });

  // Test 9: Read a GVL
  await runTest("Read a GVL file", () => {
    const gvls = projection.readDirectory("GVL");
    if (gvls.length === 0) {
      log("  (No GVLs in this fixture)");
      return;
    }

    const gvlName = gvls[0].name;
    const filePath = `GVL/${gvlName}`;
    const content = projection.readFile(filePath);

    log(`  Read ${gvlName} (${content.length} bytes)`);
    assert(content.length > 0, "GVL should have content");
  });

  // Test 10: Glob patterns
  await runTest("Glob patterns", () => {
    const stFiles = projection.glob("POUS/*.st");
    log(`  POUS/*.st found: ${stFiles.length} files`);

    const ldFiles = projection.glob("POUS/*.ld");
    log(`  POUS/*.ld found: ${ldFiles.length} files`);

    const allPous = projection.glob("POUS/*");
    log(`  POUS/* found: ${allPous.length} files`);

    assert(stFiles.length + ldFiles.length === allPous.length, "ST+LD should equal all POUs");
  });

  // Test 11: Verify no .pro.src surfaces
  await runTest("Verify .pro.src never surfaces", () => {
    const root = projection.readDirectory(".");
    const hasSrc = root.some((e) => e.name.includes(".pro.src") || e.name.includes("pro.src"));
    assert(!hasSrc, ".pro.src should not appear in any listing");

    const allPous = projection.glob("POUS/*");
    const proSrcInPous = allPous.some((p) => p.includes(".pro.src"));
    assert(!proSrcInPous, ".pro.src should not appear in POUS listing");
  });

  // Test 12: Get project object
  await runTest("Access underlying Project object", () => {
    const proj = projection.getProject();
    assert(proj.objects && proj.objects.length > 0, "Project should have objects");
    log(`  Project has ${proj.objects.length} objects`);
  });

  // Clean up the scratch copy - never leave anything behind, pass or fail.
  fs.rmSync(tmpDir, { recursive: true, force: true });

  // Summary
  logSection("Test Results Summary");
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

  log(`\nPassed: ${passed}/${results.length}`);
  log(`Failed: ${failed}/${results.length}`);
  log(`Total time: ${totalDuration}ms`);

  if (failed > 0) {
    logSection("Failed Tests");
    results.filter((r) => !r.passed).forEach((r) => {
      log(`\n${r.name}:`);
      log(`  ${r.error}`);
    });
    process.exit(1);
  } else {
    log("\n✓ All tests passed!");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
