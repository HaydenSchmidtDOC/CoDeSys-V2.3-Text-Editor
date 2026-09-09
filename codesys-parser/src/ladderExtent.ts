/**
 * Authoritative end of a ladder body, via the element walker (bible sec. 6.4).
 * The format stores no byte length for ladder bodies - only a network count -
 * so the extent must be derived structurally. Cached on the Project so
 * repeated calls (verify + rebuild + export) don't re-walk.
 */

import { walkBody, LadderError } from "./ladder";
import { CodesysObject, Project, LadderNetwork } from "./types";
import { BODY_LADDER } from "./types";

export interface LadderDecode {
  networks: LadderNetwork[];
  footer: Buffer;
  end: number;
}

export function nextHeaderAfter(objects: CodesysObject[], off: number, fileLen: number): number {
  let min = fileLen;
  for (const o of objects) {
    if (o.hdrOff > off && o.hdrOff < min) min = o.hdrOff;
  }
  return min;
}

export function getLadderDecode(project: Project, o: CodesysObject): LadderDecode {
  if (o.tag !== BODY_LADDER || o.bodyOff === null || o.nnet === null) {
    throw new LadderError(`${o.name} is not a ladder object`);
  }
  const cached = project.ladderCache.get(o.oid);
  if (cached) return cached;

  const hardLimit = nextHeaderAfter(project.objects, o.bodyOff, project.raw.length);
  const { networks, footer, end } = walkBody(project.raw, o.bodyOff, o.nnet, hardLimit);
  const decode: LadderDecode = { networks, footer, end };
  project.ladderCache.set(o.oid, decode);
  return decode;
}
