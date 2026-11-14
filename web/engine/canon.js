// The canonical map: every room and exit from the game's source, plus a fixed layout
// (port of server/canon.py). Built by tools/build_map.py and tools/layout_map.py.

// Plain-English versions of the conditions in the source, shown as exit notes.
const CONDITIONS = {
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
};

const lowerKeys = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k.toLowerCase(), v]));

export class Canon {
  /** data: {map, layout, landmarks, details} — the parsed game/zork1-*.json files. */
  constructor({ map, layout, landmarks, details }) {
    this.source = map.source || "";
    this.rooms = {};
    for (const [rid, r] of Object.entries(map.rooms)) {
      const exits = {};
      for (const [d, ex0] of Object.entries(r.exits)) {
        const ex = { ...ex0 };
        if (ex.to) ex.to = ex.to.toLowerCase();
        exits[d] = ex;
      }
      this.rooms[rid.toLowerCase()] = { ...r, id: rid.toLowerCase(), exits };
    }
    this.layout = lowerKeys(layout);
    this.landmarks = {};
    this.roles = {};      // room id -> {landmark id: role}
    if (landmarks) this._loadLandmarks(landmarks.landmarks || {});
    // Room details written once by Claude (tools/describe_rooms.py), applied on discovery.
    this.details = lowerKeys(details && details.rooms);
    this.byName = {};
    for (const [rid, r] of Object.entries(this.rooms)) (this.byName[r.name] ||= []).push(rid);
    this._neigh = {};
  }

  /** Places drawn as one thing across several rooms (game/zork1-landmarks.json). */
  _loadLandmarks(data) {
    for (const [lid, lm0] of Object.entries(data)) {
      const lm = {};
      for (const [k, v] of Object.entries(lm0)) {
        lm[k] = typeof v === "string" && ["chimney", "via", "from", "to"].includes(k) ? v.toLowerCase() : v;
      }
      const roles = {};
      const setdefault = (rid, role) => { if (!(rid in roles)) roles[rid] = role; };
      for (const role of ["interior", "upstairs", "exterior", "members", "path"]) {
        for (const rid of lm[role] || []) setdefault(rid.toLowerCase(), role === "members" ? "member" : role);
      }
      for (const role of ["from", "via", "to"]) if (lm[role]) setdefault(lm[role], role);
      if (lm.big_tree) {
        roles[lm.big_tree.base.toLowerCase()] = "tree-base";
        roles[lm.big_tree.top.toLowerCase()] = "tree-top";
        lm.big_tree = Object.fromEntries(Object.entries(lm.big_tree).map(([k, v]) => [k, v.toLowerCase()]));
      }
      if (lm.window) lm.window = { ...lm.window, room: (lm.window.room || "").toLowerCase() };
      if (lm.path) lm.path = lm.path.map((r) => r.toLowerCase());
      lm.roles = Object.fromEntries(Object.entries(roles).filter(([rid]) => rid in this.rooms));
      this.landmarks[lid] = lm;
      for (const [rid, role] of Object.entries(lm.roles)) (this.roles[rid] ||= {})[lid] = role;
    }
  }

  /** Landmarks as the client should see them: only discovered parts (fog of war),
   *  except places you can see whole from outside (always_visible) once any part is found. */
  landmarksView(discovered, reveal = false) {
    const out = [];
    const pos = (rid) => this.position(rid);
    for (const [lid, lm] of Object.entries(this.landmarks)) {
      const members = Object.keys(lm.roles);
      const found = members.filter((r) => discovered.has(r));
      if (!reveal && !found.length) continue;
      const showAll = reveal || lm.always_visible;
      const rooms = [];
      for (const rid of members) {
        if (!showAll && !discovered.has(rid)) continue;
        const [x, y, z] = pos(rid);
        const known = reveal || discovered.has(rid);
        // Undiscovered parts of a visible landmark give their shape, not their name.
        rooms.push({ id: known ? rid : "", role: lm.roles[rid], x, y, z, discovered: discovered.has(rid) });
      }
      const view = { id: lid, kind: lm.kind, name: lm.name || lid, rooms };
      for (const k of ["door", "window", "chimney", "big_tree", "path"]) if (k in lm) view[k] = lm[k];
      // Room names inside these hints are spoilers: always send positions instead.
      if (view.chimney) view.chimney = pos(view.chimney);
      if (view.window) view.window = { ...view.window, room: pos(view.window.room) };
      if (view.big_tree) view.big_tree = Object.fromEntries(Object.entries(view.big_tree).map(([k, v]) => [k, pos(v)]));
      if ("path" in view) view.path = view.path.filter((r) => reveal || discovered.has(r)).map(pos);
      out.push(view);
    }
    return out;
  }

  name(rid) { return this.rooms[rid] ? this.rooms[rid].name : ""; }
  exits(rid) { return this.rooms[rid] ? this.rooms[rid].exits : {}; }
  target(rid, direction) { const ex = this.exits(rid)[direction]; return (ex && ex.to) || null; }

  position(rid) {
    const [x, y, z] = this.layout[rid] || [0, 0, 0];
    return [Number(x), Number(y), Math.trunc(Number(z))];
  }

  neighbours(rid) {
    if (this._neigh[rid]) return this._neigh[rid];
    const out = new Set(Object.values(this.exits(rid)).map((ex) => ex.to).filter(Boolean));
    for (const [other, r] of Object.entries(this.rooms)) {
      if (Object.values(r.exits).some((ex) => ex.to === rid)) out.add(other);
    }
    return (this._neigh[rid] = out);
  }

  /** Room id for a status-line name: [id, certain]. With several rooms of that name
   *  (Forest, Maze), prefer one next to `near`. */
  find(name, near = null) {
    const ids = this.byName[name] || [];
    if (ids.length === 1) return [ids[0], true];
    if (!ids.length) return [null, false];
    if (near) {
      const nb = this.neighbours(near);
      const close = ids.filter((i) => nb.has(i));
      if (close.length === 1) return [close[0], true];
      if (close.length) return [close[0], false];
    }
    return [ids[0], false];
  }

  static conditionNote(cond) {
    return cond ? (CONDITIONS[cond] || cond.toLowerCase().replaceAll("-", " ")) : "";
  }
}
