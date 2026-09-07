path = r"c:\Users\Hayden.Schmidt\Daifuku Oceania Limited\Projects - Documents\France\BSL\101079 - BSL Phase 2 Easyjet\110 Low Level Control\Programs\PLC Program\101079 BSL TwinCat PLC Site Release 1.4 updated door code\101079 BSL.pro"
with open(path, "rb") as f:
    data = f.read()

start, end = 292239, 292466
raw = data[start:end]

def hexdump(b, base=0):
    out = []
    for i in range(0, len(b), 16):
        chunk = b[i:i+16]
        hexpart = " ".join(f"{c:02x}" for c in chunk)
        asciipart = "".join(chr(c) if 32 <= c < 127 else "." for c in chunk)
        out.append(f"{base+i:06x}  {hexpart:<48}  {asciipart}")
    return "\n".join(out)

print(hexdump(raw, start))
print()
print("length", len(raw))
