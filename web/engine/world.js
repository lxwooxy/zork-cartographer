// The map: rooms, exits, items and inventory, in canonical map mode
// (port of the parts of server/world.py that the canonical map uses).
import * as zp from "./parser.js";
import { Canon } from "./canon.js";

export const newExit = (o = {}) => ({ to: null, blocked: false, inferred: false, note: "", via: "", cond: "", hidden_to: "", ...o });

export const newRoom = (o) => ({
  id: "", name: "", description: "", x: 0, y: 0, z: 0, exits: {}, items: [], visits: 0, first_turn: 0, dark: false,
  environment: "", indoor: null, lighting: "", features: [], palette: {}, visual: "", enriched: false, ...o,
});

const clone = (o) => JSON.parse(JSON.stringify(o));
const LOG_KEEP = 400;   // log entries kept (the UI shows the last 200)

export class World {
  constructor(canon) {
    this.canon = canon;
    this.mode = "canonical";
    this.reveal = false;          // show the whole canonical map (spoilers)
    this.anomalies = [];          // where the game disagreed with the canonical map
    this.rooms = new Map();
    this.current = null;
    this.inventory = [];
    this.inventory_stale = false; // something happened we can't track (e.g. the thief)
    this.score = 0;
    this.moves = 0;
    this.turn = 0;
    this.version = 0;
    this.log = [];                // every command + output, for the UI
    this.checkpoints = [];        // saved game states (see makeCheckpoint)
    this.saves = 0;               // save counter, for unique checkpoint ids
    this.seed = 0;                // the game's starting random seed (for information)
  }

  // ---------- persistence ----------
  static load(d, canon) {
    const w = new World(canon);
    w.reveal = !!d.reveal;
    w.anomalies = d.anomalies || [];
    for (const r of d.rooms || []) {
      const exits = {};
      for (const [k, v] of Object.entries(r.exits || {})) exits[k] = newExit(v);
      w.rooms.set(r.id, newRoom({ ...r, exits }));
    }
    w.current = d.current ?? null;
    w.inventory = d.inventory || [];
    w.inventory_stale = !!d.inventory_stale;
    w.score = d.score || 0; w.moves = d.moves || 0; w.turn = d.turn || 0;
    w.version = d.version || 0;
    w.log = d.log || [];
    w.checkpoints = d.checkpoints || [];
    w.saves = d.saves || w.checkpoints.length;
    w.seed = d.seed || 0;
    // The layout is authoritative and may have been tuned since this game began.
    for (const r of w.rooms.values()) {
      if (r.id in canon.rooms) {
        [r.x, r.y, r.z] = canon.position(r.id);
        w._applyDetails(r);
      }
    }
    return w;
  }

  /** full: everything, for storage. Otherwise the view the UI gets (fog of war applied). */
  toJSON(full = false) {
    const d = {
      version: this.version,
      mode: this.mode,
      reveal: this.reveal,
      total_rooms: Object.keys(this.canon.rooms).length,
      anomalies: full ? this.anomalies : this.anomalies.slice(-20),
      current: this.current,
      inventory: [...this.inventory],
      inventory_stale: this.inventory_stale,
      score: this.score,
      moves: this.moves,
      turn: this.turn,
      rooms: clone([...this.rooms.values()]),
      checkpoints: full ? clone(this.checkpoints)
        : this.checkpoints.map((c) => Object.fromEntries(Object.entries(c).filter(([k]) => k !== "items"))),
    };
    if (full) {
      d.saves = this.saves;
      d.seed = this.seed;
    } else {
      // Fallback look for rooms without details (used by the 3D view).
      for (const rd of d.rooms) {
        rd.env3d = rd.environment || guessEnvironment(rd);
        rd.indoor3d = rd.indoor !== null && rd.indoor !== undefined ? !!rd.indoor : guessIndoor(rd);
        for (const ex of Object.values(rd.exits)) {
          if (!this.reveal) ex.hidden_to = "";      // no spoilers
          else if (!ex.to && ex.hidden_to) ex.to = ex.hidden_to;
        }
      }
      d.landmarks = this.canon.landmarksView(new Set(this.rooms.keys()), this.reveal);
      for (const rd of d.rooms) rd.roles = { ...(this.canon.roles[rd.id] || {}) };
      if (this.reveal) {
        // Fog of war off: add every room not found yet, marked as undiscovered.
        for (const cid of Object.keys(this.canon.rooms)) {
          if (this.rooms.has(cid)) continue;
          const rd = clone(this._canonRoom(cid));
          rd.undiscovered = true;
          rd.roles = { ...(this.canon.roles[cid] || {}) };
          rd.env3d = guessEnvironment(rd);
          rd.indoor3d = guessIndoor(rd);
          for (const ex of Object.values(rd.exits)) ex.to = ex.hidden_to;
          d.rooms.push(rd);
        }
      }
      d.reachable = this.reachable();
      d.confirmed = this.reachable(true);
    }
    d.log = full ? this.log.slice(-LOG_KEEP) : this.log.slice(-200);
    return d;
  }

  // ---------- checkpoints ----------
  nextSaveFile() {
    this.saves += 1;
    return `c${this.saves}`;
  }

  /** Record a checkpoint after the game has been saved as `id`. */
  makeCheckpoint(name, id, auto, text = "") {
    const cp = {
      id, name, file: id, auto,
      turn: this.turn, current: this.current, room_name: this.current ? this.rooms.get(this.current).name : "",
      score: this.score, moves: this.moves, inventory: [...this.inventory],
      items: Object.fromEntries([...this.rooms.values()].map((r) => [r.id, [...r.items]])),
      created: Date.now() / 1000,
    };
    this.checkpoints.push(cp);
    this._log({ turn: this.turn, command: "", kind: "save", file: id, text: text || `[Saved checkpoint: ${name}]`,
                room: this.current, score: this.score, moves: this.moves });
    this.version += 1;
    return cp;
  }

  /** After the game has restored cp: put the map's position, inventory and items back as
   *  they were. Everything explored since is kept. */
  restoreCheckpoint(cp, text = "") {
    this.turn += 1;
    if (this.rooms.has(cp.current)) {
      this.current = cp.current;
      this.rooms.get(this.current).visits += 1;
    }
    this.inventory = [...cp.inventory];
    this.inventory_stale = false;
    this.score = cp.score; this.moves = cp.moves;
    for (const [rid, items] of Object.entries(cp.items || {})) {
      if (this.rooms.has(rid)) this.rooms.get(rid).items = [...items];
    }
    this._log({ turn: this.turn, command: "", kind: "restore", file: cp.file, text: text || `[Loaded checkpoint: ${cp.name}]`,
                room: this.current, score: this.score, moves: this.moves });
    this.version += 1;
  }

  // ---------- routes ----------
  /** Cheapest known path from start to goal (Dijkstra). Each step: {dir, command, from, to}.
   *  avoid: a Set of "roomId|direction" strings not to use. */
  route(start, goal, avoid = null) {
    if (!this.rooms.has(start) || !this.rooms.has(goal)) return null;
    const dist = new Map([[start, 0]]);
    const prev = new Map();
    const heap = [[0, start]];
    const less = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
    while (heap.length) {
      let bi = 0;
      for (let i = 1; i < heap.length; i++) if (less(heap[i], heap[bi])) bi = i;
      const [d, rid] = heap.splice(bi, 1)[0];
      if (rid === goal) break;
      if (d > (dist.get(rid) ?? 1e9)) continue;
      for (const [direction, ex] of Object.entries(this.rooms.get(rid).exits)) {
        if (!ex.to || !this.rooms.has(ex.to) || (avoid && avoid.has(`${rid}|${direction}`))) continue;
        if (ex.blocked && !ex.cond) continue;
        // Guessed exits cost a bit more; conditional ones (a window that may be shut)
        // more again, and a lot more if they failed before (it might work now).
        const nd = d + 1 + (ex.inferred ? 0.5 : 0) + (ex.cond ? 1 : 0) + (ex.blocked ? 6 : 0);
        if (nd < (dist.get(ex.to) ?? 1e9)) {
          dist.set(ex.to, nd);
          prev.set(ex.to, [rid, direction]);
          heap.push([nd, ex.to]);
        }
      }
    }
    if (!dist.has(goal)) return null;
    const steps = [];
    let cur = goal;
    while (cur !== start) {
      const [frm, direction] = prev.get(cur);
      const ex = this.rooms.get(frm).exits[direction];
      steps.push({ dir: direction, command: ex.via || direction, from: frm, to: cur, inferred: ex.inferred, cond: ex.cond });
      cur = frm;
    }
    return steps.reverse();
  }

  /** Rooms you can walk to from here using known exits, with the number of moves.
   *  confirmedOnly: no guessed or conditional exits. */
  reachable(confirmedOnly = false) {
    if (!this.current) return {};
    const out = { [this.current]: 0 };
    const queue = [this.current];
    while (queue.length) {
      const rid = queue.shift();
      for (const ex of Object.values(this.rooms.get(rid).exits)) {
        if (ex.to && !ex.blocked && this.rooms.has(ex.to) && !(ex.to in out)) {
          if (confirmedOnly && (ex.inferred || ex.cond)) continue;
          out[ex.to] = out[rid] + 1;
          queue.push(ex.to);
        }
      }
    }
    return out;
  }

  // ---------- turn processing ----------
  /** Update the map from one game turn. Returns a small summary of what changed. */
  applyTurn(t) {
    this.turn += 1;
    this.score = t.score; this.moves = t.moves;
    const prev = this.current ? this.rooms.get(this.current) : null;
    const direction = t.command ? zp.directionOf(t.command) : null;
    const [hasHeading, desc, other] = zp.splitRoomText(t.text, t.room_name);
    const changes = { moved: false, new_room: false };

    const dark = t.room_name.toLowerCase() === "darkness" || t.text.toLowerCase().includes("it is pitch black");
    let moved = prev === null || t.room_name !== prev.name || (hasHeading && direction !== null);
    if (dark && prev !== null && direction === null) moved = false;
    if (prev !== null && direction && t.room_name === prev.name && !hasHeading) moved = false;  // same name, no new description

    if (moved && !(prev && t.room_name === prev.name && !hasHeading)) {
      const room = this._canonResolve(prev, direction, t.room_name, t.command);
      changes.new_room = room.visits === 0;
      room.visits += 1;
      if (desc && !room.description) room.description = desc;
      room.dark = room.dark || dark;
      if (prev !== null && room.id !== prev.id) {
        changes.moved = true;
        if (direction) this._link(prev, direction, room, t.command);
      }
      this.current = room.id;
    } else if (prev !== null && direction && zp.isFailedMove(t.text)) {
      (prev.exits[direction] ||= newExit()).blocked = true;
    }

    const room = this.rooms.get(this.current);
    if (hasHeading) room.items = dedupe(zp.itemsMentioned(other));   // a description lists what's lying around
    // Inventory
    const listing = zp.inventoryListing(t.text);
    if (listing !== null) {
      this.inventory = listing;
      this.inventory_stale = false;
    } else if (zp.inventoryChangedUnexpectedly(t.text)) {
      this.inventory_stale = true;
    }
    const [taken, dropped] = zp.takeDrop(t.command, t.text);
    for (const it of taken) {
      if (!this.inventory.some((x) => same(it, x))) this.inventory.push(it);
      room.items = room.items.filter((x) => !same(it, x));
    }
    for (const it of dropped) {
      this.inventory = this.inventory.filter((x) => !same(it, x));
      if (t.command.toLowerCase().startsWith("drop") && !room.items.some((x) => same(it, x))) room.items.push(it);
    }

    this._log({ turn: this.turn, command: t.command, text: t.text, room: this.current, score: t.score, moves: t.moves });
    this.version += 1;
    changes.room_id = this.current;
    changes.has_heading = hasHeading;
    return changes;
  }

  _log(entry) {
    this.log.push(entry);
    if (this.log.length > LOG_KEEP + 100) this.log = this.log.slice(-LOG_KEEP);
  }

  // ---------- canonical map ----------
  /** A Room for canonical id `cid`, positioned from the fixed layout (not registered). */
  _canonRoom(cid) {
    const c = this.canon.rooms[cid];
    const [x, y, z] = this.canon.position(cid);
    const room = newRoom({ id: cid, name: c.name, x, y, z, first_turn: this.turn });
    this._applyDetails(room);
    for (const [d, ce] of Object.entries(c.exits)) {
      if (!ce.to || ce.if === "FALSE-FLAG") continue;   // message-only or impossible "exits" aren't exits
      let note = Canon.conditionNote(ce.if || "");
      if (ce.oneway) note = (note ? note + "; " : "") + "one way";
      room.exits[d] = newExit({ to: this.rooms.has(ce.to) ? ce.to : null, note, cond: ce.if || "", hidden_to: ce.to });
    }
    return room;
  }

  /** Look, lighting, scenery and colors described once by Claude (game/zork1-details.json). */
  _applyDetails(room) {
    const d = this.canon.details[room.id];
    if (!d) return;
    if ("environment" in d) room.environment = d.environment;
    if ("indoor" in d) room.indoor = d.indoor;
    if ("lighting" in d) room.lighting = d.lighting;
    room.features = [...(d.features || room.features)];
    room.palette = Object.fromEntries(Object.entries(d.palette || {}).filter(([, v]) => typeof v === "string" && v.startsWith("#")));
    if ("visual" in d) room.visual = d.visual;
    room.enriched = true;
  }

  _discover(cid) {
    const room = this._canonRoom(cid);
    this.rooms.set(cid, room);
    // Exits from rooms we already know now lead somewhere visible.
    for (const other of this.rooms.values()) {
      for (const ex of Object.values(other.exits)) if (ex.hidden_to === cid) ex.to = cid;
    }
    return room;
  }

  _anomaly(text) { this.anomalies.push({ turn: this.turn, text }); }

  _canonResolve(prev, direction, name, command) {
    let cid = null;
    if (prev !== null && direction) {
      const predicted = this.canon.target(prev.id, direction);
      if (predicted && this.canon.name(predicted) === name) cid = predicted;
      else if (predicted) this._anomaly(`${prev.name} --${direction}--> map says ${this.canon.name(predicted)}, game says ${name}`);
    }
    if (cid === null) {
      let certain;
      [cid, certain] = this.canon.find(name, prev ? prev.id : null);
      if (cid === null) {
        this._anomaly(`'${name}' isn't in the canonical map (after '${command}')`);
        return this._resolveRoom(prev, direction, name);
      }
      if (!certain) this._anomaly(`'${name}' after '${command}' could be several rooms; guessed ${cid}`);
    }
    return this.rooms.get(cid) || this._discover(cid);
  }

  /** Fallback for a status-line name that isn't in the canonical map: reuse a room of
   *  that name, or make one next to where we were. */
  _resolveRoom(prev, direction, name) {
    if (prev && direction && prev.exits[direction]) {
      const to = prev.exits[direction].to;
      if (to && this.rooms.has(to) && this.rooms.get(to).name === name) return this.rooms.get(to);
    }
    const sameName = [...this.rooms.values()].filter((r) => r.name === name && !(r.id in this.canon.rooms));
    if (sameName.length) return sameName[0];
    const base = slug(name);
    let rid = base, n = 2;
    while (this.rooms.has(rid) || rid in this.canon.rooms) rid = `${base}-${n++}`;
    let [x, y, z] = prev ? [prev.x, prev.y, prev.z] : [0, 0, 0];
    if (prev && direction) {
      const [dx, dy, dz] = zp.DIRECTIONS[direction] || [0, 0, 0];
      x += dx || 1; y += dy; z += dz;
    } else if (prev) {
      x += 2;
    }
    const room = newRoom({ id: rid, name, x, y, z, first_turn: this.turn });
    this.rooms.set(rid, room);
    return room;
  }

  _link(a, direction, b, command = "") {
    const ex = (a.exits[direction] ||= newExit());
    ex.to = b.id; ex.blocked = false; ex.inferred = false;
    const c = command.toLowerCase().trim();
    if (command && (zp.ALIASES[c] || c) !== direction) ex.via = command.trim();
    // Canonical map: real exits only, no guessed reverse links.
  }
}

function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "room"; }

function norm(s) { return s.toLowerCase().trim().replace(/^(an?|the|some)\s+/, ""); }

function same(a, b) {
  a = norm(a); b = norm(b);
  return a === b || b.split(/\s+/).includes(a) || a.split(/\s+/).includes(b) || a.endsWith(b) || b.endsWith(a);
}

function dedupe(items) {
  const out = [];
  for (const i of items) if (!out.some((o) => same(i, o))) out.push(i);
  return out;
}

// Fallback guesses for rooms without details.
export function guessEnvironment(r) {
  const t = (r.name + " " + (r.description || "")).toLowerCase();
  for (const [env, words] of [
    ["maze", ["maze", "twisty"]],
    ["forest", ["forest", "tree", "clearing"]],
    ["river", ["river", "stream", "reservoir", "dam", "lake", "water", "beach", "shore"]],
    ["house", ["house", "kitchen", "attic", "living room", "cellar"]],
    ["temple", ["temple", "altar", "egyptian", "hades", "land of the dead"]],
    ["mine", ["mine", "coal", "shaft", "timber"]],
    ["cave", ["cave", "passage", "tunnel", "chasm", "gallery", "studio", "room"]],
  ]) {
    if (words.some((w) => t.includes(w))) return env;
  }
  return "cave";
}

export function guessIndoor(r) {
  return !["forest", "river"].includes(guessEnvironment(r)) && !r.name.toLowerCase().includes("house");
}
