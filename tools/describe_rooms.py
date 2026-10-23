"""Describe every room of the canonical map once with Claude, for the 3D views.

    .venv/bin/python tools/describe_rooms.py            # rooms not described yet
    .venv/bin/python tools/describe_rooms.py --force    # redo all of them
    .venv/bin/python tools/describe_rooms.py --dry-run  # show the prompt for one room, no API call

Needs ANTHROPIC_API_KEY (in .env or the environment). Writes game/zork1-details.json,
which the server applies to each room when you discover it (so fog of war still holds,
and no API calls are needed while playing). Commit the file after running.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GAME = ROOT / "game"
OUT = GAME / "zork1-details.json"
MODEL = os.environ.get("ZORK_LLM_MODEL", "claude-opus-5-5")

ENVIRONMENTS = ["house", "forest", "field", "river", "lake", "dam", "cave", "maze", "mine",
                "temple", "crypt", "canyon", "sky", "other"]
LEVEL_NAMES = {1: "above ground (treetops / attic)", 0: "the surface", -1: "the Great Underground Empire",
               -2: "deep underground", -3: "the bottom of the mine shaft"}

SYSTEM = """You are art-directing a 3D map of Zork I (Infocom, 1980), the Great Underground Empire.
For one room at a time you get its name, the game's own description, where it sits, and its neighbours.
Describe how it should look as a small 3D diorama, staying faithful to Zork I as written; use what you
know of the game, but don't invent puzzles, treasures or items. Don't mention items that can be picked up.
- environment: the closest of the listed kinds.
- indoor: true if enclosed (inside a building or underground with a ceiling).
- lighting: bright (daylight or lit), dim, or dark (needs a lamp).
- features: up to 6 fixed scenery things worth modelling, short and lowercase ("trophy case", "rickety staircase").
  Not exits, passages, doorways or directions: those are drawn already.
- palette: hex colors (#rrggbb) for floor, wall and accent that suit the place.
- visual: one vivid sentence (max 30 words) describing the scene, written for a player who has just arrived."""

SCHEMA = {
    "type": "object",
    "properties": {
        "environment": {"type": "string", "enum": ENVIRONMENTS},
        "indoor": {"type": "boolean"},
        "lighting": {"type": "string", "enum": ["bright", "dim", "dark"]},
        "features": {"type": "array", "items": {"type": "string"}},
        "palette": {
            "type": "object",
            "properties": {"floor": {"type": "string"}, "wall": {"type": "string"}, "accent": {"type": "string"}},
            "required": ["floor", "wall", "accent"],
            "additionalProperties": False,
        },
        "visual": {"type": "string"},
    },
    "required": ["environment", "indoor", "lighting", "features", "palette", "visual"],
    "additionalProperties": False,
}


EXIT_WORDS = re.compile(r"\b(passages?|openings?|exits?|doorways?|corridors?)\b", re.I)


def clean_features(features: list[str]) -> list[str]:
    """Scenery only: exits are drawn as paths already, so drop passage-like entries."""
    return [f for f in features if f and not EXIT_WORDS.search(f)][:6]


def load(name: str) -> dict:
    return json.loads((GAME / name).read_text())


def routine_text(source: str, name: str, limit: int = 900) -> str:
    """The text a room's ACTION routine prints (that's where 23 rooms keep their description)."""
    import re
    m = re.search(r"<ROUTINE " + re.escape(name) + r"\b(.*?)(?=\n<ROUTINE |\Z)", source, re.S)
    if not m:
        return ""
    strings = re.findall(r'"((?:\\.|[^"\\])*)"', m.group(1))
    text = " ".join(re.sub(r"\s+", " ", t).strip() for t in strings if len(t.strip()) > 3)
    return text[:limit]


def room_prompt(rid: str, rooms: dict, layout: dict, landmarks: dict, actions: str = "") -> str:
    r = rooms[rid]
    level = layout.get(rid, [0, 0, 0])[2]
    exits = []
    for d, ex in r["exits"].items():
        if ex.get("if") == "FALSE-FLAG":
            if ex.get("msg"):
                exits.append(f"{d}: \"{ex['msg']}\" (not a real exit)")
            continue
        if ex.get("to"):
            cond = f" (only if {ex['if'].lower()})" if ex.get("if") else ""
            exits.append(f"{d} -> {rooms[ex['to']]['name']}{cond}")
        elif ex.get("msg"):
            exits.append(f"{d}: \"{ex['msg']}\"")
    places = []
    for lid, lm in landmarks.items():
        for role in ("interior", "upstairs", "exterior", "members", "path"):
            if rid in lm.get(role, []):
                places.append(f"{lm.get('name', lid)} ({'part of it' if role == 'members' else role})")
        if lm.get("big_tree") and rid in lm["big_tree"].values():
            places.append("the big climbable tree in the forest")
        if rid in (lm.get("from"), lm.get("via"), lm.get("to")):
            places.append(lm.get("name", lid))
    flags = r.get("flags", [])
    facts = {
        "name": r["name"],
        "game_description": r.get("ldesc") or "(written in code; see game_text)",
        "game_text": "" if r.get("ldesc") else routine_text(actions, r.get("action", "")) or "(none; use what you know of this room)",
        "where": LEVEL_NAMES.get(level, f"level {level}"),
        "lit_by_daylight_or_lamps": "ONBIT" in flags,
        "water_room": "NONLANDBIT" in flags,
        "part_of_the_maze": "MAZEBIT" in flags,
        "part_of": places,
        "exits": exits,
    }
    return json.dumps(facts, indent=1)


async def describe(client, prompt: str) -> dict | None:
    import anthropic
    for attempt in range(3):
        try:
            resp = await client.beta.messages.create(
                model=MODEL,
                max_tokens=2000,
                system=SYSTEM,
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
                output_config={"effort": "medium", "format": {"type": "json_schema", "schema": SCHEMA}},
                messages=[{"role": "user", "content": prompt}],
            )
        except anthropic.AuthenticationError as e:
            sys.exit(f"Authentication failed: {e}. Check ANTHROPIC_API_KEY.")
        except (anthropic.RateLimitError, anthropic.APIConnectionError, anthropic.InternalServerError) as e:
            await asyncio.sleep(2 ** attempt * 3)
            continue
        except anthropic.APIStatusError as e:
            print(f"  API error {e.status_code}: {e.message}", file=sys.stderr)
            return None
        if resp.stop_reason in ("refusal", "max_tokens"):
            print(f"  stopped early: {resp.stop_reason}", file=sys.stderr)
            return None
        text = next((b.text for b in resp.content if b.type == "text"), "")
        try:
            d = json.loads(text)
        except json.JSONDecodeError:
            continue
        d["features"] = clean_features(d["features"])
        return d
    return None


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="redo rooms that already have details")
    ap.add_argument("--dry-run", action="store_true", help="print the prompt for one room and stop")
    ap.add_argument("--only", nargs="*", help="room ids to do (e.g. KITCHEN TROLL-ROOM)")
    ap.add_argument("--concurrency", type=int, default=6)
    args = ap.parse_args()

    rooms = load("zork1-map.json")["rooms"]
    layout = load("zork1-layout.json")
    landmarks = load("zork1-landmarks.json")["landmarks"] if (GAME / "zork1-landmarks.json").exists() else {}
    done = json.loads(OUT.read_text())["rooms"] if OUT.exists() else {}
    src = GAME / "source" / "1actions.zil"
    actions = src.read_text(errors="replace") if src.exists() else ""

    todo = [rid for rid in rooms if (args.force or rid not in done)]
    if args.only:
        todo = [rid for rid in todo if rid in set(args.only)]
    if args.dry_run:
        rid = todo[0] if todo else next(iter(rooms))
        print(SYSTEM, "\n---\n", room_prompt(rid, rooms, layout, landmarks, actions))
        return
    if not todo:
        print("All rooms already described. Use --force to redo them.")
        return

    from dotenv import load_dotenv
    load_dotenv(ROOT / ".env")
    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("ANTHROPIC_API_KEY is not set. Put it in .env (see .env.example).")
    import anthropic
    client = anthropic.AsyncAnthropic()

    sem = asyncio.Semaphore(args.concurrency)
    failed = []

    async def one(rid: str):
        async with sem:
            d = await describe(client, room_prompt(rid, rooms, layout, landmarks, actions))
        if d:
            done[rid] = d
            print(f"  {rid:22} {d['environment']:8} {d['lighting']:6} {d['visual'][:70]}")
        else:
            failed.append(rid)
            print(f"  {rid:22} FAILED", file=sys.stderr)

    print(f"Describing {len(todo)} rooms with {MODEL}...")
    await asyncio.gather(*(one(rid) for rid in todo))
    OUT.write_text(json.dumps({"model": MODEL, "rooms": dict(sorted(done.items()))}, indent=1) + "\n")
    print(f"Wrote {OUT.relative_to(ROOT)}: {len(done)} rooms described" + (f", {len(failed)} failed: {failed}" if failed else ""))


if __name__ == "__main__":
    asyncio.run(main())
