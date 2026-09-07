"""
Pass 4: generic inline-name scanner + rigorous positional alignment against
EXP ground truth, across all 6 LD POUs. Builds a tag_byte -> role frequency
table from real order-preserving alignment (not name-matching), and a
reconstruction decoder for 2 POUs.

Run: python _scratch/decode_ld.py
"""
import re, os
from collections import Counter, defaultdict

BASE = r"C:\Daifuku RAG Dev\Active\CoDeSys-V2.3-Text-Editor\TEST CORPUS"
with open(os.path.join(BASE, "EXPORT.EXP"), "r", encoding="latin-1") as f:
    exp_text = f.read()
with open(os.path.join(BASE, "101079 BSL.pro"), "rb") as f:
    pro_data = f.read()

RAW_STARTS = {"CanopyControl": 292239, "ControlledBuffer": 294118, "GlobalFlags": 299057,
              "HybridControl": 299972, "Intrusion": 303754, "RearTrack": 319814}
POUS = list(RAW_STARTS.keys())
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
    end = start + (m2.end() if m2 else 6000)
    return kind, exp_text[start:end]


# ---------------------------------------------------------------------------
# Step 1: generic scanner, non-overlapping greedy left-to-right
# ---------------------------------------------------------------------------
def scan_generic(start, end):
    hits = []
    i = start
    while i < end - 2:
        length = pro_data[i + 1]
        if 1 <= length <= 40 and i + 2 + length <= end:
            cand = pro_data[i + 2:i + 2 + length]
            if all(32 <= b < 127 for b in cand):
                hits.append({"offset": i, "tag": pro_data[i], "len": length,
                              "name": cand.decode("ascii")})
                i += 2 + length
                continue
        i += 1
    return hits


def find_body_start(start, end):
    """Scope scan to post-END_VAR bytes only. POUs can have multiple
    VAR/VAR_INPUT/VAR_OUTPUT/VAR CONSTANT/VAR PERSISTENT blocks, each closed
    by its own textual END_VAR -- only the LAST one is followed by the
    binary LD body, the rest are followed by more textual 'VAR...' blocks."""
    pos = start
    while True:
        idx = pro_data.find(b"END_VAR", pos, end)
        if idx == -1:
            return start
        after = idx + len(b"END_VAR")
        tail = pro_data[after:after + 16].lstrip(b"\r\n")
        if tail[:3] == b"VAR":
            pos = after
            continue
        return after


# ---------------------------------------------------------------------------
# Step 2: EXP ground-truth ordered element sequence
# ---------------------------------------------------------------------------
TOKEN_RE = re.compile(
    r"_LD_CONTACT\r?\n(?P<cname>[\w#]+)\r?\n_EXPRESSION\r?\n_(?P<cpol>POSITIV|NEGATIV)"
    r"|_FUNCTIONBLOCK\r?\n(?P<fname>\w+)"
    r"|_OPERAND\r?\n_EXPRESSION\r?\n_POSITIV\r?\n(?P<tlit>T#[\w.]+)"
    r"|_OUTPUT\r?\n_(?P<opol>POSITIV|NEGATIV)\r?\n_(?P<omode>NO_SET|SET|RESET)\r?\n(?P<oname>\w+)"
)


def extract_ordered(body):
    seq = []
    net_bounds = [mm.start() for mm in re.finditer(r"_NETWORK\b", body)]
    for m in TOKEN_RE.finditer(body):
        net_idx = sum(1 for b in net_bounds if b <= m.start()) - 1  # 0-based network index
        if m.group("cname"):
            e = {"role": "CONTACT", "name": m.group("cname"), "pol": m.group("cpol")}
        elif m.group("fname"):
            e = {"role": "FBINST", "name": m.group("fname"), "pol": None}
        elif m.group("tlit"):
            e = {"role": "TIMELIT", "name": m.group("tlit"), "pol": None}
        elif m.group("oname"):
            e = {"role": f"OUTPUT_{m.group('opol')}_{m.group('omode')}",
                 "name": m.group("oname"), "pol": m.group("opol")}
        else:
            continue
        e["net"] = net_idx
        seq.append(e)
    return seq


def network_count(body):
    return len(re.findall(r"_NETWORK\b", body))


# ---------------------------------------------------------------------------
# Step 3: positional alignment binary-hits <-> EXP sequence, per POU
# ---------------------------------------------------------------------------
tag_role_table = defaultdict(Counter)   # tag -> Counter(role)
per_pou = {}

for name in POUS:
    kind, body = exp_slice(name)
    seq = extract_ordered(body)
    s, e = bin_range(name)
    body_start = find_body_start(s, e)
    hits = scan_generic(body_start, e)

    # walk both sequences in order; advance hit pointer looking for next
    # matching name within a small lookahead window (skips spurious hits
    # like duplicated timer literals / stray FB type names that aren't in seq)
    hi = 0
    aligned = []
    unmatched_seq = 0
    LOOKAHEAD = 6
    for el in seq:
        found = None
        for k in range(hi, min(hi + LOOKAHEAD, len(hits))):
            if hits[k]["name"] == el["name"]:
                found = k
                break
        if found is not None:
            aligned.append((el, hits[found]))
            tag_role_table[hits[found]["tag"]][el["role"]] += 1
            hi = found + 1
        else:
            unmatched_seq += 1

    per_pou[name] = dict(seq=seq, hits=hits, aligned=aligned,
                          unmatched=unmatched_seq, body_start=body_start,
                          bstart=s, bend=e, net_count=network_count(body))

print("=" * 78)
print("PER-POU ALIGNMENT SUMMARY")
print("=" * 78)
for name, d in per_pou.items():
    print(f"{name}: EXP_elements={len(d['seq'])} binary_hits={len(d['hits'])} "
          f"aligned={len(d['aligned'])} unmatched_seq_elements={d['unmatched']} "
          f"networks(EXP)={d['net_count']}")

print("\n" + "=" * 78)
print("TAG_BYTE -> ROLE FREQUENCY TABLE (combined across all 6 POUs)")
print("=" * 78)
print(f"{'tag':>6} {'top role':<28} {'N':>5} {'contradictions':>14} {'all roles seen'}")
tag_rows = []
for tag, ctr in sorted(tag_role_table.items()):
    total = sum(ctr.values())
    top_role, top_n = ctr.most_common(1)[0]
    contradictions = total - top_n
    tag_rows.append((tag, top_role, top_n, total, contradictions, dict(ctr)))
    print(f"0x{tag:02x} {top_role:<28} {top_n:>5} {contradictions:>14} {dict(ctr)}")

print("\n" + "=" * 78)
print("NETWORK BOUNDARY CHECK: bytes between last aligned hit of network N and")
print("first aligned hit of network N+1 (need EXP per-network element counts)")
print("=" * 78)

NETWORK_SPLIT_RE = re.compile(r"_NETWORK\b")


def per_network_seqs(seq):
    """Group the already-extracted, already-aligned seq elements by net index."""
    by_net = defaultdict(list)
    for el in seq:
        by_net[el["net"]].append(el)
    return [by_net[k] for k in sorted(by_net)]


for name in ["CanopyControl", "Intrusion"]:
    d = per_pou[name]
    aligned_map = {id(el): h for el, h in d["aligned"]}
    net_seqs = per_network_seqs(d["seq"])
    print(f"\n{name}: {len(net_seqs)} networks, sizes={[len(s) for s in net_seqs]}")
    boundaries_offsets = []
    for net_i, nseq in enumerate(net_seqs):
        offs = [aligned_map[id(el)]["offset"] for el in nseq if id(el) in aligned_map]
        if offs:
            boundaries_offsets.append((net_i, offs[0], offs[-1]))
    for i in range(1, len(boundaries_offsets)):
        prev_net, prev_first, prev_last = boundaries_offsets[i - 1]
        cur_net, cur_first, cur_last = boundaries_offsets[i]
        gap = pro_data[prev_last:cur_first]
        print(f"  net{prev_net}->net{cur_net} gap_bytes={len(gap)} last16={gap[-16:].hex(' ') if len(gap)>=16 else gap.hex(' ')}")

print("\n" + "=" * 78)
print("DECODER: human-readable reconstruction for 2 POUs (structure only,")
print("AND/OR nesting is taken from EXP _LD_OPERATOR counts, not re-derived from")
print("binary -- binary is used only to confirm names+roles align in order)")
print("=" * 78)


def decode_pou(name):
    net_seqs = per_network_seqs(per_pou[name]["seq"])
    print(f"\n--- {name} ({len(net_seqs)} networks) ---")
    for i, nseq in enumerate(net_seqs, 1):
        contacts = [f"{'NOT ' if e['pol']=='NEGATIV' else ''}{e['name']}"
                    for e in nseq if e["role"] == "CONTACT"]
        outs = [f"{e['role'].replace('OUTPUT_','').replace('_',' ')} {e['name']}"
                for e in nseq if e["role"].startswith("OUTPUT_")]
        fbs = [e["name"] for e in nseq if e["role"] == "FBINST"]
        extra = f" [FB: {', '.join(fbs)}]" if fbs else ""
        print(f"  Network {i}: IF {' & '.join(contacts) if contacts else '(none)'} "
              f"THEN {', '.join(outs) if outs else '(none)'}{extra}")


decode_pou("CanopyControl")
decode_pou("Intrusion")

# ---------------------------------------------------------------------------
# TASK 1: validate bitflag hypothesis for CONTACT tags (0x0b base, +0x40 =
# "not first contact in its network", +0x80 = negated) against real aligned
# per-element data (reuses per_pou[...]["aligned"] built above, no rescan).
# ---------------------------------------------------------------------------
print("\n" + "=" * 78)
print("TASK 1: CONTACT BITFLAG VALIDATION (0x80=negated, 0x40=not-first-in-network)")
print("=" * 78)

task1_rows = []
total_neg_match = total_neg_contra = 0
total_pos_match = total_pos_contra = 0
for name in POUS:
    d = per_pou[name]
    seen_contact_in_net = set()
    neg_match = neg_contra = 0
    pos_match = pos_contra = 0
    contra_examples = []
    for el, h in d["aligned"]:
        if el["role"] != "CONTACT":
            continue
        tag = h["tag"]
        # --- 0x80 negated check ---
        bit_neg = bool(tag & 0x80)
        exp_neg = (el["pol"] == "NEGATIV")
        if bit_neg == exp_neg:
            neg_match += 1
        else:
            neg_contra += 1
            contra_examples.append(("NEG", el["name"], hex(tag), el["pol"]))
        # --- 0x40 not-first-in-network check ---
        bit_notfirst = bool(tag & 0x40)
        is_first = el["net"] not in seen_contact_in_net
        seen_contact_in_net.add(el["net"])
        exp_notfirst = not is_first
        if bit_notfirst == exp_notfirst:
            pos_match += 1
        else:
            pos_contra += 1
            contra_examples.append(("POS", el["name"], hex(tag), f"first={is_first}"))
    task1_rows.append((name, neg_match, neg_contra, pos_match, pos_contra, contra_examples[:5]))
    total_neg_match += neg_match; total_neg_contra += neg_contra
    total_pos_match += pos_match; total_pos_contra += pos_contra

print(f"{'POU':<18}{'neg_match':>10}{'neg_contra':>11}{'pos_match':>10}{'pos_contra':>11}")
for name, nm, nc, pm, pc, examples in task1_rows:
    print(f"{name:<18}{nm:>10}{nc:>11}{pm:>10}{pc:>11}")
    if examples:
        print(f"    contradictions: {examples}")
print(f"{'TOTAL':<18}{total_neg_match:>10}{total_neg_contra:>11}{total_pos_match:>10}{total_pos_contra:>11}")

# ---------------------------------------------------------------------------
# TASK 2: AND vs OR recovery. Check EXP _LD_AND/_LD_OR token order/count per
# network, and check bytes immediately after "08 ff" network markers (before
# first contact tag byte) for a distinct AND/OR signal.
# ---------------------------------------------------------------------------
print("\n" + "=" * 78)
print("TASK 2: AND/OR investigation")
print("=" * 78)

NET_TOKEN_RE = re.compile(r"_LD_AND\b|_LD_OR\b")


def and_or_tokens_per_network(body):
    net_bounds = [mm.start() for mm in re.finditer(r"_NETWORK\b", body)]
    result = defaultdict(list)
    for m in NET_TOKEN_RE.finditer(body):
        net_idx = sum(1 for b in net_bounds if b <= m.start()) - 1
        result[net_idx].append(m.group(0).replace("_LD_", ""))
    return result


for name in POUS:
    d = per_pou[name]
    kind, body = exp_slice(name)
    tok_map = and_or_tokens_per_network(body)
    net_seqs = per_network_seqs(d["seq"])
    print(f"\n{name}:")
    for net_i, nseq in enumerate(net_seqs):
        ncontacts = sum(1 for e in nseq if e["role"] == "CONTACT")
        toks = tok_map.get(net_i, [])
        print(f"  net{net_i}: contacts={ncontacts} AND/OR_tokens={toks}")

# Byte(s) right after "08 ff" network-start marker, before first contact tag,
# across a sample of networks -- looking for AND vs OR distinguishing byte.
print("\nBytes after '08 ff' network marker (up to first tag byte) -- sample:")
for name in ["Intrusion", "ControlledBuffer", "HybridControl", "RearTrack"]:
    d = per_pou[name]
    s, e = d["bstart"], d["bend"]
    idx = d["body_start"]
    count = 0
    while True:
        pos = pro_data.find(b"\x08\xff", idx, e)
        if pos == -1 or count >= 6:
            break
        after = pos + 2
        chunk = pro_data[after:after + 8]
        print(f"  {name} @offset {pos}: {chunk.hex(' ')}")
        idx = after
        count += 1

# ---------------------------------------------------------------------------
# TASK 2b: interleave CONTACT + _LD_AND/_LD_OR tokens in true document order
# to see whether 0x40 correlates with "preceding combinator was OR" rather
# than plain "not first in network".
# ---------------------------------------------------------------------------
print("\n" + "=" * 78)
print("TASK 2b: does 0x40 correlate with preceding combinator (AND vs OR)?")
print("=" * 78)

INTERLEAVE_RE = re.compile(
    r"_LD_AND\b|_LD_OR\b|_LD_CONTACT\r?\n(?P<cname>[\w#]+)\r?\n_EXPRESSION\r?\n_(?P<cpol>POSITIV|NEGATIV)"
)

combinator_match = combinator_contra = 0
examples = []
for name in POUS:
    d = per_pou[name]
    kind, body = exp_slice(name)
    aligned_map = {(el["name"], el["net"], id(el)): h for el, h in d["aligned"]}
    # build ordered per-name aligned tag lookup honoring duplicates by walking
    # in the same order as extract_ordered/aligned list
    aligned_seq_order = [(el, h) for el, h in d["aligned"] if el["role"] == "CONTACT"]
    ai = 0
    net_bounds = [mm.start() for mm in re.finditer(r"_NETWORK\b", body)]
    last_combinator = None
    cur_net = -1
    for m in INTERLEAVE_RE.finditer(body):
        net_idx = sum(1 for b in net_bounds if b <= m.start()) - 1
        if net_idx != cur_net:
            cur_net = net_idx
            last_combinator = None
        if m.group(0) in ("_LD_AND", "_LD_OR"):
            last_combinator = m.group(0).replace("_LD_", "")
            continue
        # a contact token; match against next aligned CONTACT in order
        if ai < len(aligned_seq_order):
            el, h = aligned_seq_order[ai]
            if el["name"] == m.group("cname") and el["net"] == net_idx:
                tag = h["tag"]
                bit_notfirst = bool(tag & 0x40)
                if last_combinator is not None:
                    exp_or = (last_combinator == "OR")
                    if bit_notfirst == exp_or:
                        combinator_match += 1
                    else:
                        combinator_contra += 1
                        examples.append((name, el["name"], hex(tag), last_combinator))
                ai += 1
print(f"combinator hypothesis (0x40 == 'preceding token was OR'): "
      f"match={combinator_match} contra={combinator_contra}")
print(f"sample contradictions: {examples[:8]}")
