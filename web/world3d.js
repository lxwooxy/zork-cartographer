// 3D view of the map, built with three.js. Mirrors the Unity viewer
// (unity/ZorkWorld/Assets/Zork/Scripts/WorldBuilder.cs).
import * as THREE from "three";
import { OrbitControls } from "./vendor/OrbitControls.js";
import { GLTFLoader } from "./vendor/loaders/GLTFLoader.js";

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
  return [r.undiscovered ? "ghost" : "", JSON.stringify(r.roles || {}), r.env3d, r.indoor3d, r.lighting, JSON.stringify(r.palette), r.items.join(","), (r.features || []).join(","), r.name, ex].join("#");
}

// ---------- room building ----------
// An undiscovered room (Reveal map on): a faint translucent tile and a dim label.
function buildGhost(r) {
  const g = new THREE.Group();
  g.name = r.id;
  mesh(GEO.box, mat("#3b4a43", 0, { opacity: 0.25 }), g, V(0, -0.2, 0), V(ROOM, 0.2, ROOM));
  const l = label(r.name, "#7d8c84", 0.8);
  l.position.set(0, 1.6, 0);
  g.add(l);
  return g;
}

// What part a room plays in a multi-room landmark (see game/zork1-landmarks.json).
const ROLE_KINDS = { "white-house": "house", forest: "forest", "frigid-river": "river", rainbow: "rainbow", reservoir: "lake" };
function roleIn(r, landmarkId) { return (r.roles || {})[landmarkId] || null; }

function buildRoom(r, byId) {
  if (r.undiscovered) return buildGhost(r);
  const houseRole = roleIn(r, "white-house");
  const forestRole = roleIn(r, "forest");
  const riverRole = roleIn(r, "frigid-river");
  if (forestRole === "tree-top") return buildTreePlatform(r);
  const g = new THREE.Group();
  g.name = r.id;
  let env = (r.env3d || "").toLowerCase();
  if (houseRole === "exterior") env = "yard";              // the house itself is a landmark
  else if (houseRole) env = "house";
  else if (forestRole) env = "clearing";                   // trees come from the forest landmark
  if (riverRole === "path") env = "riverbed";
  const theme = THEMES[env] || THEMES.default;
  const pal = r.palette || {};
  const dark = r.lighting === "dark" || r.dark;
  const shade = (c) => (dark ? new THREE.Color(c).multiplyScalar(0.45) : new THREE.Color(c));
  const floorC = shade(env === "yard" ? "#4f6b37" : env === "clearing" ? "#55703f" : env === "riverbed" ? "#2a5d99" : pal.floor || theme[0]);
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
  const indoor = houseRole === "interior" || houseRole === "upstairs" || (r.indoor3d && !["yard", "clearing", "riverbed"].includes(env));
  if (indoor || env === "maze") buildWalls(g, open, mat(wallC), env === "maze" ? WALL_H * 0.8 : WALL_H);

  decorate(g, r, env, accentC, wallC);

  const name = label(r.name, "#ffffff", 1.0);
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
  if (!r.indoor3d && r.name.toLowerCase().includes("house") && !(r.roles || {})["white-house"]) {
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

// "Up a Tree": a wooden platform in the branches of the forest's big tree.
function buildTreePlatform(r) {
  const g = new THREE.Group();
  g.name = r.id;
  mesh(GEO.cyl, mat("#7a5634"), g, V(0, -0.2, 0), V(ROOM * 0.8, 0.4, ROOM * 0.8));
  for (let i = 0; i < 6; i++) {          // a ring of leafy clumps around the edge, leaving the middle open
    const a = (i / 6) * Math.PI * 2;
    mesh(GEO.sphere, mat("#2f7a3a"), g, V(Math.cos(a) * ROOM * 0.55, 1.2, Math.sin(a) * ROOM * 0.55), V(3.4, 2.6, 3.4));
  }
  const name = label(r.name, "#ffffff", 1.0);
  name.position.set(0, WALL_H + 2.4, 0);
  g.add(name);
  return g;
}

// ---------- landmarks: places drawn as one thing across several rooms ----------
const P = (pt) => toWorld({ x: pt[0], y: pt[1], z: pt[2] });   // [x, y, z] map point -> world
const RP = (room) => toWorld(room);

function hash2(i, j, seed) {
  let h = Math.imul(i * 374761393 + j * 668265263, 1274126177) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function buildHouse(lm, parent, ctx) {
  const inside = lm.rooms.filter((r) => r.role === "interior").map(RP);
  if (!inside.length) return;
  const up = lm.rooms.filter((r) => r.role === "upstairs");
  const pad = ROOM / 2 + 1.6;
  const minX = Math.min(...inside.map((p) => p.x)) - pad, maxX = Math.max(...inside.map((p) => p.x)) + pad;
  const minZ = Math.min(...inside.map((p) => p.z)) - pad, maxZ = Math.max(...inside.map((p) => p.z)) + pad;
  const base = inside[0].y - 0.4;
  const height = (up.length ? LEVEL_H : 0) + WALL_H + 1.2;
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2, w = maxX - minX, d = maxZ - minZ, t = 0.5;
  const g = new THREE.Group();
  g.userData.house = true;
  parent.add(g);
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xece9df, roughness: 0.9, transparent: true });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x8a7a68, roughness: 0.9, transparent: true });
  ctx.houseMats = [wallMat, trimMat];
  const walls = [
    [V(cx, base + height / 2, minZ), V(w, height, t)], [V(cx, base + height / 2, maxZ), V(w, height, t)],
    [V(minX, base + height / 2, cz), V(t, height, d)], [V(maxX, base + height / 2, cz), V(t, height, d)],
  ];
  for (const [pos, size] of walls) mesh(GEO.box, wallMat, g, pos, size);
  // Floor between the rooms, and trim along the base
  mesh(GEO.box, new THREE.MeshStandardMaterial({ color: 0x6b4e32 }), g, V(cx, base - 0.05, cz), V(w, 0.3, d));
  mesh(GEO.box, trimMat, g, V(cx, base + 0.3, minZ - 0.05), V(w + 0.2, 0.6, t + 0.1));
  mesh(GEO.box, trimMat, g, V(cx, base + 0.3, maxZ + 0.05), V(w + 0.2, 0.6, t + 0.1));

  // Pitched roof: a triangular prism along the long side
  const roofH = Math.min(w, d) * 0.45;
  const shape = new THREE.Shape([new THREE.Vector2(-d / 2 - 1, 0), new THREE.Vector2(d / 2 + 1, 0), new THREE.Vector2(0, roofH)]);
  const roofGeo = new THREE.ExtrudeGeometry(shape, { depth: w + 2, bevelEnabled: false });
  const roof = new THREE.Mesh(roofGeo, new THREE.MeshStandardMaterial({ color: 0x5b3b2e, roughness: 0.85 }));
  roof.rotation.y = Math.PI / 2;
  roof.position.set(minX - 1, base + height, cz);
  g.add(roof);
  ctx.roof = roof;

  if (lm.chimney) {
    const c = P(lm.chimney);
    const chim = mesh(GEO.box, new THREE.MeshStandardMaterial({ color: 0x8b4a3a }), g, V(c.x + 2, base + height + roofH * 0.6, cz - d / 4), V(1.4, roofH + 1.5, 1.4));
    ctx.chimney = chim;
  }
  // The boarded front door (west side)
  if (lm.door) {
    const x = lm.door.side === "west" ? minX - 0.3 : maxX + 0.3;
    mesh(GEO.box, new THREE.MeshStandardMaterial({ color: 0x5a3b22 }), g, V(x, base + 1.6, cz), V(0.2, 3.2, 1.9));
    if (lm.door.boarded) {
      for (const s of [-1, 1]) {
        const plank = mesh(GEO.box, new THREE.MeshStandardMaterial({ color: 0x9c7a55 }), g, V(x - 0.15 * Math.sign(cx - x), base + 1.6, cz), V(0.15, 0.35, 2.6));
        plank.rotation.x = s * 0.7;
      }
    }
  }
  // The kitchen window (east side), slightly ajar
  if (lm.window) {
    const wp = P(lm.window.room);
    const x = lm.window.side === "east" ? maxX + 0.3 : minX - 0.3;
    mesh(GEO.box, new THREE.MeshStandardMaterial({ color: 0xd9d2bf }), g, V(x, base + 2.2, wp.z), V(0.2, 1.9, 2.3));
    mesh(GEO.box, new THREE.MeshStandardMaterial({ color: 0x1d2a33, emissive: 0x16242e, emissiveIntensity: 0.6 }), g, V(x + 0.05 * Math.sign(x - cx), base + 2.2, wp.z), V(0.15, 1.5, 1.9));
  }
  ctx.houseBox = { minX, maxX, minZ, maxZ };
  ctx.houseBox3 = new THREE.Box3(V(minX - 1, base, minZ - 1), V(maxX + 1, base + height + roofH, maxZ + 1));
}

function buildForest(lm, parent, ctx) {
  const pts = lm.rooms.map(RP);
  if (!pts.length) return;
  const reach = ROOM / 2 + 9;     // how far woodland spreads around each known forest room
  const g = new THREE.Group();
  parent.add(g);
  const y0 = pts[0].y;
  // Woodland floor: a soft disc under each known forest room, merging into one floor
  for (const p of pts) mesh(GEO.cyl, mat("#30482a"), g, V(p.x, y0 - 0.55, p.z), V(reach * 2, 0.2, reach * 2));
  // Trees on a fixed grid (so they don't move as you explore), skipping rooms, paths and the house
  const minX = Math.min(...pts.map((p) => p.x)) - reach, maxX = Math.max(...pts.map((p) => p.x)) + reach;
  const minZ = Math.min(...pts.map((p) => p.z)) - reach, maxZ = Math.max(...pts.map((p) => p.z)) + reach;
  const cell = 4.2;
  const avoid = ctx.levelRooms(pts[0].y);
  const hb = ctx.houseBox;
  const trunkMat = mat("#5a3d26");
  const leafMats = [mat("#26732f"), mat("#2e6b2a"), mat("#3a7d33"), mat("#1f5e2a")];
  for (let i = Math.floor(minX / cell); i <= Math.ceil(maxX / cell); i++) {
    for (let j = Math.floor(minZ / cell); j <= Math.ceil(maxZ / cell); j++) {
      const r1 = hash2(i, j, 7), r2 = hash2(i, j, 11), r3 = hash2(i, j, 13);
      if (r3 < 0.25) continue;                                 // natural gaps
      const x = (i + r1) * cell, z = (j + r2) * cell;
      if (!pts.some((p) => Math.hypot(p.x - x, p.z - z) < reach)) continue;
      if (avoid.some((p) => Math.abs(p.x - x) < ROOM / 2 + 1.5 && Math.abs(p.z - z) < ROOM / 2 + 1.5)) continue;
      if (ctx.onPath(x, z, 2.2)) continue;
      if (hb && x > hb.minX - 2 && x < hb.maxX + 2 && z > hb.minZ - 2 && z < hb.maxZ + 2) continue;
      const h = 2.2 + r1 * 2.2, s = 1.8 + r2 * 1.6;
      mesh(GEO.cyl, trunkMat, g, V(x, y0 + h / 2 - 0.4, z), V(0.4, h, 0.4));
      mesh(r3 > 0.8 ? GEO.cone : GEO.sphere, leafMats[Math.floor(r3 * 4) % 4], g, V(x, y0 + h + s * 0.35 - 0.4, z), V(s, s * 1.25, s));
    }
  }
  // The big climbable tree: trunk from the forest path up to the "Up a Tree" platform
  if (lm.big_tree) {
    const b = P(lm.big_tree.base), t = P(lm.big_tree.top);
    const tx = b.x + ROOM / 2 + 1.2, tz = b.z - ROOM / 2 - 1.2;
    const h = t.y - b.y + 2;
    mesh(GEO.cyl, mat("#4a3220"), g, V(tx, b.y + h / 2, tz), V(1.6, h, 1.6));
    const branch = mesh(GEO.box, mat("#4a3220"), g, V((tx + t.x) / 2, t.y - 0.6, (tz + t.z) / 2), V(0.8, 0.8, Math.hypot(tx - t.x, tz - t.z)));
    branch.lookAt(V(t.x, t.y - 0.6, t.z));
  }
}

function buildRiver(lm, parent) {
  const pts = (lm.path || []).map(P);
  const water = mat("#2a5d99", 0.12, { roughness: 0.15, opacity: 0.9 });
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const seg = mesh(GEO.box, water, parent, V((a.x + b.x) / 2, (a.y + b.y) / 2 - 0.35, (a.z + b.z) / 2), V(7, 0.25, len + 7));
    seg.rotation.y = Math.atan2(b.x - a.x, b.z - a.z);
    // Banks
    for (const s of [-1, 1]) {
      const bank = mesh(GEO.box, mat("#5b5348"), parent, V(0, 0, 0), V(1.2, 1.4, len + 6));
      bank.position.set((a.x + b.x) / 2 + Math.cos(seg.rotation.y) * 4.2 * s, (a.y + b.y) / 2 - 0.2, (a.z + b.z) / 2 - Math.sin(seg.rotation.y) * 4.2 * s);
      bank.rotation.y = seg.rotation.y;
    }
  }
}

function buildRainbow(lm, parent) {
  const from = lm.rooms.find((r) => r.role === "from"), to = lm.rooms.find((r) => r.role === "to");
  if (!from || !to) return;
  const a = RP(from), b = RP(to);
  const span = Math.hypot(b.x - a.x, b.z - a.z);
  const g = new THREE.Group();
  g.position.set((a.x + b.x) / 2, a.y, (a.z + b.z) / 2);
  g.rotation.y = -Math.atan2(b.z - a.z, b.x - a.x);
  const colors = [0xff4040, 0xff9a30, 0xffe040, 0x50d050, 0x4090ff, 0x7050e0];
  colors.forEach((c, i) => {
    const arc = new THREE.Mesh(new THREE.TorusGeometry(span / 2 - i * 0.55, 0.3, 8, 64, Math.PI),
      new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.75 }));
    g.add(arc);
  });
  parent.add(g);
}

function buildLake(lm, parent) {
  const pts = lm.rooms.map(RP);
  if (!pts.length) return;
  const water = mat("#2a5d99", 0.1, { roughness: 0.15, opacity: 0.85 });
  for (const p of pts) mesh(GEO.cyl, water, parent, V(p.x, p.y - 0.3, p.z), V(ROOM * 2.4, 0.2, ROOM * 2.4));
}

const LANDMARK_BUILDERS = { house: buildHouse, forest: buildForest, river: buildRiver, rainbow: buildRainbow, lake: buildLake };

function distToSeg(x, z, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const len2 = dx * dx + dz * dz || 1e-6;
  const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / len2));
  return Math.hypot(x - (a.x + t * dx), z - (a.z + t * dz));
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

  const clock = new THREE.Clock();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 3000);
  camera.position.set(25, 30, 30);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minDistance = 6;
  controls.maxDistance = 900;

  const rooms = new Map();          // id -> { group, sig, target, glow }
  const links = new THREE.Group();
  scene.add(links);
  const routeGroup = new THREE.Group();   // glowing route segments
  scene.add(routeGroup);
  const landmarkGroup = new THREE.Group(); // the house, the forest, the river... (see LANDMARK_BUILDERS)
  scene.add(landmarkGroup);
  let landmarkSig = "";
  let lmCtx = {};

  // ---------- the player: a frog ----------
  // Red-eyed tree frog by Quaternius (CC0), web/models/frog.glb.
  // Animations: Frog_Idle, Frog_Jump, Frog_Attack, Frog_Death.
  const player = new THREE.Group();
  scene.add(player);
  const lamp = new THREE.PointLight(0xffe6c0, 35, 22, 1.6);
  lamp.position.set(0, 4.5, 0);
  player.add(lamp);
  const placeholder = new THREE.Mesh(new THREE.CapsuleGeometry(0.45, 0.8, 6, 12), mat("#80ffa6", 1.2));
  placeholder.position.y = 0.9;
  player.add(placeholder);
  let mixer = null;
  const actions = {};
  let activeAction = null;

  function play(name, { once = false, fade = 0.2 } = {}) {
    const next = actions[name];
    if (!next || next === activeAction && !once) return;
    next.reset();
    next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    next.clampWhenFinished = once;
    next.play();
    if (activeAction && activeAction !== next) activeAction.crossFadeTo(next, fade, false);
    activeAction = next;
  }

  new GLTFLoader().load("models/frog.glb", (gltf) => {
    const frog = gltf.scene;
    // The rig has a 100x scaled armature (FBX export), so bounding boxes of the unposed
    // mesh are misleading. At scale 1 the posed frog is ~3 units long with its feet at y=0;
    // 1.0 reads well next to an 8-unit room. It faces +Z.
    frog.scale.setScalar(1.0);
    frog.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.frustumCulled = false; } });
    player.remove(placeholder);
    player.add(frog);
    mixer = new THREE.AnimationMixer(frog);
    for (const clip of gltf.animations) {
      const short = clip.name.split("|").pop().replace("Frog_", "");   // Idle, Jump, Attack, Death
      actions[short] = mixer.clipAction(clip);
    }
    play("Idle");
  }, undefined, (err) => console.warn("Frog model failed to load; using a capsule.", err));

  // "You are here": a pulsing ring on the floor under the frog.
  const ring = new THREE.Mesh(new THREE.RingGeometry(1.5, 1.9, 48),
    new THREE.MeshBasicMaterial({ color: 0x7ee0a1, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2;
  scene.add(ring);

  // ...and a glowing marker floating above, visible when zoomed out.
  const pin = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.2, 4), mat("#7ee0a1", 1.4));
  pin.rotation.x = Math.PI;   // point down at the frog
  scene.add(pin);

  let playerTarget = V(0, 0, 0);
  let hopFrom = null;               // where the current hop started
  let follow = true;
  let visible = false;
  let current = null;
  let lastTurnSeen = -1;
  let busyUntil = 0;                // time until a one-shot animation (attack/death) finishes

  // ---------- glowing tiles ----------
  const GLOW = { near: [0x7ee0a1, 0.55], reach: [0x7ee0a1, 0.22], maybe: [0xe0c97e, 0.2],
                 onroute: [0x6fd3ff, 0.6], target: [0x6fd3ff, 0.85] };
  const glowGeo = new THREE.PlaneGeometry(ROOM + 1.2, ROOM + 1.2);
  function setGlow(entry, kind) {
    if (!kind) { if (entry.glow) entry.glow.visible = false; return; }
    if (!entry.glow) {
      entry.glow = new THREE.Mesh(glowGeo, new THREE.MeshBasicMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      entry.glow.rotation.x = -Math.PI / 2;
      entry.glow.position.y = 0.06;
      entry.glow.renderOrder = 5;
    }
    if (entry.glow.parent !== entry.group) entry.group.add(entry.glow);
    const [color, opacity] = GLOW[kind];
    entry.glow.material.color.setHex(color);
    entry.glow.userData.base = opacity;
    entry.glow.userData.kind = kind;
    entry.glow.visible = true;
  }

  function dispose(group) {
    scene.remove(group);
    group.traverse((o) => { if (o.isSprite) { o.material.map.dispose(); o.material.dispose(); } });
  }

  function update(world, ov = { route: [], target: null, reachable: {}, confirmed: {} }) {
    const byId = Object.fromEntries(world.rooms.map((r) => [r.id, r]));
    for (const r of world.rooms) {
      const sig = signature(r);
      let entry = rooms.get(r.id);
      if (!entry || entry.sig !== sig) {
        if (entry) dispose(entry.group);
        const group = buildRoom(r, byId);
        group.userData.roomId = r.id;
        group.position.copy(entry ? entry.group.position : toWorld(r));
        scene.add(group);
        entry = { group, sig, glow: null };
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
        buildConnection(links, r, byId[e.to], e.inferred || r.undiscovered || byId[e.to].undiscovered);
      }
    }

    // Landmarks: rebuilt when they or the set of known rooms change.
    const lms = world.landmarks || [];
    const sig = JSON.stringify(lms) + "|" + world.rooms.map((r) => r.id).join(",");
    if (sig !== landmarkSig) {
      landmarkSig = sig;
      landmarkGroup.traverse((o) => { if (o.geometry && o.geometry.type === "ExtrudeGeometry") o.geometry.dispose(); });
      landmarkGroup.clear();
      const segs = [];
      for (const r of world.rooms) for (const e of Object.values(r.exits)) {
        const b = e.to && byId[e.to];
        if (b && b.z === r.z) segs.push([toWorld(r), toWorld(b)]);
      }
      lmCtx = {
        levelRooms: (y) => world.rooms.map(toWorld).filter((p) => Math.abs(p.y - y) < 0.5),
        onPath: (x, z, w) => segs.some(([a, b]) => distToSeg(x, z, a, b) < w),
      };
      // The house first: the forest keeps its trees clear of it.
      for (const lm of [...lms].sort((a, b) => (a.kind === "house" ? -1 : b.kind === "house" ? 1 : 0))) {
        const build = LANDMARK_BUILDERS[lm.kind];
        if (build) build(lm, landmarkGroup, lmCtx);
      }
    }

    // Glowing tiles: where you can walk, the planned route, the destination.
    const onRoute = new Set(ov.route.map((st) => st.to));
    for (const [id, entry] of rooms) {
      let kind = null;
      if (id === ov.target) kind = "target";
      else if (onRoute.has(id)) kind = "onroute";
      else if (id === world.current) kind = null;
      else if (id in ov.confirmed) kind = ov.confirmed[id] === 1 ? "near" : "reach";
      else if (id in ov.reachable) kind = "maybe";
      setGlow(entry, kind);
    }
    routeGroup.clear();
    const routeMat = mat("#6fd3ff", 1.6, { opacity: 0.85 });
    for (const st of ov.route) {
      const a = byId[st.from], b = byId[st.to];
      if (!a || !b) continue;
      const pa = toWorld(a).add(V(0, 0.6, 0)), pb = toWorld(b).add(V(0, 0.6, 0));
      const len = pa.distanceTo(pb);
      if (len < 0.1) continue;
      const seg = mesh(GEO.box, routeMat, routeGroup, pa.clone().add(pb).multiplyScalar(0.5), V(0.35, 0.35, len));
      seg.lookAt(pb);
    }

    // Frog animations from what just happened in the game.
    const last = world.log[world.log.length - 1];
    if (last && last.turn !== lastTurnSeen) {
      lastTurnSeen = last.turn;
      const cmd = (last.command || "").toLowerCase();
      if (/you have died/i.test(last.text)) { play("Death", { once: true }); busyUntil = clock.elapsedTime + 4; }
      else if (/^(kill|attack|fight|hit|stab|slay)\b/.test(cmd)) { play("Attack", { once: true }); busyUntil = clock.elapsedTime + 1.2; }
    }

    const cur = byId[world.current];
    if (cur) {
      const first = !current;
      const moved = current && current.id !== cur.id;
      current = cur;
      const target = toWorld(cur);
      if (moved) hopFrom = player.position.clone();
      playerTarget = target;
      if (first) {
        player.position.copy(playerTarget);
        controls.target.copy(playerTarget);
        camera.position.copy(playerTarget).add(V(13, 15, 17));
      }
    }
  }

  // ---------- clicking rooms ----------
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let downAt = null;
  function roomAt(ev) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const groups = [...rooms.values()].map((e) => e.group);
    for (const hit of raycaster.intersectObjects(groups, true)) {
      let o = hit.object;
      while (o && !o.userData.roomId) o = o.parent;
      if (o) return o.userData.roomId;
    }
    return null;
  }
  renderer.domElement.addEventListener("pointerdown", (ev) => { downAt = [ev.clientX, ev.clientY]; });
  renderer.domElement.addEventListener("pointerup", (ev) => {
    if (!downAt || Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) > 5) return;  // that was a drag
    const id = roomAt(ev);
    if (id && api.onRoomClick) api.onRoomClick(id, false);
  });
  renderer.domElement.addEventListener("dblclick", (ev) => {
    const id = roomAt(ev);
    if (id && api.onRoomClick) api.onRoomClick(id, true);
  });

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

  function frame() {
    requestAnimationFrame(frame);
    if (!visible) return;
    const dt = Math.min(clock.getDelta(), 0.1);
    const t = clock.elapsedTime;
    for (const entry of rooms.values()) {
      entry.group.position.lerp(entry.target, Math.min(1, dt * 3));
      entry.group.traverse((o) => { if (o.userData.spin) o.rotation.y += dt; });
      if (entry.glow && entry.glow.visible) {
        const pulse = ["near", "onroute", "target"].includes(entry.glow.userData.kind) ? 0.75 + 0.25 * Math.sin(t * 3) : 1;
        entry.glow.material.opacity = entry.glow.userData.base * pulse;
      }
    }

    // Hop toward the current room: move along the ground with an arc, facing the way we go.
    const flat = V(playerTarget.x - player.position.x, 0, playerTarget.z - player.position.z);
    const dist = flat.length();
    const step = Math.min(dist, dt * 14);
    const hopping = dist > 0.15 || Math.abs(playerTarget.y - player.position.y) > 0.3;
    if (hopping) {
      if (dist > 0.01) {
        player.position.add(flat.normalize().multiplyScalar(step));
        const yaw = Math.atan2(playerTarget.x - player.position.x, playerTarget.z - player.position.z);
        player.rotation.y += Math.atan2(Math.sin(yaw - player.rotation.y), Math.cos(yaw - player.rotation.y)) * Math.min(1, dt * 10);
      }
      const total = hopFrom ? Math.max(0.01, V(playerTarget.x - hopFrom.x, 0, playerTarget.z - hopFrom.z).length()) : 1;
      const progress = hopFrom ? 1 - Math.min(1, dist / total) : 1;
      const baseY = hopFrom ? THREE.MathUtils.lerp(hopFrom.y, playerTarget.y, progress) : playerTarget.y;
      player.position.y = baseY + Math.abs(Math.sin(t * 9)) * 0.9;
      if (t > busyUntil) play("Jump");
    } else {
      player.position.copy(playerTarget);
      hopFrom = null;
      if (t > busyUntil) play("Idle");
    }
    if (mixer) mixer.update(dt);

    // The house: see-through with the roof off while you're inside it.
    if (lmCtx.houseMats) {
      const roles = (current && current.roles) || {};
      let inside = ["interior", "upstairs"].includes(roles["white-house"]);
      // Also see through it when it stands between the camera and the frog.
      if (!inside && lmCtx.houseBox3) {
        const to = player.position.clone().add(V(0, 1, 0));
        const dir = to.clone().sub(camera.position);
        const dist = dir.length();
        const hit = new THREE.Ray(camera.position, dir.normalize()).intersectBox(lmCtx.houseBox3, V(0, 0, 0));
        if (hit && hit.distanceTo(camera.position) < dist) inside = true;
      }
      for (const m of lmCtx.houseMats) {
        m.opacity += ((inside ? 0.12 : 1) - m.opacity) * Math.min(1, dt * 4);
        m.depthWrite = m.opacity > 0.95;
      }
      if (lmCtx.roof) lmCtx.roof.visible = !inside;
      if (lmCtx.chimney) lmCtx.chimney.visible = !inside;
    }

    ring.position.set(player.position.x, playerTarget.y + 0.08, player.position.z);
    const s = 1 + 0.12 * Math.sin(t * 3);
    ring.scale.set(s, s, s);
    ring.material.opacity = 0.55 + 0.3 * Math.sin(t * 3);
    pin.position.set(player.position.x, player.position.y + 4.2 + 0.3 * Math.sin(t * 2.5), player.position.z);
    pin.rotation.y = t * 1.5;

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

  const api = {
    onRoomClick: null,
    // For debugging and tests: where things are.
    debug: () => ({ player: player.position.toArray(), target: playerTarget.toArray(), ring: ring.position.toArray(),
      frogLoaded: !!mixer, animations: Object.keys(actions), playing: activeAction && activeAction.getClip().name,
      frogBox: (() => { const b = new THREE.Box3().setFromObject(player); return [b.min.toArray(), b.max.toArray()]; })() }),
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
  return api;
}
