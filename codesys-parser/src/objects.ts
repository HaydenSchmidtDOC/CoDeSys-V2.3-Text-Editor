/**
 * Object store walker - port of proparse.py's parse_objects().
 *
 * Anchors on maximal MARK runs; never on keywords (PhysicalMapping's
 * declaration legitimately begins with CRLF, which breaks keyword
 * anchoring and computes an absurd length - bible sec. 0 rule 2).
 */

import { u16, u32, allPrintable } from "./binary";
import { findMarks, readStringAtMark } from "./marks";
import { CodesysObject, TYPE_NAMES, BODY_TEXT, BODY_LADDER, PouKind } from "./types";

export const MAX_NAME_LEN = 64;
export const MAX_DECL_LEN = 200_000;

function sniffPouKind(decl: Buffer): PouKind {
  const text = decl.toString("latin1");
  const m = /\b(PROGRAM|FUNCTION_BLOCK|FUNCTION)\b/.exec(text);
  if (!m) return null;
  return m[1] as PouKind;
}

export function parseObjects(buf: Buffer): CodesysObject[] {
  const objs: CodesysObject[] = [];
  const marks = findMarks(buf);

  for (const { start: ms, end: me } of marks) {
    if (ms < 16) continue;
    const nameRes = readStringAtMark(buf, me, MAX_NAME_LEN);
    if (!nameRes) continue;
    const { data: name, end: nameEnd } = nameRes;
    if (!allPrintable(name)) continue;

    const typ = buf[ms - 16];
    if (!(typ in TYPE_NAMES)) continue;
    const oid = u32(buf, ms - 14);
    const cls = u16(buf, ms - 10);

    // Declaration = next MARK-anchored string that looks like a decl,
    // searched within a 300-byte window after the name.
    const windowEnd = Math.min(buf.length, nameEnd + 300);
    const window = buf.subarray(nameEnd, windowEnd);
    const localMarks = findMarks(window);

    let decl: Buffer | null = null;
    let declLenOff = -1;
    let declOff = -1;
    let declEnd = -1;
    let midOff = -1;
    let midLen = -1;

    for (const lm of localMarks) {
      const absEnd = nameEnd + lm.end;
      const candRes = readStringAtMark(buf, absEnd, MAX_DECL_LEN);
      if (!candRes) continue;
      const cand = candRes.data;
      if (
        cand.includes(Buffer.from("END_VAR")) ||
        cand.includes(Buffer.from("VAR_")) ||
        cand.subarray(0, 40).includes(Buffer.from("VAR"))
      ) {
        decl = cand;
        declLenOff = absEnd;
        declOff = absEnd + 4;
        declEnd = candRes.end;
        // The middle region ends at the NOMINAL mark start (mark_end - 16).
        // Using the maximal run's actual start would under-count by 2 bytes
        // per absorbed padding pair.
        midOff = nameEnd;
        midLen = absEnd - 16 - nameEnd;
        break;
      }
    }
    if (decl === null) continue;

    const o: CodesysObject = {
      typ,
      oid,
      cls,
      name: name.toString("latin1"),
      hdrOff: ms - 16,
      markStart: ms,
      nameEnd,
      midOff,
      midLen,
      declLenOff,
      declOff,
      declLen: decl.length,
      tag: declEnd < buf.length ? buf[declEnd] : null,
      bodyOff: null,
      bodyLen: null,
      nnet: null,
      pouKind: sniffPouKind(decl),
    };

    if (o.tag === BODY_TEXT) {
      o.bodyLen = u32(buf, declEnd + 1); // u32, NOT u16
      o.bodyOff = declEnd + 5;
    } else if (o.tag === BODY_LADDER) {
      o.nnet = u32(buf, declEnd + 1); // NETWORK COUNT, not a length
      o.bodyOff = declEnd + 8;
    }

    objs.push(o);
  }
  return objs;
}
