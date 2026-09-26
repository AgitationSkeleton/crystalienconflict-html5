"""
How smoothly a level plays: run the game on its own clock in Chromium with the GPU (as a browser
on this machine would) and report the screen's frames -- how far apart they came, how many were
late -- and the game's work in each.

    python tools/verify/fps.py [--level eclipse] [--warm 400] [--seconds 15]
                               [--viewport 1600x900] [--dpr 1] [--software] [--scroll]

The level is started by its code from the main menu, stepped --warm frames, and then the clock
runs for --seconds.  A frame that comes more than 1.5 refreshes after the last is late (one or
more were dropped).  --scroll pans the view back and forth while it runs.  --software uses
Chromium without the GPU (as the other tools do).
"""

import argparse
import functools
import http.server
import json
import os
import threading

from playwright.sync_api import sync_playwright

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--level', default='eclipse')
    ap.add_argument('--warm', type=int, default=400)
    ap.add_argument('--seconds', type=float, default=15)
    ap.add_argument('--viewport', default='1600x900')
    ap.add_argument('--dpr', type=float, default=1)
    ap.add_argument('--port', type=int, default=8793)
    ap.add_argument('--software', action='store_true')
    ap.add_argument('--scroll', action='store_true')
    ap.add_argument('--exp', default=None, help='instead of running the clock, evaluate this JS file (a function) and print what it returns')
    args = ap.parse_args()
    vw, vh = (int(v) for v in args.viewport.split('x'))

    server = http.server.ThreadingHTTPServer(('127.0.0.1', args.port), functools.partial(Quiet, directory=ROOT))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    with sync_playwright() as pw:
        if args.software:
            browser = pw.chromium.launch()
        else:
            browser = pw.chromium.launch(channel='chromium', args=['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'])
        page = browser.new_page(viewport={'width': vw, 'height': vh}, device_scale_factor=args.dpr)
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto('http://127.0.0.1:%d/index.html?test&seed=1' % args.port)
        gpu = page.evaluate('''() => { const gl = document.createElement('canvas').getContext('webgl');
          const e = gl && gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : '?'; }''')
        page.wait_for_function('() => window.player && player.levels[0]', timeout=60000)

        def to_page(x, y):
            return page.evaluate('''([x, y]) => { const W = innerWidth, H = innerHeight, k = Math.min(W / 600, H / 400);
              return [(W - 600 * k) / 2 + x * k, (H - 400 * k) / 2 + y * k]; }''', [x, y])

        # Past the loader to the game's menu (drive.py's boot), then type the level's code and
        # skip its movie (as smoke.py's scenarios do).
        page.evaluate('() => { while (player.levels[0].$cur < 15) __step(1); }')
        page.mouse.click(*to_page(300, 373))
        page.wait_for_function('() => player.levels[1] && !player.levels[1].$pending', timeout=180000)
        page.evaluate('() => { let n = 0; while (player.levels[1].$cur !== 201 && n++ < 1000) __step(1); }')
        page.wait_for_function('() => player.levels[1].panel', timeout=60000)
        page.evaluate('() => __step(70)')
        page.keyboard.type(args.level, delay=60)
        page.keyboard.press('Enter')
        page.evaluate('() => __step(35)')
        page.mouse.click(*to_page(300, 373))
        page.evaluate('(n) => __step(n)', 200 + args.warm)
        if args.exp:
            print(json.dumps(page.evaluate(open(args.exp, encoding='utf-8').read()), indent=1))
            browser.close()
            server.shutdown()
            return
        page.evaluate('''() => {
          const f = window.__frames = { at: [], work: [], ticks: 0, tickMs: [], drawMs: [] };
          let work = 0;
          const tick = player.tick.bind(player), draw = player.draw.bind(player);
          player.tick = function () { const t = performance.now(); tick(); const d = performance.now() - t; work += d; f.tickMs.push(d); f.ticks++; };
          player.draw = function (a) { const t = performance.now(); draw(a); const d = performance.now() - t; work += d; f.drawMs.push(d); };
          const rec = (now) => { f.at.push(now); f.work.push(work); work = 0; if (!f.stop) requestAnimationFrame(rec); };
          requestAnimationFrame(rec);
          __run();
        }''')
        if args.scroll:
            for i in range(int(args.seconds)):
                key = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'][i % 4]
                page.keyboard.down(key)
                page.wait_for_timeout(1000)
                page.keyboard.up(key)
        else:
            page.wait_for_timeout(int(args.seconds * 1000))
        out = page.evaluate('''() => {
          const f = window.__frames; f.stop = true;
          const gaps = []; for (let i = 1; i < f.at.length; i++) gaps.push(f.at[i] - f.at[i - 1]);
          const stats = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y);
            return { n: a.length, mean: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2), p50: +s[Math.floor(s.length * 0.5)].toFixed(2),
              p95: +s[Math.floor(s.length * 0.95)].toFixed(2), p99: +s[Math.floor(s.length * 0.99)].toFixed(2), max: +s[s.length - 1].toFixed(2) }; };
          const refresh = gaps.slice().sort((x, y) => x - y)[Math.floor(gaps.length * 0.1)] || 16.7;
          const late = gaps.filter((g) => g > refresh * 1.5).length;
          const secs = (f.at[f.at.length - 1] - f.at[0]) / 1000;
          const p = player.levels[1] && player.levels[1].panel;
          return { seconds: +secs.toFixed(1), fps: +(gaps.length / secs).toFixed(1), refresh: +refresh.toFixed(2), late, lateShare: +(late / gaps.length).toFixed(3),
            ticksPerSecond: +(f.ticks / secs).toFixed(1), gap: stats(gaps), work: stats(f.work), tick: stats(f.tickMs), draw: stats(f.drawMs),
            state: p && p.state, level: p && p.game && p.game.level && p.game.level.level, errors: [...player.errors.keys()] };
        }''')
        browser.close()
    server.shutdown()
    out['gpu'] = gpu
    print(json.dumps(out, indent=1))
    if errors:
        print('page errors:', errors[:5])


if __name__ == '__main__':
    main()
