/**
 * Ladder (LD) element walker - port of ldwalk.py (bible sec. 6.3-6.4).
 *
 * Ladder bodies carry a NETWORK COUNT (u32 after tag 0x1B) but no byte
 * length anywhere in the format, so their extent can only be found by
 * structurally walking every element. Decode is validated (58/58 networks
 * on the reference corpus); write-back (encodeBody) round-trips byte-exact
 * against the same corpus and is used by rebuild() for edited ladder
 * bodies, but synthesizing brand-new elements from scratch (rather than
 * re-emitting `raw` tag bytes read from the file) is NOT validated - see
 * bible sec. 18 gap 1c. LD_WRITEBACK_ENABLED gates that riskier path.
 */

import { LadderElement, LadderNetwork } from "./types";

export const NETWORK_MARKER = Buffer.from([0x08, 0xff]);
export const FOOTER_LEN = 20;

const TIMER_TYPES = new Set(["TON", "TOF", "TP"]);
const EDGE_TYPES = new Set(["R_TRIG", "F_TRIG"]);

export const COIL_MODE: Record<number, string> = {
  0x00: "DIRECT",
  0x02: "SET",
  0x03: "RESET",
};

export class LadderError extends Error {}

function isPrintable(b: number): boolean {
  return b >= 32 && b < 127;
}

/** <len:u8> <name>. Returns [name, nextOffset]. */
function readName(buf: Buffer, p: number, limit: number): [string, number] {
  if (p >= limit) throw new LadderError(`name length past limit at ${p}`);
  const n = buf[p];
  const s = p + 1;
  const e = p + 1 + n;
  if (e > limit) throw new LadderError(`name at ${p} len ${n} overruns limit ${limit}`);
  const nm = buf.subarray(s, e);
  if (n > 0) {
    for (let i = 0; i < nm.length; i++) {
      if (!isPrintable(nm[i])) throw new LadderError(`non-printable name at ${p}: ${nm.toString("latin1")}`);
    }
  }
  return [nm.toString("latin1"), e];
}

/** FB instance record. p points just past the tag byte. */
function readFb(buf: Buffer, pIn: number, limit: number, tag: number): [LadderElement, number] {
  let p = pIn;
  const [name, p1] = readName(buf, p, limit);
  p = p1;
  const pin = buf[p];
  p += 1;
  let literal: string | null = null;
  if (p < limit && buf[p] === 0x41) {
    const [lit, p2] = readName(buf, p + 1, limit);
    literal = lit;
    p = p2;
  }
  const [fbtype, p3] = readName(buf, p, limit);
  p = p3;
  let tlen: number;
  if (TIMER_TYPES.has(fbtype)) tlen = 8;
  else if (EDGE_TYPES.has(fbtype)) tlen = 6;
  else throw new LadderError(`unknown FB type ${fbtype} at ${p}`);
  const trailer = buf.subarray(p, p + tlen);
  p += tlen;
  const el: LadderElement = {
    kind: "FB",
    name,
    fbtype,
    literal,
    pin,
    trailer,
    negated: false,
    terminal: !!(tag & 0x40),
    off: -1,
    end: -1,
    raw: tag,
  };
  return [el, p];
}

/**
 * Walk one network's element tree. Returns [elements, nextOffset].
 * Stack holds each open block's own terminal flag so closes cascade.
 */
function walkTree(buf: Buffer, pIn: number, limit: number): [LadderElement[], number] {
  const elems: LadderElement[] = [];
  const stack: boolean[] = [];
  let p = pIn;

  for (;;) {
    if (p >= limit) throw new LadderError("tree overran network limit");
    const tag = buf[p];
    const base = tag & 0x0f;
    const terminal = !!(tag & 0x40);

    // Block openers carry no name.
    if ((base === 0x09 || base === 0x0a) && !(tag & 0x80)) {
      stack.push(terminal);
      elems.push({
        kind: base === 0x09 ? "SERIES" : "PARALLEL",
        name: null,
        negated: false,
        terminal,
        off: p,
        end: p + 1,
        raw: tag,
      });
      p += 1;
      continue;
    }

    const off = p;
    let el: LadderElement;
    if (base === 0x05) {
      const [fb, p2] = readFb(buf, p + 1, limit, tag);
      el = fb;
      p = p2;
    } else if (base === 0x0b) {
      const [name, p2] = readName(buf, p + 1, limit);
      el = {
        kind: "CONTACT",
        name,
        negated: !!(tag & 0x80),
        terminal,
        off: -1,
        end: -1,
        raw: tag,
      };
      p = p2;
    } else {
      throw new LadderError(`unexpected tree tag 0x${tag.toString(16)} at ${p}`);
    }
    el.off = off;
    el.end = p;
    el.raw = tag;
    elems.push(el);

    if (terminal) {
      if (stack.length === 0) return [elems, p]; // terminal leaf at top level
      while (stack.length > 0) {
        const openerTerminal = stack.pop()!;
        if (!openerTerminal) break;
      }
      if (stack.length === 0) return [elems, p];
    } else if (stack.length === 0) {
      return [elems, p]; // single-element tree
    }
  }
}

/** Walk one network: marker, tree, output list, separator. */
function walkNetwork(
  buf: Buffer,
  pIn: number,
  limit: number,
  isLast: boolean
): [LadderNetwork, number] {
  const start = pIn;
  let p = pIn;
  if (!(buf[p] === 0x08 && buf[p + 1] === 0xff)) {
    throw new LadderError(`missing 08 FF at ${p}`);
  }
  p += 2;
  const [tree, p1] = walkTree(buf, p, limit);
  p = p1;

  if (p + 2 > limit) throw new LadderError("output count past limit");
  const count = buf.readUInt16LE(p);
  p += 2;
  if (count > 64) throw new LadderError(`implausible output count ${count} at ${p - 2}`);

  const outputs: LadderElement[] = [];
  for (let i = 0; i < count; i++) {
    const tag = buf[p];
    const [name, p2] = readName(buf, p + 1, limit);
    outputs.push({
      kind: "OUTPUT",
      name,
      raw: tag,
      negated: !!(tag & 0x80),
      terminal: !!(tag & 0x40),
      off: p,
      end: p2,
    });
    p = p2;
  }

  // Separator = the NEXT network's comment: <len:u32> <text> <00>.
  // Empty comment therefore occupies 5 bytes (00 00 00 00 | 00).
  let sep: Buffer = Buffer.alloc(0);
  let comment: string | null = null;
  if (!isLast) {
    if (p + 4 > limit) throw new LadderError("comment length past limit");
    const clen = buf.readUInt32LE(p);
    if (clen > 4096 || p + 4 + clen + 1 > limit) {
      throw new LadderError(`implausible comment length ${clen} at ${p}`);
    }
    const raw = buf.subarray(p + 4, p + 4 + clen);
    comment = clen ? raw.toString("latin1") : null;
    sep = buf.subarray(p, p + 4 + clen + 1);
    p += 4 + clen + 1;
  }

  const net: LadderNetwork = {
    index: -1,
    off: start,
    end: p,
    tree,
    outputs,
    sep,
    comment,
  };
  return [net, p];
}

/**
 * Walk a complete ladder body. Returns { networks, footer, end }.
 * `end` is the authoritative end of the ladder body - the value the format
 * does not store.
 */
export function walkBody(
  buf: Buffer,
  bodyOff: number,
  nnet: number,
  hardLimit: number
): { networks: LadderNetwork[]; footer: Buffer; end: number } {
  let p = bodyOff;
  const nets: LadderNetwork[] = [];
  for (let i = 0; i < nnet; i++) {
    const [net, p1] = walkNetwork(buf, p, hardLimit, i === nnet - 1);
    net.index = i + 1;
    nets.push(net);
    p = p1;
  }
  const footer = buf.subarray(p, p + FOOTER_LEN);
  p += FOOTER_LEN;
  return { networks: nets, footer, end: p };
}

// ------------------------------------------------------------------ encode

function encodeName(s: string): Buffer {
  const b = Buffer.from(s, "latin1");
  if (b.length > 255) throw new LadderError(`name too long: ${s}`);
  return Buffer.concat([Buffer.from([b.length]), b]);
}

function encodeElement(el: LadderElement): Buffer {
  if (el.kind === "SERIES" || el.kind === "PARALLEL") {
    const raw =
      el.raw !== undefined && el.raw !== null
        ? el.raw
        : (el.kind === "SERIES" ? 0x09 : 0x0a) | (el.terminal ? 0x40 : 0);
    return Buffer.from([raw]);
  }
  if (el.kind === "CONTACT") {
    return Buffer.concat([Buffer.from([el.raw]), encodeName(el.name ?? "")]);
  }
  if (el.kind === "FB") {
    let out = Buffer.concat([Buffer.from([el.raw]), encodeName(el.name ?? ""), Buffer.from([el.pin ?? 0])]);
    if (el.literal != null) {
      out = Buffer.concat([out, Buffer.from([0x41]), encodeName(el.literal)]);
    }
    out = Buffer.concat([out, encodeName(el.fbtype ?? ""), el.trailer ?? Buffer.alloc(0)]);
    return out;
  }
  if (el.kind === "OUTPUT") {
    return Buffer.concat([Buffer.from([el.raw]), encodeName(el.name ?? "")]);
  }
  throw new LadderError(`cannot encode ${el.kind}`);
}

function encodeNetwork(net: LadderNetwork, isLast: boolean): Buffer {
  const parts: Buffer[] = [NETWORK_MARKER];
  for (const el of net.tree) {
    parts.push(encodeElement(el));
  }
  const countBuf = Buffer.alloc(2);
  countBuf.writeUInt16LE(net.outputs.length, 0);
  parts.push(countBuf);
  for (const o of net.outputs) {
    parts.push(encodeElement(o));
  }
  if (!isLast) {
    parts.push(net.sep);
  }
  return Buffer.concat(parts);
}

export function encodeBody(nets: LadderNetwork[], footer: Buffer): Buffer {
  const parts: Buffer[] = [];
  nets.forEach((n, i) => {
    parts.push(encodeNetwork(n, i === nets.length - 1));
  });
  parts.push(footer);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ render

export function renderTree(elems: LadderElement[]): string[] {
  const lines: string[] = [];
  let depth = 0;
  const stack: boolean[] = [];
  for (const el of elems) {
    if (el.kind === "SERIES" || el.kind === "PARALLEL") {
      lines.push("  ".repeat(depth) + `${el.kind}${el.terminal ? "*" : ""}`);
      stack.push(el.terminal);
      depth += 1;
      continue;
    }
    if (el.kind === "CONTACT") {
      const n = el.negated ? "NOT " : "";
      lines.push("  ".repeat(depth) + `${n}${el.name}`);
    } else if (el.kind === "FB") {
      const lit = el.literal ? `, PT:=${el.literal}` : "";
      lines.push("  ".repeat(depth) + `${el.name} : ${el.fbtype}${lit}`);
    }
    if (el.terminal) {
      while (stack.length > 0) {
        const t = stack.pop()!;
        depth -= 1;
        if (!t) break;
      }
    }
  }
  return lines;
}

export function renderNetwork(net: LadderNetwork): string[] {
  const out = [`NETWORK ${net.index}:`];
  out.push(...renderTree(net.tree).map((l) => "  " + l));
  for (const o of net.outputs) {
    const mode = COIL_MODE[o.raw & 0x0f] ?? `0x${o.raw.toString(16)}`;
    out.push(`  => ${o.name} := ${mode}`);
  }
  return out;
}

// ------------------------------------------------------------------ tree

export type TreeNode = string | { kind: "SERIES" | "PARALLEL"; kids: TreeNode[] };

/**
 * Rebuild the nested block tree from the flat element stream, using the
 * same stack semantics as walkTree. Verified against the CoDeSys ladder
 * editor for all six rungs of HybridControl (bible sec. 6.4).
 */
export function buildTree(elems: LadderElement[]): TreeNode[] {
  const root: TreeNode[] = [];
  const stack: [TreeNode[], boolean][] = [];
  let cur = root;
  for (const el of elems) {
    if (el.kind === "SERIES" || el.kind === "PARALLEL") {
      const node: { kind: "SERIES" | "PARALLEL"; kids: TreeNode[] } = { kind: el.kind, kids: [] };
      cur.push(node);
      stack.push([cur, el.terminal]);
      cur = node.kids;
      continue;
    }
    let lbl: string;
    if (el.kind === "FB") {
      lbl = `${el.name}:${el.fbtype}`;
      if (el.literal) lbl += `(${el.literal})`;
    } else {
      lbl = (el.negated ? "NOT " : "") + (el.name ?? "");
    }
    cur.push(lbl);
    if (el.terminal) {
      while (stack.length > 0) {
        const [parent, openerTerminal] = stack.pop()!;
        cur = parent;
        if (!openerTerminal) break;
      }
    }
  }
  return root;
}

/** Boolean-expression form of a network's tree. '.' = series (AND), '||' = parallel (OR). */
export function renderExpr(elems: LadderElement[]): string {
  const show = (node: TreeNode): string => {
    if (typeof node === "string") return node;
    const op = node.kind === "SERIES" ? " . " : " || ";
    return "(" + node.kids.map(show).join(op) + ")";
  };
  return buildTree(elems).map(show).join(" . ");
}
