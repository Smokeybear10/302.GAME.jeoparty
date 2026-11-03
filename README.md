# Jeoparty! | Trivia

**Live demo: [jeoparty.thomasou.com](https://jeoparty.thomasou.com)**

Jeopardy-style trivia with multiplayer rooms, a one-screen party mode, and solo practice. Share a room link for up to eight players on separate devices, or gather two to six players around one screen.

The public site runs on Render's free plan, so the first visit after inactivity can take about a minute. Open [`/party`](https://jeoparty.thomasou.com/party) for local party play or [`/practice`](https://jeoparty.thomasou.com/practice) for solo practice. Both save progress in the current browser.

The game can load real historical boards from the compressed archive maintained
by [howardchung/jeopardy](https://github.com/howardchung/jeopardy). By default it
serves every complete playable episode, including its Daily Double and Final
Jeopardy clues. The original 20 boards remain as an offline fallback.

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
- Restores host and player sessions after an ordinary Wi-Fi interruption
- Includes thousands of complete archived games spanning decades of Jeopardy
- Filters the archive by broadcast year and supports room-scoped custom boards
- Includes twelve themed party boards and random 7×7 boards from a pool of 14,000 archived clues
- Saves the full party board, players, scores, and clue progress for later resumption

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

## Play on one screen

Open **Party** from the home page. Choose a themed board or a random 7×7 mix, enter two to six names, and start. The host opens a clue, reveals its answer, and awards or deducts its value from a player, or skips the clue. This mode has no phone buzzers, Daily Doubles, or Final Jeopardy.

The selected board and progress save together in the browser. Share a board link to let another group play the same questions with their own players and scores. Local party answers are available to the host; multiplayer rooms retain their separate private-answer rules.

The party data comes from Buzzer's themed boards and archived clue pool, now consolidated into Jeoparty. The board files live in `data/party/`.

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

Rooms live in memory. A fully disconnected room expires after 12 hours of inactivity, while a room with at least one connected device remains active. Stopping the Node.js process ends all rooms; scores and progress are intentionally not written to disk.

## Question bank

Run `npm run build` to download Howard's roughly 30 MB compressed archive and
prepare all complete playable episodes in `data/archive/howard-playable.json`.
Both generated files are gitignored. The server loads the prepared bank at
startup; an older local installation with only the compressed archive still works.

Render runs the syntax checks and test suite before each build, then starts one
Node.js instance with `npm start` and checks `/health`. Deploys and server restarts
end current multiplayer rooms.

```bash
JEOPARDY_ARCHIVE_LIMIT=1000 npm start  # newest 1,000 playable episodes
JEOPARDY_ARCHIVE_LIMIT=0 npm start     # full playable archive (the default)
```

If the archive file is absent, the server loads the original bank in
[`data/games`](data/games).

Archived boards contain text only. Some clues refer to images or audio from the
original broadcast that are not included; use **Skip clue** for those questions.

Each multiplayer game requires exactly six categories, five clues per category, one Daily
Double, and one Final Jeopardy clue. This abbreviated example shows the object
shape:

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
| `lib/game-store.js` | Multiplayer question-bank selection and validation |
| `lib/party-games.js` | Themed party boards and seeded random-board generation |
| `data/party/` | Bundled party boards and the random clue pool |
| `party.html`, `party.js`, `party-state.js`, `party.css` | Single-screen party play and browser persistence |
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
