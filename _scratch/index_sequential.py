"""
Pass 3: sequential-walk hypothesis.

1. Get confirmed 0x08 0xFF markers per POU with binary offset + matched EXP ordinal.
2. Measure raw byte distance between consecutive markers, normalize by subtracting
   name length, look for a common base record width.
3. Walk sequentially from a marker's end, one "record" per EXP element, extract
   candidate operand bytes for non-marker elements, print them raw for inspection,
   and test operand against global-list index (all / bool-only, 0/1-based).
4. Also test: is polarity better explained as a per-network bitmask than per-element.
"""
import re, os
from collections import Counter

BASE = r"C:\Daifuku RAG Dev\Active\CoDeSys-V2.3-Text-Editor\TEST CORPUS"
exp_path = os.path.join(BASE, "EXPORT.EXP")
pro_path = os.path.join(BASE, "101079 BSL.pro")

with open(exp_path, "r", encoding="latin-1") as f:
    exp_text = f.read()
with open(pro_path, "rb") as f:
    pro_data = f.read()

RAW_STARTS = {
    "CanopyControl": 292239,
    "ControlledBuffer": 294118,
    "GlobalFlags": 299057,
    "HybridControl": 299972,
    "Intrusion": 303754,
    "RearTrack": 319814,
}
POUS = list(RAW_STARTS.keys())
sorted_starts = sorted(RAW_STARTS.values())


def bin_range(name):
    s = RAW_STARTS[name]
    later = [x for x in sorted_starts if x > s]
    e = min(later) if later else s + 20000
    return s, e


def exp_slice(name):
    m = re.search(rf"\b(PROGRAM|FUNCTION_BLOCK)\s+{name}\b", exp_text)
    if not m:
        return None, None
    kind = m.group(1)
    start = m.start()
    endkw = "END_PROGRAM" if kind == "PROGRAM" else "END_FUNCTION_BLOCK"
    m2 = re.search(rf"\r?\n{endkw}\b", exp_text[start:])
    end = start + (m2.end() if m2 else 4000)
    return kind, exp_text[start:end]


def extract_combined_ordered(body):
    pat = re.compile(
        r"_LD_CONTACT\r?\n(?P<cname>\w+)\r?\n_EXPRESSION\r?\n_(?P<cpol>POSITIV|NEGATIV)"
        r"|_OUTPUT\r?\n_(?P<opol>POSITIV|NEGATIV)\r?\n_(?P<omode>NO_SET|SET|RESET)\r?\n(?P<oname>\w+)"
    )
    seq = []
    for m in pat.finditer(body):
        if m.group("cname"):
            seq.append({"role": "CONTACT", "name": m.group("cname"), "pol": m.group("cpol")})
        else:
            seq.append({"role": "OUTPUT", "name": m.group("oname"), "pol": m.group("opol"), "mode": m.group("omode")})
    return seq


def scan_markers(start, end):
    results = []
    i = start
    while i < end - 4:
        if pro_data[i] == 0x08 and pro_data[i + 1] == 0xFF:
            flag = pro_data[i + 2]
            length = pro_data[i + 3]
            if 1 <= length <= 40 and i + 4 + length <= end:
                cand = pro_data[i + 4:i + 4 + length]
                if all(32 <= b < 127 for b in cand):
                    results.append((i, flag, length, cand.decode("ascii")))
                    i += 4 + length
                    continue
        i += 1
    return results


def find_end_var(start, end):
    idx = pro_data.find(b"END_VAR", start, end)
    return idx + len(b"END_VAR") if idx != -1 else start


gvl_blocks = list(re.finditer(r"VAR_GLOBAL\b[^\n]*\r?\n(.*?)\r?\nEND_VAR", exp_text, re.S))
global_names, global_bool_names = [], []
for b in gvl_blocks:
    for line in b.group(1).splitlines():
        line = line.strip()
        if not line or line.startswith("(*"):
            continue
        mm = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)\s*(?:AT[^:]*)?:\s*([A-Za-z_][A-Za-z0-9_.\[\] ]*)", line)
        if mm:
            nm, ty = mm.group(1), mm.group(2).strip()
            global_names.append(nm)
            if ty.upper().startswith("BOOL"):
                global_bool_names.append(nm)


def idx_of(lst, nm, base):
    try:
        return lst.index(nm) + base
    except ValueError:
        return None


print("=" * 78)
print("STEP A: marker-to-marker distances, normalized by name length")
print("=" * 78)

pou_data = {}
for name in POUS:
    kind, body = exp_slice(name)
    if body is None:
        continue
    seq = extract_combined_ordered(body)
    bstart, bend = bin_range(name)
    markers = scan_markers(bstart, bend)
    body_start = find_end_var(bstart, bend)
    pou_data[name] = dict(seq=seq, markers=markers, bstart=bstart, bend=bend, body_start=body_start)

    print(f"\n{name}: {len(markers)} markers, seq_len={len(seq)}, body_start={body_start}")
    for off, flag, length, nm in markers:
        print(f"  marker off={off} flag=0x{flag:02x} len={length} name={nm}")
    for i in range(1, len(markers)):
        prev_off, _, prev_len, prev_nm = markers[i - 1]
        cur_off, _, cur_len, cur_nm = markers[i]
        raw_dist = cur_off - prev_off
        record_total = raw_dist  # includes prev marker's own header+name
        norm = raw_dist - prev_len  # subtract prev name length (marker header 4 bytes fixed)
        print(f"  gap {prev_nm!r}->{cur_nm!r}: raw_dist={raw_dist} minus_prev_namelen={norm}")

print("\n" + "=" * 78)
print("STEP B: bytes from body_start to first marker (pre-marker header region)")
print("=" * 78)
for name, d in pou_data.items():
    if not d["markers"]:
        continue
    first_off = d["markers"][0][0]
    seg = pro_data[d["body_start"]:first_off]
    print(f"\n{name}: body_start={d['body_start']} first_marker={first_off} gap={len(seg)} bytes")
    print("  hex:", seg.hex(" "))

print("\n" + "=" * 78)
print("STEP C: sequential walk - assume fixed record width R immediately after a")
print("marker's name ends; try small R values (2..12) and see if walking forward")
print("one record per remaining EXP element lands on plausible small-int operand")
print("bytes, using marker positions as resync anchors")
print("=" * 78)


def walk_with_width(d, width):
    """Return list of (el, record_bytes) by walking seq in order, treating markers
    as consuming their real header+name width and everything else as `width` bytes,
    resyncing to actual marker offset whenever we hit a marker element."""
    seq = d["seq"]
    markers = d["markers"]
    marker_by_name = {}
    for off, flag, length, nm in markers:
        marker_by_name.setdefault(nm, []).append((off, flag, length))

    pos = d["body_start"]
    out = []
    used_marker_idx = {nm: 0 for nm in marker_by_name}
    ok = True
    for el in seq:
        nm = el["name"]
        if nm in marker_by_name and used_marker_idx[nm] < len(marker_by_name[nm]):
            off, flag, length = marker_by_name[nm][used_marker_idx[nm]]
            used_marker_idx[nm] += 1
            if off < pos:
                # marker already behind current cursor -> desync, bail
                out.append((el, None))
                continue
            record_bytes = pro_data[pos:off + 4 + length]
            pos = off + 4 + length
            out.append((el, record_bytes))
        else:
            record_bytes = pro_data[pos:pos + width]
            pos += width
            out.append((el, record_bytes))
    return out


for name, d in pou_data.items():
    print(f"\n--- {name} ---")
    for width in range(2, 10):
        walk = walk_with_width(d, width)
        non_marker_ops = [(el, rb) for el, rb in walk if rb is not None and el["name"] not in
                          [m[3] for m in d["markers"]]]
        # crude plausibility score: operand's last byte (as index candidate) found in global list
        hits = 0
        total = 0
        for el, rb in non_marker_ops:
            if len(rb) < 1:
                continue
            total += 1
            last = rb[-1]
            if idx_of(global_names, el["name"], 0) == last or idx_of(global_names, el["name"], 1) == last:
                hits += 1
        print(f"  width={width}: non_marker_records={total} global_idx_lastbyte_hits={hits}")

print("\n" + "=" * 78)
print("STEP D: print raw record bytes per element for width=4 and width=6, two POUs")
print("(visual inspection: plausible small ints vs garbage)")
print("=" * 78)
for name in ["CanopyControl", "Intrusion"]:
    if name not in pou_data:
        continue
    d = pou_data[name]
    for width in (4, 6):
        print(f"\n{name} width={width}:")
        walk = walk_with_width(d, width)
        for el, rb in walk:
            tag = "MARKER" if el["name"] in [m[3] for m in d["markers"]] else "plain"
            rbh = rb.hex(" ") if rb is not None else "DESYNC"
            print(f"  {el['role']:8s} {el['name']:20s} pol={el.get('pol','-'):8s} [{tag:6s}] bytes={rbh}")

print("\n" + "=" * 78)
print("STEP E: polarity-as-bitmask check - look at bytes right after each")
print("_NETWORK marker in EXP order vs binary; search for a byte whose bit pattern")
print("correlates with per-element POSITIV/NEGATIV across the POU")
print("=" * 78)
NETWORK_RE = re.compile(r"_NETWORK\b")
for name, d in pou_data.items():
    kind, body = exp_slice(name)
    net_positions = [m.start() for m in NETWORK_RE.finditer(body)]
    print(f"{name}: {len(net_positions)} _NETWORK markers in EXP, seq_len={len(d['seq'])}")
