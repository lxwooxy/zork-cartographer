// Backend for the hosted/local Python server (server/app.py): HTTP API + WebSocket.
// The static browser build uses engine/local.js instead, with the same interface.
export function createServerBackend() {
  const subs = [];
  const post = (url, body) => fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  });

  function connect() {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "world") for (const f of subs) f(msg.world, msg.llm, msg.travel);
    };
    ws.onclose = () => setTimeout(connect, 1000);
  }

  return {
    kind: "server",
    newGameText: "Start a new game? The current map is backed up to data/world.bak.json.",
    subscribe(fn) { subs.push(fn); },
    async init() {
      connect();
      return (await fetch("/api/world")).json();
    },
    async command(command) { return (await post("/api/command", { command })).json(); },
    async route(to) {
      const r = await fetch(`/api/route?to=${encodeURIComponent(to)}`);
      return r.ok ? r.json() : null;
    },
    async travel(to, fromCheckpoint) {
      const body = { to };
      if (fromCheckpoint) body.from_checkpoint = fromCheckpoint;
      const r = await post("/api/travel", body);
      return r.ok ? {} : r.json().catch(() => ({}));
    },
    async stopTravel() { await post("/api/travel/stop"); },
    async save(name) { return (await post("/api/checkpoints", { name })).json(); },
    async load(id) { return (await post(`/api/checkpoints/${id}/load`)).json(); },
    async setReveal(reveal) { return (await post("/api/settings", { reveal })).json(); },
    async newGame() { return (await post("/api/new-game")).json(); },
  };
}
