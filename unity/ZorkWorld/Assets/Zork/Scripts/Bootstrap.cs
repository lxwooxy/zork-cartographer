using UnityEngine;

namespace Zork
{
    /// Press Play in any scene and the Zork viewer sets itself up:
    /// client + world builder + HUD + camera + lighting.
    public static class Bootstrap
    {
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void Init()
        {
            if (Object.FindAnyObjectByType<ZorkClient>() != null) return; // already in the scene

            var root = new GameObject("Zork");
            root.AddComponent<ZorkClient>();
            var builder = root.AddComponent<WorldBuilder>();
            root.AddComponent<GameHUD>();
            AutoTestRunner.AttachIfRequested(root);

            var cam = Camera.main;
            if (cam == null)
            {
                cam = new GameObject("Main Camera").AddComponent<Camera>();
                cam.tag = "MainCamera";
            }
            cam.clearFlags = CameraClearFlags.SolidColor;
            cam.backgroundColor = new Color(0.04f, 0.05f, 0.06f);
            cam.farClipPlane = 3000f;
            var rig = cam.gameObject.GetComponent<CameraRig>();
            if (rig == null) rig = cam.gameObject.AddComponent<CameraRig>();
            rig.builder = builder;

            RenderSettings.ambientMode = UnityEngine.Rendering.AmbientMode.Flat;
            RenderSettings.ambientLight = new Color(0.32f, 0.34f, 0.36f);
            RenderSettings.fog = true;
            RenderSettings.fogColor = cam.backgroundColor;
            RenderSettings.fogMode = FogMode.Linear;
            RenderSettings.fogStartDistance = 120f;
            RenderSettings.fogEndDistance = 600f;

            Light sun = null;
            foreach (var l in Object.FindObjectsByType<Light>(FindObjectsSortMode.None))
                if (l.type == LightType.Directional) { sun = l; break; }
            if (sun == null)
            {
                sun = new GameObject("Sun").AddComponent<Light>();
                sun.type = LightType.Directional;
            }
            sun.transform.rotation = Quaternion.Euler(55f, -30f, 0f);
            sun.intensity = 0.55f;
            sun.shadows = LightShadows.Soft;
        }
    }
}
