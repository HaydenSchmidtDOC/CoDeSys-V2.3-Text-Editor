import re

path = r"c:\Daifuku RAG Dev\Active\CoDeSys-V2.3-Text-Editor\TEST CORPUS\101079 BSL.pro"
data = open(path, "rb").read()

def printable_window(start, end):
    chunk = data[start:end]
    return "".join(chr(b) if 32 <= b < 127 else "." for b in chunk)

# Dump around each VAR_GLOBAL and VAR_CONFIG
for m in [b"VAR_GLOBAL", b"VAR_CONFIG"]:
    for mm in re.finditer(re.escape(m), data):
        idx = mm.start()
        start = max(0, idx - 60)
        end = min(len(data), idx + 400)
        print(f"\n===== {m.decode()} @ {idx} =====")
        print(printable_window(start, end))

# Also check what's between the last POU and end of file - is there anything after PROGRAMs?
# Find all PROGRAM/FUNCTION_BLOCK/FUNCTION starts
print("\n\n===== POU header offsets =====")
for m in [b"PROGRAM ", b"FUNCTION_BLOCK ", b"FUNCTION "]:
    for mm in re.finditer(re.escape(m), data):
        idx = mm.start()
        # print the name after keyword
        rest = data[idx:idx+60]
        name = re.match(rb"[A-Za-z_0-9]+", rest[len(m):])
        print(f"  {m.decode().strip():15s} @ {idx:7d}  name={name.group().decode() if name else '?'}")