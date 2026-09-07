path = r"c:\Users\Hayden.Schmidt\Daifuku Oceania Limited\Projects - Documents\France\BSL\101079 - BSL Phase 2 Easyjet\110 Low Level Control\Programs\PLC Program\101079 BSL TwinCat PLC Site Release 1.4 updated door code\101079 BSL.pro"
with open(path, "rb") as f:
    data = f.read()

start, end = 292239, 292466
raw = data[start:end]

# find END_VAR to anchor
idx = raw.find(b"END_VAR")
body = raw[idx+len(b"END_VAR"):]

for i,b in enumerate(body):
    ch = chr(b) if 32 <= b < 127 else "."
    print(f"{i:3d}  0x{b:02x}  {b:3d}  {ch}")
