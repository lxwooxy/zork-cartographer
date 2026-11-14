// The whole game in the browser: a stand-in for the Python server (server/app.py) that the
// web UI talks to through the same small backend interface as web/backend-server.js.
//
// - Zork I runs in JSZM (engine/zmachine.js); its status line gives room, score and moves.
// - The canonical map, room tracking, items, inventory, routes and the autopilot are ports
//   of server/world.py, canon.py, parser.py and autopilot.py (canonical map mode only).
// - Checkpoints use the interpreter's own save state, kept in localStorage.
// - After every command the game is saved quietly, so a reload resumes where you were.
import { ZMachine, randomSeed } from "./zmachine.js";
import { Canon } from "./canon.js";
import { World } from "./world.js";
import * as autopilot from "./autopilot.js";

const MAX_AUTO_CHECKPOINTS = 8;
const MAX_STEPS = 60;
const MAX_REPLANS = 6;
const MAX_ATTEMPTS = 3;      // first try + 2 retries from the trip's checkpoint
const STEP_DELAY = 350;      // ms between moves, so you can watch the hops
// What happened on a turn that makes the autopilot undo the trip and try again.
const RETRY_ON = { death: "You died", theft: "Something was stolen" };

const PREFIX = "zork-cartographer:v1:";
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// ---------- browser storage (optional: everything works without it) ----------
const store = {
  ok: (() => {
    try { const k = PREFIX + "probe"; localStorage.setItem(k, "1"); localStorage.removeItem(k); return true; }
    catch { return false; }
  })(),
  get(k) {
    try { const v = localStorage.getItem(PREFIX + k); return v == null ? null : JSON.parse(v); } catch { return null; }
  },
  set(k, v) {
    try { localStorage.setItem(PREFIX + k, JSON.stringify(v)); return true; } catch { return false; }
  },
  del(k) { try { localStorage.removeItem(PREFIX + k); } catch {} },
  keys() {
    try {
      const out = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(PREFIX)) out.push(k.slice(PREFIX.length));
      }
      return out;
    } catch { return []; }
  },
};

function toB64(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(s) {
  const b = atob(s);
  const u = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return u;
}

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

/** @param {{base?: string}} [opts] base: folder holding zork1.z3 and its JSON files. */
export function createLocalBackend(opts = {}) {
  const base = opts.base || "game/";
  const subs = [];
  const S = {
    story: null, canon: null, game: null, world: null,
    travel: null, token: null, cpData: new Map(), warned: false,
  };

  const llm = () => ({ enabled: false, error: "", pending: 0, details: S.canon ? Object.keys(S.canon.details).length : 0 });
  const snapshot = () => ({ world: S.world.toJSON(), llm: llm(), travel: S.travel });
  function broadcast() {
    const s = snapshot();
    for (const f of subs) { try { f(s.world, s.llm, s.travel); } catch (e) { console.error(e); } }
  }

  // ---------- persistence ----------
  /** Save the game quietly and store it with the map, so a reload resumes here.
   *  Skipped while the game is waiting on a question (a save would lose its context);
   *  the previous good state stays. */
  function persist() {
    const g = S.game;
    if (!g || g.done) return;
    const last = g.last;
    if (last && (!last.prompt || /\?\s*$/.test(last.text))) return;
    const s = g.save();
    if (!s.ok) return;
    const okState = store.set("state", { data: toB64(s.data), rng: g.rng, turn: S.world.turn });
    const okWorld = store.set("world", S.world.toJSON(true));
    if (!(okState && okWorld) && !S.warned) {
      S.warned = true;
      S.world._log({ turn: S.world.turn, command: "", text: "[This browser won't let the page store data, so progress won't survive a reload. Everything else works.]",
                     room: S.world.current, score: S.world.score, moves: S.world.moves });
    }
  }

  function cpLoad(id) {
    if (S.cpData.has(id)) return S.cpData.get(id);
    const b = store.get("cp:" + id);
    if (!b) return null;
    try { const d = fromB64(b); S.cpData.set(id, d); return d; } catch { return null; }
  }

  function clearStorage() {
    for (const k of store.keys()) if (k === "world" || k === "state" || k.startsWith("cp:")) store.del(k);
    S.cpData.clear();
  }

  // ---------- game lifecycle ----------
  function freshGame() {
    const seed = randomSeed();
    S.world = new World(S.canon);
    S.world.seed = seed;
    S.game = new ZMachine(S.story, { seed });
    const intro = S.game.start();
    S.world.applyTurn(intro);
    S.game.send("verbose", true);   // always print full room descriptions
    persist();
  }

  function resumeSaved() {
    const w = store.get("world"), st = store.get("state");
    if (!w || !st || !st.data) return false;
    try {
      const world = World.load(w, S.canon);
      const game = new ZMachine(S.story, { seed: world.seed || randomSeed() });
      game.start();
      const r = game.restore(fromB64(st.data), st.rng);
      if (!r.ok) throw new Error("restore failed: " + r.text);
      S.world = world;
      S.game = game;
      return true;
    } catch (e) {
      console.warn("Couldn't resume the saved game; starting a new one.", e);
      return false;
    }
  }

  function runCommand(c) {
    const turn = S.game.send(c);
    const changes = S.world.applyTurn(turn);
    persist();
    broadcast();
    return [turn, changes];
  }

  // ---------- checkpoints ----------
  function doSave(name, auto = false) {
    const s = S.game.save();
    if (!s.ok) { console.warn("Save failed:", s.text); return null; }
    const id = S.world.nextSaveFile();
    S.cpData.set(id, s.data);
    store.set("cp:" + id, toB64(s.data));
    const cur = S.world.rooms.get(S.world.current);
    const cp = S.world.makeCheckpoint(name || `Turn ${S.world.turn} at ${cur ? cur.name : "?"}`, id, auto);
    // Keep the list short: drop the oldest automatic checkpoints.
    const autos = S.world.checkpoints.filter((c) => c.auto);
    for (const old of autos.slice(0, Math.max(0, autos.length - MAX_AUTO_CHECKPOINTS))) {
      S.world.checkpoints.splice(S.world.checkpoints.indexOf(old), 1);
      S.cpData.delete(old.id);
      store.del("cp:" + old.id);
    }
    persist();
    broadcast();
    return cp;
  }

  function doLoad(cp) {
    const data = cpLoad(cp.id);
    if (!data) { console.warn("No save data for", cp.id); return false; }
    const r = S.game.restore(data);
    if (!r.ok) { console.warn("Restore failed:", r.text); return false; }
    S.world.restoreCheckpoint(cp);
    persist();
    broadcast();
    return true;
  }

  const findCheckpoint = (id) => S.world.checkpoints.find((c) => c.id === id) || null;

  /** Stuck? Find the newest checkpoint from which the map knows a route to goal. */
  function suggestCheckpoint(goal) {
    for (const cp of [...S.world.checkpoints].reverse()) {
      if (cp.current === S.world.current) continue;
      const steps = S.world.route(cp.current, goal);
      if (steps !== null) return { id: cp.id, name: cp.name, turn: cp.turn, room_name: cp.room_name, moves: steps.length };
    }
    return null;
  }

  // ---------- click-to-travel ----------
  function cancelTravel(reason) {
    if (S.token && !S.token.done) {
      S.token.cancelled = true;
      S.token.done = true;
      if (S.travel) { S.travel.status = "stopped"; S.travel.message = reason; S.world.version += 1; }
      broadcast();
    }
    S.token = null;
  }

  function event(text, kind = "info") {
    S.travel.events.push({ turn: S.world.turn, kind, text });
    S.travel.message = text;
    S.world.version += 1;
  }

  function finish(status, text, kind, goal = null) {
    S.travel.status = status;
    event(text, kind);
    if ((status === "failed" || status === "stuck") && goal) S.travel.suggest = suggestCheckpoint(goal);
    broadcast();
  }

  /** Reload the trip's checkpoint and set up another attempt. False if out of attempts. */
  function retry(reason, goal) {
    const t = S.travel;
    const cp = findCheckpoint(t.checkpoint || "");
    if (!t.retry || !cp || t.attempt >= MAX_ATTEMPTS) return false;
    t.attempt += 1;
    event(`${reason}. Loading "${cp.name}" and trying again (attempt ${t.attempt} of ${MAX_ATTEMPTS}).`, "reload");
    if (!doLoad(cp)) return false;
    // Waiting a turn or two changes what the random events do next time.
    for (let i = 0; i < t.attempt - 1; i++) runCommand("wait");
    const steps = S.world.route(S.world.current, goal);
    if (steps === null) return false;
    t.steps = steps;
    broadcast();
    return true;
  }

  async function travelLoop(goal, token) {
    const t = S.travel;
    const W = S.world;
    let replans = 0;
    try {
      for (let i = 0; i < MAX_STEPS; i++) {
        if (token.cancelled) return;
        if (W.current === goal) return finish("arrived", `Arrived at ${t.to_name}.`, "done");
        if (!t.steps.length) break;
        const step = t.steps[0];
        const [turn] = runCommand(step.command);
        const matches = autopilot.evaluate(turn.text);
        const action = autopilot.decide(matches);
        for (const m of matches) if (m.action !== "replan") event(m.message, m.action);

        // Death or theft: undo the trip and try again, if allowed.
        const trig = matches.find((m) => m.name in RETRY_ON);
        if (trig) {
          if (retry(RETRY_ON[trig.name], goal)) {
            await sleep(STEP_DELAY);
            continue;
          }
          if (matches.some((m) => m.name === "death")) return finish("stopped", "Out of retries after dying.", "stop", goal);
        }

        if (W.current === goal) return finish("arrived", `Arrived at ${t.to_name}.`, "done");
        if (action === "stop") return finish("stopped", t.message, "stop", goal);

        if (W.current === step.to) {
          t.steps.shift();
          t.done += 1;
        } else {
          let why;
          if (W.current === step.from) {
            // We didn't move, whatever the game said. Mark that exit as blocked.
            const ex = W.rooms.get(step.from).exits[step.dir];
            if (ex && !ex.blocked) { ex.blocked = true; W.version += 1; persist(); }
            t.avoid.push([step.from, step.dir]);   // not again this trip
            const said = turn.text.trim() ? turn.text.trim().split("\n")[0] : "nothing";
            why = `Going ${step.dir} from ${W.rooms.get(step.from).name} didn't work ("${said}")`;
          } else {
            // Ended up somewhere else. applyTurn already corrected the map.
            why = `Going ${step.dir} led to ${W.rooms.get(W.current).name}, not where the map expected`;
          }
          replans += 1;
          const steps = W.route(W.current, goal, new Set(t.avoid.map(([a, b]) => `${a}|${b}`)));
          if (steps === null || replans > MAX_REPLANS) return finish("stuck", `${why}, and there's no other known route.`, "stop", goal);
          t.steps = steps;
          event(`${why}. New route: ${steps.map((x) => x.dir).join(" ")}.`, "replan");
        }
        broadcast();
        await sleep(STEP_DELAY);
      }
      if (token.cancelled) return;
      if (W.current === goal) return finish("arrived", `Arrived at ${t.to_name}.`, "done");
      return finish("failed", "Gave up: too many moves.", "stop", goal);
    } catch (e) {
      console.error(e);
      if (!token.cancelled) finish("stopped", "Something went wrong while travelling.", "stop", goal);
    } finally {
      token.done = true;
      if (!token.cancelled) broadcast();
    }
  }

  // ---------- the backend interface used by app.js ----------
  return {
    kind: "local",
    newGameText: "Start a new game? This clears the current game, its map and its saves from this browser.",

    subscribe(fn) { subs.push(fn); },

    async init() {
      const [story, map, layout, landmarks, details] = await Promise.all([
        fetch(base + "zork1.z3").then((r) => { if (!r.ok) throw new Error("zork1.z3: HTTP " + r.status); return r.arrayBuffer(); }),
        fetchJSON(base + "zork1-map.json"),
        fetchJSON(base + "zork1-layout.json"),
        fetchJSON(base + "zork1-landmarks.json").catch(() => null),
        fetchJSON(base + "zork1-details.json").catch(() => null),
      ]);
      S.story = new Uint8Array(story);
      S.canon = new Canon({ map, layout, landmarks, details });
      if (!resumeSaved()) { clearStorage(); freshGame(); }
      return snapshot();
    },

    async command(c) {
      c = (c || "").trim();
      if (!c) return { error: "empty command" };
      const lc = c.toLowerCase();
      if (["restart", "quit", "q"].includes(lc)) return { error: "Use the New game button to restart." };
      if (lc === "restore" || lc === "load") return { error: "Use Load in the Saves panel to go back to a save." };
      cancelTravel("You took over.");
      if (lc === "save") {
        const cp = doSave("");
        return cp ? {} : { error: "The game refused to save." };
      }
      const [turn, changes] = runCommand(c);
      return { text: turn.text, room: turn.room_name, score: turn.score, moves: turn.moves, changes };
    },

    async route(to) {
      if (!S.world.rooms.has(to)) return null;
      const steps = S.world.route(S.world.current, to);
      if (steps === null) return { to, reachable: false, steps: [], suggest: suggestCheckpoint(to) };
      return { to, reachable: true, steps };
    },

    async travel(to, fromCheckpoint = null, retryOn = true) {
      if (!S.world.rooms.has(to)) return { error: "no such room" };
      cancelTravel("New destination.");
      const name = S.world.rooms.get(to).name;
      if (fromCheckpoint) {
        const cp = findCheckpoint(fromCheckpoint);
        if (!cp || !doLoad(cp)) return { error: "Couldn't load that checkpoint." };
      }
      const steps = S.world.route(S.world.current, to);
      if (steps === null) {
        S.travel = { to, to_name: name, status: "stuck", steps: [], done: 0, events: [],
                     suggest: suggestCheckpoint(to), message: `No known route to ${name} from here.` };
        broadcast();
        return { error: S.travel.message, suggest: S.travel.suggest };
      }
      const cp = doSave(`Before trip to ${name}`, true);
      S.travel = { to, to_name: name, status: "moving", steps, done: 0, events: [],
                   checkpoint: cp ? cp.id : null, attempt: 1, retry: retryOn, avoid: [], message: `${steps.length} moves` };
      const token = (S.token = { cancelled: false, done: false });
      broadcast();
      setTimeout(() => travelLoop(to, token), 0);
      return { ok: true };
    },

    async stopTravel() { cancelTravel("Stopped."); return { ok: true }; },

    async save(name) {
      cancelTravel("Saving.");
      const cp = doSave((name || "").trim());
      return cp ? {} : { error: "The game refused to save." };
    },

    async load(id) {
      const cp = findCheckpoint(id);
      if (!cp) return { error: "no such checkpoint" };
      cancelTravel("Loading a checkpoint.");
      return doLoad(cp) ? { ok: true } : { error: "The game couldn't load that save." };
    },

    async setReveal(v) {
      S.world.reveal = !!v;
      S.world.version += 1;
      store.set("world", S.world.toJSON(true));
      broadcast();
      return { reveal: S.world.reveal };
    },

    async newGame() {
      cancelTravel("New game.");
      S.travel = null;
      clearStorage();
      freshGame();
      broadcast();
      return { ok: true };
    },
  };
}
