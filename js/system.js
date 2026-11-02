/* PS1 or PSP? .iso, .pbp and .chd are used by both, so look inside the file.
   - .cso, .elf, .prx: PSP only.
   - .bin/.cue/.img/.m3u: PS1.
   - .iso: PSP discs are 2048-byte-sector UMDs whose volume header says "PSP GAME".
   - .pbp: PS1 classics contain "PSISOIMG"/"PSTITLEIMG"; anything else is a PSP game or homebrew.
   - .chd: PS1 discs are stored as CD tracks ("CHT2"/"CHTR"/"CHCD"); PSP UMDs as "DVD ". */
(function () {
  const PS = window.PS;
  const ascii = (u8) => String.fromCharCode(...u8);
  const read = async (f, at, n) => new Uint8Array(await f.slice(at, at + n).arrayBuffer());

  async function detectFile(f) {
    const n = f.name.toLowerCase();
    if (/\.(cso|elf|prx)$/.test(n)) return 'psp';
    if (/\.(bin|cue|img|m3u|ccd|sub|sbi|mdf|mds|toc)$/.test(n)) return 'psx';
    try {
      if (n.endsWith('.iso')) {
        const pvd = await read(f, 0x8000, 0x30); // ISO 9660 primary volume descriptor at sector 16
        return ascii(pvd.subarray(1, 6)) === 'CD001' && /PSP GAME/i.test(ascii(pvd.subarray(8, 40))) ? 'psp' : 'psx';
      }
      if (n.endsWith('.pbp')) {
        const h = new DataView((await read(f, 0, 0x28)).buffer);
        const psar = h.getUint32(0x24, true);
        const sig = ascii(await read(f, psar, 10));
        return /^PSISOIMG|^PSTITLEIMG/.test(sig) ? 'psx' : 'psp';
      }
      if (n.endsWith('.chd')) {
        const h = await read(f, 0, 124);
        if (ascii(h.subarray(0, 8)) !== 'MComprHD') return 'psx';
        const dv = new DataView(h.buffer);
        const ver = dv.getUint32(12);
        const metaAt = ver >= 5 ? Number(dv.getBigUint64(48)) : ver >= 3 ? Number(dv.getBigUint64(36)) : 0;
        if (!metaAt) return 'psx';
        const tag = ascii(await read(f, metaAt, 4));
        return tag === 'DVD ' ? 'psp' : 'psx';
      }
    } catch (e) {}
    return 'psx';
  }

  // A set is PSP if its main disc is.
  async function detect(files) {
    const main = files.find((f) => /\.(cso|iso|pbp|chd|elf|prx)$/i.test(f.name)) || files[0];
    return main ? detectFile(main) : 'psx';
  }

  // PSP runs only with threads (SharedArrayBuffer, which needs a cross-origin-isolated page)
  // and isn't supported on Safari's engine, which every iPhone and iPad browser uses.
  const isWebKitOnly = /iP(hone|ad|od)/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    || (/Safari\//.test(navigator.userAgent) && !/(Chrome|Chromium|CriOS|Edg|Firefox|FxiOS|OPR)\//.test(navigator.userAgent));
  // What PSP needs from the browser, for the readiness check.
  function readiness() {
    let webgl2 = false;
    try { webgl2 = !!document.createElement('canvas').getContext('webgl2'); } catch (e) {}
    return {
      isolated: !!window.crossOriginIsolated,
      sab: typeof SharedArrayBuffer === 'function',
      webgl2,
      threads: typeof navigator.hardwareConcurrency === 'number' ? navigator.hardwareConcurrency : null,
    };
  }

  function pspSupport() {
    if (isWebKitOnly && !PS.prefs.pspExperimental) {
      return { ok: false, why: 'EmulatorJS\u2019s PSP emulator doesn\u2019t officially support iPhone or iPad. You can try it anyway: Settings, Experimental, \u201cTry PSP on this iPhone\u201d. Or host PSP games from Android or a computer and join from iPhone.' };
    }
    if (!window.crossOriginIsolated) {
      return {
        ok: false, reload: true,
        why: isWebKitOnly
          ? 'Experimental PSP mode needs one reload to switch on. Reload the page from its https:// address (not a code editor\u2019s preview). If it still shows this, Safari didn\u2019t accept the setting and PSP can\u2019t run here.'
          : 'PSP needs a one-time reload to switch on the threads it uses. Reload the page. If this keeps appearing, open PhoStation from its https:// GitHub Pages address in Chrome or Edge (it can\u2019t work in a code editor\u2019s preview).',
      };
    }
    return { ok: true, experimental: isWebKitOnly };
  }

  PS.system = { detect, detectFile, pspSupport, readiness, isWebKitOnly };
})();
