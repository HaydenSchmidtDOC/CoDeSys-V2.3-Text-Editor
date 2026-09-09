/**
 * Surgical edit primitive - port of proparse.py's splice().
 *
 * Patches BOTH length fields (bible rule 6): the declaration u32 at
 * obj.declLenOff, and the body u32 at (bodyOff - 4). Patching only one
 * shifts the body tag out of alignment and destroys the body silently.
 *
 * Ladder bodies (0x1B) cannot be spliced this way: they carry a network
 * COUNT, not a byte length, so their extent is only known after a full
 * element walk. LD write-back goes through encodeLadderBody() instead
 * (stretch goal, feature-flagged - see rebuild.ts).
 */

import { CodesysObject, BODY_LADDER, BODY_TEXT } from "./types";

export class EditError extends Error {}

export function splice(
  buf: Buffer,
  obj: CodesysObject,
  opts: { newDecl?: Buffer; newBody?: Buffer }
): Buffer {
  const { newDecl, newBody } = opts;

  if (obj.tag === BODY_LADDER && newBody !== undefined) {
    throw new EditError("ladder bodies are read-only via splice() (no byte-length field) - see rebuild.encodeLadderBody for LD write-back");
  }

  // Apply the body edit first (it sits at a higher offset in the file), so
  // the declaration edit below can still use the object's original offsets
  // - the decl span is entirely upstream of the body span and is
  // unaffected by a length change downstream of it.
  let working = buf;

  if (newBody !== undefined && obj.tag === BODY_TEXT && obj.bodyOff !== null && obj.bodyLen !== null) {
    const before = working.subarray(0, obj.bodyOff);
    const after = working.subarray(obj.bodyOff + obj.bodyLen);
    working = Buffer.concat([before, newBody, after]);
    // Body length field lives at bodyOff - 4, unaffected by this splice
    // since it's upstream of bodyOff.
    working.writeUInt32LE(newBody.length >>> 0, obj.bodyOff - 4);
  }

  if (newDecl !== undefined) {
    const before = working.subarray(0, obj.declOff);
    const after = working.subarray(obj.declOff + obj.declLen);
    working = Buffer.concat([before, newDecl, after]);
    working.writeUInt32LE(newDecl.length >>> 0, obj.declLenOff);
  }

  return working;
}
