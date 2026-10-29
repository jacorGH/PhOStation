/* Receives unpacked file data in pieces and writes it to storage, so nothing big stays in memory. */
importScripts('spill.js');

const sinks = new Map();
let next = 1;

onmessage = async (e) => {
  const { op, id, sid, dir, name, buf } = e.data;
  try {
    if (op === 'open') {
      const s = await Spill.open(dir, name);
      const k = next++;
      sinks.set(k, s);
      postMessage({ id, sid: k });
    } else if (op === 'write') {
      await sinks.get(sid).append(new Uint8Array(buf));
      postMessage({ id });
    } else if (op === 'close') {
      const s = sinks.get(sid);
      sinks.delete(sid);
      const file = await s.finish(null);
      postMessage({ id, file, kind: s.kind });
    }
  } catch (err) {
    postMessage({ id, error: (err && err.message) || String(err) });
  }
};
