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

        // Used to decide whether a room's geometry needs rebuilding.
        public string Signature()
        {
            var s = $"{environment}|{indoor}|{lighting}|{floorColor}|{wallColor}|{accentColor}|{string.Join(",", items ?? new string[0])}|{string.Join(",", features ?? new string[0])}";
            if (exits != null)
                foreach (var e in exits) s += $"|{e.dir}:{e.to}:{e.blocked}";
            return s;
        }
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
}
