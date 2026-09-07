import re, os

BASE = r"C:\Daifuku RAG Dev\Active\CoDeSys-V2.3-Text-Editor\TEST CORPUS"
exp_path = os.path.join(BASE, "EXPORT.EXP")
pro_path = os.path.join(BASE, "101079 BSL.pro")

with open(exp_path, "r", encoding="latin-1") as f:
    exp_text = f.read()
with open(pro_path, "rb") as f:
    pro_data = f.read()

POUS = ["CanopyControl", "ControlledBuffer", "HybridControl", "GlobalFlags", "Intrusion", "RearTrack"]

def exp_slice(name):
    m = re.search(rf"\b(PROGRAM|FUNCTION_BLOCK)\s+{name}\b", exp_text)
    if not m:
        return None, None
    kind = m.group(1)
    start = m.start()
    endkw = "END_PROGRAM" if kind == "PROGRAM" else "END_FUNCTION_BLOCK"
    m2 = re.search(rf"\r?\n{endkw}\b", exp_text[start:])
    end = start + (m2.end() if m2 else 2000)
    return kind, exp_text[start:end]

def extract_contacts(text):
    return re.findall(r"_LD_CONTACT\r?\n(\w+)\r?\n_EXPRESSION\r?\n_(POSITIV|NEGATIV)", text)

def extract_outputs(text):
    return re.findall(r"_OUTPUT\r?\n_(POSITIV|NEGATIV)\r?\n_(NO_SET|SET|RESET)\r?\n(\w+)", text)

def extract_markers(text):
    # find all _XXX style uppercase tokens on their own line, in order, to see structure
    return re.findall(r"^_[A-Z_]+$", text, re.M)

# 1) find true binary offsets for PROGRAM/FUNCTION_BLOCK <name> as ascii text (latin1)
def find_pou_binary_offset(name, kind_hint=None):
    hits = []
    for kind in (["PROGRAM", "FUNCTION_BLOCK"] if not kind_hint else [kind_hint]):
        pat = f"{kind} {name}".encode("latin-1")
        idx = 0
        while True:
            idx = pro_data.find(pat, idx)
            if idx == -1:
                break
            hits.append((kind, idx))
            idx += 1
    return hits

def scan_binary_markers(start, end):
    results = []
    i = start
    while i < end - 4:
        if pro_data[i] == 0x08 and pro_data[i+1] == 0xff:
            flag = pro_data[i+2]
            length = pro_data[i+3]
            if 1 <= length <= 40 and i+4+length <= end:
                candidate = pro_data[i+4:i+4+length]
                if all(32 <= b < 127 for b in candidate):
                    name = candidate.decode("ascii")
                    results.append((i, flag, length, name))
                    i += 4 + length
                    continue
        i += 1
    return results

def bytes_between(a, b, limit=40):
    seg = pro_data[a:b]
    return seg[-limit:] if len(seg) > limit else seg

print("STEP 1+2: EXP ground truth + binary offset verification\n")

pou_ranges = {}
for name in POUS:
    print("=" * 70)
    print(name)
    kind, body = exp_slice(name)
    if body is None:
        print("  NOT FOUND in EXP as PROGRAM/FUNCTION_BLOCK")
        continue
    contacts = extract_contacts(body)
    outputs = extract_outputs(body)
    markers = extract_markers(body)
    print(f"  EXP kind: {kind}, body length {len(body)} chars")
    print(f"  EXP contacts (name, polarity) in order: {contacts}")
    print(f"  EXP outputs (polarity, set/reset, name) in order: {outputs}")
    # dedupe consecutive markers, show unique structural tokens with counts in order
    print(f"  EXP structural markers (first 40, in order): {markers[:40]}")

    hits = find_pou_binary_offset(name, kind)
    print(f"  Binary text-header hits for '{kind} {name}': {[(k, off) for k,off in hits]}")

    if not hits:
        continue
    bin_start = hits[0][1]
    # find next POU's header start to bound this range, else look ahead 20000 bytes
    idx_in_list = POUS.index(name)
    # search all remaining names for next occurring binary offset after bin_start
    next_offsets = []
    for other in POUS:
        for k2, off2 in find_pou_binary_offset(other):
            if off2 > bin_start:
                next_offsets.append(off2)
    bin_end = min(next_offsets) if next_offsets else bin_start + 20000
    pou_ranges[name] = (bin_start, bin_end)
    print(f"  Verified/derived binary range: ({bin_start}, {bin_end})  [old hardcoded range given in task]")

    markers_hits = scan_binary_markers(bin_start, bin_end)
    print(f"  BIN 0x08 0xFF markers ({len(markers_hits)}):")
    for off, flag, length, nm in markers_hits:
        print(f"    off={off:6d} flag=0x{flag:02x} len={length:2d} name={nm}")

    # combine EXP contacts+outputs into single ordered list of (role, polarity/setreset, name)
    exp_seq = []
    for nm, pol in contacts:
        exp_seq.append(("CONTACT", pol, None, nm))
    for pol, sr, nm in outputs:
        exp_seq.append(("OUTPUT", pol, sr, nm))
    # Note: contacts/outputs extracted independently lose true interleave order; redo combined scan
    combined = re.findall(r"(_LD_CONTACT\r?\n\w+\r?\n_EXPRESSION\r?\n_(?:POSITIV|NEGATIV)|_OUTPUT\r?\n_(?:POSITIV|NEGATIV)\r?\n_(?:NO_SET|SET|RESET)\r?\n\w+)", body)
    print(f"  Combined ordered EXP elements ({len(combined)}):")
    for c in combined:
        print("   ", c.replace("\n", " | ")[:60])

    print(f"  --> counts: EXP contacts={len(contacts)} EXP outputs={len(outputs)} total={len(combined)} vs BIN markers={len(markers_hits)}")
