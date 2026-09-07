# CoDeSys V2.3 Text Editor for VS Code

A VS Code custom editor + reverse-engineering toolkit for reading CoDeSys V2.3 / Beckhoff TwinCat `.pro` binary project files directly, without needing a manual TwinCat export.

## Background

TwinCat PLC Control (CoDeSys V2.3) project files (`.pro`) are a proprietary binary format. Opening one in a plain text editor shows NULs — the source isn't stored as a simple text blob. This project reverse-engineers enough of that format to decode Structured Text (ST) POUs directly from the binary, and documents ongoing work on decoding Ladder Diagram (LD) networks.

## Contents

- **`pro-viewer-extension/`** — A VS Code extension (`codesys-v2-text-editor`) that registers itself as the default editor for `*.pro` files and renders a decoded, read-only view of every POU in the project. Install via `code --install-extension pro-viewer-extension/codesys-v2-text-editor-0.0.1.vsix`.
- **`_extracted_pous/`** — Decoded POU source, extracted from a real `.pro` binary, one file per POU. Structured Text (ST) POUs decode cleanly and were validated byte-for-byte against a manual CoDeSys export. Ladder Diagram (LD) POUs (`CanopyControl`, `ControlledBuffer`, `HybridControl`, `GlobalFlags`, `Intrusion`, `RearTrack`) are **not yet reliably decoded** — see caveats below.
- **`_scratch/`** — Python analysis scripts used to reverse-engineer the binary format (printable-run scanning, POU boundary detection, and byte-level correlation against a known-good `.EXP` export).

## Status / caveats

- **ST decoding: validated.** The `[0x08][0xFF][flag][length][name]` inline-symbol pattern and POU boundary detection were confirmed against a real CoDeSys text export.
- **LD (ladder logic) decoding: in progress, not yet trustworthy.** Most contact/output references use a compact encoding (not the full inline-name form) that hasn't been fully cracked — CoDeSys appears to intern identifiers per-POU rather than repeating full names. A partial flag-bit hypothesis (base tag `0x0B`, `+0x40` for non-first operand, `+0x80` for negation, `0x09`/`0x0A` as possible AND/OR operator tags) is documented in `_scratch/correlate2.py` and `_scratch/index_hybrid2.py` but needs more validation before being trusted for safety-critical logic.
- **No write support.** The extension is read-only. Writing back to the binary format has not been attempted — a wrong write could corrupt a live PLC project.

## Do not treat decoded ladder logic as authoritative

Given this drives real physical equipment (airport baggage handling conveyors/doors), do not rely on the current LD decode output to make changes to a live system. Cross-check against a real TwinCat export before acting on anything ladder-logic-related.
