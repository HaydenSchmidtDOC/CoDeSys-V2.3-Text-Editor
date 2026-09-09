/**
 * Object directory tree - port of proparse.py's find_dir_roots / parse_directory
 * (bible sec. 7).
 */

import { u32, u16, allPrintable } from "./binary";
import { DirNode } from "./types";

/**
 * Locate tree roots structurally. Root names are LOCALE-DEPENDENT ('POUs' in
 * en, 'Bausteine'/'Datentypen'/'Globale Variablen' in de), so never hardcode
 * them.
 */
export function findDirRoots(buf: Buffer): { offset: number; name: string }[] {
  const roots: { offset: number; name: string }[] = [];
  const sig = Buffer.from([0x01, 0x00, 0x01, 0x00]);
  let idx = 0;
  while (true) {
    const o = buf.indexOf(sig, idx);
    if (o === -1) break;
    idx = o + 1;
    if (o + 8 > buf.length) continue;
    const n = u32(buf, o + 4);
    if (!(n >= 1 && n <= 40)) continue;
    const nm = buf.subarray(o + 8, o + 8 + n);
    if (allPrintable(nm)) {
      roots.push({ offset: o, name: nm.toString("latin1") });
    }
  }
  return roots;
}

/**
 * Flat walk of the directory table from `start`.
 *   FOLDER : 01 00 01 00 <len u32> <name> <childCount u16> <hasSub u16>
 *   POU    : 01 00 <len u32> <name> 00 00 <objectId u32> <linkFlags 12B>
 */
export function parseDirectory(buf: Buffer, start: number): DirNode[] {
  const out: DirNode[] = [];
  let o = start;
  const end = Math.min(buf.length, start + 4000);
  while (o < end - 8) {
    if (buf[o] === 1 && buf[o + 1] === 0) {
      const folder = buf[o + 2] === 1 && buf[o + 3] === 0;
      const lo = folder ? o + 4 : o + 2;
      const n = u32(buf, lo);
      if (n >= 1 && n <= 40) {
        const nm = buf.subarray(lo + 4, lo + 4 + n);
        if (allPrintable(nm)) {
          const tail = lo + 4 + n;
          const val = folder ? u16(buf, tail) : u32(buf, tail + 2);
          out.push({ offset: o, name: nm.toString("latin1"), isFolder: folder, value: val });
          o = tail;
          continue;
        }
      }
    }
    o += 1;
  }
  return out;
}
