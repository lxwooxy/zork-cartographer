using UnityEditor;

namespace Zork.EditorTools
{
    /// Imports Resources/Frog.fbx with Legacy animations, so the runtime code can play
    /// clips by name with the Animation component (no Animator Controller to maintain).
    class FrogImportSettings : AssetPostprocessor
    {
        void OnPreprocessModel()
        {
            if (!assetPath.EndsWith("Zork/Resources/Frog.fbx")) return;
            var mi = (ModelImporter)assetImporter;
            mi.animationType = ModelImporterAnimationType.Legacy;
            mi.importAnimation = true;
            mi.generateAnimations = ModelImporterGenerateAnimations.GenerateAnimations;
            mi.materialImportMode = ModelImporterMaterialImportMode.ImportStandard;
        }
    }
}
