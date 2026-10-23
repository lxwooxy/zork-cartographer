"""The map: rooms, exits, grid positions, items and inventory. Saved to JSON."""
from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path

from game import Turn
import parser as zp


@dataclass
class Exit:
    to: str | None = None          # room id, or None if seen but not explored
    blocked: bool = False          # tried it and couldn't go
    inferred: bool = False         # guessed from the reverse direction
    note: str = ""                 # e.g. "narrow path", "trap door"


@dataclass
class Room:
    id: str
    name: str
    description: str = ""
    x: float = 0.0     # map position (east)
    y: float = 0.0     # map position (north)
    z: int = 0         # level (up/down)
    exits: dict[str, Exit] = field(default_factory=dict)
    items: list[str] = field(default_factory=list)
    visits: int = 0
    first_turn: int = 0
    dark: bool = False
    # Filled in by the LLM (optional)
    environment: str = ""          # forest, house, cave, maze, river, temple, mine, ...
    indoor: bool | None = None
    lighting: str = ""             # bright, dim, dark
    features: list[str] = field(default_factory=list)
    palette: dict[str, str] = field(default_factory=dict)  # floor, wall, accent (hex)
    visual: str = ""               # one-sentence visual summary for the 3D builder
    enriched: bool = False


class World:
    def __init__(self, path: Path):
        self.path = path
        self.rooms: dict[str, Room] = {}
        self.current: str | None = None
        self.inventory: list[str] = []
        self.inventory_stale = False   # something happened we can't track (e.g. the thief)
        self.score = 0
        self.moves = 0
        self.turn = 0
        self.version = 0
        self.log: list[dict] = []   # every command + output, for replay and the UI

    # ---------- persistence ----------
    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.to_json(full=True), indent=1))
        tmp.replace(self.path)

    @classmethod
    def load(cls, path: Path) -> "World":
        w = cls(path)
        if not path.exists():
            return w
        d = json.loads(path.read_text())
        for r in d.get("rooms", []):
            exits = {k: Exit(**v) for k, v in r.pop("exits", {}).items()}
            w.rooms[r["id"]] = Room(**r, exits=exits)
        w.current = d.get("current")
        w.inventory = d.get("inventory", [])
        w.inventory_stale = d.get("inventory_stale", False)
        w.score, w.moves, w.turn = d.get("score", 0), d.get("moves", 0), d.get("turn", 0)
        w.version = d.get("version", 0)
        w.log = d.get("log", [])
        return w

    def to_json(self, full: bool = False) -> dict:
        d = {
            "version": self.version,
            "current": self.current,
            "inventory": self.inventory,
            "inventory_stale": self.inventory_stale,
            "score": self.score,
            "moves": self.moves,
            "turn": self.turn,
            "rooms": [asdict(r) for r in self.rooms.values()],
        }
        d["log"] = self.log if full else self.log[-200:]
        return d

    def to_unity(self) -> dict:
        """Flat, array-only shape that Unity's JsonUtility can read."""
        rooms = []
        for r in self.rooms.values():
            rooms.append({
                "id": r.id, "name": r.name, "description": r.description,
                "x": r.x, "y": r.y, "z": r.z,
                "environment": r.environment or guess_environment(r),
                "indoor": bool(r.indoor) if r.indoor is not None else guess_indoor(r),
                "lighting": r.lighting or ("dark" if r.dark else ""),
                "visual": r.visual,
                "floorColor": r.palette.get("floor", ""),
                "wallColor": r.palette.get("wall", ""),
                "accentColor": r.palette.get("accent", ""),
                "items": r.items,
                "features": r.features,
                "exits": [{"dir": k, "to": v.to or "", "blocked": v.blocked, "inferred": v.inferred}
                          for k, v in r.exits.items()],
            })
        return {"version": self.version, "current": self.current or "", "score": self.score,
                "moves": self.moves, "inventory": self.inventory, "rooms": rooms,
                "log": [{"command": e["command"], "text": e["text"]} for e in self.log[-60:]]}

    # ---------- turn processing ----------
    def apply_turn(self, t: Turn) -> dict:
        """Update the map from one game turn. Returns a small summary of what changed."""
        self.turn += 1
        self.score, self.moves = t.score, t.moves
        prev = self.rooms.get(self.current) if self.current else None
        direction = zp.direction_of(t.command) if t.command else None
        has_heading, desc, other = zp.split_room_text(t.text, t.room_name)
        changes: dict = {"moved": False, "new_room": False}

        dark = t.room_name.lower() in ("darkness",) or "it is pitch black" in t.text.lower()
        moved = prev is None or t.room_name != prev.name or (has_heading and direction is not None)
        if dark and prev is not None and direction is None:
            moved = False

        if moved and not (prev and t.room_name == prev.name and not has_heading):
            room = self._resolve_room(prev, direction, t.room_name, desc, dark,
                                      zp.items_mentioned(other) if has_heading else None)
            changes["new_room"] = room.visits == 0
            room.visits += 1
            if desc and not room.description:
                room.description = desc
            room.dark = room.dark or dark
            if prev is not None and room.id != prev.id:
                changes["moved"] = True
                if direction:
                    self._link(prev, direction, room)
            if changes["new_room"] or changes["moved"]:
                self.relax()
            self.current = room.id
        elif prev is not None and direction and zp.is_failed_move(t.text):
            prev.exits.setdefault(direction, Exit()).blocked = True

        room = self.rooms[self.current]
        if has_heading:
            # A room description lists what's lying around; treat it as the truth.
            room.items = _dedupe(zp.items_mentioned(other))
            for d in zp.exits_in_description(desc):
                room.exits.setdefault(d, Exit())
        # Inventory
        listing = zp.inventory_listing(t.text)
        if listing is not None:
            self.inventory = listing
            self.inventory_stale = False
        elif zp.inventory_changed_unexpectedly(t.text):
            self.inventory_stale = True
        taken, dropped = zp.take_drop(t.command, t.text)
        for it in taken:
            if not any(_same(it, x) for x in self.inventory):
                self.inventory.append(it)
            room.items = [x for x in room.items if not _same(it, x)]
        for it in dropped:
            self.inventory = [x for x in self.inventory if not _same(it, x)]
            if t.command.lower().startswith("drop") and not any(_same(it, x) for x in room.items):
                room.items.append(it)

        self.log.append({"turn": self.turn, "command": t.command, "text": t.text,
                         "room": self.current, "score": t.score, "moves": t.moves})
        self.version += 1
        changes["room_id"] = self.current
        changes["has_heading"] = has_heading
        return changes

    def _resolve_room(self, prev: Room | None, direction: str | None, name: str, desc: str, dark: bool,
                      items: list[str] | None = None) -> Room:
        # 1. A known exit from the previous room leads to a room with this name.
        if prev and direction and direction in prev.exits:
            to = prev.exits[direction].to
            if to and to in self.rooms and self.rooms[to].name == name:
                return self.rooms[to]
        # 2. A room with the same name (and description, if we have one) exists.
        same = [r for r in self.rooms.values() if r.name == name]
        if desc:
            same_desc = [r for r in same if r.description == desc or not r.description]
        else:
            same_desc = same
        # Items lying around are the best way to tell identical rooms apart
        # (drop something in each maze room, as Zork players always have).
        if items and same_desc:
            seen = {_norm(i) for i in items}
            match = [r for r in same_desc if r.items and {_norm(i) for i in r.items} == seen]
            if len(match) == 1:
                return match[0]
        # Walking from "Maze" into "Maze" means a different room with the same name.
        within = bool(prev and direction and prev.name == name)
        if within:
            same_desc = [r for r in same_desc if r.id != prev.id]
        if len(same_desc) == 1 and len(same) == 1 and not within:
            return same_desc[0]
        if same_desc and prev and direction:
            # Several rooms share a name (forests, mazes). Reuse one only if it sits
            # where this move would put us.
            tx, ty, tz = self._step(prev, direction)
            for r in same_desc:
                if r.z == tz and (r.x - tx) ** 2 + (r.y - ty) ** 2 < 0.36:
                    return r
        elif same_desc and not direction:
            return same_desc[0]
        # 3. New room.
        rid = _slug(name)
        n = 2
        while rid in self.rooms:
            rid = f"{_slug(name)}-{n}"
            n += 1
        x, y, z = self._place(prev, direction)
        room = Room(id=rid, name=name, description=desc, x=x, y=y, z=z, first_turn=self.turn, dark=dark)
        self.rooms[rid] = room
        return room

    def _step(self, prev: Room, direction: str) -> tuple[float, float, int]:
        dx, dy, dz = zp.DIRECTIONS.get(direction, (0, 0, 0))
        if (dx, dy, dz) == (0, 0, 0):  # in/out: pick a free side
            dx, dy = self._free_side(prev)
        return prev.x + dx, prev.y + dy, prev.z + dz

    def _free_side(self, prev: Room) -> tuple[int, int]:
        for d in ("west", "east", "north", "south"):
            dx, dy, _ = zp.DIRECTIONS[d]
            if d not in prev.exits and not self._near(prev.x + dx, prev.y + dy, prev.z):
                return dx, dy
        return 1, 0

    def _near(self, x: float, y: float, z: int, r: float = 0.5) -> bool:
        return any(o.z == z and (o.x - x) ** 2 + (o.y - y) ** 2 < r * r for o in self.rooms.values())

    def _place(self, prev: Room | None, direction: str | None) -> tuple[float, float, int]:
        if prev is None:
            return (0.0, 0.0, 0)
        if direction:
            return self._step(prev, direction)
        # Teleported (prayer, death, etc.): drop it somewhere free nearby; relax() tidies up.
        for radius in range(2, 40):
            for dx, dy in ((radius, 0), (0, radius), (-radius, 0), (0, -radius)):
                if not self._near(prev.x + dx, prev.y + dy, prev.z):
                    return prev.x + dx, prev.y + dy, prev.z
        return prev.x, prev.y, prev.z + 1

    def relax(self, iters: int = 120):
        """Spring layout: each exit pulls rooms toward their compass offset, rooms on the
        same level push apart. Zork's geography isn't consistent, so this keeps the map
        readable instead of exact."""
        rooms = list(self.rooms.values())
        if len(rooms) < 2:
            return
        idx = {r.id: i for i, r in enumerate(rooms)}
        pos = [[r.x, r.y] for r in rooms]
        anchor = [p[:] for p in pos]
        edges = []
        seen = set()
        for a in rooms:
            for d, ex in a.exits.items():
                if not ex.to or ex.to not in idx:
                    continue
                key = tuple(sorted((a.id, ex.to)))
                if key in seen:
                    continue
                seen.add(key)
                dx, dy, dz = zp.DIRECTIONS.get(d, (0, 0, 0))
                free = d in ("in", "out")
                edges.append((idx[a.id], idx[ex.to], dx, dy, free))
        levels: dict[int, list[int]] = {}
        for i, r in enumerate(rooms):
            levels.setdefault(r.z, []).append(i)
        start = min(range(len(rooms)), key=lambda i: rooms[i].first_turn)
        for _ in range(iters):
            for i, j, dx, dy, free in edges:
                vx, vy = pos[j][0] - pos[i][0], pos[j][1] - pos[i][1]
                if free:
                    dist = (vx * vx + vy * vy) ** 0.5 or 1e-6
                    ex, ey = vx - vx / dist, vy - vy / dist
                else:
                    ex, ey = vx - dx, vy - dy
                pos[i][0] += ex * 0.15; pos[i][1] += ey * 0.15
                pos[j][0] -= ex * 0.15; pos[j][1] -= ey * 0.15
            for members in levels.values():
                for a_i in range(len(members)):
                    i = members[a_i]
                    for j in members[a_i + 1:]:
                        vx, vy = pos[j][0] - pos[i][0], pos[j][1] - pos[i][1]
                        d2 = vx * vx + vy * vy
                        if d2 < 0.81:
                            dist = d2 ** 0.5
                            if dist < 1e-6:
                                vx, vy, dist = 0.01 * (j - i), 0.01, 0.0141
                            push = (0.9 - dist) / 2 / dist
                            pos[i][0] -= vx * push; pos[i][1] -= vy * push
                            pos[j][0] += vx * push; pos[j][1] += vy * push
            for i in range(len(pos)):  # gentle pull back so the map doesn't drift
                pos[i][0] += (anchor[i][0] - pos[i][0]) * 0.02
                pos[i][1] += (anchor[i][1] - pos[i][1]) * 0.02
            ox, oy = pos[start]
            for p in pos:
                p[0] -= ox; p[1] -= oy
        for r, p in zip(rooms, pos):
            r.x, r.y = round(p[0], 2), round(p[1], 2)

    def _link(self, a: Room, direction: str, b: Room):
        ex = a.exits.setdefault(direction, Exit())
        ex.to, ex.blocked, ex.inferred = b.id, False, False
        back = zp.OPPOSITE.get(direction)
        if back and back not in b.exits:
            b.exits[back] = Exit(to=a.id, inferred=True)

    # ---------- LLM enrichment ----------
    def apply_enrichment(self, room_id: str, info: dict):
        r = self.rooms.get(room_id)
        if not r:
            return
        room = info.get("room") or {}
        for key in ("environment", "lighting", "visual"):
            if room.get(key):
                setattr(r, key, room[key])
        if room.get("indoor") is not None:
            r.indoor = room["indoor"]
        if room.get("features"):
            r.features = room["features"]
        if room.get("palette"):
            r.palette = {k: v for k, v in room["palette"].items() if isinstance(v, str) and v.startswith("#")}
        for e in room.get("exits_mentioned", []):
            d = zp.ALIASES.get(e.get("direction", "").lower(), e.get("direction", "").lower())
            if d in zp.DIRECTIONS:
                ex = r.exits.setdefault(d, Exit())
                if e.get("note"):
                    ex.note = e["note"]
        if room.get("items_present") is not None and info.get("room_description_shown"):
            r.items = _dedupe([i for i in room["items_present"] if i])
        if info.get("inventory") is not None and info.get("inventory_known"):
            self.inventory = info["inventory"]
            self.inventory_stale = False
        r.enriched = True
        self.version += 1


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-") or "room"


def _norm(s: str) -> str:
    s = s.lower().strip()
    s = re.sub(r"^(an?|the|some)\s+", "", s)
    return s


def _same(a: str, b: str) -> bool:
    a, b = _norm(a), _norm(b)
    return a == b or a in b.split() or b in a.split() or a.endswith(b) or b.endswith(a)


def _dedupe(items: list[str]) -> list[str]:
    out: list[str] = []
    for i in items:
        if not any(_same(i, o) for o in out):
            out.append(i)
    return out


# Fallback guesses when no LLM is configured.
def guess_environment(r: Room) -> str:
    t = (r.name + " " + r.description).lower()
    for env, words in (
        ("maze", ["maze", "twisty"]),
        ("forest", ["forest", "tree", "clearing"]),
        ("river", ["river", "stream", "reservoir", "dam", "lake", "water", "beach", "shore"]),
        ("house", ["house", "kitchen", "attic", "living room", "cellar"]),
        ("temple", ["temple", "altar", "egyptian", "hades", "land of the dead"]),
        ("mine", ["mine", "coal", "shaft", "timber"]),
        ("cave", ["cave", "passage", "tunnel", "chasm", "gallery", "studio", "room"]),
    ):
        if any(w in t for w in words):
            return env
    return "cave"


def guess_indoor(r: Room) -> bool:
    return guess_environment(r) not in ("forest", "river") and "house" not in r.name.lower()
