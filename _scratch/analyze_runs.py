import re

path = r"c:\Daifuku RAG Dev\Active\CoDeSys-V2.3-Text-Editor\TEST CORPUS\101079 BSL.pro"
data = open(path, "rb").read()

def is_printable(b):
    return b == 9 or b == 10 or b == 13 or (32 <= b < 127)

# Find printable runs >= 20 bytes, like the decoder does
runs = []
cur = None
for i, b in enumerate(data):
    if is_printable(b):
        if cur is None:
            cur = [i, 1]
        else:
            cur[1] += 1
    else:
        if cur and cur[1] >= 20:
            runs.append(tuple(cur))
        cur = None
if cur and cur[1] >= 20:
    runs.append(tuple(cur))

print(f"Total printable runs >=20: {len(runs)}")
print(f"\nFirst 15 runs (start, len):")
for r in runs[:15]:
    print(f"  {r[0]:7d} len={r[1]:5d}  startswith: {data[r[0]:r[0]+30]!r}")

# Find runs that contain VAR_GLOBAL / VAR_CONFIG
print("\nRuns containing VAR_GLOBAL or VAR_CONFIG:")
for s, l in runs:
    chunk = data[s:s+l]
    if b"VAR_GLOBAL" in chunk or b"VAR_CONFIG" in chunk:
        # find the keyword
        kw = b"VAR_GLOBAL" if b"VAR_GLOBAL" in chunk else b"VAR_CONFIG"
        kpos = chunk.find(kw)
        print(f"  run@{s} len={l}  {kw.decode()} at +{kpos}  head={chunk[:40]!r}")

# Check the region 265047..288616 (globals+configs) - how much is printable?
region = data[265047:288616]
print(f"\nGlobals+config region 265047..288616 = {len(region)} bytes")
print(f"  printable bytes: {sum(1 for b in region if is_printable(b))} ({100*sum(1 for b in region if is_printable(b))//len(region)}%)")