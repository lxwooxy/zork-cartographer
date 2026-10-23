"""Compute a 2D/3D layout for the canonical map once, so the map is the same every game.

    python tools/layout_map.py game/zork1-map.json game/zork1-regions.json > game/zork1-layout.json

Positions are map units (x east, y north) and integer levels (z, up/down). Zork's
geography isn't consistent, so this is a spring layout: every exit pulls toward its
compass direction, rooms on a level push apart. Hand edits are welcome: put overrides
in game/zork1-layout-overrides.json ({"ROOM-ID": [x, y, z]}) and they win.
"""
from __future__ import annotations

import json
import math
import random
import sys

VEC = {
    "north": (0, 1), "south": (0, -1), "east": (1, 0), "west": (-1, 0),
    "northeast": (1, 1), "northwest": (-1, 1), "southeast": (1, -1), "southwest": (-1, -1),
}
START = "WEST-OF-HOUSE"


def _flat(rooms: dict, a: str, d: str) -> bool:
    """Does this exit stay on the same level? Up/down inside the maze is just more maze."""
    if d not in ("up", "down"):
        return True
    to = rooms[a]["exits"][d].get("to")
    return "MAZEBIT" in rooms[a]["flags"] and to in rooms and "MAZEBIT" in rooms[to]["flags"]


def levels(rooms: dict) -> dict[str, int]:
    """Group rooms into areas joined by level exits, then stack the areas: going up an
    exit from one area to another puts that area one level higher."""
    area: dict[str, int] = {}
    for rid in rooms:
        if rid in area:
            continue
        n = len(set(area.values()))
        stack = [rid]
        area[rid] = n
        while stack:
            cur = stack.pop()
            for d, ex in rooms[cur]["exits"].items():
                to = ex.get("to")
                if to in rooms and to not in area and _flat(rooms, cur, d):
                    area[to] = n
                    stack.append(to)
            # exits are one-directional in the data; also follow flat exits that point here
            for other, r in rooms.items():
                if other not in area:
                    for d, ex in r["exits"].items():
                        if ex.get("to") == cur and _flat(rooms, other, d):
                            area[other] = n
                            stack.append(other)
    zarea = {area[START]: 0}
    queue = [area[START]]
    while queue:
        a = queue.pop(0)
        for rid in [r for r in rooms if area[r] == a]:
            for d, ex in rooms[rid]["exits"].items():
                to = ex.get("to")
                if to in rooms and d in ("up", "down") and not _flat(rooms, rid, d) and area[to] not in zarea:
                    zarea[area[to]] = zarea[a] + (1 if d == "up" else -1)
                    queue.append(area[to])
    return {rid: zarea.get(area[rid], 0) for rid in rooms}


def curated_levels(rooms: dict, path: str) -> dict[str, int]:
    """Levels from the hand-curated regions file; unlisted rooms copy a neighbour."""
    data = json.load(open(path))["levels"]
    z = {rid: int(lv) for lv, ids in data.items() for rid in ids if rid in rooms}
    changed = True
    while changed:
        changed = False
        for rid, r in rooms.items():
            if rid in z:
                continue
            for d, ex in r["exits"].items():
                to = ex.get("to")
                if to in z:
                    z[rid] = z[to] + (-1 if d == "up" else 1 if d == "down" else 0)
                    changed = True
                    break
    for rid in rooms:
        z.setdefault(rid, 0)
    return z


def layout(rooms: dict, iters: int = 3000, seed: int = 1, regions: str | None = None) -> dict[str, list]:
    rnd = random.Random(seed)
    z = curated_levels(rooms, regions) if regions else levels(rooms)
    ids = list(rooms)
    pos: dict[str, list[float]] = {}
    # Seed positions by walking compass exits outward (BFS), like drawing the map by hand.
    for seed_room in [START] + ids:
        if seed_room in pos:
            continue
        pos[seed_room] = [rnd.uniform(-6, 6), rnd.uniform(-6, 6)] if seed_room != START else [0.0, 0.0]
        queue = [seed_room]
        while queue:
            cur = queue.pop(0)
            for d, ex in rooms[cur]["exits"].items():
                to = ex.get("to")
                if not to or to not in rooms or to in pos:
                    continue
                v = VEC.get(d, (rnd.uniform(-1, 1), rnd.uniform(-1, 1)))
                pos[to] = [pos[cur][0] + v[0] * 1.6 + rnd.uniform(-.2, .2), pos[cur][1] + v[1] * 1.6 + rnd.uniform(-.2, .2)]
                queue.append(to)
    edges = []
    for rid, r in rooms.items():
        for d, ex in r["exits"].items():
            to = ex.get("to")
            if to and to in rooms and to != rid:
                edges.append((rid, to, VEC.get(d)))
    by_level: dict[int, list[str]] = {}
    for rid in ids:
        by_level.setdefault(z[rid], []).append(rid)
    for it in range(iters):
        cool = 1.0 - it / iters
        for a, b, v in edges:
            pa, pb = pos[a], pos[b]
            dx, dy = pb[0] - pa[0], pb[1] - pa[1]
            if v and z[a] == z[b]:
                ex, ey = dx - v[0] * 1.9, dy - v[1] * 1.9       # want b at a + direction
            else:
                dist = math.hypot(dx, dy) or 1e-6               # up/down/in/out: just stay close
                ex, ey = dx - dx / dist * 1.2, dy - dy / dist * 1.2
            k = 0.08
            pa[0] += ex * k; pa[1] += ey * k
            pb[0] -= ex * k; pb[1] -= ey * k
        for members in by_level.values():
            for i, a in enumerate(members):
                pa = pos[a]
                for b in members[i + 1:]:
                    pb = pos[b]
                    dx, dy = pb[0] - pa[0], pb[1] - pa[1]
                    d2 = dx * dx + dy * dy
                    if d2 < 2.89:
                        d = math.sqrt(d2) or 1e-3
                        push = (1.7 - d) * 0.5 * (0.5 + cool)
                        pa[0] -= dx / d * push; pa[1] -= dy / d * push
                        pb[0] += dx / d * push; pb[1] += dy / d * push
        ox, oy = pos[START]
        for p in pos.values():
            p[0] -= ox; p[1] -= oy
    return {rid: [round(pos[rid][0], 2), round(pos[rid][1], 2), z[rid]] for rid in ids}


def main():
    rooms = json.load(open(sys.argv[1]))["rooms"]
    regions = sys.argv[2] if len(sys.argv) > 2 else None
    out = layout(rooms, regions=regions)
    import os
    overrides = sys.argv[1].replace("-map.json", "-layout-overrides.json")
    if os.path.exists(overrides):
        for rid, p in json.load(open(overrides)).items():
            if rid in out:
                out[rid] = p
    json.dump(out, sys.stdout, indent=1, sort_keys=True)
    lv = {}
    for x, y, zz in out.values():
        lv[zz] = lv.get(zz, 0) + 1
    print(f"levels: {dict(sorted(lv.items()))}", file=sys.stderr)


if __name__ == "__main__":
    main()
