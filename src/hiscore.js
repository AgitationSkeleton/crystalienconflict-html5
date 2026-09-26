// The high-score table's server (docs/high-score-server.md), and the name a score goes under.
// LEGO's server knew who was logged in; here the player is asked, when a finished Conflict
// run's score is about to be sent, with the last name they gave filled in.

// The server; ?server=URL (the server's root) points the game at another, for testing.
export function scoreServer(params) {
  const root = params.get('server') || 'https://cacserver.viosarcade.xyz';
  return root.replace(/\/+$/, '') + '/hiscore';
}

const KEY = 'cac.hiscoreName';

function remembered() {
  try {
    return localStorage.getItem(KEY) || '';
  } catch (e) {
    return '';
  }
}

function remember(name) {
  try {
    localStorage.setItem(KEY, name);
  } catch (e) {
    // (a private window: asked again next time)
  }
}

const STYLE = `
.hs-dialog { position: fixed; inset: 0; display: grid; place-items: center; background: rgba(0, 0, 0, 0.55); z-index: 1000;
  font: 15px/1.3 system-ui, sans-serif; color: #fff; }
.hs-dialog form { background: #151518; border: 2px solid #ff8a00; border-radius: 8px; padding: 18px 20px; width: min(340px, calc(100vw - 32px));
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.6); }
.hs-dialog p { margin: 0 0 10px; }
.hs-dialog input { width: 100%; box-sizing: border-box; font: inherit; padding: 8px 10px; border-radius: 4px; border: 1px solid #777;
  background: #000; color: #fff; text-transform: uppercase; }
.hs-dialog .row { display: flex; gap: 10px; justify-content: flex-end; margin-top: 14px; }
.hs-dialog button { font: inherit; padding: 7px 14px; border-radius: 4px; border: 1px solid #ff8a00; background: #2a1a05; color: #fff; cursor: pointer; }
.hs-dialog button[type=submit] { background: #ff8a00; color: #000; font-weight: 600; }
`;

// A promise of the name (at most 15 characters, as the table shows), or null if the player
// would rather not.  `suggested` is filled in when no name has been given before.
export function askScoreName(suggested = '') {
  return new Promise((resolve) => {
    if (!document.getElementById('hs-style')) {
      const st = document.createElement('style');
      st.id = 'hs-style';
      st.textContent = STYLE;
      document.head.appendChild(st);
    }
    const box = document.createElement('div');
    box.className = 'hs-dialog';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.innerHTML = '<form><p>Your name for the high-score table:</p><input maxlength="15" autocomplete="nickname" spellcheck="false" aria-label="Name">' +
      '<div class="row"><button type="button" class="skip">Don\'t save</button><button type="submit">Save score</button></div></form>';
    const input = box.querySelector('input');
    input.value = remembered() || suggested || '';
    // The game listens for keys on the window: they stay with the dialog.
    for (const t of ['keydown', 'keyup', 'keypress', 'pointerdown', 'mousedown', 'wheel']) box.addEventListener(t, (ev) => ev.stopPropagation());
    const done = (name) => {
      box.remove();
      resolve(name);
    };
    box.querySelector('form').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const name = input.value.replace(/\s+/g, ' ').trim().slice(0, 15);
      if (!name) {
        input.focus();
        return;
      }
      remember(name);
      done(name);
    });
    box.querySelector('.skip').addEventListener('click', () => done(null));
    document.body.appendChild(box);
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  });
}
