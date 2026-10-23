using System.Collections.Generic;
using UnityEngine;

namespace Zork
{
    /// Material and primitive helpers. Works in the Built-in pipeline and in URP.
    public static class Mat
    {
        static Shader _lit;
        static readonly Dictionary<string, Material> Cache = new Dictionary<string, Material>();

        static Shader Lit
        {
            get
            {
                if (_lit == null) _lit = Shader.Find("Universal Render Pipeline/Lit");
                if (_lit == null) _lit = Shader.Find("Standard");
                if (_lit == null) _lit = Shader.Find("Diffuse");
                return _lit;
            }
        }

        public static Material Color(Color c, float emission = 0f, float smooth = 0.15f)
        {
            var key = $"{ColorUtility.ToHtmlStringRGB(c)}|{emission}|{smooth}";
            if (Cache.TryGetValue(key, out var m) && m != null) return m;
            m = new Material(Lit) { color = c };
            if (m.HasProperty("_BaseColor")) m.SetColor("_BaseColor", c);
            if (m.HasProperty("_Glossiness")) m.SetFloat("_Glossiness", smooth);
            if (m.HasProperty("_Smoothness")) m.SetFloat("_Smoothness", smooth);
            if (emission > 0f)
            {
                m.EnableKeyword("_EMISSION");
                m.SetColor("_EmissionColor", c * emission);
            }
            Cache[key] = m;
            return m;
        }

        public static GameObject Primitive(PrimitiveType type, string name, Transform parent, Material m)
        {
            var go = GameObject.CreatePrimitive(type);
            go.name = name;
            go.transform.SetParent(parent, false);
            go.GetComponent<Renderer>().sharedMaterial = m;
            return go;
        }

        public static Color Parse(string hex, Color fallback)
        {
            if (!string.IsNullOrEmpty(hex) && ColorUtility.TryParseHtmlString(hex, out var c)) return c;
            return fallback;
        }
    }

    /// Floating text that always faces the camera.
    public class Label : MonoBehaviour
    {
        static Font _font;

        public static TextMesh Create(Transform parent, string text, Vector3 localPos, float size, Color color)
        {
            if (_font == null) _font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
            var go = new GameObject("Label: " + text);
            go.transform.SetParent(parent, false);
            go.transform.localPosition = localPos;
            var tm = go.AddComponent<TextMesh>();
            tm.text = text;
            tm.font = _font;
            tm.fontSize = 64;
            tm.characterSize = size * 0.15f;
            tm.anchor = TextAnchor.MiddleCenter;
            tm.alignment = TextAlignment.Center;
            tm.color = color;
            go.GetComponent<MeshRenderer>().sharedMaterial = _font.material;
            go.AddComponent<Label>();
            return tm;
        }

        void LateUpdate()
        {
            var cam = Camera.main;
            if (cam == null) return;
            transform.rotation = Quaternion.LookRotation(transform.position - cam.transform.position);
        }
    }
}
