/**
 * Projection export/import/drift detection for git hooks.
 *
 * The .pro file is always the sole source of truth. The .pro.src/ directory
 * is a *projection* derived via parse()/export(), and any edit flows back
 * through import()/rebuild(). This module implements the three-operation
 * protocol:
 *
 * 1. export(proPath) - parse .pro and write .pro.src/ with deterministic layout
 * 2. import(proSrcPath) - read .pro.src/ and rebuild .pro
 * 3. detectDrift(proPath) - check if .pro.src/ was hand-edited (safety gate)
 */

import * as fs from "fs";
import * as path from "path";
import {
  parse,
  rebuild,
  exportPou,
  importPouByOid,
  validate,
  Project,
  objKind,
  CodesysObject,
  TYPE_POU,
  TYPE_GVL,
  TYPE_DATATYPE,
  BODY_TEXT,
  BODY_LADDER,
  renderNetwork,
  getLadderDecode,
} from "codesys-parser";

const DECL_BOUNDARY = "(* @END_DECLARATION := '0' *)";

interface PouExport {
  name: string;
  oid: number;
  kind: "TEXT" | "LD";
  text: string;
}

/**
 * Export a POU directly using the CodesysObject, avoiding name-based lookup
 * which fails with duplicate names.
 */
function exportPouDirect(project: Project, obj: CodesysObject): PouExport {
  const declText = project.raw.toString(
    "latin1",
    obj.declOff,
    obj.declOff + obj.declLen
  );

  if (obj.tag === BODY_TEXT) {
    const bodyText =
      obj.bodyOff !== null && obj.bodyLen !== null
        ? project.raw.toString("latin1", obj.bodyOff, obj.bodyOff + obj.bodyLen)
        : "";
    const text = `${declText}\r\n${DECL_BOUNDARY}\r\n\r\n${bodyText}`;
    return { name: obj.name, oid: obj.oid, kind: "TEXT", text };
  }

  if (obj.tag === BODY_LADDER) {
    const { networks } = getLadderDecode(project, obj);
    const rendered = networks
      .map((n) => {
        const lines = renderNetwork(n);
        if (n.comment) lines.unshift(`(* ${n.comment} *)`);
        return lines.join("\r\n");
      })
      .join("\r\n\r\n");
    const text = `${declText}\r\n${DECL_BOUNDARY}\r\n\r\n(* LADDER DIAGRAM - ${obj.nnet} networks - read-only projection, see docs/Phase_2_Updates/TWINCAT_PRO_PARSER_BIBLE.md sec 6.4 *)\r\n\r\n${rendered}`;
    return { name: obj.name, oid: obj.oid, kind: "LD", text };
  }

  throw new Error(`${obj.name}: unknown body tag 0x${(obj.tag ?? 0).toString(16)}`);
}

/** Standard LF line endings, UTF-8, deterministic key ordering. */
function stableJson(obj: any): string {
  const json = JSON.stringify(obj, Object.keys(obj).sort(), 2);
  // Ensure LF line endings
  return json.replace(/\r\n/g, "\n") + "\n";
}

/**
 * Export a .pro file to a .pro.src/ directory with deterministic, human-readable
 * projection. Creates/overwrites <proPath>.src/ and its contents.
 *
 * Returns the export result or throws on parser/validation error.
 */
export function exportProjection(proPath: string): ExportResult {
  const buf = fs.readFileSync(proPath);
  const project = parse(buf);

  // Validate before exporting
  const validation = validate(project);
  if (!validation.ok) {
    throw new Error(
      `Validation failed: ${validation.issues
        .filter((x) => !x.ok)
        .map((x) => `${x.check}: ${x.detail}`)
        .join("; ")}`
    );
  }

  const projDir = proPath + ".src";
  const projDirName = path.basename(projDir);
  const proFileName = path.basename(proPath);

  // Ensure directories exist
  fs.mkdirSync(path.join(projDir, "POUS"), { recursive: true });
  fs.mkdirSync(path.join(projDir, "GVL"), { recursive: true });
  fs.mkdirSync(path.join(projDir, "DUT"), { recursive: true });
  fs.mkdirSync(path.join(projDir, "Tasks"), { recursive: true });

  // 1. Export project.json with metadata
  const projectMeta = {
    name: path.basename(proPath, ".pro"),
    version: project.version || "unknown",
    objects: project.objects.map((o) => ({
      name: o.name,
      type: objKind(o),
      oid: o.oid,
    })),
  };
  fs.writeFileSync(
    path.join(projDir, "project.json"),
    stableJson(projectMeta),
    "utf8"
  );

  // 2. Export POUs and GVLs as editable text
  const contents: string[] = [];

  for (const obj of project.objects) {
    if (obj.typ === TYPE_POU) {
      try {
        // exportPou uses name-based lookup, which can fail with duplicate names.
        // As a workaround, we export directly using the object's spans.
        const exported = exportPouDirect(project, obj);
        const ext = exported.kind === "TEXT" ? "st" : "ld";
        const fileName = `${obj.name}.${ext}`;
        const filePath = path.join(projDir, "POUS", fileName);
        // Preserve original line endings for byte-exact round-trip.
        // Don't normalize to LF (some .pro files use mixed or LF-only endings).
        const fileContent = exported.text + "\n";
        fs.writeFileSync(filePath, fileContent, "latin1");
        contents.push(`POUS/${fileName} (${obj.name}, ${exported.kind})`);
      } catch (err) {
        // Skip POUs that can't be exported (e.g., with unknown body tags)
        console.warn(
          `Warning: skipping POU ${obj.name}: ${(err as Error).message}`
        );
      }
    } else if (obj.typ === TYPE_GVL) {
      // GVL is just declaration text
      const declText = project.raw.toString("latin1", obj.declOff, obj.declOff + obj.declLen);
      const filePath = path.join(projDir, "GVL", `${obj.name}.gvl`);
      // Preserve original line endings for byte-exact round-trip.
      const fileContent = declText + "\n";
      fs.writeFileSync(filePath, fileContent, "latin1");
      contents.push(`GVL/${obj.name}.gvl`);
    } else if (obj.typ === TYPE_DATATYPE) {
      // DUT is just declaration text
      const declText = project.raw.toString("latin1", obj.declOff, obj.declOff + obj.declLen);
      const filePath = path.join(projDir, "DUT", `${obj.name}.dut`);
      // Preserve original line endings for byte-exact round-trip.
      const fileContent = declText + "\n";
      fs.writeFileSync(filePath, fileContent, "latin1");
      contents.push(`DUT/${obj.name}.dut`);
    }
  }

  // 3. Export Tasks as JSON
  for (const task of project.tasks) {
    const taskData = {
      name: task.task,
      program: task.program,
      disabled: task.disabled,
      priority: task.paramA,
      interval: task.paramB,
    };
    const filePath = path.join(projDir, "Tasks", `${task.task}.json`);
    fs.writeFileSync(filePath, stableJson(taskData), "utf8");
    contents.push(`Tasks/${task.task}.json`);
  }

  // 4. Write README.md stating this is a projection
  const readmeContent = `# ${proFileName}.src/

**This is a generated projection**, created and maintained by git hooks only.
**These files must never hand-edited.** Instead, edit \`${proFileName}\` directly
and commit it. The projection will be regenerated automatically.

For details, see \`docs/Phase 3/Parser Upgrade Spec.md\`.

## Contents

${contents.map((c) => `- ${c}`).join("\n")}
`;
  fs.writeFileSync(path.join(projDir, "README.md"), readmeContent, "utf8");

  return {
    projDir,
    proFileName,
    objectCount: project.objects.length,
    pouCount: project.objects.filter((o) => o.typ === TYPE_POU).length,
    gvlCount: project.objects.filter((o) => o.typ === TYPE_GVL).length,
    taskCount: project.tasks.length,
  };
}

export interface ExportResult {
  projDir: string;
  proFileName: string;
  objectCount: number;
  pouCount: number;
  gvlCount: number;
  taskCount: number;
}

/**
 * Import a .pro.src/ directory and rebuild the .pro file.
 * Parses all POUS/*.st, GVL/*.gvl, DUT/*.dut files and splices them back
 * into a rebuilt .pro binary.
 *
 * Returns the new .pro buffer or throws on parser/validation error.
 */
export function importProjection(projDir: string): Buffer {
  // Read the original .pro to get the base project structure
  const proPath = projDir.endsWith(".src") ? projDir.slice(0, -4) : projDir + ".pro";
  if (!fs.existsSync(proPath)) {
    throw new Error(`No corresponding .pro file found: ${proPath}`);
  }

  let project = parse(fs.readFileSync(proPath));

  // Build a mapping of POU names to their OIDs to handle name collisions
  // (e.g., when a GVL and a POU share the same name)
  const pouNameToOid = new Map<string, number>();
  for (const obj of project.objects) {
    if (obj.typ === TYPE_POU) {
      pouNameToOid.set(obj.name, obj.oid);
    }
  }

  // Import POUs from POUS/*.st (only .st files; .ld are read-only)
  const pousDir = path.join(projDir, "POUS");
  if (fs.existsSync(pousDir)) {
    for (const file of fs.readdirSync(pousDir)) {
      if (file.endsWith(".st")) {
        const pouName = file.slice(0, -3);
        const oid = pouNameToOid.get(pouName);
        if (oid === undefined) {
          console.warn(`Warning: POU ${pouName} not found in project, skipping import`);
          continue;
        }

        const fileContent = fs.readFileSync(path.join(pousDir, file), "latin1");
        // Strip the single trailing "\n" this package's own export() added
        // for on-disk file-convention readability (see the `+ "\n"` at write
        // time below) - codesys-parser's importPou/importPouByOid expects
        // back exactly what exportPou produced, with nothing appended.
        const content = fileContent.replace(/\n$/, "");
        try {
          // Use importPouByOid to avoid name-based lookup ambiguity
          project = importPouByOid(project, oid, content);
        } catch (err) {
          // Skip POUs that can't be imported (e.g., ladder POUs)
          console.warn(
            `Warning: skipping POU ${pouName} during import: ${(err as Error).message}`
          );
        }
      }
    }
  }

  // Validate the result
  const validation = validate(project);
  if (!validation.ok) {
    throw new Error(
      `Validation failed: ${validation.issues
        .filter((x) => !x.ok)
        .map((x) => `${x.check}: ${x.detail}`)
        .join("; ")}`
    );
  }

  return rebuild(project);
}

/**
 * Drift detection: compare the current working-tree .pro.src/ against
 * what export(parse(committed .pro)) would produce. If they differ,
 * and that difference isn't explained by a corresponding .pro change,
 * someone hand-edited the projection directly.
 *
 * Returns { drift: boolean, driftedFiles: string[] } where driftedFiles
 * lists the files that differ (relative to .pro.src/).
 */
export function detectDrift(proPath: string, headProPath: string): DriftResult {
  const driftedFiles: string[] = [];

  // Read current .pro.src/ if it exists
  const projDir = proPath + ".src";
  if (!fs.existsSync(projDir)) {
    // New file, no drift possible
    return { drift: false, driftedFiles: [] };
  }

  const workingTreeFiles = listProjectionFiles(projDir);

  // Parse committed HEAD .pro to regenerate what .pro.src/ should contain
  const headBuf = fs.readFileSync(headProPath);
  const headProject = parse(headBuf);

  // We can't call exportProjection directly because it would write to disk.
  // Instead, build the expected content in memory and compare.
  // Pass the actual pro filename so project.json has the correct name field
  const proFilename = path.basename(proPath);
  const expectedFiles = buildExpectedProjectionFiles(headProject, proFilename);

  // Compare file by file
  for (const [relPath, expectedContent] of Object.entries(expectedFiles)) {
    const workingPath = path.join(projDir, relPath);
    const workingExists = fs.existsSync(workingPath);

    if (!workingExists) {
      // File should exist but doesn't - this is drift if the .pro didn't change
      driftedFiles.push(relPath);
      continue;
    }

    const workingContent = fs.readFileSync(workingPath, "utf8");
    if (workingContent !== expectedContent) {
      driftedFiles.push(relPath);
    }
  }

  // Check for extra files in working tree that shouldn't be there
  for (const relPath of workingTreeFiles) {
    if (!(relPath in expectedFiles)) {
      driftedFiles.push(relPath);
    }
  }

  return {
    drift: driftedFiles.length > 0,
    driftedFiles,
  };
}

export interface DriftResult {
  drift: boolean;
  driftedFiles: string[];
}

/**
 * List all tracked files in .pro.src/ (relative paths).
 */
function listProjectionFiles(projDir: string): string[] {
  const files: string[] = [];

  function walk(dir: string, prefix: string) {
    if (!fs.existsSync(dir)) return;

    for (const file of fs.readdirSync(dir)) {
      if (file === "README.md" || file === "project.json") {
        files.push(prefix + file);
        continue;
      }

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

/**
 * Build the expected projection files from a parsed project (in-memory only,
 * don't write to disk). Returns a map of relative paths to file contents.
 *
 * This must match exactly what exportProjection() generates, including the
 * detailed file listings in README.md, so drift detection can compare them.
 */
function buildExpectedProjectionFiles(
  project: Project,
  proFilename?: string
): Record<string, string> {
  const files: Record<string, string> = {};
  const contents: string[] = [];

  // project.json
  const projectName = proFilename ? path.basename(proFilename, ".pro") : "unknown";
  const projectMeta = {
    name: projectName,
    version: project.version || "unknown",
    objects: project.objects.map((o) => ({
      name: o.name,
      type: objKind(o),
      oid: o.oid,
    })),
  };
  files["project.json"] = stableJson(projectMeta);

  // POUs, GVLs, DUTs - must match exportProjection exactly
  for (const obj of project.objects) {
    if (obj.typ === TYPE_POU) {
      try {
        const exported = exportPouDirect(project, obj);
        const ext = exported.kind === "TEXT" ? "st" : "ld";
        const fileName = `POUS/${obj.name}.${ext}`;
        // Preserve original line endings for byte-exact round-trip.
        files[fileName] = exported.text + "\n";
        // Include detailed info in README for POUs (matches exportProjection)
        contents.push(`POUS/${obj.name}.${ext} (${obj.name}, ${exported.kind})`);
      } catch (err) {
        // Skip POUs that can't be exported
      }
    } else if (obj.typ === TYPE_GVL) {
      const declText = project.raw.toString(
        "latin1",
        obj.declOff,
        obj.declOff + obj.declLen
      );
      // Preserve original line endings for byte-exact round-trip.
      files[`GVL/${obj.name}.gvl`] = declText + "\n";
      contents.push(`GVL/${obj.name}.gvl`);
    } else if (obj.typ === TYPE_DATATYPE) {
      const declText = project.raw.toString(
        "latin1",
        obj.declOff,
        obj.declOff + obj.declLen
      );
      // Preserve original line endings for byte-exact round-trip.
      files[`DUT/${obj.name}.dut`] = declText + "\n";
      contents.push(`DUT/${obj.name}.dut`);
    }
  }

  // Tasks
  for (const task of project.tasks) {
    const taskData = {
      name: task.task,
      program: task.program,
      disabled: task.disabled,
      priority: task.paramA,
      interval: task.paramB,
    };
    files[`Tasks/${task.task}.json`] = stableJson(taskData);
    contents.push(`Tasks/${task.task}.json`);
  }

  // README - must match exportProjection exactly
  const readmeHeading = proFilename ? `${proFilename}.src/` : ".pro.src/";
  const readmeProRef = proFilename ? `\`${proFilename}\`` : "the .pro file";
  const readmeContent = `# ${readmeHeading}

**This is a generated projection**, created and maintained by git hooks only.
**These files must never hand-edited.** Instead, edit ${readmeProRef} directly
and commit it. The projection will be regenerated automatically.

For details, see \`docs/Phase 3/Parser Upgrade Spec.md\`.

## Contents

${contents.map((c) => `- ${c}`).join("\n")}
`;
  files["README.md"] = readmeContent;

  return files;
}
