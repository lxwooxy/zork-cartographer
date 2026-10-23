"""Build the canonical Zork I map from the game's own source (1dungeon.zil).

    python tools/build_map.py game/source/1dungeon.zil > game/zork1-map.json

The source is in game/source/ (from https://github.com/historicalsource/zork1, MIT license).
The output lists every room with its name (what the status line shows), Zork's own
description, flags, and every exit with its condition.
"""
from __future__ import annotations

import json
import re
import sys

DIRS = {
    "NORTH": "north", "SOUTH": "south", "EAST": "east", "WEST": "west",
    "NE": "northeast", "NW": "northwest", "SE": "southeast", "SW": "southwest",
    "UP": "up", "DOWN": "down", "IN": "in", "OUT": "out", "LAND": "land",
}

# Exits handled by code ("PER <routine>"). Destinations come from the routines in
# 1actions.zil / the comments next to them.
PER_EXITS = {
    "GRATING-EXIT": {"to": "GRATING-ROOM", "if": "GRATE IS OPEN",
                     "note": "only through the open grating"},
    "TRAP-DOOR-EXIT": {"to": "CELLAR", "if": "TRAP-DOOR IS OPEN",
                       "note": "the trap door must be open; it shuts behind you"},
    "UP-CHIMNEY-FUNCTION": {"to": "KITCHEN", "if": "CARRYING LITTLE",
                            "note": "you can only climb the chimney carrying one or two things"},
    "MAZE-DIODES": {"note": "one-way drop"},   # target from the ;"to X" comment
}


# ---------- a tiny reader for the parts of ZIL we need ----------
TOKEN = re.compile(r'"(?:\\.|[^"\\])*"|;"(?:\\.|[^"\\])*"|[()<>]|[^\s()<>"]+', re.S)


def tokens(src: str):
    for m in TOKEN.finditer(src):
        yield m.group(0)


def parse(tok_iter, closer=None):
    """Nested lists from ( ) and < >. Strings stay as Python str with quotes stripped,
    atoms as ('atom', NAME). Comments ;"..." are kept as ('comment', text)."""
    out = []
    for t in tok_iter:
        if t in ("(", "<"):
            out.append((t, parse(tok_iter, ")" if t == "(" else ">")))
        elif t in (")", ">"):
            return out
        elif t.startswith(';"'):
            out.append(("comment", t[2:-1]))
        elif t.startswith('"'):
            out.append(("string", t[1:-1].replace('\\"', '"')))
        else:
            out.append(("atom", t))
    return out


def text(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def rooms_from(src: str) -> dict:
    tree = parse(tokens(src))
    rooms = {}
    for node in tree:
        if node[0] != "<":
            continue
        body = node[1]
        if not body or body[0] != ("atom", "ROOM"):
            continue
        rid = body[1][1]
        room = {"id": rid, "name": "", "ldesc": "", "flags": [], "exits": {}}
        items = body[2:]
        for i, prop in enumerate(items):
            if prop[0] != "(" or not prop[1]:
                continue
            parts = prop[1]
            key = parts[0][1] if parts[0][0] == "atom" else None
            rest = parts[1:]
            if key == "DESC" and rest and rest[0][0] == "string":
                room["name"] = text(rest[0][1])
            elif key == "LDESC" and rest and rest[0][0] == "string":
                room["ldesc"] = text(rest[0][1])
            elif key == "FLAGS":
                room["flags"] = [a[1] for a in rest if a[0] == "atom"]
            elif key == "ACTION" and rest and rest[0][0] == "atom":
                room["action"] = rest[0][1]   # routine in 1actions.zil (some descriptions live there)
            elif key in DIRS:
                if key == "IN" and rest == [("atom", "ROOMS")]:
                    continue   # (IN ROOMS) means "this object is a room", not an exit
                ex = exit_from(rest)
                # A ;"to X" comment right after a PER exit names its target.
                nxt = items[i + 1] if i + 1 < len(items) else None
                if ex.get("per") == "MAZE-DIODES" and nxt and nxt[0] == "comment":
                    m = re.match(r"to (\S+)", nxt[1])
                    if m:
                        ex["to"] = m.group(1)
                        ex["oneway"] = True
                room["exits"][DIRS[key]] = ex
        rooms[rid] = room
    return rooms


def exit_from(rest: list) -> dict:
    atoms = [(k, v) for k, v in rest if k in ("atom", "string")]
    if not atoms:
        return {}
    kind, first = atoms[0]
    if kind == "string":
        return {"msg": text(first)}                      # (EAST "The door is boarded...")
    if first == "SORRY":
        return {"msg": text(atoms[1][1]) if len(atoms) > 1 else ""}
    if first == "PER":
        name = atoms[1][1]
        ex = {"per": name}
        ex.update({k: v for k, v in PER_EXITS.get(name, {}).items()})
        return ex
    if first == "TO":
        ex = {"to": atoms[1][1]}
        words = atoms[2:]
        if words and words[0][1] == "IF":
            cond = []
            for k, v in words[1:]:
                if v == "ELSE":
                    break
                cond.append(v)
            ex["if"] = " ".join(cond)
            for j, (k, v) in enumerate(words):
                if v == "ELSE" and j + 1 < len(words) and words[j + 1][0] == "string":
                    ex["msg"] = text(words[j + 1][1])
        return ex
    return {"raw": " ".join(v for _, v in atoms)}


def main():
    src = open(sys.argv[1], encoding="utf-8", errors="replace").read()
    rooms = rooms_from(src)
    # Sanity checks
    problems = []
    for r in rooms.values():
        if not r["name"]:
            problems.append(f"{r['id']}: no DESC")
        for d, ex in r["exits"].items():
            if ex.get("to") and ex["to"] not in rooms:
                problems.append(f"{r['id']} {d} -> unknown room {ex['to']}")
            if "raw" in ex or ("per" in ex and "to" not in ex):
                problems.append(f"{r['id']} {d}: unhandled exit {ex}")
    for p in problems:
        print("warning:", p, file=sys.stderr)
    out = {
        "game": "Zork I (Release 119 / Serial 880429)",
        "source": "historicalsource/zork1 1dungeon.zil (MIT)",
        "rooms": rooms,
    }
    json.dump(out, sys.stdout, indent=1)
    print(f"{len(rooms)} rooms, {sum(len(r['exits']) for r in rooms.values())} exits", file=sys.stderr)


if __name__ == "__main__":
    main()
