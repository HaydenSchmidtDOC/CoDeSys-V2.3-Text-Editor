// Verify the attachment's LD encoding claims against the real HybridControl
// binary body in the corpus. The attachment (from a real TwinCat ladder
// printout) claims:
//   - Every element is [gap bytes] [tag] [name]; gap bytes are structure nodes
//   - 09 = series (AND) open, 0a = parallel (OR) open, 0b = contact
//   - +0x40 = LAST child of the current list (terminates its block)
//   - +0x80 = negated contact
//   - 45 = FB instance, 41 = literal, 03 54 4f 4e = len-prefixed "TON"
//   - Coils distinguished by a FIELD AFTER the name, not the tag byte
//     (trailing `01 00`/`02 00` + tag 0/2/3 = output/pin-reference list)
//   - Serialization is depth-first: open a block, emit children, child with
//     0x40 closes it
// Worked proofs to check: NET 6, 8, 9, 10, 11, 13, 16.
"use strict";
const fs = require("fs");
const { decodePro } = require("../pro-viewer-extension/decoder");

const buf = fs.readFileSync("TEST CORPUS/101079 BSL.pro");
const pous = decodePro(buf);
const hyb = pous.find((p) => p.name === "HybridControl");
console.log("=== HybridControl (base .pro) ===");
console.log("editable=" + hyb.editable + "\n");
console.log(hyb.text);

// Locate the raw binary region of HybridControl (header run -> next POU start)
// by re-deriving the same runs/starts the decoder uses.
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
const POU_KW = ["PROGRAM ", "FUNCTION_BLOCK ", "FUNCTION "];
function pouNameAt(b, s) {
  let i = s; const lim = s + 80;
  while (i < lim && (b[i] === 0x0d || b[i] === 0x0a || b[i] === 0x09 || b[i] === 0x20)) i++;
  const slice = b.toString("latin1", i, Math.min(lim, i + 80));
  const m = slice.match(/^\s*(?:PROGRAM|FUNCTION_BLOCK|FUNCTION)\s+([A-Za-z0-9_]+)/);
  return m ? m[1] : null;
}
const hybIdx = starts.findIndex((s) => pouNameAt(buf, s) === "HybridControl");
const start = starts[hybIdx];
const nextStart = hybIdx + 1 < starts.length ? starts[hybIdx + 1] : buf.length;
// post-END_VAR body start (multi-VAR-block aware), same as decoder
let pos = start;
for (;;) {
  const idx = buf.indexOf("END_VAR", pos, "latin1");
  if (idx === -1 || idx >= nextStart) break;
  const after = idx + 7;
  const tail = buf.toString("latin1", after, Math.min(after + 16, nextStart)).replace(/^[\r\n]+/, "");
  if (tail.startsWith("VAR")) { pos = after; continue; }
  pos = after; break;
}
const bodyStart = pos;
console.log("\n=== HybridControl binary body range: " + bodyStart + " .. " + nextStart + " (len " + (nextStart - bodyStart) + ") ===");

// Generic [tag][len][name] scanner (same as decoder)
const records = [];
let i = bodyStart;
while (i < nextStart - 2) {
  const len = buf[i + 1];
  if (len >= 1 && len <= 40 && i + 2 + len <= nextStart) {
    let ok = true;
    for (let k = i + 2; k < i + 2 + len; k++) if (!(buf[k] >= 32 && buf[k] < 127)) { ok = false; break; }
    if (ok) { records.push({ off: i, tag: buf[i], name: buf.toString("ascii", i + 2, i + 2 + len) }); i += 2 + len; continue; }
  }
  i++;
}

// Attachment grammar parser: gap bytes between records are structure.
// 0x40 = last child of current list (terminator). Depth-first serialization.
const LD_OPEN_SERIES = 0x09, LD_OPEN_PARALLEL = 0x0a, LD_CONTACT = 0x0b;
const LAST_CHILD = 0x40, NEG = 0x80;
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

// Also look for the trailing output/pin-reference structure the attachment
// claims: [01 00] or [02 00] then a tag byte (0/2/3) after a record's name.
function trailingPinRef(off, lim) {
  // off is just past the [tag][len][name] record. Look for 01 00 / 02 00 then a low tag.
  const w = Math.min(off + 8, lim);
  for (let p = off; p < w - 2; p++) {
    const lead = buf[p];
    if (lead === 0x01 || lead === 0x02) {
      if (buf[p + 1] === 0x00) {
        const t = buf[p + 2];
        if (t === 0x00 || t === 0x02 || t === 0x03) return { off: p, lead, tag: t };
      }
    }
  }
  return null;
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
    current = { n: networks.length + 1, elems: [], tree: { type: "AND", children: [] }, treeOk: true, raw: [] };
    networks.push(current);
    gap = markerPos !== -1 ? buf.subarray(markerPos + 2, rec.off) : Buffer.alloc(0);
    fresh = true;
  } else {
    gap = buf.subarray(lastEnd, rec.off);
  }
  const base = rec.tag & ~(NEG | LAST_CHILD);
  const isContact = base === LD_CONTACT;
  const isFb = (rec.tag & ~LAST_CHILD) === 0x05;
  if (isContact || isFb) {
    if (!fresh && !prevWasContact) gap = Buffer.alloc(0);
    const opens = [];
    for (const g of gap) {
      const type = (g & ~LAST_CHILD) === LD_OPEN_SERIES ? "AND" : (g & ~LAST_CHILD) === LD_OPEN_PARALLEL ? "OR" : null;
      if (type === null) { current.treeOk = false; continue; }
      const node = { type, children: [], last: (g & LAST_CHILD) !== 0 };
      opens.push({ g, type, last: node.last });
      current.tree.pushRaw = current.tree.pushRaw || [];
      // place node under the top of a simple stack we track on current
    }
    // push opens in order onto the tree
    let leaf;
    let consumedEnd = rec.off + 2 + rec.name.length;
    if (isContact) {
      leaf = { name: rec.name, negated: (rec.tag & NEG) !== 0, last: (rec.tag & LAST_CHILD) !== 0 };
    } else {
      let pt = null, fbType = null;
      const nextRec = records[ri + 1];
      if (nextRec && nextRec.tag === 0x41 && nextRec.off - consumedEnd <= 4) {
        pt = nextRec.name; consumedEnd = nextRec.off + 2 + nextRec.name.length; consumedByFb.add(ri + 1);
        fbType = readPascalTypeName(consumedEnd, nextStart);
        if (fbType) { const te = consumedEnd + 1 + fbType.length; if (buf.subarray(te, te + 8)[0] === 1) consumedEnd = te + 8; }
      } else if (nextRec && nextRec.tag === 0x40 && nextRec.off - consumedEnd <= 4) {
        fbType = nextRec.name; consumedEnd = nextRec.off + 2 + nextRec.name.length; consumedByFb.add(ri + 1);
      }
      leaf = { name: rec.name, fb: true, fbType, pt, last: (rec.tag & LAST_CHILD) !== 0 };
    }
    // check for trailing pin-ref structure (attachment's coil/IN field)
    const pinRef = trailingPinRef(consumedEnd, nextStart);
    let pinStr = "";
    if (pinRef) { pinStr = " [pinref lead=0x" + pinRef.lead.toString(16) + " tag=" + pinRef.tag + "]"; }
    // store the opening chain bytes for reporting
    const gapHex = Array.from(gap, (g) => "0x" + g.toString(16).padStart(2, "0")).join(" ");
    current.raw.push({ gapHex, recHex: "0x" + rec.tag.toString(16).padStart(2, "0"), name: rec.name, fb: !!leaf.fb, fbType: leaf.fbType, pt: leaf.pt, negated: leaf.negated, last: leaf.last, pinStr });
    current.elems.push(leaf);
    lastEnd = consumedEnd;
    prevWasContact = true;
  } else {
    lastEnd = rec.off + 2 + rec.name.length;
    prevWasContact = false;
  }
}

// Print each network's raw [gap][tag][name] sequence + interpreted structure
console.log("\n=== Attachment-grammar dump (per network) ===");
for (const net of networks) {
  console.log("NET " + net.n + ":");
  for (const r of net.raw) {
    console.log("   [" + (r.gapHex || "(none)") + "] " + r.recHex + " " + r.name + (r.negated ? " (NC)" : "") + (r.last ? " (last)" : "") + (r.fb ? " FB:" + (r.fbType || "?") : "") + (r.pt ? " PT=" + r.pt : "") + r.pinStr);
  }
}

console.log("\n=== Current decoder's rendering (for comparison) ===");
console.log(hyb.text);
