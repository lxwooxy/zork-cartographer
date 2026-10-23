using System;

namespace Zork
{
    // Mirrors the JSON from GET /api/unity (see server/world.py: World.to_unity).
    [Serializable]
    public class WorldData
    {
        public int version;
        public bool unchanged;
        public string current;
        public int score;
        public int moves;
        public string[] inventory;
        public RoomData[] rooms;
        public LogEntry[] log;
        public LandmarkData[] landmarks;
        public string travelStatus;    // "", moving, arrived, stopped, stuck, failed
        public string travelMessage;
        public string travelTo;
    }

    [Serializable]
    public class RoomData
    {
        public string id;
        public string name;
        public string description;
        public float x;
        public float y;
        public int z;
        public string environment;
        public bool indoor;
        public string lighting;
        public string visual;
        public string floorColor;
        public string wallColor;
        public string accentColor;
        public string[] items;
        public string[] features;
        public ExitData[] exits;
        public int reach;              // 0 none, 1 maybe, 2 reachable, 3 one move away, 4 on the route
        public string[] roles;         // "landmark:role", e.g. "white-house:exterior"

        public string RoleIn(string landmark)
        {
            if (roles == null) return null;
            foreach (var r in roles)
                if (r.StartsWith(landmark + ":")) return r.Substring(landmark.Length + 1);
            return null;
        }

        // Used to decide whether a room's geometry needs rebuilding.
        public string Signature()
        {
            var s = $"{string.Join(",", roles ?? new string[0])}|{environment}|{indoor}|{lighting}|{floorColor}|{wallColor}|{accentColor}|{string.Join(",", items ?? new string[0])}|{string.Join(",", features ?? new string[0])}";
            if (exits != null)
                foreach (var e in exits) s += $"|{e.dir}:{e.to}:{e.blocked}";
            return s;
        }
    }

    /// A place drawn as one thing across several rooms (game/zork1-landmarks.json).
    [Serializable]
    public class LandmarkData
    {
        public string id;
        public string kind;            // house, forest, river, rainbow, lake
        public LandmarkRoom[] rooms;
        public string doorSide;
        public bool doorBoarded;
        public string windowSide;
        public float[] window;         // map point [x, y, z]
        public float[] chimney;
        public float[] treeBase;
        public float[] treeTop;
        public float[] path;           // x,y,z,x,y,z,... for rivers
    }

    [Serializable]
    public class LandmarkRoom
    {
        public string id;
        public string role;
        public float x;
        public float y;
        public int z;
    }

    [Serializable]
    public class ExitData
    {
        public string dir;
        public string to;
        public bool blocked;
        public bool inferred;
    }

    [Serializable]
    public class LogEntry
    {
        public string command;
        public string text;
    }

    [Serializable]
    public class CommandRequest
    {
        public string command;
    }

    [Serializable]
    public class TravelRequest
    {
        public string to;
    }
}
