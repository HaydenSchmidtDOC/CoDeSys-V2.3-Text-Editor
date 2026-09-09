/**
 * pro-fs-projection - Filesystem deception layer for .pro files
 *
 * This library intercepts ordinary filesystem operations (readDirectory,
 * readFile, writeFile, glob) on a .pro file and transparently answers as if
 * that file were actually a directory tree containing POUS/, GVL/, DUT/,
 * Tasks/, and Libraries/ subdirectories with the actual project contents.
 *
 * The layer is backed by parse()/export()/import()/rebuild() from the
 * codesys-parser core and never surfaces anything named *.pro.src (that's
 * the git-integration projection, unrelated to this in-memory one).
 *
 * This is option (b) from the Phase 3 spec: a Node/TypeScript library with
 * functions readDirectory/readFile/writeFile/glob that work without requiring
 * OS-level filesystem interception (ProjFS or FUSE). A future OS-level
 * integration point (ProjFS driver or similar) would sit on top of this library.
 */

import * as fs from "fs";
import * as path from "path";
import {
  parse,
  exportPou,
  importPou,
  validate,
  Project,
  CodesysObject,
  TYPE_POU,
  TYPE_GVL,
  TYPE_VISU,
  TYPE_DATATYPE,
} from "codesys-parser";

/**
 * Represents a fake directory entry as seen by the deception layer.
 */
export interface DirectoryEntry {
  name: string;
  isDirectory: boolean;
  /** Path relative to the .pro root (e.g., "POUS/Main.st") */
  relativePath: string;
}

/**
 * Configuration for the filesystem projection.
 */
export interface ProjectionConfig {
  /** Full path to the .pro file on disk */
  proPath: string;
  /** Cached parsed Project - if not provided, will be parsed from disk on demand */
  project?: Project;
}

/**
 * The main deception layer. Manages the projection of a .pro file as a
 * directory tree.
 */
export class ProFsProjection {
  private proPath: string;
  private project: Project | null = null;
  private fileBuffer: Buffer | null = null;

  constructor(config: ProjectionConfig) {
    this.proPath = config.proPath;
    this.project = config.project ?? null;
  }

  /**
   * Ensure the .pro file is loaded and parsed. Called internally before any
   * operation.
   */
  private ensureParsed(): Project {
    if (this.project) return this.project;

    if (!fs.existsSync(this.proPath)) {
      throw new Error(`File not found: ${this.proPath}`);
    }

    this.fileBuffer = fs.readFileSync(this.proPath);
    this.project = parse(this.fileBuffer);
    return this.project;
  }

  /**
   * List the contents of a fake directory within the .pro tree.
   *
   * @param dirPath - Path relative to the .pro root (e.g., "POUS" or "GVL")
   * @returns Array of directory entries
   */
  readDirectory(dirPath: string): DirectoryEntry[] {
    const normalized = dirPath.replace(/\\/g, "/").toLowerCase();
    const project = this.ensureParsed();

    // Root listing
    if (normalized === "" || normalized === ".") {
      return [
        { name: "POUS", isDirectory: true, relativePath: "POUS" },
        { name: "GVL", isDirectory: true, relativePath: "GVL" },
        { name: "DUT", isDirectory: true, relativePath: "DUT" },
        { name: "Tasks", isDirectory: true, relativePath: "Tasks" },
        { name: "Libraries", isDirectory: true, relativePath: "Libraries" },
      ];
    }

    if (normalized === "pous") {
      // List POUs (TEXT and LD bodies)
      return project.objects
        .filter((o) => o.typ === TYPE_POU)
        .map((o) => ({
          name: o.tag === 0x1b ? `${o.name}.ld` : `${o.name}.st`,
          isDirectory: false,
          relativePath: `POUS/${o.tag === 0x1b ? o.name + ".ld" : o.name + ".st"}`,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }

    if (normalized === "gvl") {
      // List GVLs
      return project.objects
        .filter((o) => o.typ === TYPE_GVL)
        .map((o) => ({
          name: `${o.name}.gvl`,
          isDirectory: false,
          relativePath: `GVL/${o.name}.gvl`,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }

    if (normalized === "dut") {
      // List DUTs (datatypes)
      return project.objects
        .filter((o) => o.typ === TYPE_DATATYPE)
        .map((o) => ({
          name: `${o.name}.dut`,
          isDirectory: false,
          relativePath: `DUT/${o.name}.dut`,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }

    if (normalized === "tasks") {
      // List Tasks
      return project.tasks.map((t) => ({
        name: `${t.task}.json`,
        isDirectory: false,
        relativePath: `Tasks/${t.task}.json`,
      }));
    }

    if (normalized === "libraries") {
      // List Libraries
      return project.libraries.map((lib) => ({
        name: `${lib.name}.lib`,
        isDirectory: false,
        relativePath: `Libraries/${lib.name}.lib`,
      }));
    }

    throw new Error(`No such directory: ${dirPath}`);
  }

  /**
   * Read the contents of a file in the fake directory tree.
   *
   * @param filePath - Path relative to the .pro root (e.g., "POUS/Main.st")
   * @returns File contents as a string
   */
  readFile(filePath: string): string {
    const normalized = filePath.replace(/\\/g, "/").toLowerCase();
    const parts = normalized.split("/");

    if (parts.length !== 2) {
      throw new Error(`Invalid file path: ${filePath}`);
    }

    const [category, filename] = parts;
    const project = this.ensureParsed();

    // Helper to export objects with or without bodies
    const exportObject = (o: any): string => {
      try {
        // Try exportPou first (for POUs with TEXT/LADDER bodies)
        const export_ = exportPou(project, o.name);
        return export_.text;
      } catch (err) {
        // If exportPou fails (e.g., for GVLs/DUTs with no body), just return the declaration
        if (err instanceof Error && err.message.includes("unknown body tag")) {
          const declText = project.raw.subarray(o.declOff, o.declOff + o.declLen).toString("latin1");
          return `${declText}\r\n(* @END_DECLARATION := '0' *)\r\n`;
        }
        throw err;
      }
    };

    // POUS
    if (category === "pous") {
      // Parse out the name - could be "Main.st" or "Main.ld"
      const match = filename.match(/^(.+)\.(st|ld)$/i);
      if (!match) {
        throw new Error(`Invalid POU filename: ${filename}`);
      }

      const name = match[1];
      const pou = project.objects.find((o) => o.typ === TYPE_POU && o.name.toLowerCase() === name.toLowerCase());
      if (!pou) {
        throw new Error(`No such POU: ${name}`);
      }

      const export_ = exportPou(project, pou.name);
      return export_.text;
    }

    // GVL
    if (category === "gvl") {
      const match = filename.match(/^(.+)\.gvl$/i);
      if (!match) {
        throw new Error(`Invalid GVL filename: ${filename}`);
      }

      const name = match[1];
      const gvl = project.objects.find((o) => o.typ === TYPE_GVL && o.name.toLowerCase() === name.toLowerCase());
      if (!gvl) {
        throw new Error(`No such GVL: ${name}`);
      }

      return exportObject(gvl);
    }

    // DUT
    if (category === "dut") {
      const match = filename.match(/^(.+)\.dut$/i);
      if (!match) {
        throw new Error(`Invalid DUT filename: ${filename}`);
      }

      const name = match[1];
      const dut = project.objects.find((o) => o.typ === TYPE_DATATYPE && o.name.toLowerCase() === name.toLowerCase());
      if (!dut) {
        throw new Error(`No such DUT: ${name}`);
      }

      return exportObject(dut);
    }

    // Tasks
    if (category === "tasks") {
      const match = filename.match(/^(.+)\.json$/i);
      if (!match) {
        throw new Error(`Invalid Task filename: ${filename}`);
      }

      const name = match[1];
      const task = project.tasks.find((t) => t.task.toLowerCase() === name.toLowerCase());
      if (!task) {
        throw new Error(`No such Task: ${name}`);
      }

      return JSON.stringify(task, null, 2);
    }

    // Libraries
    if (category === "libraries") {
      const match = filename.match(/^(.+)\.lib$/i);
      if (!match) {
        throw new Error(`Invalid Library filename: ${filename}`);
      }

      const name = match[1];
      const lib = project.libraries.find((l) => l.name.toLowerCase() === name.toLowerCase());
      if (!lib) {
        throw new Error(`No such Library: ${name}`);
      }

      return JSON.stringify(lib, null, 2);
    }

    throw new Error(`Unknown file category: ${category}`);
  }

  /**
   * Write a file to the .pro, updating the binary and triggering round-trip
   * validation.
   *
   * @param filePath - Path relative to the .pro root (e.g., "POUS/Main.st")
   * @param content - New file contents as a string
   * @throws Error if validation fails or the write is invalid
   */
  writeFile(filePath: string, content: string): void {
    const normalized = filePath.replace(/\\/g, "/").toLowerCase();
    const parts = normalized.split("/");

    if (parts.length !== 2) {
      throw new Error(`Invalid file path: ${filePath}`);
    }

    const [category, filename] = parts;
    let project = this.ensureParsed();

    // Only POUS, GVL, DUT support write-back (TEXT bodies only)
    if (category === "pous" || category === "gvl" || category === "dut") {
      let name: string;
      let obj: any;

      if (category === "pous") {
        const match = filename.match(/^(.+)\.(st|ld)$/i);
        if (!match) throw new Error(`Invalid POU filename: ${filename}`);
        name = match[1];
        obj = project.objects.find((o) => o.typ === TYPE_POU && o.name.toLowerCase() === name.toLowerCase());
        if (!obj) throw new Error(`No such POU: ${name}`);
        name = obj.name; // Use exact case from project
      } else if (category === "gvl") {
        const match = filename.match(/^(.+)\.gvl$/i);
        if (!match) throw new Error(`Invalid GVL filename: ${filename}`);
        name = match[1];
        obj = project.objects.find((o) => o.typ === TYPE_GVL && o.name.toLowerCase() === name.toLowerCase());
        if (!obj) throw new Error(`No such GVL: ${name}`);
        name = obj.name;
      } else {
        // DUT
        const match = filename.match(/^(.+)\.dut$/i);
        if (!match) throw new Error(`Invalid DUT filename: ${filename}`);
        name = match[1];
        obj = project.objects.find((o) => o.typ === TYPE_DATATYPE && o.name.toLowerCase() === name.toLowerCase());
        if (!obj) throw new Error(`No such DUT: ${name}`);
        name = obj.name;
      }

      // For objects with bodies, use importPou; for declaration-only objects, throw
      if (obj.tag === null || obj.tag === 0) {
        throw new Error(`${name} is a declaration-only object (no body). Write-back is not supported for this object type in this version.`);
      }

      // Import the edited POU back into the project
      try {
        project = importPou(project, name, content);
      } catch (err) {
        throw new Error(`Failed to import ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Validate the updated project
      const validationResult = validate(project);
      if (!validationResult.ok) {
        const issues = validationResult.issues.filter((i) => !i.ok).map((i) => `${i.check}: ${i.detail}`).join("; ");
        throw new Error(`Validation failed after editing ${name}: ${issues}`);
      }

      // Rebuild to get new binary
      const { rebuild } = require("codesys-parser");
      const newBuffer = rebuild(project);

      // Write back to disk
      if (!this.fileBuffer) {
        throw new Error("Internal error: fileBuffer not initialized");
      }

      fs.writeFileSync(this.proPath, newBuffer);

      // Update our cache
      this.fileBuffer = newBuffer;
      this.project = project;

      return;
    }

    // Tasks and Libraries are read-only in this phase
    throw new Error(`${category} are read-only in this version`);
  }

  /**
   * Glob pattern matching for files in the fake directory.
   *
   * @param pattern - Glob pattern (e.g., "POUS/*.st", "GVL/*")
   * @returns Array of matching file paths relative to the .pro root
   */
  glob(pattern: string): string[] {
    const normalized = pattern.replace(/\\/g, "/").toLowerCase();

    // Handle simple patterns
    if (normalized === "pous/*" || normalized === "pous/*.st" || normalized === "pous/*.ld") {
      const entries = this.readDirectory("POUS");
      return entries
        .filter((e) => {
          if (normalized === "pous/*") return true;
          if (normalized === "pous/*.st") return e.name.endsWith(".st");
          if (normalized === "pous/*.ld") return e.name.endsWith(".ld");
          return false;
        })
        .map((e) => e.relativePath);
    }

    if (normalized === "gvl/*" || normalized === "gvl/*.gvl") {
      const entries = this.readDirectory("GVL");
      return entries
        .filter((e) => (normalized === "gvl/*" ? true : e.name.endsWith(".gvl")))
        .map((e) => e.relativePath);
    }

    if (normalized === "dut/*" || normalized === "dut/*.dut") {
      const entries = this.readDirectory("DUT");
      return entries
        .filter((e) => (normalized === "dut/*" ? true : e.name.endsWith(".dut")))
        .map((e) => e.relativePath);
    }

    if (normalized === "tasks/*" || normalized === "tasks/*.json") {
      const entries = this.readDirectory("Tasks");
      return entries
        .filter((e) => (normalized === "tasks/*" ? true : e.name.endsWith(".json")))
        .map((e) => e.relativePath);
    }

    if (normalized === "libraries/*" || normalized === "libraries/*.lib") {
      const entries = this.readDirectory("Libraries");
      return entries
        .filter((e) => (normalized === "libraries/*" ? true : e.name.endsWith(".lib")))
        .map((e) => e.relativePath);
    }

    // Recursive pattern
    if (normalized === "**/*" || normalized === "**/*.st") {
      const results: string[] = [];
      const categories = ["POUS", "GVL", "DUT", "Tasks", "Libraries"];
      for (const cat of categories) {
        try {
          const entries = this.readDirectory(cat);
          entries.forEach((e) => {
            if (normalized === "**/*") results.push(e.relativePath);
            if (normalized === "**/*.st" && e.name.endsWith(".st")) results.push(e.relativePath);
          });
        } catch {
          // Category might be empty
        }
      }
      return results;
    }

    throw new Error(`Unsupported glob pattern: ${pattern}`);
  }

  /**
   * Get the underlying parsed Project object.
   */
  getProject(): Project {
    return this.ensureParsed();
  }

  /**
   * Get the underlying raw buffer from disk.
   */
  getRawBuffer(): Buffer {
    if (!this.fileBuffer) {
      if (!fs.existsSync(this.proPath)) {
        throw new Error(`File not found: ${this.proPath}`);
      }
      this.fileBuffer = fs.readFileSync(this.proPath);
    }
    return this.fileBuffer;
  }
}

export default ProFsProjection;
