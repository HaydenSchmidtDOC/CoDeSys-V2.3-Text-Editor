/**
 * Small binary helpers. All integers in the format are little-endian.
 */

export function u16(buf: Buffer, off: number): number {
  return buf.readUInt16LE(off);
}

export function u32(buf: Buffer, off: number): number {
  return buf.readUInt32LE(off);
}

export function writeU32(buf: Buffer, off: number, value: number): void {
  buf.writeUInt32LE(value >>> 0, off);
}

export function writeU16(buf: Buffer, off: number, value: number): void {
  buf.writeUInt16LE(value & 0xffff, off);
}

/** latin-1 in, latin-1 out - the format is not UTF-8. */
export function decodeLatin1(buf: Buffer): string {
  return buf.toString("latin1");
}

export function encodeLatin1(s: string): Buffer {
  return Buffer.from(s, "latin1");
}

export function isPrintableAscii(byte: number): boolean {
  return byte >= 32 && byte < 127;
}

export function allPrintable(buf: Buffer, start = 0, end = buf.length): boolean {
  for (let i = start; i < end; i++) {
    if (!isPrintableAscii(buf[i])) return false;
  }
  return true;
}
