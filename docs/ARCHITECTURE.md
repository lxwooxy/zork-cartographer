# Architecture

How a typed command becomes a room on the map, and where to change things.

## Flow of one turn

1. A client (browser or Unity) sends `POST /api/command {"command": "north"}`.
2. **`server/game.py`** writes the command to `dfrotz`'s stdin and reads until the `>` prompt. dfrotz prints a status line every turn (`West of House ... Score: 0 Moves: 3`); the room name, score and move count come from there, so the server always knows where the player is. The status line is stripped from the text shown to the player.
3. **`server/world.py`** (`World.apply_turn`) updates the map, using helpers in **`server/parser.py`**:
   - **Did we move?** Either the room name changed, or a direction command printed a room heading.
   - **Which room is it?** `_resolve_room` checks, in order:
     1. a known exit from the previous room in that direction;
     2. matching items lying in the room (how players tell maze rooms apart);
     3. a unique name;
     4. for shared names (Forest, Maze), a room already sitting where the move would put us.
     If none match, it creates a new room. Moving from "Maze" into "Maze" always means a different room unless an exit or items prove otherwise.
   - **Exits:** the move links the two rooms and adds a tentative reverse exit (`inferred`). Failed moves ("You can't go that way", "solid rock") mark the exit `blocked`. Directions mentioned in a description become unexplored stubs.
   - **Items:** taken from "There is a … here" lines when a room description prints. Inventory comes from `Taken.` / `Dropped.` / `take all` lines, and is replaced whenever the game prints a full `inventory` listing. Theft-like text sets `inventory_stale`.
   - **Layout:** see below.
4. The world is saved to `data/world.json` and broadcast over the WebSocket.
5. If the Claude API is on and the turn is worth it (new room, look, take, drop, inventory…), **`server/llm.py`** sends the command, the output and what's known so far to the API, using structured JSON output. The reply fills `environment`, `indoor`, `lighting`, `features`, `palette`, `visual` and exit notes, then a second broadcast goes out. This runs in the background, so play never waits on it.

## Layout

Zork's geography isn't Euclidean (east then west doesn't always return you), so grid positions would collide. `World.relax()` runs a small spring simulation whenever a room is added or a move happens:

- each exit pulls its two rooms toward their compass offset (1 unit; `in`/`out` only want distance 1);
- rooms on the same level push apart if closer than 0.9;
- a weak pull toward the previous positions keeps the map stable;
- the first room is pinned at (0, 0).

`z` is the level, an integer changed by `up`/`down`. Positions are floats; both 3D views animate rooms gliding to new spots.

## Two map modes

**Canonical (default for new games, Zork I).** `server/canon.py` loads `game/zork1-map.json` (generated from the game source by `tools/build_map.py`) and `game/zork1-layout.json`.

- **Tracking:** after a direction command, the predicted room is `canon.target(current, dir)`. If its name matches the status line, that's where you are. Otherwise the room is looked up by name (`canon.find`, preferring neighbours of where you were), and the disagreement is recorded in `World.anomalies`.
- **Discovery:** a room is added to `World.rooms` the first time you enter it (`_discover`), at its fixed layout position, with all its real exits. An exit's `to` is only filled in once its destination has been discovered; until then the destination sits in `hidden_to`, which `/api/world` blanks out unless `reveal` is on. `/api/unity` never sends it.
- **Conditions:** exits carry `cond` (e.g. `KITCHEN-WINDOW IS OPEN`) and a plain-English `note`. Routes treat conditional exits as possible but pricier. Exits that failed are avoided for the rest of the trip and cost more afterwards (they might work later, once the window is open). Exits with `FALSE-FLAG` (impossible) are dropped.
- **No guessing:** no reverse-link inference, no direction words from descriptions, no spring relaxation.
- **Reveal:** `POST /api/settings {"reveal": true}` adds every undiscovered room to `/api/world` with `undiscovered: true`.

**Heuristic (fallback).** For saves made before the canonical map existed, or with `ZORK_MAP=off`: the map is built from play, as described below. `World.mode` is stored in the save, so a game never switches modes halfway.

## Room details

`tools/describe_rooms.py` asks Claude once per canonical room (structured JSON output) and writes `game/zork1-details.json`. `Canon` loads it, and `World._apply_details` copies it onto a `Room` when the room is discovered (`_canon_room`), and onto already-discovered rooms when a save loads. With details present, `should_enrich` never calls Claude per turn. Fields map onto the existing `Room` fields (`environment`, `indoor`, `lighting`, `features`, `palette`, `visual`), so both 3D views and the panels use them without changes. Undiscovered rooms' details are never sent unless Reveal is on.

## Landmarks (places drawn as one thing)

`game/zork1-landmarks.json` groups rooms into places: `white-house` (house), `forest`, `frigid-river` (river), `rainbow`, `reservoir` (lake). Each room gets a role (`interior`, `upstairs`, `exterior`, `member`, `path`, `tree-base`, `tree-top`, `from`/`via`/`to`).

- **Server:** `Canon.landmarks_view(discovered, reveal)` sends only discovered parts. `always_visible` places (the house, the rainbow) appear whole once any part is found, but their undiscovered rooms are sent as positions without ids, so no names leak. Rooms carry `roles` (`/api/world`: dict; `/api/unity`: `"landmark:role"` strings).
- **Rooms render by role:** house yards are open grass with no per-room house; interior rooms keep walls; forest rooms are clearings (the trees belong to the forest); river rooms are water; Up a Tree is a platform in the branches.
- **Landmarks render once, across rooms:** the house shell is fitted around its interior rooms, tall enough for the attic, with a pitched roof, chimney, boarded door and kitchen window. Walls fade and the roof hides while you're inside or when the house blocks the camera's view of you. The forest floor and trees sit on a fixed grid (trees don't move as you explore) and avoid rooms, paths and the house. There's a big trunk from the Forest Path to Up a Tree, a water ribbon along the river path, six arcs for the rainbow, and discs for the lake.
- Web: `LANDMARK_BUILDERS` in `web/world3d.js`. Unity: `LandmarkBuilder.cs`.

## Click-to-travel (autopilot)

- **Planning:** `World.route(start, goal)` is Dijkstra over known, unblocked exits. Exits we've walked cost 1; exits only guessed from the reverse direction cost 1.5, so walked paths are preferred. Each step carries the command that actually worked (`Exit.via`, e.g. `climb tree`, `enter window`), not just the compass direction.
- **Reachability:** `World.reachable()` (all known exits) and `reachable(confirmed_only=True)` (walked exits only) drive the glowing tiles. Both come with `/api/world` as `reachable` / `confirmed` (room id → number of moves).
- **Walking** (`_travel_loop` in `app.py`): sends one step, then:
  1. checks the turn's text against `autopilot.RULES` (death, darkness, troll, cyclops, thief, theft, combat, question);
  2. on death or theft, `_retry()` loads the trip's checkpoint, waits `attempt - 1` turns to change the random outcome, re-plans and goes again (max 3 attempts);
  3. on a stop rule, stops (but arriving at the destination always counts as arrived);
  4. **whether a move worked is decided by where we ended up, not by phrases**: same room means the exit is marked blocked and the route re-planned; a different room than expected means the map is already corrected, so re-plan.
- **Stuck:** with no route, `suggest_checkpoint(goal)` looks for the newest checkpoint whose room has a known route to the goal. The UI offers to load it, then `POST /api/travel {to, from_checkpoint}`.
- Any manual command cancels a trip in progress.

## Checkpoints (save / load)

- **Saving** uses Zork's own `SAVE` (`Game.save`), writing Quetzal files (`c1.qzl`, `c2.qzl`, …) into `saves/` next to the world file. dfrotz runs with that folder as its working directory, because it truncates long save paths.
- **Snapshot:** `World.make_checkpoint` records the room id, inventory, score, moves and every room's items, because the map can't learn those from the save file.
- **Loading** runs `RESTORE`, then `World.restore_checkpoint` rewinds those fields. Rooms and exits learned since then are kept on purpose: you remember the map even if the game rewinds.
- **Why not just replay fewer commands?** Replay with a fixed seed repeats the same random outcomes, so the thief would steal the same key again. After a `RESTORE` the interpreter's random numbers keep going, so a retry can play out differently.
- **Log:** saves and loads go into the command log as `{"kind": "save"|"restore", "file": …}` entries. Startup replay performs them in order, so restarts stay exact. Pruned automatic checkpoints leave their files; replay rewrites them anyway.

## Restoring a game

`data/world.json` keeps every command, save and load. On startup, `app.py` starts a fresh dfrotz with the same seed and replays them in order (`Game.send(fast=True)` stops reading as soon as the `>` prompt appears; save/load entries call `Game.save` / `Game.restore`). Then it drains leftover output. The map itself is loaded from the file, not rebuilt.

## HTTP API

| Method & path | Body / query | Returns |
|---|---|---|
| `POST /api/command` | `{"command": "take lamp"}` | `{text, room, score, moves, changes}` |
| `GET /api/world` | | `{world, llm}`: full state for the web UI (last 200 log entries) |
| `GET /api/unity?since=N` | `since` = last version seen | flat, array-only state for Unity's `JsonUtility`, or `{unchanged: true}` |
| `POST /api/new-game` | | backs up the save, restarts |
| `POST /api/rooms/{id}/rename` | `{"name": "..."}` | rename a room on the map |
| `GET /api/route?to=ID` | | `{reachable, steps: [{dir, command, from, to, inferred}], suggest}` |
| `POST /api/travel` | `{"to": ID, "from_checkpoint": null, "retry": true}` | starts a trip; `409` with `suggest` if there's no route |
| `POST /api/travel/stop` | | stops the trip in progress |
| `POST /api/checkpoints` | `{"name": "..."}` | saves the game now |
| `POST /api/checkpoints/{id}/load` | | loads a checkpoint |
| `WS /ws` | | pushes `{type: "world", world, llm, travel}` after every change |
| `GET/POST /login` | `{"password": "..."}` | login page / sets the session cookie |
| `GET /healthz` | | `{ok, turn}`, used by Fly health checks; no password needed |

When `ZORK_PASSWORD` is set, every route except `/login`, `/healthz` and `/style.css` needs the `zork_auth` cookie or an `X-Zork-Password` header. Unauthenticated API calls get `401`; pages redirect to `/login`; WebSockets are refused.

## Save format (`data/world.json`)

```jsonc
{
  "version": 41,                 // bumps on every change; clients use it to skip redraws
  "current": "maze-7",           // room id
  "inventory": ["sword", "brass lantern"],
  "inventory_stale": false,
  "score": 40, "moves": 40, "turn": 41,
  "rooms": [{
    "id": "west-of-house", "name": "West of House", "description": "...",
    "x": 0.0, "y": 0.0, "z": 0,             // map position (east, north, level)
    "exits": {"north": {"to": "north-of-house", "blocked": false, "inferred": false, "note": "", "via": ""}},
    "items": ["small mailbox"], "visits": 2, "first_turn": 0, "dark": false,
    // filled in by the Claude API when it's on:
    "environment": "field", "indoor": false, "lighting": "bright",
    "features": ["white house"], "palette": {"floor": "#...", "wall": "#...", "accent": "#..."},
    "visual": "...", "enriched": true
  }],
  "checkpoints": [{"id": "c1", "name": "Got the leaflet", "file": "c1.qzl", "auto": false, "turn": 3,
                   "current": "west-of-house", "room_name": "West of House", "score": 0, "moves": 2,
                   "inventory": ["leaflet"], "items": {"west-of-house": ["small mailbox"]}, "created": 1761234567.0}],
  "log": [{"turn": 1, "command": "north", "text": "...", "room": "north-of-house", "score": 0, "moves": 1},
          {"turn": 3, "command": "", "kind": "save", "file": "c1.qzl", "text": "[Saved checkpoint: ...]"}]
}
```

`/api/world` adds `env3d` and `indoor3d` to each room: the Claude values if present, otherwise keyword guesses (`guess_environment` in `world.py`). Both 3D views use these.

## The 3D views

Both build the same scene from the same data:

| | Web (`web/world3d.js`) | Unity (`Assets/Zork/Scripts/WorldBuilder.cs`) |
|---|---|---|
| Scale | 14 units per map unit, 9 per level, 8×8 rooms | same |
| Rooms | floor; walls with doorway gaps on sides that have exits (indoor and maze rooms) | same |
| Theme | forest/field trees, water strip, cave rocks, temple columns, white house | same |
| Links | flat paths on one level; ramps between levels; a shaft when rooms are stacked | same |
| Exits not taken | grey stubs, red when blocked; discs for up/down | same |
| Labels | canvas-texture sprites | `TextMesh` billboards |
| Lighting | hemisphere + sun + a light on the player | adds a point light per room |
| Player | frog (`web/models/frog.glb`), three.js `AnimationMixer` | frog (`Resources/Frog.fbx`), Legacy `Animation` (`FrogPlayer.cs`) |
| You are here | ring on the floor + floating marker | same |
| Reachable rooms | additive glow plane per room (`setGlow`) | emissive tile per room (`SetGlow`, from `RoomData.reach`) |
| Travel | click = preview, double-click = go | double-click = go; status bar in the HUD |

**Frog model gotcha:** the rig was exported from FBX with the armature scaled 100×, so the skinned mesh's bounding box is about 100× too big. Both viewers size the frog from its **bone positions** (or a fixed scale) instead of mesh bounds, and turn off culling for it.

When adding a new environment type, update `THEMES` and `decorate()` in `world3d.js`, `Theme.For` and `Decorate()` in `WorldBuilder.cs`, the keyword guesses in `guess_environment`, and the list in the `SYSTEM` prompt in `llm.py`.

## Unity project notes

- **Startup:** `Bootstrap.cs` uses `[RuntimeInitializeOnLoadMethod]`, so any scene works. If the scene already has a `ZorkClient`, it does nothing.
- **Packages:** `Packages/manifest.json` is minimal. Scripts use IMGUI, JSONSerialize, Physics (primitive colliders), UnityWebRequest, ScreenCapture and ImageConversion. If you add a module dependency, add it there too.
- **Plain http:** `ZorkProjectSetup.cs` (editor) allows `http://` for local servers.
