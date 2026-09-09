import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { parse } from "../src/parse";
import { rebuild } from "../src/rebuild";
import { validate } from "../src/validate";
import { verify } from "../src/verify";
import { exportPou, importPou } from "../src/pou";
import { diff } from "../src/diff";
import { BODY_LADDER, BODY_TEXT } from "../src/types";

// __dirname is dist/test at run time (tsc does not copy non-.ts assets);
// the fixture lives in the source tree's test/fixtures, so resolve from
// the package root (npm test always runs with cwd == package root) with a
// __dirname-relative fallback for direct `node dist/test/x.test.js` runs.
const FIXTURE = fs.existsSync(path.join(process.cwd(), "test", "fixtures", "DEMO_FIXTURE.pro"))
  ? path.join(process.cwd(), "test", "fixtures", "DEMO_FIXTURE.pro")
  : path.join(__dirname, "..", "..", "test", "fixtures", "DEMO_FIXTURE.pro");

function loadFixture(): Buffer {
  return fs.readFileSync(FIXTURE);
}

test("fixture exists and starts with the CoDeSys+ magic", () => {
  const buf = loadFixture();
  assert.equal(buf.length, 335392);
  assert.equal(buf.subarray(0, 8).toString("latin1"), "CoDeSys+");
});

test("parse() finds all 35 objects with 27 POUs, 6 ladder bodies", () => {
  const buf = loadFixture();
  const project = parse(buf);
  assert.equal(project.objects.length, 35, "object count");
  const pous = project.objects.filter((o) => o.typ === 0x07);
  assert.equal(pous.length, 27, "POU count");
  const ladder = project.objects.filter((o) => o.tag === BODY_LADDER);
  assert.equal(ladder.length, 6, "ladder POU count");
  const text = project.objects.filter((o) => o.tag === BODY_TEXT);
  // GVLs are declaration-only (a single MARK'd VAR_GLOBAL string with no
  // trailing body tag) - their `tag` field just happens to read whatever
  // byte follows in the file (usually the next object header's type tag),
  // which is not itself 0x12/0x1B. So only POUs contribute to this count:
  // 27 POUs - 6 ladder = 21 text POUs, matching the bible's corpus (21/6).
  assert.equal(text.length, 21, "text-bodied POU count");
});

test("HARD REQUIREMENT: rebuild(parse(fixture)) is byte-identical to the original file", () => {
  const buf = loadFixture();
  const project = parse(buf);
  const rebuilt = rebuild(project);
  assert.equal(rebuilt.length, buf.length, "length must match");
  assert.equal(rebuilt.compare(buf), 0, "byte-exact round trip");
});

test("validate() reports ok:true and byte-exact round trip on the fixture", () => {
  const buf = loadFixture();
  const project = parse(buf);
  const result = validate(project);
  const failures = result.issues.filter((i) => !i.ok);
  if (failures.length > 0) {
    console.error("Failing invariant checks:", failures);
  }
  assert.equal(failures.length, 0, "no invariant failures");
  assert.equal(result.roundTripByteExact, true);
  assert.equal(result.ok, true);
});

test("bible sec 17.3 invariant checks all pass, and there are many of them (122 on the reference corpus)", () => {
  const buf = loadFixture();
  const project = parse(buf);
  const issues = verify(project);
  assert.ok(issues.length >= 60, `expected a substantial number of per-object checks, got ${issues.length}`);
  const failing = issues.filter((i) => !i.ok);
  assert.deepEqual(failing, []);
});

test("every ladder body walks exactly nnet networks and lands on the next object header", () => {
  const buf = loadFixture();
  const project = parse(buf);
  const ladderObjs = project.objects.filter((o) => o.tag === BODY_LADDER);
  assert.equal(ladderObjs.length, 6);

  let totalNetworks = 0;
  for (const o of ladderObjs) {
    const issues = verify(project).filter((i) => i.check.startsWith(`LD ${o.name}:`));
    for (const i of issues) {
      assert.ok(i.ok, `${i.check}: ${i.detail}`);
    }
    totalNetworks += o.nnet ?? 0;
  }
  assert.equal(totalNetworks, 58, "total ladder networks across all 6 ladder POUs");
});

test("object ids are unique and joins happen on objectId, not name (bible rule 5)", () => {
  const buf = loadFixture();
  const project = parse(buf);
  const ids = project.objects.map((o) => o.oid);
  assert.equal(new Set(ids).size, ids.length);
});

test("declaration and body length fields are u32 (not u16) and match actual span lengths", () => {
  const buf = loadFixture();
  const project = parse(buf);
  for (const o of project.objects) {
    assert.equal(buf.readUInt32LE(o.declLenOff), o.declLen, `${o.name} decl length field`);
    if (o.tag === BODY_TEXT && o.bodyOff !== null && o.bodyLen !== null) {
      assert.equal(buf.readUInt32LE(o.bodyOff - 4), o.bodyLen, `${o.name} body length field`);
    }
  }
});

test("exportPou/importPou round-trip a text POU edit and only that object's bytes change", () => {
  const buf = loadFixture();
  const project = parse(buf);

  // Pick a small text POU to edit safely (MAIN is present in the fixture
  // under its original name - the rest are anonymized).
  const target = project.objects.find((o) => o.tag === BODY_TEXT && o.name === "MAIN");
  assert.ok(target, "fixture must contain a MAIN text POU for this test");

  const before = exportPou(project, target!.name);
  assert.equal(before.kind, "TEXT");
  assert.equal(before.editable, true);

  const marker = "(* codesys-parser round-trip test marker *)";
  const editedText = before.text + "\r\n" + marker + "\r\n";

  const edited = importPou(project, target!.name, editedText);

  // Re-parse from scratch and validate the edited project before trusting it.
  const result = validate(edited);
  assert.equal(result.ok, true, JSON.stringify(result.issues.filter((i) => !i.ok)));

  const after = exportPou(edited, target!.name);
  assert.ok(after.text.includes(marker), "edited marker must be present after round trip");

  // Diff against the original: only the edited object should show as changed.
  const d = diff(project, edited);
  assert.equal(d.added.length, 0);
  assert.equal(d.removed.length, 0);
  assert.equal(d.changed.length, 1, `expected exactly one changed object, got ${JSON.stringify(d.changed)}`);
  assert.equal(d.changed[0].name, target!.name);

  // rebuild(edited) must itself be internally consistent (it *will* differ
  // from the original fixture bytes since we intentionally edited it).
  const rebuiltEdited = rebuild(edited);
  assert.notEqual(rebuiltEdited.compare(buf), 0, "edited output should differ from the original");

  // And re-parsing the rebuilt edited buffer must reproduce the same edit,
  // proving the write-back path itself is stable.
  const reparsed = parse(rebuiltEdited);
  const reexported = exportPou(reparsed, target!.name);
  assert.ok(reexported.text.includes(marker));
});

test("exportPou on a ladder POU is marked read-only", () => {
  const buf = loadFixture();
  const project = parse(buf);
  const ladderObj = project.objects.find((o) => o.tag === BODY_LADDER);
  assert.ok(ladderObj);
  const exported = exportPou(project, ladderObj!.name);
  assert.equal(exported.kind, "LD");
  assert.equal(exported.editable, false);
});

test("importPou refuses to write back a ladder POU (write-back is a feature-flagged stretch goal)", () => {
  const buf = loadFixture();
  const project = parse(buf);
  const ladderObj = project.objects.find((o) => o.tag === BODY_LADDER);
  assert.ok(ladderObj);
  assert.throws(() => importPou(project, ladderObj!.name, "whatever"));
});

test("diff(a, a) on an unedited project reports nothing changed", () => {
  const buf = loadFixture();
  const a = parse(buf);
  const b = parse(buf);
  const d = diff(a, b);
  assert.equal(d.added.length, 0);
  assert.equal(d.removed.length, 0);
  assert.equal(d.changed.length, 0);
  assert.equal(d.unchanged.length, a.objects.length);
});
