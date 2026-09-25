# High-score server: plan

Status: planned, not built. The game's own high-score code is intact in the port; it
only needs a server to talk to, and the port's `LoadVars.sendAndLoad` needs to actually
send (it is a no-op today, see `src/flash/as2.js`).

## What the game does

Everything below is the original ActionScript (`src/scripts/game.js`), unchanged.

- **When a score is sent.** On finishing Conflict mode (`state = "gameComplete"`), if the
  launcher passed a `username` and no cheats were used. The score is
  `Math.round(300000000 / frames taken)`: faster is higher. Without a `username` the
  game shows its "log in to save your score" line instead (dialogue `int_gameComplete2`).
- **Where.** `serviceurl` from the launcher parameters, defaulting to LEGO's dead
  `http://services.3rd.corp.lego.com/hiscore/default.asmx`.
- **Reading** (`getScores`, when the HIGH SCORES button is pressed):
  `GET {serviceurl}/GetScores?gamename=CrystAlienConflict`. The reply is XML: one child
  element per row under the root, each with a `score` attribute and a first child
  element whose text is the player's name. The table shows the first 15, names upper-cased
  and cut to 15 characters.
- **Writing** (`saveScore`): `POST {serviceurl}/SaveScore`, form-encoded fields
  `gamename`, `score`, and `hash = SHA1(secret + "SaveScore" + gamename + score)`, where
  `secret` is a constant in the SWF. The player's name is **not** sent: LEGO's server
  knew who was logged in.

## Server

A Cloudflare Worker on the viosarcade.xyz account, e.g. `scores.viosarcade.xyz`, with a
D1 (SQLite) database. The free tier is far beyond a leaderboard's needs.

- `GET /GetScores?gamename=` returns the game's XML: top 15 by score, then oldest first.
- `POST /SaveScore` with `gamename`, `score`, `hash`, and `username` (added by the port,
  see below). Checks the hash, the name, and plausibility; stores the row.
- CORS: allow `https://cac.viosarcade.xyz` and `https://caconline.viosarcade.xyz`.
- Admin: `DELETE /scores/:id` behind a secret held as a Worker secret, for removing
  junk.

Schema: `scores(id INTEGER PRIMARY KEY, game TEXT, name TEXT, score INTEGER,
created INTEGER, ip_hash TEXT)`.

## Port changes

- Pass `serviceurl` (the Worker) and `username` in the launcher parameters
  (`FLASHVARS` in `src/main.js`).
- Ask for a name once, the first time a score would be saved, and keep it in
  localStorage; the online version can use its settings page's name instead.
- Make `LoadVars.sendAndLoad` POST for real, adding `username` to `SaveScore`.

## Cheating

The hash's secret is inside the SWF, so anyone determined can forge a score. What we can
do: reject impossible scores (a lower bound on frames for a full Conflict run), rate-limit
per IP, cap name length and filter names, and delete entries by hand. That is as much as
the original had.

## Open questions

- Name prompt: the game's own style (an in-canvas box) or a plain page dialog.
- Whether cac. and caconline. share one table or keep two (`gamename` can tell them
  apart).
