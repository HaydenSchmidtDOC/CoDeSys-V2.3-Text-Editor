#!/usr/bin/env python3
"""
proparse.py - Reference parser for CoDeSys V2.3 / TwinCAT 2 `.pro` and `.lib`.

Implements the format described in TWINCAT_PRO_PARSER_BIBLE.md.
Span-preserving: every byte of the file belongs to exactly one span, and
unparsed spans are copied through verbatim, so a no-op rebuild is byte-exact.

Usage:
    python proparse.py info    <file.pro>
    python proparse.py list    <file.pro>
    python proparse.py dump    <file.pro> <outdir>
    python proparse.py verify  <file.pro>
    python proparse.py ladder  <file.pro> [POU]
    python proparse.py decrypt <file.lib> <out.dec>
"""

import os
import re
import struct
import sys

try:
    import ldwalk
except ImportError:
    ldwalk = None

# ---------------------------------------------------------------- constants

MAGIC = b"CoDeSys+"

# The string MARK is a MAXIMAL run of (02 00) repeated >= 8 times.
# It must be maximal: an object's trailing 8 padding bytes sometimes contain
# 02 00 pairs, which extends the run. Anchoring on the leftmost match reads
# the length u32 from the wrong offset and yields garbage.
MARK_RE = re.compile(rb"(?:\x02\x00){8,}")

# Object type tag, at (mark_start - 16)
TYPE_POU = 0x07
TYPE_GVL = 0x00
TYPE_VISU = 0x01
TYPE_DATATYPE = 0x0B  # libraries only

TYPE_NAMES = {
    TYPE_POU: "POU",
    TYPE_GVL: "GVL",
    TYPE_VISU: "VISU",
    TYPE_DATATYPE: "DATATYPE",
}

# Body tag, at declaration end
BODY_TEXT = 0x12  # followed by u32 BYTE LENGTH
BODY_LADDER = 0x1B  # followed by u32 NETWORK COUNT (not a length!)

NETWORK_MARKER = b"\x08\xff"

MAX_NAME_LEN = 64
MAX_DECL_LEN = 200_000


def u16(buf, off):
    return struct.unpack_from("<H", buf, off)[0]


def u32(buf, off):
    return struct.unpack_from("<I", buf, off)[0]


# ---------------------------------------------------------------- decryption


def lib_keystream(i):
    """Library XOR keystream: k[i] = (0xEF * (i+1)) mod 256."""
    return (0xEF * (i + 1)) & 0xFF


def decrypt_lib(data, start=20):
    """
    Decrypt a .lib. XOR is an involution, so this function also ENCRYPTS.
    The keystream is indexed by ABSOLUTE offset, so you must decrypt whole,
    edit, then re-encrypt whole. You cannot patch ciphertext in place.
    """
    out = bytearray(data)
    for i in range(start, len(data)):
        out[i] ^= lib_keystream(i)
    return bytes(out)


def looks_decrypted(plain):
    """Self-validating check: offset 20 must be 0x0B then 'SERIAL10COM'."""
    return plain[20:21] == b"\x0b" and plain[21:32] == b"SERIAL10COM"


# ---------------------------------------------------------------- primitives


def find_marks(buf):
    """Yield (mark_start, mark_end) for every MAXIMAL MARK run."""
    for m in MARK_RE.finditer(buf):
        yield m.start(), m.end()


def read_string_at_mark(buf, mark_end, max_len):
    """Read <u32 len><bytes> at the end of a MARK run. Returns (data, end)."""
    if mark_end + 4 > len(buf):
        return None, None
    n = u32(buf, mark_end)
    if not (0 < n <= max_len) or mark_end + 4 + n > len(buf):
        return None, None
    return buf[mark_end + 4 : mark_end + 4 + n], mark_end + 4 + n


# ---------------------------------------------------------------- objects


class Obj:
    """One object in the store, with byte spans into the original buffer."""

    __slots__ = (
        "typ", "oid", "cls", "name",
        "hdr_off", "mark_start", "name_end",
        "mid_off", "mid_len",
        "decl_len_off", "decl_off", "decl_len",
        "tag", "body_off", "body_len", "nnet",
    )

    @property
    def kind(self):
        return TYPE_NAMES.get(self.typ, "UNKNOWN(0x%02x)" % self.typ)

    @property
    def body_kind(self):
        if self.tag == BODY_TEXT:
            return "TEXT"
        if self.tag == BODY_LADDER:
            return "LD"
        return None

    def decl(self, buf):
        return buf[self.decl_off : self.decl_off + self.decl_len]

    def body(self, buf):
        if self.tag != BODY_TEXT:
            return None
        return buf[self.body_off : self.body_off + self.body_len]

    def mid(self, buf):
        """25-byte middle region. Bytes [17:25] are OPAQUE - copy verbatim."""
        return buf[self.mid_off : self.mid_off + self.mid_len]


def parse_objects(buf):
    """
    Walk the object store. Anchors on maximal MARK runs; never on keywords
    (PhysicalMapping's declaration legitimately begins with CRLF, which breaks
    keyword anchoring).
    """
    objs = []
    for ms, me in find_marks(buf):
        if ms < 16:
            continue
        name, name_end = read_string_at_mark(buf, me, MAX_NAME_LEN)
        if name is None or not all(32 <= b < 127 for b in name):
            continue

        typ = buf[ms - 16]
        if typ not in TYPE_NAMES:
            continue
        oid = u32(buf, ms - 14)
        cls = u16(buf, ms - 10)

        # Declaration = next MARK-anchored string that looks like a decl.
        decl = None
        p = name_end
        for ms2, me2 in find_marks(buf[p : p + 300]):
            cand, cand_end = read_string_at_mark(buf, p + me2, MAX_DECL_LEN)
            if cand is None:
                continue
            if b"END_VAR" in cand or b"VAR_" in cand or b"VAR" in cand[:40]:
                decl = cand
                decl_len_off = p + me2
                decl_off = p + me2 + 4
                decl_end = cand_end
                # The middle region ends at the NOMINAL mark start
                # (mark_end - 16). Using the maximal run's actual start would
                # under-count by 2 bytes per absorbed padding pair.
                mid_off = p
                mid_len = (p + me2 - 16) - p
                break
        if decl is None:
            continue

        o = Obj()
        o.typ, o.oid, o.cls = typ, oid, cls
        o.name = name.decode("latin1")
        o.hdr_off, o.mark_start, o.name_end = ms - 16, ms, name_end
        o.mid_off, o.mid_len = mid_off, mid_len
        o.decl_len_off, o.decl_off, o.decl_len = decl_len_off, decl_off, len(decl)
        o.tag = buf[decl_end] if decl_end < len(buf) else None
        o.body_off = o.body_len = o.nnet = None

        if o.tag == BODY_TEXT:
            o.body_len = u32(buf, decl_end + 1)   # u32, NOT u16
            o.body_off = decl_end + 5
        elif o.tag == BODY_LADDER:
            o.nnet = u32(buf, decl_end + 1)       # NETWORK COUNT, not a length
            o.body_off = decl_end + 8

        objs.append(o)
    return objs


# ---------------------------------------------------------------- directory


class Node:
    def __init__(self, name, is_folder, oid=None):
        self.name, self.is_folder, self.oid = name, is_folder, oid
        self.children = []

    def walk(self, path=""):
        here = (path + "/" + self.name) if path else self.name
        yield here, self
        for c in self.children:
            yield from c.walk(here)


def find_dir_roots(buf):
    """
    Locate tree roots structurally. Root names are LOCALE-DEPENDENT
    ('POUs' in en, 'Bausteine'/'Datentypen'/'Globale Variablen' in de),
    so never hardcode them.
    """
    roots = []
    for m in re.finditer(rb"\x01\x00\x01\x00", buf):
        o = m.start()
        if o + 8 > len(buf):
            continue
        n = u32(buf, o + 4)
        if not (1 <= n <= 40):
            continue
        nm = buf[o + 8 : o + 8 + n]
        if all(32 <= b < 127 for b in nm):
            roots.append((o, nm.decode("latin1")))
    return roots


def parse_directory(buf, start):
    """
    Flat walk of the directory table from `start`.
    Records:
        FOLDER : 01 00 01 00 <len u32> <name> <childCount u16> <hasSub u16>
        POU    : 01 00 <len u32> <name> 00 00 <objectId u32> <linkFlags 12B>
    Returns list of (offset, name, is_folder, oid_or_childcount).
    """
    out = []
    o = start
    end = min(len(buf), start + 4000)
    while o < end - 8:
        if buf[o] == 1 and buf[o + 1] == 0:
            folder = buf[o + 2 : o + 4] == b"\x01\x00"
            lo = o + 4 if folder else o + 2
            n = u32(buf, lo)
            if 1 <= n <= 40:
                nm = buf[lo + 4 : lo + 4 + n]
                if all(32 <= b < 127 for b in nm):
                    tail = lo + 4 + n
                    if folder:
                        val = u16(buf, tail)          # child count
                    else:
                        val = u32(buf, tail + 2)      # object id
                    out.append((o, nm.decode("latin1"), folder, val))
                    o = tail
                    continue
        o += 1
    return out


# ---------------------------------------------------------------- libraries


def parse_library_table(buf):
    """
    Library manager table: 6 records of
        <recLen u32> "<name>.lib d.m.yy hh:mm:ss" 00 40 <timestamp u32>
    recLen covers name + 00 + 40 + 4 timestamp bytes (= len(name) + 6).
    """
    libs = []
    for m in re.finditer(rb"[A-Za-z0-9_]+\.(?:lib|LIB|Lib) [0-9.]+ [0-9:]+", buf):
        s, e = m.start(), m.end()
        if buf[e : e + 2] != b"\x00\x40":
            continue
        rec_len = u32(buf, s - 4) if s >= 4 else None
        ts = u32(buf, e + 2)
        libs.append(
            dict(off=s, name=m.group(0).decode("latin1"),
                 rec_len=rec_len, ok=(rec_len == len(m.group(0)) + 6), ts=ts)
        )
    return libs


def parse_library_symbol_index(buf, start, stop):
    """Flat list: <len u32><name> 00 00 00 00, repeated."""
    names, o = [], start
    while o < stop - 8:
        n = u32(buf, o)
        if 0 < n < 80:
            nm = buf[o + 4 : o + 4 + n]
            if all(33 <= b < 127 for b in nm):
                names.append((o, nm.decode("latin1")))
                o += 4 + n + 4
                continue
        o += 1
    return names


# ---------------------------------------------------------------- task config


def parse_task_config(buf):
    """
    Task records use a u8 length prefix - NOT the MARK+u32 scheme:
        01 <flag u8> <nameLen u8> <task> <pA u32> <pB u32> ...
        01 00 <progLen u8> <program> ff ff ff ff
    flag 0x01 == task DISABLED (compiler emits no _CALLTASK<NAME> wrapper).
    """
    tasks = []
    for m in re.finditer(rb"\x01([\x00\x01])([\x01-\x20])", buf):
        o, flag, n = m.start(), m.group(1)[0], m.group(2)[0]
        nm = buf[o + 3 : o + 3 + n]
        if len(nm) != n or not all(32 <= b < 127 for b in nm):
            continue
        tail = buf[o + 3 + n : o + 3 + n + 40]
        pm = re.search(rb"\x01\x00([\x01-\x20])", tail)
        if not pm:
            continue
        pn = pm.group(1)[0]
        ps = o + 3 + n + pm.end()
        prog = buf[ps : ps + pn]
        if len(prog) != pn or not all(32 <= b < 127 for b in prog):
            continue
        if buf[ps + pn : ps + pn + 4] != b"\xff\xff\xff\xff":
            continue
        tasks.append(
            dict(off=o, task=nm.decode("latin1"), program=prog.decode("latin1"),
                 disabled=bool(flag),
                 pA=u32(buf, o + 3 + n), pB=u32(buf, o + 7 + n))
        )
    # de-duplicate (the table appears twice)
    seen, uniq = set(), []
    for t in tasks:
        k = (t["task"], t["program"])
        if k not in seen:
            seen.add(k)
            uniq.append(t)
    return uniq


# ---------------------------------------------------------------- verify


def verify(buf, objs):
    """Invariant checks. A parser that guesses is worse than one that stops."""
    res = []

    def chk(name, ok, detail=""):
        res.append((name, bool(ok), detail))

    chk("magic is CoDeSys+", buf[:8] == MAGIC)

    ids = [o.oid for o in objs]
    chk("object ids unique", len(ids) == len(set(ids)),
        f"{len(ids)} objects, {len(set(ids))} distinct")

    for o in objs:
        if o.tag == BODY_LADDER:
            span_end = o.body_off + 4000
            seg = buf[o.body_off : span_end]
            # count markers up to the next object header
            nxt = [x.hdr_off for x in objs if x.hdr_off > o.body_off]
            if nxt:
                seg = buf[o.body_off : min(nxt) ]
            cnt = seg.count(NETWORK_MARKER)
            chk(f"LD {o.name}: nnet==08FF count", cnt == o.nnet,
                f"field={o.nnet} markers={cnt}")

    for o in objs:
        chk(f"{o.name}: decl u32 matches", u32(buf, o.decl_len_off) == o.decl_len)
        if o.tag == BODY_TEXT:
            b = o.body(buf)
            printable = sum(1 for x in b if 32 <= x < 127 or x in (9, 10, 13))
            chk(f"{o.name}: body printable", printable / max(1, len(b)) > 0.98)

    # The 25-byte middle region applies to normal project objects (cls 0x2C).
    # The task/watch record 'Standard' (cls 0x0000) has a different layout.
    for o in objs:
        if o.cls != 0x2C:
            continue
        chk(f"{o.name}: mid is 25 bytes", o.mid_len == 25, f"got {o.mid_len}")

    # Ladder: walk every network structurally and confirm the derived end
    # equals the next object header, and that re-encoding is byte-exact.
    if ldwalk is not None:
        for o in objs:
            if o.tag != BODY_LADDER:
                continue
            hard = min([x.hdr_off for x in objs if x.hdr_off > o.body_off]
                       or [len(buf)])
            try:
                nets, footer, end = ldwalk.walk_body(buf, o.body_off,
                                                     o.nnet, hard)
            except ldwalk.LadderError as exc:
                chk(f"LD {o.name}: walk", False, str(exc))
                continue
            chk(f"LD {o.name}: walked nnet networks", len(nets) == o.nnet)
            chk(f"LD {o.name}: lands on next object header", end == hard,
                f"end={end} hdr={hard}")
            chk(f"LD {o.name}: re-encode byte-exact",
                ldwalk.encode_body(nets, footer) == buf[o.body_off:end])

    libs = parse_library_table(buf)
    for L in libs:
        chk(f"lib recLen {L['name'][:22]}", L["ok"], f"recLen={L['rec_len']}")

    return res


# ---------------------------------------------------------------- rebuild


def rebuild_noop(buf, objs):
    """
    Span-preserving reassembly with no edits. MUST equal the input byte for
    byte. If this fails, the span model is wrong - stop before editing.
    """
    spans = []
    for o in objs:
        spans.append((o.decl_off, o.decl_off + o.decl_len))
        if o.tag == BODY_TEXT:
            spans.append((o.body_off, o.body_off + o.body_len))
        elif o.tag == BODY_LADDER and ldwalk is not None:
            # Ladder extent is derived by the element walker, not stored.
            hard = min([x.hdr_off for x in objs if x.hdr_off > o.body_off]
                       or [len(buf)])
            try:
                _, _, end = ldwalk.walk_body(buf, o.body_off, o.nnet, hard)
                spans.append((o.body_off, end))
            except ldwalk.LadderError:
                pass
    spans.sort()
    out, pos = bytearray(), 0
    for s, e in spans:
        if s < pos:
            continue
        out += buf[pos:s]
        out += buf[s:e]
        pos = e
    out += buf[pos:]
    return bytes(out)


def splice(buf, obj, new_decl=None, new_body=None):
    """
    Surgical edit. Patches BOTH length fields.

    The declaration u32 lives at obj.decl_len_off; the body u32 at
    (declEnd + 1). Failing to patch the declaration length shifts the body
    tag out of alignment and the body becomes unrecoverable.

    Ladder bodies (0x1B) cannot be spliced: they carry a network COUNT, not
    a byte length, so their extent is unknown without a full element walk.
    """
    if obj.tag == BODY_LADDER and new_body is not None:
        raise ValueError("ladder bodies are read-only (no byte-length field)")

    out = bytearray(buf)

    if new_body is not None and obj.tag == BODY_TEXT:
        s, e = obj.body_off, obj.body_off + obj.body_len
        out[s:e] = new_body
        struct.pack_into("<I", out, obj.body_off - 4, len(new_body))  # u32!

    if new_decl is not None:
        s, e = obj.decl_off, obj.decl_off + obj.decl_len
        out[s:e] = new_decl
        struct.pack_into("<I", out, obj.decl_len_off, len(new_decl))

    return bytes(out)


# ---------------------------------------------------------------- cli


def load(path):
    data = open(path, "rb").read()
    if data[:8] != MAGIC:
        raise SystemExit(f"{path}: not a CoDeSys+ container")
    return data


def cmd_info(path):
    buf = load(path)
    ver = None
    m = re.search(rb"\d+\.\d+\.\d+\.\d+", buf[:120])
    if m:
        ver = m.group(0).decode()
    objs = parse_objects(buf)
    print(f"file        : {path}")
    print(f"size        : {len(buf)} bytes")
    print(f"version     : {ver}")
    print(f"objects     : {len(objs)}")
    for t in sorted(TYPE_NAMES):
        n = sum(1 for o in objs if o.typ == t)
        if n:
            print(f"  {TYPE_NAMES[t]:9s}: {n}")
    print(f"text bodies : {sum(1 for o in objs if o.tag == BODY_TEXT)}")
    print(f"ladder      : {sum(1 for o in objs if o.tag == BODY_LADDER)}")
    for t in parse_task_config(buf):
        flag = " [DISABLED]" if t["disabled"] else ""
        print(f"task        : {t['task']} -> {t['program']}{flag}")
    for L in parse_library_table(buf):
        print(f"library     : {L['name']}")
    m = re.search(rb"[A-Z]:\\\\?Users\\[ -~]{5,300}?\.lib", buf[:2000])
    if m:
        print(f"embedded path: {m.group(0).decode('latin1')}")


def cmd_list(path):
    buf = load(path)
    objs = parse_objects(buf)
    print(f"{'name':26s}{'kind':10s}{'id':>6s}{'body':>7s}{'decl':>8s}{'len/net':>9s}")
    for o in sorted(objs, key=lambda x: x.name.lower()):
        extra = o.nnet if o.tag == BODY_LADDER else (o.body_len or 0)
        print(f"{o.name:26s}{o.kind:10s}{o.oid:6d}"
              f"{str(o.body_kind or '-'):>7s}{o.decl_len:8d}{extra:9d}")


def cmd_dump(path, outdir):
    buf = load(path)
    objs = parse_objects(buf)
    os.makedirs(outdir, exist_ok=True)
    n = 0
    for o in objs:
        ext = ".st" if o.typ == TYPE_POU else ".txt"
        p = os.path.join(outdir, f"{o.name}{ext}")
        with open(p, "wb") as f:
            f.write(o.decl(buf))
            b = o.body(buf)
            if b:
                f.write(b"\r\n")
                f.write(b)
            elif o.tag == BODY_LADDER:
                f.write(b"\r\n(* LADDER: %d networks - binary, read-only *)"
                        % o.nnet)
        n += 1
    print(f"wrote {n} files to {outdir}")


def ladder_extent(buf, obj, objs):
    """
    Authoritative end of a ladder body, via the element walker.
    The format stores no byte length for ladder bodies - only a network
    count - so the extent must be derived structurally.
    """
    if ldwalk is None:
        return None, None, None
    hard = min([o.hdr_off for o in objs if o.hdr_off > obj.body_off]
               or [len(buf)])
    nets, footer, end = ldwalk.walk_body(buf, obj.body_off, obj.nnet, hard)
    return nets, footer, end


def cmd_ladder(path, which=None):
    buf = load(path)
    objs = parse_objects(buf)
    if ldwalk is None:
        raise SystemExit("ldwalk.py not found")
    for o in objs:
        if o.tag != BODY_LADDER:
            continue
        if which and o.name != which:
            continue
        nets, footer, end = ladder_extent(buf, o, objs)
        print(f"===== {o.name}  ({o.nnet} networks, "
              f"body {o.body_off}..{end}, {end - o.body_off} bytes)")
        for n in nets:
            if n.comment:
                print(f"  (* {n.comment} *)")
            print("\n".join(ldwalk.render_network(n)))
        print()


def cmd_verify(path):
    buf = load(path)
    objs = parse_objects(buf)
    res = verify(buf, objs)
    fails = [r for r in res if not r[1]]
    for name, ok, detail in res:
        if not ok:
            print(f"FAIL  {name}  {detail}")
    rt = rebuild_noop(buf, objs)
    ok_rt = rt == buf
    print(f"\nchecks run      : {len(res)}")
    print(f"failures        : {len(fails)}")
    print(f"no-op round-trip: {'BYTE-EXACT' if ok_rt else 'MISMATCH'}")
    return 0 if (not fails and ok_rt) else 1


def cmd_decrypt(path, out):
    data = open(path, "rb").read()
    plain = decrypt_lib(data)
    if not looks_decrypted(plain):
        print("WARNING: sentinel check failed (expected 0x0B 'SERIAL10COM' @20)")
    open(out, "wb").write(plain)
    # XOR is an involution - verify it re-encrypts exactly
    assert decrypt_lib(plain) == data, "round-trip failed"
    print(f"decrypted {len(plain)} bytes -> {out}  (re-encrypt verified)")


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    cmd, path = sys.argv[1], sys.argv[2]
    if cmd == "info":
        return cmd_info(path)
    if cmd == "list":
        return cmd_list(path)
    if cmd == "dump":
        return cmd_dump(path, sys.argv[3])
    if cmd == "verify":
        return cmd_verify(path)
    if cmd == "ladder":
        return cmd_ladder(path, sys.argv[3] if len(sys.argv) > 3 else None)
    if cmd == "decrypt":
        return cmd_decrypt(path, sys.argv[3])
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main() or 0)
