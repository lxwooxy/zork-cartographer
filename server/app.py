"""Zork Cartographer server.

- Runs Zork I through dfrotz
- Builds the map from every turn (rules first, Claude for extra detail)
- Serves the web UI (terminal, 2D map, inventory) at http://localhost:8765
- Serves /api/unity for the Unity 3D viewer
"""
from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

from game import Game  # noqa: E402
from llm import Enricher  # noqa: E402
from world import World  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
log = logging.getLogger("zork")

STORY = Path(os.environ.get("ZORK_STORY", ROOT / "game" / "zork1.z3"))
DATA = Path(os.environ.get("ZORK_DATA", ROOT / "data" / "world.json"))
SEED = int(os.environ.get("ZORK_SEED", "42"))
WEB = ROOT / "web"


class State:
    game: Game
    world: World
    enricher: Enricher
    sockets: set[WebSocket] = set()
    pending: int = 0


S = State()


async def broadcast():
    payload = {"type": "world", "world": S.world.to_json(), "llm": llm_status()}
    dead = []
    for ws in S.sockets:
        try:
            await ws.send_json(payload)
        except Exception:
            dead.append(ws)
    for ws in dead:
        S.sockets.discard(ws)


def llm_status() -> dict:
    return {"enabled": S.enricher.enabled, "error": S.enricher.error, "pending": S.pending}


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
    room = S.world.rooms.get(changes["room_id"])
    if changes["has_heading"] and room and not room.enriched:
        return True
    c = command.lower().split()[0] if command.strip() else ""
    if c in ("i", "inventory", "look", "l", "take", "get", "drop", "put", "open", "give", "throw", "examine", "x"):
        return True
    return changes["has_heading"]


async def start_game(replay: list[str]):
    S.game = Game(STORY, seed=SEED)
    intro = await S.game.start()
    if not S.world.rooms:
        S.world.apply_turn(intro)
        await S.game.send("verbose")  # always print full room descriptions
        S.world.save()
        if S.enricher.enabled:
            asyncio.create_task(enrich("", intro.text, S.world.current, {"room_id": S.world.current, "has_heading": True}))
    else:
        # Restore the game by replaying the saved commands (fixed seed = same outcome).
        await S.game.send("verbose")
        for cmd in replay:
            await S.game.send(cmd)
        log.info("Replayed %d commands", len(replay))


@asynccontextmanager
async def lifespan(app: FastAPI):
    S.world = World.load(DATA)
    S.enricher = Enricher()
    if not S.enricher.enabled:
        log.warning("Claude disabled (%s). Map still works with rule-based parsing.", S.enricher.error)
    replay = [e["command"] for e in S.world.log if e.get("command")]
    await start_game(replay)
    yield
    await S.game.stop()


app = FastAPI(title="Zork Cartographer", lifespan=lifespan)


class Command(BaseModel):
    command: str


@app.post("/api/command")
async def command(cmd: Command):
    c = cmd.command.strip()
    if not c:
        return JSONResponse({"error": "empty command"}, status_code=400)
    if c.lower() in ("restart", "quit", "q"):
        return JSONResponse({"error": "Use the New Game button to restart."}, status_code=400)
    turn = await S.game.send(c)
    changes = S.world.apply_turn(turn)
    S.world.save()
    if should_enrich(c, turn.text, changes):
        asyncio.create_task(enrich(c, turn.text, changes["room_id"], changes))
    await broadcast()
    return {"text": turn.text, "room": turn.room_name, "score": turn.score, "moves": turn.moves,
            "changes": changes}


@app.get("/api/world")
async def world():
    return {"world": S.world.to_json(), "llm": llm_status()}


@app.get("/api/unity")
async def unity(since: int = -1):
    if since == S.world.version:
        return {"version": S.world.version, "unchanged": True}
    d = S.world.to_unity()
    d["unchanged"] = False
    return d


@app.post("/api/new-game")
async def new_game():
    await S.game.stop()
    if DATA.exists():
        DATA.rename(DATA.with_suffix(".bak.json"))
    S.world = World(DATA)
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
    await websocket.accept()
    S.sockets.add(websocket)
    await websocket.send_json({"type": "world", "world": S.world.to_json(), "llm": llm_status()})
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        S.sockets.discard(websocket)


@app.get("/")
async def index():
    return FileResponse(WEB / "index.html")


app.mount("/", StaticFiles(directory=WEB), name="web")
