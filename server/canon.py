"""The canonical map: every room and exit from the game's source, plus a fixed layout.

Built by tools/build_map.py (rooms + exits) and tools/layout_map.py (positions).
When it's available the server tracks your position exactly by following real exits,
and the UI reveals rooms as you discover them (fog of war).
"""
from __future__ import annotations

import json
from pathlib import Path

# Plain-English versions of the conditions in the source, shown as exit notes.
CONDITIONS = {
    "KITCHEN-WINDOW IS OPEN": "the kitchen window must be open",
    "TRAP-DOOR IS OPEN": "the trap door must be open",
    "GRATE IS OPEN": "the grating must be open",
    "TROLL-FLAG": "the troll must be dealt with",
    "CYCLOPS-FLAG": "the cyclops must be dealt with",
    "MAGIC-FLAG": "the door must be opened somehow",
    "RAINBOW-FLAG": "the rainbow must be solid",
    "LOW-TIDE": "the reservoir must be drained",
    "DOME-FLAG": "a rope must be tied to the railing",
    "LLD-FLAG": "the spirits must be dispelled",
    "CARRYING LITTLE": "you can only carry a little",
    "EMPTY-HANDED": "you must be empty-handed",
    "COFFIN-CURE": "you can't carry the coffin",
    "DEFLATE": "the boat must be deflated",
    "WON-FLAG": "only after winning",
    "FALSE-FLAG": "not possible",
}


class Canon:
    def __init__(self, map_path: Path, layout_path: Path | None = None):
        data = json.loads(Path(map_path).read_text())
        self.source = data.get("source", "")
        self.rooms: dict[str, dict] = {}
        for rid, r in data["rooms"].items():
            exits = {}
            for d, ex in r["exits"].items():
                ex = dict(ex)
                if ex.get("to"):
                    ex["to"] = ex["to"].lower()
                exits[d] = ex
            self.rooms[rid.lower()] = {**r, "id": rid.lower(), "exits": exits}
        self.layout: dict[str, list] = {}
        if layout_path and Path(layout_path).exists():
            self.layout = {k.lower(): v for k, v in json.loads(Path(layout_path).read_text()).items()}
        self.by_name: dict[str, list[str]] = {}
        for rid, r in self.rooms.items():
            self.by_name.setdefault(r["name"], []).append(rid)

    @classmethod
    def for_story(cls, story: Path) -> "Canon | None":
        """game/zork1.z3 -> game/zork1-map.json + game/zork1-layout.json, if present."""
        base = Path(story).with_suffix("")
        map_path = Path(f"{base}-map.json")
        if not map_path.exists():
            return None
        return cls(map_path, Path(f"{base}-layout.json"))

    def name(self, rid: str) -> str:
        return self.rooms[rid]["name"] if rid in self.rooms else ""

    def exits(self, rid: str) -> dict[str, dict]:
        return self.rooms[rid]["exits"] if rid in self.rooms else {}

    def target(self, rid: str, direction: str) -> str | None:
        return self.exits(rid).get(direction, {}).get("to")

    def position(self, rid: str) -> tuple[float, float, int]:
        x, y, z = self.layout.get(rid, (0.0, 0.0, 0))
        return float(x), float(y), int(z)

    def neighbours(self, rid: str) -> set[str]:
        out = {ex["to"] for ex in self.exits(rid).values() if ex.get("to")}
        out |= {other for other, r in self.rooms.items()
                if any(ex.get("to") == rid for ex in r["exits"].values())}
        return out

    def find(self, name: str, near: str | None = None) -> tuple[str | None, bool]:
        """Room id for a status-line name. Returns (id, certain). With several rooms of
        that name (Forest, Maze), prefer one next to `near`."""
        ids = self.by_name.get(name, [])
        if len(ids) == 1:
            return ids[0], True
        if not ids:
            return None, False
        if near:
            close = [i for i in ids if i in self.neighbours(near)]
            if len(close) == 1:
                return close[0], True
            if close:
                return close[0], False
        return ids[0], False

    @staticmethod
    def condition_note(cond: str) -> str:
        return CONDITIONS.get(cond, cond.lower().replace("-", " ")) if cond else ""
