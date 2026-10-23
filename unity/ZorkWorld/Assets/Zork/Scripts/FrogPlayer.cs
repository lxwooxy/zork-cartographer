using UnityEngine;

namespace Zork
{
    /// The player character: a red-eyed tree frog (Quaternius, CC0) loaded from
    /// Resources/Frog.fbx, imported with Legacy animations (Editor/FrogImportSettings.cs).
    /// Hops between rooms, idles when still, attacks and dies when the game says so.
    /// Falls back to a glowing capsule if the model is missing.
    public class FrogPlayer : MonoBehaviour
    {
        public float length = 2.6f;   // frog size in world units (rooms are 8)

        Vector3 _target;
        Vector3 _hopFrom;
        bool _hasTarget;
        Animation _anim;
        string _idle, _jump, _attack, _death;
        float _busyUntil;
        Transform _model, _ring, _pin;

        /// What was loaded, for logs and the smoke test.
        public string Info { get; private set; } = "no frog model";

        void Awake()
        {
            var prefab = Resources.Load<GameObject>("Frog");
            if (prefab != null)
            {
                var go = Instantiate(prefab, transform);
                go.name = "Frog";
                _model = go.transform;
                FitToSize(go);
                _anim = go.GetComponentInChildren<Animation>();
                if (_anim != null)
                {
                    foreach (AnimationState st in _anim)
                    {
                        if (st.name.Contains("Idle")) _idle = st.name;
                        else if (st.name.Contains("Jump")) _jump = st.name;
                        else if (st.name.Contains("Attack")) _attack = st.name;
                        else if (st.name.Contains("Death")) _death = st.name;
                    }
                    Loop(_idle); Loop(_jump);
                    if (_death != null) _anim[_death].wrapMode = WrapMode.ClampForever;
                    Play(_idle);
                }
                Info += $" clips=[{_idle},{_jump},{_attack},{_death}] anim={(_anim != null)}";
            }
            else
            {
                var cap = Mat.Primitive(PrimitiveType.Capsule, "Player (no frog model)", transform, Mat.Color(new Color(0.5f, 1f, 0.65f), emission: 1.5f));
                cap.transform.localPosition = Vector3.up;
                Destroy(cap.GetComponent<Collider>());
            }

            var lamp = new GameObject("Lamp").AddComponent<Light>();
            lamp.transform.SetParent(transform, false);
            lamp.transform.localPosition = new Vector3(0, 4.5f, 0);
            lamp.type = LightType.Point;
            lamp.range = 14f;
            lamp.intensity = 1.6f;
            lamp.color = new Color(1f, 0.9f, 0.75f);

            // "You are here": a glowing disc on the floor and a marker floating above.
            var ring = Mat.Primitive(PrimitiveType.Cylinder, "Here ring", null, Mat.Color(new Color(0.3f, 0.9f, 0.55f), emission: 1.2f));
            ring.transform.localScale = new Vector3(3.6f, 0.01f, 3.6f);
            Destroy(ring.GetComponent<Collider>());
            _ring = ring.transform;
            var pin = Mat.Primitive(PrimitiveType.Cube, "Here marker", null, Mat.Color(new Color(0.5f, 1f, 0.65f), emission: 1.6f));
            pin.transform.localScale = Vector3.one * 0.6f;
            Destroy(pin.GetComponent<Collider>());
            _pin = pin.transform;
        }

        void FitToSize(GameObject go)
        {
            // Renderer bounds are useless here: the rig's armature is scaled 100x (FBX export),
            // so a skinned mesh reports a box ~100x too big. The bones' positions give the
            // real pose. The bone box runs from the back feet to past the nose, so the body
            // itself is a bit over half of its length.
            var smr = go.GetComponentInChildren<SkinnedMeshRenderer>();
            if (smr == null || smr.bones == null || smr.bones.Length == 0) return;
            var b = new Bounds(smr.bones[0].position, Vector3.zero);
            foreach (var bone in smr.bones) if (bone != null) b.Encapsulate(bone.position);
            var longest = Mathf.Max(b.size.x, b.size.z) * 0.55f;
            Info = $"bones={smr.bones.Length} boneBox={b.size}";
            if (longest > 0.0001f) go.transform.localScale *= length / longest;
            // Feet on the floor
            b = new Bounds(smr.bones[0].position, Vector3.zero);
            foreach (var bone in smr.bones) if (bone != null) b.Encapsulate(bone.position);
            go.transform.position += Vector3.up * (transform.position.y - b.min.y);
            smr.updateWhenOffscreen = true;   // skinned bounds are wrong, so never cull it
        }

        void Loop(string clip) { if (clip != null) _anim[clip].wrapMode = WrapMode.Loop; }

        void Play(string clip, bool once = false)
        {
            if (_anim == null || clip == null) return;
            if (!once && _anim.IsPlaying(clip)) return;
            _anim.CrossFade(clip, 0.2f);
        }

        public void SetTarget(Vector3 pos)
        {
            if (!_hasTarget) { transform.position = pos; _hasTarget = true; }
            else if ((pos - _target).sqrMagnitude > 0.01f) _hopFrom = transform.position;
            _target = pos;
        }

        /// Called with each new turn so the frog can react.
        public void OnTurn(string command, string text)
        {
            var c = (command ?? "").ToLowerInvariant();
            if ((text ?? "").ToLowerInvariant().Contains("you have died")) { Play(_death, true); _busyUntil = Time.time + 4f; }
            else if (c.StartsWith("kill") || c.StartsWith("attack") || c.StartsWith("fight") || c.StartsWith("hit"))
            { Play(_attack, true); _busyUntil = Time.time + 1.2f; }
        }

        void Update()
        {
            if (!_hasTarget) return;
            var flat = new Vector3(_target.x - transform.position.x, 0, _target.z - transform.position.z);
            var dist = flat.magnitude;
            var hopping = dist > 0.15f || Mathf.Abs(_target.y - transform.position.y) > 0.3f;
            if (hopping)
            {
                if (dist > 0.01f)
                {
                    var step = Mathf.Min(dist, Time.deltaTime * 14f);
                    var p = transform.position + flat.normalized * step;
                    var look = Quaternion.LookRotation(flat.normalized, Vector3.up);
                    transform.rotation = Quaternion.Slerp(transform.rotation, look, Time.deltaTime * 10f);
                    var total = Mathf.Max(0.01f, new Vector3(_target.x - _hopFrom.x, 0, _target.z - _hopFrom.z).magnitude);
                    var progress = 1f - Mathf.Clamp01((dist - step) / total);
                    p.y = Mathf.Lerp(_hopFrom.y, _target.y, progress) + Mathf.Abs(Mathf.Sin(Time.time * 9f)) * 0.9f;
                    transform.position = p;
                }
                else transform.position = Vector3.MoveTowards(transform.position, _target, Time.deltaTime * 10f);
                if (Time.time > _busyUntil) Play(_jump);
            }
            else
            {
                transform.position = _target;
                if (Time.time > _busyUntil) Play(_idle);
            }

            var pulse = 1f + 0.1f * Mathf.Sin(Time.time * 3f);
            _ring.position = new Vector3(transform.position.x, _target.y + 0.03f, transform.position.z);
            _ring.localScale = new Vector3(3.6f * pulse, 0.01f, 3.6f * pulse);
            _pin.position = transform.position + Vector3.up * (4.2f + 0.3f * Mathf.Sin(Time.time * 2.5f));
            _pin.rotation = Quaternion.Euler(45f, Time.time * 90f, 45f);
        }
    }
}
