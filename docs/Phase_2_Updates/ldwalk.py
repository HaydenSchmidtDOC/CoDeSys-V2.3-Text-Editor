#!/usr/bin/env python3
"""
ldwalk.py - Ladder (LD) element walker for CoDeSys V2.3 / TwinCAT 2 `.pro`.

Solves the last open problem in the format: ladder bodies carry a NETWORK
COUNT (u32 after tag 0x1B) but no byte length, so their extent can only be
found by structurally walking every element.

Grammar (see TWINCAT_PRO_PARSER_BIBLE.md sec 6.3):

  BODY     := NETWORK x nnet  FOOTER(20 bytes)
  NETWORK  := 08 FF  TREE  <outCount:u16>  OUTPUT x outCount  [SEP(5 bytes)]
  TREE     := depth-first element stream; a block opener (09 series / 0A
              parallel) pushes, an element carrying +0x40 closes its block.
              Closing cascades while the popped opener itself carried +0x40.
              A tree whose first token is a leaf is a single-element tree.
  ELEMENT  := <tag:u8> <len:u8> <name>          (contacts, coils, literals)
  FB       := <05|45> <len> <name> <pinByte> <41 len literal>
              <u8 len> <typeName> <trailer>
              trailer = 8 bytes for timers (TON/TOF/TP)
                        6 bytes for edge detectors (R_TRIG/F_TRIG)

Tag bits:  0x0B contact | 0x05 FB | 0x41 literal | 0x00/02/03 coil D/S/R
           +0x40 = terminal (last child of its block)
           +0x80 = negated contact
"""

import struct

NETWORK_MARKER = b"\x08\xff"
FOOTER_LEN = 20
SEP_LEN = 5

TIMER_TYPES = {"TON", "TOF", "TP"}
EDGE_TYPES = {"R_TRIG", "F_TRIG"}

COIL_MODE = {0x00: "DIRECT", 0x02: "SET", 0x03: "RESET"}


class LadderError(Exception):
    pass


class Element:
    __slots__ = ("kind", "name", "negated", "terminal", "off", "end",
                 "fbtype", "literal", "pin", "trailer", "raw")

    def __init__(self, **kw):
        for k in self.__slots__:
            setattr(self, k, kw.get(k))

    def __repr__(self):
        n = "/" if self.negated else ""
        t = "*" if self.terminal else ""
        return f"{self.kind}{t}({n}{self.name})"


class Network:
    __slots__ = ("index", "off", "end", "tree", "outputs", "sep", "comment")

    def __init__(self, **kw):
        for k in self.__slots__:
            setattr(self, k, kw.get(k))


def _read_name(buf, p, limit):
    """<len:u8> <name>. Returns (name, next_offset)."""
    if p >= limit:
        raise LadderError(f"name length past limit at {p}")
    n = buf[p]
    s, e = p + 1, p + 1 + n
    if e > limit:
        raise LadderError(f"name at {p} len {n} overruns limit {limit}")
    nm = buf[s:e]
    if n and not all(32 <= c < 127 for c in nm):
        raise LadderError(f"non-printable name at {p}: {nm!r}")
    return nm.decode("latin1"), e


def _read_fb(buf, p, limit, tag):
    """FB instance record. p points just past the tag byte."""
    name, p = _read_name(buf, p, limit)
    pin = buf[p]
    p += 1
    literal = None
    if p < limit and buf[p] == 0x41:
        literal, p = _read_name(buf, p + 1, limit)
    fbtype, p = _read_name(buf, p, limit)   # bare Pascal string, no tag
    if fbtype in TIMER_TYPES:
        tlen = 8
    elif fbtype in EDGE_TYPES:
        tlen = 6
    else:
        raise LadderError(f"unknown FB type {fbtype!r} at {p}")
    trailer = buf[p:p + tlen]
    p += tlen
    return Element(kind="FB", name=name, fbtype=fbtype, literal=literal,
                   pin=pin, trailer=trailer, negated=False,
                   terminal=bool(tag & 0x40)), p


def walk_tree(buf, p, limit):
    """
    Walk one network's element tree. Returns (elements, next_offset).
    Stack holds each open block's own terminal flag so closes cascade.
    """
    elems = []
    stack = []
    started = False
    while True:
        if p >= limit:
            raise LadderError("tree overran network limit")
        tag = buf[p]
        base = tag & 0x0F
        terminal = bool(tag & 0x40)

        # Block openers carry no name.
        if base in (0x09, 0x0A) and not (tag & 0x80):
            stack.append(terminal)
            elems.append(Element(kind="SERIES" if base == 0x09 else "PARALLEL",
                                 name=None, terminal=terminal, off=p, end=p + 1))
            p += 1
            started = True
            continue

        off = p
        if base == 0x05:
            el, p = _read_fb(buf, p + 1, limit, tag)
        elif base == 0x0B:
            name, p = _read_name(buf, p + 1, limit)
            el = Element(kind="CONTACT", name=name,
                         negated=bool(tag & 0x80), terminal=terminal)
        else:
            raise LadderError(f"unexpected tree tag 0x{tag:02x} at {p}")
        el.off, el.end, el.raw = off, p, tag
        elems.append(el)
        started = True

        if terminal:
            if not stack:
                return elems, p          # terminal leaf at top level
            while stack:
                if not stack.pop():
                    break
            if not stack:
                return elems, p
        elif not stack:
            return elems, p              # single-element tree

    # unreachable


def walk_network(buf, p, limit, is_last):
    """Walk one network: marker, tree, output list, separator."""
    start = p
    if buf[p:p + 2] != NETWORK_MARKER:
        raise LadderError(f"missing 08 FF at {p}")
    p += 2
    tree, p = walk_tree(buf, p, limit)

    if p + 2 > limit:
        raise LadderError("output count past limit")
    count = struct.unpack_from("<H", buf, p)[0]
    p += 2
    if count > 64:
        raise LadderError(f"implausible output count {count} at {p-2}")

    outputs = []
    for _ in range(count):
        tag = buf[p]
        name, p2 = _read_name(buf, p + 1, limit)
        outputs.append(Element(kind="OUTPUT", name=name, raw=tag,
                               negated=bool(tag & 0x80),
                               terminal=bool(tag & 0x40), off=p, end=p2))
        p = p2

    # Separator = the NEXT network's comment: <len:u32> <text> <00>.
    # Empty comment therefore occupies 5 bytes (00 00 00 00 | 00), which is
    # why it first looked like a fixed 5-byte pad.
    sep = b""
    comment = None
    if not is_last:
        if p + 4 > limit:
            raise LadderError("comment length past limit")
        clen = struct.unpack_from("<I", buf, p)[0]
        if clen > 4096 or p + 4 + clen + 1 > limit:
            raise LadderError(f"implausible comment length {clen} at {p}")
        raw = buf[p + 4:p + 4 + clen]
        comment = raw.decode("latin1") if clen else None
        sep = buf[p:p + 4 + clen + 1]
        p += 4 + clen + 1

    return Network(off=start, end=p, tree=tree, outputs=outputs,
                   sep=sep, comment=comment), p


def walk_body(buf, body_off, nnet, hard_limit):
    """
    Walk a complete ladder body. Returns (networks, footer, end_offset).
    end_offset is the authoritative end of the ladder body - the value the
    format does not store.
    """
    p = body_off
    nets = []
    for i in range(nnet):
        net, p = walk_network(buf, p, hard_limit, is_last=(i == nnet - 1))
        net.index = i + 1
        nets.append(net)
    footer = buf[p:p + FOOTER_LEN]
    p += FOOTER_LEN
    return nets, footer, p


# ----------------------------------------------------------------- encode

def encode_name(s):
    b = s.encode("latin1")
    if len(b) > 255:
        raise LadderError(f"name too long: {s!r}")
    return bytes([len(b)]) + b


def encode_element(el):
    if el.kind in ("SERIES", "PARALLEL"):
        return bytes([el.raw if el.raw is not None else
                      ((0x09 if el.kind == "SERIES" else 0x0A) |
                       (0x40 if el.terminal else 0))])
    if el.kind == "CONTACT":
        return bytes([el.raw]) + encode_name(el.name)
    if el.kind == "FB":
        out = bytes([el.raw]) + encode_name(el.name) + bytes([el.pin])
        if el.literal is not None:
            out += b"\x41" + encode_name(el.literal)
        out += encode_name(el.fbtype) + el.trailer
        return out
    if el.kind == "OUTPUT":
        return bytes([el.raw]) + encode_name(el.name)
    raise LadderError(f"cannot encode {el.kind}")


def encode_network(net, is_last):
    out = bytearray(NETWORK_MARKER)
    for el in net.tree:
        if el.kind in ("SERIES", "PARALLEL"):
            out += bytes([el.raw if el.raw is not None else
                          ((0x09 if el.kind == "SERIES" else 0x0A) |
                           (0x40 if el.terminal else 0))])
        else:
            out += encode_element(el)
    out += struct.pack("<H", len(net.outputs))
    for o in net.outputs:
        out += encode_element(o)
    if not is_last:
        out += net.sep
    return bytes(out)


def encode_body(nets, footer):
    out = bytearray()
    for i, n in enumerate(nets):
        out += encode_network(n, is_last=(i == len(nets) - 1))
    out += footer
    return bytes(out)


# ----------------------------------------------------------------- render

def render_tree(elems):
    """
    Readable form. Indentation mirrors the walker's block stack, so blocks
    close (dedent) exactly where a terminal element pops them.
    """
    lines = []
    depth = 0
    stack = []
    for el in elems:
        if el.kind in ("SERIES", "PARALLEL"):
            lines.append("  " * depth + f"{el.kind}{'*' if el.terminal else ''}")
            stack.append(el.terminal)
            depth += 1
            continue
        if el.kind == "CONTACT":
            n = "NOT " if el.negated else ""
            lines.append("  " * depth + f"{n}{el.name}")
        elif el.kind == "FB":
            lit = f", PT:={el.literal}" if el.literal else ""
            lines.append("  " * depth + f"{el.name} : {el.fbtype}{lit}")
        if el.terminal:
            while stack:
                t = stack.pop()
                depth -= 1
                if not t:
                    break
    return lines


def render_network(net):
    out = [f"NETWORK {net.index}:"]
    out += ["  " + l for l in render_tree(net.tree)]
    for o in net.outputs:
        mode = COIL_MODE.get(o.raw & 0x0F, f"0x{o.raw:02x}")
        out.append(f"  => {o.name} := {mode}")
    return out


# ----------------------------------------------------------------- tree

def build_tree(elems):
    """
    Rebuild the nested block tree from the flat element stream, using the
    same stack semantics as walk_tree. Returns a list of nodes, where a node
    is either a str (leaf label) or {'kind': 'SERIES'|'PARALLEL', 'kids': []}.

    Verified against the CoDeSys ladder editor for all six rungs of
    HybridControl visible in the UI (see BIBLE sec 6.4).
    """
    root = []
    stack = []
    cur = root
    for el in elems:
        if el.kind in ("SERIES", "PARALLEL"):
            node = {"kind": el.kind, "kids": []}
            cur.append(node)
            stack.append((cur, el.terminal))
            cur = node["kids"]
            continue
        if el.kind == "FB":
            lbl = f"{el.name}:{el.fbtype}"
            if el.literal:
                lbl += f"({el.literal})"
        else:
            lbl = ("NOT " if el.negated else "") + el.name
        cur.append(lbl)
        if el.terminal:
            while stack:
                parent, opener_terminal = stack.pop()
                cur = parent
                if not opener_terminal:
                    break
    return root


def render_expr(elems):
    """Boolean-expression form of a network's tree, for direct comparison
    against the ladder drawing. '·' = series (AND), '||' = parallel (OR)."""
    def show(node):
        if isinstance(node, str):
            return node
        op = " . " if node["kind"] == "SERIES" else " || "
        return "(" + op.join(show(k) for k in node["kids"]) + ")"
    return " . ".join(show(n) for n in build_tree(elems))
