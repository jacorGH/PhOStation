/* PhoStation controls. Output state: { b: 16-bit button mask (EmulatorJS indices), a: [lx, ly, rx, ry] } */
(function () {
  const PS = window.PS;
  // EmulatorJS / RetroPad indices with PlayStation names
  const B = { cross: 0, square: 1, select: 2, start: 3, up: 4, down: 5, left: 6, right: 7, circle: 8, triangle: 9, l1: 10, r1: 11, l2: 12, r2: 13, l3: 14, r3: 15 };
  const ZERO = () => ({ b: 0, a: [0, 0, 0, 0] });

  let root = null, opts = {};
  const pointers = new Map();
  let touch = ZERO(), pad = ZERO(), kb = 0, out = ZERO();
  // Turbo: held turbo buttons flick on/off about 15 times a second.
  let turboMask = 0, turboPhase = true, turboTimer = null, rawHeld = 0, paintedRaw = -1;
  let bitEls = [];
  let dpadEls = [];

  // ---------- haptics ----------
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let hapt = null;
  function buzz() {
    if (!PS.prefs.haptics) return;
    if (navigator.vibrate) { navigator.vibrate(8); return; }
    if (isIOS) {
      // iOS 18+: toggling a native switch inside a user gesture produces a tick.
      if (!hapt) {
        hapt = document.createElement('label');
        hapt.setAttribute('aria-hidden', 'true');
        hapt.style.cssText = 'position:fixed;left:-99px;top:0;width:1px;height:1px;overflow:hidden;opacity:0';
        hapt.innerHTML = '<input type="checkbox" switch>';
        document.body.appendChild(hapt);
      }
      hapt.click();
    }
  }

  // ---------- hit testing ----------
  const SEL = '[data-btn],[data-dpad],[data-stick],[data-act],[data-hold]';
  function targetAt(x, y) {
    const el = document.elementFromPoint(x, y);
    return el && root.contains(el) ? el.closest(SEL) : null;
  }
  const maskOf = (list) => list.split(',').filter(Boolean).reduce((m, n) => m | (1 << +n), 0);

  function dpadBits(el, x, y) {
    const map = (el.dataset.dpad || '4,5,6,7').split(',').map((n) => (n === '' ? null : +n));
    const [U, D, L, R] = map.map((n) => (n == null ? 0 : 1 << n));
    const r = el.getBoundingClientRect();
    const dx = (x - (r.left + r.width / 2)) / (r.width / 2);
    const dy = (y - (r.top + r.height / 2)) / (r.height / 2);
    if (Math.hypot(dx, dy) < 0.2) return 0;
    const sector = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)); // -4..4, 0 = right
    return ({ 0: R, 1: D | R, 2: D, 3: D | L, 4: L, '-4': L, '-3': U | L, '-2': U, '-1': U | R })[sector] || 0;
  }

  function update(p, x, y) {
    if (p.kind === 'stick') {
      let dx = (x - p.cx) / p.rad, dy = (y - p.cy) / p.rad;
      const len = Math.hypot(dx, dy);
      if (len > 1) { dx /= len; dy /= len; }
      p.vec = Math.hypot(dx, dy) < 0.12 ? [0, 0] : [dx, dy];
      const knob = p.el.querySelector('.knob');
      if (knob) knob.style.transform = `translate(${dx * 42}%, ${dy * 42}%)`;
    } else if (p.kind === 'dpad') {
      p.bits = dpadBits(p.el, x, y);
    } else {
      const t = targetAt(x, y);
      p.bits = t && t.dataset.btn ? maskOf(t.dataset.btn) : 0;
    }
  }

  function recompute() {
    const s = ZERO();
    for (const p of pointers.values()) {
      if (p.kind === 'stick') { s.a[p.idx * 2] = p.vec[0]; s.a[p.idx * 2 + 1] = p.vec[1]; }
      else s.b |= p.bits || 0;
    }
    const newly = s.b & ~touch.b;
    touch = s;
    if (newly) buzz();
    merge();
  }

  function merge() {
    const raw = touch.b | pad.b | kb;
    const newlyTurbo = raw & ~rawHeld & turboMask;
    rawHeld = raw;
    if (newlyTurbo) turboPhase = true; // respond on the first frame of a press
    if (raw & turboMask) {
      if (!turboTimer) turboTimer = setInterval(() => { turboPhase = !turboPhase; merge(); }, 33);
    } else if (turboTimer) { clearInterval(turboTimer); turboTimer = null; }
    const b = (raw & ~turboMask) | (turboPhase ? raw & turboMask : 0);
    const a = [0, 1, 2, 3].map((k) => (Math.abs(pad.a[k]) > Math.abs(touch.a[k]) ? pad.a[k] : touch.a[k]));
    if (raw !== paintedRaw) { paintedRaw = raw; paint(); }
    if (b === out.b && a.every((v, k) => v === out.a[k])) return;
    out = { b, a };
    opts.onChange && opts.onChange(out);
  }

  function paint() {
    bitEls.forEach(({ el, mask }) => el.classList.toggle('on', (rawHeld & mask) === mask && mask !== 0));
    dpadEls.forEach((el) => {
      const [U, D, L, R] = (el.dataset.dpad || '4,5,6,7').split(',').map((n) => (n === '' ? 0 : 1 << +n));
      el.classList.toggle('u', !!(rawHeld & U)); el.classList.toggle('d', !!(rawHeld & D));
      el.classList.toggle('l', !!(rawHeld & L)); el.classList.toggle('r', !!(rawHeld & R));
    });
  }

  function index() {
    bitEls = [...root.querySelectorAll('[data-btn]')].map((el) => ({ el, mask: maskOf(el.dataset.btn) }));
    dpadEls = [...root.querySelectorAll('[data-dpad]')];
    paintedRaw = -1;
    pointers.clear();
    touch = ZERO();
    merge();
  }

  function onDown(e) {
    const t = targetAt(e.clientX, e.clientY);
    if (!t) return;
    e.preventDefault();
    try { t.setPointerCapture(e.pointerId); } catch (err) {}
    if (t.dataset.hold) {
      buzz();
      t.classList.add('on');
      pointers.set(e.pointerId, { id: e.pointerId, kind: 'hold', el: t, bits: 0 });
      opts.onAction && opts.onAction(t.dataset.hold, true);
      return;
    }
    if (t.dataset.act) {
      buzz();
      t.classList.add('on');
      setTimeout(() => t.classList.remove('on'), 140);
      opts.onAction && opts.onAction(t.dataset.act);
      return;
    }
    const p = { id: e.pointerId, bits: 0, vec: [0, 0] };
    if (t.dataset.stick != null) {
      const r = t.getBoundingClientRect();
      Object.assign(p, { kind: 'stick', el: t, idx: +t.dataset.stick, cx: r.left + r.width / 2, cy: r.top + r.height / 2, rad: r.width / 2 });
      t.classList.add('on');
    } else if (t.dataset.dpad != null) {
      Object.assign(p, { kind: 'dpad', el: t });
    } else p.kind = 'btn';
    pointers.set(e.pointerId, p);
    update(p, e.clientX, e.clientY);
    recompute();
  }
  function onMove(e) {
    const p = pointers.get(e.pointerId);
    if (!p || p.kind === 'hold') return;
    e.preventDefault();
    update(p, e.clientX, e.clientY);
    recompute();
  }
  function onUp(e) {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    if (p.kind === 'hold') {
      p.el.classList.remove('on');
      pointers.delete(e.pointerId);
      opts.onAction && opts.onAction(p.el.dataset.hold, false);
      return;
    }
    if (p.kind === 'stick') {
      p.el.classList.remove('on');
      const knob = p.el.querySelector('.knob');
      if (knob) knob.style.transform = '';
    }
    pointers.delete(e.pointerId);
    recompute();
  }

  // ---------- gamepad (guests; the host's EmulatorJS reads pads itself) ----------
  const GP_MAP = [B.cross, B.circle, B.square, B.triangle, B.l1, B.r1, B.l2, B.r2, B.select, B.start, B.l3, B.r3, B.up, B.down, B.left, B.right];
  let gpRunning = false;
  function gpLoop() {
    const pads = (navigator.getGamepads && navigator.getGamepads()) || [];
    let b = 0, any = false;
    const a = [0, 0, 0, 0];
    for (const g of pads) {
      if (!g) continue;
      any = true;
      g.buttons.forEach((btn, i) => { if (i < 16 && (btn.pressed || btn.value > 0.5)) b |= 1 << GP_MAP[i]; });
      for (let k = 0; k < 4; k++) {
        let v = g.axes[k] || 0;
        if (Math.abs(v) < 0.15) v = 0;
        if (Math.abs(v) > Math.abs(a[k])) a[k] = v;
      }
    }
    if (opts.gamepad && opts.gamepad()) { pad = { b, a }; merge(); }
    if (any) requestAnimationFrame(gpLoop); else gpRunning = false;
  }
  addEventListener('gamepadconnected', () => { if (!gpRunning) { gpRunning = true; requestAnimationFrame(gpLoop); } });

  // ---------- keyboard (guests) ----------
  const KEYS = {
    ArrowUp: B.up, ArrowDown: B.down, ArrowLeft: B.left, ArrowRight: B.right,
    KeyZ: B.cross, KeyX: B.circle, KeyA: B.square, KeyS: B.triangle,
    KeyQ: B.l1, KeyW: B.r1, Digit1: B.l2, Digit2: B.r2,
    Enter: B.start, ShiftRight: B.select, ShiftLeft: B.select,
  };
  function onKey(e) {
    if (!(opts.keyboard && opts.keyboard())) return;
    if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    const bit = KEYS[e.code];
    if (bit == null) return;
    e.preventDefault();
    const was = kb;
    if (e.type === 'keydown') kb |= 1 << bit; else kb &= ~(1 << bit);
    if (kb !== was) merge();
  }
  addEventListener('keydown', onKey);
  addEventListener('keyup', onKey);

  // ---------- layouts ----------
  function renderDefault(withSticks, extras = {}) {
    root.className = 'pad pad-default' + (withSticks ? ' with-sticks' : '');
    root.innerHTML = `
      <div class="shoulders left"><b data-btn="${B.l2}">L2</b><b data-btn="${B.l1}">L1</b></div>
      <div class="shoulders right"><b data-btn="${B.r1}">R1</b><b data-btn="${B.r2}">R2</b></div>
      <div class="dpad" data-dpad="${B.up},${B.down},${B.left},${B.right}">
        <i class="arm u"></i><i class="arm d"></i><i class="arm l"></i><i class="arm r"></i>
      </div>
      <div class="face">
        <b class="tri" data-btn="${B.triangle}" aria-label="Triangle"><svg viewBox="0 0 24 24"><path d="M12 4 21 19H3Z"/></svg></b>
        <b class="cir" data-btn="${B.circle}" aria-label="Circle"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7.5"/></svg></b>
        <b class="crs" data-btn="${B.cross}" aria-label="Cross"><svg viewBox="0 0 24 24"><path d="M5 5 19 19M19 5 5 19"/></svg></b>
        <b class="sqr" data-btn="${B.square}" aria-label="Square"><svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14"/></svg></b>
      </div>
      <div class="mid">
        <b class="pill" data-btn="${B.select}">Select</b>
        <b class="pill" data-btn="${B.start}">Start</b>
        ${extras.ff ? '<b class="pill ff" data-hold="ff" aria-label="Hold to fast forward"><svg viewBox="0 0 24 24"><path d="M3 6l8 6-8 6zM12 6l8 6-8 6z"/></svg></b>' : ''}
      </div>
      ${withSticks ? `
      <div class="stick s0" data-stick="0"><span class="knob"></span></div>
      <div class="stick s1" data-stick="1"><span class="knob"></span></div>
      <div class="l3r3"><b class="pill" data-btn="${B.l3}">L3</b><b class="pill" data-btn="${B.r3}">R3</b></div>` : ''}
    `;
    index();
  }

  // Delta skin: draws the skin image into bgEl, builds invisible hit zones, returns the screen rect.
  function renderDelta(skin, bgEl) {
    const W = innerWidth, H = innerHeight;
    const orient = W > H ? 'landscape' : 'portrait';
    const rep = skin.reps[orient] || skin.reps.portrait || skin.reps.landscape;
    const s = Math.min(W / rep.mw, H / rep.mh);
    const ox = (W - rep.mw * s) / 2;
    const oy = orient === 'portrait' ? H - rep.mh * s : (H - rep.mh * s) / 2;
    const px = (v) => v.toFixed(1) + 'px';

    bgEl.innerHTML = rep.imgUrl
      ? `<img src="${rep.imgUrl}" alt="" style="left:${px(ox)};top:${px(oy)};width:${px(rep.mw * s)};height:${px(rep.mh * s)}">`
      : '';
    root.className = 'pad pad-delta';
    let html = '';
    let have = 0;
    let minY = rep.mh;
    for (const it of rep.items) {
      const k = PS.delta.classify(it);
      if (!k) continue;
      const f = it.frame, e = it.ext;
      minY = Math.min(minY, f.y);
      const box = `left:${px(ox + (f.x - e.left) * s)};top:${px(oy + (f.y - e.top) * s)};width:${px((f.width + e.left + e.right) * s)};height:${px((f.height + e.top + e.bottom) * s)}`;
      if (k.kind === 'btn') { have |= k.bits; html += `<b class="zone" style="${box}" data-btn="${bitsToList(k.bits)}"></b>`; }
      else if (k.kind === 'act') html += `<b class="zone" style="${box}" data-act="${k.act}"></b>`;
      else if (k.kind === 'dpad') { k.map.forEach((n) => n != null && (have |= 1 << n)); html += `<b class="zone dz" style="${box}" data-dpad="${k.map.map((n) => (n == null ? '' : n)).join(',')}"></b>`; }
      else if (k.kind === 'stick') {
        const tw = ((it.thumb && it.thumb.width) || 60) * s, th = ((it.thumb && it.thumb.height) || 60) * s;
        const thumb = it.thumbUrl ? `<img class="knob img" src="${it.thumbUrl}" alt="" style="width:${px(tw)};height:${px(th)};margin-left:${px(-tw / 2)};margin-top:${px(-th / 2)}">` : '<span class="knob"></span>';
        html += `<div class="zone stick" style="${box}" data-stick="${k.idx}">${thumb}</div>`;
      }
    }
    // PS1 buttons a non-PS1 skin doesn't have: small floating pills.
    const extra = [];
    if (!(have & (1 << B.l2))) extra.push(['l', B.l2, 'L2']);
    if (!(have & (1 << B.l1))) extra.push(['l', B.l1, 'L1']);
    if (!(have & (1 << B.select))) extra.push(['c', B.select, 'Select']);
    if (!(have & (1 << B.r1))) extra.push(['r', B.r1, 'R1']);
    if (!(have & (1 << B.r2))) extra.push(['r', B.r2, 'R2']);
    if (extra.length) {
      html += `<div class="extras">${extra.map(([side, bit, label]) => `<b class="pill x-${side}" data-btn="${bit}">${label}</b>`).join('')}</div>`;
    }
    root.innerHTML = html;
    index();

    if (rep.screen) {
      const r = rep.screen;
      return { x: ox + r.x * s, y: oy + r.y * s, w: r.width * s, h: r.height * s };
    }
    if (orient === 'portrait') return { x: 0, y: 0, w: W, h: Math.max(120, oy + minY * s) };
    return { x: 0, y: 0, w: W, h: H };
  }

  function bitsToList(mask) {
    const l = [];
    for (let i = 0; i < 16; i++) if (mask & (1 << i)) l.push(i);
    return l.join(',');
  }

  function init(el, o) {
    root = el;
    opts = o || {};
    root.addEventListener('pointerdown', onDown, { passive: false });
    root.addEventListener('pointermove', onMove, { passive: false });
    root.addEventListener('pointerup', onUp);
    root.addEventListener('pointercancel', onUp);
    root.addEventListener('lostpointercapture', onUp);
    root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  function setTurbo(mask) { turboMask = mask | 0; merge(); }

  PS.controls = { init, renderDefault, renderDelta, setTurbo, state: () => out, B };
})();
