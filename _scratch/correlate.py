import re

exp_path = r"c:\Users\Hayden.Schmidt\Daifuku Oceania Limited\Projects - Documents\France\BSL\101079 - BSL Phase 2 Easyjet\110 Low Level Control\Programs\PLC Program\101079 BSL TwinCat PLC Site Release 1.4 updated door code\EXTRACTED FROM TWINCAT\EXPORT.EXP"
pro_path = r"c:\Users\Hayden.Schmidt\Daifuku Oceania Limited\Projects - Documents\France\BSL\101079 - BSL Phase 2 Easyjet\110 Low Level Control\Programs\PLC Program\101079 BSL TwinCat PLC Site Release 1.4 updated door code\101079 BSL.pro"

with open(exp_path, "r", encoding="latin-1") as f:
    exp_text = f.read()

with open(pro_path, "rb") as f:
    pro_data = f.read()

pous = {
    "CanopyControl": (292239, 292466),
    "ControlledBuffer": (294118, 295654),
    "HybridControl": (299972, 301970),
}

def exp_slice(name):
    m = re.search(rf"PROGRAM {name}\b", exp_text)
    start = m.start()
    m2 = re.search(r"\r?\nEND_PROGRAM", exp_text[start:])
    return exp_text[start:start+m2.start()]

def extract_contacts(text):
    # (name, polarity) for every _LD_CONTACT, in order
    return re.findall(r"_LD_CONTACT\r?\n(\w+)\r?\n_EXPRESSION\r?\n(POSITIV|NEGATIV)", text)

def extract_outputs(text):
    return re.findall(r"_OUTPUT\r?\n(POSITIV|NEGATIV)\r?\n(NO_SET|SET|RESET)\r?\n(\w+)", text)

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

for name, (start, end) in pous.items():
    print("=" * 60)
    print(name)
    exp_body = exp_slice(name)
    contacts = extract_contacts(exp_body)
    outputs = extract_outputs(exp_body)
    print("EXP contacts (name, polarity):", contacts)
    print("EXP outputs (polarity, set, name):", outputs)
    bin_hits = scan_binary_markers(start, end)
    print("BIN markers (offset, flag_hex, length, name):")
    for off, flag, length, nm in bin_hits:
        print(f"  {off:6d}  flag=0x{flag:02x}  len={length:2d}  {nm}")
