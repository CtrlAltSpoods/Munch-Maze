# Munch Maze

A self-hosted, multiplayer maze-chase game that runs in any web browser.

Everyone who enters the same **seed** shares one maze. Players eat pellets together, dodge ghosts, and clear the level to unlock the next one, which is bigger. Levels are generated from the seed, so the same seed always gives the same mazes.

- Level 1 is a 15×11 maze with 1 slow ghost. Each level adds 4 tiles in each direction, up to 63×51, with faster and more numerous ghosts (up to 6).
- No player limit, no accounts, no external services, no npm dependencies.
- Players share an invite link (`http://your-server:8080/#seed-name`) to land in the same maze.
- High scores are kept in `/data/scores.json`.

## Run it

```sh
docker run -d --name munch-maze -p 8080:8080 -v ./data:/data ghcr.io/YOUR_GITHUB_USERNAME/munch-maze:latest
```

Then open `http://<host>:8080`. A `compose.yaml` is included as well.

Without Docker (Node 20 or newer):

```sh
npm start        # serves on :8080
npm test         # end-to-end smoke test
```

## Settings

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8080` | Port inside the container |
| `SERVER_NAME` | `Munch Maze` | Shown in the browser tab |
| `MAX_PLAYERS_PER_MAZE` | `0` | `0` means unlimited |
| `MAX_MAZES` | `200` | How many seeds can run at once |
| `SHOW_LOBBY` | `true` | List running mazes on the start screen; set `false` for private games |
| `DEFAULT_SEED` | *(empty)* | Seed used when a player leaves it blank; empty means random |
| `TICK_RATE` | `30` | Simulation steps per second (10–60) |
| `DATA_DIR` | `/data` | Where `scores.json` lives |
| `PUID` / `PGID` | `1000` / `1000` | Owner of the data folder. Unraid's template uses `99` / `100` |

The container starts as root only to `chown` the data folder, then switches to `PUID:PGID`.

### Behind a reverse proxy

The game uses a WebSocket at `/ws`, so the proxy must pass `Upgrade` and `Connection` headers. In Nginx Proxy Manager, tick **Websockets Support**. SWAG and Traefik handle it by default. Serving from a sub-path works as long as the proxy strips the prefix.

## How it works

- `shared/maze.js` builds a level from `seed + level number`. It is loaded by both the server and the browser, so both always build the identical maze. A level is a mirrored maze with a central ghost house, extra loops, no dead ends, and a wrap-around tunnel from level 2.
- `server/` is plain Node: an HTTP server for the page, a small WebSocket implementation (`ws.js`), and one `Game` per seed (`game.js`). The server owns pellets, ghosts, scores, lives and level changes, and sends state 15 times a second.
- `public/` is the client. Each browser moves its own player for instant controls and reports which pellets it ate. The server checks that the player is next to the pellet before awarding points.
- If a player's connection drops, reconnecting within 2 minutes resumes their score and lives.

The server trusts each client's reported position, so a modified client could still move faster than it should. That's fine for friends and home servers. Add stricter movement checks before running a competitive public server.