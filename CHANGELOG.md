# Changelog

All notable changes to this project are documented in this file.

## [2.0.2.0] - 2026-11-08

- Retry interrupted room restores and keep a manual Retry button available without enabling stale game controls.
- Let an existing contestant take over after the host has been disconnected for 60 seconds, preserving the current game and scores.
- Save completed results independently of rooms, with private links for opening results on another device.
- Limit room creation, action bursts, queued writes, and transport connections while allowing valid custom boards.
- Cover recovery races, database transactions, result privacy, and connection limits with 80 additional tests.

## [2.0.1.0] - 2026-09-02

### Added

- Optional host-as-contestant mode with the same authoritative buzzer order, Daily Double rules, and private Final Jeopardy submissions as remote players.
- A dual-role host buzzer, contestant status, self-judging controls, roster identity, and responsive Final Jeopardy entry forms.
- Explicit private answer-key disclosure with server-enforced commit-or-forfeit rules for a playing host.

### Changed

- Answer keys now stay closed by default for both playing and non-playing hosts.
- Final Jeopardy wager limits are frozen when Final begins so later score corrections cannot change an entrant's cap.
- Lobby and game copy now explains that the host may take one of the eight contestant spots.

### Fixed

- Preserved the host contestant's identity, score, buzz position, key-disclosure state, and Final entry across reconnects and active-tab takeover.
- Prevented a playing host from seeing a private key while retaining an uncommitted attempt or bypassing the commitment before self-scoring.
- Kept remote buzz queues moving after the host forfeits, and prevented committed host attempts from being erased by a buzzer reset.
- Corrected the host buzzer sizing and mobile clue layout so judging controls remain reachable without overlap.

## [2.0.0.0] - 2026-09-01

### Added

- Authoritative Node.js and Socket.IO multiplayer rooms for one host and up to eight local-network players.
- Live synchronized boards, server-ordered buzzing, host scoring, Daily Doubles, private Final Jeopardy submissions, and final standings.
- Resumable host and player sessions with active-tab takeover and safe reconnect behavior.
- A replacement library of 20 original medium-difficulty games with 600 board clues, 20 Daily Doubles, and 20 Finals.
- Automated game-bank, room-engine, privacy, reconnect, authorization, and multi-client integration coverage.

### Changed

- Rebuilt the landing and room lobby around a dense, responsive, Lichess-inspired game browser.
- Split the warm charcoal lobby palette from the cobalt-and-gold board presentation.
- Improved mobile ordering, bounded game lists, touch targets, keyboard focus handling, dialog focus trapping, and screen-reader labels.
- Moved hidden responses and authoritative game state to the server so player clients receive only role-appropriate data.
- Expanded the README with setup, LAN hosting, player instructions, architecture, question-bank schema, and troubleshooting guidance.

### Fixed

- Kept reconnect credentials valid when a resume acknowledgement is lost.
- Rejected buzzes on the server while the host is offline.
- Immediately locked Final Jeopardy forms after keyboard or button submission.
- Corrected clue wording, difficulty inversions, answer giveaways, and repeated concepts found during the final content audit.

### Removed

- The old browser-bundled game bank and its backup copies.
