/**
 * Top-level parse() - builds the Project model (bible sec. 17.1).
 */

import { parseObjects } from "./objects";
import { findDirRoots, parseDirectory } from "./directory";
import { parseLibraryTable, parseLibrarySymbolIndex } from "./libraries";
import { parseTaskConfig } from "./tasks";
import { Project } from "./types";

const MAGIC = Buffer.from("CoDeSys+", "latin1");

export class ParseError extends Error {}

function detectVersion(buf: Buffer): string | null {
  const head = buf.subarray(0, 120).toString("latin1");
  const m = /\d+\.\d+\.\d+\.\d+/.exec(head);
  return m ? m[0] : null;
}

export function parse(buf: Buffer): Project {
  if (buf.subarray(0, 8).compare(MAGIC) !== 0) {
    throw new ParseError("not a CoDeSys+ container (bad magic)");
  }

  const objects = parseObjects(buf);
  const dirRootOffsets = findDirRoots(buf);

  let directory: Project["directory"] = [];
  const poRoot = dirRootOffsets.find((r) => r.offset >= 0);
  if (poRoot) {
    directory = parseDirectory(buf, poRoot.offset);
  }

  const libraries = parseLibraryTable(buf);

  // Library symbol index sits after the library table; scan a generous
  // window starting right after the last library record.
  let librarySymbols: Project["librarySymbols"] = [];
  if (libraries.length > 0) {
    const last = libraries[libraries.length - 1];
    const start = last.off + last.name.length + 2 + 4;
    const stop = Math.min(buf.length, start + 40000);
    librarySymbols = parseLibrarySymbolIndex(buf, start, stop);
  }

  const tasks = parseTaskConfig(buf);
  const version = detectVersion(buf);

  return {
    raw: buf,
    objects,
    directory,
    dirRootOffsets,
    libraries,
    librarySymbols,
    tasks,
    version,
    ladderCache: new Map(),
  };
}
