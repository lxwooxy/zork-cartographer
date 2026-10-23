using System.Collections.Generic;
using UnityEngine;

namespace Zork
{
    /// Builds places that span several rooms as one thing: the white house (with the
    /// kitchen and living room inside it), the forest, the big tree, the Frigid River,
    /// the rainbow and the reservoir. Mirrors the landmark builders in web/world3d.js.
    /// Data comes from game/zork1-landmarks.json via /api/unity (fog of war applied).
    public class LandmarkBuilder : MonoBehaviour
    {
        WorldBuilder _b;
        Transform _root;
        string _sig = "";
        readonly List<Material> _houseMats = new List<Material>();
        GameObject _roof, _chimney;
        Bounds _houseBounds;
        bool _hasHouse;
        float _houseAlpha = 1f;

        /// True while the house is drawn solid (not faded). Labels of rooms inside it are hidden then,
        /// because Unity's built-in text draws on top of everything.
        public bool HouseSolid => !_hasHouse || _houseAlpha > 0.6f;

        void Awake()
        {
            _b = GetComponent<WorldBuilder>();
            _root = new GameObject("Landmarks").transform;
            _root.SetParent(transform, false);
        }

        Vector3 W(float x, float y, float z) => new Vector3(x * _b.spacing, z * _b.levelHeight, y * _b.spacing);
        Vector3 WP(float[] p) => W(p[0], p[1], p[2]);
        Vector3 WR(LandmarkRoom r) => W(r.x, r.y, r.z);

        public void Build(WorldData w)
        {
            var sig = (w.landmarks != null ? JsonUtility.ToJson(new Wrapper { items = w.landmarks }) : "") + "|";
            foreach (var r in w.rooms) sig += r.id + ",";
            if (sig == _sig) return;
            _sig = sig;
            foreach (Transform c in _root) Destroy(c.gameObject);
            _houseMats.Clear();
            _roof = _chimney = null;
            _hasHouse = false;
            if (w.landmarks == null) return;

            // The house first: the forest keeps its trees clear of it.
            foreach (var lm in w.landmarks) if (lm.kind == "house") BuildHouse(lm);
            foreach (var lm in w.landmarks)
            {
                switch (lm.kind)
                {
                    case "forest": BuildForest(lm, w); break;
                    case "river": BuildRiver(lm); break;
                    case "rainbow": BuildRainbow(lm); break;
                    case "lake": BuildLake(lm); break;
                }
            }
        }

        [System.Serializable] class Wrapper { public LandmarkData[] items; }

        GameObject Box(string name, Vector3 pos, Vector3 size, Material m, Transform parent = null)
        {
            var go = Mat.Primitive(PrimitiveType.Cube, name, parent ?? _root, m);
            go.transform.position = pos;
            go.transform.localScale = size;
            Destroy(go.GetComponent<Collider>());
            return go;
        }

        // ---------- the white house ----------
        void BuildHouse(LandmarkData lm)
        {
            var inside = new List<Vector3>();
            bool upstairs = false;
            foreach (var r in lm.rooms)
            {
                if (r.role == "interior") inside.Add(WR(r));
                if (r.role == "upstairs") upstairs = true;
            }
            if (inside.Count == 0) return;
            var pad = _b.roomSize / 2f + 1.6f;
            float minX = float.MaxValue, maxX = float.MinValue, minZ = float.MaxValue, maxZ = float.MinValue;
            foreach (var p in inside)
            {
                minX = Mathf.Min(minX, p.x - pad); maxX = Mathf.Max(maxX, p.x + pad);
                minZ = Mathf.Min(minZ, p.z - pad); maxZ = Mathf.Max(maxZ, p.z + pad);
            }
            var baseY = inside[0].y - 0.4f;
            var height = (upstairs ? _b.levelHeight : 0f) + _b.wallHeight + 1.2f;
            float cx = (minX + maxX) / 2f, cz = (minZ + maxZ) / 2f, w = maxX - minX, d = maxZ - minZ, t = 0.5f;
            var house = new GameObject("White House").transform;
            house.SetParent(_root, false);

            var wallMat = Mat.Transparent(new Color(0.93f, 0.91f, 0.87f));
            var trimMat = Mat.Transparent(new Color(0.54f, 0.48f, 0.41f));
            _houseMats.Add(wallMat);
            _houseMats.Add(trimMat);
            Box("Wall N", new Vector3(cx, baseY + height / 2, maxZ), new Vector3(w, height, t), wallMat, house);
            Box("Wall S", new Vector3(cx, baseY + height / 2, minZ), new Vector3(w, height, t), wallMat, house);
            Box("Wall W", new Vector3(minX, baseY + height / 2, cz), new Vector3(t, height, d), wallMat, house);
            Box("Wall E", new Vector3(maxX, baseY + height / 2, cz), new Vector3(t, height, d), wallMat, house);
            Box("Trim N", new Vector3(cx, baseY + 0.3f, maxZ + 0.05f), new Vector3(w + 0.2f, 0.6f, t + 0.1f), trimMat, house);
            Box("Trim S", new Vector3(cx, baseY + 0.3f, minZ - 0.05f), new Vector3(w + 0.2f, 0.6f, t + 0.1f), trimMat, house);
            Box("Floor", new Vector3(cx, baseY - 0.05f, cz), new Vector3(w, 0.3f, d), Mat.Color(new Color(0.42f, 0.31f, 0.2f)), house);

            // Pitched roof: a triangular prism along the long side
            var roofH = Mathf.Min(w, d) * 0.45f;
            _roof = new GameObject("Roof");
            _roof.transform.SetParent(house, false);
            _roof.AddComponent<MeshFilter>().mesh = Prism(minX - 1, maxX + 1, minZ - 1, maxZ + 1, baseY + height, roofH);
            _roof.AddComponent<MeshRenderer>().sharedMaterial = Mat.Color(new Color(0.36f, 0.23f, 0.18f));

            if (lm.chimney != null && lm.chimney.Length == 3)
            {
                var c = WP(lm.chimney);
                _chimney = Box("Chimney", new Vector3(c.x + 2, baseY + height + roofH * 0.6f, cz + d / 4), new Vector3(1.4f, roofH + 1.5f, 1.4f),
                    Mat.Color(new Color(0.55f, 0.29f, 0.23f)), house);
            }
            if (!string.IsNullOrEmpty(lm.doorSide))
            {
                var x = lm.doorSide == "west" ? minX - 0.3f : maxX + 0.3f;
                Box("Front door", new Vector3(x, baseY + 1.6f, cz), new Vector3(0.2f, 3.2f, 1.9f), Mat.Color(new Color(0.35f, 0.23f, 0.13f)), house);
                if (lm.doorBoarded)
                    for (int s = -1; s <= 1; s += 2)
                    {
                        var plank = Box("Board", new Vector3(x + 0.15f * Mathf.Sign(x - cx), baseY + 1.6f, cz), new Vector3(0.15f, 0.35f, 2.6f),
                            Mat.Color(new Color(0.61f, 0.48f, 0.33f)), house);
                        plank.transform.rotation = Quaternion.Euler(s * 40f, 0, 0);
                    }
            }
            if (lm.window != null && lm.window.Length == 3)
            {
                var wp = WP(lm.window);
                var x = lm.windowSide == "east" ? maxX + 0.3f : minX - 0.3f;
                Box("Kitchen window frame", new Vector3(x, baseY + 2.2f, wp.z), new Vector3(0.2f, 1.9f, 2.3f), Mat.Color(new Color(0.85f, 0.82f, 0.75f)), house);
                Box("Kitchen window", new Vector3(x + 0.05f * Mathf.Sign(x - cx), baseY + 2.2f, wp.z), new Vector3(0.15f, 1.5f, 1.9f),
                    Mat.Color(new Color(0.11f, 0.16f, 0.2f), emission: 0.5f), house);
            }
            _houseBounds = new Bounds(new Vector3(cx, baseY + (height + roofH) / 2, cz), new Vector3(w + 2, height + roofH, d + 2));
            _hasHouse = true;
        }

        static Mesh Prism(float x0, float x1, float z0, float z1, float y, float h)
        {
            var zc = (z0 + z1) / 2;
            Vector3 a0 = new Vector3(x0, y, z0), b0 = new Vector3(x0, y, z1), c0 = new Vector3(x0, y + h, zc);
            Vector3 a1 = new Vector3(x1, y, z0), b1 = new Vector3(x1, y, z1), c1 = new Vector3(x1, y + h, zc);
            var v = new[] { a0, c0, c1, a1,  b0, b1, c1, c0,  a0, b0, c0,  a1, c1, b1 };
            var tris = new[] { 0, 1, 2, 0, 2, 3,  4, 5, 6, 4, 6, 7,  8, 9, 10,  11, 12, 13 };
            var m = new Mesh { vertices = v, triangles = tris };
            m.RecalculateNormals();
            return m;
        }

        void Update()
        {
            if (!_hasHouse) return;
            var room = _b.CurrentRoom;
            var role = room != null ? room.RoleIn("white-house") : null;
            var inside = role == "interior" || role == "upstairs";
            // Also see through it when it stands between the camera and the player.
            var cam = Camera.main;
            if (!inside && cam != null && _b.Player != null)
            {
                var to = _b.Player.position + Vector3.up;
                var ray = new Ray(cam.transform.position, (to - cam.transform.position).normalized);
                if (_houseBounds.IntersectRay(ray, out var dist) && dist < Vector3.Distance(cam.transform.position, to)) inside = true;
            }
            _houseAlpha = Mathf.MoveTowards(_houseAlpha, inside ? 0.12f : 1f, Time.deltaTime * 3f);
            foreach (var m in _houseMats) { var c = m.color; c.a = _houseAlpha; m.color = c; }
            if (_roof != null) _roof.SetActive(!inside);
            if (_chimney != null) _chimney.SetActive(!inside);
        }

        // ---------- the forest ----------
        static float Hash(int i, int j, int seed)
        {
            unchecked
            {
                var h = (uint)(i * 374761393 + j * 668265263) * 1274126177u ^ (uint)seed;
                h = (h ^ (h >> 13)) * 1274126177u;
                return (h ^ (h >> 16)) / 4294967296f;
            }
        }

        void BuildForest(LandmarkData lm, WorldData w)
        {
            var pts = new List<Vector3>();
            foreach (var r in lm.rooms) pts.Add(WR(r));
            if (pts.Count == 0) return;
            var forest = new GameObject("Forest").transform;
            forest.SetParent(_root, false);
            var reach = _b.roomSize / 2 + 9;
            var y0 = pts[0].y;
            var floorMat = Mat.Color(new Color(0.19f, 0.28f, 0.16f));
            foreach (var p in pts)
            {
                var disc = Mat.Primitive(PrimitiveType.Cylinder, "Woodland floor", forest, floorMat);
                disc.transform.position = new Vector3(p.x, y0 - 0.55f, p.z);
                disc.transform.localScale = new Vector3(reach * 2, 0.1f, reach * 2);
                Destroy(disc.GetComponent<Collider>());
            }
            // Rooms and paths on this level, which trees must keep clear of
            var rooms = new List<Vector3>();
            var segs = new List<(Vector3, Vector3)>();
            var byId = new Dictionary<string, RoomData>();
            foreach (var r in w.rooms) byId[r.id] = r;
            foreach (var r in w.rooms)
            {
                var p = _b.ToWorld(r);
                if (Mathf.Abs(p.y - y0) > 0.5f) continue;
                rooms.Add(p);
                if (r.exits != null)
                    foreach (var e in r.exits)
                        if (!string.IsNullOrEmpty(e.to) && byId.TryGetValue(e.to, out var o) && o.z == r.z) segs.Add((p, _b.ToWorld(o)));
            }
            float minX = float.MaxValue, maxX = float.MinValue, minZ = float.MaxValue, maxZ = float.MinValue;
            foreach (var p in pts)
            {
                minX = Mathf.Min(minX, p.x - reach); maxX = Mathf.Max(maxX, p.x + reach);
                minZ = Mathf.Min(minZ, p.z - reach); maxZ = Mathf.Max(maxZ, p.z + reach);
            }
            const float cell = 4.2f;
            var trunk = Mat.Color(new Color(0.35f, 0.24f, 0.15f));
            var leaves = new[] { Mat.Color(new Color(0.15f, 0.45f, 0.18f)), Mat.Color(new Color(0.18f, 0.42f, 0.16f)), Mat.Color(new Color(0.23f, 0.49f, 0.2f)) };
            for (int i = Mathf.FloorToInt(minX / cell); i <= Mathf.CeilToInt(maxX / cell); i++)
                for (int j = Mathf.FloorToInt(minZ / cell); j <= Mathf.CeilToInt(maxZ / cell); j++)
                {
                    float r1 = Hash(i, j, 7), r2 = Hash(i, j, 11), r3 = Hash(i, j, 13);
                    if (r3 < 0.25f) continue;
                    var x = (i + r1) * cell; var z = (j + r2) * cell;
                    var near = false;
                    foreach (var p in pts) if (Mathf.Abs(p.x - x) + Mathf.Abs(p.z - z) < reach * 1.2f && Vector2.Distance(new Vector2(p.x, p.z), new Vector2(x, z)) < reach) { near = true; break; }
                    if (!near) continue;
                    var blocked = false;
                    foreach (var p in rooms) if (Mathf.Abs(p.x - x) < _b.roomSize / 2 + 1.5f && Mathf.Abs(p.z - z) < _b.roomSize / 2 + 1.5f) { blocked = true; break; }
                    if (blocked) continue;
                    foreach (var (a, b) in segs) if (DistToSeg(x, z, a, b) < 2.2f) { blocked = true; break; }
                    if (blocked) continue;
                    if (_hasHouse && x > _houseBounds.min.x - 2 && x < _houseBounds.max.x + 2 && z > _houseBounds.min.z - 2 && z < _houseBounds.max.z + 2) continue;
                    var h = 2.2f + r1 * 2.2f; var s = 1.8f + r2 * 1.6f;
                    var tr = Mat.Primitive(PrimitiveType.Cylinder, "Trunk", forest, trunk);
                    tr.transform.position = new Vector3(x, y0 + h / 2 - 0.4f, z);
                    tr.transform.localScale = new Vector3(0.4f, h / 2, 0.4f);
                    Destroy(tr.GetComponent<Collider>());
                    var top = Mat.Primitive(PrimitiveType.Sphere, "Leaves", forest, leaves[(int)(r3 * 3) % 3]);
                    top.transform.position = new Vector3(x, y0 + h + s * 0.35f - 0.4f, z);
                    top.transform.localScale = new Vector3(s, s * 1.25f, s);
                    Destroy(top.GetComponent<Collider>());
                }
            // The big climbable tree: trunk from the forest path up to the "Up a Tree" platform
            if (lm.treeBase != null && lm.treeBase.Length == 3 && lm.treeTop != null && lm.treeTop.Length == 3)
            {
                var b = WP(lm.treeBase); var t = WP(lm.treeTop);
                var tx = b.x + _b.roomSize / 2 + 1.2f; var tz = b.z + _b.roomSize / 2 + 1.2f;
                var h = t.y - b.y + 2;
                var big = Mat.Primitive(PrimitiveType.Cylinder, "Big tree", forest, Mat.Color(new Color(0.29f, 0.2f, 0.13f)));
                big.transform.position = new Vector3(tx, b.y + h / 2, tz);
                big.transform.localScale = new Vector3(1.6f, h / 2, 1.6f);
                Destroy(big.GetComponent<Collider>());
                var mid = new Vector3((tx + t.x) / 2, t.y - 0.6f, (tz + t.z) / 2);
                var branch = Box("Branch", mid, new Vector3(0.8f, 0.8f, Vector2.Distance(new Vector2(tx, tz), new Vector2(t.x, t.z))), Mat.Color(new Color(0.29f, 0.2f, 0.13f)), forest);
                branch.transform.rotation = Quaternion.LookRotation(new Vector3(t.x - tx, 0, t.z - tz));
            }
        }

        static float DistToSeg(float x, float z, Vector3 a, Vector3 b)
        {
            float dx = b.x - a.x, dz = b.z - a.z;
            var len2 = Mathf.Max(1e-6f, dx * dx + dz * dz);
            var t = Mathf.Clamp01(((x - a.x) * dx + (z - a.z) * dz) / len2);
            return Vector2.Distance(new Vector2(x, z), new Vector2(a.x + t * dx, a.z + t * dz));
        }

        // ---------- water ----------
        void BuildRiver(LandmarkData lm)
        {
            if (lm.path == null || lm.path.Length < 6) return;
            var river = new GameObject("Frigid River").transform;
            river.SetParent(_root, false);
            var water = Mat.Color(new Color(0.16f, 0.36f, 0.6f), emission: 0.15f, smooth: 0.9f);
            var bank = Mat.Color(new Color(0.36f, 0.33f, 0.28f));
            for (int i = 0; i + 5 < lm.path.Length; i += 3)
            {
                var a = W(lm.path[i], lm.path[i + 1], lm.path[i + 2]);
                var b = W(lm.path[i + 3], lm.path[i + 4], lm.path[i + 5]);
                var flat = new Vector3(b.x - a.x, 0, b.z - a.z);
                var rot = Quaternion.LookRotation(flat.sqrMagnitude > 0.001f ? flat : Vector3.forward);
                var seg = Box("Water", (a + b) / 2 + Vector3.down * 0.35f, new Vector3(7, 0.25f, flat.magnitude + 7), water, river);
                seg.transform.rotation = rot;
                for (int s = -1; s <= 1; s += 2)
                {
                    var bk = Box("Bank", (a + b) / 2 + rot * new Vector3(4.2f * s, 0.15f, 0), new Vector3(1.2f, 1.4f, flat.magnitude + 6), bank, river);
                    bk.transform.rotation = rot;
                }
            }
        }

        void BuildLake(LandmarkData lm)
        {
            var lake = new GameObject("Reservoir").transform;
            lake.SetParent(_root, false);
            var water = Mat.Color(new Color(0.16f, 0.36f, 0.6f), emission: 0.12f, smooth: 0.9f);
            foreach (var r in lm.rooms)
            {
                var p = WR(r);
                var disc = Mat.Primitive(PrimitiveType.Cylinder, "Water", lake, water);
                disc.transform.position = p + Vector3.down * 0.3f;
                disc.transform.localScale = new Vector3(_b.roomSize * 2.4f, 0.1f, _b.roomSize * 2.4f);
                Destroy(disc.GetComponent<Collider>());
            }
        }

        // ---------- the rainbow ----------
        void BuildRainbow(LandmarkData lm)
        {
            LandmarkRoom from = null, to = null;
            foreach (var r in lm.rooms) { if (r.role == "from") from = r; if (r.role == "to") to = r; }
            if (from == null || to == null) return;
            Vector3 a = WR(from), b = WR(to);
            var rainbow = new GameObject("Rainbow").transform;
            rainbow.SetParent(_root, false);
            var mid = (a + b) / 2;
            var along = new Vector3(b.x - a.x, 0, b.z - a.z);
            var span = along.magnitude;
            along.Normalize();
            var colors = new[] { new Color(1f, 0.25f, 0.25f), new Color(1f, 0.6f, 0.19f), new Color(1f, 0.88f, 0.25f),
                                 new Color(0.31f, 0.82f, 0.31f), new Color(0.25f, 0.56f, 1f), new Color(0.44f, 0.31f, 0.88f) };
            const int steps = 28;
            for (int band = 0; band < colors.Length; band++)
            {
                var radius = span / 2 - band * 0.55f;
                var m = Mat.Color(colors[band], emission: 0.8f);
                for (int k = 0; k < steps; k++)
                {
                    float t0 = Mathf.PI * k / steps, t1 = Mathf.PI * (k + 1) / steps;
                    var p0 = mid + along * (-Mathf.Cos(t0) * radius) + Vector3.up * (Mathf.Sin(t0) * radius);
                    var p1 = mid + along * (-Mathf.Cos(t1) * radius) + Vector3.up * (Mathf.Sin(t1) * radius);
                    var seg = Box("Band", (p0 + p1) / 2, new Vector3(0.5f, 0.5f, Vector3.Distance(p0, p1) + 0.05f), m, rainbow);
                    seg.transform.rotation = Quaternion.LookRotation(p1 - p0);
                }
            }
        }
    }
}
