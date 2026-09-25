"""
Step 1 of the build: have JPEXS FFDec decode what the rest of the pipeline does not --
the media, and readable (deobfuscated) ActionScript.

    python tools/extract.py [--original DIR] [--ffdec PATH]

Writes, for each of loader.swf and game(original).swf:

    work/ffdec/<movie>_media/   images, sounds, fonts
    work/ffdec/<movie>_as/      ActionScript, deobfuscated

The game's scripts were run through an obfuscator (flattened control flow, a shared
constant pool); without these settings the export is unreadable.  FFDec 26.2.1 on Java 8
was used to produce the files this repository was built from.

Then: python tools/build_library.py && python tools/transpile.py
"""

import argparse
import os
import shutil
import subprocess

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
DEFAULT_ORIGINAL = r'D:\Claude_RTSGames\CRYSTALIEN\CrystAlienConflict'
DEFAULT_FFDEC = os.environ.get('FFDEC', r'D:\Claude_RTSGames\tools\ffdec\ffdec-cli.exe')
MOVIES = {'loader': 'loader.swf', 'game': 'game(original).swf'}
DEOBFUSCATE = 'autoDeobfuscate=1,resolveConstants=1,simplifyExpressions=1,as12DeobfuscatorExecutionLimit=200000'


def run(cmd):
    print(' '.join('"%s"' % c if ' ' in c else c for c in cmd))
    subprocess.run(cmd, check=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--original', default=DEFAULT_ORIGINAL)
    ap.add_argument('--ffdec', default=DEFAULT_FFDEC)
    args = ap.parse_args()
    work = os.path.join(ROOT, 'work', 'ffdec')
    os.makedirs(work, exist_ok=True)
    for movie, fname in MOVIES.items():
        swf = os.path.join(args.original, fname)
        for sub in ('_media', '_as'):
            d = os.path.join(work, movie + sub)
            if os.path.isdir(d):
                shutil.rmtree(d)
        run([args.ffdec, '-export', 'image,sound,font', os.path.join(work, movie + '_media'), swf])
        run([args.ffdec, '-config', DEOBFUSCATE, '-export', 'script', os.path.join(work, movie + '_as'), swf])


if __name__ == '__main__':
    main()
