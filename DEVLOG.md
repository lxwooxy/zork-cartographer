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
- **Host: Fly.io.** One always-on machine with a volume. The game is a live process with in-memory state, which suits a small VM better than a stateless platform. Docker image builds `dfrotz` from source (Debian's package doesn't reliably include it). Originally 2.54; see the deploy notes below for why it's 2.55 now.
- **Access:** one shared game behind `ZORK_PASSWORD`. Browsers use an HMAC cookie; Unity sends an `X-Zork-Password` header. WebSockets check the cookie too. Failed logins are delayed by 1s.
- **Faster restore:** replay used to wait 150 ms of silence per command (~2.5 min for a 1,000-move game). Replay mode now stops at the `>` prompt and accepts only the real prompt, so a stray `:` or `)` at a chunk boundary can't end a read early. 40 commands: 6s → 1.1s.
- **Browser 3D:** `web/world3d.js` ports the Unity builder to three.js (bundled in `web/vendor/`, no CDN). Same scale, themes, walls with doorways, ramps, stubs, item markers, labels. One light follows the player instead of a light per room, so shaders stay cheap with 100+ rooms. Toggle 2D/3D on the map; the choice is remembered.
- **Unity:** a **Server…** panel to set the URL and password, saved in PlayerPrefs. Tested against a password-protected server.

### Click-to-travel, glowing rooms, "you are here"

- **Goal:** click anywhere on the map and have the program work out "north, west, north" and walk it, handling trouble along the way.
- **Route planning** on the server (Dijkstra), so the browser and Unity agree. Walked exits are preferred over guessed ones. Each exit remembers the command that actually crossed it (`climb tree`, not `up`).
- **Rulebook** (`server/autopilot.py`): death / darkness / troll / cyclops / combat / questions stop; the thief makes it keep moving (leaving is the tactic, even mid-attack); blocked moves re-plan.
- **Bug found while testing:** the guessed reverse of a move is often wrong in Zork (North of House → `south` is "The windows are all boarded."). The first version only recognised failures by phrase, missed this one, and re-planned the same route six times. Then adding "boarded" made it think *successful* moves had failed, because room descriptions mention boarded windows. **Fix:** decide success by where we ended up (same room = blocked, mark and re-plan), never by phrases.
- **Arriving counts:** reaching the Cyclops Room stopped the trip because the cyclops rule fired; arrival now wins over warnings (except death).
- **UI:** reachable rooms glow (bright green: one move; soft green: reachable; dashed amber: only via guessed exits), the previewed or active route glows blue, and a pulsing ring plus "YOU ARE HERE" marks the player. Click previews, double-click goes. A banner shows progress and why it stopped.

### Save / load and smarter retries

- **Ask:** let the autopilot save and reload, e.g. go back and try again if the thief steals the key.
- **Why real saves:** rewinding the command log replays the same dice, so the thief would steal the same thing again. Zork's own `SAVE` / `RESTORE` resets the game but not the interpreter's random numbers, so a retry can go differently. Each retry also waits a turn first to shift things further.
- dfrotz truncates long save paths (only part of the name was kept), so it now runs inside the saves folder with short names (`c1.qzl`). Saves are about 0.5 KB.
- **Checkpoints** store a snapshot of position, inventory, score and room items; loading rewinds those but keeps the explored map.
- Saves and loads are entries in the command log, so startup replay reproduces them exactly.
- **Autopilot:** checkpoint before every trip; on death or theft, load it and retry (3 attempts); when stuck, suggest the newest save from which the destination is reachable. Tested: the trap-door case (cellar → kitchen, stuck → suggested living-room save → arrived) and a simulated theft (save → move → theft → restore → wait → arrive on attempt 2).

### The frog

- Searched for a free rigged frog. Picked **Frog by Quaternius** (CC0, via Poly Pizza): 28 bones; Idle, Jump, Attack, Death. Also considered his upright yellow frog character (14 animations, including Walk, Wave, Punch); it would be easy to swap in.
- Web: glTF + `AnimationMixer`. Hops between rooms with an arc, turns to face where it's going, attacks on `kill …`, plays Death when you die.
- Unity: the same model as FBX, imported with Legacy animations by an `AssetPostprocessor`.
- **Gotcha:** it rendered as an invisible speck in both engines. The rig's armature is scaled 100× (FBX export), so mesh bounds are ~100× too big and auto-fit shrank it to nothing. Fix: size it by bone positions (Unity) or a fixed scale (web), and disable culling. Bone box is 2.64 × 1.78 × 5.44 in both engines.
- Added a floating marker above the frog so "you are here" is visible when zoomed out.

### The canonical map and fog of war

- **Idea:** the "correct" map is knowable, so generate it once, perfect it, and reveal it as you play, instead of guessing from text.
- **Source:** `1dungeon.zil` from Microsoft's MIT release of Zork I. `tools/build_map.py` is a small reader for the ZIL forms used by rooms: `(DIR TO ROOM)`, `(DIR TO ROOM IF FLAG ELSE "msg")`, `(DIR "message")`, `(DIR PER ROUTINE)`. Result: 110 rooms, 352 exits, 16 kinds of condition. The 7 code-driven exits got their targets from the routines and the `;"to MAZE-5"` comments in the source.
- **Parser slip caught by its own warnings:** `(IN ROOMS)` means "this object is a room", not an IN exit.
- **Layout, three tries:**
  1. "+1 for up, −1 for down" from West of House put the maze and the river on the surface, because up/down inside the maze is just more maze.
  2. Grouping rooms into areas joined by sideways exits merged nearly everything, because the surface canyon connects sideways to the falls, the river, and the dam.
  3. **Hand-curated levels** in `game/zork1-regions.json` (surface, treetops/attic, main underground, deep areas, mine shaft), then a spring layout per level seeded by walking compass directions. Readable, and editable.
- **Tracking** now follows real exits. A replay of the earlier test route produced **zero anomalies**, and all 7 maze rooms resolved to their true IDs. The autopilot routed back through the maze in 8 moves; the old mapper couldn't, because it didn't know the maze's one-way passages.
- **Spoilers:** undiscovered destinations are blanked in `/api/world` unless Reveal is on, and never sent to Unity. Checked by scanning the API output.
- Old saves keep working in heuristic mode (`mode` is stored in the save).

### Deployed to Fly.io

- App `zork-cartographer-lxwooxy` in `ewr`: one shared-cpu machine (512 MB), a 1 GB volume with daily snapshots, password in a Fly secret.
- **Bug found on first deploy:** rooms weren't tracked at all (`room: ""`). The Docker image had built **Frotz 2.54**, whose dumb interface **doesn't print the status line**; the Mac had Homebrew's 2.55, which does. Everything depends on that line. Fixes: build 2.55, and the server now logs a clear error at startup if the interpreter prints no status line.
- Checked live: login redirect and 401s without the password, wrong password rejected, WebSocket refused without the cookie and working with it, three.js and the frog served, canonical tracking with zero anomalies, an autopilot trip arrived. Then reset to a fresh game.

### One house, one forest: landmarks

- **Ask:** North/South/West of House and Behind House are the same house, so draw it once; same for other places.
- **Layout first:** the automatic layout had put the Living Room west of West of House and the Attic in the yard, so no building could contain them. Hand-placed the house area in `zork1-layout-overrides.json`: four yards around the house, the Living Room and Kitchen side by side inside it, the Attic above the Kitchen, the Cellar below the Living Room, and Up a Tree above the Forest Path. The layout tool now keeps pinned rooms fixed and arranges the rest around them. (Found along the way: its compass-walk seeding never ran, because every room had already been given a random spot.)
- **Landmarks file:** house, forest (with the big tree), Frigid River, rainbow, reservoir, with a role per room.
- **3D (web and Unity):** rooms render by role, and each place is built once across its rooms (details in ARCHITECTURE.md). The house goes see-through with the roof off while you're inside, and also when it's between the camera and you. Without that, standing at North of House the camera just saw a wall.
- **Spoilers:** visible-from-outside places send undiscovered parts as bare positions; the server scrubs room names.
- **Unity gotcha:** built-in `TextMesh` labels draw on top of everything, so the Kitchen label showed through the roof. Labels of rooms inside the house are now hidden while it's solid.

- Deployed to Fly.io. The live game in progress (by then in the Cellar, with the river and reservoir found) picked up the new layout on restart: room positions are refreshed from the layout when a save loads. Still zero anomalies.

### Room details, written once

- **Ask:** use the API key to add detail once, and show it when a room is revealed.
- `tools/describe_rooms.py` describes all 110 canonical rooms ahead of time; the server applies each room's details on discovery. There are no per-turn calls and no key on the server.
- 40 rooms keep their description in code (`ACTION` routines) rather than `LDESC`. The map now records each routine's name, and the prompt includes that routine's text from `game/source/1actions.zil`, so descriptions stay faithful to the game. (The Zork source files now live in `game/source/`, so the map can be rebuilt without downloading anything.)
- Impossible exits (`FALSE-FLAG`, e.g. Santa's chimney) are given to Claude as messages, not exits.
- UI: the description appears in italics in the room panel (web and Unity), and the header badge reads "Room details ✓".
- Tested with a temporary two-room file: details appear on discovery and nowhere else.
- **Ran it:** all 110 rooms in about 90 seconds (`claude-opus-5-5`, medium effort). A two-room trial first showed exits ("west passage") creeping into features; the prompt now excludes them and the tool filters passage-like entries (502 → 488 features). Spot-checks are faithful to the game (Dam: bolted control panel and green bubble; Temple: ancient inscription; Aragain Falls: solid rainbow).
- **Bug:** the game-start path still called Claude once when a key was present (the per-turn check didn't cover it). Fixed, and verified: 10 commands, zero API calls.
- A headless-browser hang during testing turned out to be a stuck screenshot process (macOS has no `timeout`, so a time limit silently didn't apply), not the page.

### Open items

- Claude parsing hasn't been run against the live API yet (no key configured during development).
- Autopilot could explore unknown exits on its own (currently it only uses known ones).
- Map editor in the browser (drag rooms, change levels) writing `zork1-layout-overrides.json`.
- Unity: show undiscovered rooms when Reveal is on.
- More landmarks: the temple, coal mine, maze and dam are still drawn room by room.
- Unity: yard labels can show through the house roof from some angles (TextMesh ignores depth).
- Unity: click-to-preview routes (it has double-click travel, glow and the status bar).
