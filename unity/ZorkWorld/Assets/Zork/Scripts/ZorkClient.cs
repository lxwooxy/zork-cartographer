using System;
using System.Collections;
using System.Text;
using UnityEngine;
using UnityEngine.Networking;

namespace Zork
{
    /// Polls the Python server for map updates and sends commands to the game.
    public class ZorkClient : MonoBehaviour
    {
        public string serverUrl = "http://127.0.0.1:8765";
        public string password = "";
        public float pollInterval = 0.5f;
        public bool Unauthorized { get; private set; }

        public WorldData World { get; private set; }
        public bool Connected { get; private set; }
        public string LastError { get; private set; }
        public event Action<WorldData> OnWorld;

        int _version = -1;

        void Awake()
        {
            // Saved settings win, then environment variables, then the defaults above.
            serverUrl = PlayerPrefs.GetString("zork.server", Environment.GetEnvironmentVariable("ZORK_SERVER") ?? serverUrl);
            password = PlayerPrefs.GetString("zork.password", Environment.GetEnvironmentVariable("ZORK_PASSWORD") ?? password);
        }

        void Start() => StartCoroutine(Poll());

        public void Configure(string url, string pw)
        {
            serverUrl = url.Trim().TrimEnd('/');
            password = pw;
            PlayerPrefs.SetString("zork.server", serverUrl);
            PlayerPrefs.SetString("zork.password", password);
            PlayerPrefs.Save();
            _version = -1;
            World = null;
        }

        void Auth(UnityWebRequest req)
        {
            if (!string.IsNullOrEmpty(password)) req.SetRequestHeader("X-Zork-Password", password);
        }

        IEnumerator Poll()
        {
            while (true)
            {
                using (var req = UnityWebRequest.Get($"{serverUrl}/api/unity?since={_version}"))
                {
                    req.timeout = 5;
                    Auth(req);
                    yield return req.SendWebRequest();
                    Unauthorized = req.responseCode == 401;
                    if (req.result == UnityWebRequest.Result.Success)
                    {
                        Connected = true;
                        LastError = null;
                        var data = JsonUtility.FromJson<WorldData>(req.downloadHandler.text);
                        if (data != null && !data.unchanged)
                        {
                            _version = data.version;
                            World = data;
                            OnWorld?.Invoke(data);
                        }
                    }
                    else
                    {
                        Connected = false;
                        LastError = Unauthorized ? "wrong or missing password" : req.error;
                        _version = -1;
                    }
                }
                yield return new WaitForSeconds(pollInterval);
            }
        }

        public void SendCommand(string command)
        {
            if (string.IsNullOrWhiteSpace(command)) return;
            StartCoroutine(Post("/api/command", JsonUtility.ToJson(new CommandRequest { command = command.Trim() })));
        }

        /// Ask the autopilot to walk to a room (see server/autopilot.py for its rules).
        public void Travel(string roomId)
        {
            if (string.IsNullOrEmpty(roomId)) return;
            StartCoroutine(Post("/api/travel", JsonUtility.ToJson(new TravelRequest { to = roomId })));
        }

        public void StopTravel() => StartCoroutine(Post("/api/travel/stop", "{}"));

        IEnumerator Post(string path, string body)
        {
            using (var req = new UnityWebRequest($"{serverUrl}{path}", "POST"))
            {
                req.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(body));
                req.downloadHandler = new DownloadHandlerBuffer();
                req.SetRequestHeader("Content-Type", "application/json");
                Auth(req);
                req.timeout = 15;
                yield return req.SendWebRequest();
                if (req.result != UnityWebRequest.Result.Success && req.responseCode != 409)
                    LastError = req.error;
            }
            _version = -1; // force a refresh right away
        }
    }
}
