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
    if (msg.type === "world") update(msg.world, msg.llm);
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
function update(w, llm) {
  const prevCurrent = world && world.current;
  world = w;
  const cur = currentRoom();
  $("score").textContent = w.score;
  $("moves").textContent = w.moves;
  $("roomcount").textContent = w.rooms.length;
  const pill = $("llm");
  if (llm.enabled) {
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
  renderMap();
  renderPanel();
  renderInventory();
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
  const g = el("g", {}, svg);
  const k = view.k;

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
        el("line", { x1: ax, y1: ay, x2: bx, y2: by, class: "edge" + (ex.inferred ? " inferred" : "") }, g);
      } else if (vec) {
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

  // Rooms on this level.
  for (const r of world.rooms) {
    if (r.z !== level) continue;
    const [sx, sy] = toScreen(r.x, r.y);
    const cls = ["room"];
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
    gr.addEventListener("click", (ev) => { ev.stopPropagation(); selected = r.id; renderPanel(); });
  }
}

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
window.addEventListener("mouseup", () => { if (drag && drag.moved) $("follow").checked = false; drag = null; });
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
svg.addEventListener("click", () => { selected = null; renderPanel(); });

$("lvlup").onclick = () => { level++; $("follow").checked = false; renderMap(); };
$("lvldown").onclick = () => { level--; $("follow").checked = false; renderMap(); };
$("center").onclick = () => { const c = currentRoom(); if (c) { level = c.z; centerOn(c); renderMap(); } };
$("follow").onchange = () => { if ($("follow").checked) $("center").onclick(); };
window.addEventListener("resize", () => { const c = currentRoom(); if (c && $("follow").checked) centerOn(c); renderMap(); });

// ---------- side panels ----------
function renderPanel() {
  const r = world && world.rooms.find((x) => x.id === (selected || world.current));
  if (!r) return;
  $("roomname").textContent = r.name + (r.id === world.current ? "" : "  (selected)");
  $("roomdesc").textContent = r.description || "";
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

fetch("/api/world").then((r) => r.json()).then((d) => { if (!world) update(d.world, d.llm); });
connect();
