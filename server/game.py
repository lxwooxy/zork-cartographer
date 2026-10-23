"""Runs Zork through dfrotz and turns each command into a structured Turn."""
from __future__ import annotations

import asyncio
import re
import shutil
from dataclasses import dataclass
from pathlib import Path

STATUS_RE = re.compile(r"^ (.+?)\s{2,}Score:\s*(-?\d+)\s+Moves:\s*(\d+)\s*$")


@dataclass
class Turn:
    command: str
    text: str          # game output with status line and prompt removed
    room_name: str     # from the status line
    score: int
    moves: int


class Game:
    def __init__(self, story: Path, seed: int = 42, width: int = 250):
        self.story = story
        self.seed = seed
        self.width = width
        self.proc: asyncio.subprocess.Process | None = None
        self.lock = asyncio.Lock()
        self.last: Turn | None = None

    async def start(self) -> Turn:
        dfrotz = shutil.which("dfrotz")
        if not dfrotz:
            raise RuntimeError("dfrotz not found. Install it with: brew install frotz")
        # -m: no MORE prompts, -s: fixed random seed so replays are deterministic
        self.proc = await asyncio.create_subprocess_exec(
            dfrotz, "-m", "-Z", "0", "-w", str(self.width), "-s", str(self.seed), str(self.story),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        raw = await self._read_until_prompt()
        self.last = self._parse("", raw)
        return self.last

    async def stop(self):
        if self.proc and self.proc.returncode is None:
            self.proc.kill()
            await self.proc.wait()
        self.proc = None

    async def send(self, command: str, fast: bool = False) -> Turn:
        """Send one command. fast=True is for replays: stop as soon as the prompt shows."""
        async with self.lock:
            if not self.proc or self.proc.returncode is not None:
                raise RuntimeError("Game is not running")
            self.proc.stdin.write((command.strip() + "\n").encode())
            await self.proc.stdin.drain()
            raw = await self._read_until_prompt(idle=0.01 if fast else 0.15, strict=fast)
            self.last = self._parse(command.strip(), raw)
            return self.last

    async def drain(self):
        """Throw away any output still in the pipe (used after a replay)."""
        async with self.lock:
            await self._read_until_prompt(idle=0.3, max_wait=0.6)

    async def _read_until_prompt(self, idle: float = 0.15, max_wait: float = 5.0, strict: bool = False) -> str:
        """Read until the game shows a prompt ('>' or a question ending in ':' / '?')
        and then goes quiet. strict: only the real '>' prompt counts."""
        buf = ""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + max_wait
        while loop.time() < deadline:
            try:
                chunk = await asyncio.wait_for(self.proc.stdout.read(4096), timeout=idle)
            except asyncio.TimeoutError:
                tail = buf.rstrip(" ")
                if strict:
                    if tail.endswith("\n>") or tail == ">":
                        break
                elif tail.endswith((">", ":", "?", ")")):
                    break
                continue
            if not chunk:
                break
            buf += chunk.decode("utf-8", errors="replace")
        return buf

    def _parse(self, command: str, raw: str) -> Turn:
        room = self.last.room_name if self.last else ""
        score = self.last.score if self.last else 0
        moves = self.last.moves if self.last else 0
        lines = []
        for line in raw.replace("\r", "").split("\n"):
            m = STATUS_RE.match(line.lstrip(">"))
            if m:
                room, score, moves = m.group(1).strip(), int(m.group(2)), int(m.group(3))
                continue
            if line.startswith(("Using normal formatting", "Loading ")):
                continue
            lines.append(line)
        text = "\n".join(lines).strip()
        text = re.sub(r"\n?>\s*$", "", text).strip()
        return Turn(command=command, text=text, room_name=room, score=score, moves=moves)
