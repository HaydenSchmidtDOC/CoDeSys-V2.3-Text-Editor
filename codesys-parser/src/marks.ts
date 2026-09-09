/**
 * The MARK - universal string anchor (bible sec. 2).
 *
 *   (02 00) repeated N times, N >= 8      <- MAXIMAL run
 *   <length : u32>
 *   <bytes : length>                       <- latin-1, NOT NUL-terminated
 *
 * Rule 1 (bible sec. 0): anchor on the MARK, and the MARK is a *maximal*
 * run. Never anchor on the run's start - some objects' trailing padding
 * bytes contain 02 00 pairs that extend the run, and reading the length at
 * the wrong offset yields garbage.
 */

import { u32 } from "./binary";

export interface Mark {
  start: number;
  end: number;
}

const PAIR = Buffer.from([0x02, 0x00]);

/** Yield every MAXIMAL run of (02 00) x N, N >= 8, as {start, end} (end = byte after the run, i.e. where the length u32 begins). */
export function findMarks(buf: Buffer): Mark[] {
  const marks: Mark[] = [];
  let i = 0;
  const len = buf.length;
  while (i < len - 1) {
    if (buf[i] === 0x02 && buf[i + 1] === 0x00) {
      const runStart = i;
      let j = i;
      let pairs = 0;
      while (j < len - 1 && buf[j] === 0x02 && buf[j + 1] === 0x00) {
        pairs++;
        j += 2;
      }
      if (pairs >= 8) {
        marks.push({ start: runStart, end: j });
      }
      i = j > i ? j : i + 1;
    } else {
      i++;
    }
  }
  return marks;
}

/**
 * Read <u32 len><bytes> at the end of a MARK run.
 * Returns null if the length is implausible or would overrun the buffer.
 */
export function readStringAtMark(
  buf: Buffer,
  markEnd: number,
  maxLen: number
): { data: Buffer; end: number } | null {
  if (markEnd + 4 > buf.length) return null;
  const n = u32(buf, markEnd);
  if (!(n > 0 && n <= maxLen)) return null;
  if (markEnd + 4 + n > buf.length) return null;
  return { data: buf.subarray(markEnd + 4, markEnd + 4 + n), end: markEnd + 4 + n };
}
