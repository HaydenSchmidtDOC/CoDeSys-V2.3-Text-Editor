// Dump the raw bytes of every LD POU body, showing the exact byte layout
// between/after records, so the encoder can reproduce it byte-for-byte.
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
for (const name of LD_NAMES) {
  const idx = starts.findIndex((s) => pouNameAt(buf, s) === name);
  if (idx === -1) { console.log(name + ": NOT FOUND"); continue; }
  const start = starts[idx];
  const nextStart = idx + 1 < starts.length ? starts[idx + 1] : buf.length;
  // post-END_VAR body start
  let pos = start;
  for (;;) {
    const e = buf.indexOf("END_VAR", pos, "latin1");
    if (e === -1 || e >= nextStart) break;
    const after = e + 7;
    const tail = buf.toString("latin1", after, Math.min(after + 16, nextStart)).replace(/^[\r\n]+/, "");
    if (tail.startsWith("VAR")) { pos = after; continue; }
    pos = after; break;
  }
  const bodyStart = pos;
  console.log("\n========== " + name + " body " + bodyStart + ".." + nextStart + " (len " + (nextStart - bodyStart) + ") ==========");
  // Print the whole body as hex, 16 bytes per line, with ASCII gutter
  for (let o = bodyStart; o < nextStart; o += 16) {
    const end = Math.min(o + 16, nextStart);
    const hex = Array.from(buf.subarray(o, end), (b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = Array.from(buf.subarray(o, end), (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("");
    console.log((o - bodyStart).toString().padStart(5) + "  " + hex.padEnd(47) + "  " + ascii);
  }
}