"""Zork Cartographer server.

- Runs Zork I through dfrotz
- Builds the map from every turn (rules first, Claude for extra detail)
- Serves the web UI (terminal, 2D map, inventory) at http://localhost:8765
- Serves /api/unity for the Unity 3D viewer
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

import autopilot  # noqa: E402
from canon import Canon  # noqa: E402
from game import Game  # noqa: E402
from llm import Enricher  # noqa: E402
from world import World  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
log = logging.getLogger("zork")

STORY = Path(os.environ.get("ZORK_STORY", ROOT / "game" / "zork1.z3"))
DATA = Path(os.environ.get("ZORK_DATA", ROOT / "data" / "world.json"))
SEED = int(os.environ.get("ZORK_SEED", "42"))
WEB = ROOT / "web"
SAVES = DATA.parent / "saves"      # Zork save files for checkpoints
MAX_AUTO_CHECKPOINTS = 8
# The canonical map (game/zork1-map.json) turns on exact tracking and fog of war.
# ZORK_MAP=off falls back to the heuristic mapper.
CANON = None if os.environ.get("ZORK_MAP", "on") == "off" else Canon.for_story(STORY)
PASSWORD = os.environ.get("ZORK_PASSWORD", "")
COOKIE = "zork_auth"


class State:
    game: Game
    world: World
    enricher: Enricher
    sockets: set[WebSocket] = set()
    pending: int = 0
    travel: dict | None = None          # current/last autopilot trip, shown in the UI
    travel_task: asyncio.Task | None = None


S = State()


async def broadcast():
    payload = {"type": "world", "world": S.world.to_json(), "llm": llm_status(), "travel": S.travel}
    dead = []
    for ws in S.sockets:
        try:
            await ws.send_json(payload)
        except Exception:
            dead.append(ws)
    for ws in dead:
        S.sockets.discard(ws)


def llm_status() -> dict:
    details = len(S.world.canon.details) if getattr(S, "world", None) and S.world.canon else 0
    return {"enabled": S.enricher.enabled, "error": S.enricher.error, "pending": S.pending, "details": details}


async def enrich(command: str, text: str, room_id: str, changes: dict):
    room = S.world.rooms.get(room_id)
    if not room:
        return
    from dataclasses import asdict
    S.pending += 1
    try:
        info = await S.enricher.analyze(command, text, asdict(room), S.world.inventory)
    finally:
        S.pending -= 1
    if info:
        S.world.apply_enrichment(room_id, info)
        S.world.save()
    await broadcast()


def should_enrich(command: str, text: str, changes: dict) -> bool:
    if not S.enricher.enabled:
        return False
    # With pre-written room details (tools/describe_rooms.py) there's nothing to ask per turn.
    if S.world.canon and S.world.canon.details:
        return False
    room = S.world.rooms.get(changes["room_id"])
    if changes["has_heading"] and room and not room.enriched:
        return True
    c = command.lower().split()[0] if command.strip() else ""
    if c in ("i", "inventory", "look", "l", "take", "get", "drop", "put", "open", "give", "throw", "examine", "x"):
        return True
    return changes["has_heading"]


async def start_game(replay: list[dict]):
    S.game = Game(STORY, seed=SEED, saves=SAVES)
    intro = await S.game.start()
    if not intro.room_name:
        # The map depends on dfrotz's status line (room name, score, moves).
        log.error("dfrotz printed no status line, so rooms can't be tracked. "
                  "Use Frotz 2.55 or newer (2.54's dumb interface doesn't print it).")
    if not S.world.rooms:
        S.world.apply_turn(intro)
        await S.game.send("verbose")  # always print full room descriptions
        S.world.save()
        if should_enrich("", intro.text, {"room_id": S.world.current, "has_heading": True}):
            asyncio.create_task(enrich("", intro.text, S.world.current, {"room_id": S.world.current, "has_heading": True}))
    else:
        # Restore the game by replaying the saved commands (fixed seed = same outcome).
        await S.game.send("verbose")
        loop = asyncio.get_running_loop()
        t0 = loop.time()
        for entry in replay:
            if entry.get("kind") == "save":
                await S.game.save(entry["file"])
            elif entry.get("kind") == "restore":
                await S.game.restore(entry["file"])
            else:
                await S.game.send(entry["command"], fast=True)
        await S.game.drain()
        log.info("Replayed %d commands in %.1fs", len(replay), loop.time() - t0)


@asynccontextmanager
async def lifespan(app: FastAPI):
    S.world = World.load(DATA, CANON)
    log.info("Map mode: %s%s", S.world.mode, f" ({len(CANON.rooms)} rooms in the canonical map)" if S.world.canon else "")
    S.enricher = Enricher()
    if not S.enricher.enabled:
        log.warning("Claude disabled (%s). Map still works with rule-based parsing.", S.enricher.error)
    replay = [e for e in S.world.log if e.get("command") or e.get("kind")]
    await start_game(replay)
    yield
    await S.game.stop()


app = FastAPI(title="Zork Cartographer", lifespan=lifespan)


# ---------- password (set ZORK_PASSWORD to turn it on) ----------
def _token() -> str:
    return hmac.new(PASSWORD.encode(), b"zork-cartographer-session", hashlib.sha256).hexdigest()


def is_authed(headers, cookies) -> bool:
    if not PASSWORD:
        return True
    if hmac.compare_digest(cookies.get(COOKIE, ""), _token()):
        return True
    given = headers.get("x-zork-password", "")  # used by the Unity viewer
    return bool(given) and hmac.compare_digest(given, PASSWORD)


OPEN_PATHS = ("/login", "/healthz", "/style.css")


@app.middleware("http")
async def require_password(request: Request, call_next):
    if request.url.path in OPEN_PATHS or is_authed(request.headers, request.cookies):
        return await call_next(request)
    if request.url.path.startswith("/api/"):
        return JSONResponse({"error": "password required"}, status_code=401)
    return RedirectResponse("/login")


@app.get("/login")
async def login_page():
    return FileResponse(WEB / "login.html")


@app.post("/login")
async def login(request: Request, body: dict):
    if not PASSWORD or hmac.compare_digest(str(body.get("password", "")), PASSWORD):
        resp = JSONResponse({"ok": True})
        https = request.headers.get("x-forwarded-proto", request.url.scheme) == "https"
        resp.set_cookie(COOKIE, _token(), max_age=60 * 60 * 24 * 365, httponly=True, samesite="lax", secure=https)
        return resp
    await asyncio.sleep(1.0)  # slow down guessing
    return JSONResponse({"ok": False, "error": "Wrong password"}, status_code=401)


@app.get("/healthz")
async def healthz():
    return {"ok": True, "turn": S.world.turn if hasattr(S, "world") else None}


class Command(BaseModel):
    command: str


async def run_command(c: str) -> tuple:
    """Send one command to the game and update the map. Used by players and the autopilot."""
    turn = await S.game.send(c)
    changes = S.world.apply_turn(turn)
    S.world.save()
    if should_enrich(c, turn.text, changes):
        asyncio.create_task(enrich(c, turn.text, changes["room_id"], changes))
    await broadcast()
    return turn, changes


@app.post("/api/command")
async def command(cmd: Command):
    c = cmd.command.strip()
    if not c:
        return JSONResponse({"error": "empty command"}, status_code=400)
    if c.lower() in ("restart", "quit", "q"):
        return JSONResponse({"error": "Use the New Game button to restart."}, status_code=400)
    await cancel_travel("You took over.")
    turn, changes = await run_command(c)
    return {"text": turn.text, "room": turn.room_name, "score": turn.score, "moves": turn.moves,
            "changes": changes}


# ---------- settings ----------
class Settings(BaseModel):
    reveal: bool | None = None   # show the whole canonical map (spoilers)


@app.post("/api/settings")
async def settings(req: Settings):
    if req.reveal is not None:
        S.world.reveal = req.reveal and S.world.canon is not None
        S.world.version += 1
        S.world.save()
        await broadcast()
    return {"reveal": S.world.reveal, "mode": S.world.mode}


# ---------- checkpoints (save / load) ----------
class CheckpointRequest(BaseModel):
    name: str = ""


async def do_save(name: str, auto: bool = False) -> dict | None:
    file = S.world.next_save_file()
    ok, text = await S.game.save(file)
    if not ok:
        log.warning("Save failed: %s", text)
        return None
    cp = S.world.make_checkpoint(name or f"Turn {S.world.turn} at {S.world.rooms[S.world.current].name}",
                                 file, auto)
    # Keep the list short: drop the oldest automatic checkpoints. (Their files can stay;
    # replaying the log recreates them anyway.)
    autos = [c for c in S.world.checkpoints if c["auto"]]
    for old in autos[:-MAX_AUTO_CHECKPOINTS]:
        S.world.checkpoints.remove(old)
    S.world.save()
    await broadcast()
    return cp


async def do_load(cp: dict) -> bool:
    ok, text = await S.game.restore(cp["file"])
    if not ok:
        log.warning("Restore failed: %s", text)
        return False
    S.world.restore_checkpoint(cp)
    S.world.save()
    await broadcast()
    return True


def find_checkpoint(cp_id: str) -> dict | None:
    return next((c for c in S.world.checkpoints if c["id"] == cp_id), None)


@app.post("/api/checkpoints")
async def save_checkpoint(req: CheckpointRequest):
    await cancel_travel("Saving.")
    cp = await do_save(req.name.strip())
    if not cp:
        return JSONResponse({"error": "The game refused to save."}, status_code=500)
    return {k: v for k, v in cp.items() if k != "items"}


@app.post("/api/checkpoints/{cp_id}/load")
async def load_checkpoint(cp_id: str):
    cp = find_checkpoint(cp_id)
    if not cp:
        return JSONResponse({"error": "no such checkpoint"}, status_code=404)
    await cancel_travel("Loading a checkpoint.")
    if not await do_load(cp):
        return JSONResponse({"error": "The game couldn't load that save."}, status_code=500)
    return {"ok": True}


# ---------- click-to-travel ----------
MAX_STEPS = 60
MAX_REPLANS = 6
MAX_ATTEMPTS = 3      # first try + 2 retries from the trip's checkpoint
STEP_DELAY = 0.35     # seconds between moves, so you can watch the hops

# What happened on a turn that makes the autopilot undo the trip and try again.
RETRY_ON = {"death": "You died", "theft": "Something was stolen"}


class TravelRequest(BaseModel):
    to: str
    from_checkpoint: str | None = None   # load this checkpoint first ("go back and try again")
    retry: bool = True                   # reload and retry on death or theft


@app.get("/api/route")
async def route(to: str):
    if to not in S.world.rooms:
        return JSONResponse({"error": "no such room"}, status_code=404)
    steps = S.world.route(S.world.current, to)
    if steps is None:
        return {"to": to, "reachable": False, "steps": [], "suggest": suggest_checkpoint(to)}
    return {"to": to, "reachable": True, "steps": steps}


def suggest_checkpoint(goal: str) -> dict | None:
    """Stuck? Find the newest checkpoint from which the map knows a route to goal."""
    for cp in reversed(S.world.checkpoints):
        if cp["current"] == S.world.current:
            continue
        steps = S.world.route(cp["current"], goal)
        if steps is not None:
            return {"id": cp["id"], "name": cp["name"], "turn": cp["turn"],
                    "room_name": cp["room_name"], "moves": len(steps)}
    return None


@app.post("/api/travel")
async def travel(req: TravelRequest):
    if req.to not in S.world.rooms:
        return JSONResponse({"error": "no such room"}, status_code=404)
    await cancel_travel("New destination.")
    name = S.world.rooms[req.to].name
    if req.from_checkpoint:
        cp = find_checkpoint(req.from_checkpoint)
        if not cp or not await do_load(cp):
            return JSONResponse({"error": "Couldn't load that checkpoint."}, status_code=409)
    steps = S.world.route(S.world.current, req.to)
    if steps is None:
        S.travel = {"to": req.to, "to_name": name, "status": "stuck", "steps": [], "done": 0,
                    "events": [], "suggest": suggest_checkpoint(req.to),
                    "message": f"No known route to {name} from here."}
        await broadcast()
        return JSONResponse({"error": S.travel["message"], "suggest": S.travel["suggest"]}, status_code=409)
    cp = await do_save(f"Before trip to {name}", auto=True)
    S.travel = {"to": req.to, "to_name": name, "status": "moving", "steps": steps, "done": 0,
                "events": [], "checkpoint": cp["id"] if cp else None, "attempt": 1, "retry": req.retry,
                "avoid": [], "message": f"{len(steps)} moves"}
    S.travel_task = asyncio.create_task(_travel_loop(req.to))
    await broadcast()
    return S.travel


@app.post("/api/travel/stop")
async def travel_stop():
    await cancel_travel("Stopped.")
    return {"ok": True}


async def cancel_travel(reason: str):
    task = S.travel_task
    if task and not task.done():
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        if S.travel:
            S.travel.update(status="stopped", message=reason)
            S.world.version += 1
        await broadcast()
    S.travel_task = None


def _event(text: str, kind: str = "info"):
    S.travel["events"].append({"turn": S.world.turn, "kind": kind, "text": text})
    S.travel["message"] = text
    S.world.version += 1   # so polling clients (Unity) see the new status


async def _finish(status: str, text: str, kind: str, goal: str | None = None):
    S.travel["status"] = status
    _event(text, kind)
    if status in ("failed", "stuck") and goal:
        S.travel["suggest"] = suggest_checkpoint(goal)
    await broadcast()


async def _retry(reason: str, goal: str) -> bool:
    """Reload the trip's checkpoint and set up another attempt. False if out of attempts."""
    t = S.travel
    cp = find_checkpoint(t.get("checkpoint") or "")
    if not t.get("retry") or not cp or t["attempt"] >= MAX_ATTEMPTS:
        return False
    t["attempt"] += 1
    _event(f"{reason}. Loading \"{cp['name']}\" and trying again "
           f"(attempt {t['attempt']} of {MAX_ATTEMPTS}).", "reload")
    if not await do_load(cp):
        return False
    # Waiting a turn or two changes what the random events do next time
    # (where the thief wanders, how a fight goes).
    for _ in range(t["attempt"] - 1):
        await run_command("wait")
    new = S.world.route(S.world.current, goal)
    if new is None:
        return False
    t["steps"] = new
    await broadcast()
    return True


async def _travel_loop(goal: str):
    t = S.travel
    replans = 0
    try:
        for _ in range(MAX_STEPS):
            if S.world.current == goal:
                return await _finish("arrived", f"Arrived at {t['to_name']}.", "done")
            if not t["steps"]:
                break
            step = t["steps"][0]
            turn, _ = await run_command(step["command"])
            matches = autopilot.evaluate(turn.text)
            action = autopilot.decide(matches)
            for m in matches:
                if m.action != "replan":
                    _event(m.message, m.action)

            # Death or theft: undo the trip and try again, if allowed.
            trigger = next((RETRY_ON[m.name] for m in matches if m.name in RETRY_ON), None)
            if trigger:
                if await _retry(trigger, goal):
                    await asyncio.sleep(STEP_DELAY)
                    continue
                if any(m.name == "death" for m in matches):
                    return await _finish("stopped", "Out of retries after dying.", "stop", goal)

            if S.world.current == goal:
                return await _finish("arrived", f"Arrived at {t['to_name']}.", "done")
            if action == "stop":
                return await _finish("stopped", t["message"], "stop", goal)

            if S.world.current == step["to"]:
                t["steps"].pop(0)
                t["done"] += 1
            else:
                if S.world.current == step["from"]:
                    # We didn't move, whatever the game said ("The windows are boarded", ...).
                    # Mark that exit as blocked so the next plan avoids it.
                    ex = S.world.rooms[step["from"]].exits.get(step["dir"])
                    if ex and not ex.blocked:
                        ex.blocked = True
                        S.world.version += 1
                        S.world.save()
                    t["avoid"].append([step["from"], step["dir"]])   # not again this trip
                    said = turn.text.strip().splitlines()[0] if turn.text.strip() else "nothing"
                    why = f"Going {step['dir']} from {S.world.rooms[step['from']].name} didn't work (\"{said}\")"
                else:
                    # Ended up somewhere else. apply_turn already corrected the map.
                    why = f"Going {step['dir']} led to {S.world.rooms[S.world.current].name}, not where the map expected"
                replans += 1
                new = S.world.route(S.world.current, goal, avoid={tuple(a) for a in t["avoid"]})
                if new is None or replans > MAX_REPLANS:
                    return await _finish("stuck", f"{why}, and there's no other known route.", "stop", goal)
                t["steps"] = new
                _event(f"{why}. New route: {' '.join(x['dir'] for x in new)}.", "replan")
            await broadcast()
            await asyncio.sleep(STEP_DELAY)
        if S.world.current == goal:
            return await _finish("arrived", f"Arrived at {t['to_name']}.", "done")
        return await _finish("failed", "Gave up: too many moves.", "stop", goal)
    finally:
        await broadcast()


@app.get("/api/world")
async def world():
    return {"world": S.world.to_json(), "llm": llm_status(), "travel": S.travel}


@app.get("/api/unity")
async def unity(since: int = -1):
    if since == S.world.version:
        return {"version": S.world.version, "unchanged": True}
    d = S.world.to_unity(S.travel)
    d["unchanged"] = False
    return d


@app.post("/api/new-game")
async def new_game():
    await cancel_travel("New game.")
    S.travel = None
    await S.game.stop()
    if DATA.exists():
        DATA.rename(DATA.with_suffix(".bak.json"))
    if SAVES.exists():
        import shutil
        bak = SAVES.with_name("saves.bak")
        shutil.rmtree(bak, ignore_errors=True)
        SAVES.rename(bak)
    S.world = World(DATA, CANON)
    await start_game([])
    await broadcast()
    return {"ok": True}


@app.post("/api/rooms/{room_id}/rename")
async def rename_room(room_id: str, body: dict):
    r = S.world.rooms.get(room_id)
    if not r:
        return JSONResponse({"error": "no such room"}, status_code=404)
    r.name = body.get("name", r.name)
    S.world.version += 1
    S.world.save()
    await broadcast()
    return {"ok": True}


@app.websocket("/ws")
async def ws(websocket: WebSocket):
    if not is_authed(websocket.headers, websocket.cookies):
        await websocket.close(code=4401)
        return
    await websocket.accept()
    S.sockets.add(websocket)
    await websocket.send_json({"type": "world", "world": S.world.to_json(), "llm": llm_status(), "travel": S.travel})
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        S.sockets.discard(websocket)


@app.get("/")
async def index():
    return FileResponse(WEB / "index.html")


app.mount("/", StaticFiles(directory=WEB), name="web")
