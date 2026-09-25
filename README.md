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
- `render.js` — Canvas 2D drawing, masks, colour transforms, filters (as SVG filters)
- `text.js` — text fields, laid out from the embedded font outlines
- `sound.js` — event sounds through Web Audio
- `player.js`, `as2.js` — the frame loop, input, and ActionScript's built-in classes

`src/main.js` does what the original `Launcher.html` did: it starts `loader.swf` with the
same parameters, and the loader loads the game exactly as before.

## Differences from the original

- **High scores.** The game submitted and fetched scores from LEGO's servers, which no
  longer exist. Those requests are not made.
- **Tracking.** The loader fetched a third-party page counter; it is not fetched.
- **Right-click** does nothing, where the original showed a one-item menu linking to
  lego.com.
- **Size.** The 600×400 stage is scaled to fit the window, letterboxed, as Flash's
  "show all" mode would.

## Checking it against the original

`tools/verify/compare.py` drives this port and the original SWFs (in
[Ruffle](https://ruffle.rs)) with the same clicks and keys in headless Chromium, and
saves the screenshots side by side. It needs Python with Playwright and Pillow, plus a
`reference/` folder, which is not committed:

```
reference/ruffle/      Ruffle's self-hosted web build (ruffle-*-web-selfhosted.zip)
reference/swf/         loader.swf, game(original).swf renamed game.swf, dialogue.xml
```

## Credits

*CrystAlien Conflict* was made by 4T2 Multimedia for LEGO in 2007. LEGO and Mars Mission
are trademarks of the LEGO Group.
