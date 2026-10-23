# Setup guide

How to run Zork Cartographer on your own machine, and how to use the Unity viewer.

## 1. Requirements

| | Version | Notes |
|---|---|---|
| Python | 3.10 or newer | Tested on 3.12–3.14 |
| dfrotz | 2.5x | The text-only build of the Frotz Z-machine interpreter |
| Browser | any recent | Chrome, Safari, Firefox. The 3D view needs WebGL. |
| Unity | 6000.0.37f1 | Only for the optional desktop 3D viewer |

### Installing dfrotz

**macOS (Homebrew):**

```bash
brew install frotz      # installs frotz, dfrotz and sfrotz
dfrotz -v               # check it's on your PATH
```

**Debian / Ubuntu:** the `frotz` package doesn't always ship `dfrotz`, so build it from source (takes under a minute):

```bash
sudo apt-get install -y build-essential git
git clone --depth 1 --branch 2.54 https://gitlab.com/DavidGriffith/frotz.git /tmp/frotz
make -C /tmp/frotz dumb
sudo install /tmp/frotz/dfrotz /usr/local/bin/
```

> Building from source on macOS needs `make -C /tmp/frotz dumb CURSES_CONFIG=/usr/bin/true`, because the Makefile looks for Homebrew's ncurses even for the text-only build.

## 2. Run the server

```bash
git clone https://github.com/lxwooxy/zork-cartographer.git
cd zork-cartographer
cp .env.example .env     # edit if you want a password or Claude parsing
./run.sh
```

`run.sh` creates `.venv/` and installs `requirements.txt` the first time, then starts the server on <http://127.0.0.1:8765>. Use `PORT=9000 ./run.sh` to pick another port.

To run it by hand instead:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cd server && ../.venv/bin/uvicorn app:app --port 8765 --reload
```

(`--reload` restarts on code changes. Each restart replays your saved commands, which takes about a second per few dozen moves.)

## 3. Configuration

Copy `.env.example` to `.env`. All settings are optional; the full list is in the [README](../README.md#configuration).

- **Password.** Set `ZORK_PASSWORD=something` to require a login. Browsers get a cookie that lasts a year; the Unity viewer sends the password in an `X-Zork-Password` header.
- **Claude parsing.** Set `ANTHROPIC_API_KEY`. The status pill in the header shows `Claude: on`, and `Claude: parsing (n)` while requests are in flight. Hover `Claude: off` to see why it's off.

## 4. Saves

- The map and the full command log live in `data/world.json` (git-ignored).
- On startup the server replays the log against a fresh game with the same seed (`ZORK_SEED`) to restore the exact game state.
- **New game** in the UI moves the old file to `data/world.bak.json`.
- To start over by hand: stop the server and delete `data/world.json`.
- Don't change `ZORK_SEED` for an existing save. Random events (the troll fight, the thief) would play out differently and the replay would go out of sync.

## 5. Unity viewer (optional)

The Unity project is in `unity/ZorkWorld`. It needs no scene setup: a bootstrap script creates the client, world builder, HUD, camera and lights when you press Play in any scene.

1. Start the server (`./run.sh`).
2. In Unity Hub: **Add → Add project from disk →** `unity/ZorkWorld`. Open it with **6000.0.37f1**. The first open imports for a few minutes.
3. Press **Play**.
4. If it can't connect, a **Connect** panel appears (also under **Server…**, top right). Enter the server URL (`http://127.0.0.1:8765` locally, or your hosted URL) and the password, if any. Settings are remembered between sessions.

You can also pass settings as environment variables: `ZORK_SERVER` and `ZORK_PASSWORD`.

**Controls:** right-drag orbit · scroll zoom · WASD/QE pan · **F** follow · **Tab** overview · **H** hide HUD · **Enter** focuses the command box.

### Unity smoke test

With the server running, this opens the editor, enters Play mode, saves screenshots, sends one move (`nw`), and quits:

```bash
ZORK_AUTOTEST=/tmp/zorktest \
  "/Applications/Unity/Hub/Editor/6000.0.37f1/Unity.app/Contents/MacOS/Unity" \
  -projectPath unity/ZorkWorld
cat /tmp/zorktest/autotest.log     # connected=True rooms=… and the move result
```

Add `ZORK_PASSWORD=…` if the server has a password. The test code is `Assets/Zork/Editor/ZorkAutoTest.cs` and `Assets/Zork/Scripts/AutoTestRunner.cs`; it does nothing unless `ZORK_AUTOTEST` is set.

## 6. Troubleshooting

| Problem | Fix |
|---|---|
| `dfrotz not found` | Install it (step 1) and make sure it's on `PATH`. |
| Page loads but nothing happens | Check the server terminal for errors. The browser console shows WebSocket failures. |
| `Claude: off` with a key set | Hover the pill for the reason. Check the key in `.env` and restart the server. |
| Unity: "Insecure connection not allowed" | `Assets/Zork/Editor/ZorkProjectSetup.cs` allows `http://` on open. Reopen the project, or set **Player Settings → Allow downloads over HTTP** to *Always allowed*. |
| Unity: "wrong or missing password" | Click **Server…** and re-enter the password. |
| Map has a duplicate room | Zork has many rooms with the same name (Forest, Maze). Drop an item in a room you want to recognise later; the mapper uses items lying around to tell identical rooms apart. |
| Inventory looks wrong | Type `i`. The game's own listing always replaces what the parser tracked. |
