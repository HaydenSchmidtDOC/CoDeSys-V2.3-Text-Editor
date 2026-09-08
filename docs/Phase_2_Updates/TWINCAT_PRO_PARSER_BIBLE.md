# TwinCAT 2 / CoDeSys V2.3 `.pro` — Parser Bible

**Consolidated master reference.** Supersedes spec v1, v2 and v3.

**Corpus:** `101079 BSL.pro` (406,636 B) · `101079 BSL.BAK` (406,608 B) · `COMlibV2.lib` (101,472 B) · `EXPORT.EXP` · `.tpy` · `.ci` · `.ri` · `.SYM` · `DEFAULT.DFR` · GVL exports · UI screenshots

**Validation status of this document:**

| Check | Result |
|---|---|
| Declarations byte-exact vs `EXPORT.EXP` | **27 / 27** |
| Structured-text bodies byte-exact vs `EXPORT.EXP` | **21 / 21** |
| Ladder network counts vs independent `08 FF` marker count | **6 / 6** |
| Object IDs matching between directory table and object store | **35 / 35** |
| **Ladder networks structurally walked** | **58 / 58, both files** |
| **Ladder bodies landing exactly on next object header** | **6 / 6, both files** |
| **Ladder bodies re-encoded byte-exact** | **6 / 6, both files** |
| Invariant checks passing on `.pro` | **122 / 122** |
| Invariant checks passing on `.BAK` (independent specimen) | **122 / 122** |
| No-op span reassembly (incl. ladder) | **byte-exact, both files** |
| Library decrypt → re-encrypt | **byte-exact** |

| **Ladder tree geometry vs. CoDeSys editor** | **6 / 6 rungs exact** |

> **Status change:** the ladder-extent problem — the last open blocker, flagged in every prior revision — is **SOLVED**, and the tree geometry is now confirmed against the CoDeSys ladder editor. See §6.4.

Confidence marks used throughout: **V** = verified against ≥2 independent sources · **D** = consistent across all instances, one source · **U** = unconfirmed, preserve bytes verbatim.

---

## 0. The seven rules

Everything else in this document is detail. These are the rules that, if broken, corrupt data.

| # | Rule |
|---|---|
| 1 | **Anchor on the MARK, and the MARK is a *maximal* run.** Match `(02 00){8,}` and read the length `u32` at the run's **end**. Nine objects in this file have runs longer than 8 pairs. |
| 2 | **Never anchor on keywords.** `PhysicalMapping`'s declaration begins with CRLF *before* `PROGRAM`. Keyword anchoring computes a length of 168,624,128. |
| 3 | **All lengths are `u32` little-endian.** Not `u16`. `SecurityDoor`'s body is 25,457 bytes. |
| 4 | **The `0x1B` field is a network COUNT, not a byte length.** Ladder bodies have no byte-length field anywhere — the extent must be derived by walking every element (§6.4). |
| 5 | **Join objects on `objectId`, never on name.** `TestGUI`/`TESTGUI` differ in case; `BagData` exists twice (POU 677, GVL 678). |
| 6 | **Patch BOTH length fields on every edit.** Declaration `u32` *and* body `u32`. Patching only one shifts the body tag out of alignment and destroys the body silently. |
| 7 | **Every byte belongs to exactly one span; copy unparsed spans verbatim.** Verify by no-op reassembly before any edit. |

---

## 1. Container header

| Offset | Size | Field | Value in corpus | Conf |
|---|---|---|---|---|
| 0 | 8 | Magic | `43 6f 44 65 53 79 73 2b` = `CoDeSys+` | **V** |
| 8 | 1 | Kind | `.pro` = `01`, `.lib` = `0f` | **D** |
| 9 or 13 | 4 | Constant | `17 8c 00 00` (`.lib` @9, `.pro` @13) | **D** |
| ~57 | — | Version | tag `01`, `u32` len 8, ASCII `2.3.9.50` | **V** |
| 198 | 4 | Path length `u32` | 304 (`.pro`), 277 (`.BAK`) | **V** |
| 202 | var | Absolute path to `COMlibV2.lib` + `00 40` + padding | see §11 | **V** |
| last 4 | 4 | Trailer | `c4 9b 8b 5a` — **not a checksum** (§12) | **V** |

`DEFAULT.DFR` uses `25 8c 00 00` at offset 0 — same serialiser family, different version word. **D**

All integers are **little-endian**. All strings are **length-prefixed, never NUL-terminated** (a `00` often follows but is not a terminator).

---

## 2. The MARK — universal string anchor

Every named string in the object store uses one encoding:

```
(02 00) repeated N times, N >= 8      <- MAXIMAL run
<length : u32>
<bytes : length>                       <- latin-1, NOT NUL-terminated
```

### Why the run must be maximal

The last 8 bytes of each object's middle region are opaque padding (§4). In 9 objects that padding contains `02 00` pairs, extending the run. Anchoring at the run *start* reads the length from the wrong offset.

| Run length (pairs) | Count | Meaning | Conf |
|---|---|---|---|
| 8 | 74 | Normal | **V** |
| 9 | 7 | Padding contributed 1 pair | **V** |
| 12 | 1 | `PhysicalMapping` | **V** |
| 16 | 1 | File header, not an object | **V** |

Collision offsets: 288594, 292444, 295632, 302638, 303732, 311337, 352655, 353463 (+ header at 93).

Correct regex: `(?:\x02\x00){8,}` — read `u32` at `match.end()`.

| Metric | `.pro` | decrypted `.lib` | Conf |
|---|---|---|---|
| MARK occurrences | 84 | 108 | **V** |
| Largest string | 25,457 B | — | **V** |

---

## 3. Object header

Layout, relative to the **nominal** MARK start (= `mark_end − 16`):

| Offset | Size | Field | Conf |
|---|---|---|---|
| −16 | 1 | **Type tag** | **V** |
| −15 | 1 | Constant `0x08` | **V** |
| −14 | 4 | **`objectId : u32`** — join key to directory | **V** |
| −10 | 2 | `classWord` — `0x002C` project, `0x0000` library | **D** |
| −8 | 8 | Editor state (scroll/window) | **U** |
| 0 | 16 | MARK run | **V** |
| +16 | 4 | Name length `u32` | **V** |
| +20 | n | Name | **V** |

### Type tags

| Value | Kind | `.pro` count | `.lib` count | Conf |
|---|---|---|---|---|
| `0x07` | POU (PROGRAM / FUNCTION / FUNCTION_BLOCK) | 27 | 23 | **V** |
| `0x00` | GVL / resource object | 8 | 2 | **V** |
| `0x01` | Visualization | 2 | 0 | **D** |
| `0x0B` | Data type (`TYPE…END_TYPE`) | 0 | 28 | **V** |

Cross-check: in the library, tag `0x07` appears 23 times against exactly 19 `FUNCTION_BLOCK` + 4 `FUNCTION` keywords; tag `0x0B` appears 28 times against exactly 28 `TYPE` keywords.

---

## 4. Middle region — exactly 25 bytes

Between the name string and the declaration MARK.

| Offset | Size | Field | Conf |
|---|---|---|---|
| 0 | 1 | Constant `00` | **V** |
| 1 | 1 | Tag `08` | **V** |
| 2 | 4 | `timestamp1 : u32` — **Unix epoch seconds, UTC** | **V** |
| 6 | 1 | Tag `09` | **V** |
| 7 | 4 | `timestamp2 : u32` | **V** |
| 11 | 4 | `objectId : u32` — **populated for resource objects, ZERO for POUs** | **V** |
| 15 | 2 | Constant `00 00` | **V** |
| 17 | 8 | **Opaque persistent field** — copy verbatim | **V** |

### Timestamps are Unix epoch, UTC

| Value | Decodes to | Corroboration |
|---|---|---|
| `0x6A8BB7AE` (`.pro`) | 2026-08-24 03:17:02 UTC | `.tpy` `ChangeDate` = 2026-08-24T15:17:02 local (+12 NZ) |
| `0x6975ED00` (`.BAK`) | 2026-01-25 10:14:24 UTC | `.ci` internal stamp = +1 second |

### On bytes [17:25]

They contain readable stale fragments — `ModbusWatchdog`, `ProcessDoorGUI` and `SecurityDoor` all carry `"teroct S"`; `Config_DecodeString` and `TwinSafe` carry `"s e fat "`. They look like uninitialised heap.

**They are not.** They are byte-identical between `.pro` and `.BAK`, two saves seven months apart by different CoDeSys builds. They are persistent data written once from a reused buffer. **Copy them; never regenerate, never "clean", never diff-assert on them.**

> **Parser note:** when a maximal MARK run absorbs padding, the middle region measured to the run *start* is short by 2 bytes per absorbed pair. Measure to the **nominal** mark start (`mark_end − 16`) to always get 25.

---

## 5. Declaration

```
<MARK> <declLen : u32> <declaration text>
```

| Property | Value | Conf |
|---|---|---|
| Length field | `u32` LE | **V** |
| Content | Header line + all `VAR…END_VAR` blocks | **V** |
| Terminator | None — length is authoritative | **V** |
| May begin with CRLF | Yes (`PhysicalMapping`) | **V** |
| May end with CRLF | Yes (`MAIN`, `RearTrack`) | **V** |

The `.pro` is **more faithful than the EXP**: EXP normalises edge CRLF away. Use EXP as a read-only oracle only; never round-trip through it.

The EXP boundary marker `(* @END_DECLARATION := '0' *)` does not exist in the `.pro`. Its 35-byte footprint (CRLF + 29 chars + CRLF + CRLF) exactly explains the size delta on all 21 text POUs.

---

## 6. Body

The byte immediately after the declaration selects the encoding.

| Tag | Encoding | Count | Follows with | Conf |
|---|---|---|---|---|
| `0x12` | Structured Text / IL | 21 | `<byteLen : u32>` then text | **V** |
| `0x1B` | Ladder Diagram | 6 | `<networkCount : u32>` + 3 bytes, then networks | **V** |

### 6.1 Text bodies

```
12 <byteLen : u32> <text>
```

Field is `u32`. Writing only 2 bytes leaves the high half stale.

### 6.2 Ladder bodies — the count, not a length

```
1B <networkCount : u32> 00 00 00 <networks…>
```

| POU | `u32` value | `08 FF` markers counted | Match |
|---|---|---|---|
| CanopyControl | 2 | 2 | ✔ |
| ControlledBuffer | 13 | 13 | ✔ |
| GlobalFlags | 7 | 7 | ✔ |
| HybridControl | 20 | 20 | ✔ |
| Intrusion | 10 | 10 | ✔ |
| RearTrack | 6 | 6 | ✔ |

**There is no byte-length field for ladder bodies anywhere in the format.** The extent must be derived structurally by walking every element — see §6.4, which solves this.

### 6.3 Ladder element grammar

Serialization is depth-first: open a block, emit children in order, the child carrying `0x40` closes it.

| Byte | Meaning | Conf |
|---|---|---|
| `08 FF` | Network boundary marker | **V** |
| `0x09` | Open **series** (AND) block | **V** |
| `0x0A` | Open **parallel** (OR) block | **V** |
| `0x0B` | Contact / element referencing following symbol | **V** |
| `+0x40` (`49`,`4A`,`4B`) | **Last child** — terminates current block | **V** |
| `+0x80` (`8B`) | **Negated** contact (`|/|`) | **V** |
| `0x05` / `0x45` | FB instance name (`0x45` = terminal) | **V** |
| `0x41` | PT literal (e.g. `T#6000ms`) | **V** |
| `03 54 4F 4E` | Pascal string `"TON"` — length 3 + `TON`, **not** structure bytes | **V** |
| `01 00 00 00 00 00 00 00` | 8-byte FB trailer (timers) | **D** |
| 6 zero bytes | FB trailer (R_TRIG / F_TRIG) | **D** |
| `0x00` / `0x02` / `0x03` | Coil: DIRECT / SET / RESET | **D** |
| `<count u16>` + entries | Trailing reference list (coil or FB `IN` source) | **V** |

**Function block template:**

```
[gap] 0B  <contact chain driving IN>
[gap] 05  <FB instance name>          (0x45 when terminal)
[00]  41  <PT literal>
03 54 4F 4E                            <- type name, Pascal string
01 00 00 00 00 00 00 00                <- 8-byte trailer
<01 00> <tag 3> <IN source symbol>     <- 1-entry reference list
```

The instance name is serialised **before** the type name — the reverse of how it renders (instance label above the box, `TON` inside).

**Rung comments** are stored as one flat string trailing the *previous* network, behind a `4B 00 00 00` header. A naive tag-splitter shreds them: `[4b 00 00 00 54 69 6d 65] tag=72` is not a tag — `0x72` is the letter `r`, and `54 69 6d 65` is `"Time"`. Reassembled: *"Timer to allow run to release past PE, or timeout in case of releasing jam."*

**Semantic validation:** every symbol in every decoded network resolves to exactly one GVL (§8). Zero unresolved. Physical I/O → `Hardware`; logical coils (`L_*`) → `Global_Variables`.

### 6.4 The element walker — ladder extent SOLVED

Walking the element stream yields the body's true end. Implemented in `ldwalk.py`; proven against a hard oracle.

#### Body grammar

```
BODY     := NETWORK × nnet  FOOTER(20 bytes)
NETWORK  := 08 FF  TREE  <outCount:u16>  OUTPUT × outCount  [COMMENT]
TREE     := depth-first element stream (see stack rule below)
ELEMENT  := <tag:u8> <len:u8> <name>
COMMENT  := <len:u32> <text> 00          -- present on all but the LAST network
FOOTER   := 64 00 00 00 04 00 00 00 + 12 zero bytes   (constant, 20 bytes)
```

| Field | Finding | Conf |
|---|---|---|
| **Names are `<len:u8>` prefixed** | Not `u32`, unlike every other string in the format | **V** |
| **The inter-network gap is a COMMENT, not padding** | `<len:u32><text><00>`. An empty comment is `00 00 00 00 00` — which is why it looked like a fixed 5-byte pad | **V** |
| Comment attaches to the **following** network | `"Conveyor Control"` stored after NET 1 renders atop rung 0002 | **V** |
| Last network has **no** comment field | Footer follows the final output directly | **V** |
| Footer is a 20-byte constant | Byte-identical across all 6 POUs in both `.pro` and `.BAK` | **V** |
| Comments found in corpus | 8 | **V** |

#### The block-stack rule

This is what makes the tree self-delimiting:

1. `0x09` (series) / `0x0A` (parallel) are **openers** — they carry no name and push onto a stack, recording their own `+0x40` flag.
2. Leaf elements (`0x0B` contact, `0x05` FB) carry `<len:u8><name>`.
3. An element with `+0x40` **closes** its block: pop the stack, and **keep popping while the popped opener itself carried `+0x40`** (cascading close).
4. When the stack empties, the tree is complete → the `u16` output count follows.
5. **Special case:** if the first token is a leaf rather than an opener, the tree is a single element and ends immediately (e.g. `CanopyControl` NET 1).

#### Function-block records

```
<05|45> <len:u8> <name> <pinByte> [41 <len:u8> <literal>] <len:u8> <typeName> <trailer>
```

| Type | Trailer | Conf |
|---|---|---|
| `TON`, `TOF`, `TP` | 8 bytes (`01 00 00 00 00 00 00 00`) | **V** |
| `R_TRIG`, `F_TRIG` | 6 bytes | **V** |

The instance name serialises **before** the type name — the reverse of how it renders. `<len:u8> <typeName>` is a bare Pascal string with no tag byte, so `03 54 4F 4E` is `3,"TON"`, not structure bytes.

#### Validation — the oracle

Three independent conditions had to hold simultaneously, and did:

| Condition | `.pro` | `.BAK` |
|---|---|---|
| Networks walked == `nnet` from the `0x1B` field | **58 / 58** | **58 / 58** |
| Derived body end == next object header offset | **6 / 6** | **6 / 6** |
| `encode_body(walk(body))` == original bytes | **6 / 6** | **6 / 6** |

A wrong grammar cannot satisfy these together — any mis-sized element desynchronises the stream and the walk either throws or lands off the header.

**Semantic cross-check.** Rendered output matches the UI screenshots for element content, order, negation, FB type, PT literal and coil mode: `HybridControl` NET 2 (`AgentActive·AgentHealthy·FwdPB·(InductForward∥HoopIntrusion)` → `L_ScaleForward`), NET 13 (`BRRunToPE → RunToRearTimer:TON PT:=T#6000ms`), NET 16 (cascaded `RunRelJamTimer` T#4000ms / `RunToReleaseTimer` T#1000ms), NET 18, NET 19. **102 distinct ladder symbols** extracted, all resolving to a GVL (§8).

#### Coil modes

| Tag | Mode | Conf |
|---|---|---|
| `0x00` | DIRECT | **V** |
| `0x02` | SET | **V** |
| `0x03` | RESET | **V** |

#### Editing ladder

Round-tripping is now proven, so ladder is **structurally** editable: walk → modify the element list → `encode_body` → splice, patching the `0x1B` network count if the count changed.

**One caution:** preserve `el.raw`. Re-emitting the original tag byte is what guarantees byte-exactness; reconstructing tags from semantic flags is not yet proven.

#### Tree geometry — confirmed against the CoDeSys editor

`build_tree()` / `render_expr()` rebuild the nested block structure using the same stack semantics as the walker. All six `HybridControl` rungs visible in the editor match the decode exactly (`.` = series, `||` = parallel):

| Rung | Decoded expression | Drawing |
|---|---|---|
| 0001 | `(AgentMode \|\| ForceAgentMode)` | AgentMode with ForceAgentMode branched beneath | ✔ |
| 0002 | `AgentActive . AgentHealthy . FwdPB . (InductForward \|\| HoopIntrusion)` | HoopIntrusion branched under InductForward | ✔ |
| 0003 | `AgentActive . AgentHealthy . RevPB . ScalePE2` | plain series, no branch | ✔ |
| 0004 | `AgentActive . AgentHealthy . (((FwdPB \|\| BRRunToPE) . InductPE1) \|\| BRRunRel)` | BRRunToPE narrow under FwdPB; BRRunRel spanning both columns | ✔ |
| 0005 | `AgentActive . AgentHealthy . RevPB . (ScaleReverse \|\| HoopIntrusion)` | HoopIntrusion branched under ScaleReverse | ✔ |
| 0006 | `AgentHealthy . ((BRRunRel . NOT Config_ExternalBufferEnabled) \|\| (BufferReleaseAct . Config_ExternalBufferEnabled))` | two-contact branch beneath | ✔ |

Rung 0004 is the strongest evidence: the walker independently derives a *three-level* nesting — an inner parallel inside a series inside an outer parallel — and the differing branch **widths** in the drawing (BRRunToPE spanning one column, BRRunRel spanning two) confirm exactly that shape. Rung 0001 confirms that a bare `0x0A` opener at network start is genuinely parallel.

---

## 7. Directory tree

Signature `01 00 01 00 <len:u32> "POUs"` occurs exactly once (offset 404,678).

### 7.1 Records

```
FOLDER : 01 00 01 00 <nameLen u32> <name> <childCount u16> <hasSub u16>
         then child-list header: 8 bytes if hasSub=1, else 10 bytes
         then children, each preceded by a separator:
             2 bytes (00 00)       before a POU
             4 bytes (00 00 00 00) before a folder

POU    : 01 00 <nameLen u32> <name> 00 00 <objectId u32> <linkFlags 12 bytes>
```

| linkFlags | Meaning | Conf |
|---|---|---|
| `ff ff ff ff` at [0:4] | **Last child of folder** | **V** |
| `01 00` at [4:6] | *Claimed* "next sibling is a folder" — **WRONG, see §7.3** | — |

### 7.2 Verified tree

| Folder | Offset | childCount | hasSub | Children |
|---|---|---|---|---|
| `POUs` (root) | 404,680 | 9 | 1 | 6 folders + MAIN, ModbusWatchdog, PhysicalMapping |
| `BackgroundTasks` | 404,704 | 2 | 0 | ReadConfigs, SerialCom |
| `BagdropModules` | 404,811 | 10 | 0 | CanopyControl … RearTrack |
| `JAL SBD` | 405,217 | 2 | 0 | BagData, Extract2ByteData |
| `Library` | 405,319 | 3 | 1 | Config_Libraries, ParseForColour, UPS_CX80xx |
| `Config_Libraries` | 405,346 | 4 | 0 | Config_AdvanceRegister … Config_DecodeString |
| `Optional` | 405,632 | 2 | 0 | TagToSerial, TwinSafe |
| `Security Door` | 405,731 | 2 | 1 | Internal, SecurityDoor |
| `Internal` | 405,764 | 1 | 0 | ProcessDoorGUI |
| `Data types` | 405,983 | 0 | 0 | (empty) |
| `Visualizations` | 406,017 | 2 | 0 | AUTODOOR, TestGUI |
| `Global Variables` | 406,120 | 7 | 0 | BagData, Configs, Global_Variables, Hardware, TwinCAT_Configuration, TwinCAT_Import, Variable_Configuration |

Four top-level trees serialised consecutively: POUs, Data types, Visualizations, Global Variables.

### 7.3 Two flag bytes are UI state, not structure

`.pro` and `.BAK` have **identical folder structure** yet differ at two flag bytes:

| Location | `.pro` | `.BAK` |
|---|---|---|
| `BackgroundTasks` child-list header byte 0 | `01` | `00` |
| `ProcessDoorGUI` linkFlags byte 6 | `00` | `01` |

Since structure is identical, these cannot encode structure — most plausibly folder expand/collapse. **Derive topology from `childCount`, separator widths and `ff ff ff ff` only.** Preserve the flag bytes; never assert on them.

### 7.4 Root names are locale-dependent

`.pro` roots: `POUs`, `Data types`, `Visualizations`, `Global Variables`.
`COMlibV2.lib` roots: **`Bausteine`, `Datentypen`, `Globale Variablen`** — the library was authored on a German installation.

Discover roots structurally; treat the name as a label.

---

## 8. Global variable lists

Standard MARK + `u32` encoding, type tag `0x00`.

| Object | ID | Content | First line | Conf |
|---|---|---|---|---|
| `Global_Variables` | 731 | 2,130 B, **61 declarations** | `VAR_GLOBAL` | **V** |
| `Hardware` | 1 | 4,554 B, **118 declarations** | `VAR_GLOBAL` | **V** |
| `Configs` | 737 | 951 B | `VAR_GLOBAL PERSISTENT` | **V** |
| `TwinCAT_Configuration` | 744 | 12,938 B | (VAR_CONFIG) | **D** |
| `TwinCAT_Import` | 735 | 62 B | `VAR_GLOBAL (* DO NOT CHANGE THIS SHEET MANUALLY! *)` | **V** |
| `BagData` | 678 | 305 B | `VAR_GLOBAL` | **V** |
| `Variable_Configuration` | 3 | 21 B | `VAR_CONFIG` | **V** |
| `Standard` | 0 | 43 B | watch/trace list, `cls=0x0000` | **D** |

### UI decorations are derived, not stored

The tree shows `Configs (PERSISTENT)`, `Variable_Configuration (VAR_CONFIG)`. These suffixes come **directly from the declaration keyword** in the object's own text. There is no flag byte to maintain. **V**

### Symbol resolution as a free correctness check

Every identifier in a parsed POU should resolve to: a GVL, a local `VAR` in that POU's own declaration, or the 136-entry library symbol index (§9.2). An unresolved identifier means a parse error.

---

## 9. Libraries

### 9.1 Library manager table (offset 386,346)

```
<libCount : u16>
[ <recLen : u32> "<name>.lib d.m.yy hh:mm:ss" 00 40 <timestamp : u32> ] × libCount
```

`recLen` = `len(name) + 6`. Verified arithmetically on all six.

| # | Reference | recLen | Check |
|---|---|---|---|
| 1 | `COMlibV2.lib 11.8.21 08:44:40` | 35 | 29+6 ✔ |
| 2 | `TcSystemCX80xx.lib 5.11.21 09:08:00` | 41 | 35+6 ✔ |
| 3 | `TcBase.lib 14.5.09 12:14:08` | 33 | 27+6 ✔ |
| 4 | `TcSystem.lib 7.6.16 11:01:22` | 34 | 28+6 ✔ |
| 5 | `TcUtilities.lib 3.2.16 16:08:58` | 37 | 31+6 ✔ |
| 6 | `STANDARD.LIB 5.6.98 12:03:02` | 34 | 28+6 ✔ |

Only **five** contribute global variables — `TcBase.lib` has none. `STANDARD.LIB`'s node is literally named `Global Variables 0` (space, trailing zero).

### 9.2 Library symbol index (~386,604)

```
[ <nameLen : u32> <name> 00 00 00 00 ] × N
```

**136 symbols.** Your linkage oracle: a library call must have its symbol here or the project won't resolve.

### 9.3 Library timestamps are replicated ~500 times

Each symbol-table entry back-references its source library's timestamp. Diff clusters align exactly with the section boundaries in §10:

| Range | Section | `.BAK` → `.pro` |
|---|---|---|
| 23,810–29,549 | TcSystemCX80xx | `f0 83` → `a0 3d` |
| 30,294–42,802 | TcBase | `90 9a` → `50 62` |
| 43,366–89,070 | TcSystem | `02 39` → `c2 00` |
| 90,104–236,707 | TcUtilities | `9a b5` → `4a 6f` |
| 237,018–242,283 | STANDARD.LIB | `74 97` → `24 51` |

**Never patch a library reference in the table alone** — it touches ~500 sites.

---

## 10. The symbol/interface cache (bytes 202 – 264,900)

65% of the file. A cached interface table for every library and every project POU.

```
<pathLen u32> <library absolute path> 00 40
then per POU:
  <UPPERCASE POU name>
  [ <len u32><member name> <type ref> <optional comment> ] …
```

| Range | Section | Conf |
|---|---|---|
| 202 – 23,423 | `COMlibV2.lib` (project-relative path) | **V** |
| 23,423 – 29,598 | `TcSystemCX80xx.lib` | **V** |
| 29,598 – 42,853 | `TcBase.lib` | **V** |
| 42,853 – 89,121 | `TcSystem.lib` | **V** |
| 89,121 – 236,756 | `TcUtilities.lib` | **V** |
| 236,756 – 242,424 | `STANDARD.LIB` | **V** |
| 242,424 – 264,041 | **Project POUs**, alphabetical | **V** |

**5,369 records, 2,259 distinct names. All 27/27 project POUs present as uppercase headers.**

Two independent confirmations came out of this region:

- **Ladder decode:** `CONTROLLEDBUFFER` lists `RunToRearTimer:TON`, `RunToReleaseTimer:TON`, `RunRelJamTimer:TON` — exactly the timers decoded from the ladder binary. `INTRUSION` lists `IntrusionFilter1:TON`, `IntrusionFilter2:TON`, `PEHit1:R_TRIG`, `PEHit2:R_TRIG`.
- **Library decode:** `COMlibV2.lib@_RECEIVESTRING` lists all 23 members in order, matching the decrypted `.lib` and the UI screenshot.

Member comments are preserved verbatim, making this a usable documentation source without decrypting anything.

> **Compiler-maintained. Do not write.** Excellent read-only material.

---

## 11. Task configuration (264,932 – 265,350)

**Different string encoding — `u8` length prefix, not MARK + `u32`.**

```
01 <flag u8> <nameLen u8> <taskName> <paramA u32> <paramB u32> …
01 00 <progLen u8> <programName> ff ff ff ff
```

| Task | Program | paramA | paramB | Flag | Conf |
|---|---|---|---|---|---|
| `Standard` | `MAIN` | 16 | — | `00` | **V** |
| `Configuration` | `ReadConfigs` | 10000 | 1 | `00` | **V** |
| `SerialCom` | `SerialCom` | 2 | 2 | **`01`** | **V** |

### The flag byte is confirmed to mean "disabled"

The `.ci` contains exactly two generated task wrappers — `_CALLTASKSTANDARD` and `_CALLTASKCONFIGURATION`. **There is no `_CALLTASKSERIALCOM`.** The compiler emitted no wrapper because the task is disabled. This corroborates the greyed-out rendering in the UI.

**Operational consequence: `SerialCom` does not execute on the PLC.**

`0x2710` = 10000 is plausibly a cycle time in µs, but the param semantics are **U** — do not write.

> **Do not edit the task configuration.** It controls scan order and cycle timing.

---

## 12. There is no checksum

`.pro` and `.BAK` contain **byte-identical source content** — all 27 declarations, all 21 text bodies, all 6 network counts, all 35 object IDs, identical folder structure. Every difference is metadata:

| # | Difference | Bytes | Cause |
|---|---|---|---|
| 1 | Version `2.3.9.50` → `2.3.9.59` | 1 | Different CoDeSys build |
| 2 | Embedded `COMlibV2.lib` path | 27 | Different user + release folder |
| 3 | Object timestamps (35 × 2) | ~280 | Save time |
| 4 | Library timestamps (~500 sites) | ~1000 | Library re-read |
| 5 | Two directory flag bytes | 2 | UI state (§7.3) |
| 6 | Trailer | 4 | Session value |

The 27-byte length change propagated through the entire file with **no compensating fixups anywhere** — no offset table, no length recomputation, no integrity field. The trailer differs between files with identical content, so it cannot be a content checksum.

**Length-changing edits are structurally safe.** The trailing tables are self-describing and position-independent.

### Embedded absolute paths

| File | Path |
|---|---|
| `.pro` | `C:\Users\Hayden.Schmidt\…\Projects - Documents\…\Release 1.4 updated door code\COMlibV2.lib` |
| `.BAK` | `C:\Users\Tong.Xie\…\Projects - 文档\…\Release 1.3\COMlibV2.lib` |

The `.BAK` was saved by a different engineer, from a Chinese-localised OneDrive, on a **newer** CoDeSys (2.3.9.59) than the current `.pro`. Two consequences: the project is **not path-portable**, and sharing it externally leaks a username and folder structure.

---

## 13. `COMlibV2.lib` — encryption

### 13.1 The cipher

```
k[i] = (0xEF * (i + 1)) mod 256          equivalently  k[i] = (239 − 17·i) mod 256

plaintext[i] = ciphertext[i] XOR k[i]     for i >= 20
plaintext[i] = ciphertext[i]              for i <  20   (header not encrypted)
```

| Property | Value | Conf |
|---|---|---|
| Operation | XOR (**not** additive) | **V** |
| Step | −17 (`−0x11`) per byte | **V** |
| Period | 256 (17 is coprime with 256) | **V** |
| Start offset | 20 | **V** |
| Printable ratio, XOR | **91.3 %** | **V** |
| Printable ratio, ADD (rejected) | 35.6 % | **V** |

**How it was found.** Ciphertext entropy is 7.998 bits/byte — apparently random. But runs of zero plaintext leak the keystream: `(byte[i] + 17·i) mod 256` equals **239** at 6,576 positions, including unbroken runs of 82 bytes. That fixes step and phase.

**Sentinel:** offset 20 decrypts to `0x0B` followed by exactly 11 bytes `SERIAL10COM` — a well-formed length-prefixed string. Assert this.

XOR is an involution: **the same routine re-encrypts.** But the keystream is indexed by **absolute offset**, so you must decrypt whole → edit → re-encrypt whole. You cannot patch ciphertext in place.

### 13.2 Decrypted structure

Same container format. Own directory tree at offset 98,901, rooted at `Bausteine`.

| Measure | Value | Conf |
|---|---|---|
| MARK occurrences | 108 | **V** |
| Named objects | 53 | **V** |
| Data types (`0x0B`) | 28 — matches 28 `TYPE` keywords | **V** |
| POUs (`0x07`) | 23 — matches 19 `FUNCTION_BLOCK` + 4 `FUNCTION` | **V** |
| Globals (`0x00`) | 2 | **V** |
| Object ID band | `0xBA`–`0xEE` | **D** |

| Folder | Members (ID hex) |
|---|---|
| `[Internal]` | `_ReceiveString` (ba), `_SendString` (bb), `_strncpy` (bc) |
| `Background Communication` | `SerialLineControl` (ec), `SerialLineControlADS` (ed), `SerialLineControlM8000` (ee) |
| `Configuration` | `KL6configuration` (d6), `KL6ReadRegisters` (dd), `KL6WriteRegisters` (de), `M8000configuration` (df) |
| `Send + Receive` | `ReceiveByte` (e4), `ReceiveData` (e5), `ReceiveString` (e6), `ReceiveString255` (e7), `SendByte` (e8), `SendData` (e9), `SendString` (ea), `SendString255` (eb) |
| `Version` | `Get_ComLib_Version` (d1) |
| root | `ASC` (bd), `CHR` (be), `ClearComBuffer` (bf), `ComReset` (ca) |

### 13.3 Line endings differ — trap

| File | Line ending |
|---|---|
| `.pro` object text | **CRLF** (`0D 0A`) |
| `.lib` object text | **LF** (`0A`) |

Track this per file. Never normalise. Rewriting LF→CRLF on save changes every length field in the library.

---

## 14. Sibling files

| File | Format | Content | Recommendation |
|---|---|---|---|
| `.tpa` | XML | **Variable → physical fieldbus mapping** (`IGroup`/`IOffset`/`BitSize`, `LinkedWith`). Not in `.pro` or `.EXP` | **Parse it.** Only source of the I/O wiring map |
| `.tpy` | XML | 1,007 `<Symbol>`, 155 `<DataType>`, 701 I/O addresses, `ChangeDate` | **Read-only oracle.** Regenerate and diff after edits |
| `.ci` | Binary, magic `35 31 40 05` | Task bindings, globals, source comments. Embeds the identical task-config structure | **Stale — 2026-01-25.** Do not trust |
| `.ri` | Same magic | Relocation info; 3,740 printable runs vs `.ci`'s 8,089 | Skip |
| `.BAK` | `CoDeSys+` | Prior save — a full second specimen | Format validation |
| `.SYM` | Text, 56 B | `;Version=2 ;ProjectId=85860 ;Checksum=0 ;Filesize=0` — symbol download disabled. `85860` not found in any binary | Low value |
| `.DFR` | `CoDeSys+`, 449 B | Same container. Name at 32, `{Content}` at 276, **16-colour VGA palette (BGR0) at 368–432** | Useful for visualization rendering |
| `.tsm` | OLE compound | TwinCAT type/symbol DB | Optional, needs OLE reader |
| `.SDB` | — | Stale | Skip |

VGA palette decodes exactly: `#000000, #0000ff, #00ffff, #00ff00, #ffff00, #ff0000, #ff00ff, #c0c0c0` + eight dark variants.

---

## 15. Complete file map

| Range | Contents | Conf |
|---|---|---|
| 0 – 202 | Magic, version, header, path length | **V** |
| 202 – 242,424 | Library symbol/interface cache, 6 sections | **V** |
| 242,424 – 264,041 | Project POU symbol/interface cache | **V** |
| 264,900 – 265,400 | Task configuration | **V** |
| 265,418 – 288,000 | Resource objects (GVLs, TwinCAT config) | **V** |
| 288,528 – 360,000 | **27 POU objects**, alphabetical | **V** |
| 360,014 – 386,300 | Visualizations (`AUTODOOR`, `TESTGUI`) | **D** |
| 386,346 – 386,600 | Library reference table | **V** |
| 386,604 – ~404,000 | Library symbol index (136 names) | **V** |
| 404,678 – 406,420 | Object directory tree | **V** |
| 406,420 – 406,632 | Target/gateway settings (`localhost` ×3) | **D** |
| 406,632 – 406,636 | Trailer | **V** |

Nothing is unaccounted for.

### Visualizations are partly text-parseable

`AUTODOOR` yields variable bindings (`ProcessDoorGUI.GUIClose`, `SecurityDoor.CurrentDeltaRatio`), labels (`Operational Data`, `Door Current State`), format strings (`%d`, `%f`), fonts (`MS Sans Serif`, `Arial`). `TESTGUI` binds `mb_Output_Registers[INDEX]`. Geometry remains binary, but a read-only "which variables does this HMI touch" view is achievable with string extraction alone. **D**

---

## 16. Object inventory

| POU | ID | Hex | Body | Decl | Body len | Nets | Path |
|---|---|---|---|---|---|---|---|
| BagData | 677 | 0x2a5 | TEXT | 407 | 3,101 | | /JAL SBD |
| CanopyControl | 12 | 0x00c | **LD** | 35 | — | 2 | /BagdropModules |
| Config_AdvanceRegister | 21 | 0x015 | TEXT | 120 | 149 | | /Library/Config_Libraries |
| Config_DecodeBool | 22 | 0x016 | TEXT | 87 | 75 | | /Library/Config_Libraries |
| Config_DecodeInt | 23 | 0x017 | TEXT | 108 | 106 | | /Library/Config_Libraries |
| Config_DecodeString | 24 | 0x018 | TEXT | 152 | 379 | | /Library/Config_Libraries |
| ControlledBuffer | 13 | 0x00d | **LD** | 301 | — | 13 | /BagdropModules |
| CX8080ReadSwitches | 25 | 0x019 | TEXT | 81 | 715 | | /BagdropModules |
| Extract2ByteData | 736 | 0x2e0 | TEXT | 183 | 463 | | /JAL SBD |
| FastStop | 738 | 0x2e2 | TEXT | 248 | 1,372 | | /BagdropModules |
| GlobalFlags | 15 | 0x00f | **LD** | 264 | — | 7 | /BagdropModules |
| HybridControl | 16 | 0x010 | **LD** | 183 | — | 20 | /BagdropModules |
| InterfaceInputs | 17 | 0x011 | TEXT | 54 | 518 | | /BagdropModules |
| InterfaceOutputs | 18 | 0x012 | TEXT | 121 | 862 | | /BagdropModules |
| Intrusion | 19 | 0x013 | **LD** | 323 | — | 10 | /BagdropModules |
| MAIN | 26 | 0x01a | TEXT | 228 | 3,072 | | (root) |
| ModbusWatchdog | 740 | 0x2e4 | TEXT | 541 | 1,575 | | (root) |
| ParseForColour | 739 | 0x2e3 | TEXT | 104 | 121 | | /Library |
| PhysicalMapping | 27 | 0x01b | TEXT | 306 | 6,295 | | (root) |
| ProcessDoorGUI | 742 | 0x2e6 | TEXT | 431 | 561 | | /Security Door/Internal |
| ReadConfigs | 28 | 0x01c | TEXT | 172 | 344 | | /BackgroundTasks |
| RearTrack | 20 | 0x014 | **LD** | 479 | — | 6 | /BagdropModules |
| SecurityDoor | 743 | 0x2e7 | TEXT | 5,939 | 25,457 | | /Security Door |
| SerialCom | 682 | 0x2aa | TEXT | 194 | 501 | | /BackgroundTasks |
| TagToSerial | 683 | 0x2ab | TEXT | 729 | 3,239 | | /Optional |
| TwinSafe | 29 | 0x01d | TEXT | 337 | 1,685 | | /Optional |
| UPS_CX80xx | 733 | 0x2dd | TEXT | 88 | 187 | | /Library |

Non-POU: `Hardware` 1, `Variable_Configuration` 3, `TestGUI` 30, `BagData` 678, `Global_Variables` 731, `TwinCAT_Import` 735, `Configs` 737, `AUTODOOR` 741, `TwinCAT_Configuration` 744, `Standard` 0.

**ID bands:** project 1–30 and 677–744; library 0xBA–0xEE. Allocation rule unknown — a new object must take an unused ID.

---

## 17. Decode → edit → encode

### 17.1 Architecture

```
ProFile
 ├─ raw : bytes                        (immutable original, never mutated)
 ├─ objects[]
 │    ├─ typ, oid, cls                 (parsed)
 │    ├─ declSpan, bodySpan            (offset + length)
 │    ├─ midSpan                       (25 B; [17:25] OPAQUE)
 │    └─ bodyKind : TEXT | LD
 ├─ directory, libraries, librarySymbols, tasks
 └─ unparsed spans                     (copied verbatim)
```

Governing rule: **every byte belongs to exactly one span; unparsed spans are copied through untouched.**

### 17.2 The loop

1. **Load** and build the span model. Never mutate `raw`.
2. **Assert** the invariants (§17.3). Abort on any failure.
3. **No-op round-trip test before any edit** — reassemble and confirm equality with `raw`. If this fails your model is wrong; stop.
4. **Edit** only a `declSpan` or a `TEXT` `bodySpan`.
5. **Rewrite:** `raw[0:span.start] + newBytes + raw[span.end:]`.
6. **Patch BOTH length fields:**
   - declaration `u32` at `declLenOff`
   - body `u32` at `bodyOff − 4`
   Write full 32-bit values.
7. **Re-parse from scratch.** Confirm every object resolves, IDs unchanged, only intended text differs.
8. **Compile in TwinCAT**, regenerate `.tpy`, diff its symbol list against the pre-edit `.tpy`.

For `.lib`: decrypt whole at step 1, re-encrypt whole at step 5.

### 17.3 Invariants to assert

| # | Invariant | Catches |
|---|---|---|
| 1 | Magic is `CoDeSys+` | Wrong file type |
| 2 | Exactly one `POUs`-shaped root signature | Truncation |
| 3 | Object count == directory POU record count | Missed objects |
| 4 | Every `objectId` appears once in store and once in directory; sets equal | Broken join |
| 5 | `declSpan` starts 4 bytes after a **maximal** MARK run end | Mis-anchored parse |
| 6 | Body tag ∈ {`0x12`, `0x1B`} | Unknown encoding |
| 7 | **LD: `u32` after `0x1B` == count of `08 FF`** | Ladder corruption |
| 7b | **LD: walker consumes exactly `nnet` networks** | Grammar desync |
| 7c | **LD: derived body end == next object header** | Extent error |
| 7d | **LD: `encode_body(walk(b))` == `b`** | Round-trip loss |
| 8 | **After edit: `u32` at `declLenOff` == new decl length** | **The silent-corruption bug** |
| 9 | **After edit: byte at `declStart + declLen` ∈ {`0x12`,`0x1B`}** | Misaligned body tag |
| 10 | Middle region == 25 bytes (cls `0x2C` objects) | Mis-parse |
| 11 | Folder `childCount` == children walked | Directory corruption |
| 12 | `libCount` == library records parsed | Table corruption |
| 13 | Spans tile the file, no gaps, no overlaps | **Byte loss** |
| 14 | No-op reassembly reproduces input exactly | Model error |

Invariants 13 and 14 together guarantee no byte is lost. 8 and 9 catch the declaration-edit corruption class.

### 17.4 Risk ranking

| Target | Risk | Note |
|---|---|---|
| ST/IL body text | **Low** | Proven byte-exact; no checksum |
| Declarations | **Low–Medium** | Safe *only* with invariants 8–9 enforced |
| GVL contents | **Low–Medium** | Same encoding as declarations |
| Ladder bodies — symbol/literal edits | **Low–Medium** | Walker round-trips byte-exact (§6.4). Preserve `el.raw` |
| Ladder bodies — add/remove branches | **Medium** | Geometry confirmed 6/6 vs editor; tag synthesis unproven |
| Symbol/interface cache | **Do not write** | Compiler-maintained |
| Task configuration | **Do not write** | Controls scan order |
| Visualizations | **Read-only feasible** | Strings extractable, geometry unknown |
| Directory (rename/move/add) | **High** | Needs ID allocation rule |
| `COMlibV2.lib` | **Read-only** | Vendor library, referenced by timestamp |

---

## 18. Remaining gaps

| # | Unknown | Status | Resolution |
|---|---|---|---|
| ~~1~~ | ~~Ladder body extent~~ | **CLOSED** — element walker, 58/58 networks, byte-exact both files (§6.4) | — |
| ~~1b~~ | ~~Ladder tree geometry~~ | **CLOSED** — 6/6 rungs match the CoDeSys editor, incl. 3-level nesting in rung 0004 (§6.4) | — |
| 1c | Ladder **tag synthesis** for newly created elements | Open, narrow. Round-trip preserves `el.raw`; building tags from scratch untested | Add one branch in CoDeSys, re-save, diff |
| 2 | Object flags (`@OBJECTFLAGS`, `@SYMFILEFLAGS`) | Narrowed — not in the 25-byte middle region; unchanged across saves | A `.pro` with one POU's flags changed |
| 3 | Object ID allocation rule | Open. Bands 1–30, 677–744, 0xBA–0xEE | Add one POU in CoDeSys and diff |
| 4 | Visualization geometry | Partly open — strings extractable | A CoDeSys visualization export |
| 5 | Task-config param words (16 / 10000 / 2) | Open | A `.pro` with a changed cycle time |
| 6 | `editorState` 8 bytes, `classWord` `0x002C` | Cosmetic if preserved | Scroll a POU, re-save, diff |
| 7 | `ProjectId=85860` storage | Minor — absent from all binaries | Low priority |
| 8 | Header bytes 8–18 | Minor | — |
| ~~9~~ | ~~Checksum / trailer~~ | **CLOSED** — none exists (§12) | — |
| ~~10~~ | ~~Uncharacterised 65%~~ | **CLOSED** — symbol cache (§10) | — |
| ~~11~~ | ~~Task enable flag~~ | **CLOSED** — absent `_CALLTASKSERIALCOM` (§11) | — |

**Most valuable next input:** one `Archive/edited*.pro` with its matching `EXPORT EDITED*.EXP`. They differ by a *known, deliberate* edit — the cleanest signal for gaps 2 and 3, and the natural regression corpus.

With gaps 1 and 1b closed, **every structural element of the format now parses, verifies, renders correctly and round-trips byte-exactly.** The remaining gaps are refinements, not blockers.

---

## 19. Reference — bytes at a glance

| Bytes | Meaning | Conf |
|---|---|---|
| `43 6f 44 65 53 79 73 2b` | `CoDeSys+` magic | **V** |
| `(02 00)` × **N≥8**, maximal | String MARK; `u32` length at run **end** | **V** |
| `07 08 <id u32> 2c 00` | POU object header | **V** |
| `00 08 <id u32> 2c 00` | GVL / resource header | **D** |
| `01 08 <id u32> 2c 00` | Visualization header | **D** |
| `0b 08 <id u32> 00 00` | Data type header (library) | **V** |
| `08 <u32>` / `09 <u32>` | Timestamp pair — Unix epoch UTC | **V** |
| mid[11:15] | Object ID — resource objects only, zero for POUs | **V** |
| mid[17:25] | Opaque persistent field — copy verbatim | **V** |
| `12 <u32>` | Text body: tag + **byte length** | **V** |
| `1b <u32> 00 00 00` | Ladder body: tag + **network count** | **V** |
| `<len:u8> <name>` | Ladder element name (u8 prefix, unlike the rest of the format) | **V** |
| `<len:u32> <text> 00` | Ladder network comment; empty = `00 00 00 00 00` | **V** |
| `64 00 00 00 04 00 00 00` + 12×`00` | Ladder body footer, 20-byte constant | **V** |
| `08 ff` | Ladder network boundary | **V** |
| `09` / `0a` / `0b` | Series / parallel / contact | **V** |
| `+0x40` / `+0x80` | Terminal child / negated contact | **V** |
| `05` / `45` / `41` | FB instance / terminal FB / PT literal | **V** |
| `03 54 4f 4e` | Pascal string `"TON"` | **V** |
| `01 00 01 00 <len u32> <name>` | Folder record | **V** |
| `01 00 <len u32> <name> 00 00 <id u32>` | POU record | **V** |
| `ff ff ff ff` | Last-child terminator | **V** |
| `01 <flag u8> <len u8> <name>` | Task record (u8 prefix!) | **V** |
| `<u32> <name> 00 40 <u32>` | Library reference record | **V** |
| `<u32> <name> 00 00 00 00` | Library symbol index entry | **V** |
| `k[i] = (0xEF*(i+1)) & 0xFF` | `.lib` XOR keystream, from offset 20 | **V** |
| `0x0B` + `SERIAL10COM` @20 | Library decryption sentinel | **V** |

---

## 20. Companion code

`proparse.py` — reference implementation of everything above.

```
python proparse.py info    <file.pro>      container summary, tasks, libraries
python proparse.py list    <file.pro>      object inventory
python proparse.py dump    <file.pro> <d>  extract POUs to files
python proparse.py verify  <file.pro>      run all invariants + round-trip
python proparse.py ladder  <file.pro> [P]  walk and render ladder networks
python proparse.py decrypt <file.lib> <o>  decrypt (and verify re-encrypt)
```

Measured results:

| | `.pro` | `.BAK` |
|---|---|---|
| Invariant checks | **122 / 122** | **122 / 122** |
| No-op round-trip (incl. ladder) | **byte-exact** | **byte-exact** |
| Declarations vs EXP | **27 / 27** | — |
| Text bodies vs EXP | **21 / 21** | — |
| Ladder networks walked | **58 / 58** | **58 / 58** |
| Ladder re-encode | **6 / 6 exact** | **6 / 6 exact** |

| Ladder geometry vs editor | **6 / 6 rungs** | — |

`ldwalk.py` — the ladder element walker (§6.4). Standalone; `proparse.py` uses it when present and degrades gracefully when absent. Exposes `walk_body`, `encode_body`, `render_network`, `build_tree`, `render_expr`.

`splice()` demonstrates the correct edit path. The exact declaration edit that silently destroys a body when only the body length is patched (`bPowerFail` → `bPowerFailXYZ` in `UPS_CX80xx`, +3 bytes) round-trips cleanly: length field patched, body tag still `0x12`, body recovered identical, zero collateral damage to the other 34 objects.

`hexdump_to_bin.py` — reconstructs binaries from `hexdump -C` style `.txt` (verifies offset continuity).
