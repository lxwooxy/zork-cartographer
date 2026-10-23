using System.Text;
using UnityEngine;

namespace Zork
{
    /// Play Zork from inside Unity: game log + command box on the left,
    /// room info and inventory on the right.
    public class GameHUD : MonoBehaviour
    {
        public bool visible = true;

        ZorkClient _client;
        WorldBuilder _builder;
        string _input = "";
        Vector2 _logScroll;
        int _lastLogCount;
        GUIStyle _log, _box, _title, _small;

        void Awake()
        {
            _client = GetComponent<ZorkClient>();
            _builder = GetComponent<WorldBuilder>();
        }

        void Styles()
        {
            if (_log != null) return;
            _log = new GUIStyle(GUI.skin.label) { wordWrap = true, fontSize = 13, richText = true };
            _log.normal.textColor = new Color(0.85f, 0.9f, 0.87f);
            _box = new GUIStyle(GUI.skin.box);
            var bg = new Texture2D(1, 1);
            bg.SetPixel(0, 0, new Color(0.05f, 0.07f, 0.06f, 0.82f));
            bg.Apply();
            _box.normal.background = bg;
            _title = new GUIStyle(GUI.skin.label) { fontSize = 15, fontStyle = FontStyle.Bold, wordWrap = true };
            _title.normal.textColor = new Color(0.5f, 0.9f, 0.63f);
            _small = new GUIStyle(_log) { fontSize = 12 };
        }

        void OnGUI()
        {
            Styles();
            if (Event.current.type == EventType.KeyDown && Event.current.keyCode == KeyCode.H && GUIUtility.keyboardControl == 0)
                visible = !visible;
            if (!visible) { GUI.Label(new Rect(10, 10, 300, 20), "H: show HUD"); return; }

            var w = _client.World;
            var status = _client.Connected
                ? (w != null ? $"Score {w.score}   Moves {w.moves}   Rooms {w.rooms.Length}" : "Connected")
                : $"Not connected to {_client.serverUrl}. Start the server: ./run.sh";
            GUI.Label(new Rect(12, 8, 900, 22), status, _title);
            GUI.Label(new Rect(12, 28, 900, 20),
                "Right-drag orbit · Scroll zoom · WASD/QE pan · F follow · Tab overview · H hide HUD", _small);

            // Left: log + input
            float lw = Mathf.Min(440, Screen.width * 0.3f);
            var logRect = new Rect(10, 54, lw, Mathf.Min(Screen.height - 110, Screen.height * 0.55f));
            GUI.Box(logRect, GUIContent.none, _box);
            var sb = new StringBuilder();
            if (w != null && w.log != null)
            {
                foreach (var e in w.log)
                {
                    if (!string.IsNullOrEmpty(e.command)) sb.Append("\n<color=#7ee0a1>> ").Append(Escape(e.command)).Append("</color>\n");
                    sb.Append(Escape(e.text)).Append('\n');
                }
                if (w.log.Length != _lastLogCount) { _lastLogCount = w.log.Length; _logScroll.y = float.MaxValue; }
            }
            var text = sb.ToString();
            var inner = logRect.width - 30;
            var h = _log.CalcHeight(new GUIContent(text), inner);
            _logScroll = GUI.BeginScrollView(new Rect(logRect.x + 5, logRect.y + 5, logRect.width - 10, logRect.height - 10),
                _logScroll, new Rect(0, 0, inner, h));
            GUI.Label(new Rect(0, 0, inner, h), text, _log);
            GUI.EndScrollView();

            GUI.SetNextControlName("cmd");
            var inputRect = new Rect(10, logRect.yMax + 8, lw, 30);
            if (Event.current.type == EventType.KeyDown && Event.current.keyCode == KeyCode.Return && GUI.GetNameOfFocusedControl() == "cmd")
            {
                _client.SendCommand(_input);
                _input = "";
                Event.current.Use();
            }
            _input = GUI.TextField(inputRect, _input);
            if (Event.current.type == EventType.KeyDown && Event.current.keyCode == KeyCode.Escape)
                GUI.FocusControl(null);
            if (Event.current.type == EventType.KeyDown && Event.current.keyCode == KeyCode.Return && GUI.GetNameOfFocusedControl() != "cmd")
            {
                GUI.FocusControl("cmd");
                Event.current.Use();
            }

            // Right: room + inventory
            float rw = Mathf.Min(260, Screen.width * 0.24f);
            var right = new Rect(Screen.width - rw - 10, 54, rw, Screen.height - 64);
            GUI.Box(right, GUIContent.none, _box);
            GUILayout.BeginArea(new Rect(right.x + 10, right.y + 8, right.width - 20, right.height - 16));
            var room = _builder.CurrentRoom;
            if (room != null)
            {
                GUILayout.Label(room.name, _title);
                if (!string.IsNullOrEmpty(room.environment))
                    GUILayout.Label($"<color=#7d8c84>{room.environment} · {(room.indoor ? "indoor" : "outdoor")} · level {room.z}</color>", _small);
                if (!string.IsNullOrEmpty(room.description)) GUILayout.Label(room.description, _small);
                GUILayout.Space(6);
                GUILayout.Label("<b>Here</b>", _log);
                if (room.items == null || room.items.Length == 0) GUILayout.Label("<i>nothing loose</i>", _small);
                else foreach (var it in room.items) GUILayout.Label("• " + it, _small);
                GUILayout.Space(6);
                GUILayout.Label("<b>Exits</b>", _log);
                if (room.exits != null)
                    foreach (var e in room.exits)
                        if (GUILayout.Button(e.dir + (string.IsNullOrEmpty(e.to) ? (e.blocked ? " (blocked)" : " (unexplored)") : ""), GUILayout.Height(22)))
                            _client.SendCommand(e.dir);
            }
            GUILayout.Space(10);
            GUILayout.Label("Inventory", _title);
            if (w == null || w.inventory == null || w.inventory.Length == 0) GUILayout.Label("<i>empty-handed</i>", _small);
            else foreach (var it in w.inventory) GUILayout.Label("• " + it, _small);
            GUILayout.EndArea();
        }

        static string Escape(string s) => (s ?? "").Replace("<", "‹").Replace(">", "›");
    }
}
