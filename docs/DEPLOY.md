# Deploying to Fly.io

The hosted version is one shared game behind a password. It runs on a single always-on Fly.io machine with a small volume for the save file.

**Why one machine:** the game is a live `dfrotz` process holding state in memory, so every request must reach the same process. Don't scale past one machine.

**Cost:** about $3–4/month (shared-cpu-1x with 512 MB, always on) plus about $0.15/month for a 1 GB volume. Claude API usage is billed separately by Anthropic if you set a key.

## What's in the repo

- **`Dockerfile`:** builds `dfrotz` 2.54 from source in a build stage, then installs the Python app. The server listens on port 8080.
- **`fly.toml`:** app name, region, health check (`/healthz`), the `zork_data` volume mounted at `/data`, `auto_stop_machines = "off"`.
- **`.dockerignore`:** keeps `.venv`, `data`, `unity` and `.env` out of the image.

You don't need Docker installed. `fly deploy` builds on Fly's remote builders.

## First deploy

```bash
brew install flyctl            # if needed
fly auth login                 # opens a browser

# 1. Create the app (name must be globally unique; edit `app` in fly.toml to change it)
fly apps create zork-cartographer-lxwooxy

# 2. Create the volume for the save file, in the same region as fly.toml
fly volumes create zork_data --region ewr --size 1 --yes

# 3. Secrets
fly secrets set ZORK_PASSWORD='choose-a-password'
fly secrets set ANTHROPIC_API_KEY='sk-ant-...'     # optional

# 4. Deploy (one machine, no HA pair)
fly deploy --ha=false
```

Then open `https://<app-name>.fly.dev`, enter the password, and play.

## Day to day

```bash
fly deploy --ha=false          # ship code changes
fly logs                       # server logs (look for "Replayed N commands")
fly status                     # machine state
fly ssh console                # shell on the machine; the save is /data/world.json
fly secrets set ZORK_PASSWORD='new-password'    # change the password (restarts the app)
```

Each deploy restarts the machine. On boot the server replays the command log from `/data/world.json`, so the game resumes where it was. A 500-move game replays in about 10–15 seconds.

## Backups

```bash
fly ssh sftp get /data/world.json ./world-backup.json
```

To restore, upload with `fly ssh sftp shell` (`put world-backup.json /data/world.json`), then `fly machine restart`.

## Pointing Unity at the hosted server

In the Unity viewer click **Server…**, enter `https://<app-name>.fly.dev` and the password, then **Connect**.

## Notes

- `force_https` is on. The login cookie is `Secure` and `HttpOnly` over HTTPS.
- Failed logins wait one second before replying, to slow down guessing.
- Anyone with the password plays the same game, including **New game**. Share it only with people you're happy to share a save with.
