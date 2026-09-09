/**
 * Library manager table + library symbol index - port of proparse.py
 * (bible sec. 9).
 */

import { u32 } from "./binary";
import { LibraryRecord, LibrarySymbol } from "./types";

/**
 * Library manager table: N records of
 *   <recLen u32> "<name>.lib d.m.yy hh:mm:ss" 00 40 <timestamp u32>
 * recLen covers name + 00 + 40 + 4 timestamp bytes (= len(name) + 6).
 */
export function parseLibraryTable(buf: Buffer): LibraryRecord[] {
  const libs: LibraryRecord[] = [];
  const text = buf.toString("latin1");
  const re = /[A-Za-z0-9_]+\.(?:lib|LIB|Lib) [0-9.]+ [0-9:]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const s = m.index;
    const e = s + m[0].length;
    if (!(buf[e] === 0x00 && buf[e + 1] === 0x40)) continue;
    const recLen = s >= 4 ? u32(buf, s - 4) : null;
    const ts = u32(buf, e + 2);
    libs.push({
      off: s,
      name: m[0],
      recLen,
      ok: recLen === m[0].length + 6,
      ts,
    });
  }
  return libs;
}

/** Flat list: <len u32><name> 00 00 00 00, repeated. */
export function parseLibrarySymbolIndex(buf: Buffer, start: number, stop: number): LibrarySymbol[] {
  const names: LibrarySymbol[] = [];
  let o = start;
  while (o < stop - 8) {
    const n = u32(buf, o);
    if (n > 0 && n < 80) {
      const nm = buf.subarray(o + 4, o + 4 + n);
      let ok = true;
      for (let i = 0; i < nm.length; i++) {
        if (!(nm[i] >= 33 && nm[i] < 127)) {
          ok = false;
          break;
        }
      }
      if (ok) {
        names.push({ off: o, name: nm.toString("latin1") });
        o += 4 + n + 4;
        continue;
      }
    }
    o += 1;
  }
  return names;
}
