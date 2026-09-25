"""
Drive the port in headless Chromium: serve the repo, open the page, run a script of
actions, and save screenshots plus everything the page logged.

    python tools/verify/drive.py OUTDIR "wait 3000" "shot boot" "click 300 300" ...

Actions (stage coordinates; the viewport is the 600x400 stage at 1:1 unless --scale):
    wait MS            let the game run
    frames N           wait until the player has run N more frames
    shot NAME          screenshot -> OUTDIR/NAME.png
    click X Y          left click
    down X Y / up X Y  press / release
    move X Y           move the mouse
    key NAME           press and release a key (Playwright names: Space, Enter, a, ...)
    type TEXT          type text
    eval JS            evaluate JS in the page and print the result
    boot               click LOAD GAME and wait until the game's first frame has run
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
    ap.add_argument('--page', default='index.html')
    ap.add_argument('--root', default=ROOT)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    httpd = serve(args.root, args.port)
    log = []
    s = args.scale
    with sync_playwright() as p:
        browser = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
        page = browser.new_page(viewport={'width': int(600 * s), 'height': int(400 * s)})
        page.on('console', lambda m: log.append('[%s] %s' % (m.type, m.text)))
        page.on('pageerror', lambda e: log.append('[pageerror] %s' % e))
        page.on('requestfailed', lambda r: log.append('[requestfailed] %s %s' % (r.url, r.failure)))
        page.goto('http://127.0.0.1:%d/%s' % (args.port, args.page))
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
            elif op in ('click', 'down', 'up', 'move'):
                x, y = [float(v) * s for v in rest.split()]
                page.mouse.move(x, y)
                if op == 'click':
                    page.mouse.down()
                    page.wait_for_timeout(60)
                    page.mouse.up()
                elif op == 'down':
                    page.mouse.down()
                elif op == 'up':
                    page.mouse.up()
            elif op == 'key':
                page.keyboard.press(rest)
            elif op == 'type':
                page.keyboard.type(rest, delay=60)
            elif op == 'boot':
                page.wait_for_function('() => window.player && player.levels[0] && player.levels[0].$cur >= 15', timeout=60000)
                page.mouse.click(300 * s, 373 * s)
                page.wait_for_function('() => player.levels[1] && !player.levels[1].$pending && player.levels[1].$cur === 201', timeout=180000)
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
