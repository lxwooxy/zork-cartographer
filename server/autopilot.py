"""Click-to-travel: walk a planned route one move at a time, checking each turn's
text against a small rulebook and deciding whether to keep going, re-plan or stop."""
from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass
class Rule:
    name: str
    pattern: re.Pattern
    action: str       # "stop", "flee" (keep moving), "replan", "note"
    message: str


def _r(p: str) -> re.Pattern:
    return re.compile(p, re.I | re.S)


# Checked top to bottom; the first "stop" wins. Whether a move worked is decided by where
# we ended up, not by these phrases (room descriptions mention "boarded" windows etc.). Order matters: dangers before the thief
# rule, and the thief rule before generic combat (the thief's tactic is "just leave").
RULES: list[Rule] = [
    Rule("death", _r(r"\*\*\*\*\s*You have died|you have died"), "stop",
         "You died. Travel stopped."),
    Rule("darkness", _r(r"pitch black|likely to be eaten by a grue"), "stop",
         "It's pitch black here. Light a lamp before travelling on."),
    Rule("troll", _r(r"troll[^.]*(blocks|fends you off|swings|axe)"), "stop",
         "The troll is in the way. Deal with it first (try: kill troll with sword)."),
    Rule("cyclops", _r(r"cyclops[^.]*(blocks|let you past|doesn't look)"), "stop",
         "The cyclops blocks the way."),
    Rule("thief", _r(r"\bthief\b|seedy-looking individual|large bag"), "flee",
         "The thief is here. Leaving right away."),
    Rule("theft", _r(r"abstracted|stolen|steals|from your possession|robbed you"), "note",
         "Something may have been stolen. Type i later to check."),
    Rule("combat", _r(r"\b(hits|wounds|cuts|stabs|slashes|staggered|knocked)\b"), "stop",
         "You're under attack. Travel stopped so you can decide what to do."),
    Rule("question", _r(r"\?\s*$"), "stop",
         "The game asked a question. Answer it, then try again."),
    Rule("blocked", _r(r"you can't go that way|is closed|solid rock|there is a wall|too narrow|"
                       r"you would need|impassable|the door is (locked|closed)"), "replan",
         "That way is blocked. Looking for another route."),
]


def evaluate(text: str) -> list[Rule]:
    """All rules that match this turn's text, in rulebook order."""
    return [r for r in RULES if r.pattern.search(text or "")]


def decide(matches: list[Rule]) -> str:
    """Overall action for a turn: stop > replan > flee > continue."""
    actions = {m.action for m in matches}
    if "stop" in actions:
        # The thief's attacks shouldn't stop us: running away is the tactic.
        thief = any(m.name == "thief" for m in matches)
        stops = [m for m in matches if m.action == "stop"]
        if thief and all(m.name == "combat" for m in stops):
            return "flee"
        return "stop"
    if "replan" in actions:
        return "replan"
    if "flee" in actions:
        return "flee"
    return "continue"
