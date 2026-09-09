#!/usr/bin/env python3
"""
sanitize.py - Build a synthetic, company-data-free `.pro` from a real one.

Produces a structurally identical CoDeSys V2.3 / TwinCAT 2 project whose
POU names, variable names, comments, code and ladder logic are all invented,
so it can be used as a development fixture outside a controlled environment.

Strategy
--------
1. IDENTIFIERS are replaced with SAME-LENGTH synthetic names, applied as a
   whole-file byte substitution. Because every replacement is the same byte
   length, every length-prefixed record in the file stays valid untouched -
   the symbol/interface cache (~2,259 names), directory tree, library symbol
   index, ladder element names and declarations all remain consistent with
   zero length-field edits.

2. FREE TEXT (declaration bodies, ST implementation bodies, ladder network
   comments) is regenerated wholesale. Declaration and body u32 length fields
   are patched. Ladder bodies have no byte-length field (extent is derived by
   walking), so comment length may change freely.

3. PATHS / USERNAMES are overwritten in place.

What is preserved: every structural feature - object count, IDs, folder tree,
task configuration, library references, ladder network counts and topology,
FB types and PT literals. What is destroyed: all company logic and naming.

Usage:
    python sanitize.py <real.pro> <synthetic.pro>
"""

import hashlib
import re
import struct
import sys

sys.path.insert(0, ".")
from proparse import (load, parse_objects, parse_directory, u32,
                      BODY_TEXT, BODY_LADDER, TYPE_POU, TYPE_GVL, TYPE_VISU,
                      MARK_RE)
import ldwalk

# ------------------------------------------------------------------ naming

ST_KEYWORDS = {
    "IF", "THEN", "ELSE", "ELSIF", "END_IF", "CASE", "OF", "END_CASE", "FOR",
    "TO", "BY", "DO", "END_FOR", "WHILE", "END_WHILE", "REPEAT", "UNTIL",
    "END_REPEAT", "RETURN", "EXIT", "VAR", "END_VAR", "TRUE", "FALSE", "AND",
    "OR", "NOT", "XOR", "MOD", "BOOL", "INT", "UINT", "DINT", "UDINT", "WORD",
    "BYTE", "REAL", "LREAL", "TIME", "STRING", "ARRAY", "STRUCT", "TON",
    "TOF", "TP", "R_TRIG", "F_TRIG", "PROGRAM", "FUNCTION", "TYPE", "AT",
}

# Neutral vocabulary - deliberately generic industrial-demo words.
# CoDeSys built-in tree roots - these are tool vocabulary, not company data.
STANDARD_FOLDERS = {"POUs", "Data types", "Visualizations",
                    "Global Variables", "Bausteine", "Datentypen",
                    "Globale Variablen"}

NOUNS = ["Unit", "Node", "Stage", "Zone", "Line", "Cell", "Block", "Gate",
         "Track", "Motor", "Valve", "Lamp", "Latch", "Timer", "Level",
         "Guard", "Feed", "Drive", "Panel", "Relay", "Probe", "Frame"]
ADJS = ["Main", "Aux", "Prim", "Sec", "Upper", "Lower", "Left", "Right",
        "Fast", "Slow", "Inner", "Outer", "Front", "Rear", "Alpha", "Beta",
        "Delta", "Gamma", "Sigma", "Omega", "Test", "Demo"]


def _stable(seed, n):
    """Deterministic index from a seed string."""
    h = hashlib.sha256(seed.encode()).digest()
    return int.from_bytes(h[:4], "big") % n


class NameFactory:
    """Generates unique synthetic identifiers of an EXACT byte length."""

    def __init__(self):
        self.used = set()
        self.counter = 0

    ALPH = "abcdefghijklmnopqrstuvwxyz0123456789"

    def _enc(self, n, width):
        """Base-36 encode n into exactly `width` chars."""
        out = []
        for _ in range(width):
            out.append(self.ALPH[n % 36])
            n //= 36
        return "".join(reversed(out))

    def make(self, length, seed):
        """
        Unique synthetic identifier of EXACTLY `length` bytes.
        Always alphanumeric, so folder names containing spaces become
        space-free but keep their byte length.

        Long names get readable word-pairs; short names fall back to a
        systematic base-36 counter, which guarantees uniqueness down to
        length 1 (26 + 36^(L-1) available slots).
        """
        if length < 1:
            return ""

        # Preferred: readable word pair, padded with a numeric tail.
        if length >= 7:
            for attempt in range(600):
                s = seed + ("#%d" % attempt if attempt else "")
                base = ADJS[_stable(s + "a", len(ADJS))] + \
                    NOUNS[_stable(s + "n", len(NOUNS))]
                # Chain further word pairs so long names stay readable
                # rather than becoming a short word plus 20 digits.
                k = 0
                while len(base) < length and k < 6:
                    base += "_" + ADJS[_stable(s + "a%d" % k, len(ADJS))] \
                        + NOUNS[_stable(s + "n%d" % k, len(NOUNS))]
                    k += 1
                if length <= len(base):
                    cand = base[:length]
                else:
                    pad = length - len(base)
                    cand = base + str(self.counter % (10 ** pad)).zfill(pad)
                cand = cand.rstrip("_")
                if len(cand) < length:
                    cand = cand + "x" * (length - len(cand))
                if (re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", cand)
                        and cand.upper() not in ST_KEYWORDS
                        and cand not in self.used):
                    self.used.add(cand)
                    self.counter += 1
                    return cand
                self.counter += 1

        # Systematic fallback: letter prefix + base-36 body.
        for n in range(36 ** max(1, length - 1) * 26):
            first = self.ALPH[n % 26]
            cand = first + (self._enc(n // 26, length - 1) if length > 1 else "")
            if cand.upper() in ST_KEYWORDS or cand in self.used:
                continue
            self.used.add(cand)
            return cand
        raise RuntimeError(f"could not generate unique name of length {length}")


# ------------------------------------------------------- identifier harvest

IDENT_RE = re.compile(rb"[A-Za-z_][A-Za-z0-9_]{2,63}")

# Identifiers that MUST survive: IEC/vendor library surface. Renaming these
# would make the project reference function blocks that do not exist.
def build_keep_set(buf):
    keep = set(k.encode() for k in ST_KEYWORDS)
    # Everything named by the library symbol index and library sections is
    # vendor API - keep it. Harvest from the library cache region and the
    # library symbol index.
    for m in IDENT_RE.finditer(buf[:242424]):
        keep.add(m.group(0))
    for m in IDENT_RE.finditer(buf[386604:404000]):
        keep.add(m.group(0))
    # Common IEC types/functions that may only appear in project code
    for extra in ("CONCAT", "FIND", "INSERT", "DELETE", "REPLACE", "LEFT",
                  "RIGHT", "MID", "LEN", "ADR", "SIZEOF", "SHL", "SHR",
                  "ROL", "ROR", "SEL", "MIN", "MAX", "LIMIT", "MUX", "ABS",
                  "SQRT", "TRUNC", "BOOL_TO_INT", "INT_TO_BOOL",
                  "WORD_TO_INT", "INT_TO_WORD", "REAL_TO_INT",
                  "INT_TO_REAL", "BYTE_TO_STRING", "WORD_TO_HEXSTR",
                  "HEXSTR_TO_DATA", "STRING_TO_INT", "DWORD", "SINT",
                  "USINT", "LINT", "ULINT", "DATE", "TIME_OF_DAY", "DT",
                  "PERSISTENT", "CONSTANT", "RETAIN", "VAR_INPUT",
                  "VAR_OUTPUT", "VAR_IN_OUT", "VAR_GLOBAL", "VAR_CONFIG",
                  "END_PROGRAM", "END_FUNCTION", "END_FUNCTION_BLOCK",
                  "FUNCTION_BLOCK", "END_STRUCT", "END_TYPE",
                  "MAIN"):
        keep.add(extra.encode())
    return keep


def harvest_project_identifiers(buf, objs):
    """Identifiers that belong to the PROJECT (not the vendor libraries)."""
    found = set()
    # object names
    for o in objs:
        found.add(o.name.encode())
    # declaration text
    for o in objs:
        for m in IDENT_RE.finditer(o.decl(buf)):
            found.add(m.group(0))
    # ST body text
    for o in objs:
        b = o.body(buf)
        if b:
            for m in IDENT_RE.finditer(b):
                found.add(m.group(0))
    # ladder element names
    allo = sorted(objs, key=lambda x: x.hdr_off)
    for o in objs:
        if o.tag != BODY_LADDER:
            continue
        hard = min([x.hdr_off for x in allo if x.hdr_off > o.body_off]
                   or [len(buf)])
        nets, _, _ = ldwalk.walk_body(buf, o.body_off, o.nnet, hard)
        for n in nets:
            for e in n.tree + n.outputs:
                if e.name:
                    for m in IDENT_RE.finditer(e.name.encode()):
                        found.add(m.group(0))
    # project POU section of the symbol cache
    for m in IDENT_RE.finditer(buf[242424:264900]):
        found.add(m.group(0))
    # custom folder names from the directory tree (may contain spaces, so
    # they are harvested whole rather than by identifier regex)
    for _, name, is_folder, _ in parse_directory(buf, 404678):
        if is_folder and name not in STANDARD_FOLDERS:
            found.add(name.encode("latin1"))
    return found


# ------------------------------------------------------------- code bodies

def gen_decl(obj, newname, varnames):
    """
    Synthetic declaration reusing the object's already-renamed variables.
    Returns (bytes, typed) where typed = [(name, type)], so the body
    generator can emit type-correct statements (CASE/FOR need an integer,
    not a BOOL).
    """
    head = f"PROGRAM {newname}"
    if obj.kind_hint == "FUNCTION":
        head = f"FUNCTION {newname} : INT"
    elif obj.kind_hint == "FUNCTION_BLOCK":
        head = f"FUNCTION_BLOCK {newname}"

    typed = []
    for i, v in enumerate(varnames[:14]):
        typed.append((v, ["BOOL", "INT", "WORD", "TON", "REAL"][i % 5]))
    if not typed:
        typed = [("bDemoFlag", "BOOL"), ("iDemoCount", "INT")]
    # guarantee at least one BOOL and one INT for the body generator
    if not any(t == "BOOL" for _, t in typed):
        typed.append(("bDemoFlag", "BOOL"))
    if not any(t == "INT" for _, t in typed):
        typed.append(("iDemoCount", "INT"))

    lines = [head, "VAR"]
    for v, t in typed:
        lines.append(f"\t{v}: {t};")
    lines.append("END_VAR")
    return "\r\n".join(lines).encode("latin1"), typed


def gen_body(obj, newname, typed, seed):
    """Type-correct, syntactically valid, semantically meaningless ST."""
    bools = [v for v, t in typed if t == "BOOL"]
    ints = [v for v, t in typed if t in ("INT", "WORD")]
    tons = [v for v, t in typed if t == "TON"]
    b0 = bools[0]
    i0 = ints[0]
    i1 = ints[1] if len(ints) > 1 else i0

    L = ["(* Synthetic demo logic - no functional meaning. *)", ""]
    n = _stable(seed, 4)
    if n == 0:
        L += [f"IF {b0} THEN", f"\t{i0} := 1;", "ELSE", f"\t{i0} := 0;",
              "END_IF"]
    elif n == 1:
        L += [f"CASE {i0} OF", "0:", f"\t{i1} := 10;", "1:",
              f"\t{i1} := 20;", "ELSE", f"\t{i1} := 0;", "END_CASE"]
    elif n == 2:
        L += [f"FOR {i0} := 0 TO 9 DO", f"\t{i1} := {i1} + 1;", "END_FOR"]
    else:
        L += [f"{b0} := NOT {b0};", f"IF {b0} THEN",
              f"\t{i0} := {i0} + 1;", "END_IF"]
    if tons:
        L += ["", f"{tons[0]}(IN := {b0}, PT := T#500ms);",
              f"IF {tons[0]}.Q THEN", f"\t{i0} := 0;", "END_IF"]
    L.append("")
    if obj.kind_hint == "FUNCTION":
        L += [f"{newname} := {i0};", "RETURN;"]
    return "\r\n".join(L).encode("latin1")


LD_COMMENTS = ["Demo rung group", "Synthetic control block",
               "Placeholder interlock", "Example sequence step"]


# ------------------------------------------------------------------ main

def sanitize(src, dst):
    buf = load(src)
    objs = parse_objects(buf)
    allo = sorted(objs, key=lambda x: x.hdr_off)

    # remember declared kind before we rewrite anything
    for o in objs:
        d = o.decl(buf)
        if d.lstrip()[:14] == b"FUNCTION_BLOCK":
            o.kind_hint = "FUNCTION_BLOCK"
        elif d.lstrip()[:8] == b"FUNCTION":
            o.kind_hint = "FUNCTION"
        else:
            o.kind_hint = "PROGRAM"

    # ---- 1. same-length identifier map -----------------------------------
    keep = build_keep_set(buf)
    proj = harvest_project_identifiers(buf, objs)
    rename = sorted(proj - keep, key=lambda b: (-len(b), b))

    fac = NameFactory()
    mapping = {}
    for ident in rename:
        s = ident.decode("latin1")
        mapping[ident] = fac.make(len(s), s).encode("latin1")

    print(f"identifiers renamed : {len(mapping)}")
    print(f"identifiers kept    : {len(keep & proj)} (vendor/IEC surface)")

    # ---- 1a. structural rename in length-prefixed binary regions ---------
    #
    # A plain word-boundary substitution is NOT safe here for two reasons:
    #   * 351 project identifiers are substrings of vendor identifiers
    #     (e.g. 'UPS_CX80xx' inside 'FB_S_UPS_CX80xx'), so boundaries are
    #     mandatory; and
    #   * inside ladder binary the byte FOLLOWING a name is a tag which is
    #     often an ASCII letter (0x4B='K', 0x45='E', 0x41='A'), which defeats
    #     a lookahead boundary and silently skips the rename.
    #
    # Instead, use each region's own length prefix as the boundary proof:
    # a name is only renamed when the preceding length field equals its
    # length exactly. Unambiguous, and same-length so nothing shifts.
    out = bytearray(buf)

    def map_name(nm):
        """Map a name, including dotted forms like 'SecurityDoor.DoorHW_LOCK'
        used by visualization bindings. Same length either way."""
        if nm in mapping:
            return mapping[nm]
        if b"." in nm:
            parts = nm.split(b".")
            new = [mapping.get(p, p) for p in parts]
            if any(a != b for a, b in zip(parts, new)):
                return b".".join(new)
        return None

    def rename_u32_records(lo, hi):
        """<len:u32><name> records - symbol cache, object store, directory."""
        n = 0
        p = lo
        while p < hi - 8:
            ln = u32(out, p)
            if 1 <= ln <= 96 and p + 4 + ln <= hi:
                nm = bytes(out[p + 4:p + 4 + ln])
                new = map_name(nm)
                if new is not None and len(new) == ln:
                    out[p + 4:p + 4 + ln] = new
                    n += 1
                    p += 4 + ln
                    continue
            p += 1
        return n

    def rename_u8_records(lo, hi):
        """<len:u8><name> records - task configuration."""
        n = 0
        p = lo
        while p < hi - 2:
            ln = out[p]
            if 1 <= ln <= 64 and p + 1 + ln <= hi:
                nm = bytes(out[p + 1:p + 1 + ln])
                new = map_name(nm)
                if new is not None and len(new) == ln:
                    out[p + 1:p + 1 + ln] = new
                    n += 1
                    p += 1 + ln
                    continue
            p += 1
        return n

    n_rec = rename_u32_records(202, len(out))
    n_task = rename_u8_records(264900, 265500)
    print(f"length-prefixed names renamed : {n_rec}")
    print(f"task-config names renamed     : {n_task}")

    # ---- 1b. neutralise free-text records --------------------------------
    #
    # Comments, visualization labels and expression strings ("NOT X.Y",
    # "Door Current State") are prose, not identifiers, so the exact-name
    # pass above misses them. Rewrite them SAME-LENGTH so no length field
    # moves: first substitute identifiers, then, if any residual English
    # word survives that is neither vendor API nor a generated name,
    # replace the whole record with neutral filler.

    ident_pat = re.compile(
        rb"(?<![A-Za-z0-9_])(" +
        rb"|".join(re.escape(k) for k in rename) +
        rb")(?![A-Za-z0-9_])")

    # Strings that must survive verbatim: rendering and target vocabulary.
    TEXT_KEEP = {b"localhost", b"Arial", b"MS Sans Serif", b"Tahoma",
                 b"Courier New", b"Times New Roman", b"System"}
    allowed_words = set(w.lower() for w in fac.used) | \
        set(k.lower() for k in keep) | \
        set(k.encode().lower() for k in ST_KEYWORDS)

    WORD = re.compile(rb"[A-Za-z][A-Za-z_]{3,}")
    FILLER = b"Demo placeholder text for synthetic project fixture. "

    RUN_RE = re.compile(rb"[\x20-\x7e\t\r\n]{4,}")

    def neutralise_text(lo, hi):
        """
        Scrub PRINTABLE RUNS in place, same length.

        Working on runs rather than length-prefixed records matters:
        visualization label records carry trailing binary inside their
        declared length (e.g. len=22 for "Door Current State" + 4 binary
        bytes), so a whole-record printable test skips them entirely.
        Rewriting only the printable bytes keeps every structural byte and
        every length field untouched by construction.
        """
        n = 0
        for m in RUN_RE.finditer(bytes(out[lo:hi])):
            s, e = lo + m.start(), lo + m.end()
            raw = bytes(out[s:e])
            if raw.strip() in TEXT_KEEP:
                continue
            new = ident_pat.sub(lambda mm: mapping[mm.group(1)], raw)
            if len(new) != len(raw):
                continue
            resid = [w for w in WORD.findall(new)
                     if w.lower() not in allowed_words]
            if resid:
                new = (FILLER * (len(raw) // len(FILLER) + 1))[:len(raw)]
                n += 1
            if new != raw:
                out[s:e] = new
        return n

    # Scope: the project symbol cache and the visualization objects.
    # The object store is deliberately EXCLUDED - its declarations and
    # bodies are regenerated wholesale in step 3, and overwriting them
    # here would destroy the END_VAR that object parsing depends on.
    vis_lo = max([o.body_off for o in objs if o.body_off] or [0])
    vis_hi = min((m.start() for m in
                  re.finditer(rb"[A-Za-z0-9_]+\.(?:lib|LIB) [0-9.]+ [0-9:]+",
                              bytes(out))), default=len(out))
    n_text = neutralise_text(242424, 264900)
    n_text += neutralise_text(vis_lo, vis_hi)
    print(f"free-text records neutralised : {n_text}")

    # declaration text: safe to use word boundaries (pure text region)
    pat = re.compile(
        rb"(?<![A-Za-z0-9_])(" +
        rb"|".join(re.escape(k) for k in rename) +
        rb")(?![A-Za-z0-9_])")
    for o in objs:
        s, e = o.decl_off, o.decl_off + o.decl_len
        new = pat.sub(lambda m: mapping[m.group(1)], bytes(out[s:e]))
        assert len(new) == e - s
        out[s:e] = new

    assert len(out) == len(buf), "same-length substitution changed size"

    # ---- 2. scrub the embedded path --------------------------------------
    plen = u32(out, 198)
    path = bytes(out[202:202 + plen])
    newpath = b"C:\\PLC\\Demo\\Synthetic\\COMlibV2.lib"
    newpath = newpath + b"\x00\x40" + b"\x00" * (plen - len(newpath) - 2)
    out[202:202 + plen] = newpath[:plen]

    # ---- 3. regenerate free text -----------------------------------------
    objs2 = parse_objects(bytes(out))
    for a, b in zip(sorted(objs, key=lambda x: x.hdr_off),
                    sorted(objs2, key=lambda x: x.hdr_off)):
        b.kind_hint = a.kind_hint

    edits = []          # (start, end, newbytes, lenfield_off or None)
    allo2 = sorted(objs2, key=lambda x: x.hdr_off)

    for o in objs2:
        decl = o.decl(bytes(out)).decode("latin1")
        varnames = re.findall(r"^\s*([A-Za-z_]\w*)\s*(?:AT\s+%[^:]+)?:",
                              decl, re.M)
        varnames = [v for v in varnames if v.upper() not in ST_KEYWORDS]

        if o.typ in (TYPE_GVL,):
            # keep GVL shape (VAR_GLOBAL ... END_VAR) but neutral contents
            kw = "VAR_GLOBAL PERSISTENT" if "PERSISTENT" in decl else (
                "VAR_CONFIG" if "VAR_CONFIG" in decl else "VAR_GLOBAL")
            body = [kw]
            for i, v in enumerate(varnames[:40]):
                t = ["BOOL", "INT", "WORD", "REAL"][i % 4]
                body.append(f"\t{v}: {t};")
            body.append("END_VAR")
            nd = "\r\n".join(body).encode("latin1")
            edits.append((o.decl_off, o.decl_off + o.decl_len, nd,
                          o.decl_len_off))
            continue

        if o.typ != TYPE_POU:
            continue

        nd, typed = gen_decl(o, o.name, varnames)
        edits.append((o.decl_off, o.decl_off + o.decl_len, nd, o.decl_len_off))

        if o.tag == BODY_TEXT:
            nb = gen_body(o, o.name, typed, o.name)
            edits.append((o.body_off, o.body_off + o.body_len, nb,
                          o.body_off - 4))
        elif o.tag == BODY_LADDER:
            hard = min([x.hdr_off for x in allo2 if x.hdr_off > o.body_off]
                       or [len(out)])
            nets, footer, end = ldwalk.walk_body(bytes(out), o.body_off,
                                                 o.nnet, hard)
            for i, n in enumerate(nets):
                # Rename every element name via the walker, not by byte
                # substitution - the tag byte after a name is often an
                # ASCII letter and would defeat a boundary match.
                for el in n.tree + n.outputs:
                    if el.name:
                        k = el.name.encode("latin1")
                        if k in mapping:
                            el.name = mapping[k].decode("latin1")
                if n.comment:
                    c = LD_COMMENTS[_stable(o.name + str(i),
                                            len(LD_COMMENTS))]
                    cb = c.encode("latin1")
                    n.sep = struct.pack("<I", len(cb)) + cb + b"\x00"
                    n.comment = c
            nb = ldwalk.encode_body(nets, footer)
            edits.append((o.body_off, end, nb, None))

    # ---- 4. rebuild with patched length fields ----------------------------
    edits.sort()
    res = bytearray()
    pos = 0
    patches = []
    for s, e, new, lenoff in edits:
        if s < pos:
            raise RuntimeError(f"overlapping edit spans at {s}")
        res += out[pos:s]
        start_in_res = len(res)
        res += new
        pos = e
        if lenoff is not None:
            # Every length field sits exactly 4 bytes before its span
            # (decl_len_off == decl_off-4; body length == body_off-4), and
            # those 4 bytes were just copied, so patch relative to res.
            assert lenoff == s - 4, f"unexpected length-field offset {lenoff}"
            patches.append((start_in_res - 4, len(new)))
    res += out[pos:]

    for off, val in patches:
        struct.pack_into("<I", res, off, val)

    open(dst, "wb").write(bytes(res))
    print(f"wrote {dst}  ({len(res)} bytes, source {len(buf)})")
    return bytes(res)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(2)
    sanitize(sys.argv[1], sys.argv[2])
