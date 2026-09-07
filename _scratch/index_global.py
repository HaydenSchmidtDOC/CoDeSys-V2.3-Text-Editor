"""
Test: LD element references not covered by the 0x08 0xFF name-marker are encoded
as a small integer INDEX into the PROJECT-WIDE VAR_GLOBAL declaration order
(concatenation of all VAR_GLOBAL blocks, in file order: BagData, Configs,
Global_Variables, Hardware, TwinCAT_Import(empty)) -- 210 globals total, 173 BOOL.

Reuses extraction machinery from index_hypothesis.py.
"""
import re, os

BASE = r"C:\Daifuku RAG Dev\Active\CoDeSys-V2.3-Text-Editor\TEST CORPUS"
exp_path = os.path.join(BASE, "EXPORT.EXP")
pro_path = os.path.join(BASE, "101079 BSL.pro")

with open(exp_path, "r", encoding="latin-1") as f:
    exp_text = f.read()
with open(pro_path, "rb") as f:
    pro_data = f.read()

RAW_STARTS = {
    "GlobalFlags": 299057,
    "CanopyControl": 292239,
    "ControlledBuffer": 294118,
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


# ---- Build project-wide global var list, in declaration order ----
gvl_blocks = list(re.finditer(r"VAR_GLOBAL\b[^\n]*\r?\n(.*?)\r?\nEND_VAR", exp_text, re.S))
global_names = []
global_bool_names = []
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

print(f"Global vars: {len(global_names)} total, {len(global_bool_names)} BOOL")
assert len(global_names) < 256, "would need 2-byte index"  # 210 < 256, so also test as if >255 not needed

report_rows = []
detail = {}

for name in POUS:
    kind, body = exp_slice(name)
    if body is None:
        print(f"{name}: NOT FOUND in EXP")
        continue
    seq = extract_combined_ordered(body)

    bstart, bend = bin_range(name)
    markers = scan_markers(bstart, bend)
    body_start = find_end_var(bstart, bend)

    marker_names = set(nm for _, _, _, nm in markers)
    explained_first = set()
    remaining = []
    for el in seq:
        if el["name"] in marker_names and el["name"] not in explained_first:
            explained_first.add(el["name"])
            continue
        remaining.append(el)

    def idx_of(lst, nm, base):
        try:
            return lst.index(nm) + base
        except ValueError:
            return None

    candidates = []
    for el in remaining:
        nm = el["name"]
        candidates.append({
            "el": el,
            "g_all_1b": idx_of(global_names, nm, 1),
            "g_all_0b": idx_of(global_names, nm, 0),
            "g_bool_1b": idx_of(global_bool_names, nm, 1),
            "g_bool_0b": idx_of(global_bool_names, nm, 0),
        })

    seg = pro_data[body_start:bend]

    detail[name] = {
        "seq_len": len(seq),
        "markers": markers,
        "remaining": candidates,
        "seg": seg,
        "bstart": bstart,
        "bend": bend,
    }
    n_found = sum(1 for c in candidates if c["g_all_1b"] is not None)
    print(f"{name}: seq={len(seq)} markers={len(markers)} remaining={len(candidates)} "
          f"found_in_globals={n_found}/{len(candidates)}")


def try_hypothesis(seg, candidates, key, mask_high_bit=False):
    """Find single tag byte T s.t. scanning seg for [T,val] in order matches
    candidates[key] in sequence (forward-only, non-overlapping).
    If mask_high_bit, val byte's low 7 bits must match idx, high bit is polarity flag
    (checked separately for correctness against el['pol'])."""
    idxs = [c[key] for c in candidates]
    if any(v is None for v in idxs):
        return None, 0, len(idxs), 0
    best_tag, best_count, best_polhits = None, -1, 0
    for tag in range(256):
        pos = 0
        count = 0
        polhits = 0
        for c, val in zip(candidates, idxs):
            found = -1
            i = pos
            while i < len(seg) - 1:
                b0, b1 = seg[i], seg[i + 1]
                if mask_high_bit:
                    ok = (b0 == tag) and ((b1 & 0x7F) == val)
                else:
                    ok = (b0 == tag) and (b1 == val)
                if ok:
                    found = i
                    break
                i += 1
            if found == -1:
                break
            count += 1
            if mask_high_bit:
                is_neg = bool(seg[found + 1] & 0x80)
                expected_neg = c["el"]["pol"] == "NEGATIV"
                if is_neg == expected_neg:
                    polhits += 1
            pos = found + 2
        if count > best_count:
            best_count = count
            best_tag = tag
            best_polhits = polhits
    return best_tag, best_count, len(idxs), best_polhits


print("\n" + "#" * 70)
print("HYPOTHESIS TESTING: tag-byte + global-list-index byte pattern")
print("#" * 70)

HYPOTHESES = ["g_all_1b", "g_all_0b", "g_bool_1b", "g_bool_0b"]
totals = {h: [0, 0] for h in HYPOTHESES}
totals_mask = {h: [0, 0, 0] for h in HYPOTHESES}

for name, d in detail.items():
    cands = d["remaining"]
    if not cands:
        print(f"\n{name}: no remaining elements (all explained by markers)")
        continue
    print(f"\n{name}: testing {len(cands)} remaining elements")
    for h in HYPOTHESES:
        tag, count, total, _ = try_hypothesis(d["seg"], cands, h)
        totals[h][0] += count
        totals[h][1] += total
        print(f"  {h:12s} plain    tag={tag if tag is not None else '--':>4} match={count}/{total}")
        tag2, count2, total2, polhits = try_hypothesis(d["seg"], cands, h, mask_high_bit=True)
        totals_mask[h][0] += count2
        totals_mask[h][1] += total2
        totals_mask[h][2] += polhits
        print(f"  {h:12s} hibit-pol tag={tag2 if tag2 is not None else '--':>4} match={count2}/{total2} polarity_ok={polhits}/{count2 if count2 else 0}")

print("\n\nCOMBINED MATCH RATES (plain index byte):")
for h in HYPOTHESES:
    m, t = totals[h]
    pct = (100.0 * m / t) if t else 0.0
    print(f"  {h:12s} {m}/{t}  ({pct:.1f}%)")

print("\nCOMBINED MATCH RATES (high-bit-masked index, testing polarity-in-highbit):")
for h in HYPOTHESES:
    m, t, p = totals_mask[h]
    pct = (100.0 * m / t) if t else 0.0
    polpct = (100.0 * p / m) if m else 0.0
    print(f"  {h:12s} {m}/{t}  ({pct:.1f}%)  polarity_correct={p}/{m} ({polpct:.1f}%)")
