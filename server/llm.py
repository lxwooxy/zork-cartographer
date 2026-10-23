"""Optional Claude pass that reads each turn and returns structured room/item info.

The game and the map work without this; Claude adds environment types, colors,
features and better item tracking that the Unity builder uses.
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path

import anthropic

log = logging.getLogger("zork.llm")

MODEL = os.environ.get("ZORK_LLM_MODEL", "claude-opus-5-5")
EFFORT = os.environ.get("ZORK_LLM_EFFORT", "low")

SYSTEM = """You help map the text adventure Zork I into a 3D world.
Each request gives you the player's command, the game's response, the current room, and what we already know.
Extract facts only from the game text. Keep names short and lowercase (e.g. "brass lantern", "rug").

Fields:
- room_description_shown: true only if the response includes the room's full description (after moving or "look").
- room.environment: one of house, forest, field, river, lake, dam, cave, maze, mine, temple, crypt, canyon, sky, other.
- room.indoor: true if enclosed (inside a building or underground).
- room.lighting: bright, dim or dark.
- room.features: up to 6 fixed scenery objects worth modelling (e.g. "trophy case", "oriental rug", "white house", "staircase").
- room.items_present: takeable or loose objects visible in the room now. Empty list if none or unknown.
- room.exits_mentioned: exits the description mentions, with a canonical direction (north, south, east, west, northeast, northwest, southeast, southwest, up, down, in, out) and a short note ("narrow path", "trap door").
- room.palette: hex colors (#rrggbb) for floor, wall and accent that suit the place.
- room.visual: one sentence describing how the room should look in 3D.
- inventory_known: true only if this response tells you the full inventory (e.g. after "inventory").
- inventory: the player's full inventory after this turn, using our current inventory plus anything taken/dropped this turn."""

SCHEMA = {
    "type": "object",
    "properties": {
        "room_description_shown": {"type": "boolean"},
        "room": {
            "type": "object",
            "properties": {
                "environment": {"type": "string"},
                "indoor": {"type": "boolean"},
                "lighting": {"type": "string"},
                "features": {"type": "array", "items": {"type": "string"}},
                "items_present": {"type": "array", "items": {"type": "string"}},
                "exits_mentioned": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {"direction": {"type": "string"}, "note": {"type": "string"}},
                        "required": ["direction", "note"],
                        "additionalProperties": False,
                    },
                },
                "palette": {
                    "type": "object",
                    "properties": {"floor": {"type": "string"}, "wall": {"type": "string"}, "accent": {"type": "string"}},
                    "required": ["floor", "wall", "accent"],
                    "additionalProperties": False,
                },
                "visual": {"type": "string"},
            },
            "required": ["environment", "indoor", "lighting", "features", "items_present",
                         "exits_mentioned", "palette", "visual"],
            "additionalProperties": False,
        },
        "inventory_known": {"type": "boolean"},
        "inventory": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["room_description_shown", "room", "inventory_known", "inventory"],
    "additionalProperties": False,
}


class Enricher:
    def __init__(self):
        self.client: anthropic.AsyncAnthropic | None = None
        self.error: str | None = None
        has_creds = any(os.environ.get(k) for k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_PROFILE")) \
            or (Path.home() / ".config" / "anthropic").exists()
        if os.environ.get("ZORK_LLM", "on").lower() == "off":
            self.error = "turned off with ZORK_LLM=off"
        elif not has_creds:
            self.error = "no ANTHROPIC_API_KEY found (put it in .env)"
        else:
            try:
                self.client = anthropic.AsyncAnthropic()
            except Exception as e:
                self.error = str(e)

    @property
    def enabled(self) -> bool:
        return self.client is not None

    async def analyze(self, command: str, output: str, room: dict, inventory: list[str]) -> dict | None:
        if not self.client:
            return None
        known = {
            "room_name": room.get("name"),
            "room_description": room.get("description"),
            "known_exits": list(room.get("exits", {}).keys()),
            "known_items": room.get("items"),
            "current_inventory": inventory,
        }
        prompt = (
            f"<known>\n{json.dumps(known, indent=1)}\n</known>\n"
            f"<command>{command or '(game start)'}</command>\n"
            f"<response>\n{output}\n</response>"
        )
        try:
            resp = await self.client.beta.messages.create(
                model=MODEL,
                max_tokens=4000,
                system=SYSTEM,
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
                output_config={"effort": EFFORT, "format": {"type": "json_schema", "schema": SCHEMA}},
                messages=[{"role": "user", "content": prompt}],
            )
        except anthropic.AuthenticationError as e:
            self.error = f"Claude authentication failed: {e}"
            self.client = None
            log.warning(self.error)
            return None
        except anthropic.RateLimitError:
            log.warning("Claude rate limited; skipping this turn")
            return None
        except anthropic.APIStatusError as e:
            log.warning("Claude API error %s: %s", e.status_code, e.message)
            return None
        except anthropic.APIConnectionError as e:
            log.warning("Could not reach Claude: %s", e)
            return None
        except TypeError as e:  # e.g. credentials could not be resolved
            self.error = str(e)
            self.client = None
            return None
        if resp.stop_reason in ("refusal", "max_tokens"):
            log.warning("Claude stopped early (%s)", resp.stop_reason)
            return None
        text = next((b.text for b in resp.content if b.type == "text"), None)
        if not text:
            return None
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            log.warning("Claude returned invalid JSON")
            return None
