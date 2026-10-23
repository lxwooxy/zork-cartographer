// Zork Cartographer web UI: terminal, 2D map, room panel and inventory.
const $ = (id) => document.getElementById(id);
const SVGNS = "http://www.w3.org/2000/svg";
const SCALE = 110;          // pixels per map unit
const ROOM_W = 84, ROOM_H = 40;
const DIR_VEC = {
  north: [0, 1], south: [0, -1], east: [1, 0], west: [-1, 0],
  northeast: [1, 1], northwest: [-1, 1], southeast: [1, -1], southwest: [-1, -1],
};

let world = null;
let travel = null;          // autopilot trip state from the server
let preview = null;         // {to, reachable, steps, suggest} for the selected room
let level = 0;
let selected = null;        // room id shown in the side panel (null = current room)
let view = { x: 0, y: 0, k: 1 };   // pan offset (px) and zoom
let lastLogLen = 0;
const history = [];
let histIdx = 0;

// ---------- server connection ----------
function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "world") update(msg.world, msg.llm, msg.travel);
  };
  ws.onclose = () => setTimeout(connect, 1000);
}

async function send(command) {
  appendLog(command, null);
  const r = await fetch("/api/command", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command }),
  });
  const data = await r.json();
  if (data.error) appendLog(null, data.error);
}

// ---------- terminal ----------
function appendLog(command, text) {
  const log = $("log");
  if (command !== null) {
    const c = document.createElement("div");
    c.className = "cmd";
    c.textContent = "> " + command;
    c.dataset.pending = "1";
    log.appendChild(c);
  }
  if (text) {
    const t = document.createElement("div");
    t.textContent = text;
    log.appendChild(t);
  }
  log.scrollTop = log.scrollHeight;
}

function renderLog(entries) {
  // Rebuild only when new entries arrive.
  if (entries.length === lastLogLen) return;
  lastLogLen = entries.length;
  const log = $("log");
  log.innerHTML = "";
  for (const e of entries) {
    if (e.command) {
      const c = document.createElement("div");
      c.className = "cmd";
      c.textContent = "> " + e.command;
      log.appendChild(c);
    }
    const t = document.createElement("div");
    const room = world.rooms.find((r) => r.id === e.room);
    const lines = e.text.split("\n");
    lines.forEach((line, i) => {
      const span = document.createElement("span");
      span.textContent = line + (i < lines.length - 1 ? "\n" : "");
      if (room && line.trim() === room.name) span.className = "heading";
      t.appendChild(span);
    });
    log.appendChild(t);
  }
  log.scrollTop = log.scrollHeight;
}

$("cmdform").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("cmd").value.trim();
  if (!v) return;
  history.push(v);
  histIdx = history.length;
  $("cmd").value = "";
  send(v);
});
$("cmd").addEventListener("keydown", (e) => {
  if (e.key === "ArrowUp" && histIdx > 0) { histIdx--; $("cmd").value = history[histIdx]; e.preventDefault(); }
  if (e.key === "ArrowDown") { histIdx = Math.min(history.length, histIdx + 1); $("cmd").value = history[histIdx] || ""; e.preventDefault(); }
});

// ---------- state ----------
function update(w, llm, tr) {
  const prevCurrent = world && world.current;
  world = w;
  travel = tr || null;
  const cur = currentRoom();
  $("score").textContent = w.score;
  $("moves").textContent = w.moves;
  const found = w.rooms.filter((r) => !r.undiscovered).length;
  $("roomcount").textContent = w.total_rooms ? `${found}/${w.total_rooms}` : found;
  // Map mode: canonical (exact, fog of war) or heuristic (built from play).
  const mm = $("mapmode");
  if (w.mode === "canonical") {
    mm.hidden = false;
    const n = (w.anomalies || []).length;
    mm.textContent = n ? `Map: ${n} mismatch${n === 1 ? "" : "es"}` : "Map ✓";
    mm.className = "pill " + (n ? "warn" : "on");
    mm.title = n ? "The game disagreed with the canonical map here:\n" + w.anomalies.map((a) => `turn ${a.turn}: ${a.text}`).join("\n")
                 : "Exact map from the game's source. Rooms appear as you discover them.";
    $("revealwrap").hidden = false;
    $("reveal").checked = !!w.reveal;
  } else {
    mm.hidden = true;
    $("revealwrap").hidden = true;
  }
  const pill = $("llm");
  if (llm.details) {
    // Room details were written once ahead of time; nothing is called during play.
    pill.textContent = "Room details ✓";
    pill.className = "pill on";
    pill.title = `Looks, lighting, scenery and colors for ${llm.details} rooms, written once by Claude (game/zork1-details.json). Shown as you discover each room.`;
  } else if (llm.enabled) {
    pill.textContent = llm.pending ? `Claude: parsing (${llm.pending})` : "Claude: on";
    pill.className = "pill on";
  } else {
    pill.textContent = "Claude: off";
    pill.className = "pill off";
    pill.title = "Rule-based parsing only. Add ANTHROPIC_API_KEY to .env to turn Claude on.\n" + (llm.error || "");
  }
  if (cur && $("follow").checked && (cur.id !== prevCurrent || prevCurrent === undefined)) {
    level = cur.z;
    centerOn(cur);
    selected = null;
  }
  renderLog(w.log);
  if (prevCurrent && prevCurrent !== w.current && selected) refreshPreview();
  if (window.world3d) window.world3d.update(w, overlay());
  renderMap();
  renderPanel();
  renderInventory();
  renderTravel();
  renderCheckpoints();
}

// What the map should highlight: the trip in progress, or the previewed route.
function overlay() {
  const moving = travel && travel.status === "moving";
  const steps = moving ? travel.steps : (preview && preview.reachable ? preview.steps : []);
  return {
    route: steps,
    target: moving ? travel.to : (preview ? preview.to : null),
    reachable: world.reachable || {},
    confirmed: world.confirmed || {},
  };
}

function currentRoom() {
  return world && world.rooms.find((r) => r.id === world.current);
}

// ---------- 2D map ----------
const svg = $("map");

function toScreen(x, y) {
  return [x * SCALE * view.k + view.x, -y * SCALE * view.k + view.y];
}

function centerOn(room) {
  const rect = svg.getBoundingClientRect();
  view.x = rect.width / 2 - room.x * SCALE * view.k;
  view.y = rect.height / 2 + room.y * SCALE * view.k;
}

function el(name, attrs, parent) {
  const e = document.createElementNS(SVGNS, name);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

function renderMap() {
  if (!world) return;
  $("level").textContent = level;
  svg.innerHTML = "";
  const byId = Object.fromEntries(world.rooms.map((r) => [r.id, r]));
  const defs = el("defs", {}, svg);
  const f = el("filter", { id: "glow", x: "-50%", y: "-50%", width: "200%", height: "200%" }, defs);
  el("feGaussianBlur", { stdDeviation: 5 }, f);
  const g = el("g", {}, svg);
  const k = view.k;
  const ov = overlay();

  // Rooms on other levels: faint outlines, for context.
  for (const r of world.rooms) {
    if (r.z === level) continue;
    if (Math.abs(r.z - level) > 1) continue;
    const [sx, sy] = toScreen(r.x, r.y);
    const gr = el("g", { class: "room ghost" }, g);
    el("rect", { x: sx - ROOM_W * k / 2, y: sy - ROOM_H * k / 2, width: ROOM_W * k, height: ROOM_H * k }, gr);
  }

  // Edges.
  const drawn = new Set();
  for (const r of world.rooms) {
    if (r.z !== level) continue;
    const [ax, ay] = toScreen(r.x, r.y);
    for (const [dir, ex] of Object.entries(r.exits)) {
      const vec = DIR_VEC[dir];
      if (ex.to && byId[ex.to]) {
        const b = byId[ex.to];
        if (b.z !== level) continue;
        const key = [r.id, b.id].sort().join("|");
        if (drawn.has(key)) continue;
        drawn.add(key);
        const [bx, by] = toScreen(b.x, b.y);
        const hidden = r.undiscovered || b.undiscovered;
        el("line", { x1: ax, y1: ay, x2: bx, y2: by, class: "edge" + (ex.inferred || ex.cond ? " inferred" : "") + (hidden ? " hidden" : "") }, g);
      } else if (vec && !r.undiscovered) {
        // Exit we know about but haven't taken (or that was blocked).
        const len = 0.42 * SCALE * k;
        const n = Math.hypot(vec[0], vec[1]);
        const ex2 = ax + (vec[0] / n) * len, ey2 = ay - (vec[1] / n) * len;
        el("line", { x1: ax, y1: ay, x2: ex2, y2: ey2, class: ex.blocked ? "blocked" : "stub" }, g);
        if (ex.blocked) {
          const t = el("text", { x: ex2, y: ey2 + 4, fill: "var(--warn)", "text-anchor": "middle", "font-size": 12 }, g);
          t.textContent = "×";
        }
      }
    }
  }

  // The route being previewed or travelled: a glowing line, room to room.
  for (const st of ov.route) {
    const a = byId[st.from], b = byId[st.to];
    if (!a || !b) continue;
    if (a.z !== level && b.z !== level) continue;
    const [ax, ay] = toScreen(a.x, a.y);
    const [bx, by] = a.z === b.z ? toScreen(b.x, b.y) : [ax, ay - 26 * k * (b.z > a.z ? 1 : -1)];
    el("line", { x1: ax, y1: ay, x2: bx, y2: by, class: "route-glow" }, g);
    el("line", { x1: ax, y1: ay, x2: bx, y2: by, class: "route" }, g);
  }

  // Rooms on this level.
  const routeRooms = new Set(ov.route.map((st) => st.to));
  for (const r of world.rooms) {
    if (r.z !== level) continue;
    const [sx, sy] = toScreen(r.x, r.y);
    // Glowing tiles: where you can walk from here.
    const glow = r.id === world.current ? null
      : r.id in ov.confirmed ? (ov.confirmed[r.id] === 1 ? "near" : "reach")
      : r.id in ov.reachable ? "maybe" : null;
    const pad = 7 * k;
    if (glow || routeRooms.has(r.id)) {
      el("rect", { x: sx - ROOM_W * k / 2 - pad / 2, y: sy - ROOM_H * k / 2 - pad / 2,
        width: ROOM_W * k + pad, height: ROOM_H * k + pad, rx: 10,
        class: "tileglow " + (routeRooms.has(r.id) ? "onroute" : glow) }, g);
    }
    if (r.id === world.current) {
      el("circle", { cx: sx, cy: sy, r: ROOM_W * k * 0.62, class: "here-pulse" }, g);
    }
    const cls = ["room"];
    if (r.undiscovered) cls.push("undiscovered");
    if (r.id === ov.target) cls.push("target");
    if (r.id === selected) cls.push("selected");
    if (r.id === world.current) cls.push("current");
    if (r.dark || r.lighting === "dark") cls.push("dark");
    const gr = el("g", { class: cls.join(" "), "data-id": r.id }, g);
    const rect = el("rect", { x: sx - ROOM_W * k / 2, y: sy - ROOM_H * k / 2, width: ROOM_W * k, height: ROOM_H * k }, gr);
    if (r.palette && r.palette.floor) rect.style.fill = mix(r.palette.floor, "#161b19", 0.55);
    const label = el("text", { x: sx, y: sy + 4 }, gr);
    label.textContent = shorten(r.name, Math.floor(13 * k));
    label.style.fontSize = `${Math.max(8, 11 * Math.min(k, 1.3))}px`;
    const ups = [];
    if (r.exits.up) ups.push("▲");
    if (r.exits.down) ups.push("▼");
    if (r.exits.in || r.exits.out) ups.push("◆");
    if (ups.length) {
      const b = el("text", { x: sx + ROOM_W * k / 2 - 8, y: sy - ROOM_H * k / 2 + 12, class: "badge" }, gr);
      b.textContent = ups.join("");
    }
    if (r.items.length) {
      el("circle", { cx: sx - ROOM_W * k / 2 + 7, cy: sy - ROOM_H * k / 2 + 7, r: 3.5, class: "itemdot" }, gr);
    }
    if (r.id === world.current) {
      const you = el("text", { x: sx, y: sy - ROOM_H * k / 2 - 8, class: "you" }, gr);
      you.textContent = "YOU ARE HERE";
    }
    gr.addEventListener("click", (ev) => { ev.stopPropagation(); selectRoom(r.id); });
    gr.addEventListener("dblclick", (ev) => { ev.stopPropagation(); goTo(r.id); });
  }
}

// ---------- click-to-travel ----------
async function selectRoom(id) {
  selected = id === world.current ? null : id;
  preview = null;
  await refreshPreview();
}

async function refreshPreview() {
  if (!selected || selected === world.current) { preview = null; refreshViews(); return; }
  const r = await fetch(`/api/route?to=${encodeURIComponent(selected)}`);
  preview = r.ok ? await r.json() : null;
  refreshViews();
}

function refreshViews() {
  renderMap();
  renderPanel();
  if (window.world3d && world) window.world3d.update(world, overlay());
}

async function goTo(id, fromCheckpoint) {
  if (!id || id === world.current) return;
  selected = id;
  const body = { to: id };
  if (fromCheckpoint) body.from_checkpoint = fromCheckpoint;
  const r = await fetch("/api/travel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    if (d.error) appendLog(null, "[Autopilot] " + d.error);
  }
}

async function stopTravel() { await fetch("/api/travel/stop", { method: "POST" }); }

function renderTravel() {
  const box = $("travel");
  const t = travel;
  if (!t || (t.status !== "moving" && !t.events.length && t.status !== "stuck")) { box.hidden = true; return; }
  box.hidden = false;
  box.className = "travel " + t.status;
  const labels = { moving: "Travelling", arrived: "Arrived", stopped: "Stopped", stuck: "Stuck", failed: "Couldn't get there" };
  const total = t.done + (t.steps ? t.steps.length : 0);
  let html = `<div class="travel-head"><b>${labels[t.status] || t.status}</b> → ${esc(t.to_name)}`;
  if (t.status === "moving") html += ` <span class="muted">(${t.done}/${total}${t.attempt > 1 ? `, attempt ${t.attempt}` : ""})</span>`;
  html += `<span class="spacer"></span>`;
  if (t.status === "moving") html += `<button id="tstop">Stop</button>`;
  else html += `<button id="tclose" title="Hide">✕</button>`;
  html += `</div><div class="travel-msg">${esc(t.message || "")}</div>`;
  // The latest event is the message above; list the few before it.
  const earlier = t.events.slice(-4, -1);
  if (earlier.length) html += `<ul class="travel-events">${earlier.map((e) => `<li class="${e.kind}">${esc(e.text)}</li>`).join("")}</ul>`;
  if (t.suggest && t.status !== "moving") {
    const m = t.suggest.moves;
    const how = m === 0 ? "it starts there" : `then ${m} move${m === 1 ? "" : "s"}`;
    html += `<button id="tsuggest" class="primary">Load “${esc(t.suggest.name)}” (${how})</button>`;
  }
  box.innerHTML = html;
  if ($("tstop")) $("tstop").onclick = stopTravel;
  if ($("tclose")) $("tclose").onclick = () => { travel = null; box.hidden = true; };
  if ($("tsuggest")) $("tsuggest").onclick = () => {
    if (confirm(`Load the checkpoint “${t.suggest.name}” (turn ${t.suggest.turn})? Progress since then is undone, but the map keeps everything you've explored.`)) goTo(t.to, t.suggest.id);
  };
}

// ---------- checkpoints ----------
function renderCheckpoints() {
  const ul = $("checkpoints");
  ul.innerHTML = "";
  const cps = (world.checkpoints || []).slice().reverse();
  if (!cps.length) { ul.innerHTML = `<li class="empty">No saves yet</li>`; return; }
  for (const c of cps) {
    const li = document.createElement("li");
    li.className = "cp" + (c.auto ? " auto" : "");
    li.innerHTML = `<span class="cpname">${esc(c.name)}</span><span class="muted">turn ${c.turn} · ${esc(c.room_name)}</span>`;
    const b = document.createElement("button");
    b.textContent = "Load";
    b.onclick = async () => {
      if (!confirm(`Load “${c.name}”? Progress since turn ${c.turn} is undone, but the map keeps everything you've explored.`)) return;
      await fetch(`/api/checkpoints/${c.id}/load`, { method: "POST" });
    };
    li.appendChild(b);
    ul.appendChild(li);
  }
}

$("savebtn").onclick = async () => {
  const cur = currentRoom();
  const name = prompt("Name this save:", cur ? `${cur.name}, turn ${world.turn}` : "");
  if (name === null) return;
  await fetch("/api/checkpoints", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
};

function shorten(s, n) { return s.length > n ? s.slice(0, Math.max(3, n - 1)) + "…" : s; }

function mix(a, b, t) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  try {
    const [x, y] = [p(a), p(b)];
    return "rgb(" + x.map((v, i) => Math.round(v * (1 - t) + y[i] * t)).join(",") + ")";
  } catch { return a; }
}

// Pan and zoom.
let drag = null;
svg.addEventListener("mousedown", (e) => { drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }; });
window.addEventListener("mousemove", (e) => {
  if (!drag) return;
  view.x = drag.vx + e.clientX - drag.x;
  view.y = drag.vy + e.clientY - drag.y;
  drag.moved = true;
  renderMap();
});
let justDragged = false;
window.addEventListener("mouseup", () => {
  justDragged = !!(drag && drag.moved);
  if (justDragged) $("follow").checked = false;
  drag = null;
});
svg.addEventListener("wheel", (e) => {
  e.preventDefault();
  const rect = svg.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const f = Math.exp(-e.deltaY * 0.0015);
  const nk = Math.min(3, Math.max(0.25, view.k * f));
  view.x = mx - (mx - view.x) * (nk / view.k);
  view.y = my - (my - view.y) * (nk / view.k);
  view.k = nk;
  renderMap();
}, { passive: false });
svg.addEventListener("click", () => { if (justDragged) return; selected = null; preview = null; refreshViews(); });

$("lvlup").onclick = () => { level++; $("follow").checked = false; renderMap(); };
$("lvldown").onclick = () => { level--; $("follow").checked = false; renderMap(); };
$("center").onclick = () => {
  if (mode3d) { window.world3d && window.world3d.center(); return; }
  const c = currentRoom(); if (c) { level = c.z; centerOn(c); renderMap(); }
};
$("follow").onchange = () => {
  if (window.world3d) window.world3d.setFollow($("follow").checked);
  if ($("follow").checked) $("center").onclick();
};

// ---------- 2D / 3D toggle ----------
let mode3d = false;
function setMode(is3d) {
  mode3d = is3d;
  $("mode2d").classList.toggle("on", !is3d);
  $("mode3d").classList.toggle("on", is3d);
  $("mapwrap").classList.toggle("is3d", is3d);
  svg.style.display = is3d ? "none" : "block";
  $("view3d").hidden = !is3d;
  if (window.world3d) {
    window.world3d.setVisible(is3d);
    if (is3d && world) window.world3d.update(world, overlay());
  }
  try { localStorage.setItem("zork-view", is3d ? "3d" : "2d"); } catch {}
  if (!is3d) renderMap();
}
$("reveal").onchange = async () => {
  await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reveal: $("reveal").checked }) });
};
$("mode2d").onclick = () => setMode(false);
$("mode3d").onclick = () => setMode(true);
$("overview").onclick = () => { if (window.world3d) { window.world3d.overview(); $("follow").checked = false; } };
window.addEventListener("world3d-ready", () => {
  window.world3d.onRoomClick = (id, dbl) => (dbl ? goTo(id) : selectRoom(id));
  if (world) window.world3d.update(world, overlay());
  let saved = null;
  try { saved = localStorage.getItem("zork-view"); } catch {}
  if (saved === "3d" || location.hash.startsWith("#3d")) setMode(true);
  // /#3d&overview opens zoomed out over the whole map.
  if (new URLSearchParams(location.hash.slice(1)).has("overview")) setTimeout(() => window.world3d.overview(), 300);
});
window.addEventListener("resize", () => { const c = currentRoom(); if (c && $("follow").checked) centerOn(c); renderMap(); });

// ---------- side panels ----------
function renderPanel() {
  const r = world && world.rooms.find((x) => x.id === (selected || world.current));
  if (!r) return;
  $("roomname").textContent = r.name + (r.id === world.current ? "" : "  (selected)");
  $("roomdesc").textContent = r.description || "";
  $("roomvisual").textContent = r.visual || "";
  $("roomvisual").hidden = !r.visual;
  const tags = [];
  if (r.environment) tags.push(r.environment);
  if (r.indoor !== null && r.indoor !== undefined) tags.push(r.indoor ? "indoor" : "outdoor");
  if (r.lighting) tags.push(r.lighting);
  tags.push(`level ${r.z}`);
  tags.push(`${r.visits} visit${r.visits === 1 ? "" : "s"}`);
  let html = tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("");
  if (r.palette && r.palette.floor) {
    html += `<span class="tag">${["floor", "wall", "accent"].map((k) => `<span class="swatch" style="background:${esc(r.palette[k] || "")}"></span>`).join("")}</span>`;
  }
  if (r.features && r.features.length) html += `<div class="muted" style="margin-top:6px">Features: ${esc(r.features.join(", "))}</div>`;
  $("roomtags").innerHTML = html;
  fillList("roomitems", r.items, "Nothing loose here", (it) => (r.id === world.current ? `take ${lastWord(it)}` : null));
  const exits = Object.entries(r.exits).map(([d, ex]) => {
    const to = ex.to && world.rooms.find((x) => x.id === ex.to);
    let s = d + (to ? ` → ${to.name}` : ex.blocked ? " (blocked)" : " (unexplored)");
    if (ex.note) s += ` — ${ex.note}`;
    return { label: s, dir: d };
  });
  renderRouteBox(r);
  const ul = $("roomexits");
  ul.innerHTML = "";
  if (!exits.length) ul.innerHTML = `<li class="empty">None known yet</li>`;
  for (const e of exits) {
    const li = document.createElement("li");
    li.textContent = e.label;
    if (r.id === world.current) { li.className = "click"; li.title = `Go ${e.dir}`; li.onclick = () => send(e.dir); }
    ul.appendChild(li);
  }
}

function renderRouteBox(r) {
  const box = $("routebox");
  if (r.undiscovered) {
    box.hidden = false;
    box.innerHTML = `<div><b>Not discovered yet</b></div><div class="muted small">You're seeing this because Reveal map is on. Find it in the game to travel here.</div>`;
    return;
  }
  if (r.id === world.current || !preview || preview.to !== r.id) { box.hidden = true; return; }
  box.hidden = false;
  if (preview.reachable) {
    const dirs = preview.steps.map((s) => s.command).join(" → ");
    const n = preview.steps.length;
    box.innerHTML = `<div><b>Route</b> <span class="muted">${n} move${n === 1 ? "" : "s"}</span></div>
      <div class="dirs">${esc(dirs)}</div>
      <button id="gobtn" class="primary">Go there</button>
      <div class="muted small">Tip: double-click a room to go straight there.</div>`;
    $("gobtn").onclick = () => goTo(r.id);
  } else {
    let html = `<div><b>No known route</b></div><div class="muted small">Explore the way there by hand first, or go back to a save that had a way through.</div>`;
    if (preview.suggest) {
      const m = preview.suggest.moves;
      html += `<button id="sugbtn" class="primary">Load “${esc(preview.suggest.name)}” (${m === 0 ? "it starts there" : `then ${m} move${m === 1 ? "" : "s"}`})</button>`;
    }
    box.innerHTML = html;
    if ($("sugbtn")) $("sugbtn").onclick = () => {
      const sg = preview.suggest;
      if (confirm(`Load “${sg.name}” (turn ${sg.turn})? Progress since then is undone, but the map keeps everything you've explored.`)) goTo(r.id, sg.id);
    };
  }
}

function renderInventory() {
  fillList("inventory", world.inventory, "Empty-handed", (it) => `examine ${lastWord(it)}`);
  if (world.inventory_stale) {
    const li = document.createElement("li");
    li.className = "click stale";
    li.textContent = "Something may have been taken. Type i to refresh.";
    li.onclick = () => send("i");
    $("inventory").appendChild(li);
  }
}

function fillList(id, items, emptyText, clickCmd) {
  const ul = $(id);
  ul.innerHTML = "";
  if (!items || !items.length) { ul.innerHTML = `<li class="empty">${emptyText}</li>`; return; }
  for (const it of items) {
    const li = document.createElement("li");
    li.textContent = it;
    const cmd = clickCmd && clickCmd(it);
    if (cmd) { li.className = "click"; li.title = cmd; li.onclick = () => send(cmd); }
    ul.appendChild(li);
  }
}

function lastWord(s) { return s.trim().split(/\s+/).pop(); }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

$("newgame").onclick = async () => {
  if (!confirm("Start a new game? The current map is backed up to data/world.bak.json.")) return;
  lastLogLen = -1;
  await fetch("/api/new-game", { method: "POST" });
};

fetch("/api/world").then((r) => r.json()).then((d) => {
  if (!world) update(d.world, d.llm, d.travel);
  // Links like /#3d&to=kitchen open with that room selected and its route previewed.
  const to = new URLSearchParams(location.hash.slice(1)).get("to");
  if (to) selectRoom(to);
});
connect();
