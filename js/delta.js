/* Delta skin import. Delta has no PS1 skins, so SNES/N64/GBA skins are mapped onto PS1 buttons:
   a→Circle  b→Cross  x→Triangle  y→Square  l/r→L1/R1  zl/zr/z→L2/R2. Missing shoulder buttons get floating pills. */
(function () {
  const PS = window.PS;
  const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/';
  const NAME_MAP = {
    a: 8, b: 0, x: 9, y: 1, l: 10, r: 11, l1: 10, r1: 11, l2: 12, r2: 13, zl: 12, zr: 13, z: 12,
    start: 3, select: 2, up: 4, down: 5, left: 6, right: 7, l3: 14, r3: 15,
    cross: 0, circle: 8, square: 1, triangle: 9,
  };
  const ACTIONS = { menu: 'menu', quickSave: 'qs', quickLoad: 'ql', fastForward: 'ff', toggleFastForward: 'ff' };

  let pdfjsP = null;
  const loadScript = (src) => new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });

  async function pdfToBlob(bytes, width) {
    if (!pdfjsP) pdfjsP = loadScript(PDFJS + 'pdf.min.js').then(() => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js';
      return window.pdfjsLib;
    });
    const lib = await pdfjsP;
    const doc = await lib.getDocument({ data: bytes }).promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: width / base.width });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    return new Promise((r) => c.toBlob(r, 'image/png'));
  }

  async function asset(zip, dir, name, width) {
    if (!name) return null;
    const f = zip.file(dir + name) || zip.file(name);
    if (!f) return null;
    const bytes = await f.async('uint8array');
    return /\.pdf$/i.test(name) ? pdfToBlob(bytes, Math.max(64, width * 3)) : new Blob([bytes], { type: 'image/png' });
  }

  async function importSkin(file) {
    const zip = await JSZip.loadAsync(file);
    const infoPath = Object.keys(zip.files).find((p) => /(^|\/)info\.json$/i.test(p) && !p.startsWith('__MACOSX'));
    if (!infoPath) throw new Error('This file has no info.json, so it isn\u2019t a Delta skin.');
    const dir = infoPath.slice(0, infoPath.length - 'info.json'.length);
    const info = JSON.parse(await zip.file(infoPath).async('string'));
    const reps = info.representations || {};
    const dev = reps.iphone || reps.ipad || Object.values(reps)[0];
    if (!dev) throw new Error('The skin has no iPhone layouts.');
    const variant = dev.edgeToEdge || dev.standard || Object.values(dev)[0];

    const skin = { id: 'delta-' + Date.now(), name: info.name || file.name.replace(/\.\w+$/, ''), reps: {} };
    for (const o of ['portrait', 'landscape']) {
      const r = variant[o];
      if (!r || !r.mappingSize) continue;
      const ms = r.mappingSize;
      const a = r.assets || {};
      const img = await asset(zip, dir, a.resizable || a.large || a.medium || a.small, ms.width);
      const items = [];
      for (const it of r.items || []) {
        const item = {
          frame: it.frame,
          ext: Object.assign({ top: 0, bottom: 0, left: 0, right: 0 }, r.extendedEdges || {}, it.extendedEdges || {}),
          inputs: it.inputs,
          thumb: it.thumbstick || null,
          thumbImg: null,
        };
        if (item.thumb && item.thumb.name) item.thumbImg = await asset(zip, dir, item.thumb.name, item.thumb.width || 60);
        items.push(item);
      }
      const screen = (r.screens && r.screens[0] && r.screens[0].outputFrame) || r.gameScreenFrame || null;
      skin.reps[o] = { mw: ms.width, mh: ms.height, img, items, screen };
    }
    if (!Object.keys(skin.reps).length) throw new Error('No usable portrait or landscape layout found.');
    return skin;
  }

  function classify(item) {
    const inp = item.inputs;
    if (Array.isArray(inp)) {
      let bits = 0, act = null;
      for (const n of inp) {
        if (n in NAME_MAP) bits |= 1 << NAME_MAP[n];
        else if (ACTIONS[n]) act = ACTIONS[n];
      }
      return bits ? { kind: 'btn', bits } : act ? { kind: 'act', act } : null;
    }
    if (inp && typeof inp === 'object') {
      const vals = Object.values(inp).join(' ');
      if (item.thumb || /analog|stick|thumb/i.test(vals)) {
        return { kind: 'stick', idx: /right|^c[A-Z]|\bc[A-Z]/.test(vals) ? 1 : 0 };
      }
      return { kind: 'dpad', map: [inp.up, inp.down, inp.left, inp.right].map((n) => (n in NAME_MAP ? NAME_MAP[n] : null)) };
    }
    return null;
  }

  // ---------- storage ----------
  const urlCache = new Map();
  async function list() { return (await PS.store.get('skins')) || []; }
  async function save(skin) {
    await PS.store.set('skin:' + skin.id, skin);
    const l = await list();
    l.push({ id: skin.id, name: skin.name });
    await PS.store.set('skins', l);
  }
  async function remove(id) {
    await PS.store.del('skin:' + id);
    await PS.store.set('skins', (await list()).filter((s) => s.id !== id));
    urlCache.delete(id);
  }
  async function load(id) {
    if (urlCache.has(id)) return urlCache.get(id);
    const skin = await PS.store.get('skin:' + id);
    if (!skin) return null;
    for (const rep of Object.values(skin.reps)) {
      rep.imgUrl = rep.img ? URL.createObjectURL(rep.img) : null;
      rep.items.forEach((it) => { it.thumbUrl = it.thumbImg ? URL.createObjectURL(it.thumbImg) : null; });
    }
    urlCache.set(id, skin);
    return skin;
  }

  PS.delta = { importSkin, classify, list, save, remove, load };
})();
