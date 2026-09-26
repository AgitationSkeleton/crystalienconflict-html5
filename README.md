# CrystAlien Conflict (HTML5)

The 2007 LEGO Mars Mission strategy game *CrystAlien Conflict*, running in a modern
browser with no Flash Player.

This is not a remake. The page plays the original SWF's own content — its bitmaps,
vector shapes, animations, sounds, text, and its ActionScript translated line for line
into JavaScript — on a small Flash-compatible player written for it. The aim is that it
looks, sounds and plays exactly like the Flash original.

## Playing

Hosted with GitHub Pages. To run it locally, serve the repository root over HTTP (opening
`index.html` from disk will not work, because browsers block `fetch` on `file://`):

```
python -m http.server 8000
```

then open <http://localhost:8000/>.

## How it works

| Step | Tool | Output |
|---|---|---|
| Decode media and deobfuscate the ActionScript | `tools/extract.py` (runs [JPEXS FFDec](https://github.com/jindrapetrik/jpexs-decompiler)) | `work/ffdec/` (not committed) |
| Parse the SWFs: shapes, timelines, buttons, text, fonts | `tools/build_library.py` with `tools/swf/` | `data/*.json`, `assets/*/*.bin` |
| Translate ActionScript 2 to JavaScript | `tools/transpile.py` | `src/scripts/*.js` |

At runtime, `src/flash/` is the player:

- `display.js` — the display list, timelines, and the MovieClip/Button/TextField API
- `render.js` — Canvas 2D drawing, masks, colour transforms; objects with filters are
  cached as bitmaps, as Flash did
- `filters.js` — Flash's blur, glow, drop shadow and colour matrix filters on the GPU
  (WebGL2), computed the way Flash Player computed them; where WebGL is missing or
  software-rendered, `render.js` approximates them with SVG filters instead
- `text.js` — text fields, laid out from the embedded font outlines
- `sound.js` — event sounds through Web Audio
- `player.js`, `as2.js` — the frame loop, input, and ActionScript's built-in classes

`src/main.js` does what the original `Launcher.html` did: it starts `loader.swf` with the
same parameters, and the loader loads the game exactly as before.

## Differences from the original

- **High scores.** The game submitted and fetched scores from LEGO's servers, which no
  longer exist. It talks to a server of the port's own instead (`cacserver.viosarcade.xyz`,
  shared with the online version; its code is in that repository's `server/`), with the
  game's own requests and checks unchanged. LEGO's server knew who was logged in: here the
  page asks for a name when a finished Conflict run's score is sent, and the line that said
  the score was saved to lego.com says it goes on the high score table.
- **Tracking.** The loader fetched a third-party page counter; it is not fetched.
- **Right-click** does nothing, where the original showed a one-item menu linking to
  lego.com.
- **Size.** The 600×400 stage is scaled to fit the window, letterboxed, as Flash's
  "show all" mode would.
- **Smoothness.** The game runs at Flash's 23 frames a second, but the screen is drawn at
  every refresh: what moved in the last frame is shown part of the way to where it is, and
  the game's pointer is drawn where the mouse is.
- **Saving.** Progress goes to the browser's localStorage. Flash wrote its save when
  the player closed; this also writes it whenever the page is hidden, and every few
  seconds if it changed, because a browser tab can be closed without warning.

## Where JavaScript and ActionScript 2 differ

The translated scripts run as JavaScript, so wherever the two languages disagree the
runtime or the translator has to supply ActionScript's behaviour. The ones this game
depends on, each found by comparing the port with the original:

- `a <= b` and `a >= b` are compiled as `!(a > b)` and `!(a < b)`, which are true when
  either side is NaN or undefined.
- `null` becomes NaN in arithmetic, like `undefined`.
- Strings convert to numbers by Flash's rules (`""` is NaN, `"010"` is octal), and
  numbers print with 15 significant digits.
- `Array.sortOn` is Flash's unstable quicksort; the pathfinder depends on its order.
- A timeline variable hides a child clip of the same name.
- `for..in` runs newest-first.

## Checking it against the original

`tools/verify/compare.py` drives this port and the original SWFs (in
[Ruffle](https://ruffle.rs)) with the same clicks and keys in headless Chromium, and
saves the screenshots side by side. It needs Python with Playwright and Pillow, plus a
`reference/` folder, which is not committed:

```
reference/ruffle/      Ruffle's self-hosted web build (ruffle-*-web-selfhosted.zip)
reference/swf/         loader.swf, game(original).swf renamed game.swf, dialogue.xml
```

Ruffle is a very good reference, but not a perfect one: it does not show the colour
matrix that turns the terrain white on the Christmas level, which the port does.

For repeatable runs, open the page as `index.html?test&seed=1`: the clock stops, frames
advance only when `__step(n)` is called, and random numbers follow the seed. Adding
`glfilters` forces the GPU filters even on a software renderer (headless Chromium).
`tools/verify/drive.py --test` scripts runs that way, and `tools/verify/smoke.py` plays
a set of scenarios, including thousands of frames of random input on several levels,
and fails on any script error.

## Credits

*CrystAlien Conflict* was made by 4T2 Multimedia for LEGO in 2007. LEGO and Mars Mission
are trademarks of the LEGO Group.
