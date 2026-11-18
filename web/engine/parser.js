// Rule-based parsing of Zork commands and output (port of server/parser.py, the parts
// the canonical map mode uses).

// Direction -> [dx, dy, dz]. x = east, y = north, z = up.
export const DIRECTIONS = {
  north: [0, 1, 0], south: [0, -1, 0], east: [1, 0, 0], west: [-1, 0, 0],
  northeast: [1, 1, 0], northwest: [-1, 1, 0], southeast: [1, -1, 0], southwest: [-1, -1, 0],
  up: [0, 0, 1], down: [0, 0, -1],
  in: [0, 0, 0], out: [0, 0, 0], land: [0, 0, 0],
};
export const ALIASES = {
  n: "north", s: "south", e: "east", w: "west",
  ne: "northeast", nw: "northwest", se: "southeast", sw: "southwest",
  u: "up", d: "down", enter: "in", inside: "in", exit: "out", outside: "out", leave: "out",
};
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const alias = (w) => (has(ALIASES, w) ? ALIASES[w] : w);

const FAILED_MOVE = [
  "you can't go that way", "the door is closed", "is closed", "you can't", "there is a wall",
  "too narrow", "it is too dark", "you are not able", "the window is closed",
  "solid rock", "wall is solid", "boarded", "there is no way", "you would need", "impassable",
];

/** The canonical direction a command moves in, if any. */
export function directionOf(command) {
  let words = command.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  if (["go", "walk", "run", "move"].includes(words[0]) && words.length > 1) words = words.slice(1);
  const w = alias(words[0]);
  if (has(DIRECTIONS, w) && words.length === 1) return w;
  if (w === "climb") {
    if (words.length > 1 && alias(words[1]) === "down") return "down";
    return "up";
  }
  if (w === "in" || w === "out") return w;   // "enter window", "exit house"
  return null;
}

/** Join hard-wrapped lines (dfrotz wraps at `width`; the browser engine doesn't wrap). */
export function unwrap(text, width = 250) {
  const paras = [];
  let prevLen = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) { prevLen = 0; continue; }
    if (paras.length && prevLen >= width - 30 && !line.startsWith("  ")) {
      paras[paras.length - 1] += " " + line.trim();
    } else {
      paras.push(line.startsWith("  ") ? line.replace(/\s+$/, "") : line.trim());
    }
    prevLen = line.length;
  }
  return paras;
}

/** If the output contains a room heading: [true, description, otherParagraphs]. */
export function splitRoomText(text, roomName) {
  const paras = unwrap(text);
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i].trim();
    if (p === roomName || p.startsWith(roomName + ",")) {   // "Kitchen, on the table"
      const rest = paras.slice(i + 1);
      return [true, rest.length ? rest[0] : "", rest.slice(1)];
    }
  }
  return [false, "", paras];
}

const ITEM_PATTERNS = [
  /^There (?:is|are) (an? |some |the )?(.+?) here\.?$/i,
  /^(?:An? |The )(.+?) (?:is|are) (?:here|lying|sitting|on the|in the)/i,
  /^On the .+? (?:is|are) (an? |some )?(.+?)\.$/i,
];

export function itemsMentioned(paragraphs) {
  const items = [];
  for (const p of paragraphs) {
    for (const pat of ITEM_PATTERNS) {
      const m = pat.exec(p.trim());
      if (m) {
        const name = m[m.length - 1].split(",")[0].trim().replace(/\.+$/, "");
        if (name && name.length < 60) items.push(name);
        break;
      }
    }
  }
  return items;
}

/** Parse the response to 'inventory'. null if this isn't an inventory listing. */
export function inventoryListing(text) {
  const t = text.trim();
  if (t.startsWith("You are empty-handed")) return [];
  if (!t.startsWith("You are carrying:")) return null;
  const items = [];
  for (const line of t.split("\n").slice(1)) {
    if (line.startsWith("  ") && !line.startsWith("    ") && !line.replace(/\s+$/, "").endsWith(":")) {
      let s = line.trim();   // (deeper lines are the contents of containers)
      s = s.replace(/^(an?|the|some)\s+/i, "");
      s = s.replace(/\s*\(.*?\)\s*$/, "");   // "(providing light)"
      items.push(s);
    }
  }
  return items;
}

/** [taken, dropped] object names from a take/drop command and its output. */
export function takeDrop(command, text) {
  const words = command.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [[], []];
  const verb = words[0];
  const taking = ["take", "get", "grab", "pick"].includes(verb);
  const dropping = ["drop", "throw", "put", "give"].includes(verb);
  if (!(taking || dropping)) return [[], []];
  const taken = [], dropped = [];
  for (const line of text.split("\n")) {
    const m = /^(.+?):\s*(Taken|Dropped|Done)\./.exec(line.trim());
    if (m) (m[2] === "Taken" ? taken : dropped).push(m[1]);
  }
  if (!taken.length && !dropped.length) {
    const first = text.trim() ? text.trim().split("\n")[0] : "";
    let obj = words.slice(1).filter((w) => !["up", "the", "a", "an"].includes(w)).join(" ");
    obj = obj.split(/\b(?:in|on|into|to|at)\b/)[0].trim();
    if (first === "Taken." && taking && obj) taken.push(obj);
    else if (["Dropped.", "Done.", "Thrown."].includes(first) && dropping && obj) dropped.push(obj);
  }
  return [taken, dropped];
}

export function isFailedMove(text) {
  const t = text.toLowerCase();
  return FAILED_MOVE.some((f) => t.includes(f));
}

const LOST = /(abstracted|stolen|steals?|snatche[sd]|took .* from you|from your possession|slips? from your|you drop|falls? from your|is knocked out of your|disappears)/i;

/** True when the game text hints that items left your hands (thief, combat, magic). */
export function inventoryChangedUnexpectedly(text) {
  return LOST.test(text);
}
