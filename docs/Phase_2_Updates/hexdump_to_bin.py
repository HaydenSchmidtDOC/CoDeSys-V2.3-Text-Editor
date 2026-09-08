import re,sys
def unhex(path):
    data=bytearray(); bad=0
    for line in open(path,'r',errors='replace'):
        line=line.rstrip('\n')
        if not line.strip(): continue
        i=line.find('|')
        hexpart=line[:i] if i!=-1 else line
        toks=hexpart.split()
        if not toks: continue
        try: off=int(toks[0])
        except: continue
        bs=[]
        for t in toks[1:]:
            if len(t)==2 and re.fullmatch(r'[0-9a-fA-F]{2}',t): bs.append(int(t,16))
            else: break
        if off!=len(data): bad+=1
        data.extend(bs)
    return bytes(data),bad
for p,o in [("101079 BSL.BAK.hex.txt","bsl.BAK"),("101079 BSL.SYM.hex.txt","bsl.SYM"),
            ("101079 BSL________r.ci.hex.txt","bsl.ci"),("101079 BSL________r.ri.hex.txt","bsl.ri"),
            ("DEFAULT.DFR.hex.txt","DEFAULT.DFR")]:
    d,bad=unhex("/mnt/user-data/uploads/"+p)
    open(o,'wb').write(d)
    print(f'{o:14s} {len(d):9d} bytes  offsetGaps={bad}')
