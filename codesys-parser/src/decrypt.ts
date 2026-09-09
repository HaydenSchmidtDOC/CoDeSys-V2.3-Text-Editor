/**
 * `.lib` XOR decryption (bible sec. 13). Not needed for `.pro` files, but
 * part of the same container family and included for completeness / future
 * library-aware tooling.
 *
 *   k[i] = (0xEF * (i + 1)) mod 256
 *   plaintext[i] = ciphertext[i] XOR k[i]   for i >= 20
 *   plaintext[i] = ciphertext[i]            for i <  20  (header not encrypted)
 *
 * XOR is an involution: the same routine re-encrypts. The keystream is
 * indexed by ABSOLUTE offset, so decrypt whole -> edit -> re-encrypt whole.
 * You cannot patch ciphertext in place.
 */

export function libKeystream(i: number): number {
  return (0xef * (i + 1)) & 0xff;
}

export function decryptLib(data: Buffer, start = 20): Buffer {
  const out = Buffer.from(data);
  for (let i = start; i < out.length; i++) {
    out[i] = out[i] ^ libKeystream(i);
  }
  return out;
}

/** Self-validating check: offset 20 must be 0x0B then 'SERIAL10COM'. */
export function looksDecrypted(plain: Buffer): boolean {
  return plain[20] === 0x0b && plain.subarray(21, 32).toString("latin1") === "SERIAL10COM";
}
