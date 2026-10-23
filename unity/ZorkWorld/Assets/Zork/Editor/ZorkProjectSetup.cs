using UnityEditor;

namespace Zork.EditorTools
{
    /// The viewer talks to the local Python server over plain http://, which Unity
    /// blocks by default. Allow it for this project.
    [InitializeOnLoad]
    static class ZorkProjectSetup
    {
        static ZorkProjectSetup()
        {
            if (PlayerSettings.insecureHttpOption != InsecureHttpOption.AlwaysAllowed)
                PlayerSettings.insecureHttpOption = InsecureHttpOption.AlwaysAllowed;
        }
    }
}
