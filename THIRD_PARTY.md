# Third-party software and content

| What | Where | License | Source |
|---|---|---|---|
| Zork I story file (Release 119 / Serial 880429) and source | `game/zork1.z3`, `game/source/` | MIT, © 2025 Microsoft (see `game/LICENSE-zork1`) | <https://github.com/historicalsource/zork1> |
| JSZM 2.0.3, Z-machine interpreter (browser version) | `web/vendor/jszm/jszm.js` | Public domain (stated in the file's header) | <https://github.com/DLehenbauer/jszm> (commit `1c953fd`), a snapshot of zzo38's JSZM 2.0.2 |
| three.js r160, OrbitControls, GLTFLoader, BufferGeometryUtils | `web/vendor/` | MIT, © 2010-2023 three.js authors | <https://threejs.org> |
| Red-eyed tree frog model | `web/models/frog.glb` | CC0 1.0 | Quaternius, see `web/models/CREDITS.md` |
| Frotz (`dfrotz`, server version only; not bundled) | installed separately | GPL-2.0-or-later | <https://gitlab.com/DavidGriffith/frotz> |

## Local changes to JSZM

One line in the `RANDOM` opcode: the random number is scaled with `/ 0x100000000` instead of `/ 0xFFFFFFFF`, so it can never return `range + 1`. The change is marked in the file with a `[zork-cartographer: ...]` comment. Everything else is as published.
