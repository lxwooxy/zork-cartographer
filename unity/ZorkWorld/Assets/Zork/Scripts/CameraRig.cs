using UnityEngine;

namespace Zork
{
    /// Orbit camera that follows the player.
    /// Right-drag (or Alt+left-drag): orbit. Scroll: zoom. Middle-drag or WASD: pan.
    /// F: follow the player again. Tab: toggle overview of the whole map.
    public class CameraRig : MonoBehaviour
    {
        public WorldBuilder builder;
        public float distance = 34f;
        public float yaw = 35f;
        public float pitch = 50f;

        Vector3 _focus;
        bool _follow = true;
        bool _overview;
        float _savedDistance;

        void Start() => _focus = Vector3.zero;

        void LateUpdate()
        {
            if (GUIUtility.keyboardControl != 0) { Apply(); return; } // typing in the HUD

            var orbit = Input.GetMouseButton(1) || (Input.GetMouseButton(0) && Input.GetKey(KeyCode.LeftAlt));
            if (orbit)
            {
                yaw += Input.GetAxis("Mouse X") * 4f;
                pitch = Mathf.Clamp(pitch - Input.GetAxis("Mouse Y") * 4f, 5f, 89f);
            }
            var scroll = Input.mouseScrollDelta.y;
            if (Mathf.Abs(scroll) > 0.01f) distance = Mathf.Clamp(distance * Mathf.Pow(0.9f, scroll), 6f, 600f);

            var rot = Quaternion.Euler(0, yaw, 0);
            var pan = Vector3.zero;
            if (Input.GetMouseButton(2))
                pan += rot * new Vector3(-Input.GetAxis("Mouse X"), 0, -Input.GetAxis("Mouse Y")) * distance * 0.03f;
            var k = new Vector3((Input.GetKey(KeyCode.D) ? 1 : 0) - (Input.GetKey(KeyCode.A) ? 1 : 0), 0,
                                (Input.GetKey(KeyCode.W) ? 1 : 0) - (Input.GetKey(KeyCode.S) ? 1 : 0));
            pan += rot * k * distance * Time.deltaTime;
            if (Input.GetKey(KeyCode.Q)) pan += Vector3.down * distance * Time.deltaTime * 0.5f;
            if (Input.GetKey(KeyCode.E)) pan += Vector3.up * distance * Time.deltaTime * 0.5f;
            if (pan.sqrMagnitude > 0) { _focus += pan; _follow = false; }

            if (Input.GetKeyDown(KeyCode.F)) _follow = true;
            if (Input.GetKeyDown(KeyCode.Tab)) ToggleOverview();

            if (_follow && builder != null && builder.Player != null)
                _focus = Vector3.Lerp(_focus, builder.CurrentRoomPosition, Time.deltaTime * 3f);
            Apply();
        }

        void Apply()
        {
            var rot = Quaternion.Euler(pitch, yaw, 0);
            transform.position = _focus - rot * Vector3.forward * distance;
            transform.rotation = rot;
        }

        void ToggleOverview()
        {
            _overview = !_overview;
            if (_overview)
            {
                _savedDistance = distance;
                var b = new Bounds(builder.CurrentRoomPosition, Vector3.one);
                foreach (Transform t in builder.transform) b.Encapsulate(t.position);
                _focus = b.center;
                _follow = false;
                distance = Mathf.Max(40f, b.extents.magnitude * 2.2f);
                pitch = 65f;
            }
            else
            {
                distance = _savedDistance;
                _follow = true;
                pitch = 50f;
            }
        }
    }
}
