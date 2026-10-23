# Jeoparty! | Multiplayer Trivia

**Live demo: [jeoparty.thomasou.com](https://jeoparty.thomasou.com)**

A browser-based Jeopardy-style game for up to eight players. Share a room link and join from a phone or computer. The room creator can play alongside friends or run a dedicated host screen.

The public site runs on Render's free plan, so the first visit after inactivity can take about a minute. Trivia practice is available at [`/practice`](https://jeoparty.thomasou.com/practice), with progress saved in each browser.

The game can load real historical boards from the compressed archive maintained
by [howardchung/jeopardy](https://github.com/howardchung/jeopardy). By default it
serves complete text-playable episodes with both boards, their original Daily
Doubles, and Final Jeopardy. The original 20 single-round boards remain as an offline fallback.

## What it does

- Creates a private five-character room code for each game
- Keeps the board, clues, buzz order, and scores synchronized across every device
- Lets players use their phone as a low-latency buzzer
- Lets the room creator join the contestants, with the same private answer checks and scoring rules
- Uses a compact episode browser, responsive game board, and individual scorecards
- Sends each answer only to the active contestant, who checks and scores their own spoken response
- Reopens buzzing after an incorrect response while locking out that player for the clue
- Supports host-assigned Daily Double contestants and wagers
- Runs private Final Jeopardy wagers, written responses, and contestant self-judging
- Restores host and player sessions after Wi-Fi interruptions and server restarts
- Keeps the last 100 completed games in each browser, with dates, final scores, and replay for boards still in the archive
- Includes thousands of complete archived games spanning decades of Jeopardy
- Filters the archive by broadcast year and supports room-scoped custom boards

## Requirements

- [Node.js](https://nodejs.org/) 20 or newer
- For local hosting, all participating devices connected to the same local network or Wi-Fi

## Start the server

```bash
git clone https://github.com/Smokeybear10/303.GAME.jeoparty.git
cd 303.GAME.jeoparty
npm install
npm run fetch:archive
npm start
```

The server listens on port `3000` and prints addresses similar to these:

```text
Jeoparty! multiplayer is live.
Open one of these addresses:
  http://localhost:3000
  http://192.168.1.42:3000
```

Open either address on the host computer. Players must use the `192.168.x.x`-style local-network address—not `localhost`—because `localhost` always points back to the device currently holding it.

To use a different port:

```bash
PORT=8080 npm start
```

## Host a game

1. Open the server address and select **Create room**, choose an episode directly, or select **Custom board**.
2. To play too, enter your name under **Playing too?** and select **Join as player**.
3. Share the player link or five-character room code, choose a board, and select **Start game** once a player has joined.
4. In a game where the creator plays, the player who answers correctly picks next. A dedicated host controls clue selection otherwise.
5. Use **Final →** when you are ready to finish and at least one player has a positive score.

The host can adjust scores manually, reset buzzers before an answer check starts, show an unclaimed answer on contestant screens, close clues, remove players, reset the board, or return to the game library.

### Answer privacy

A dedicated host never receives clue or Final Jeopardy answers. A creator who joins as a player follows the same rules as everyone else: the active contestant says their response aloud, selects **Check my response**, and privately checks and scores it. An incorrect response promotes the next queued buzzer; a Daily Double closes after either result. **Show answer to players** reveals an unclaimed answer to contestants. Any contestant can also use **Skip clue**, including after being locked out.

## Join as a player

1. Open the shared room link on a phone or laptop. For a locally hosted game, use the host's local-network address on the same Wi-Fi.
2. Enter the room code and a display name.
3. Keep the page open while the host chooses a game.
4. When a clue appears, tap **Buzz in** or press **Space**. The host sees everyone in server-received order.
5. If you are first, say your response aloud, check the official response on your device, and mark yourself correct or incorrect.
6. Players with a positive score can submit a private Final Jeopardy wager and response, then self-score it from their device.

## How multiplayer works

```text
Host browser ─┐
Player phones ├── Socket.IO ── Node.js room server ── archive or bundled boards
Player laptop ┘                     │
                                    └── authoritative scores and archive-backed game state
```

The server validates identity, active clue, buzz position, and score transitions before broadcasting a role-specific state update. Only the active contestant receives a private clue answer. Final Jeopardy wagers and written responses remain private to their owners; the dedicated host receives progress status.

Room changes are saved before the server confirms them. Restarting restores room codes, scores, board progress, wagers, and responses; players reconnect with their existing tab credentials. A fully disconnected room expires after 12 hours. The selected episode is saved with the room so archive updates cannot change a game already in progress.

Past games are saved on each participating browser when it receives the final standings. Results remain after leaving a room, but do not sync across devices and are removed when browser site data is cleared. A returning player can recover missed results while the room still exists; closing the room removes that server copy. History stores player names and scores, not credentials or private answers.

Locally, `npm start` saves to `data/rooms/saved-games.json`, which is private to the server and excluded from Git. Set `JEOPARDY_SAVE_PATH` to change that location. On Render, set the private `DATABASE_URL` environment variable to a PostgreSQL connection string. Local files on Render are temporary, so startup requires the database rather than silently using them for saves. Use the database provider's TLS connection string and run one server instance; conflicting writers are rejected to prevent overwriting newer games.

## Question bank

Run `npm run build` to download Howard's roughly 30 MB compressed archive and
prepare complete two-round episodes in `data/archive/howard-playable.json`.
Both generated files are gitignored. The server loads the prepared bank at
startup; old caches are rebuilt from the compressed archive. Episodes with identifiable missing-media references are excluded. This uses clue and category text, so it is not an exhaustive review of every clue.

Render runs the syntax checks and test suite before each build, then starts one
Node.js instance with `npm start` and checks `/health`. Configure `DATABASE_URL`
before deploying this version so multiplayer rooms survive restarts.

```bash
JEOPARDY_ARCHIVE_LIMIT=1000 npm start  # newest 1,000 playable episodes
JEOPARDY_ARCHIVE_LIMIT=0 npm start     # full playable archive (the default)
```

If the archive file is absent, the server loads the original bank in
[`data/games`](data/games).

Archived boards contain text only. If a media-dependent clue slips through the
filter, use **Skip clue**; skipping never changes scores.

The first board requires six categories with five clues each and one Daily Double.
The optional `doubleJeopardy.categories` board has the same shape, values from
$400 to $2,000, and two Daily Doubles. Every game includes Final Jeopardy.
This abbreviated example shows a single-round game's shape:

```json
{
  "id": "game-example",
  "title": "Example Game",
  "description": "A balanced mix of familiar subjects.",
  "difficulty": "Medium",
  "categories": [
    {
      "name": "SCIENCE",
      "clues": [
        {
          "value": 200,
          "clue": "This planet is known as the Red Planet.",
          "answer": "What is Mars?",
          "dailyDouble": true
        }
      ]
    }
  ],
  "finalJeopardy": {
    "category": "SPACE",
    "clue": "This is the largest planet in our solar system.",
    "answer": "What is Jupiter?"
  }
}
```

The server validates the complete bank at startup and refuses to launch if a file is malformed, an ID or title is duplicated, a category is incomplete, clue values are out of order, or a game does not contain exactly one Daily Double.

## Development

```bash
npm run dev    # restart automatically when server files change
npm run check  # syntax-check the server and browser JavaScript
npm test       # run game-bank, room-engine, privacy, and socket integration tests
```

See the [changelog](CHANGELOG.md) for release history.

## Project structure

| Path | Purpose |
| --- | --- |
| `server.js` | HTTP server, Socket.IO events, room broadcasts, and local-network addresses |
| `lib/room-manager.js` | Authoritative room, buzzer, scoring, Daily Double, and Final Jeopardy rules |
| `lib/game-store.js` | Question-bank selection and validation |
| `lib/howard-archive.js` | Historical episode archive conversion |
| `scripts/fetch-howard-archive.js` | Downloads and validates the compressed archive |
| `data/archive/*.gz` | Gitignored Howard archive downloaded locally |
| `data/games/*.json` | The original 20-game fallback bank |
| `index.html` | Host and player application shell |
| `app.js` | Synchronized host/player rendering and controls |
| `style.css` | Responsive lobby, board, buzzer, and Final Jeopardy design |
| `ui.css` | Lobby, board, clue, and scoreboard styling |
| `test/` | Unit and multi-client integration tests |

## Local-network troubleshooting

- Make sure every device is connected to the same Wi-Fi network.
- Share the address beginning with your computer's local IP, such as `192.168.1.42`, rather than `localhost`.
- Allow incoming Node.js connections if macOS or Windows shows a firewall prompt.
- Guest Wi-Fi and some corporate or school networks block devices from talking to each other. Use a normal home network or a phone hotspot if players cannot connect.
- Keep the terminal running for the entire game.

This server is intended for a trusted local network. The room code is convenient game-night access, not production-grade authentication; do not expose the server directly to the public internet.

## Disclaimer

This is an unofficial fan-made project and is not affiliated with or endorsed by Jeopardy Productions, Inc. or Sony Pictures Television.
