# Devlog

A running record of what was built, why, and what broke along the way. Newest entries at the bottom of each day.

## 2026-10-23

### Goal

Play Zork I with a helper that builds the map as you go: a 2D map, an inventory, and a 3D world in Unity, so that by the end you have a 3D model of the Great Underground Empire.

### Getting the game running

- Zork I's source and compiled story file were released under the MIT license by Microsoft in 2025 (`historicalsource/zork1`). `game/zork1.z3` is Release 119 / Serial 880429.
- Interpreter: `dfrotz`, the text-only Frotz. Flags: `-m` (no MORE prompts), `-w 250` (wide lines, so descriptions rarely wrap), `-s 42` (fixed random seed).
- **Key finding:** dfrotz prints the status line (`Room name … Score: N Moves: N`) on every turn. That gives the current room name for free, with no guessing from prose. The whole mapper is built on it.

### Mapper design

- **Rules first, LLM second.** Moves, exits, items and inventory are parsed with rules (`server/parser.py`), which are free, instant and predictable. An LLM pass is optional and only adds what rules can't: what a place looks like (forest/cave/river…), lighting, scenery, colors. It runs in the background, so play never waits on it.
- **LLM call:** Claude API with structured JSON output (a JSON schema in `server/llm.py`), low effort, server-side fallback on refusal. Errors are logged and skipped, never shown in the game.
- **Room identity** is the hard part. Zork reuses names ("Forest", "Maze"), and maze rooms share descriptions. The order of checks is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- **Layout:** a spring simulation rather than a strict grid, because Zork's directions aren't consistent. Up/down are separate integer levels.
- **Saves:** store the command log and replay it on restart, with a fixed seed. Simpler than Z-machine save files, and it survives server restarts and redeploys.

### Web UI

- Terminal, SVG 2D map with levels, room panel (click exits to walk, click items to take), inventory. Live updates over a WebSocket.

### Unity viewer

- Unity 6 (6000.0.37f1), Built-in render pipeline, primitives only (no imported assets), IMGUI HUD so there are no package dependencies.
- `Bootstrap.cs` sets everything up on Play, so the project has no scene to maintain.
- Polls `/api/unity?since=<version>`, a flat array-only JSON shape, because `JsonUtility` can't read dictionaries.
- **Couldn't create the project in batch mode:** the license client couldn't start from a headless shell. Worked around it by writing `Packages/manifest.json` and `ProjectVersion.txt` by hand and letting the editor generate the rest on first open. Scripts were compile-checked with the editor's bundled Roslyn against the Unity DLLs.

### Playtest 1 (scripted, 38 moves: house → cellar → troll → maze → Cyclops Room)

Bugs found and fixed:

- **Room headings merged into descriptions.** dfrotz hard-wraps lines, and the unwrap logic glued "Kitchen" onto the next line, so items were never found. Fix: wide output (`-w 250`), and only join a line onto the previous one when the previous line was nearly full.
- **Container contents in inventory.** "The glass bottle contains:" appeared as an item. Fix: skip lines ending in `:` and deeper-indented lines.
- **Maze rooms collapsed.** Moving "Maze" → "Maze" reused the same room, so 7 moves made 5 rooms with broken links. Fix: moving between same-named rooms means a new room unless an exit or matching items prove otherwise.
- **False exits and missed walls.** "west of a white house" became a west exit; "The east wall is solid rock." wasn't counted as a failed move. Fix: skip direction words followed by "of/side/wall/end"; add more failure phrases.
- **Thief.** When the thief steals something, the parser can't know what was taken. Fix: flag the inventory as possibly stale and prompt the player to type `i` (not sent automatically, because it uses a game turn).
- Inventory items keep notes like "(providing light)". Stripped.

### Unity test

- First real editor run failed on an invalid package (`com.unity.modules.textrendering` isn't a Unity 6 module) and was missing `screencapture` / `imageconversion`. Lesson: the local compile check referenced every engine module, so it didn't catch project-level module gaps. It now compiles against only the modules in the manifest.
- An editor-only autotest stalled after entering Play mode, because editor update callbacks stop running reliably there. Moved the test into a runtime component (`AutoTestRunner`), enabled only by the `ZORK_AUTOTEST` env var.
- Result: connects, builds all 17 rooms, sends `nw` from inside Unity, and the player moves to the correct maze room. Labels were too small and the HUD covered most of a small game view; both fixed.

### Hosting and the browser 3D view

- **Goal:** play from anywhere in a browser, with 3D, no Unity required.
- **Host: Fly.io.** One always-on machine with a volume. The game is a live process with in-memory state, which suits a small VM better than a stateless platform. Docker image builds `dfrotz` 2.54 from source (Debian's package doesn't reliably include it).
- **Access:** one shared game behind `ZORK_PASSWORD`. Browsers use an HMAC cookie; Unity sends an `X-Zork-Password` header. WebSockets check the cookie too. Failed logins are delayed by 1s.
- **Faster restore:** replay used to wait 150 ms of silence per command (~2.5 min for a 1,000-move game). Replay mode now stops at the `>` prompt and accepts only the real prompt, so a stray `:` or `)` at a chunk boundary can't end a read early. 40 commands: 6s → 1.1s.
- **Browser 3D:** `web/world3d.js` ports the Unity builder to three.js (bundled in `web/vendor/`, no CDN). Same scale, themes, walls with doorways, ramps, stubs, item markers, labels. One light follows the player instead of a light per room, so shaders stay cheap with 100+ rooms. Toggle 2D/3D on the map; the choice is remembered.
- **Unity:** a **Server…** panel to set the URL and password, saved in PlayerPrefs. Tested against a password-protected server.

### Open items

- Deploy to Fly.io (config is ready; needs `fly auth login`).
- Player character: replace the capsule with an animated frog.
- Claude parsing hasn't been run against the live API yet (no key configured during development).
- Possible: Z-machine save files instead of replay for very long games.
