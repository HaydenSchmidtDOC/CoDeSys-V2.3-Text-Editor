import re, os
from collections import Counter

BASE = r"C:\Daifuku RAG Dev\Active\CoDeSys-V2.3-Text-Editor\TEST CORPUS"
with open(os.path.join(BASE, "EXPORT.EXP"), "r", encoding="latin-1") as f:
    exp_text = f.read()
with open(os.path.join(BASE, "101079 BSL.pro"), "rb") as f:
    pro_data = f.read()

RAW_STARTS = {"CanopyControl": 292239, "ControlledBuffer": 294118, "GlobalFlags": 299057,
              "HybridControl": 299972, "Intrusion": 303754, "RearTrack": 319814}
sorted_starts = sorted(RAW_STARTS.values())


def bin_range(name):
    s = RAW_STARTS[name]
    later = [x for x in sorted_starts if x > s]
    e = min(later) if later else s + 20000
    return s, e


def exp_slice(name):
    m = re.search(rf"\b(PROGRAM|FUNCTION_BLOCK)\s+{name}\b", exp_text)
    kind = m.group(1)
    start = m.start()
    endkw = "END_PROGRAM" if kind == "PROGRAM" else "END_FUNCTION_BLOCK"
    m2 = re.search(rf"\r?\n{endkw}\b", exp_text[start:])
    end = start + (m2.end() if m2 else 4000)
    return exp_text[start:end]


def extract_combined_ordered(body):
    pat = re.compile(
        r"_LD_CONTACT\r?\n(?P<cname>\w+)\r?\n_EXPRESSION\r?\n_(?P<cpol>POSITIV|NEGATIV)"
        r"|_OUTPUT\r?\n_(?P<opol>POSITIV|NEGATIV)\r?\n_(?P<omode>NO_SET|SET|RESET)\r?\n(?P<oname>\w+)"
    )
    seq = []
    for m in pat.finditer(body):
        if m.group("cname"):
            seq.append(("CONTACT", m.group("cname"), m.group("cpol")))
        else:
            seq.append(("OUTPUT", m.group("oname"), m.group("opol")))
    return seq


def scan_generic(start, end):
    res = []
    i = start
    while i < end - 2:
        length = pro_data[i + 1]
        if 1 <= length <= 40 and i + 2 + length <= end:
            cand = pro_data[i + 2:i + 2 + length]
            if all(32 <= b < 127 for b in cand):
                res.append((i, pro_data[i], length, cand.decode("ascii")))
                i += 2 + length
                continue
        i += 1
    return res


for name in RAW_STARTS:
    body = exp_slice(name)
    seq = extract_combined_ordered(body)
    s, e = bin_range(name)
    hits = scan_generic(s, e)
    names_in_seq = [n for _, n, _ in seq]
    hitnames = [h[3] for h in hits]
    avail = Counter(hitnames)
    matched = 0
    for n in names_in_seq:
        if avail[n] > 0:
            matched += 1
            avail[n] -= 1
    print(f"{name}: EXP_elements={len(seq)} generic_string_hits={len(hits)} matched_by_name={matched}/{len(seq)}")
