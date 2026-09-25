"""
Drive the port in headless Chromium: serve the repo, open the page, run a script of
actions, and save screenshots plus everything the page logged.

    python tools/verify/drive.py OUTDIR "wait 3000" "shot boot" "click 300 300" ...

Actions (stage coordinates; the viewport is the 600x400 stage at 1:1 unless --scale):
    wait MS            let the game run
    frames N           wait until the player has run N more frames
    shot NAME          screenshot -> OUTDIR/NAME.png
    click X Y          left click, held for two frames
    clickjs JS         left click at the stage point [x, y] that JS evaluates to
    down X Y / up X Y  press / release
    move X Y           move the mouse
    key NAME           press and release a key (Playwright names: Space, Enter, a, ...)
    keydown NAME       hold a key down (keyup NAME releases it)
    type TEXT          type text
    eval JS            evaluate JS in the page and print the result
    boot               click LOAD GAME and wait until the game's first frame has run
    step N             (--test) advance exactly N frames

With --test the page runs with ?test&seed=S: the clock is stopped and frames advance only
on "step", so a run is repeatable.  "boot" then steps the loader to its button, clicks,
waits for the game to download without advancing, steps to the game's first frame, and
waits there for dialogue.xml.
    grid NAME A B ...  tile earlier screenshots A, B, ... two across into NAME.png
"""

import argparse
import functools
import http.server
import json
import os
import sys
import threading
import time

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


def serve(root, port):
    handler = functools.partial(QuietHandler, directory=root)
    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', port), handler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('out')
    ap.add_argument('actions', nargs='*')
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--scale', type=float, default=1.0)
    ap.add_argument('--viewport', help='WxH in CSS pixels (default: the stage times --scale)')
    ap.add_argument('--dpr', type=float, default=1.0, help='device pixel ratio')
    ap.add_argument('--page', default='index.html')
    ap.add_argument('--root', default=ROOT)
    ap.add_argument('--browser', default='chromium', choices=['chromium', 'firefox', 'webkit'])
    ap.add_argument('--test', action='store_true', help='stopped clock, seeded random numbers')
    ap.add_argument('--seed', type=int, default=1)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    httpd = serve(args.root, args.port)
    log = []
    s = args.scale
    with sync_playwright() as p:
        if args.browser == 'chromium':
            browser = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
        else:
            browser = getattr(p, args.browser).launch()
        if args.viewport:
            vw, vh = [int(v) for v in args.viewport.lower().split('x')]
        else:
            vw, vh = int(600 * s), int(400 * s)
        page = browser.new_page(viewport={'width': vw, 'height': vh}, device_scale_factor=args.dpr)

        def to_page(x, y):
            # Stage coordinates -> CSS pixels, through the letterboxed stage (the reference
            # page has no player object, and fills the same viewport with the same fit).
            return page.evaluate("""([x, y]) => {
                const W = innerWidth, H = innerHeight, k = Math.min(W / 600, H / 400);
                return [(W - 600 * k) / 2 + x * k, (H - 400 * k) / 2 + y * k];
            }""", [x, y])
        page.on('console', lambda m: log.append('[%s] %s' % (m.type, m.text)))
        page.on('pageerror', lambda e: log.append('[pageerror] %s' % e))
        # Chromium reports some of the parallel library downloads as net::ERR_ABORTED even
        # though every byte arrives (the page parses and decodes them); only real failures
        # are worth logging.
        page.on('requestfailed', lambda r: r.failure == 'net::ERR_ABORTED' or
                log.append('[requestfailed] %s %s' % (r.url, r.failure)))
        query = 'test&seed=%d' % args.seed if args.test else ''
        page_url = args.page
        if query:
            page_url += ('&' if '?' in page_url else '?') + query
        page.goto('http://127.0.0.1:%d/%s' % (args.port, page_url))
        t0 = time.time()
        for act in args.actions:
            op, _, rest = act.partition(' ')
            if op == 'wait':
                page.wait_for_timeout(int(rest))
            elif op == 'frames':
                n = int(rest)
                page.wait_for_function('(n) => window.player && (window.__f0 === undefined ? (window.__f0 = player.frame, false) : player.frame - window.__f0 >= n)', arg=n, timeout=120000)
                page.evaluate('() => { delete window.__f0; }')
            elif op == 'shot':
                page.screenshot(path=os.path.join(args.out, rest + '.png'))
            elif op == 'clickjs':
                sx, sy = page.evaluate(rest)
                x, y = to_page(sx, sy)
                page.mouse.move(x, y)
                page.mouse.down()
                if args.test:
                    page.evaluate('() => __step(2)')
                else:
                    page.wait_for_timeout(90)
                page.mouse.up()
            elif op in ('click', 'down', 'up', 'move'):
                x, y = to_page(*[float(v) for v in rest.split()])
                page.mouse.move(x, y)
                if op == 'click':
                    # The game polls the mouse once a frame, so a click has to span frames,
                    # as a person's does (a click inside one frame is missed in Flash too).
                    page.mouse.down()
                    if args.test:
                        page.evaluate('() => __step(2)')
                    else:
                        page.wait_for_timeout(90)
                    page.mouse.up()
                elif op == 'down':
                    page.mouse.down()
                elif op == 'up':
                    page.mouse.up()
            elif op == 'key':
                page.keyboard.press(rest)
            elif op == 'keydown':
                page.keyboard.down(rest)
            elif op == 'keyup':
                page.keyboard.up(rest)
            elif op == 'type':
                page.keyboard.type(rest, delay=60)
            elif op == 'boot' and args.test:
                page.wait_for_function('() => window.player && player.levels[0]', timeout=60000)
                page.evaluate('() => { while (player.levels[0].$cur < 15) __step(1); }')
                page.mouse.click(*to_page(300, 373))
                page.wait_for_function('() => player.levels[1] && !player.levels[1].$pending', timeout=180000)
                page.evaluate('() => { let n = 0; while (player.levels[1].$cur !== 201 && n++ < 1000) __step(1); }')
                # The game's first frame loads dialogue.xml and builds its Panel when it
                # arrives; wait for that without advancing, so it lands on the same frame.
                page.wait_for_function('() => player.levels[1].panel', timeout=60000)
            elif op == 'boot':
                page.wait_for_function('() => window.player && player.levels[0] && player.levels[0].$cur >= 15', timeout=60000)
                page.mouse.click(*to_page(300, 373))
                page.wait_for_function('() => player.levels[1] && !player.levels[1].$pending && player.levels[1].$cur === 201', timeout=180000)
            elif op == 'step':
                page.evaluate('(n) => __step(n)', int(rest))
            elif op == 'grid':
                name, *shots = rest.split()
                ims = [Image.open(os.path.join(args.out, n + '.png')) for n in shots]
                w, h = ims[0].size
                cols = 2 if len(ims) > 1 else 1
                sheet = Image.new('RGB', (w * cols, h * ((len(ims) + cols - 1) // cols)))
                for i, im in enumerate(ims):
                    sheet.paste(im, ((i % cols) * w, (i // cols) * h))
                sheet.save(os.path.join(args.out, name + '.png'))
            elif op == 'eval':
                r = page.evaluate(rest)
                print('eval:', json.dumps(r)[:4000])
            else:
                raise SystemExit('unknown action ' + op)
            log.append('--- %6.2fs %s' % (time.time() - t0, act))
        browser.close()
    httpd.shutdown()
    httpd.server_close()
    with open(os.path.join(args.out, 'log.txt'), 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(log) + '\n')
    print('\n'.join(log[-80:]))


if __name__ == '__main__':
    main()
