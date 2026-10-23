# Zork Cartographer

Play Zork I in your browser and watch the world map itself as you go: a live 2D map, a 3D view of every room you've visited (with a frog as your player), and your inventory, all updating as you type. Click any room to have the autopilot walk you there, and save and load the game at any point. A Unity viewer renders the same world in 3D on the desktop.

```text
 you type a command (browser or Unity)
        │
        ▼
 ┌──────────────┐   text    ┌─────────────────────────┐
 │ dfrotz       │ ────────► │ Python server (FastAPI) │──► data/world.json
 │ (Zork I)     │           │ • rule-based parser     │    (map + every command)
 └──────────────┘           │ • Claude API (optional) │
                            └───────────┬─────────────┘
                    WebSocket           │           HTTP polling
               ┌────────────────────────┴──────────────────┐
               ▼                                           ▼
   Web UI (web/)                                Unity viewer (unity/ZorkWorld)
   terminal · 2D map · 3D view · inventory      3D rooms · paths · stairs · items
```

## Quick start (local)

Requires macOS or Linux, Python 3.10+, and the `dfrotz` interpreter.

```bash
git clone https://github.com/lxwooxy/zork-cartographer.git
cd zork-cartographer
brew install frotz          # macOS. Linux: see docs/SETUP.md
cp .env.example .env        # optional settings (API key, password)
./run.sh                    # creates .venv on first run
```

Open <http://localhost:8765> and type `look`.

## Using it

- **Terminal (left):** type Zork commands. ↑/↓ recalls previous commands.
- **Map (middle):** switch between **2D** and **3D**.
  - 2D: drag to pan, scroll to zoom, ▲/▼ to change level (up/down in the game).
  - 3D: drag to orbit, right-drag to pan, scroll to zoom. **Overview** shows the whole map.
  - **Follow** keeps the view on the player. **Center** jumps back to them.
  - **You are here:** a pulsing ring (2D), or the frog with a ring and a floating marker (3D).
  - **Glowing rooms** show where you can walk: bright green = one move away, soft green = reachable by exits you've walked, dashed amber = probably reachable (only through exits the map guessed).
- **Click a room** to preview the route (it glows blue, and the room panel lists the moves, e.g. `north → north → climb tree`). Press **Go there**, or **double-click** a room to go straight away. See [Autopilot](#autopilot).
- **Room panel (right):** description, items here (click to take), exits (click to walk).
- **Inventory:** click an item to examine it. If the game hints something was taken (the thief), a red note asks you to type `i` to refresh.
- **Saves:** **Save** makes a named checkpoint; **Load** goes back to one. Loading undoes game progress since then but keeps everything you've mapped.
- **New game** backs up the current map to `data/world.bak.json` and restarts.

Progress saves after every command. When the server restarts it replays your commands with a fixed random seed, so you continue exactly where you left off.

## Autopilot

When you pick a destination, the server plans the shortest route over exits you know about and walks it one move at a time, checking each turn against a rulebook (`server/autopilot.py`):

| Situation | What it does |
|---|---|
| A move doesn't work ("The kitchen window is closed.") | Marks that exit blocked and re-plans. |
| You end up somewhere unexpected (Zork's paths aren't always two-way) | Fixes the map and re-plans. |
| The thief appears, even if he attacks | Keeps moving: leaving is the tactic. |
| Something gets stolen, or you die | Loads the checkpoint it made before the trip and tries again, after waiting a turn so the dice roll differently (up to 3 attempts). |
| Troll or cyclops in the way, darkness, other combat, a question from the game | Stops and tells you why. |
| No known route from here | Looks for an earlier save from which the destination *is* reachable and offers to load it ("Load ‘Living room’ and go"). |

Every trip starts with an automatic checkpoint ("Before trip to …"), so you can always undo it. The newest 8 automatic checkpoints are kept; your own saves are never removed.

## Documentation

| Doc | What's in it |
|---|---|
| [docs/SETUP.md](docs/SETUP.md) | Local setup on macOS and Linux, configuration, Unity viewer, troubleshooting |
| [docs/DEPLOY.md](docs/DEPLOY.md) | Hosting on Fly.io behind a password |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the map is built, the HTTP API, the save format, where to change things |
| [DEVLOG.md](DEVLOG.md) | What was built, design decisions, bugs found and fixed |

## Repository layout

```text
game/zork1.z3                  Zork I story file (MIT, from github.com/historicalsource/zork1)
server/game.py                 runs dfrotz, splits output into turns
server/parser.py               rule-based parsing: directions, items, inventory, exits
server/world.py                rooms, exits, spring layout, persistence
server/llm.py                  optional Claude API pass (structured JSON per turn)
server/autopilot.py            click-to-travel rulebook (stop / flee / retry decisions)
server/app.py                  FastAPI app: API, WebSocket, password login, static files
web/                           browser UI (app.js = terminal/2D/panels, world3d.js = 3D)
web/vendor/                    three.js r160 + GLTFLoader (bundled, no CDN needed)
web/models/                    frog.glb player model (CC0, see CREDITS.md)
unity/ZorkWorld/               Unity 6 project; scripts in Assets/Zork/Scripts
Dockerfile, fly.toml           container build and Fly.io config
run.sh                         local launcher
```

## Configuration

Set in `.env` locally, or as secrets/env vars when hosted.

| Variable | Default | Purpose |
|---|---|---|
| `ZORK_PASSWORD` | *(empty)* | Require a password to play. Leave empty for local use. |
| `ANTHROPIC_API_KEY` | *(empty)* | Turns on Claude parsing (richer room types, colors, scenery). |
| `ZORK_LLM_MODEL` | `claude-opus-5-5` | Model used for parsing. |
| `ZORK_LLM_EFFORT` | `low` | `low` / `medium` / `high`. |
| `ZORK_LLM` | `on` | `off` disables Claude even if a key is set. |
| `ZORK_SEED` | `42` | Game random seed. Changing it breaks replay of an existing save. |
| `ZORK_DATA` | `data/world.json` | Where the map and command log are saved. Checkpoint files go in a `saves/` folder next to it. |
| `PORT` | `8765` | Port used by `run.sh`. |

Everything works without an API key. The rule-based parser handles rooms, exits, items and inventory. With a key, each meaningful turn is also sent to the Claude API, which costs roughly a few dollars over a full game at the default settings.

## Credits

Zork I © Infocom, released under the MIT license by Microsoft (2025); see `game/LICENSE-zork1`. Interpreter: [Frotz](https://gitlab.com/DavidGriffith/frotz). 3D rendering: [three.js](https://threejs.org) (MIT). Frog model: [Quaternius](https://quaternius.com) (CC0), see `web/models/CREDITS.md`.
