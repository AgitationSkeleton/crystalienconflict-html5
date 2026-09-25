// The page's equivalent of the original Launcher.html: play loader.swf with the parameters
// the launcher gave it, in a player that runs at the movie's 23 frames a second.  The
// loader, exactly as in the original, shows its PLAY button and pigeon game, then loads
// game.swf into _level1 and starts it.

import { Player } from './flash/player.js';
import { Library } from './flash/library.js';

const FLASHVARS = { xmlurl: 'data/dialogue.xml', asseturl: '', serviceurl: '', gamename: 'CrystAlienConflict' };
const MOVIES = { 'game.swf': 'game' };     // loadMovieNum's file names -> converted movies
const FPS = 23;

const canvas = document.getElementById('stage');
let sizes = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('failed to load ' + src));
    document.head.appendChild(s);
  });
}

// A movie is its library (data + media) and its translated ActionScript.
function openMovie(name) {
  const lib = new Library(name, `assets/${name}/`);
  const ready = Promise.all([
    lib.load(`data/${name}.json`, sizes),
    globalThis.__scripts && globalThis.__scripts[name] ? null : loadScript(`src/scripts/${name}.js`),
  ]);
  return { lib, ready };
}

const player = new Player(canvas, {
  flashVars: FLASHVARS,
  openMovie: (file) => (MOVIES[file] ? openMovie(MOVIES[file]) : null),
});
globalThis.player = player;                // for the console and the verification harness

// ?test stops the clock: frames advance only when __step() is called, so a test decides
// exactly when each click lands.  ?seed=N makes the random numbers repeatable.
const params = new URLSearchParams(location.search);
const TEST = params.has('test');
if (params.has('seed')) player.seedRandom(Number(params.get('seed')) || 0);
// ?glfilters: Flash-exact filters on the GPU even where WebGL is software-rendered.
if (params.has('glfilters')) player.renderer.forceGL = true;
globalThis.__step = (n = 1) => {
  for (let i = 0; i < n; i++) player.tick();
  player.draw();
  return player.frame;
};

// ---- the stage fills the window; the movie is fitted inside it ("showAll") -------------
function resize() {
  const r = canvas.getBoundingClientRect();
  player.renderer.resize(r.width, r.height, window.devicePixelRatio || 1);
  player.draw();
}
addEventListener('resize', resize);

// ---- input -----------------------------------------------------------------------------
function stagePoint(ev) {
  const r = canvas.getBoundingClientRect();
  const dpr = canvas.width / Math.max(1, r.width);
  return player.renderer.toStage((ev.clientX - r.left) * dpr, (ev.clientY - r.top) * dpr);
}

canvas.addEventListener('pointermove', (ev) => {
  const [x, y] = stagePoint(ev);
  player.pointerMove(x, y);
});
canvas.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return;             // Flash only ever saw the left button
  canvas.focus();
  canvas.setPointerCapture(ev.pointerId);  // a drag that leaves the stage still ends here
  const [x, y] = stagePoint(ev);
  player.pointerDown(x, y);
  ev.preventDefault();
});
canvas.addEventListener('pointerup', (ev) => {
  if (ev.button !== 0) return;
  const [x, y] = stagePoint(ev);
  player.pointerUp(x, y);
});
canvas.addEventListener('pointercancel', (ev) => {
  const [x, y] = stagePoint(ev);
  if (player.mouseDown) player.pointerUp(x, y);
});
// The middle and right buttons only ever reached the game as key codes (the game uses the
// middle one to deselect).  Middle-clicking must not start the browser's autoscroll.
canvas.addEventListener('mousedown', (ev) => {
  if (ev.button === 0) return;
  player.mouseButton(ev.button, true);
  ev.preventDefault();
});
addEventListener('mouseup', (ev) => {
  if (ev.button !== 0) player.mouseButton(ev.button, false);
});
canvas.addEventListener('auxclick', (ev) => ev.preventDefault());
// The original replaced Flash's right-click menu with a single "www.lego.com" item; here
// right-click does nothing rather than show the browser's menu over the game.
canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
canvas.addEventListener('wheel', (ev) => {
  // Flash on Windows reported wheel movement in lines, three per notch, up positive.
  if (ev.deltaY) player.wheel(ev.deltaY < 0 ? 3 : -3);
  ev.preventDefault();
}, { passive: false });

// The game traps every key (fscommand trapallkeys); browser shortcuts still work.
function trapped(ev) {
  return !(ev.ctrlKey || ev.metaKey || ev.altKey || /^F\d+$/.test(ev.key));
}
addEventListener('keydown', (ev) => {
  if (!trapped(ev)) return;
  player.keyDown(ev);
  ev.preventDefault();
});
addEventListener('keyup', (ev) => {
  player.keyUp(ev);
  if (trapped(ev)) ev.preventDefault();
});
// Keys and buttons held when the window loses focus would otherwise stay down forever.
addEventListener('blur', () => {
  for (const code of [...player.keys]) player.keyUp({ keyCode: code, key: '' });
});

// ---- the frame loop ----------------------------------------------------------------------
// Fixed 23fps steps.  Flash never skipped a frame's logic; after a long stall (a hidden
// tab) this resumes rather than racing to catch up.
const STEP = 1000 / FPS;
let last = 0;
let acc = 0;
function loop(now) {
  if (last) acc += Math.min(now - last, STEP * 4);
  last = now;
  let ticked = false;
  while (acc >= STEP) {
    player.tick();
    acc -= STEP;
    ticked = true;
  }
  if (ticked) player.draw();
  requestAnimationFrame(loop);
}

// ---- start ---------------------------------------------------------------------------------
async function start() {
  sizes = await fetch('data/sizes.json').then((r) => r.json());
  const loader = openMovie('loader');
  await loader.ready;
  resize();
  await player.loadLevel(0, loader.lib);
  player.draw();
  if (!TEST) requestAnimationFrame(loop);
}

start().catch((e) => {
  console.error(e);
  document.body.setAttribute('data-error', String(e && e.message || e));
  const note = document.createElement('p');
  note.className = 'failed';
  note.textContent = 'CrystAlien Conflict could not load. Check your connection and reload the page.';
  document.body.appendChild(note);
});
