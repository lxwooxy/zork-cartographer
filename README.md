# Zork Cartographer

Play Zork I in your browser and watch the world map itself as you go: a live 2D map, a 3D view of every room you've visited, and your inventory, all updating as you type. A Unity viewer renders the same world in 3D on the desktop.

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
- **Room panel (right):** description, items here (click to take), exits (click to walk).
- **Inventory:** click an item to examine it. If the game hints something was taken (the thief), a red note asks you to type `i` to refresh.
- **New game** backs up the current map to `data/world.bak.json` and restarts.

Progress saves after every command. When the server restarts it replays your commands with a fixed random seed, so you continue exactly where you left off.

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
server/app.py                  FastAPI app: API, WebSocket, password login, static files
web/                           browser UI (app.js = terminal/2D/panels, world3d.js = 3D)
web/vendor/                    three.js r160 (bundled, no CDN needed)
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
| `ZORK_DATA` | `data/world.json` | Where the map and command log are saved. |
| `PORT` | `8765` | Port used by `run.sh`. |

Everything works without an API key. The rule-based parser handles rooms, exits, items and inventory. With a key, each meaningful turn is also sent to the Claude API, which costs roughly a few dollars over a full game at the default settings.

## Credits

Zork I © Infocom, released under the MIT license by Microsoft (2025); see `game/LICENSE-zork1`. Interpreter: [Frotz](https://gitlab.com/DavidGriffith/frotz). 3D rendering: [three.js](https://threejs.org) (MIT).
