# CoDeSys V2.3 Text Editor for VS Code

A VS Code custom editor + reverse-engineering toolkit for reading and editing CoDeSys V2.3 / Beckhoff TwinCat `.pro` binary project files directly, without needing a manual TwinCat export.

## Background

TwinCat PLC Control (CoDeSys V2.3) project files (`.pro`) are a proprietary binary format. Opening one in a plain text editor shows NULs — the source isn't stored as a simple text blob. This project reverse-engineers enough of that format to decode and edit Structured Text (ST) POUs directly from the binary, and best-effort decodes Ladder Diagram (LD) networks (still read-only).

## Contents

- **`pro-viewer-extension/`** — A VS Code extension (`codesys-v2-text-editor`) that registers itself as the default editor for `*.pro` files, decodes every POU, and lets you edit + save the ones it's confident about. Install via `code --install-extension pro-viewer-extension/codesys-v2-text-editor-0.0.1.vsix`. Self-check: `node pro-viewer-extension/test_decoder.js`.
- **`_extracted_pous/`** — A one-off snapshot of decoded POU source extracted early in this project (via the extension's export command). It's just prior output, not a ground truth — the real ground truth used to validate everything below is a manual TwinCat "Export" (`.EXP` text file) of the real project, kept locally alongside the `.pro` and gitignored (not part of this repo).
- **`_scratch/`** — Python/Node scripts used to reverse-engineer the binary format: printable-run scanning, POU boundary detection, and byte-level correlation against `.EXP` exports (including a controlled before/after edit — see below).

## Status

### Structured Text (ST) POUs — decode + edit + save

- **Decode: validated.** Each POU's declarations + implementation are a contiguous run of printable ASCII/CRLF text in the binary, framed by non-printable bytes. Confirmed byte-for-byte against a real CoDeSys export.
- **Two known artifacts, both handled correctly (not just papered over):**
  - A trailing forward-link to the *next* POU's name sometimes gets swept into the scanned range — detected and trimmed at a safe syntactic boundary (after the last `;`/`END_IF`/etc. before it).
  - A single non-printable framing byte is sometimes dropped between a POU's `END_VAR` and whatever follows on the same line (commonly `END_VAR(*comment*)`) — the missing CRLF is reinserted to recover the real formatting.
- **Write support: variable-length.** An edit no longer has to keep the POU's byte length identical. Saving finds the common prefix/suffix between the old and new text (anchored to real source byte positions, tracked per-character through both artifact-repairs above) and replaces only the differing middle span, shifting everything after it in the file. This was validated against a real controlled test: renaming a variable (`InterfaceBagReleaseAct` → `...withaddedbytes`, +14 bytes) round-trips exactly and leaves every other POU byte-for-byte unaffected.
  - **Why this is believed safe:** a systematic search of the real `.pro` file found no absolute byte-offset table anywhere referencing POU text locations (POU "directory" entries only carry a name + timestamps), and no whole-file checksum. That's evidence, not proof — every save is still verified by re-decoding the whole file afterwards and refusing to write if the edited POU doesn't decode back to exactly what was typed, or if *any other* POU's decoded text changed as a side effect.
  - A lightweight (not a real parser) syntax check runs before every save — balances `VAR`/`END_VAR`, `IF`/`END_IF`, `CASE`/`END_CASE`, `FOR`/`END_FOR`, `WHILE`/`END_WHILE`, `REPEAT`/`END_REPEAT`, and parens/brackets — to catch obvious slips (a deleted `END_IF`, a stray paren) before they reach disk. It is not a substitute for a Rebuild in TwinCat.
  - Of the real project's 27 POUs, 21 currently qualify as editable; the other 6 are the Ladder Diagram POUs below.

### Ladder Diagram (LD) POUs — decode only, always read-only

LD POUs (`CanopyControl`, `ControlledBuffer`, `GlobalFlags`, `HybridControl`, `Intrusion`, `RearTrack`) use a different encoding: every contact/coil/FB-instance/time-literal reference is stored inline as a `[tag byte][length byte][ASCII name]` micro-record, repeated at (almost) every use site.

**Confirmed, used by the decoder:**
- Tag byte reliably identifies the record class: CONTACT (`0x0B` base), OUTPUT (`0x00`=POSITIV/NO_SET, `0x02`=POSITIV/SET, `0x03`=NEGATIV/SET), FB-instance name (`0x05`/`0x45`), time literal (`0x41`). Zero contradictions across all 6 POUs.
- `0x80` on a CONTACT tag = negated. Zero contradictions across 155 aligned contacts.
- Network boundaries are marked by an `08 FF` byte pair somewhere in a small lookback window before a network's first record (the gap varies 0–3 filler bytes — it's not always adjacent, which broke the network split for `HybridControl` until fixed and validated against a real TwinCat screenshot).
- **AND/OR grouping is a real nested tree — cracked via a long series of controlled A/B edits.** A single "network combinator" byte was the first, too-simple theory (validated only for a 2-contact network flipped `OR → AND` in TwinCat). A second edit (a 6-contact network regrouped) falsified it: the header byte stayed constant while real internal structure changed. The actual grammar, found by re-framing the problem as rail *splits and joins* rather than "one combinator per network": between two contact records, any stray byte the old scanner silently skipped over **opens a new bracketed group** — `0x09` = AND-group, `0x0A` = OR-group. A contact's own tag byte can carry `0x40`, which **closes the innermost open group**, that contact being its last member. A group left open when the network's last contact is reached needs no explicit close (it auto-closes). This is a simple stack machine, and it was validated against a large batch of real edits: swapping which variable sits in which branch, moving whole groups' positions, and building networks with 2-way/3-way/4-way and nested splits — every one reconstructs into exactly the expression the edit was known to produce.
  - `0x40` also sometimes appears standalone on a group-*open* byte (`0x0A→0x4A`, `0x09→0x49`). Several theories for what this extra bit means were tried and falsified (first vs. later sibling group, group content/identity) - current best guess is it marks the "rightmost spine" of the tree (an open whose eventual close chains straight through to the network's end with no further opens in between), which looks like a redundant/derivable serialization artifact rather than fresh logical content. The decoder does **not** rely on it — only the low nibble of an open byte (AND vs. OR) is used to build the tree.
  - Re-run against every network in every LD POU across the full test corpus (7 real `.pro` files, ~140 networks): zero networks fall back to the flat "MIXED, unresolved" rendering now. One caveat flagged by a second, independent read of the same data (not yet resolved): in one network, a variable that should likely be a coil/output decodes with a plain contact tag — suggesting coils may not always be distinguishable by tag byte alone. Treat any single decoded network with healthy skepticism until cross-checked.
- **Timer/FB-instance calls (TON/TOF/R_TRIG/...) decode too, not just their names.** An FB-instance record (tag `0x05` non-terminal / `0x45` terminal) participates in the exact same AND/OR open/close grammar as a contact — confirmed against `ControlledBuffer`/`HybridControl`'s real `RunToRearTimer`/`RunRelJamTimer`/`RunToReleaseTimer` timers, byte-for-byte against a TwinCAT export. Its PT operand (if any) is the next record (tag `0x41`); the FB's type name follows as a bare, tag-less length-prefixed string when a PT is present (e.g. `03 54 4f 4e` = `"TON"`), or as an ordinary tagged (`0x40`) record when there's no operand (e.g. `R_TRIG`). A fixed 8-byte trailer (`01 00 00 00 00 00 00 00`) follows a timer's type name — it must be skipped precisely, since the very next gap byte can legitimately open a *nested* AND/OR group (confirmed against `HybridControl` NETWORK 16's cascade, `RunRelJamTimer OR (InductPE1 AND RunToReleaseTimer)` — treating the trailer as a garbage "open" byte silently flattened this into a wrong 3-way OR before the fix). Cross-checked against every FB call site (24) in every one of the 7 corpus `.pro`/`.exp` pairs: exact match on instance name, type, and PT.
- LD POUs remain **always read-only** regardless of how cleanly they decode — write-back for ladder logic hasn't been implemented.

**Do not treat decoded ladder logic as authoritative.** This drives real physical equipment (airport baggage handling conveyors/doors). Cross-check any rendered ladder logic against a real TwinCat export before acting on it or changing a live system.

## Known gaps

- **LD write-back.** Decode-only; even confidently-decoded nested AND/OR trees can't be edited and saved yet.
- **Coil vs. contact tag ambiguity.** At least one real network has what should likely be a coil/output decoding as a plain contact tag — needs investigation before trusting output identification everywhere.
- **No POU add/delete/rename**, and only the 6 POUs named in the code are treated as LD — a different project file could have LD/FBD POUs under other names that would be mis-decoded as ST.
- **No live TwinCat 2 open/save test yet.** Everything above is validated by re-decoding our own output, not by confirming TwinCat 2 actually opens a file we've written. Do this before trusting a saved file on a live system.
