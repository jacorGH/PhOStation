/* Spill: write large outputs straight to storage instead of memory. Used inside workers.
   Prefers the Origin Private File System (sync access handles). Where that's missing
   (older iOS, in-app browsers like Textastic's preview), it writes 8 MB chunks to IndexedDB
   and stitches them back together as a disk-backed File. */
self.Spill = (() => {
  const CHUNK = 8 * 1024 * 1024;
  let dbp = null;

  const db = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('phostation-spill', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('chunks');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const done = (tx) => new Promise((res, rej) => {
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error || new Error('Phone storage is full.'));
  });
  const range = (prefix) => IDBKeyRange.bound(prefix, prefix + '\uffff');

  async function put(key, blob) {
    const tx = (await db()).transaction('chunks', 'readwrite');
    tx.objectStore('chunks').put(blob, key);
    await done(tx);
  }
  async function getAll(prefix) {
    const q = (await db()).transaction('chunks').objectStore('chunks').getAll(range(prefix));
    return new Promise((res, rej) => { q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  }
  async function remove(prefix) {
    const tx = (await db()).transaction('chunks', 'readwrite');
    tx.objectStore('chunks').delete(range(prefix));
    await done(tx);
  }

  // headerSize reserves space at the start that finish(head) fills in last.
  async function open(dir, name, headerSize = 0) {
    try {
      if (!navigator.storage || !navigator.storage.getDirectory) throw new Error('no opfs');
      const root = await navigator.storage.getDirectory();
      const d = await root.getDirectoryHandle(dir, { create: true });
      const fh = await d.getFileHandle(name, { create: true });
      const h = await fh.createSyncAccessHandle();
      h.truncate(0);
      let pos = 0;
      return {
        kind: 'opfs',
        async append(buf) { h.write(buf, { at: headerSize + pos }); pos += buf.byteLength; },
        async finish(head) {
          if (head) h.write(head, { at: 0 });
          h.flush(); h.close();
          return fh.getFile();
        },
      };
    } catch (e) {
      const prefix = `${dir}/${name}/`;
      await remove(prefix);
      let buf = new Uint8Array(CHUNK), fill = 0, n = 0;
      const flush = async () => {
        if (!fill) return;
        await put(prefix + String(n++).padStart(6, '0'), new Blob([buf.subarray(0, fill)]));
        buf = new Uint8Array(CHUNK);
        fill = 0;
      };
      return {
        kind: 'idb',
        async append(data) {
          for (let off = 0; off < data.length;) {
            const k = Math.min(CHUNK - fill, data.length - off);
            buf.set(data.subarray(off, off + k), fill);
            fill += k; off += k;
            if (fill === CHUNK) await flush();
          }
        },
        async finish(head) {
          await flush();
          buf = null;
          const parts = await getAll(prefix);
          return new File(head ? [head, ...parts] : parts, name);
        },
      };
    }
  }

  return { open, remove };
})();
