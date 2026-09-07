"""
Test hypothesis: non-first LD element references in the .pro binary are encoded
as a small integer INDEX into the POU's declared-variable list, rather than by name.

Reuses parsing approach from ld_analysis.py (EXP ground truth) but adds:
 - VAR block parsing (declared var order) from EXP text (same decls as .pro)
 - per-POU binary scan after END_VAR for repeating tag+index byte patterns
 - match-rate scoring against declared-var-index and used-var-index (first-appearance) hypotheses
"""
import re, os

BASE = r"C:\Daifuku RAG Dev\Active\CoDeSys-V2.3-Text-Editor\TEST CORPUS"
exp_path = os.path.join(BASE, "EXPORT.EXP")
pro_path = os.path.join(BASE, "101079 BSL.pro")

with open(exp_path, "r", encoding="latin-1") as f:
    exp_text = f.read()
with open(pro_path, "rb") as f:
    pro_data = f.read()

# name -> (bin_start, bin_end) per prior findings; end = next POU's start (sorted)
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


def parse_declared_vars(body):
    """Ordered list of (name, type, is_bool) from all VAR* ... END_VAR blocks, decl order."""
    out = []
    for vm in re.finditer(r"\bVAR(?:_INPUT|_OUTPUT|_IN_OUT)?\b.*?\bEND_VAR\b", body, re.S):
        block = vm.group(0)
        for line in block.splitlines():
            line = line.strip()
            mm = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)\s*(?:AT[^:]*)?:\s*([A-Za-z_][A-Za-z0-9_]*)", line)
            if mm:
                nm, ty = mm.group(1), mm.group(2)
                out.append((nm, ty, ty.upper() == "BOOL"))
    return out


def extract_combined_ordered(body):
    """Ordered list of dicts: role, name, polarity, mode(for output)."""
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


report_rows = []
detail = {}

for name in POUS:
    kind, body = exp_slice(name)
    if body is None:
        print(f"{name}: NOT FOUND in EXP")
        continue
    decl_vars = parse_declared_vars(body)
    decl_names = [v[0] for v in decl_vars]
    bool_names = [v[0] for v in decl_vars if v[2]]
    seq = extract_combined_ordered(body)

    bstart, bend = bin_range(name)
    markers = scan_markers(bstart, bend)
    body_start = find_end_var(bstart, bend)

    # first-appearance "used vars" list, built by walking seq
    used_names = []
    seen = set()
    for el in seq:
        if el["name"] not in seen:
            seen.add(el["name"])
            used_names.append(el["name"])

    # names explained by markers already (first hit per unique name, roughly)
    marker_names = set(nm for _, _, _, nm in markers)

    # remaining elements = those whose name isn't covered by an exact marker match
    # (approx: treat first occurrence of each marker name as "explained")
    explained_first = set()
    remaining = []
    for el in seq:
        if el["name"] in marker_names and el["name"] not in explained_first:
            explained_first.add(el["name"])
            continue
        remaining.append(el)

    # compute candidate indices for each remaining element under 4 hypotheses
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
            "decl_all_1b": idx_of(decl_names, nm, 1),
            "decl_all_0b": idx_of(decl_names, nm, 0),
            "decl_bool_1b": idx_of(bool_names, nm, 1),
            "decl_bool_0b": idx_of(bool_names, nm, 0),
            "used_1b": idx_of(used_names, nm, 1),
            "used_0b": idx_of(used_names, nm, 0),
        })

    # scan the binary body for byte sequences: try to find repeating tag bytes
    # strategy: collect all bytes in body region, look at bytes following END_VAR
    seg = pro_data[body_start:bend]

    detail[name] = {
        "decl_vars": decl_names,
        "bool_vars": bool_names,
        "used_vars": used_names,
        "seq_len": len(seq),
        "markers": markers,
        "remaining": candidates,
        "seg": seg,
        "bstart": bstart,
        "bend": bend,
        "body_start": body_start,
    }

    print(f"\n{'='*70}\n{name}  decl_vars={len(decl_names)} bool_vars={len(bool_names)} "
          f"seq_total={len(seq)} markers={len(markers)} remaining={len(candidates)} seg_bytes={len(seg)}")


# --- Now try to find a byte pattern in `seg` matching candidate indices ---
# Approach: for each POU, for each remaining element in order, try to find, scanning
# forward through seg, a 2-byte window [tag, idx_byte] where idx_byte == one of the
# computed candidate indices (try each hypothesis independently across whole POU,
# requiring STRICT in-order, non-overlapping matches, same tag byte value throughout).

def try_hypothesis(seg, candidates, key):
    """Try to find single consistent tag byte T such that scanning seg for [T, val]
    pairs in order matches candidates[key] values in sequence (all present, in order,
    non-overlapping, forward-only). Returns (tag_byte, match_count) best found."""
    idxs = [c[key] for c in candidates]
    if any(v is None for v in idxs):
        return None, 0, len(idxs)
    best_tag, best_count = None, -1
    for tag in range(256):
        pos = 0
        count = 0
        for val in idxs:
            found = -1
            i = pos
            while i < len(seg) - 1:
                if seg[i] == tag and seg[i + 1] == val:
                    found = i
                    break
                i += 1
            if found == -1:
                break
            count += 1
            pos = found + 2
        if count > best_count:
            best_count = count
            best_tag = tag
    return best_tag, best_count, len(idxs)


print("\n\n" + "#" * 70)
print("HYPOTHESIS TESTING: tag-byte + index-byte pattern search")
print("#" * 70)

HYPOTHESES = ["decl_all_1b", "decl_all_0b", "decl_bool_1b", "decl_bool_0b", "used_1b", "used_0b"]
totals = {h: [0, 0] for h in HYPOTHESES}

for name, d in detail.items():
    cands = d["remaining"]
    if not cands:
        print(f"\n{name}: no remaining elements to test (all explained by markers)")
        continue
    print(f"\n{name}: testing {len(cands)} remaining elements")
    for h in HYPOTHESES:
        tag, count, total = try_hypothesis(d["seg"], cands, h)
        totals[h][0] += count
        totals[h][1] += total
        flag = "  <-- BEST" if False else ""
        print(f"  {h:16s} tag={tag if tag is not None else '--':>4} match={count}/{total}{flag}")

print("\n\nCOMBINED MATCH RATES ACROSS ALL POUS:")
for h in HYPOTHESES:
    m, t = totals[h]
    pct = (100.0 * m / t) if t else 0.0
    print(f"  {h:16s} {m}/{t}  ({pct:.1f}%)")
