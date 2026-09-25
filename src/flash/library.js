// A movie's library: its characters, timelines and media, loaded from the files
// tools/build_library.py produced from the original SWF.
//
// Loading reports bytes as they arrive so that getBytesLoaded()/getBytesTotal() mean what
// they meant in Flash -- the loader's progress bar is driven by exactly those two calls.

export class Library {
  constructor(movie, base) {
    this.movie = movie;
    this.base = base;              // e.g. "assets/game/"
    this.json = null;
    this.chars = null;
    this.exports = {};
    this.bitmaps = new Map();       // id -> ImageBitmap
    this.sounds = new Map();        // id -> { data: ArrayBuffer, buffer: AudioBuffer|null }
    this.paths = new Map();         // cache key -> Path2D
    this.bytesLoaded = 0;
    this.bytesTotal = 1;            // never 0: the loader divides by it
    this.complete = false;
  }

  char(id) {
    return this.chars[id];
  }

  exportId(name) {
    const id = this.exports[name];
    return id === undefined ? null : id;
  }

  path(key, d) {
    let p = this.paths.get(key);
    if (!p) {
      p = new Path2D(d);
      this.paths.set(key, p);
    }
    return p;
  }

  // Three downloads -- the JSON, the bitmap pack and the sound pack -- side by side, their
  // sizes known in advance from data/sizes.json.  The byte count stops one short of the
  // total until the bitmaps are decoded, so the movie never looks loaded before it is.
  async load(dataUrl, sizes, onProgress) {
    const files = [dataUrl, this.base + 'bitmaps.bin', this.base + 'sounds.bin'];
    this.bytesTotal = Math.max(1, files.reduce((s, f) => s + ((sizes && sizes[f]) || 0), 0));
    const got = [0, 0, 0];
    const report = () => {
      this.bytesLoaded = Math.min(this.bytesTotal - 1, got[0] + got[1] + got[2]);
      if (onProgress) onProgress(this);
    };
    const [jsonBytes, bitmapPack, soundPack] = await Promise.all(files.map((f, i) =>
      fetchBytes(f, (n) => { got[i] = n; report(); })));

    this.json = JSON.parse(new TextDecoder('utf-8').decode(jsonBytes));
    this.chars = this.json.chars;
    this.exports = this.json.exports;

    const ids = Object.keys(this.chars);
    const bitmapIds = ids.filter((id) => this.chars[id].t === 'bitmap');
    const decode = async (id) => {
      const ch = this.chars[id];
      const [at, len] = ch.pack;
      const blob = new Blob([bitmapPack.subarray(at, at + len)], { type: ch.type });
      this.bitmaps.set(+id, await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'default' }));
    };
    for (let i = 0; i < bitmapIds.length; i += 64) await Promise.all(bitmapIds.slice(i, i + 64).map(decode));

    // Sounds are decoded on first play: an AudioContext may not exist yet (browsers only
    // allow one after a click), and decoding 160 files up front would delay the start.
    for (const id of ids) {
      const ch = this.chars[id];
      if (ch.t !== 'sound') continue;
      const [at, len] = ch.pack;
      this.sounds.set(+id, { data: soundPack.buffer.slice(soundPack.byteOffset + at, soundPack.byteOffset + at + len), buffer: null });
    }

    this.bytesLoaded = this.bytesTotal;
    this.complete = true;
    if (onProgress) onProgress(this);
  }
}

async function fetchBytes(url, onBytes) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('failed to load ' + url + ': ' + r.status);
  if (!r.body || !r.body.getReader) {
    const b = new Uint8Array(await r.arrayBuffer());
    onBytes(b.byteLength);
    return b;
  }
  const reader = r.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    n += value.byteLength;
    onBytes(n);
  }
  const all = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.byteLength;
  }
  return all;
}
