"""
Regression check: play a set of scenarios in test mode (stopped clock, seeded random
numbers) and fail if any script raises an error.

    python tools/verify/smoke.py [OUTDIR] [--browser=firefox|webkit]

Each scenario is a list of drive.py actions; screenshots land in OUTDIR/<scenario>/.
"""

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SOAK = 'eval ' + open(os.path.join(HERE, 'soak.js'), encoding='utf-8').read()
ERRORS = "eval [...player.errors.keys()]"


# The stage point at the centre of a map tile, from where the camera is now.
TILE = '''((tx, ty) => {
  const lv = player.levels[1].panel.game.level;
  const mc = lv.arena.MC, s = lv.arena.tileSize;
  return [Math.round(150 + mc._x + (tx - 0.5) * s), Math.round(mc._y + ((ty - 0.5) * s) / 2)];
})'''

# Mission 1 ends when its tutorial does: progress is saved and mission 2's movie starts.
STORY_DONE = '''eval (() => { const p = player.levels[1].panel, so = player.levels[1].SO.data;
  return p.state === 'movie' && so.goodUnlocked === 1 ? [] : ['mission 1 did not end: ' + p.state + ' ' + JSON.stringify(so)]; })()'''


# Pointing at a sidebar option restarts the white flash over the radar.  Moving to another
# option on the frame the last flash ends must restart it again and let it fade, not
# leave it stuck white.
RADAR_FLASH = ['move 300 300', 'step 10', 'move 30 225', 'step 5', 'move 30 255', 'step 12',
               '''eval (() => { const s = player.levels[1].panel.game.level.arena.radar.stats;
  return s.title === 'TRAINING CAMP' && s.flash._currentframe === 6 ? []
    : ['radar flash stuck: ' + s.title + ' frame ' + s.flash._currentframe]; })()''']


def code(level):
    # From the main menu: type a level code, skip its movie.
    return ['step 70', 'type ' + level, 'key Enter', 'step 35', 'click 300 373', 'step 200']


SCENARIOS = {
    'tutorial': ['step 70', 'click 50 215', 'step 35', 'click 300 373', 'step 100',
                 'click 295 262', 'step 35', 'click 420 180', 'move 590 390', 'step 200',
                 'shot end', ERRORS],
    'story-1': ['step 70', 'click 50 215', 'step 35', 'click 300 373', 'step 100',
                'click 295 262', 'step 35', 'clickjs (%s)(4, 7)' % TILE, 'step 120',
                'clickjs (%s)(6, 6)' % TILE, 'step 900', 'shot end', STORY_DONE, ERRORS],
    'alien-start': ['step 70', 'click 555 215', 'step 35', 'click 300 373', 'step 150',
                    'shot end', ERRORS],
    'radar-flash': code('eclipse') + RADAR_FLASH + ['shot end', ERRORS],
    'soak-eclipse': code('eclipse') + [SOAK, 'shot end'],
    'soak-santa': code('santa') + [SOAK, 'shot end'],
    'soak-drill': code('drill') + [SOAK, 'shot end'],
    'soak-temple': code('temple') + [SOAK, 'shot end'],
}


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    extra = [a for a in sys.argv[1:] if a.startswith('--')]        # e.g. --browser=firefox
    out = args[0] if args else os.path.join(HERE, '..', '..', 'work', 'smoke')
    failed = 0
    for name, actions in SCENARIOS.items():
        cmd = [sys.executable, os.path.join(HERE, 'drive.py'), os.path.join(out, name), '--test'] + extra + ['boot'] + actions
        r = subprocess.run(cmd, capture_output=True, text=True)
        lines = r.stdout.splitlines()
        errors = [l for l in lines if l.startswith('[error]') or l.startswith('[pageerror]')]
        evals = [l[6:] for l in lines if l.startswith('eval: ')]
        for e in evals:
            try:
                v = json.loads(e)
            except ValueError:
                continue
            if isinstance(v, dict) and v.get('errors'):
                errors.append('script errors: %s' % v['errors'])
            elif isinstance(v, list) and v and all(isinstance(x, str) for x in v):
                errors.append('script errors: %s' % v)
        ok = r.returncode == 0 and not errors
        failed += not ok
        print('%-14s %s' % (name, 'ok' if ok else 'FAILED'))
        for e in errors[:10]:
            print('    ' + e[:300])
        if r.returncode:
            print('    ' + r.stderr.strip().splitlines()[-1][:300] if r.stderr.strip() else '    exit %d' % r.returncode)
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
