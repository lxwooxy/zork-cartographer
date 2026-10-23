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

## Restoring a game

`data/world.json` keeps every command. On startup, `app.py` starts a fresh dfrotz with the same seed and replays them (`Game.send(fast=True)`, which stops reading as soon as the `>` prompt appears). Then it drains leftover output. The map itself is loaded from the file, not rebuilt.

## HTTP API

| Method & path | Body / query | Returns |
|---|---|---|
| `POST /api/command` | `{"command": "take lamp"}` | `{text, room, score, moves, changes}` |
| `GET /api/world` | | `{world, llm}`: full state for the web UI (last 200 log entries) |
| `GET /api/unity?since=N` | `since` = last version seen | flat, array-only state for Unity's `JsonUtility`, or `{unchanged: true}` |
| `POST /api/new-game` | | backs up the save, restarts |
| `POST /api/rooms/{id}/rename` | `{"name": "..."}` | rename a room on the map |
| `WS /ws` | | pushes `{type: "world", world, llm}` after every change |
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
    "exits": {"north": {"to": "north-of-house", "blocked": false, "inferred": false, "note": ""}},
    "items": ["small mailbox"], "visits": 2, "first_turn": 0, "dark": false,
    // filled in by the Claude API when it's on:
    "environment": "field", "indoor": false, "lighting": "bright",
    "features": ["white house"], "palette": {"floor": "#...", "wall": "#...", "accent": "#..."},
    "visual": "...", "enriched": true
  }],
  "log": [{"turn": 1, "command": "north", "text": "...", "room": "north-of-house", "score": 0, "moves": 1}]
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

When adding a new environment type, update `THEMES` and `decorate()` in `world3d.js`, `Theme.For` and `Decorate()` in `WorldBuilder.cs`, the keyword guesses in `guess_environment`, and the list in the `SYSTEM` prompt in `llm.py`.

## Unity project notes

- **Startup:** `Bootstrap.cs` uses `[RuntimeInitializeOnLoadMethod]`, so any scene works. If the scene already has a `ZorkClient`, it does nothing.
- **Packages:** `Packages/manifest.json` is minimal. Scripts use IMGUI, JSONSerialize, Physics (primitive colliders), UnityWebRequest, ScreenCapture and ImageConversion. If you add a module dependency, add it there too.
- **Plain http:** `ZorkProjectSetup.cs` (editor) allows `http://` for local servers.
