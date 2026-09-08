// Test the "cascade close" hypothesis for 0x40 semantics against the corpus.
// Hypothesis: 0x40 on a leaf closes the innermost group. 0x40 on an OPEN
// marks the PARENT group as "closes after this group" - when the group closes
// (via a leaf's 0x40 or network end), all marked ancestors close too.
// This should fix HybridControl NET 15 AND Intrusion NET 2 (the README's
// known-wrong cases) without breaking the validated networks.
"use strict";
const fs = require("fs");
const { decodePro } = require("../pro-viewer-extension/decoder");

const buf = fs.readFileSync("TEST CORPUS/101079 BSL.pro");
const pous = decodePro(buf);

function isPrintable(b) { return (b >= 32 && b < 127) || b === 9 || b === 10 || b === 13; }
function findPrintableRuns(b) {
  const runs = []; let cur = null;
  for (let i = 0; i < b.length; i++) {
    if (isPrintable(b[i])) { if (cur === null) cur = i; }
    else if (cur !== null) { const len = i - cur; if (len >= 20) runs.push([cur, len]); cur = null; }
  }
  if (cur !== null) runs.push([cur, b.length - cur]);
  return runs;
}
const runs = findPrintableRuns(buf);
const starts = [];
for (const [s, l] of runs) {
  let i = s; const lim = s + l;
  while (i < lim && (buf[i] === 0x0d || buf[i] === 0x0a || buf[i] === 0x09 || buf[i] === 0x20)) i++;
  const slice = buf.toString("latin1", i, Math.min(lim, i + 20));
  if (["PROGRAM ", "FUNCTION_BLOCK ", "FUNCTION "].some((kw) => slice.startsWith(kw))) starts.push(s);
}
function pouNameAt(b, s) {
  let i = s; const lim = s + 80;
  while (i < lim && (b[i] === 0x0d || b[i] === 0x0a || b[i] === 0x09 || b[i] === 0x20)) i++;
  const slice = b.toString("latin1", i, Math.min(lim, i + 80));
  const m = slice.match(/^\s*(?:PROGRAM|FUNCTION_BLOCK|FUNCTION)\s+([A-Za-z0-9_]+)/);
  return m ? m[1] : null;
}

const LD_NAMES = ["CanopyControl", "ControlledBuffer", "HybridControl", "GlobalFlags", "Intrusion", "RearTrack"];

function renderTree(node) {
  if (!("children" in node)) {
    if (node.fb) return `${node.name}.Q`;
    return node.negated ? `NOT ${node.name}` : node.name;
  }
  if (node.children.length === 1) return renderTree(node.children[0]);
  const parts = [];
  for (const child of node.children) {
    const s = renderTree(child);
    parts.push("children" in child && child.children.length > 1 ? `(${s})` : s);
  }
  return parts.length <= 1 ? parts[0] || "" : parts.join(node.type === "AND" ? " AND " : " OR ");
}

// Cascade-close parser
function parseWithCascade(buf, start, limit) {
  // post-END_VAR
  let pos = start;
  for (;;) {
    const idx = buf.indexOf("END_VAR", pos, "latin1");
    if (idx === -1 || idx >= limit) break;
    const after = idx + 7;
    const tail = buf.toString("latin1", after, Math.min(after + 16, limit)).replace(/^[\r\n]+/, "");
    if (tail.startsWith("VAR")) { pos = after; continue; }
    pos = after; break;
  }
  const bodyStart = pos;
  // records
  const records = [];
  let i = bodyStart;
  while (i < limit - 2) {
    const len = buf[i + 1];
    if (len >= 1 && len <= 40 && i + 2 + len <= limit) {
      let ok = true;
      for (let k = i + 2; k < i + 2 + len; k++) if (!(buf[k] >= 32 && buf[k] < 127)) { ok = false; break; }
      if (ok) { records.push({ off: i, tag: buf[i], name: buf.toString("ascii", i + 2, i + 2 + len) }); i += 2 + len; continue; }
    }
    i++;
  }
  const BOUNDARY_LOOKBACK = 8;
  const networks = [];
  let current = null;
  let lastEnd = bodyStart;
  let prevWasContact = false;
  const consumedByFb = new Set();
  function readPascalTypeName(off, lim) {
    if (off + 1 > lim) return null;
    const len = buf[off];
    if (len < 1 || len > 20 || off + 1 + len > lim) return null;
    let s = "";
    for (let k = 0; k < len; k++) { const c = buf[off + 1 + k]; if (!((c >= 65 && c <= 90) || c === 95)) return null; s += String.fromCharCode(c); }
    return s;
  }
  for (let ri = 0; ri < records.length; ri++) {
    if (consumedByFb.has(ri)) continue;
    const rec = records[ri];
    const windowStart = Math.max(lastEnd, rec.off - BOUNDARY_LOOKBACK);
    const between = buf.subarray(windowStart, rec.off);
    let markerPos = -1;
    for (let k = 0; k + 1 < between.length; k++) if (between[k] === 0x08 && between[k + 1] === 0xff) { markerPos = windowStart + k; break; }
    let gap; let fresh = false;
    if (current === null || markerPos !== -1) {
      current = { n: networks.length + 1, tree: { type: "AND", children: [] }, treeOk: true, outputs: [] };
      networks.push(current);
      gap = markerPos !== -1 ? buf.subarray(markerPos + 2, rec.off) : Buffer.alloc(0);
      fresh = true;
    } else {
      gap = buf.subarray(lastEnd, rec.off);
    }
    const base = rec.tag & ~(0x80 | 0x40);
    const isContact = base === 0x0b;
    const isFb = (rec.tag & ~0x40) === 0x05;
    if (isContact || isFb) {
      if (!fresh && !prevWasContact) gap = Buffer.alloc(0);
      const stack = current._stack || [current.tree];
      for (const g of gap) {
        const opType = (g & ~0x40) === 0x09 ? "AND" : (g & ~0x40) === 0x0a ? "OR" : null;
        if (opType === null) { current.treeOk = false; continue; }
        const node = { type: opType, children: [] };
        const parent = stack[stack.length - 1];
        parent.children.push(node);
        stack.push(node);
        if (g & 0x40) parent._marked = true; // mark parent: closes after this group
      }
      let leaf;
      let consumedEnd = rec.off + 2 + rec.name.length;
      if (isContact) {
        leaf = { name: rec.name, negated: (rec.tag & 0x80) !== 0 };
      } else {
        let pt = null, fbType = null;
        const nextRec = records[ri + 1];
        if (nextRec && nextRec.tag === 0x41 && nextRec.off - consumedEnd <= 4) {
          pt = nextRec.name; consumedEnd = nextRec.off + 2 + nextRec.name.length; consumedByFb.add(ri + 1);
          fbType = readPascalTypeName(consumedEnd, limit);
          if (fbType) {
            const te = consumedEnd + 1 + fbType.length;
            const trailer = buf.subarray(te, te + 8);
            if (trailer.length === 8 && trailer[0] === 1 && trailer.subarray(1).every((b) => b === 0)) consumedEnd = te + 8;
          }
        } else if (nextRec && nextRec.tag === 0x40 && nextRec.off - consumedEnd <= 4) {
          fbType = nextRec.name; consumedEnd = nextRec.off + 2 + nextRec.name.length; consumedByFb.add(ri + 1);
          const trailer = buf.subarray(consumedEnd, consumedEnd + 6);
          if (trailer.length === 6 && trailer.every((b) => b === 0)) consumedEnd += 6;
        }
        leaf = { name: rec.name, fb: true, fbType, pt };
      }
      stack[stack.length - 1].children.push(leaf);
      if (rec.tag & 0x40) {
        // Close the innermost group, then cascade through marked ancestors.
        if (stack.length <= 1) { current.treeOk = false; }
        else {
          stack.pop();
          while (stack.length > 1 && stack[stack.length - 1]._marked) stack.pop();
        }
      }
      current._stack = stack;
      lastEnd = consumedEnd;
      prevWasContact = true;
    } else if (rec.tag === 0x00 || rec.tag === 0x02 || rec.tag === 0x03) {
      current.outputs.push({ name: rec.name, mode: rec.tag === 0x02 ? "SET" : rec.tag === 0x03 ? "RESET" : "DIRECT" });
      lastEnd = rec.off + 2 + rec.name.length;
      prevWasContact = false;
    } else {
      lastEnd = rec.off + 2 + rec.name.length;
      prevWasContact = false;
    }
  }
  return networks;
}

for (const name of LD_NAMES) {
  const idx = starts.findIndex((s) => pouNameAt(buf, s) === name);
  if (idx === -1) continue;
  const start = starts[idx];
  const nextStart = idx + 1 < starts.length ? starts[idx + 1] : buf.length;
  const nets = parseWithCascade(buf, start, nextStart);
  const pou = pous.find((p) => p.name === name);
  console.log("===== " + name + " =====");
  for (const net of nets) {
    const rendered = net.treeOk ? renderTree(net.tree) : "(tree not ok)";
    console.log(`NET ${net.n}: ${rendered}`);
  }
  console.log("");
}