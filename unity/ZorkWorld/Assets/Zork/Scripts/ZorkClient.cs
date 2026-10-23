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
        public float pollInterval = 0.5f;

        public WorldData World { get; private set; }
        public bool Connected { get; private set; }
        public string LastError { get; private set; }
        public event Action<WorldData> OnWorld;

        int _version = -1;

        void Start() => StartCoroutine(Poll());

        IEnumerator Poll()
        {
            while (true)
            {
                using (var req = UnityWebRequest.Get($"{serverUrl}/api/unity?since={_version}"))
                {
                    req.timeout = 5;
                    yield return req.SendWebRequest();
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
                        LastError = req.error;
                        _version = -1;
                    }
                }
                yield return new WaitForSeconds(pollInterval);
            }
        }

        public void SendCommand(string command)
        {
            if (string.IsNullOrWhiteSpace(command)) return;
            StartCoroutine(Post(command.Trim()));
        }

        IEnumerator Post(string command)
        {
            var body = JsonUtility.ToJson(new CommandRequest { command = command });
            using (var req = new UnityWebRequest($"{serverUrl}/api/command", "POST"))
            {
                req.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(body));
                req.downloadHandler = new DownloadHandlerBuffer();
                req.SetRequestHeader("Content-Type", "application/json");
                req.timeout = 15;
                yield return req.SendWebRequest();
                if (req.result != UnityWebRequest.Result.Success)
                    LastError = req.error;
            }
            _version = -1; // force a refresh right away
        }
    }
}
