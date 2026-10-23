using System;
using System.Collections;
using System.IO;
using UnityEngine;

namespace Zork
{
    /// Only active when the ZORK_AUTOTEST environment variable is set (see Editor/ZorkAutoTest.cs).
    /// Waits for the map to load, saves screenshots, writes a summary, and quits.
    public class AutoTestRunner : MonoBehaviour
    {
        string _dir;

        public static void AttachIfRequested(GameObject root)
        {
            var dir = Environment.GetEnvironmentVariable("ZORK_AUTOTEST");
            if (string.IsNullOrEmpty(dir)) return;
            root.AddComponent<AutoTestRunner>()._dir = dir;
        }

        IEnumerator Start()
        {
            Directory.CreateDirectory(_dir);
            Log("play mode running");
            var client = GetComponent<ZorkClient>();
            var builder = GetComponent<WorldBuilder>();
            var t0 = Time.realtimeSinceStartup;
            while (client.World == null && Time.realtimeSinceStartup - t0 < 20f) yield return null;
            Log($"connected={client.Connected} error={client.LastError} rooms={(client.World?.rooms?.Length ?? -1)} current={client.World?.current}");

            yield return new WaitForSecondsRealtime(6f);   // let rooms glide into place
            yield return Shot("follow");

            var rig = FindAnyObjectByType<CameraRig>();
            if (rig != null) { rig.distance = 120f; rig.pitch = 62f; }
            yield return new WaitForSecondsRealtime(3f);
            yield return Shot("wide");

            var frogInfo = FindAnyObjectByType<FrogPlayer>();
            Log("frog: " + (frogInfo != null ? frogInfo.Info : "none") + (frogInfo != null ? $" pos={frogInfo.transform.position} modelScale={(frogInfo.transform.childCount > 0 ? frogInfo.transform.GetChild(0).lossyScale.ToString() : "-")}" : ""));
            // Close-up of the frog.
            if (rig != null) { rig.distance = 16f; rig.pitch = 35f; }
            yield return new WaitForSecondsRealtime(3f);
            yield return Shot("frog");

            // Send the autopilot to a reachable room and check the frog gets there.
            if (rig != null) { rig.distance = 34f; rig.pitch = 50f; }
            var before = client.World?.current;
            string target = null;
            foreach (var r in client.World.rooms) if (r.reach >= 2) { target = r.id; break; }
            if (target != null)
            {
                client.Travel(target);
                var t1 = Time.realtimeSinceStartup;
                while (Time.realtimeSinceStartup - t1 < 20f && client.World?.current != target) yield return null;
                yield return new WaitForSecondsRealtime(2f);
                Log($"travel {before} -> {target}: now at {client.World?.current}, status={client.World?.travelStatus} msg={client.World?.travelMessage}");
            }
            else Log("no reachable room to travel to");
            yield return Shot("travelled");

            Log($"builder children={builder.transform.childCount}");
#if UNITY_EDITOR
            UnityEditor.EditorApplication.Exit(0);
#else
            Application.Quit();
#endif
        }

        IEnumerator Shot(string name)
        {
            yield return new WaitForEndOfFrame();
            // Game view including the HUD
            var tex = ScreenCapture.CaptureScreenshotAsTexture();
            File.WriteAllBytes(Path.Combine(_dir, name + "_screen.png"), tex.EncodeToPNG());
            Destroy(tex);
            // Fixed-size render of the 3D scene only
            var cam = Camera.main;
            const int w = 1600, h = 900;
            var rt = new RenderTexture(w, h, 24);
            cam.targetTexture = rt;
            cam.Render();
            RenderTexture.active = rt;
            var img = new Texture2D(w, h, TextureFormat.RGB24, false);
            img.ReadPixels(new Rect(0, 0, w, h), 0, 0);
            img.Apply();
            cam.targetTexture = null;
            RenderTexture.active = null;
            File.WriteAllBytes(Path.Combine(_dir, name + ".png"), img.EncodeToPNG());
            Destroy(img);
            rt.Release();
            Log("saved " + name);
        }

        void Log(string msg)
        {
            Debug.Log("[ZorkAutoTest] " + msg);
            File.AppendAllText(Path.Combine(_dir, "autotest.log"), DateTime.Now.ToString("HH:mm:ss ") + msg + "\n");
        }
    }
}
