/**
 * codesys-parser - standalone TypeScript parser core for TwinCAT 2 /
 * CoDeSys V2.3 `.pro` binaries.
 *
 * Port of docs/Phase_2_Updates/proparse.py + ldwalk.py per
 * docs/Phase_2_Updates/TWINCAT_PRO_PARSER_BIBLE.md. Span-preserving:
 * rebuild(parse(buf)) is byte-exact for any unedited input. No VS Code
 * dependency, no Node-fs API beyond Buffer, so this is consumable from a
 * VS Code extension, an AI filesystem hook, and git hooks alike.
 */

export { parse, ParseError } from "./parse";
export { rebuild, encodeLadderBody } from "./rebuild";
export { exportPou, importPou, importPouByOid, LD_WRITEBACK_ENABLED, DECL_BOUNDARY, PouExport } from "./pou";
export { diff, ObjectDiff, ObjectDiffKind, ProjectDiff } from "./diff";
export { validate } from "./validate";
export { verify, noOpRoundTripByteExact } from "./verify";
export { splice, EditError } from "./edit";
export { decryptLib, looksDecrypted, libKeystream } from "./decrypt";
export {
  walkBody,
  encodeBody,
  renderNetwork,
  renderTree,
  buildTree,
  renderExpr,
  LadderError,
  COIL_MODE,
} from "./ladder";
export { getLadderDecode, nextHeaderAfter, LadderDecode } from "./ladderExtent";

export * from "./types";
