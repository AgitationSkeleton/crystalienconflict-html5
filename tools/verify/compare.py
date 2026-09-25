"""
Run the same actions against the port and against the original SWFs in Ruffle, and put
each pair of screenshots side by side (port left, original right).

    python tools/verify/compare.py OUTDIR [--scale 1] ACTIONS...

The reference needs reference/ruffle (Ruffle's self-hosted web build) and reference/swf
(the original loader.swf, game(original).swf saved as game.swf, and dialogue.xml).  The
page that embeds them, tools/verify/ruffle.html, is copied in as reference/swf/index.html.
reference/ is not part of the repository; see README.md.

Actions are drive.py's.  "boot" means: get from the loader's LOAD GAME button to the
game's main menu, however each player needs to do it.
"""

import argparse
import os
import shutil
import subprocess
import sys

from PIL import Image, ImageChops, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('out')
    ap.add_argument('actions', nargs='*')
    ap.add_argument('--scale', default='1')
    ap.add_argument('--query', default='', help='extra query string for the port, e.g. glfilters')
    args = ap.parse_args()
    ref = os.path.join(ROOT, 'reference')
    for need in ('ruffle/ruffle.js', 'swf/loader.swf', 'swf/game.swf', 'swf/dialogue.xml'):
        if not os.path.exists(os.path.join(ref, need)):
            raise SystemExit('reference/%s is missing: see the header of this file' % need)
    shutil.copyfile(os.path.join(HERE, 'ruffle.html'), os.path.join(ref, 'swf', 'index.html'))
    runs = {
        'port': ('index.html' + ('?' + args.query if args.query else ''), args.actions, 8765),
        # Ruffle takes the first click to focus itself, and loads game.swf from disk at once.
        'ruffle': ('reference/swf/index.html',
                   [a if a != 'boot' else 'BOOT' for a in args.actions], 8766),
    }
    for name, (page, actions, port) in runs.items():
        acts = []
        for a in actions:
            if a == 'BOOT':
                acts += ['wait 2500', 'click 5 5', 'wait 300', 'click 300 373', 'wait 4000']
            else:
                acts.append(a)
        cmd = [sys.executable, os.path.join(HERE, 'drive.py'), os.path.join(args.out, name),
               '--page', page, '--port', str(port), '--scale', args.scale] + acts
        r = subprocess.run(cmd, capture_output=True, text=True)
        errs = [l for l in r.stdout.splitlines() if l.startswith('[error]') or l.startswith('[pageerror]')]
        print('%s: exit %d, %d errors' % (name, r.returncode, len(errs)))
        for l in errs[:20]:
            print('   ', l[:300])
    shots = [a.split(' ', 1)[1] for a in args.actions if a.startswith('shot ')]
    for s in shots:
        a = Image.open(os.path.join(args.out, 'port', s + '.png')).convert('RGB')
        b = Image.open(os.path.join(args.out, 'ruffle', s + '.png')).convert('RGB')
        diff = ImageChops.difference(a, b).convert('L')
        changed = sum(diff.point(lambda v: 255 if v > 48 else 0).histogram()[255:]) / float(a.size[0] * a.size[1])
        sheet = Image.new('RGB', (a.size[0] * 2 + 4, a.size[1] + 18), (40, 40, 40))
        sheet.paste(a, (0, 18))
        sheet.paste(b, (a.size[0] + 4, 18))
        d = ImageDraw.Draw(sheet)
        d.text((4, 3), 'port  %s' % s, fill=(255, 255, 255))
        d.text((a.size[0] + 8, 3), 'original (Ruffle)   %.1f%% of pixels differ' % (changed * 100), fill=(255, 255, 255))
        sheet.save(os.path.join(args.out, 'cmp_' + s + '.png'))
        print('%-12s %5.1f%% differ' % (s, changed * 100))


if __name__ == '__main__':
    main()
