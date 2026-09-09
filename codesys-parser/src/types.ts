/**
 * Canonical in-memory model. Every object carries byte spans into the
 * original buffer (bible sec. 17.1) so the whole file can be reassembled
 * span-by-span, with unparsed regions copied through verbatim.
 */

export const TYPE_POU = 0x07;
export const TYPE_GVL = 0x00;
export const TYPE_VISU = 0x01;
export const TYPE_DATATYPE = 0x0b; // libraries only

export type ObjType =
  | typeof TYPE_POU
  | typeof TYPE_GVL
  | typeof TYPE_VISU
  | typeof TYPE_DATATYPE;

export const TYPE_NAMES: Record<number, string> = {
  [TYPE_POU]: "POU",
  [TYPE_GVL]: "GVL",
  [TYPE_VISU]: "VISU",
  [TYPE_DATATYPE]: "DATATYPE",
};

export const BODY_TEXT = 0x12; // followed by u32 BYTE LENGTH
export const BODY_LADDER = 0x1b; // followed by u32 NETWORK COUNT (not a length!)

export type BodyKind = "TEXT" | "LD" | null;

/** PROGRAM / FUNCTION / FUNCTION_BLOCK, sniffed from the declaration text (cosmetic, not load-bearing for round-trip). */
export type PouKind = "PROGRAM" | "FUNCTION" | "FUNCTION_BLOCK" | null;

export interface CodesysObject {
  typ: number;
  oid: number;
  cls: number;
  name: string;

  hdrOff: number;
  markStart: number;
  nameEnd: number;

  midOff: number;
  midLen: number;

  declLenOff: number;
  declOff: number;
  declLen: number;

  tag: number | null;
  bodyOff: number | null;
  bodyLen: number | null; // TEXT only
  nnet: number | null; // LD only

  pouKind: PouKind;
}

export function objKind(o: CodesysObject): string {
  return TYPE_NAMES[o.typ] ?? `UNKNOWN(0x${o.typ.toString(16)})`;
}

export function objBodyKind(o: CodesysObject): BodyKind {
  if (o.tag === BODY_TEXT) return "TEXT";
  if (o.tag === BODY_LADDER) return "LD";
  return null;
}

export function objDecl(buf: Buffer, o: CodesysObject): Buffer {
  return buf.subarray(o.declOff, o.declOff + o.declLen);
}

export function objBody(buf: Buffer, o: CodesysObject): Buffer | null {
  if (o.tag !== BODY_TEXT || o.bodyOff === null || o.bodyLen === null) return null;
  return buf.subarray(o.bodyOff, o.bodyOff + o.bodyLen);
}

export function objMid(buf: Buffer, o: CodesysObject): Buffer {
  return buf.subarray(o.midOff, o.midOff + o.midLen);
}

// --------------------------------------------------------------- directory

export interface DirNode {
  offset: number;
  name: string;
  isFolder: boolean;
  /** object id for a POU record, child count for a folder record */
  value: number;
}

// --------------------------------------------------------------- libraries

export interface LibraryRecord {
  off: number;
  name: string;
  recLen: number | null;
  ok: boolean;
  ts: number;
}

export interface LibrarySymbol {
  off: number;
  name: string;
}

// --------------------------------------------------------------- tasks

export interface TaskRecord {
  off: number;
  task: string;
  program: string;
  disabled: boolean;
  paramA: number;
  paramB: number;
}

// --------------------------------------------------------------- ladder (re-exported from ladder.ts)

export interface LadderElement {
  kind: "SERIES" | "PARALLEL" | "CONTACT" | "FB" | "OUTPUT";
  name: string | null;
  negated: boolean;
  terminal: boolean;
  off: number;
  end: number;
  fbtype?: string;
  literal?: string | null;
  pin?: number;
  trailer?: Buffer;
  raw: number; // original tag byte - MUST be preserved for byte-exact re-encode
}

export interface LadderNetwork {
  index: number;
  off: number;
  end: number;
  tree: LadderElement[];
  outputs: LadderElement[];
  sep: Buffer; // raw bytes of the trailing comment/separator (empty for the last network)
  comment: string | null;
}

// --------------------------------------------------------------- project

export interface Project {
  /** Immutable original buffer. Never mutated by parse(). */
  raw: Buffer;
  objects: CodesysObject[];
  directory: DirNode[];
  dirRootOffsets: { offset: number; name: string }[];
  libraries: LibraryRecord[];
  librarySymbols: LibrarySymbol[];
  tasks: TaskRecord[];
  version: string | null;
  /** Ladder decode cache, keyed by object id. Populated lazily by getLadder(). */
  ladderCache: Map<number, { networks: LadderNetwork[]; footer: Buffer; end: number }>;
}

export interface ValidationIssue {
  check: string;
  ok: boolean;
  detail: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  roundTripByteExact: boolean;
}
