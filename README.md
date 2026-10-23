# Zork Cartographer

Play Zork I and watch the world map itself as you go: a 2D map in the browser and a 3D world in Unity.

```
 you type a command
        │
        ▼
 ┌──────────────┐   text    ┌────────────────────┐
 │ dfrotz       │ ────────► │ Python server      │
 │ (Zork I)     │           │ • rule-based parser│──► data/world.json
 └──────────────┘           │ • Claude (optional)│
                            └─────────┬──────────┘
                     WebSocket        │        HTTP poll
                 ┌────────────────────┴───────────────────┐
                 ▼                                        ▼
     Web UI  localhost:8765                    Unity viewer (unity/ZorkWorld)
     terminal · 2D map · inventory             3D rooms · paths · stairs · items
```

## Quick start

```bash
brew install frotz              # provides dfrotz, the Z-machine interpreter
cp .env.example .env            # optional: add ANTHROPIC_API_KEY for richer parsing
./run.sh                        # starts the server on http://localhost:8765
```

Open http://localhost:8765 and play. Every move updates the map.

### 3D view (Unity)

1. Open `unity/ZorkWorld` in Unity Hub (Unity 6000.0.37f1). The first open takes a few minutes while Unity builds the project's `Library/`.
2. Press **Play** in any scene. The viewer sets itself up automatically, so you don't need to place any objects.
3. Keep `./run.sh` running. You can type commands in Unity's HUD or in the browser; both stay in sync.

Controls: right-drag orbits · scroll zooms · WASD/QE pans · **F** follows the player · **Tab** shows the whole map · **H** hides the HUD.

## How the map is built

- **Location**: dfrotz prints a status line with the current room name every turn, so the server always knows where you are.
- **Rooms and exits**: when the room changes after a direction command (`n`, `up`, `enter`, `climb tree`…), the server links the two rooms. Failed moves mark that exit as blocked. Exits mentioned in descriptions show up as unexplored stubs.
- **Repeated names** (forests, the maze): rooms with the same name are only merged when they sit where the move would put you, so separate "Forest" rooms stay separate.
- **Layout**: Zork's geography isn't consistent (going east then west doesn't always bring you back), so positions come from a spring layout: each exit pulls rooms toward its compass direction, and rooms push each other apart. Up/down changes the level.
- **Items and inventory**: parsed from "There is a … here", "Taken.", "Dropped.", and the `inventory` listing.
- **Claude (optional)**: with an API key, each meaningful turn is also sent to Claude, which returns structured JSON: environment type (forest, cave, river, temple…), indoor/outdoor, lighting, scenery features, exits with notes, items, and a color palette. Unity uses this to theme each room. Runs in the background, so play never waits on it.

## Saving

The map and every command are saved to `data/world.json`. When the server restarts, it replays your commands with a fixed random seed, so the game resumes exactly where you left off. **New game** in the web UI backs up the old map to `data/world.bak.json`.

## Layout

```
game/zork1.z3            Zork I story file (MIT licensed, from github.com/historicalsource/zork1)
server/game.py           runs dfrotz, splits output into turns
server/parser.py         rule-based parsing (directions, items, inventory)
server/world.py          rooms, exits, layout, persistence
server/llm.py            optional Claude pass (structured output)
server/app.py            FastAPI: /api/command, /api/world, /api/unity, /ws
web/                     browser UI
unity/ZorkWorld/Assets/Zork/Scripts   Unity viewer (client, builder, camera, HUD)
```

## Configuration (.env)

| Variable | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | enables Claude parsing |
| `ZORK_LLM_MODEL` | `claude-opus-5-5` | model used for parsing |
| `ZORK_LLM_EFFORT` | `low` | `low` / `medium` / `high` |
| `ZORK_LLM` | `on` | set to `off` to disable Claude |
| `ZORK_SEED` | `42` | random seed for the game |

Claude requests use `fallbacks: "default"`, so if a request is ever declined it's retried on a fallback model automatically.

## Credits

Zork I © Infocom, released under the MIT license by Microsoft (2025). Interpreter: [Frotz](https://gitlab.com/DavidGriffith/frotz).
