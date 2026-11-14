#!/usr/bin/env python3
"""Build the static, serverless browser version into a folder you can host anywhere
(GitHub Pages, any static file server). All paths in it are relative.

    python3 tools/build_static.py            # -> dist/browser/
    python3 tools/build_static.py OUT_DIR

Try it locally:  python3 -m http.server -d dist/browser 8000   (then open http://localhost:8000)
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
GAME = ROOT / "game"

# (source, destination inside the build)
FILES = [
    (WEB / "index-static.html", "index.html"),
    (WEB / "app.js", "app.js"),
    (WEB / "world3d.js", "world3d.js"),
    (WEB / "style.css", "style.css"),
    (WEB / "vendor" / "three.module.min.js", "vendor/three.module.min.js"),
    (WEB / "vendor" / "OrbitControls.js", "vendor/OrbitControls.js"),
    (WEB / "vendor" / "loaders" / "GLTFLoader.js", "vendor/loaders/GLTFLoader.js"),
    (WEB / "vendor" / "utils" / "BufferGeometryUtils.js", "vendor/utils/BufferGeometryUtils.js"),
    (WEB / "vendor" / "jszm" / "jszm.js", "vendor/jszm/jszm.js"),
    (WEB / "models" / "frog.glb", "models/frog.glb"),
    (WEB / "models" / "CREDITS.md", "models/CREDITS.md"),
    (GAME / "zork1.z3", "game/zork1.z3"),
    (GAME / "LICENSE-zork1", "game/LICENSE-zork1.txt"),   # .txt so browsers show it instead of downloading
    (ROOT / "THIRD_PARTY.md", "THIRD_PARTY.txt"),        # plain text: static hosts serve .md inconsistently
]
ENGINE = sorted((WEB / "engine").glob("*.js"))
# Game data, written compact (no indentation) to keep the download small.
DATA = ["zork1-map.json", "zork1-layout.json", "zork1-landmarks.json", "zork1-details.json"]


def main(out: Path):
    out = out.resolve()
    if out == ROOT or ROOT.is_relative_to(out):
        sys.exit(f"Refusing to build into {out}")
    if out.exists():
        if not (out / "index.html").exists() or not (out / "engine").exists():
            sys.exit(f"{out} exists and doesn't look like a previous build; pick an empty folder")
        shutil.rmtree(out)
    for src, dst in FILES + [(p, f"engine/{p.name}") for p in ENGINE]:
        target = out / dst
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, target)
    for name in DATA:
        data = json.loads((GAME / name).read_text())
        (out / "game" / name).write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False))
    size = sum(p.stat().st_size for p in out.rglob("*") if p.is_file())
    print(f"Built {out} ({size / 1e6:.2f} MB, {sum(1 for p in out.rglob('*') if p.is_file())} files)")


if __name__ == "__main__":
    main(Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "dist" / "browser")
