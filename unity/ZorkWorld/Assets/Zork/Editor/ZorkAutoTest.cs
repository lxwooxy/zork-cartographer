using System;
using UnityEditor;

namespace Zork.EditorTools
{
    /// Smoke test. Launch the editor with ZORK_AUTOTEST=/some/folder and it enters Play mode;
    /// AutoTestRunner (runtime) then saves screenshots there and quits the editor.
    /// Does nothing when the variable isn't set.
    [InitializeOnLoad]
    static class ZorkAutoTest
    {
        const string Key = "ZorkAutoTest.Started";

        static ZorkAutoTest()
        {
            if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("ZORK_AUTOTEST"))) return;
            EditorApplication.update += Tick;
        }

        static void Tick()
        {
            if (EditorApplication.isCompiling || EditorApplication.isUpdating) return;
            if (SessionState.GetBool(Key, false)) { EditorApplication.update -= Tick; return; }
            SessionState.SetBool(Key, true);
            EditorApplication.isPlaying = true;
        }
    }
}
