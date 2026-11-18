// Runs a Z-machine story in the browser with JSZM (web/vendor/jszm/jszm.js, public domain)
// and turns each command into a Turn, like server/game.py does with dfrotz.
//
// JSZM is a generator-based interpreter: it yields whenever our read() hook wants input,
// so each send() resumes it with the command and runs until the next prompt.

/**
 * @typedef {{command: string, text: string, room_name: string, score: number, moves: number, prompt: boolean}} Turn
 * prompt: the game is back at its normal ">" prompt (not asking a question).
 */

export class ZMachine {
  /** @param {Uint8Array} story  @param {{seed?: number}} [opts] */
  constructor(story, opts = {}) {
    const JSZM = globalThis.JSZM;
    if (!JSZM) throw new Error("JSZM interpreter not loaded");
    this.vm = new JSZM(story);
    this.seed = opts.seed ?? randomSeed();
    this.status = { room: "", score: 0, moves: 0 };
    this.out = "";
    this.done = false;
    this.lastSave = null;        // Uint8Array from the most recent SAVE
    this.pendingRestore = null;  // Uint8Array to hand to the next RESTORE
    this.last = null;
    this.lastCommand = "";
    const self = this;
    this.vm.print = function* (text) { self.out += text; };
    this.vm.read = function* () { return yield "read"; };
    this.vm.updateStatusLine = function* (text, moves, score) {
      // JSZM passes globals 2 (moves) and 1 (score), in that order.
      self.status = { room: text, score: score, moves: moves };
    };
    this.vm.save = function* (buf) { self.lastSave = buf.slice(); return true; };
    this.vm.restore = function* () { const d = self.pendingRestore; self.pendingRestore = null; return d || null; };
    this.vm.restarted = function* () { self.vm.seed = self.seed >>> 0; };
  }

  /** Start the game and return the opening text as a Turn. */
  start() {
    this.it = this.vm.run();
    this._resume(undefined);
    this.last = this._turn("");
    return this.last;
  }

  /** Send one command and return what the game printed. internal: a command the player
   *  didn't type (verbose, the quiet autosave), which doesn't count as the last turn. */
  send(command, internal = false) {
    let c = command.trim();
    if (this.done) return { command: c, text: "[The game has ended. Press New game to play again.]",
      room_name: this.status.room, score: this.status.score, moves: this.status.moves, prompt: false };
    // "again" would repeat our quiet autosave, so repeat the player's last command instead.
    if (!internal && /^(g|again)$/i.test(c) && this.lastCommand) c = this.lastCommand;
    this._resume(c);
    const t = this._turn(c);
    if (!internal) { this.last = t; this.lastCommand = c; }
    return t;
  }

  /** Save with the game's own SAVE. Returns {ok, data, text}; data is the interpreter state. */
  save() {
    this.lastSave = null;
    const t = this.send("save", true);
    const ok = !!this.lastSave && /\bOk\./.test(t.text);
    return { ok, data: ok ? this.lastSave : null, text: t.text };
  }

  /** Restore a state made by save(). The random numbers keep going (unless rng is given),
   *  so retrying after a restore can play out differently. */
  restore(data, rng) {
    this.pendingRestore = data;
    const t = this.send("restore", true);
    this.pendingRestore = null;
    const ok = /\bOk\./.test(t.text);
    if (ok && rng !== undefined && rng !== null) this.vm.seed = rng >>> 0;
    return { ok, text: t.text };
  }

  /** The interpreter's current random-number state (not part of a save file). */
  get rng() { return this.vm.seed >>> 0; }

  _resume(value) {
    this.out = "";
    let r = this.it.next(value);
    if (r.done) this.done = true;
    // Our hooks only yield to ask for input.
    while (!r.done && r.value !== "read") r = this.it.next();
    if (r.done) this.done = true;
  }

  _turn(command) {
    let text = this.out.replace(/\r/g, "");
    const prompt = /(^|\n)>\s*$/.test(text);
    text = text.trim().replace(/\n?>\s*$/, "").trim();
    return { command, text, room_name: this.status.room, score: this.status.score,
             moves: this.status.moves, prompt };
  }
}

export function randomSeed() {
  try {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    if (a[0]) return a[0];
  } catch {}
  return (Math.floor(Math.random() * 0xFFFFFFFF) >>> 0) || 1;
}
