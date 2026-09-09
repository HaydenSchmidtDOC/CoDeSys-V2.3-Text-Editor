/**
 * Invariant checks - port of proparse.py's verify(), which operationalizes
 * the bible's sec. 17.3 invariant list (122/122 on the reference corpus).
 * "A parser that guesses is worse than one that stops."
 */

import { u32 } from "./binary";
import { BODY_LADDER, BODY_TEXT, Project, ValidationIssue, objBody } from "./types";
import { NETWORK_MARKER, walkBody, LadderError, encodeBody } from "./ladder";
import { nextHeaderAfter } from "./ladderExtent";
import { rebuild } from "./rebuild";

const MAGIC = Buffer.from("CoDeSys+", "latin1");

export function verify(project: Project): ValidationIssue[] {
  const buf = project.raw;
  const res: ValidationIssue[] = [];
  const chk = (check: string, ok: boolean, detail = "") => res.push({ check, ok, detail });

  chk("magic is CoDeSys+", buf.subarray(0, 8).compare(MAGIC) === 0);

  const ids = project.objects.map((o) => o.oid);
  chk(
    "object ids unique",
    ids.length === new Set(ids).size,
    `${ids.length} objects, ${new Set(ids).size} distinct`
  );

  // LD: u32 network-count field must equal the count of 08 FF markers up to
  // the next object header (invariant 7).
  for (const o of project.objects) {
    if (o.tag === BODY_LADDER && o.bodyOff !== null && o.nnet !== null) {
      const hard = nextHeaderAfter(project.objects, o.bodyOff, buf.length);
      const seg = buf.subarray(o.bodyOff, hard);
      let cnt = 0;
      let idx = 0;
      while (true) {
        const p = seg.indexOf(NETWORK_MARKER, idx);
        if (p === -1) break;
        cnt++;
        idx = p + 1;
      }
      chk(`LD ${o.name}: nnet==08FF count`, cnt === o.nnet, `field=${o.nnet} markers=${cnt}`);
    }
  }

  // Declaration length field + text body printability (invariant 8).
  for (const o of project.objects) {
    chk(`${o.name}: decl u32 matches`, u32(buf, o.declLenOff) === o.declLen);
    if (o.tag === BODY_TEXT) {
      const b = objBody(buf, o);
      if (b) {
        let printable = 0;
        for (let i = 0; i < b.length; i++) {
          const x = b[i];
          if ((x >= 32 && x < 127) || x === 9 || x === 10 || x === 13) printable++;
        }
        chk(`${o.name}: body printable`, printable / Math.max(1, b.length) > 0.98);
      }
    }
  }

  // 25-byte middle region applies to normal project objects (cls 0x2C) only.
  for (const o of project.objects) {
    if (o.cls !== 0x2c) continue;
    chk(`${o.name}: mid is 25 bytes`, o.midLen === 25, `got ${o.midLen}`);
  }

  // Ladder: walk every network structurally and confirm the derived end
  // equals the next object header, and re-encoding is byte-exact
  // (invariants 7b, 7c, 7d).
  for (const o of project.objects) {
    if (o.tag !== BODY_LADDER || o.bodyOff === null || o.nnet === null) continue;
    const hard = nextHeaderAfter(project.objects, o.bodyOff, buf.length);
    try {
      const { networks, footer, end } = walkBody(buf, o.bodyOff, o.nnet, hard);
      chk(`LD ${o.name}: walked nnet networks`, networks.length === o.nnet);
      chk(`LD ${o.name}: lands on next object header`, end === hard, `end=${end} hdr=${hard}`);
      chk(
        `LD ${o.name}: re-encode byte-exact`,
        encodeBody(networks, footer).compare(buf.subarray(o.bodyOff, end)) === 0
      );
    } catch (exc) {
      chk(`LD ${o.name}: walk`, false, exc instanceof LadderError ? exc.message : String(exc));
    }
  }

  for (const L of project.libraries) {
    chk(`lib recLen ${L.name.slice(0, 22)}`, L.ok, `recLen=${L.recLen}`);
  }

  return res;
}

export function noOpRoundTripByteExact(project: Project): boolean {
  return rebuild(project).compare(project.raw) === 0;
}
