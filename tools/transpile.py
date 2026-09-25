"""
ActionScript 2 -> JavaScript, mechanically.

    python tools/transpile.py

Input is FFDec's deobfuscated export (work/ffdec/<movie>_as/scripts).  Output is one
classic (non-module) script per movie, src/scripts/<movie>.js, registering every frame,
button and clip-event script under a key the runtime uses to find it:

    root:<frame>:<n>                      n-th DoAction on a main-timeline frame
    s<sprite>:<frame>:<n>                 n-th DoAction on a sprite's frame
    b<button>:<i>                         i-th BUTTONCONDACTION of a button
    c<timeline>:<frame>:<depth>:<i>       i-th CLIPACTIONRECORD of a placement

The code is kept as close to the decompiled source as JavaScript allows, so the two can
be read side by side.  What changes is only what JavaScript would do differently:

  * Scope.  Every script runs inside `with (scope)`, where scope is a proxy reproducing
    AS2's chain: the timeline, then _global, then the built-ins; assignments land on the
    timeline.  Top-level `var` and `function` in a frame script therefore become
    timeline variables, as they are in Flash.  (Classic scripts are sloppy-mode, which is
    what allows `with`.)
  * Undefined bases.  AS2 reads, calls and writes on undefined/null do nothing; JS
    throws.  Reads and calls become optional chains; writes and updates on anything but
    `this` go through __as.set / __as.upd / __as.op.
  * for..in.  AVM1 enumerates newest-first (arrays: highest index first); JavaScript
    does not.  Loops go through __as.keys, which returns AVM1's order.
  * null.  Written as undefined, so arithmetic on it gives NaN as in AS2 (see _expr).
  * <= and >=.  Written as !(a > b) and !(a < b), which is what the bytecode does.

Nothing else is rewritten.  If esprima cannot parse a script the build stops and says
which one.
"""

import json
import os
import re
import sys

import esprima

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))

# Identifiers that are always defined, so `X.y` needs no optional chain.
SAFE_BASES = {'Math', 'Key', 'Mouse', 'Stage', 'System', 'Selection', 'flash', 'String',
              'Number', 'Array', 'Object', 'Boolean', '_global', '__as'}

PRECEDENCE = {
    'SequenceExpression': 0, 'AssignmentExpression': 2, 'ConditionalExpression': 3,
    'LogicalExpression||': 4, 'LogicalExpression&&': 5,
    '|': 6, '^': 7, '&': 8, '==': 9, '!=': 9, '===': 9, '!==': 9,
    '<': 10, '>': 10, '<=': 10, '>=': 10, 'instanceof': 10, 'in': 10,
    '<<': 11, '>>': 11, '>>>': 11, '+': 12, '-': 12, '*': 13, '/': 13, '%': 13,
    'UnaryExpression': 15, 'UpdateExpression': 16, 'NewExpression': 18, 'CallExpression': 19,
    'MemberExpression': 19, 'Primary': 20,
}


def prec(node):
    t = node.type
    if t == 'BinaryExpression':
        return PRECEDENCE[node.operator]
    if t == 'LogicalExpression':
        return PRECEDENCE['LogicalExpression' + node.operator]
    if t in PRECEDENCE:
        return PRECEDENCE[t]
    return PRECEDENCE['Primary']


class Emitter:
    def __init__(self):
        self.out = []
        self.ind = 0
        self.tmp = 0

    # -- statements --------------------------------------------------------------------
    def line(self, s):
        self.out.append('   ' * self.ind + s)

    def stmts(self, body, toplevel=False):
        if toplevel:
            # AS2 frame scripts: function declarations are timeline variables and are
            # defined before the rest of the frame runs.
            funcs = [s for s in body if s.type == 'FunctionDeclaration']
            rest = [s for s in body if s.type != 'FunctionDeclaration']
            for f in funcs:
                self.line('%s = %s;' % (f.id.name, self.function(f, name=f.id.name)))
            body = rest
        for s in body:
            self.stmt(s, toplevel)

    def block(self, node, toplevel=False):
        if node.type == 'BlockStatement':
            self.line('{')
            self.ind += 1
            self.stmts(node.body, toplevel)
            self.ind -= 1
            self.line('}')
        else:
            self.line('{')
            self.ind += 1
            self.stmt(node, toplevel)
            self.ind -= 1
            self.line('}')

    def stmt(self, s, top=False):
        t = s.type
        if t == 'ExpressionStatement':
            self.line(self.expr(s.expression) + ';')
        elif t == 'VariableDeclaration':
            if top:
                # Timeline variable: assignment through the scope.  `var x;` with no
                # initialiser declares nothing observable and is dropped.
                for d in s.declarations:
                    if d.init is not None:
                        self.line('%s = %s;' % (d.id.name, self.expr(d.init, 2)))
            else:
                self.line(self.vardecl(s) + ';')
        elif t == 'FunctionDeclaration':
            self.line(self.function(s, name=s.id.name, declaration=True))
        elif t == 'ReturnStatement':
            self.line('return' + (' ' + self.expr(s.argument) if s.argument else '') + ';')
        elif t == 'IfStatement':
            self.line('if(%s)' % self.expr(s.test))
            self.block(s.consequent, top)
            if s.alternate:
                if s.alternate.type == 'IfStatement':
                    self.out[-1] = self.out[-1]            # keep structure readable
                    self.line('else')
                    self.block(s.alternate, top)
                else:
                    self.line('else')
                    self.block(s.alternate, top)
        elif t == 'BlockStatement':
            self.block(s, top)
        elif t == 'ForStatement':
            init = ''
            if s.init is not None:
                if s.init.type == 'VariableDeclaration':
                    init = self.vardecl(s.init) if not top else ', '.join(
                        '%s = %s' % (d.id.name, self.expr(d.init, 2)) for d in s.init.declarations if d.init)
                else:
                    init = self.expr(s.init)
            self.line('for(%s; %s; %s)' % (init, self.expr(s.test) if s.test else '',
                                            self.expr(s.update) if s.update else ''))
            self.block(s.body, top)
        elif t == 'ForInStatement':
            if s.left.type == 'VariableDeclaration':
                name = s.left.declarations[0].id.name
                left = name if top else 'var ' + name
            else:
                left = self.expr(s.left)
            self.line('for(%s of __as.keys(%s))' % (left, self.expr(s.right)))
            self.block(s.body, top)
        elif t == 'WhileStatement':
            self.line('while(%s)' % self.expr(s.test))
            self.block(s.body, top)
        elif t == 'DoWhileStatement':
            self.line('do')
            self.block(s.body, top)
            self.line('while(%s);' % self.expr(s.test))
        elif t == 'BreakStatement':
            self.line('break' + (' ' + s.label.name if s.label else '') + ';')
        elif t == 'ContinueStatement':
            self.line('continue' + (' ' + s.label.name if s.label else '') + ';')
        elif t == 'SwitchStatement':
            self.line('switch(%s)' % self.expr(s.discriminant))
            self.line('{')
            self.ind += 1
            for c in s.cases:
                self.line(('case %s:' % self.expr(c.test)) if c.test else 'default:')
                self.ind += 1
                self.stmts(c.consequent)
                self.ind -= 1
            self.ind -= 1
            self.line('}')
        elif t == 'TryStatement':
            self.line('try')
            self.block(s.block, top)
            if s.handler:
                self.line('catch(%s)' % s.handler.param.name)
                self.block(s.handler.body, top)
            if s.finalizer:
                self.line('finally')
                self.block(s.finalizer, top)
        elif t == 'ThrowStatement':
            self.line('throw %s;' % self.expr(s.argument))
        elif t == 'LabeledStatement':
            self.line('%s:' % s.label.name)
            self.stmt(s.body, top)
        elif t == 'EmptyStatement':
            pass
        else:
            raise ValueError('statement %s not handled' % t)

    def vardecl(self, s):
        parts = []
        for d in s.declarations:
            parts.append(d.id.name + (' = ' + self.expr(d.init, 2) if d.init is not None else ''))
        return 'var ' + ', '.join(parts)

    def function(self, f, name=None, declaration=False):
        params = ', '.join(p.name for p in f.params)
        saved_out, saved_ind = self.out, self.ind
        self.out = []
        self.ind = saved_ind + 1
        self.stmts(f.body.body)
        body = self.out
        self.out, self.ind = saved_out, saved_ind
        head = 'function %s(%s)' % (name or (f.id.name if f.id else ''), params)
        pad = '   ' * saved_ind
        text = head + '\n' + pad + '{\n' + '\n'.join(body) + ('\n' if body else '') + pad + '}'
        return text

    # -- expressions -------------------------------------------------------------------
    def expr(self, e, min_prec=0):
        s = self._expr(e)
        return '(' + s + ')' if prec(e) < min_prec else s

    def member_base(self, obj):
        return self.expr(obj, PRECEDENCE['MemberExpression'])

    def optional(self, obj):
        """Is an optional chain needed after this base?"""
        if obj.type == 'ThisExpression':
            return False
        if obj.type == 'Identifier' and obj.name in SAFE_BASES:
            return False
        if obj.type == 'MemberExpression' and not obj.computed and obj.object.type == 'Identifier' \
                and obj.object.name == 'flash':
            return False
        return True

    def member(self, e):
        base = self.member_base(e.object)
        q = '?.' if self.optional(e.object) else '.'
        if e.computed:
            return base + ('?.' if q == '?.' else '') + '[' + self.expr(e.property) + ']'
        return base + q + e.property.name

    def prop_key(self, e):
        """For writes: (base_code, key_code) of a MemberExpression target."""
        base = self.member_base(e.object)
        key = self.expr(e.property) if e.computed else json.dumps(e.property.name)
        return base, key

    def _expr(self, e):
        t = e.type
        if t == 'Identifier':
            return e.name
        if t == 'Literal':
            if e.value is None and e.raw == 'null':
                # AS2 (SWF 7+) converts null to NaN in arithmetic and comparisons, as it
                # does undefined; JavaScript makes null 0.  The game passes null for "no
                # value" (new Unit(this, "UD_good", null, null, ...)) and then does maths
                # on it, so null is written as undefined, which JavaScript treats the
                # AS2 way.  Nothing in the game tells the two apart: it never uses ===,
                # and never tests typeof against "null".
                return 'undefined'
            if isinstance(e.value, str):
                return json.dumps(e.value)
            return e.raw
        if t == 'ThisExpression':
            return 'this'
        if t == 'ArrayExpression':
            return '[' + ', '.join(self.expr(x, 2) if x is not None else '' for x in e.elements) + ']'
        if t == 'ObjectExpression':
            if not e.properties:
                return '{}'
            parts = []
            for p in e.properties:
                k = p.key.name if p.key.type == 'Identifier' else (
                    json.dumps(p.key.value) if isinstance(p.key.value, str) else p.key.raw)
                parts.append('%s:%s' % (k, self.expr(p.value, 2)))
            return '{' + ','.join(parts) + '}'
        if t == 'FunctionExpression':
            return self.function(e)
        if t == 'UnaryExpression':
            arg = e.argument
            if e.operator == 'delete':
                if arg.type == 'MemberExpression':
                    return 'delete ' + self.member(arg)
                return 'delete ' + self.expr(arg, 15)
            sp = ' ' if e.operator in ('typeof', 'void') else ''
            return e.operator + sp + self.expr(arg, 15)
        if t == 'UpdateExpression':
            arg = e.argument
            if arg.type == 'MemberExpression' and arg.object.type != 'ThisExpression':
                base, key = self.prop_key(arg)
                return '__as.upd(%s, %s, %d, %s)' % (base, key, 1 if e.operator == '++' else -1,
                                                     'true' if e.prefix else 'false')
            a = self.expr(arg, 16)
            return e.operator + a if e.prefix else a + e.operator
        if t == 'BinaryExpression' and e.operator in ('<=', '>='):
            # AVM1 has no <= or >=.  The compiler emits !(a > b) and !(a < b), which are
            # true when either side is NaN or undefined; JavaScript's <= and >= are false
            # there.  The game relies on it: a unit whose path was deleted passes
            # `if (this.path.length <= 1)` in Flash, and must here too.
            left = self.expr(e.left, 10)
            right = self.expr(e.right, 11)
            return '!(%s %s %s)' % (left, '>' if e.operator == '<=' else '<', right)
        if t in ('BinaryExpression', 'LogicalExpression'):
            p = prec(e)
            left = self.expr(e.left, p)
            right = self.expr(e.right, p + 1)
            return '%s %s %s' % (left, e.operator, right)
        if t == 'AssignmentExpression':
            tgt = e.left
            if tgt.type == 'MemberExpression' and tgt.object.type != 'ThisExpression':
                base, key = self.prop_key(tgt)
                if e.operator == '=':
                    return '__as.set(%s, %s, %s)' % (base, key, self.expr(e.right, 2))
                return '__as.op(%s, %s, %s, %s)' % (base, key, json.dumps(e.operator[:-1]),
                                                    self.expr(e.right, 2))
            left = self.expr(tgt, 3) if tgt.type != 'MemberExpression' else self.member_write(tgt)
            return '%s %s %s' % (left, e.operator, self.expr(e.right, 2))
        if t == 'ConditionalExpression':
            return '%s ? %s : %s' % (self.expr(e.test, 4), self.expr(e.consequent, 2),
                                      self.expr(e.alternate, 2))
        if t == 'CallExpression':
            args = ', '.join(self.expr(a, 2) for a in e.arguments)
            c = e.callee
            if c.type == 'MemberExpression':
                # Always an optional call: AS2 calling an undefined method does nothing,
                # even on `this`, and an optional call on a real function costs nothing.
                if c.object.type == 'Identifier' and c.object.name in SAFE_BASES:
                    return self.member(c) + '(' + args + ')'
                return self.member(c) + '?.(' + args + ')'
            if c.type == 'Identifier':
                return c.name + '?.(' + args + ')'
            return self.expr(c, 19) + '?.(' + args + ')'
        if t == 'NewExpression':
            args = ', '.join(self.expr(a, 2) for a in e.arguments)
            c = e.callee
            callee = self.member_write(c) if c.type == 'MemberExpression' else self.expr(c, 18)
            return 'new %s(%s)' % (callee, args)
        if t == 'MemberExpression':
            return self.member(e)
        if t == 'SequenceExpression':
            return ', '.join(self.expr(x, 1) for x in e.expressions)
        raise ValueError('expression %s not handled' % t)

    def member_write(self, e):
        """Plain dotted access, for `this.x = ...` targets and `new` callees."""
        base = self.expr(e.object, PRECEDENCE['MemberExpression'])
        if e.computed:
            return base + '[' + self.expr(e.property) + ']'
        return base + '.' + e.property.name


# ---- preprocessing -------------------------------------------------------------------

def _fix_sha1_this(text):
    """frame_201/DoAction_2.as, function SHA1.

    FFDec shows `this = SHA1;` because the compiler reused the register that held
    `this` as a scratch variable: from that line on, every `this.` at the function's own
    level means the SHA1 function object (nested functions keep their own `this`).
    JavaScript cannot assign to `this`, so the register becomes a local.
    """
    start = text.index('function SHA1(str)\n{\n')
    end = text.index('\n}\n', start) + 3
    body = text[start:end]
    body = body.replace('   this = SHA1;\n', '   var __self = SHA1;\n', 1)
    body = re.sub(r'^(   (?:return )?)this\.', r'\1__self.', body, flags=re.M)
    return text[:start] + body + text[end:]


# (relative path, fix, expected number of occurrences of the thing being fixed)
FIXES = {
    'frame_201/DoAction_2.as': _fix_sha1_this,
}

OBF_VAR = re.compile(r'^\s*var §[^§]*§ = [^;]*;\s*$', re.M)
WRAPPER = re.compile(r'^\s*(on|onClipEvent)\((.*?)\)\s*\{\s*\n(.*)\n\s*\}\s*$', re.S)


def preprocess(text, key):
    text = OBF_VAR.sub('', text)
    m = WRAPPER.match(text)
    if m:
        text = m.group(3)
    # FFDec's raw form of a for..in it could not restructure:
    #   §§enumerate(X);  ...  (_loc0_ = §§enumeration())
    # AVM1 pushes a null terminator then the keys, and each step pops one.
    # Each §§enumeration() belongs to the nearest §§enumerate before it.
    n = [0]

    def enum_token(mm):
        if mm.group(1) is not None:
            n[0] += 1
            return 'var __en%d = __as.keys(%s).concat([null]), __ei%d = 0, _loc0_;' % (n[0], mm.group(1), n[0])
        return '__en%d[__ei%d++]' % (n[0], n[0])
    text = re.sub(r'§§enumerate\((.*?)\);|§§enumeration\(\)', enum_token, text)
    # Any obfuscator residue still left is a syntax error ('§' cannot begin an
    # identifier), so esprima reports it; a '§' inside a string literal is legitimate.
    return text


def translate(text, key, relpath=None):
    if relpath in FIXES:
        text = FIXES[relpath](text)
    src = preprocess(text, key)
    try:
        tree = esprima.parseScript(src)
    except esprima.Error as err:
        raise SystemExit('%s: parse error %s\n---\n%s' % (key, err, src[:800]))
    em = Emitter()
    em.ind = 2
    em.stmts(tree.body, toplevel=True)
    return '\n'.join(em.out)


# ---- locating scripts ----------------------------------------------------------------

FRAME = re.compile(r'^frame_(\d+)$')
SPRITE = re.compile(r'^DefineSprite_(\d+)(?:_.*)?$')
BUTTON = re.compile(r'^DefineButton2_(\d+)$')
PLACE = re.compile(r'^PlaceObject[23]?_(\d+)(?:_(.+))?_(\d+)$')
DOACTION = re.compile(r'^DoAction(?:_(\d+))?\.as$')
CLIPACT = re.compile(r'^CLIPACTIONRECORD onClipEvent\((.*)\)\.as$')
BTNACT = re.compile(r'^BUTTONCONDACTION on\((.*)\)\.as$')


def load_library(movie):
    with open(os.path.join(ROOT, 'data', movie + '.json'), encoding='utf-8') as fh:
        return json.load(fh)


def button_index(lib, bid, conds):
    """Match FFDec's on(...) text to the button's n-th condition action."""
    acts = lib['chars'][str(bid)]['acts']
    want = [c.strip() for c in conds.split(',')]
    for i, a in enumerate(acts):
        if a['ev'] == want:
            return i
    raise SystemExit('button %d: no condition matches on(%s); have %r' % (bid, conds, acts))


def clip_index(lib, timeline, frame, depth, events):
    """Match onClipEvent(...) to the placement's n-th clip action record."""
    frames = lib['root']['frames'] if timeline == 'root' else lib['chars'][str(timeline)]['frames']
    want = [e.strip() for e in events.split(',')]
    for op in frames[frame - 1]:
        if op.get('d') == depth and 'e' in op:
            for i, rec in enumerate(op['e']):
                if rec['ev'] == want:
                    return i
    raise SystemExit('clip action %s frame %d depth %d on(%s) not found' % (timeline, frame, depth, events))


def collect(movie):
    base = os.path.join(ROOT, 'work', 'ffdec', movie + '_as', 'scripts')
    lib = load_library(movie)
    scripts = []
    for dirpath, _, files in os.walk(base):
        rel = os.path.relpath(dirpath, base).replace('\\', '/').split('/')
        for f in files:
            path = os.path.join(dirpath, f)
            text = open(path, encoding='utf-8').read()
            src = '/'.join(rel + [f])
            m_frame = FRAME.match(rel[0])
            m_sprite = SPRITE.match(rel[0])
            m_button = BUTTON.match(rel[0])
            if m_frame and len(rel) == 1 and DOACTION.match(f):
                n = int(DOACTION.match(f).group(1) or 1)
                key = 'root:%d:%d' % (int(m_frame.group(1)), n)
            elif m_sprite and len(rel) == 2 and FRAME.match(rel[1]) and DOACTION.match(f):
                n = int(DOACTION.match(f).group(1) or 1)
                key = 's%s:%s:%d' % (m_sprite.group(1), FRAME.match(rel[1]).group(1), n)
            elif m_button and len(rel) == 1 and BTNACT.match(f):
                bid = int(m_button.group(1))
                key = 'b%d:%d' % (bid, button_index(lib, bid, BTNACT.match(f).group(1)))
            elif len(rel) >= 2 and CLIPACT.match(f) and PLACE.match(rel[-1]):
                owner = 'root' if FRAME.match(rel[0]) else int(SPRITE.match(rel[0]).group(1))
                frame_dir = rel[0] if owner == 'root' else rel[1]
                frame = int(FRAME.match(frame_dir).group(1))
                depth = int(PLACE.match(rel[-1]).group(3))
                i = clip_index(lib, owner, frame, depth, CLIPACT.match(f).group(1))
                key = 'c%s:%d:%d:%d' % (owner, frame, depth, i)
            else:
                raise SystemExit('unrecognised script location %s' % src)
            scripts.append((key, src, text))
    return sorted(scripts, key=lambda s: _sort_key(s[0]))


def _sort_key(k):
    """Order scripts by kind, then numerically by every number in the key."""
    return re.sub(r'\d+', lambda m: '%08d' % int(m.group()), k)


HEADER = """/*
 * %s.js -- the %s movie's ActionScript, translated.
 *
 * GENERATED by tools/transpile.py from FFDec's deobfuscated export of the original SWF.
 * Do not edit by hand: change the translator, or add an entry to its fixes, and rerun.
 *
 * Each function is one script from the original, keyed by where it ran.  The comment
 * above each gives the path FFDec exported it under, so any line here can be checked
 * against the decompiled source.
 */
(function (registry) {
"use sloppy";
"""


def main():
    out_dir = os.path.join(ROOT, 'src', 'scripts')
    os.makedirs(out_dir, exist_ok=True)
    for movie in ('loader', 'game'):
        scripts = collect(movie)
        parts = [HEADER % (movie, movie)]
        lines = 0
        for key, src, text in scripts:
            body = translate(text, movie + ':' + src, src if movie == 'game' else None)
            lines += body.count('\n') + 1
            parts.append('   /* %s */' % src)
            parts.append('   registry[%s] = function (__scope)\n   {\n      with (__scope)\n      {\n%s\n      }\n   };\n'
                         % (json.dumps(key), body))
        parts.append('})((globalThis.__scripts = globalThis.__scripts || {})[%s] = {});\n'
                     % json.dumps(movie))
        dest = os.path.join(out_dir, movie + '.js')
        with open(dest, 'w', encoding='utf-8', newline='\n') as fh:
            fh.write('\n'.join(parts).replace('"use sloppy";\n', ''))
        print('%-7s %4d scripts, %6d lines -> %s' % (movie, len(scripts), lines, os.path.relpath(dest, ROOT)))


if __name__ == '__main__':
    main()
