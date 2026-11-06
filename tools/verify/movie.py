"""
How smoothly a story level's cutscene plays: start the level (its cutscene comes first), run the
game on its own clock in Chromium with the GPU, and report the screen's frames -- how far apart
they came, how many were late -- and the game's work in each, as fps.py does for a skirmish.

    python tools/verify/movie.py [--level 1] [--team good] [--seconds 15] [--viewport 1600x900]
                                 [--dpr 1] [--software] [--profile 25] [--cpu 4]

--cpu N slows the page's CPU N times (Chromium's own throttling), for a weaker computer.
--old draws as the renderer did before (colour transforms with their pixels read back, every
filtered clip signed every frame), to compare.  Only the frames
while the cutscene plays are counted.
--software draws without the GPU.  --profile N adds a CPU profile: the top N functions.
"""

import argparse
import collections
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
    ap.add_argument('--level', type=int, default=1)
    ap.add_argument('--team', default='good')
    ap.add_argument('--seconds', type=float, default=15)
    ap.add_argument('--viewport', default='1600x900')
    ap.add_argument('--dpr', type=float, default=1)
    ap.add_argument('--port', type=int, default=8793)
    ap.add_argument('--software', action='store_true')
    ap.add_argument('--profile', type=int, default=0)
    ap.add_argument('--cpu', type=float, default=1)
    ap.add_argument('--old', action='store_true')
    ap.add_argument('--time', default='', help='renderer methods to time, comma-separated (ms a frame drawn, and calls)')
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
        page.evaluate('() => { while (player.levels[0].$cur < 15) __step(1); }')
        xy = page.evaluate('''() => { const r = player.renderer, b = r.canvas.getBoundingClientRect(), d = r.canvas.width / b.width;
          const x = 300 + Math.round((r.stageW - 600) / 2), y = 373 + Math.round((r.stageH - 400) / 2);
          return [b.left + (r.offsetX + x * r.scale) / d, b.top + (r.offsetY + y * r.scale) / d]; }''')
        page.mouse.click(*xy)
        page.wait_for_function('() => player.levels[1] && !player.levels[1].$pending', timeout=180000)
        page.evaluate('() => { let n = 0; while (player.levels[1].$cur !== 201 && n++ < 1000) __step(1); }')
        page.wait_for_function('() => player.levels[1].panel', timeout=60000)
        page.evaluate('() => __step(70)')
        # the level, as the story starts it: its cutscene first
        started = page.evaluate('''([level, team]) => { const p = player.levels[1].panel;
          p.team = team; p.oppo = team === 'good' ? 'evil' : 'good'; p.level = level; p.state = 'startgame';
          for (let i = 0; i < 400 && !(p.MC && p.MC.movieholder && p.MC.movieholder.movie); i++) __step(1);
          return { state: p.state, movie: p.movieName, attached: !!(p.MC && p.MC.movieholder && p.MC.movieholder.movie) }; }''', [args.level, args.team])
        if args.old:
            page.evaluate('() => { player.renderer.canvasFilters = false; player.renderer.alwaysSign = true; }')
        if args.cpu > 1:
            cdp0 = page.context.new_cdp_session(page)
            cdp0.send('Emulation.setCPUThrottlingRate', {'rate': args.cpu})
        if args.time:
            page.evaluate('''(names) => { const r = player.renderer; window.__timed = {};
              for (const n of names) { const f = r[n]; if (typeof f !== 'function') continue; const e = window.__timed[n] = { ms: 0, calls: 0, depth: 0 };
                r[n] = function (...a) { if (e.depth++) { try { return f.apply(this, a); } finally { e.depth--; } } const t = performance.now(); try { return f.apply(this, a); } finally { e.depth--; e.ms += performance.now() - t; e.calls++; } }; } }''', args.time.split(','))
        cdp = None
        if args.profile:
            cdp = page.context.new_cdp_session(page)
            cdp.send('Profiler.enable')
            cdp.send('Profiler.setSamplingInterval', {'interval': 1000})
            cdp.send('Profiler.start')
        page.evaluate('''() => {
          const f = window.__frames = { at: [], work: [], tickMs: [], drawMs: [] };
          let work = 0;
          const tick = player.tick.bind(player), draw = player.draw.bind(player);
          player.tick = function () { const t = performance.now(); tick(); const d = performance.now() - t; work += d; f.tickMs.push(d); };
          player.draw = function (a) { const t = performance.now(); draw(a); const d = performance.now() - t; work += d; f.drawMs.push(d); };
          // (only while the cutscene plays)
          const rec = (now) => { if (player.levels[1].panel.state === 'movie') { f.at.push(now); f.work.push(work); } work = 0; if (!f.stop) requestAnimationFrame(rec); };
          requestAnimationFrame(rec);
          __run();
        }''')
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
          const p = player.levels[1].panel;
          return { seconds: +secs.toFixed(1), fps: +(gaps.length / secs).toFixed(1), refresh: +refresh.toFixed(2), late, lateShare: +(late / gaps.length).toFixed(3),
            ticksPerSecond: +(f.tickMs.length / secs).toFixed(1), gap: stats(gaps), work: stats(f.work), tick: stats(f.tickMs), draw: stats(f.drawMs),
            // (the longest gaps: when, in seconds from the first frame, and the work in them)
            worst: gaps.map((g, i) => [g, i]).sort((x, y) => y[0] - x[0]).slice(0, 5).map(([g, i]) => ({ ms: +g.toFixed(1), at: +((f.at[i] - f.at[0]) / 1000).toFixed(2), work: +f.work[i + 1].toFixed(1) })),
            stillMovie: p.state === 'movie', errors: [...player.errors.keys()],
            timed: window.__timed ? Object.fromEntries(Object.entries(window.__timed).map(([k, e]) => [k, { msPerDraw: +(e.ms / f.drawMs.length).toFixed(2), callsPerDraw: +(e.calls / f.drawMs.length).toFixed(1) }])) : undefined };
        }''')
        prof = cdp.send('Profiler.stop')['profile'] if cdp else None
        browser.close()
    server.shutdown()
    out['started'] = started
    out['gpu'] = gpu
    print(json.dumps(out, indent=1))
    if errors:
        print('page errors:', errors[:5])
    if prof:
        nodes = {n['id']: n for n in prof['nodes']}
        own = collections.Counter()
        for sid, d in zip(prof.get('samples', []), prof.get('timeDeltas', [])):
            cf = nodes[sid]['callFrame']
            own['%s (%s:%d)' % (cf['functionName'] or '(anon)', os.path.basename(cf['url']) or '-', cf['lineNumber'] + 1)] += d
        total = sum(own.values()) or 1
        print('\nown time, top %d:' % args.profile)
        for key, t in own.most_common(args.profile):
            print('%6.1f%%  %8.1f ms  %s' % (100.0 * t / total, t / 1000.0, key))


if __name__ == '__main__':
    main()
