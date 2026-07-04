'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { WebSocketServer } = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;

// Persist contacts to disk
const DATA_DIR = path.join(__dirname, 'data');
const CONTACTS_FILE = path.join(DATA_DIR, 'contacts.json');

function loadContacts() {
  if (!fs.existsSync(CONTACTS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8')); } catch { return []; }
}

function saveContacts(contacts) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONTACTS_FILE, JSON.stringify(contacts, null, 2));
}

const contacts = loadContacts();
const incubators = new Map();
// deviceId → WebSocket connection (so the hub can address commands to a device)
const deviceSockets = new Map();
// deviceId → { pan, tilt, updatedAt } most recently reported by the device
const headPoses = new Map();

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'wss:', 'ws:'],
    },
  },
}));

app.use(cors({
  origin: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : ['http://localhost:3000', 'https://loopedeggs.ca', 'https://www.loopedeggs.ca'],
}));

app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '10kb' }));

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false });
const contactLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false });

app.use('/api/', apiLimiter);

// ── Static ────────────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '7d' : 0,
}));

// Surface the IK docs from /docs/* so the Inspect page can link to them.
app.use('/docs', express.static(path.join(__dirname, 'docs'), {
  maxAge: '1d',
  extensions: ['md'],
}));

// ── API ───────────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), incubators: incubators.size, timestamp: new Date().toISOString() });
});

app.post('/api/contact', contactLimiter, (req, res) => {
  const { name, email, subject, message } = req.body;

  if (!name?.trim() || !email?.trim() || !message?.trim()) {
    return res.status(400).json({ error: 'name, email, and message are required' });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  const entry = {
    id: Date.now().toString(),
    name: String(name).slice(0, 120),
    email: String(email).slice(0, 120),
    subject: String(subject || 'other').slice(0, 60),
    message: String(message).slice(0, 2000),
    ip: req.ip,
    timestamp: new Date().toISOString(),
  };

  contacts.push(entry);
  saveContacts(contacts);
  console.log(`[contact] ${entry.name} <${entry.email}> — ${entry.subject}`);
  res.json({ success: true });
});

// Hub — register a LifeLoop device
app.post('/api/hub/incubators/register', (req, res) => {
  const { deviceId, name, location, streamUrl, capabilities } = req.body;
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

  const unit = {
    deviceId: String(deviceId).slice(0, 64),
    name: String(name || `Unit ${incubators.size + 1}`).slice(0, 100),
    location: String(location || '').slice(0, 100),
    status: 'online',
    lastSeen: new Date().toISOString(),
    telemetry: null,
    streamUrl: streamUrl ? String(streamUrl).slice(0, 256) : null,
    capabilities: Array.isArray(capabilities)
      ? capabilities.filter(c => typeof c === 'string').slice(0, 16)
      : [],
  };

  incubators.set(unit.deviceId, unit);
  broadcast({ type: 'incubator_registered', unit });
  res.json({ success: true, unit });
});

// Hub — list all
app.get('/api/hub/incubators', (req, res) => {
  res.json({ count: incubators.size, incubators: [...incubators.values()] });
});

// Hub — get one
app.get('/api/hub/incubators/:deviceId', (req, res) => {
  const unit = incubators.get(req.params.deviceId);
  if (!unit) return res.status(404).json({ error: 'Not found' });
  res.json(unit);
});

// Hub — push telemetry from device
app.post('/api/hub/incubators/:deviceId/telemetry', (req, res) => {
  const unit = incubators.get(req.params.deviceId);
  if (!unit) return res.status(404).json({ error: 'Not found' });

  unit.lastSeen = new Date().toISOString();
  unit.status = 'online';
  unit.telemetry = {
    temperature: req.body.temperature ?? null,
    humidity: req.body.humidity ?? null,
    eggCount: req.body.eggCount ?? null,
    day: req.body.day ?? null,
    phase: req.body.phase ?? null,
    timestamp: new Date().toISOString(),
  };

  incubators.set(unit.deviceId, unit);
  broadcast({ type: 'telemetry_update', deviceId: unit.deviceId, telemetry: unit.telemetry });
  res.json({ success: true });
});

// ── Camera & head (Inspect) ───────────────────────────────────────────────────
//
//   GET  /api/hub/incubators/:id/camera/stream  → MJPEG proxy from the device
//   POST /api/hub/incubators/:id/look           → click-to-look (pixel → ray)
//   POST /api/hub/incubators/:id/head           → manual pan/tilt (radians)
//   GET  /api/hub/incubators/:id/head           → last reported pose
//
// IK is not done here — the hub just relays the command to the device, which
// owns its own calibration. See docs/INVERSE_KINEMATICS.md.

function sendToDevice(deviceId, payload) {
  const ws = deviceSockets.get(deviceId);
  if (!ws || ws.readyState !== 1) return false;
  ws.send(JSON.stringify(payload));
  return true;
}

// Proxy the device's MJPEG stream so browsers don't need direct LAN access
// to the Pi. The device registers a streamUrl when it comes online.
app.get('/api/hub/incubators/:deviceId/camera/stream', (req, res) => {
  const unit = incubators.get(req.params.deviceId);
  if (!unit?.streamUrl) return res.status(404).json({ error: 'No camera registered for this device' });

  const upstream = http.get(unit.streamUrl, upRes => {
    res.writeHead(upRes.statusCode || 502, upRes.headers);
    upRes.pipe(res);
  });

  upstream.on('error', err => {
    console.error('[camera proxy]', err.message);
    if (!res.headersSent) res.status(502).json({ error: 'Camera stream unavailable' });
    else res.end();
  });

  req.on('close', () => upstream.destroy());
});

// Click-to-look: browser sends pixel + frame size, device does the IK.
app.post('/api/hub/incubators/:deviceId/look', (req, res) => {
  const unit = incubators.get(req.params.deviceId);
  if (!unit) return res.status(404).json({ error: 'Not found' });

  const { u, v, frameWidth, frameHeight, relative } = req.body || {};
  if ([u, v, frameWidth, frameHeight].some(n => typeof n !== 'number')) {
    return res.status(400).json({ error: 'u, v, frameWidth, frameHeight required (numbers)' });
  }

  const sent = sendToDevice(unit.deviceId, {
    type: 'head_target_pixel',
    u, v, frameWidth, frameHeight,
    relative: relative !== false,   // default: treat click as a delta from current pose
  });
  if (!sent) return res.status(503).json({ error: 'Device offline' });
  res.json({ success: true });
});

// Manual pan/tilt in radians (joystick / sliders).
app.post('/api/hub/incubators/:deviceId/head', (req, res) => {
  const unit = incubators.get(req.params.deviceId);
  if (!unit) return res.status(404).json({ error: 'Not found' });

  const { pan, tilt, mode } = req.body || {};
  if (typeof pan !== 'number' || typeof tilt !== 'number') {
    return res.status(400).json({ error: 'pan and tilt required (radians)' });
  }
  if (!Number.isFinite(pan) || !Number.isFinite(tilt)) {
    return res.status(400).json({ error: 'pan/tilt must be finite' });
  }
  // Mechanical sanity bounds — device clamps further to its own limits.
  if (Math.abs(pan) > Math.PI || Math.abs(tilt) > Math.PI / 2) {
    return res.status(400).json({ error: 'pan/tilt out of allowable range' });
  }

  const sent = sendToDevice(unit.deviceId, {
    type: 'head_target_angle',
    pan, tilt,
    mode: mode === 'absolute' ? 'absolute' : 'relative',
  });
  if (!sent) return res.status(503).json({ error: 'Device offline' });
  res.json({ success: true });
});

app.get('/api/hub/incubators/:deviceId/head', (req, res) => {
  const pose = headPoses.get(req.params.deviceId);
  if (!pose) return res.status(404).json({ error: 'No pose reported yet' });
  res.json(pose);
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── WebSocket ─────────────────────────────────────────────────────────────────

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach(client => { if (client.readyState === 1) client.send(msg); });
}

wss.on('connection', (ws, req) => {
  // A device announces itself with `?deviceId=...`; everything else is a browser.
  const url = new URL(req.url, 'http://placeholder');
  const deviceId = url.searchParams.get('deviceId');

  if (deviceId && incubators.has(deviceId)) {
    deviceSockets.set(deviceId, ws);
    ws.isDevice = true;
    ws.deviceId = deviceId;
    console.log(`[ws] device connected: ${deviceId}`);
  } else {
    ws.send(JSON.stringify({ type: 'init', incubators: [...incubators.values()] }));
  }

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Devices report their current pose so the UI can render the reticle.
    if (ws.isDevice && msg.type === 'head_pose') {
      const { pan, tilt } = msg;
      if (typeof pan === 'number' && typeof tilt === 'number') {
        const pose = { pan, tilt, updatedAt: new Date().toISOString() };
        headPoses.set(ws.deviceId, pose);
        broadcast({ type: 'head_pose', deviceId: ws.deviceId, pose });
      }
    }
  });

  ws.on('close', () => {
    if (ws.isDevice) {
      deviceSockets.delete(ws.deviceId);
      const unit = incubators.get(ws.deviceId);
      if (unit) { unit.status = 'offline'; broadcast({ type: 'incubator_offline', deviceId: ws.deviceId }); }
      console.log(`[ws] device disconnected: ${ws.deviceId}`);
    }
  });

  ws.on('error', err => console.error('[ws]', err.message));
});

// ── Start ─────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`LifeLoop Hub · http://localhost:${PORT} · ${process.env.NODE_ENV || 'development'}`);
});
