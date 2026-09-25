"""
Regression check: play a set of scenarios in test mode (stopped clock, seeded random
numbers) and fail if any script raises an error.

    python tools/verify/smoke.py [OUTDIR]

Each scenario is a list of drive.py actions; screenshots land in OUTDIR/<scenario>/.
"""

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SOAK = 'eval ' + open(os.path.join(HERE, 'soak.js'), encoding='utf-8').read()
ERRORS = "eval [...player.errors.keys()]"


def code(level):
    # From the main menu: type a level code, skip its movie.
    return ['step 70', 'type ' + level, 'key Enter', 'step 35', 'click 300 373', 'step 200']


SCENARIOS = {
    'tutorial': ['step 70', 'click 50 215', 'step 35', 'click 300 373', 'step 100',
                 'click 295 262', 'step 35', 'click 420 180', 'move 590 390', 'step 200',
                 'shot end', ERRORS],
    'alien-start': ['step 70', 'click 555 215', 'step 35', 'click 300 373', 'step 150',
                    'shot end', ERRORS],
    'soak-eclipse': code('eclipse') + [SOAK, 'shot end'],
    'soak-santa': code('santa') + [SOAK, 'shot end'],
    'soak-drill': code('drill') + [SOAK, 'shot end'],
    'soak-temple': code('temple') + [SOAK, 'shot end'],
}


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, '..', '..', 'work', 'smoke')
    failed = 0
    for name, actions in SCENARIOS.items():
        cmd = [sys.executable, os.path.join(HERE, 'drive.py'), os.path.join(out, name), '--test', 'boot'] + actions
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
