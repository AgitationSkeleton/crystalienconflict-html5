// Sound, through Web Audio.
//
// Flash plays two kinds here: event sounds started by a timeline's StartSound tags
// (every effect in the game goes through the soundFX clip this way), and Sound objects,
// which this game only uses to mute a clip -- `new Sound(mc).setVolume(0)`.  A Sound
// object's volume applies to the sounds owned by that clip and everything inside it, so
// a sound's gain is the product of the volumes up its owner's ancestry.
//
// Browsers only let audio start after a click or key press.  The original's own first
// screen is a PLAY button, so by the time anything is meant to be heard, audio is live.

export class SoundSystem {
  constructor(player) {
    this.player = player;
    this.ctx = null;
    this.master = null;
    this.playing = new Set();       // {id, lib, owner, src, gain}
  }

  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  get live() {
    return this.ctx && this.ctx.state === 'running';
  }

  async buffer(lib, id) {
    const s = lib.sounds.get(id);
    if (!s) return null;
    if (s.buffer) return s.buffer;
    if (!s.decoding) {
      // decodeAudioData detaches its input, so decode a copy.
      s.decoding = this.ctx.decodeAudioData(s.data.slice(0)).then((b) => (s.buffer = b)).catch(() => null);
    }
    return s.decoding;
  }

  volumeOf(owner) {
    let v = 1;
    for (let o = owner; o; o = o.$parent) {
      if (o.$soundVolume !== undefined) v *= o.$soundVolume / 100;
    }
    return Math.max(0, v);
  }

  refreshVolumes() {
    for (const p of this.playing) p.gain.gain.value = this.volumeOf(p.owner) * p.envelope;
  }

  // A StartSound tag: SOUNDINFO decides whether it stops, restarts, or loops.
  timelineSound(owner, id, info) {
    this.start(owner.$lib, id, owner, info || {});
  }

  start(lib, id, owner, info) {
    if (!this.live) return null;
    if (info.syncStop) {
      for (const p of [...this.playing]) if (p.id === id && p.lib === lib) this.stopOne(p);
      return null;
    }
    if (info.syncNoMultiple) {
      for (const p of this.playing) if (p.id === id && p.lib === lib) return null;
    }
    const entry = { id, lib, owner, src: null, gain: null, envelope: 1, stopped: false };
    this.playing.add(entry);
    this.buffer(lib, id).then((buf) => {
      if (!buf || entry.stopped) {
        this.playing.delete(entry);
        return;
      }
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      const gain = this.ctx.createGain();
      if (info.envelope && info.envelope.length) {
        // Envelope points are in 44.1kHz samples with levels 0..32768 per channel;
        // both channels are averaged, which is all this game's sounds would need.
        const t0 = this.ctx.currentTime;
        const lvl = (e) => ((e[1] + e[2]) / 2) / 32768;
        entry.envelope = lvl(info.envelope[0]);
        gain.gain.setValueAtTime(this.volumeOf(owner) * entry.envelope, t0);
        for (const e of info.envelope) gain.gain.linearRampToValueAtTime(this.volumeOf(owner) * lvl(e), t0 + e[0] / 44100);
      } else {
        gain.gain.value = this.volumeOf(owner);
      }
      src.connect(gain);
      gain.connect(this.master);
      entry.src = src;
      entry.gain = gain;
      const loops = Math.max(1, info.loops || 1);
      const inPt = info.inPoint ? info.inPoint / 44100 : 0;
      const outPt = info.outPoint ? info.outPoint / 44100 : buf.duration;
      const length = Math.max(0, outPt - inPt);
      if (loops > 1) {
        src.loop = true;
        src.loopStart = inPt;
        src.loopEnd = outPt;
        src.start(0, inPt, length * loops);
      } else {
        src.start(0, inPt, length);
      }
      src.onended = () => {
        this.playing.delete(entry);
        if (entry.onComplete) entry.onComplete();
      };
    });
    return entry;
  }

  stopOne(p) {
    p.stopped = true;
    this.playing.delete(p);
    if (p.src) {
      try { p.src.onended = null; p.src.stop(); } catch (e) { /* already stopped */ }
    }
  }

  stopAll() {
    for (const p of [...this.playing]) this.stopOne(p);
  }

  // Stop everything owned by a clip that has left the stage.  Flash lets event sounds
  // finish even then, so this is only used by Sound.stop().
  stopOwnedBy(owner, id) {
    for (const p of [...this.playing]) {
      let o = p.owner;
      while (o && o !== owner) o = o.$parent;
      if (o && (id === undefined || p.id === id)) this.stopOne(p);
    }
  }
}
