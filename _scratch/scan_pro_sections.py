import sys, re

path = r"c:\Daifuku RAG Dev\Active\CoDeSys-V2.3-Text-Editor\TEST CORPUS\101079 BSL.pro"
data = open(path, "rb").read()
print(f"File size: {len(data)} bytes")

# Search for printable text markers that indicate section types
markers = [
    b"VAR_GLOBAL", b"VAR_CONFIG", b"VAR_EXTERNAL", b"LIBRARY",
    b"PLC_CONFIGURATION", b"RESOURCE", b"TASK ", b"END_TASK",
    b"GLOBAL_VARIABLE_LIST", b"PROGRAM ", b"FUNCTION_BLOCK ", b"FUNCTION ",
    b"END_PROGRAM", b"END_FUNCTION_BLOCK", b"END_FUNCTION",
    b"CONFIGURATION", b"END_CONFIGURATION", b"VAR", b"END_VAR",
    b"@PATH", b"@OBJECTFLAGS", b"@SYMFILEFLAGS", b"@GLOBAL_VARIABLE_LIST",
]

for m in markers:
    positions = [mm.start() for mm in re.finditer(re.escape(m), data)]
    print(f"{m.decode():30s} count={len(positions):4d}  first={positions[0] if positions else '-'}")

# Show a window around the first VAR_GLOBAL / LIBRARY / PLC_CONFIGURATION if present
for m in [b"VAR_GLOBAL", b"LIBRARY", b"PLC_CONFIGURATION", b"RESOURCE", b"TASK "]:
    idx = data.find(m)
    if idx >= 0:
        start = max(0, idx - 40)
        end = min(len(data), idx + 200)
        chunk = data[start:end]
        printable = "".join(chr(b) if 32 <= b < 127 else "." for b in chunk)
        print(f"\n--- around {m.decode()} @ {idx} ---")
        print(printable)