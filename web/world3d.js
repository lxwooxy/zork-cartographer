// 3D view of the map, built with three.js. Mirrors the Unity viewer
// (unity/ZorkWorld/Assets/Zork/Scripts/WorldBuilder.cs).
import * as THREE from "three";
import { OrbitControls } from "./vendor/OrbitControls.js";

const SPACING = 14;       // world units per map unit
const LEVEL_H = 9;        // world units per up/down level
const ROOM = 8;           // room floor size
const WALL_H = 3.2;

const DIRS = {
  north: [0, 1], south: [0, -1], east: [1, 0], west: [-1, 0],
  northeast: [1, 1], northwest: [-1, 1], southeast: [1, -1], southwest: [-1, -1],
};

const THEMES = {
  forest: ["#3d5a2e", "#2f4a26", "#8fbf5a"],
  field: ["#5c7a3a", "#6b8a46", "#d9d07a"],
  house: ["#7a5a3c", "#d8d2c4", "#c99a5b"],
  river: ["#5a6a6e", "#3e5560", "#5aa0d0"],
  lake: ["#5a6a6e", "#3e5560", "#5aa0d0"],
  dam: ["#5a6a6e", "#3e5560", "#5aa0d0"],
  maze: ["#3a3530", "#5a524a", "#a08a6a"],
  mine: ["#2e2a26", "#3d3631", "#c08040"],
  temple: ["#8a8070", "#b0a690", "#e0c060"],
  crypt: ["#8a8070", "#b0a690", "#e0c060"],
  sky: ["#9ab0c8", "#c0d0e0", "#ffffff"],
  default: ["#4a4540", "#5e5650", "#b0906a"],
};

// Map coordinates (x east, y north, z level) to three.js (x right, y up, -z north).
const toWorld = (r) => new THREE.Vector3(r.x * SPACING, r.z * LEVEL_H, -r.y * SPACING);

// ---------- materials and helpers ----------
const matCache = new Map();
function mat(color, emissive = 0, extra = {}) {
  const key = `${new THREE.Color(color).getHexString()}|${emissive}|${JSON.stringify(extra)}`;
  if (!matCache.has(key)) {
    const c = new THREE.Color(color);
    matCache.set(key, new THREE.MeshStandardMaterial({
      color: c, roughness: extra.roughness ?? 0.85, metalness: 0,
      emissive: emissive ? c : 0x000000, emissiveIntensity: emissive,
      transparent: !!extra.opacity, opacity: extra.opacity ?? 1,
    }));
  }
  return matCache.get(key);
}

const GEO = {
  box: new THREE.BoxGeometry(1, 1, 1),
  cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 12),
  sphere: new THREE.SphereGeometry(0.5, 14, 10),
  cone: new THREE.ConeGeometry(0.5, 1, 10),
};

function mesh(geo, material, parent, pos, scale, rotY = 0) {
  const m = new THREE.Mesh(geo, material);
  m.position.copy(pos);
  m.scale.copy(scale);
  m.rotation.y = rotY;
  parent.add(m);
  return m;
}
const V = (x, y, z) => new THREE.Vector3(x, y, z);

function label(text, color = "#ffffff", size = 1) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const font = "600 44px ui-monospace, Menlo, monospace";
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 28;
  canvas.width = w; canvas.height = 64;
  ctx.font = font;
  ctx.fillStyle = "rgba(10,14,12,0.62)";
  ctx.beginPath();
  ctx.roundRect(0, 4, w, 56, 12);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  ctx.fillText(text, 14, 33);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true }));
  const h = 0.9 * size;
  sprite.scale.set(h * (w / 64), h, 1);
  sprite.renderOrder = 10;
  return sprite;
}

function rng(seedStr) {
  let h = 2166136261;
  for (const c of seedStr) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

function signature(r) {
  const ex = Object.entries(r.exits).map(([d, e]) => `${d}:${e.to}:${e.blocked}`).join("|");
  return [r.env3d, r.indoor3d, r.lighting, JSON.stringify(r.palette), r.items.join(","), (r.features || []).join(","), r.name, ex].join("#");
}

// ---------- room building ----------
function buildRoom(r, byId) {
  const g = new THREE.Group();
  g.name = r.id;
  const env = (r.env3d || "").toLowerCase();
  const theme = THEMES[env] || THEMES.default;
  const pal = r.palette || {};
  const dark = r.lighting === "dark" || r.dark;
  const shade = (c) => (dark ? new THREE.Color(c).multiplyScalar(0.45) : new THREE.Color(c));
  const floorC = shade(pal.floor || theme[0]);
  const wallC = shade(pal.wall || theme[1]);
  const accentC = new THREE.Color(pal.accent || theme[2]);

  mesh(GEO.box, mat(floorC), g, V(0, -0.2, 0), V(ROOM, 0.4, ROOM));

  // Which sides have openings
  const open = new Set();
  for (const [d, e] of Object.entries(r.exits)) {
    let v = null;
    const other = e.to && byId[e.to];
    if (other && other.z === r.z) v = [other.x - r.x, other.y - r.y];
    else if (DIRS[d]) v = DIRS[d];
    if (!v || (Math.abs(v[0]) < 1e-3 && Math.abs(v[1]) < 1e-3)) continue;
    open.add(Math.abs(v[0]) > Math.abs(v[1]) ? (v[0] > 0 ? "east" : "west") : (v[1] > 0 ? "north" : "south"));
  }
  if (r.indoor3d || env === "maze") buildWalls(g, open, mat(wallC), env === "maze" ? WALL_H * 0.8 : WALL_H);

  decorate(g, r, env, accentC, wallC);

  const name = label(r.name, "#ffffff", 1.3);
  name.position.set(0, WALL_H + 2.4, 0);
  g.add(name);

  // Items: glowing cubes along the front edge
  r.items.forEach((it, i) => {
    const x = -ROOM * 0.35 + i * 1.8;
    const cube = mesh(GEO.box, mat("#ffd15a", 0.7), g, V(x, 0.4, ROOM * 0.3), V(0.45, 0.45, 0.45));
    cube.userData.spin = true;
    const l = label(it, "#ffe7a3", 0.6);
    l.position.set(x, 1.3, ROOM * 0.3);
    g.add(l);
  });

  // Unexplored / blocked exits
  for (const [d, e] of Object.entries(r.exits)) {
    if (e.to) continue;
    const color = e.blocked ? "#b33030" : "#4d6659";
    if (d === "up" || d === "down") {
      const disc = mesh(GEO.cyl, mat(color, 0.25), g, V(ROOM * 0.3, d === "up" ? WALL_H : 0.03, -ROOM * 0.3), V(1.4, 0.05, 1.4));
      const l = label(`${d}${e.blocked ? " ✕" : " ?"}`, "#b8e0c8", 0.55);
      l.position.copy(disc.position).add(V(0, 0.7, 0));
      g.add(l);
      continue;
    }
    const v = DIRS[d];
    if (!v) continue;
    const dir = V(v[0], 0, -v[1]).normalize();
    const stub = mesh(GEO.box, mat(color), g, dir.clone().multiplyScalar(ROOM / 2 + 1.25).add(V(0, -0.1, 0)), V(1.8, 0.2, 2.5));
    stub.rotation.y = Math.atan2(dir.x, dir.z);
  }
  return g;
}

function buildWalls(g, open, m, h) {
  const half = ROOM / 2, t = 0.3, gap = 2.6;
  const sides = { north: [V(0, 0, -half), true], south: [V(0, 0, half), true], east: [V(half, 0, 0), false], west: [V(-half, 0, 0), false] };
  for (const [side, [c, alongX]] of Object.entries(sides)) {
    if (!open.has(side)) {
      mesh(GEO.box, m, g, c.clone().add(V(0, h / 2, 0)), alongX ? V(ROOM, h, t) : V(t, h, ROOM));
      continue;
    }
    const seg = (ROOM - gap) / 2;
    for (const s of [-1, 1]) {
      const off = s * (gap / 2 + seg / 2);
      mesh(GEO.box, m, g, c.clone().add(alongX ? V(off, h / 2, 0) : V(0, h / 2, off)), alongX ? V(seg, h, t) : V(t, h, seg));
    }
  }
}

function decorate(g, r, env, accent, wall) {
  const rand = rng(r.id);
  const R = (a, b) => a + rand() * (b - a);
  const edge = () => {
    const along = R(-ROOM * 0.45, ROOM * 0.45), inset = R(ROOM * 0.32, ROOM * 0.47);
    return [V(along, 0, inset), V(along, 0, -inset), V(inset, 0, along), V(-inset, 0, along)][Math.floor(rand() * 4)];
  };
  if (env === "forest" || env === "field") {
    const n = env === "forest" ? 9 : 2;
    for (let i = 0; i < n; i++) {
      const p = edge(), th = R(2, 3.5), s = R(1.6, 2.6);
      mesh(GEO.cyl, mat("#5a3d26"), g, p.clone().add(V(0, th / 2, 0)), V(0.35, th, 0.35));
      const leaf = new THREE.Color("#26732f").lerp(accent, 0.2);
      mesh(i % 3 ? GEO.sphere : GEO.cone, mat(leaf), g, p.clone().add(V(0, th + s * 0.4, 0)), V(s, s * 1.2, s));
    }
  } else if (["river", "lake", "dam"].includes(env)) {
    mesh(GEO.box, mat("#2a5d99", 0.08, { roughness: 0.15, opacity: 0.85 }), g, V(0, 0.06, -ROOM * 0.2), V(ROOM * 0.9, 0.1, ROOM * 0.45));
  } else if (["cave", "mine", "canyon"].includes(env)) {
    for (let i = 0; i < 6; i++) {
      const s = R(0.6, 1.6);
      mesh(GEO.sphere, mat(new THREE.Color(wall).lerp(new THREE.Color("#808080"), 0.3)), g, edge().add(V(0, s * 0.2, 0)), V(s * R(0.8, 1.5), s * 0.7, s));
    }
  } else if (env === "temple" || env === "crypt") {
    for (const i of [-1, 1]) for (const j of [-1, 1]) {
      mesh(GEO.cyl, mat(new THREE.Color(wall).lerp(new THREE.Color("#ffffff"), 0.4)), g, V(i * ROOM * 0.3, WALL_H / 2, j * ROOM * 0.3), V(0.6, WALL_H, 0.6));
    }
  }
  if (!r.indoor3d && r.name.toLowerCase().includes("house")) {
    // The white house, with a little roof
    mesh(GEO.box, mat("#ebebe0"), g, V(ROOM * 0.3, 1.25, -ROOM * 0.3), V(2.5, 2.5, 2.5));
    const roof = mesh(GEO.cone, mat("#6b4b3a"), g, V(ROOM * 0.3, 3.1, -ROOM * 0.3), V(3.6, 1.3, 3.6));
    roof.rotation.y = Math.PI / 4;
  }
  (r.features || []).slice(0, 6).forEach((f) => {
    const p = edge().multiplyScalar(0.85), h = R(0.6, 1.4);
    mesh(GEO.box, mat(new THREE.Color(accent).lerp(new THREE.Color(wall), 0.3)), g, p.clone().add(V(0, h / 2, 0)), V(R(0.8, 1.6), h, R(0.6, 1.2)));
    const l = label(f, "#cfd8e3", 0.5);
    l.position.copy(p).add(V(0, h + 0.5, 0));
    g.add(l);
  });
}

function buildConnection(parent, a, b, inferred) {
  const pa = toWorld(a), pb = toWorld(b);
  const m = mat(inferred ? "#5a615c" : "#8c806b");
  if (a.z === b.z) {
    const flat = pb.clone().sub(pa);
    const len = flat.length() - ROOM;
    if (len <= 0.05) return;
    const dir = flat.normalize();
    const mid = pa.clone().add(dir.clone().multiplyScalar(ROOM / 2 + len / 2)).add(V(0, -0.15, 0));
    const p = mesh(GEO.box, m, parent, mid, V(2.2, 0.3, len));
    p.rotation.y = Math.atan2(dir.x, dir.z);
    return;
  }
  const [lo, hi] = a.z < b.z ? [pa, pb] : [pb, pa];
  const horiz = V(hi.x - lo.x, 0, hi.z - lo.z);
  if (horiz.length() < ROOM) {
    // Rooms stacked on top of each other: a shaft at the corner
    const h = hi.y - lo.y;
    mesh(GEO.cyl, mat("#7f735a", 0.1), parent, lo.clone().add(V(ROOM / 2 + 1, h / 2, -(ROOM / 2 + 1))), V(1.2, h, 1.2));
    return;
  }
  const hd = horiz.clone().normalize();
  const s = lo.clone().add(hd.clone().multiplyScalar(ROOM / 2));
  const e = hi.clone().sub(hd.clone().multiplyScalar(ROOM / 2));
  const ramp = mesh(GEO.box, m, parent, s.clone().add(e).multiplyScalar(0.5), V(2.2, 0.3, s.distanceTo(e)));
  ramp.lookAt(e);
}

// ---------- the view ----------
export function createWorld3D(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const bg = new THREE.Color("#0b0e0d");
  scene.background = bg;
  scene.fog = new THREE.Fog(bg, 160, 650);
  scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x2a2420, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.3);
  sun.position.set(-40, 80, 30);
  scene.add(sun);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 3000);
  camera.position.set(25, 30, 30);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minDistance = 6;
  controls.maxDistance = 900;

  const rooms = new Map();          // id -> { group, sig, target }
  const links = new THREE.Group();
  scene.add(links);

  const player = new THREE.Mesh(new THREE.CapsuleGeometry(0.45, 0.8, 6, 12), mat("#80ffa6", 1.2));
  const glow = new THREE.PointLight(0xffd9a0, 60, 22, 1.6);
  player.add(glow);
  scene.add(player);
  let playerTarget = V(0, 0, 0);
  let follow = true;
  let visible = false;
  let current = null;

  function dispose(group) {
    scene.remove(group);
    group.traverse((o) => { if (o.isSprite) { o.material.map.dispose(); o.material.dispose(); } });
  }

  function update(world) {
    const byId = Object.fromEntries(world.rooms.map((r) => [r.id, r]));
    for (const r of world.rooms) {
      const sig = signature(r);
      let entry = rooms.get(r.id);
      if (!entry || entry.sig !== sig) {
        if (entry) dispose(entry.group);
        const group = buildRoom(r, byId);
        group.position.copy(entry ? entry.group.position : toWorld(r));
        scene.add(group);
        entry = { group, sig };
        rooms.set(r.id, entry);
      }
      entry.target = toWorld(r);
    }
    for (const [id, entry] of rooms) if (!byId[id]) { dispose(entry.group); rooms.delete(id); }

    links.clear();
    const done = new Set();
    for (const r of world.rooms) {
      for (const e of Object.values(r.exits)) {
        if (!e.to || !byId[e.to]) continue;
        const key = [r.id, e.to].sort().join("|");
        if (done.has(key)) continue;
        done.add(key);
        buildConnection(links, r, byId[e.to], e.inferred);
      }
    }

    const cur = byId[world.current];
    if (cur) {
      const first = !current;
      current = cur;
      playerTarget = toWorld(cur);
      if (first) {
        player.position.copy(playerTarget).add(V(0, 1.3, 0));
        controls.target.copy(playerTarget);
        camera.position.copy(playerTarget).add(V(22, 26, 28));
      }
    }
  }

  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(container);

  const clock = new THREE.Clock();
  function frame() {
    requestAnimationFrame(frame);
    if (!visible) return;
    const dt = Math.min(clock.getDelta(), 0.1);
    const t = clock.elapsedTime;
    for (const entry of rooms.values()) {
      entry.group.position.lerp(entry.target, Math.min(1, dt * 3));
      entry.group.traverse((o) => { if (o.userData.spin) o.rotation.y += dt; });
    }
    player.position.lerp(playerTarget.clone().add(V(0, 1.3 + Math.sin(t * 2) * 0.15, 0)), Math.min(1, dt * 4));
    if (follow) {
      // Move the orbit target with the player, keeping the camera's offset.
      const delta = playerTarget.clone().sub(controls.target).multiplyScalar(Math.min(1, dt * 3));
      controls.target.add(delta);
      camera.position.add(delta);
    }
    controls.update();
    renderer.render(scene, camera);
  }
  frame();

  return {
    update,
    setVisible(v) { visible = v; if (v) { resize(); clock.getDelta(); } },
    setFollow(f) { follow = f; },
    center() {
      if (!current) return;
      const offset = camera.position.clone().sub(controls.target);
      controls.target.copy(playerTarget);
      camera.position.copy(playerTarget).add(offset);
    },
    overview() {
      const box = new THREE.Box3();
      for (const e of rooms.values()) box.expandByPoint(e.target);
      if (box.isEmpty()) return;
      const c = box.getCenter(V(0, 0, 0));
      const size = box.getSize(V(0, 0, 0)).length();
      follow = false;
      controls.target.copy(c);
      camera.position.copy(c).add(V(0.35, 0.9, 0.6).normalize().multiplyScalar(Math.max(60, size * 1.1)));
      return false;
    },
  };
}
