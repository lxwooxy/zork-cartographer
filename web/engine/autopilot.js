// Click-to-travel rulebook (port of server/autopilot.py): check each turn's text and
// decide whether to keep going, re-plan or stop.

const r = (p) => new RegExp(p, "is");

// Checked top to bottom; the first "stop" wins. Whether a move worked is decided by where
// we ended up, not by these phrases. Order matters: dangers before the thief rule, and
// the thief rule before generic combat (the thief's tactic is "just leave").
export const RULES = [
  { name: "death", pattern: r("\\*\\*\\*\\*\\s*You have died|you have died"), action: "stop",
    message: "You died. Travel stopped." },
  { name: "darkness", pattern: r("pitch black|likely to be eaten by a grue"), action: "stop",
    message: "It's pitch black here. Light a lamp before travelling on." },
  { name: "troll", pattern: r("troll[^.]*(blocks|fends you off|swings|axe)"), action: "stop",
    message: "The troll is in the way. Deal with it first (try: kill troll with sword)." },
  { name: "cyclops", pattern: r("cyclops[^.]*(blocks|let you past|doesn't look)"), action: "stop",
    message: "The cyclops blocks the way." },
  { name: "thief", pattern: r("\\bthief\\b|seedy-looking individual|large bag"), action: "flee",
    message: "The thief is here. Leaving right away." },
  { name: "theft", pattern: r("abstracted|stolen|steals|from your possession|robbed you"), action: "note",
    message: "Something may have been stolen. Type i later to check." },
  { name: "combat", pattern: r("\\b(hits|wounds|cuts|stabs|slashes|staggered|knocked)\\b"), action: "stop",
    message: "You're under attack. Travel stopped so you can decide what to do." },
  { name: "question", pattern: r("\\?\\s*$"), action: "stop",
    message: "The game asked a question. Answer it, then try again." },
  { name: "blocked", pattern: r("you can't go that way|is closed|solid rock|there is a wall|too narrow|" +
                                "you would need|impassable|the door is (locked|closed)"), action: "replan",
    message: "That way is blocked. Looking for another route." },
];

/** All rules that match this turn's text, in rulebook order. */
export function evaluate(text) {
  return RULES.filter((rule) => rule.pattern.test(text || ""));
}

/** Overall action for a turn: stop > replan > flee > continue. */
export function decide(matches) {
  const actions = new Set(matches.map((m) => m.action));
  if (actions.has("stop")) {
    // The thief's attacks shouldn't stop us: running away is the tactic.
    const thief = matches.some((m) => m.name === "thief");
    const stops = matches.filter((m) => m.action === "stop");
    if (thief && stops.every((m) => m.name === "combat")) return "flee";
    return "stop";
  }
  if (actions.has("replan")) return "replan";
  if (actions.has("flee")) return "flee";
  return "continue";
}
