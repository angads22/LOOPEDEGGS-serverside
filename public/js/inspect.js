// =============================================================================
//  /inspect — live camera + head control
//
//  No frameworks. The hub WebSocket pushes pose updates and incubator status;
//  we send REST commands for the UI's manual + click-to-look actions. The
//  device does the actual IK (see docs/INVERSE_KINEMATICS.md) and reports
//  back its current (pan, tilt) so we can render the reticle.
// =============================================================================

(() => {
  'use strict';

  const DEG = 180 / Math.PI;
  const RAD = Math.PI / 180;

  const $ = sel => document.querySelector(sel);

  const els = {
    select:    $('#device-select'),
    conn:      $('#conn-status'),
    frame:     $('#viewer-frame'),
    img:       $('#cam'),
    reticle:   $('#reticle'),
    empty:     $('#viewer-empty'),
    hudPose:   $('#hud-pose'),
    hudFps:    $('#hud-fps'),
    pan:       $('#pan'),
    tilt:      $('#tilt'),
    panOut:    $('#pan-out'),
    tiltOut:   $('#tilt-out'),
    centre:    $('#centre'),
    sendAbs:   $('#send-abs'),
    step:      $('#step-deg'),
    telemetry: $('#telemetry-body'),
  };

  const state = {
    deviceId: null,
    pose:     { pan: 0, tilt: 0 },   // radians, last reported by device
    units:    new Map(),             // deviceId → unit
    fps:      { count: 0, last: performance.now() },
  };

  // ── unit list / selection ────────────────────────────────────────────────

  async function loadUnits() {
    try {
      const r = await fetch('/api/hub/incubators');
      const data = await r.json();
      data.incubators.forEach(u => state.units.set(u.deviceId, u));
      renderUnitOptions();
    } catch (err) {
      console.error('failed to load incubators', err);
    }
  }

  function renderUnitOptions() {
    const current = els.select.value;
    els.select.innerHTML = '<option value="">— select —</option>';
    for (const u of state.units.values()) {
      const opt = document.createElement('option');
      opt.value = u.deviceId;
      opt.textContent = `${u.name} (${u.deviceId.slice(0, 8)}) · ${u.status}`;
      if (u.deviceId === current) opt.selected = true;
      els.select.appendChild(opt);
    }
  }

  els.select.addEventListener('change', () => selectDevice(els.select.value || null));

  function selectDevice(deviceId) {
    state.deviceId = deviceId;
    if (!deviceId) {
      els.img.removeAttribute('src');
      els.empty.hidden = false;
      return;
    }
    els.empty.hidden = true;
    // MJPEG is just <img src> — the browser will keep the connection open
    // and replace frames. Cache-bust to force a reconnect when switching.
    els.img.src = `/api/hub/incubators/${deviceId}/camera/stream?t=${Date.now()}`;
    fetchPose();
    refreshTelemetry();
  }

  els.img.addEventListener('load',  countFrame);
  els.img.addEventListener('error', () => {
    els.empty.textContent = 'No camera stream available for this unit.';
    els.empty.hidden = false;
    els.img.removeAttribute('src');
  });

  function countFrame() {
    state.fps.count++;
    const now = performance.now();
    if (now - state.fps.last >= 1000) {
      els.hudFps.textContent = `${state.fps.count} fps`;
      state.fps.count = 0;
      state.fps.last = now;
    }
  }

  // ── click-to-look ────────────────────────────────────────────────────────

  els.frame.addEventListener('click', async ev => {
    if (!state.deviceId || !els.img.naturalWidth) return;

    // Map the click from the rendered <img> back into the source frame's
    // pixel coordinates (the image is `object-fit: contain`).
    const rect = els.img.getBoundingClientRect();
    const xInBox = ev.clientX - rect.left;
    const yInBox = ev.clientY - rect.top;

    const imgW = els.img.naturalWidth;
    const imgH = els.img.naturalHeight;
    const scale = Math.min(rect.width / imgW, rect.height / imgH);
    const drawnW = imgW * scale;
    const drawnH = imgH * scale;
    const offX = (rect.width  - drawnW) / 2;
    const offY = (rect.height - drawnH) / 2;

    const u = (xInBox - offX) / scale;
    const v = (yInBox - offY) / scale;
    if (u < 0 || u > imgW || v < 0 || v > imgH) return;   // clicked the letterbox

    flashReticleAt(ev.clientX - rect.left, ev.clientY - rect.top);

    try {
      const r = await fetch(`/api/hub/incubators/${state.deviceId}/look`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          u, v,
          frameWidth:  imgW,
          frameHeight: imgH,
          relative:    true,
        }),
      });
      if (!r.ok) console.warn('look failed', await r.text());
    } catch (err) { console.error(err); }
  });

  function flashReticleAt(x, y) {
    els.reticle.style.left = `${x}px`;
    els.reticle.style.top  = `${y}px`;
    els.reticle.hidden = false;
    els.reticle.animate(
      [{ opacity: 1, transform: 'translate(-50%,-50%) scale(.8)' },
       { opacity: 0, transform: 'translate(-50%,-50%) scale(1.4)' }],
      { duration: 600, easing: 'ease-out' },
    );
  }

  // ── manual pan/tilt ──────────────────────────────────────────────────────

  function syncSliderOutputs() {
    els.panOut.textContent  = `${els.pan.value}°`;
    els.tiltOut.textContent = `${els.tilt.value}°`;
  }
  els.pan.addEventListener('input',  syncSliderOutputs);
  els.tilt.addEventListener('input', syncSliderOutputs);
  syncSliderOutputs();

  els.centre.addEventListener('click', () => {
    els.pan.value = 0; els.tilt.value = 0; syncSliderOutputs();
  });

  els.sendAbs.addEventListener('click', () => sendAngles({
    pan:  Number(els.pan.value)  * RAD,
    tilt: Number(els.tilt.value) * RAD,
    mode: 'absolute',
  }));

  document.querySelectorAll('[data-nudge]').forEach(btn => {
    btn.addEventListener('click', () => {
      const stepDeg = Math.max(1, Math.min(30, Number(els.step.value) || 5));
      const step = stepDeg * RAD;
      const cmd = { pan: 0, tilt: 0, mode: 'relative' };
      switch (btn.dataset.nudge) {
        case 'up':     cmd.tilt = +step; break;
        case 'down':   cmd.tilt = -step; break;
        case 'left':   cmd.pan  = +step; break;
        case 'right':  cmd.pan  = -step; break;
        case 'centre':
          els.pan.value = 0; els.tilt.value = 0; syncSliderOutputs();
          return sendAngles({ pan: 0, tilt: 0, mode: 'absolute' });
      }
      sendAngles(cmd);
    });
  });

  async function sendAngles(cmd) {
    if (!state.deviceId) return;
    try {
      const r = await fetch(`/api/hub/incubators/${state.deviceId}/head`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(cmd),
      });
      if (!r.ok) console.warn('head command failed', await r.text());
    } catch (err) { console.error(err); }
  }

  // ── pose / telemetry ─────────────────────────────────────────────────────

  async function fetchPose() {
    if (!state.deviceId) return;
    try {
      const r = await fetch(`/api/hub/incubators/${state.deviceId}/head`);
      if (r.ok) updatePose(await r.json());
    } catch { /* device may not have reported yet */ }
  }

  function updatePose(p) {
    if (typeof p?.pan === 'number')  state.pose.pan  = p.pan;
    if (typeof p?.tilt === 'number') state.pose.tilt = p.tilt;
    els.hudPose.textContent =
      `pan ${(state.pose.pan * DEG).toFixed(1)}° · tilt ${(state.pose.tilt * DEG).toFixed(1)}°`;
  }

  function refreshTelemetry() {
    const u = state.units.get(state.deviceId);
    if (!u?.telemetry) {
      els.telemetry.innerHTML = '<dt>—</dt><dd>waiting…</dd>';
      return;
    }
    const t = u.telemetry;
    els.telemetry.innerHTML = `
      <dt>temp</dt><dd>${fmt(t.temperature, '°C')}</dd>
      <dt>humidity</dt><dd>${fmt(t.humidity, '%')}</dd>
      <dt>eggs</dt><dd>${t.eggCount ?? '—'}</dd>
      <dt>day</dt><dd>${t.day ?? '—'}</dd>
      <dt>phase</dt><dd>${t.phase ?? '—'}</dd>
    `;
  }
  const fmt = (n, unit) => (typeof n === 'number' ? `${n.toFixed(1)} ${unit}` : '—');

  // ── WebSocket ────────────────────────────────────────────────────────────

  let ws, retry = 0;
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    setConn('connecting');

    ws.onopen = () => { setConn('open'); retry = 0; };
    ws.onclose = () => {
      setConn('closed');
      retry = Math.min(retry + 1, 6);
      setTimeout(connect, 500 * 2 ** retry);    // 1s, 2s, 4s … 32s
    };
    ws.onerror = () => ws.close();

    ws.onmessage = ev => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      switch (msg.type) {
        case 'init':
          state.units.clear();
          msg.incubators.forEach(u => state.units.set(u.deviceId, u));
          renderUnitOptions();
          break;
        case 'incubator_registered':
          state.units.set(msg.unit.deviceId, msg.unit);
          renderUnitOptions();
          break;
        case 'incubator_offline': {
          const u = state.units.get(msg.deviceId);
          if (u) { u.status = 'offline'; renderUnitOptions(); }
          break;
        }
        case 'telemetry_update': {
          const u = state.units.get(msg.deviceId);
          if (u) { u.telemetry = msg.telemetry; if (msg.deviceId === state.deviceId) refreshTelemetry(); }
          break;
        }
        case 'head_pose':
          if (msg.deviceId === state.deviceId) updatePose(msg.pose);
          break;
      }
    };
  }
  function setConn(s) { els.conn.dataset.state = s; els.conn.textContent = s; }

  // ── boot ─────────────────────────────────────────────────────────────────

  loadUnits();
  connect();
})();
