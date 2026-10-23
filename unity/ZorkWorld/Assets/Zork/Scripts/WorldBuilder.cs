using System.Collections.Generic;
using UnityEngine;

namespace Zork
{
    /// Turns the map data into 3D geometry: one "room" per location, corridors
    /// between them, stairs between levels, and markers for items and the player.
    public class WorldBuilder : MonoBehaviour
    {
        public float spacing = 14f;      // world units per map unit
        public float levelHeight = 9f;   // world units per up/down level
        public float roomSize = 8f;
        public float wallHeight = 3.2f;

        public Transform Player { get; private set; }
        public Vector3 CurrentRoomPosition { get; private set; }
        public RoomData CurrentRoom { get; private set; }

        ZorkClient _client;
        readonly Dictionary<string, GameObject> _rooms = new Dictionary<string, GameObject>();
        readonly Dictionary<string, string> _signatures = new Dictionary<string, string>();
        readonly Dictionary<string, Vector3> _positions = new Dictionary<string, Vector3>();
        Transform _connections;
        Vector3 _playerTarget;

        static readonly Dictionary<string, Vector3> Dir = new Dictionary<string, Vector3>
        {
            {"north", new Vector3(0, 0, 1)}, {"south", new Vector3(0, 0, -1)},
            {"east", new Vector3(1, 0, 0)}, {"west", new Vector3(-1, 0, 0)},
            {"northeast", new Vector3(1, 0, 1).normalized}, {"northwest", new Vector3(-1, 0, 1).normalized},
            {"southeast", new Vector3(1, 0, -1).normalized}, {"southwest", new Vector3(-1, 0, -1).normalized},
            {"up", Vector3.up}, {"down", Vector3.down}, {"in", Vector3.zero}, {"out", Vector3.zero},
        };

        void Awake()
        {
            _client = GetComponent<ZorkClient>();
            _client.OnWorld += Build;
            _connections = new GameObject("Connections").transform;
            _connections.SetParent(transform, false);

            var p = Mat.Primitive(PrimitiveType.Capsule, "Player", transform, Mat.Color(new Color(0.5f, 1f, 0.65f), emission: 1.5f));
            p.transform.localScale = new Vector3(0.9f, 0.9f, 0.9f);
            var light = p.AddComponent<Light>();
            light.type = LightType.Point;
            light.range = 14f;
            light.intensity = 2.2f;
            light.color = new Color(1f, 0.85f, 0.6f);
            Player = p.transform;
        }

        void Update()
        {
            if (Player == null) return;
            var bob = Mathf.Sin(Time.time * 2f) * 0.15f;
            Player.position = Vector3.Lerp(Player.position, _playerTarget + Vector3.up * (1.3f + bob), Time.deltaTime * 4f);
        }

        public Vector3 ToWorld(RoomData r) => new Vector3(r.x * spacing, r.z * levelHeight, r.y * spacing);

        void Build(WorldData w)
        {
            var byId = new Dictionary<string, RoomData>();
            foreach (var r in w.rooms) byId[r.id] = r;

            // Rooms: create, move, or rebuild if their data changed.
            foreach (var r in w.rooms)
            {
                var pos = ToWorld(r);
                var sig = r.Signature();
                if (!_rooms.TryGetValue(r.id, out var go) || _signatures[r.id] != sig)
                {
                    if (go != null) Destroy(go);
                    go = BuildRoom(r, byId);
                    _rooms[r.id] = go;
                    _signatures[r.id] = sig;
                    go.transform.position = pos;
                }
                // The layout can shift as the map grows; glide rooms to their new spots.
                var mover = go.GetComponent<SmoothMove>();
                if (mover == null) mover = go.AddComponent<SmoothMove>();
                mover.target = pos;
                mover.enabled = true;
                _positions[r.id] = pos;
            }

            // Connections are cheap, so rebuild them every update.
            foreach (Transform c in _connections) Destroy(c.gameObject);
            var done = new HashSet<string>();
            foreach (var r in w.rooms)
            {
                if (r.exits == null) continue;
                foreach (var e in r.exits)
                {
                    if (string.IsNullOrEmpty(e.to) || !byId.ContainsKey(e.to)) continue;
                    var key = string.CompareOrdinal(r.id, e.to) < 0 ? r.id + "|" + e.to : e.to + "|" + r.id;
                    if (!done.Add(key)) continue;
                    BuildConnection(r, byId[e.to], e);
                }
            }

            if (!string.IsNullOrEmpty(w.current) && byId.TryGetValue(w.current, out var cur))
            {
                CurrentRoom = cur;
                CurrentRoomPosition = ToWorld(cur);
                _playerTarget = CurrentRoomPosition;
                if (Player.position == Vector3.zero) Player.position = _playerTarget;
            }
        }

        // ---------- rooms ----------
        GameObject BuildRoom(RoomData r, Dictionary<string, RoomData> byId)
        {
            var root = new GameObject("Room: " + r.name);
            root.transform.SetParent(transform, false);
            var env = (r.environment ?? "").ToLowerInvariant();
            var dark = r.lighting == "dark";
            var theme = Theme.For(env);
            var floorC = Mat.Parse(r.floorColor, theme.floor);
            var wallC = Mat.Parse(r.wallColor, theme.wall);
            var accentC = Mat.Parse(r.accentColor, theme.accent);
            if (dark) { floorC *= 0.45f; wallC *= 0.45f; floorC.a = wallC.a = 1f; }

            // Floor
            var floor = Mat.Primitive(PrimitiveType.Cube, "Floor", root.transform, Mat.Color(floorC));
            floor.transform.localScale = new Vector3(roomSize, 0.4f, roomSize);
            floor.transform.localPosition = new Vector3(0, -0.2f, 0);

            // Which sides have openings
            var open = new HashSet<string>();
            if (r.exits != null)
                foreach (var e in r.exits)
                {
                    var side = SideFor(r, e, byId);
                    if (side != null) open.Add(side);
                }

            if (r.indoor && env != "maze")
                BuildWalls(root.transform, open, Mat.Color(wallC), wallHeight);
            else if (env == "maze")
                BuildWalls(root.transform, open, Mat.Color(wallC), wallHeight * 0.8f);

            Decorate(root.transform, r, env, accentC, wallC);

            // Room light
            var lgo = new GameObject("Light");
            lgo.transform.SetParent(root.transform, false);
            lgo.transform.localPosition = new Vector3(0, wallHeight + 0.5f, 0);
            var light = lgo.AddComponent<Light>();
            light.type = LightType.Point;
            light.range = roomSize * 1.4f;
            light.intensity = dark ? 0.15f : 1.1f;
            light.color = Color.Lerp(Color.white, accentC, 0.35f);

            // Label
            Label.Create(root.transform, r.name, new Vector3(0, wallHeight + 1.6f, 0), 0.32f, Color.white);

            // Items: small glowing cubes along the front of the room
            if (r.items != null)
                for (int i = 0; i < r.items.Length; i++)
                {
                    var x = -roomSize * 0.35f + i * 1.6f;
                    var it = Mat.Primitive(PrimitiveType.Cube, "Item: " + r.items[i], root.transform,
                        Mat.Color(new Color(1f, 0.82f, 0.35f), emission: 0.8f));
                    it.transform.localScale = Vector3.one * 0.45f;
                    it.transform.localPosition = new Vector3(x, 0.35f, -roomSize * 0.3f);
                    it.AddComponent<Spin>();
                    Label.Create(root.transform, r.items[i], it.transform.localPosition + new Vector3(0, 0.7f, 0), 0.16f, new Color(1f, 0.9f, 0.6f));
                }

            // Unexplored and blocked exits: short stubs out of the room
            if (r.exits != null)
                foreach (var e in r.exits)
                {
                    if (!string.IsNullOrEmpty(e.to)) continue;
                    if (!Dir.TryGetValue(e.dir, out var d) || d == Vector3.zero) continue;
                    if (d.y != 0)
                    {
                        var marker = Mat.Primitive(PrimitiveType.Cylinder, "Exit " + e.dir, root.transform,
                            Mat.Color(e.blocked ? new Color(0.8f, 0.2f, 0.2f) : new Color(0.4f, 0.6f, 0.5f), emission: 0.3f));
                        marker.transform.localScale = new Vector3(1.4f, 0.05f, 1.4f);
                        marker.transform.localPosition = new Vector3(roomSize * 0.3f, d.y > 0 ? wallHeight : 0.03f, roomSize * 0.3f);
                        Label.Create(root.transform, e.dir + (e.blocked ? " (blocked)" : " ?"), marker.transform.localPosition + new Vector3(0, 0.6f, 0), 0.14f, new Color(0.7f, 0.9f, 0.8f));
                        continue;
                    }
                    var stub = Mat.Primitive(PrimitiveType.Cube, "Exit " + e.dir, root.transform,
                        Mat.Color(e.blocked ? new Color(0.7f, 0.15f, 0.15f) : new Color(0.3f, 0.4f, 0.35f)));
                    stub.transform.localScale = new Vector3(1.8f, 0.2f, 2.5f);
                    stub.transform.localRotation = Quaternion.LookRotation(d);
                    stub.transform.localPosition = d * (roomSize * 0.5f + 1.25f) + Vector3.up * -0.1f;
                }
            return root;
        }

        string SideFor(RoomData r, ExitData e, Dictionary<string, RoomData> byId)
        {
            Vector3 d;
            if (!string.IsNullOrEmpty(e.to) && byId.TryGetValue(e.to, out var other) && other.z == r.z)
                d = new Vector3(other.x - r.x, 0, other.y - r.y);
            else if (!Dir.TryGetValue(e.dir, out d) || d.y != 0 || d == Vector3.zero)
                return null;
            if (d.sqrMagnitude < 0.0001f) return null;
            return Mathf.Abs(d.x) > Mathf.Abs(d.z) ? (d.x > 0 ? "east" : "west") : (d.z > 0 ? "north" : "south");
        }

        void BuildWalls(Transform parent, HashSet<string> open, Material m, float h)
        {
            var half = roomSize / 2f;
            const float t = 0.3f, gap = 2.6f;
            void Wall(string side, Vector3 center, bool alongX)
            {
                if (!open.Contains(side))
                {
                    var w = Mat.Primitive(PrimitiveType.Cube, "Wall " + side, parent, m);
                    w.transform.localScale = alongX ? new Vector3(roomSize, h, t) : new Vector3(t, h, roomSize);
                    w.transform.localPosition = center + Vector3.up * h / 2f;
                    return;
                }
                var segLen = (roomSize - gap) / 2f;
                for (int s = -1; s <= 1; s += 2)
                {
                    var w = Mat.Primitive(PrimitiveType.Cube, "Wall " + side, parent, m);
                    var off = s * (gap / 2f + segLen / 2f);
                    w.transform.localScale = alongX ? new Vector3(segLen, h, t) : new Vector3(t, h, segLen);
                    w.transform.localPosition = center + (alongX ? new Vector3(off, 0, 0) : new Vector3(0, 0, off)) + Vector3.up * h / 2f;
                }
            }
            Wall("north", new Vector3(0, 0, half), true);
            Wall("south", new Vector3(0, 0, -half), true);
            Wall("east", new Vector3(half, 0, 0), false);
            Wall("west", new Vector3(-half, 0, 0), false);
        }

        void Decorate(Transform parent, RoomData r, string env, Color accent, Color wall)
        {
            var rng = new System.Random(r.id.GetHashCode());
            float Rand(float a, float b) => a + (float)rng.NextDouble() * (b - a);
            Vector3 Edge()
            {
                // Somewhere near the edges, leaving the middle free.
                var side = rng.Next(4);
                var along = Rand(-roomSize * 0.45f, roomSize * 0.45f);
                var inset = Rand(roomSize * 0.32f, roomSize * 0.47f);
                switch (side)
                {
                    case 0: return new Vector3(along, 0, inset);
                    case 1: return new Vector3(along, 0, -inset);
                    case 2: return new Vector3(inset, 0, along);
                    default: return new Vector3(-inset, 0, along);
                }
            }

            switch (env)
            {
                case "forest":
                case "field":
                    var trees = env == "forest" ? 9 : 2;
                    for (int i = 0; i < trees; i++)
                    {
                        var p = Edge();
                        var trunkH = Rand(2f, 3.5f);
                        var trunk = Mat.Primitive(PrimitiveType.Cylinder, "Trunk", parent, Mat.Color(new Color(0.35f, 0.24f, 0.15f)));
                        trunk.transform.localScale = new Vector3(0.35f, trunkH / 2f, 0.35f);
                        trunk.transform.localPosition = p + Vector3.up * trunkH / 2f;
                        var top = Mat.Primitive(PrimitiveType.Sphere, "Canopy", parent, Mat.Color(Color.Lerp(new Color(0.15f, 0.45f, 0.2f), accent, 0.2f)));
                        var s = Rand(1.6f, 2.6f);
                        top.transform.localScale = new Vector3(s, s * 1.2f, s);
                        top.transform.localPosition = p + Vector3.up * (trunkH + s * 0.4f);
                    }
                    break;
                case "river":
                case "lake":
                case "dam":
                    var water = Mat.Primitive(PrimitiveType.Cube, "Water", parent, Mat.Color(new Color(0.15f, 0.35f, 0.6f), smooth: 0.9f));
                    water.transform.localScale = new Vector3(roomSize * 0.9f, 0.1f, roomSize * 0.45f);
                    water.transform.localPosition = new Vector3(0, 0.06f, roomSize * 0.2f);
                    break;
                case "cave":
                case "mine":
                case "canyon":
                    for (int i = 0; i < 6; i++)
                    {
                        var rock = Mat.Primitive(PrimitiveType.Sphere, "Rock", parent, Mat.Color(Color.Lerp(wall, Color.gray, 0.3f)));
                        var s = Rand(0.6f, 1.6f);
                        rock.transform.localScale = new Vector3(s * Rand(0.8f, 1.5f), s * 0.7f, s);
                        rock.transform.localPosition = Edge() + Vector3.up * s * 0.2f;
                    }
                    break;
                case "temple":
                case "crypt":
                    for (int i = -1; i <= 1; i += 2)
                        for (int j = -1; j <= 1; j += 2)
                        {
                            var col = Mat.Primitive(PrimitiveType.Cylinder, "Column", parent, Mat.Color(Color.Lerp(wall, Color.white, 0.4f)));
                            col.transform.localScale = new Vector3(0.6f, wallHeight / 2f, 0.6f);
                            col.transform.localPosition = new Vector3(i * roomSize * 0.3f, wallHeight / 2f, j * roomSize * 0.3f);
                        }
                    break;
            }

            // A white house sits next to the rooms around it.
            var name = r.name.ToLowerInvariant();
            if (!r.indoor && name.Contains("house"))
            {
                var house = Mat.Primitive(PrimitiveType.Cube, "White House", parent, Mat.Color(new Color(0.92f, 0.92f, 0.88f)));
                house.transform.localScale = new Vector3(2.5f, 2.5f, 2.5f);
                house.transform.localPosition = new Vector3(roomSize * 0.3f, 1.25f, roomSize * 0.3f);
            }

            // Scenery features from Claude become labelled props along the walls.
            if (r.features != null)
                for (int i = 0; i < r.features.Length && i < 6; i++)
                {
                    var p = Edge() * 0.85f;
                    var prop = Mat.Primitive(PrimitiveType.Cube, "Feature: " + r.features[i], parent, Mat.Color(Color.Lerp(accent, wall, 0.3f)));
                    var h = Rand(0.6f, 1.4f);
                    prop.transform.localScale = new Vector3(Rand(0.8f, 1.6f), h, Rand(0.6f, 1.2f));
                    prop.transform.localPosition = p + Vector3.up * h / 2f;
                    Label.Create(parent, r.features[i], prop.transform.localPosition + new Vector3(0, h / 2f + 0.5f, 0), 0.14f, new Color(0.8f, 0.85f, 0.9f));
                }
        }

        // ---------- connections ----------
        void BuildConnection(RoomData a, RoomData b, ExitData e)
        {
            var pa = ToWorld(a);
            var pb = ToWorld(b);
            var mat = Mat.Color(e.inferred ? new Color(0.35f, 0.38f, 0.36f) : new Color(0.55f, 0.5f, 0.42f));
            if (a.z == b.z)
            {
                var flat = pb - pa;
                var len = flat.magnitude - roomSize;
                if (len <= 0.05f) return;
                var dir = flat.normalized;
                var start = pa + dir * roomSize / 2f;
                var path = Mat.Primitive(PrimitiveType.Cube, $"Path {a.name} - {b.name}", _connections, mat);
                path.transform.position = start + dir * len / 2f + Vector3.down * 0.15f;
                path.transform.rotation = Quaternion.LookRotation(dir);
                path.transform.localScale = new Vector3(2.2f, 0.3f, len);
            }
            else
            {
                // Stairs or ramp between levels. If the rooms are stacked, offset the ramp.
                var horizontal = new Vector3(pb.x - pa.x, 0, pb.z - pa.z);
                var lowP = a.z < b.z ? pa : pb;
                var highP = a.z < b.z ? pb : pa;
                if (horizontal.magnitude < roomSize)
                {
                    // Spiral-ish: a tall shaft at the room corner
                    var corner = lowP + new Vector3(roomSize / 2f + 1f, 0, roomSize / 2f + 1f);
                    var shaft = Mat.Primitive(PrimitiveType.Cylinder, $"Shaft {a.name} - {b.name}", _connections,
                        Mat.Color(new Color(0.5f, 0.45f, 0.35f), emission: 0.1f));
                    var h = highP.y - lowP.y;
                    shaft.transform.position = corner + Vector3.up * h / 2f;
                    shaft.transform.localScale = new Vector3(1.2f, h / 2f, 1.2f);
                    return;
                }
                var dir = (highP - lowP).normalized;
                var startP = lowP + new Vector3(dir.x, 0, dir.z).normalized * roomSize / 2f;
                var endP = highP - new Vector3(dir.x, 0, dir.z).normalized * roomSize / 2f;
                var ramp = Mat.Primitive(PrimitiveType.Cube, $"Stairs {a.name} - {b.name}", _connections, mat);
                ramp.transform.position = (startP + endP) / 2f;
                ramp.transform.rotation = Quaternion.LookRotation(endP - startP);
                ramp.transform.localScale = new Vector3(2.2f, 0.3f, (endP - startP).magnitude);
            }
        }
    }

    /// Default colors per environment, used until Claude suggests a palette.
    public struct Theme
    {
        public Color floor, wall, accent;

        public static Theme For(string env)
        {
            switch (env)
            {
                case "forest": return new Theme { floor = H("#3d5a2e"), wall = H("#2f4a26"), accent = H("#8fbf5a") };
                case "field": return new Theme { floor = H("#5c7a3a"), wall = H("#6b8a46"), accent = H("#d9d07a") };
                case "house": return new Theme { floor = H("#7a5a3c"), wall = H("#d8d2c4"), accent = H("#c99a5b") };
                case "river":
                case "lake":
                case "dam": return new Theme { floor = H("#5a6a6e"), wall = H("#3e5560"), accent = H("#5aa0d0") };
                case "maze": return new Theme { floor = H("#3a3530"), wall = H("#5a524a"), accent = H("#a08a6a") };
                case "mine": return new Theme { floor = H("#2e2a26"), wall = H("#3d3631"), accent = H("#c08040") };
                case "temple":
                case "crypt": return new Theme { floor = H("#8a8070"), wall = H("#b0a690"), accent = H("#e0c060") };
                case "sky": return new Theme { floor = H("#9ab0c8"), wall = H("#c0d0e0"), accent = H("#ffffff") };
                default: return new Theme { floor = H("#4a4540"), wall = H("#5e5650"), accent = H("#b0906a") };
            }
        }

        static Color H(string hex) => Mat.Parse(hex, Color.gray);
    }

    public class SmoothMove : MonoBehaviour
    {
        public Vector3 target;

        void Update()
        {
            transform.position = Vector3.Lerp(transform.position, target, Time.deltaTime * 3f);
            if ((transform.position - target).sqrMagnitude < 0.0001f) { transform.position = target; enabled = false; }
        }
    }

    public class Spin : MonoBehaviour
    {
        void Update() => transform.Rotate(0, 60f * Time.deltaTime, 0, Space.World);
    }
}
