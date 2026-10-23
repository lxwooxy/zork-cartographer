"""Rule-based parsing of Zork commands and output. Works without an LLM."""
from __future__ import annotations

import re

# Direction -> (dx, dy, dz). x = east, y = north, z = up.
DIRECTIONS: dict[str, tuple[int, int, int]] = {
    "north": (0, 1, 0), "south": (0, -1, 0), "east": (1, 0, 0), "west": (-1, 0, 0),
    "northeast": (1, 1, 0), "northwest": (-1, 1, 0), "southeast": (1, -1, 0), "southwest": (-1, -1, 0),
    "up": (0, 0, 1), "down": (0, 0, -1),
    "in": (0, 0, 0), "out": (0, 0, 0),
}
OPPOSITE = {
    "north": "south", "south": "north", "east": "west", "west": "east",
    "northeast": "southwest", "southwest": "northeast", "northwest": "southeast", "southeast": "northwest",
    "up": "down", "down": "up", "in": "out", "out": "in",
}
ALIASES = {
    "n": "north", "s": "south", "e": "east", "w": "west",
    "ne": "northeast", "nw": "northwest", "se": "southeast", "sw": "southwest",
    "u": "up", "d": "down", "enter": "in", "inside": "in", "exit": "out", "outside": "out", "leave": "out",
}

FAILED_MOVE = (
    "you can't go that way", "the door is closed", "is closed", "you can't", "there is a wall",
    "too narrow", "it is too dark", "you are not able", "the window is closed",
)


def direction_of(command: str) -> str | None:
    """Return the canonical direction a command moves in, if any."""
    words = command.lower().strip().split()
    if not words:
        return None
    if words[0] in ("go", "walk", "run", "move") and len(words) > 1:
        words = words[1:]
    w = ALIASES.get(words[0], words[0])
    if w in DIRECTIONS and len(words) == 1:
        return w
    if w == "climb":
        if len(words) > 1 and ALIASES.get(words[1], words[1]) == "down":
            return "down"
        return "up"
    if w == "in" or w == "out":  # "enter window", "exit house"
        return w
    if w in ("cross", "swim", "jump"):
        return None
    return None


def unwrap(text: str, width: int = 250) -> list[str]:
    """dfrotz hard-wraps long lines at `width`. Join a line onto the previous one
    only when the previous line was nearly full (i.e. it was wrapped)."""
    paras: list[str] = []
    prev_len = 0
    for line in text.split("\n"):
        if not line.strip():
            prev_len = 0
            continue
        if paras and prev_len >= width - 30 and not line.startswith("  "):
            paras[-1] += " " + line.strip()
        else:
            paras.append(line.rstrip() if line.startswith("  ") else line.strip())
        prev_len = len(line)
    return paras


def split_room_text(text: str, room_name: str) -> tuple[bool, str, list[str]]:
    """If the output contains a room heading, return (True, description, other_paragraphs)."""
    paras = unwrap(text)
    for i, p in enumerate(paras):
        if p.strip() == room_name or p.strip().startswith(room_name + ","):  # "Kitchen, on the table"
            rest = paras[i + 1:]
            desc = rest[0] if rest else ""
            return True, desc, rest[1:]
    return False, "", paras


ITEM_PATTERNS = [
    re.compile(r"^There (?:is|are) (an? |some |the )?(.+?) here\.?$", re.I),
    re.compile(r"^(?:An? |The )(.+?) (?:is|are) (?:here|lying|sitting|on the|in the)", re.I),
    re.compile(r"^On the .+? (?:is|are) (an? |some )?(.+?)\.$", re.I),
]


def items_mentioned(paragraphs: list[str]) -> list[str]:
    items = []
    for p in paragraphs:
        for pat in ITEM_PATTERNS:
            m = pat.match(p.strip())
            if m:
                name = m.groups()[-1].split(",")[0].strip().rstrip(".")
                if name and len(name) < 60:
                    items.append(name)
                break
    return items


def inventory_listing(text: str) -> list[str] | None:
    """Parse the response to 'inventory'. Returns None if this isn't an inventory listing."""
    t = text.strip()
    if t.startswith("You are empty-handed"):
        return []
    if not t.startswith("You are carrying:"):
        return None
    items = []
    for line in t.split("\n")[1:]:
        if line.startswith("  ") and not line.startswith("    ") and not line.rstrip().endswith(":"):
            s = line.strip()  # (deeper lines are the contents of containers)
            s = re.sub(r"^(an?|the|some)\s+", "", s, flags=re.I)
            s = re.sub(r"\s*\(.*?\)\s*$", "", s)  # "(providing light)"
            items.append(s)
    return items


def take_drop(command: str, text: str) -> tuple[list[str], list[str]]:
    """Return (taken, dropped) object names from a take/drop command and its output."""
    words = command.lower().split()
    if not words:
        return [], []
    verb = words[0]
    taking = verb in ("take", "get", "grab", "pick")
    dropping = verb in ("drop", "throw", "put", "give")
    if not (taking or dropping):
        return [], []
    taken, dropped = [], []
    for line in text.split("\n"):
        m = re.match(r"^(.+?):\s*(Taken|Dropped|Done)\.", line.strip())
        if m:
            (taken if m.group(2) == "Taken" else dropped).append(m.group(1))
    if not taken and not dropped:
        first = text.strip().split("\n")[0] if text.strip() else ""
        obj = " ".join(w for w in words[1:] if w not in ("up", "the", "a", "an"))
        obj = re.split(r"\b(in|on|into|to|at)\b", obj)[0].strip()
        if first in ("Taken.",) and taking and obj:
            taken.append(obj)
        elif first in ("Dropped.", "Done.", "Thrown.") and dropping and obj:
            dropped.append(obj)
    return taken, dropped


def is_failed_move(text: str) -> bool:
    t = text.lower()
    return any(f in t for f in FAILED_MOVE)


_DIR_WORDS = re.compile(
    r"\b(north|south|east|west|northeast|northwest|southeast|southwest|upward|upwards|downward|downwards|up|down)\b",
    re.I)


def exits_in_description(desc: str) -> list[str]:
    """Directions a room description mentions ("passages to the east and south")."""
    out = []
    for m in _DIR_WORDS.finditer(desc):
        w = m.group(1).lower()
        # "north side of the house" describes the house, not an exit
        after = desc[m.end():m.end() + 6].lower()
        if after.startswith(" side") or after.startswith(" wall"):
            continue
        w = {"upward": "up", "upwards": "up", "downward": "down", "downwards": "down"}.get(w, w)
        if w in ("up", "down"):
            # Only count up/down when it's near a way to travel ("staircase leading upward").
            window = desc[max(0, m.start() - 40):m.end() + 25]
            if not re.search(r"(stair|climb|ladder|ramp|chimney|hole|shaft|slide|lead|path|passage)", window, re.I):
                continue
        if w not in out:
            out.append(w)
    return out
