// Random play, for smoke.py: every few frames press somewhere on the stage (now and then
// dragging), now and then press a key the game uses, for 3000 frames; then report any
// script errors and the state of the game.  Runs in test mode (__step).
(() => {
  // Random play: every few frames press somewhere on the stage, sometimes drag, sometimes
  // press a key, and keep going; report any script errors and the game's state.
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
  const keys = [32, 37, 38, 39, 40, 49, 50, 72, 16];
  const t0 = performance.now();
  for (let i = 0; i < 3000; i++) {
    if (i % 9 === 0) {
      const x = rnd() < 0.3 ? rnd() * 150 : 150 + rnd() * 450, y = rnd() * 400;
      player.pointerMove(x, y);
      player.pointerDown(x, y);
      __step(1);
      if (rnd() < 0.2) { player.pointerMove(x + rnd() * 120 - 60, y + rnd() * 120 - 60); __step(3); }
      player.pointerUp(player.mouse[0], player.mouse[1]);
    }
    if (i % 23 === 0) {
      const k = keys[Math.floor(rnd() * keys.length)];
      player.keyDown({ keyCode: k, key: k === 32 ? ' ' : '' });
      __step(2);
      player.keyUp({ keyCode: k, key: '' });
    }
    __step(1);
  }
  const lv = player.levels[1].panel.game && player.levels[1].panel.game.level;
  return { ms: Math.round(performance.now() - t0), frame: player.frame, errors: [...player.errors.entries()], state: player.levels[1].panel.state,
    units: lv && lv.units.length, buildings: lv && lv.buildings.length, cash: lv && lv.cash };
})()
