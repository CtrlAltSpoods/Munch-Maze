# Munch Maze

A self-hosted, multiplayer maze-chase game that runs in any web browser.

Everyone who enters the same **seed** shares one maze. Players eat pellets together, dodge ghosts, and clear the level to unlock the next one, which is bigger. Levels are generated from the seed, so the same seed always gives the same mazes.

- Level 1 is a 15×11 maze with 1 ghost. Each level adds 4 tiles in each direction, up to 63×51, and more ghosts (up to 6).
- Every completed level makes the game **10% faster** (compounding: ×1.10, ×1.21, ×1.33 … about ×2.14 by level 9), for players and ghosts alike.
- Every new maze opens in a **lobby**: players gather, see who's in and copy the invite link, and the host presses *Start game* when everyone's ready. The running-mazes list marks mazes that are still in their lobby.
- Between levels the maze pauses for the **host**, the player who started it, who presses *Start level N* (or Enter/Space) when everyone is ready. Other players see who they're waiting for. If the host leaves, the longest-present player takes over, and the original host gets it back if they return.
- No player limit, no accounts, no external services, no npm dependencies.
- Each maze is **Public** (listed under “Mazes running now” for anyone on the server) or **Invite only** (never listed; joined through a private link like `http://your-server:8080/#seed-name~k3j9x2m4p8qa`). Typing the same seed without the link starts a separate maze, so private games stay private.
- Ten player characters (Chomper, Saucer, Robot, Slime, Shark, Cat, Rocket, Bee, Frog and Gem), each in five colours, picked on the start screen and remembered per browser.
- Neon arcade presentation: glowing mazes that pulse with the music, softly chasing marquee lights, a warp-speed starfield (with the rare planet drifting past) that speeds up with the game and with your streak, sparks, coin showers and confetti. Eat pellets back to back to build a **streak** (NICE → SWEET → ON FIRE → JACKPOT → MEGA JACKPOT); from a 100 streak the screen rumbles gently until the streak ends, and clearing a level spins slot reels to reveal the next maze. These are visual and sound rewards only; scores come from the server. Players with *reduce motion* turned on get no screen shake, softer flashes and fewer particles. Fonts load from Google Fonts, falling back to system fonts offline.
- An original electro soundtrack and arcade sound effects, generated live in the browser. Music and effects have their own volume sliders (10% and 40% by default, remembered per browser); press **M** to mute.
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
| `MAX_CONNECTIONS` | `1000` | Most players connected at once across the server; `0` = no limit |
| `MAX_CONNECTIONS_PER_IP` | `20` | Most connections from one address; `0` = no limit |
| `ALLOWED_ORIGINS` | *(empty)* | Other websites allowed to open game connections, comma-separated (`https://site.example`), or `*` for any |
| `TRUST_PROXY` | `false` | Set `true` behind a reverse proxy so per-IP limits and Origin checks use `X-Forwarded-For` / `X-Forwarded-Host` |
| `DATA_DIR` | `/data` | Where `scores.json` lives |
| `PUID` / `PGID` | `1000` / `1000` | Owner of the data folder. Unraid's template uses `99` / `100` |

The container starts as root only to `chown` the data folder, then switches to `PUID:PGID`.

### Connection safety

- Only the game's own page can open game connections. Browsers on other websites are refused unless listed in `ALLOWED_ORIGINS`.
- Each address can hold `MAX_CONNECTIONS_PER_IP` connections, and the server holds `MAX_CONNECTIONS` in total. Players who disconnect free their slot straight away; dead connections are dropped after 45 seconds of silence.
- The WebSocket layer follows RFC 6455 strictly: unmasked, oversized, badly fragmented or non-UTF-8 frames close the connection. `npm test` checks all of this.

### Behind a reverse proxy

The game uses a WebSocket at `/ws`, so the proxy must pass `Upgrade` and `Connection` headers. Set `TRUST_PROXY=true`, otherwise every player appears to come from the proxy's address and the per-IP limit applies to all of them together. If the proxy rewrites the `Host` header, also set `ALLOWED_ORIGINS` to your public address (for example `https://maze.example.com`). In Nginx Proxy Manager, tick **Websockets Support**. SWAG and Traefik handle it by default. Serving from a sub-path works as long as the proxy strips the prefix.

## How it works

- `shared/maze.js` builds a level from `seed + level number`. It is loaded by both the server and the browser, so both always build the identical maze. A level is a mirrored maze with a central ghost house, extra loops, no dead ends, and a wrap-around tunnel from level 2.
- `server/` is plain Node: an HTTP server for the page, a small WebSocket implementation (`ws.js`), and one `Game` per seed (`game.js`). The server owns pellets, ghosts, scores, lives and level changes, and sends state 15 times a second.
- `public/` is the client. Each browser moves its own player for instant controls and reports which pellets it ate. The server checks that the player is next to the pellet before awarding points.
- If a player's connection drops, reconnecting within 2 minutes resumes their score and lives.

The server trusts each client's reported position, so a modified client could still move faster than it should. That's fine for friends and home servers. Add stricter movement checks before running a competitive public server.