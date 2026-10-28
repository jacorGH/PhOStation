/* Converts one PS1 disc (.cue + .bin files, or a single raw .bin/.img/.iso) into a .pbp.
   Layout follows popstation: PBP header -> PARAM.SFO -> DATA.PSAR ("PSISOIMG0000" header,
   TOC at +0x800, block index at +0x4000, raw-deflate blocks of 16 sectors from +0x100000).
   Output is written to the Origin Private File System so the result never sits in memory. */
importScripts('https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js');

const SECT = 2352;
const BLOCK_SECT = 16;
const BLOCK = SECT * BLOCK_SECT; // 0x9300
const MAX_BLOCKS = (0x100000 - 0x4000) / 32 - 1; // last index slot is the terminator
const BATCH = 64; // blocks read per file slice

const bcd = (n) => ((n / 10) | 0) * 16 + (n % 10);
const toMsf = (s) => [Math.floor(s / 4500), Math.floor(s / 75) % 60, s % 75];
const parseTime = (t) => { const [m, s, f] = t.split(':').map(Number); return (m * 60 + s) * 75 + f; };
const u32 = (dv, at, v) => dv.setUint32(at, v >>> 0, true);
const ascii = (buf, at, str) => { for (let i = 0; i < str.length; i++) buf[at + i] = str.charCodeAt(i) & 0xff; };

// ---------- disc layout ----------
function layoutFromCue(text, files) {
  const byName = new Map(files.map((f) => [f.name.toLowerCase(), f]));
  const segs = [];
  const tracks = [];
  let fileStart = 0, extra = 0, curTrack = null;
  const total = () => segs.reduce((n, s) => n + s.count, 0);

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    let m;
    if ((m = line.match(/^FILE\s+"(.+)"\s+\S+$/i) || line.match(/^FILE\s+(\S+)\s+\S+$/i))) {
      const name = m[1].split(/[\\/]/).pop();
      const f = byName.get(name.toLowerCase());
      if (!f) throw new Error(`The .cue needs \u201c${name}\u201d. Select it together with the .cue.`);
      if (f.size % SECT) throw new Error(`\u201c${name}\u201d isn\u2019t a raw 2352-byte disc image.`);
      fileStart = total();
      extra = 0;
      segs.push({ file: f, from: 0, count: f.size / SECT });
    } else if ((m = line.match(/^TRACK\s+(\d+)\s+(\S+)/i))) {
      curTrack = { num: +m[1], audio: /^AUDIO$/i.test(m[2]), pregap: 0, start: null };
      tracks.push(curTrack);
    } else if ((m = line.match(/^PREGAP\s+(\d+:\d+:\d+)/i)) && curTrack) {
      curTrack.pregap = parseTime(m[1]);
    } else if ((m = line.match(/^INDEX\s+01\s+(\d+:\d+:\d+)/i)) && curTrack) {
      const rel = parseTime(m[1]);
      if (curTrack.pregap) {
        // Insert silent sectors that aren't stored in the .bin.
        const last = segs.pop();
        const cut = rel - last.from;
        if (cut > 0) segs.push({ file: last.file, from: last.from, count: cut });
        segs.push({ zero: true, count: curTrack.pregap });
        segs.push({ file: last.file, from: rel, count: last.count - Math.max(cut, 0) });
        extra += curTrack.pregap;
      }
      curTrack.start = fileStart + rel + extra;
    }
  }
  if (!tracks.length || tracks.some((t) => t.start == null)) throw new Error('This .cue file couldn\u2019t be read.');
  return finish(segs.filter((s) => s.count > 0), tracks);
}

function layoutFromBin(f) {
  if (f.size % SECT) {
    if (f.size % 2048 === 0) throw new Error(`\u201c${f.name}\u201d has 2048-byte sectors. PS1 games need the full raw .bin (2352-byte sectors).`);
    throw new Error(`\u201c${f.name}\u201d isn\u2019t a raw disc image.`);
  }
  return finish([{ file: f, from: 0, count: f.size / SECT }], [{ num: 1, audio: false, start: 0 }]);
}

function finish(segs, tracks) {
  let at = 0;
  for (const s of segs) { s.at = at; at += s.count; }
  return { segs, tracks, total: at };
}

async function readSectors(L, start, count) {
  const out = new Uint8Array(count * SECT);
  let pos = start, filled = 0;
  const end = Math.min(start + count, L.total);
  while (pos < end) {
    const s = L.segs.find((x) => pos >= x.at && pos < x.at + x.count);
    const n = Math.min(end - pos, s.at + s.count - pos);
    if (!s.zero) {
      const off = (s.from + pos - s.at) * SECT;
      out.set(new Uint8Array(await s.file.slice(off, off + n * SECT).arrayBuffer()), filled * SECT);
    }
    pos += n; filled += n;
  }
  return out; // anything past the end of the disc stays zero (pads the last block)
}

// ---------- disc ID from SYSTEM.CNF ----------
async function discId(L) {
  try {
    const user = (sec) => sec.subarray(sec[15] === 1 ? 16 : 24, (sec[15] === 1 ? 16 : 24) + 2048);
    const pvd = user(await readSectors(L, 16, 1));
    if (String.fromCharCode(...pvd.subarray(1, 6)) !== 'CD001') return null;
    const dv = new DataView(pvd.buffer, pvd.byteOffset + 156);
    const lba = dv.getUint32(2, true), size = dv.getUint32(10, true);
    const nSec = Math.min(8, Math.ceil(size / 2048));
    const raw = await readSectors(L, lba, nSec);
    for (let s = 0; s < nSec; s++) {
      const dir = user(raw.subarray(s * SECT, (s + 1) * SECT));
      for (let i = 0; i < 2048;) {
        const len = dir[i];
        if (!len) break;
        const name = String.fromCharCode(...dir.subarray(i + 33, i + 33 + dir[i + 32]));
        if (/^SYSTEM\.CNF/i.test(name)) {
          const rdv = new DataView(dir.buffer, dir.byteOffset + i);
          const cnf = user(await readSectors(L, rdv.getUint32(2, true), 1));
          const txt = new TextDecoder().decode(cnf.subarray(0, Math.min(2048, rdv.getUint32(10, true))));
          const m = txt.match(/BOOT\s*=\s*cdrom:?\\*([A-Z]{4})[_-]?(\d{3})\.?(\d{2})/i);
          return m ? (m[1] + m[2] + m[3]).toUpperCase() : null;
        }
        i += len;
      }
    }
  } catch (e) {}
  return null;
}

// ---------- PARAM.SFO ----------
function buildSfo(title, id) {
  const entries = [
    ['BOOTABLE', 'int', 1, 4],
    ['CATEGORY', 'str', 'ME', 4],
    ['DISC_ID', 'str', id, 16],
    ['DISC_VERSION', 'str', '1.00', 8],
    ['PARENTAL_LEVEL', 'int', 1, 4],
    ['PSP_SYSTEM_VER', 'str', '3.01', 8],
    ['REGION', 'int', 0x8000, 4],
    ['TITLE', 'str', title.slice(0, 120), 128],
  ];
  const enc = new TextEncoder();
  const keyBytes = entries.map(([k]) => enc.encode(k + '\0'));
  let keyLen = keyBytes.reduce((n, b) => n + b.length, 0);
  keyLen = (keyLen + 3) & ~3;
  const dataLen = entries.reduce((n, e) => n + e[3], 0);
  const keyStart = 20 + entries.length * 16;
  const dataStart = keyStart + keyLen;
  const buf = new Uint8Array(dataStart + dataLen);
  const dv = new DataView(buf.buffer);
  buf.set([0x00, 0x50, 0x53, 0x46]);
  u32(dv, 4, 0x00000101); u32(dv, 8, keyStart); u32(dv, 12, dataStart); u32(dv, 16, entries.length);
  let ko = 0, doff = 0;
  entries.forEach(([, type, value, max], i) => {
    const at = 20 + i * 16;
    const data = type === 'int' ? null : enc.encode(value + '\0');
    dv.setUint16(at, ko, true);
    dv.setUint16(at + 2, type === 'int' ? 0x0404 : 0x0204, true);
    u32(dv, at + 4, type === 'int' ? 4 : Math.min(data.length, max));
    u32(dv, at + 8, max);
    u32(dv, at + 12, doff);
    buf.set(keyBytes[i], keyStart + ko);
    if (type === 'int') u32(dv, dataStart + doff, value);
    else buf.set(data.subarray(0, max), dataStart + doff);
    ko += keyBytes[i].length; doff += max;
  });
  return buf;
}

// ---------- output ----------
async function makeWriter(dir, name) {
  try {
    const root = await navigator.storage.getDirectory();
    const d = await root.getDirectoryHandle(dir, { create: true });
    const fh = await d.getFileHandle(name, { create: true });
    const h = await fh.createSyncAccessHandle();
    h.truncate(0);
    return { opfs: true, write: (buf, at) => h.write(buf, { at }), finish: async () => { h.flush(); h.close(); return fh.getFile(); } };
  } catch (e) {
    // No OPFS: keep the pieces in memory instead.
    const parts = [];
    return {
      opfs: false,
      write: (buf, at) => parts.push({ at, buf }),
      finish: async () => new File(parts.sort((a, b) => a.at - b.at).map((p) => p.buf), name, { type: 'application/octet-stream' }),
    };
  }
}

// ---------- main ----------
onmessage = async (e) => {
  const { files, cueName, binName, title, outName, outDir } = e.data;
  try {
    let L;
    if (cueName) {
      const cue = files.find((f) => f.name === cueName);
      L = layoutFromCue(await cue.text(), files);
    } else L = layoutFromBin(files.find((f) => f.name === binName));

    const nBlocks = Math.ceil(L.total / BLOCK_SECT);
    if (nBlocks > MAX_BLOCKS) throw new Error('This disc is too large for the .pbp format.');

    const id = (await discId(L)) || 'SLUS00000';
    const sfo = buildSfo(title, id);
    const psarOff = (0x28 + sfo.length + 15) & ~15;
    const dataStart = psarOff + 0x100000;
    const out = await makeWriter(outDir, outName);

    // Compress the disc in 16-sector blocks.
    const index = [];
    let dataPos = 0;
    for (let b = 0; b < nBlocks; b += BATCH) {
      const n = Math.min(BATCH, nBlocks - b);
      const chunk = await readSectors(L, b * BLOCK_SECT, n * BLOCK_SECT);
      for (let i = 0; i < n; i++) {
        const c = fflate.deflateSync(chunk.subarray(i * BLOCK, (i + 1) * BLOCK), { level: 6 });
        out.write(c, dataStart + dataPos);
        index.push([dataPos, c.length]);
        dataPos += c.length;
      }
      postMessage({ type: 'progress', p: Math.min(1, (b + n) / nBlocks) });
    }

    // Header area: PBP header, PARAM.SFO, PSISOIMG header, TOC, block index.
    const head = new Uint8Array(dataStart);
    const dv = new DataView(head.buffer);
    head.set([0x00, 0x50, 0x42, 0x50]);
    u32(dv, 4, 0x00010000);
    u32(dv, 8, 0x28);
    for (let k = 1; k < 7; k++) u32(dv, 8 + k * 4, 0x28 + sfo.length); // ICON0..DATA.PSP: empty
    u32(dv, 0x24, psarOff);
    head.set(sfo, 0x28);

    const P = psarOff;
    ascii(head, P, 'PSISOIMG0000');
    u32(dv, P + 0x0c, 0x100000 + dataPos);
    ascii(head, P + 0x400, `_${id.slice(0, 4)}_${id.slice(4)}`);

    // TOC (Q-subchannel style). pcsx reads A1 for the track count and A2 for the lead-out.
    const t = L.tracks;
    const ctl = (tr) => (tr.audio ? 0x01 : 0x41);
    let at = P + 0x800;
    const entry = (bytes) => { head.set(bytes, at); at += 10; };
    entry([ctl(t[0]), 0, 0xa0, 0, 0, 0, 0, bcd(t[0].num), 0x20, 0]);
    entry([ctl(t[t.length - 1]), 0, 0xa1, 0, 0, 0, 0, bcd(t[t.length - 1].num), 0, 0]);
    const lo = toMsf(L.total + 150);
    entry([ctl(t[t.length - 1]), 0, 0xa2, 0, 0, 0, 0, bcd(lo[0]), bcd(lo[1]), bcd(lo[2])]);
    for (const tr of t) {
      const a = toMsf(tr.start), p = toMsf(tr.start + 150);
      entry([ctl(tr), 0, bcd(tr.num), bcd(a[0]), bcd(a[1]), bcd(a[2]), 0, bcd(p[0]), bcd(p[1]), bcd(p[2])]);
    }

    index.forEach(([off, size], i) => { u32(dv, P + 0x4000 + i * 32, off); u32(dv, P + 0x4000 + i * 32 + 4, size); });
    u32(dv, P + 0x4000 + index.length * 32, dataPos); // terminator: size 0
    out.write(head, 0);

    const file = await out.finish();
    postMessage({ type: 'done', file, opfs: out.opfs, id, ratio: file.size / (L.total * SECT) });
  } catch (err) {
    postMessage({ type: 'error', message: err.message || String(err) });
  }
};
