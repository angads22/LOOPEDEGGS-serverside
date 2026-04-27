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
const APP_VERSION = '1.0.1';

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
  const { deviceId, name, location } = req.body;
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

  const unit = {
    deviceId: String(deviceId).slice(0, 64),
    name: String(name || `Unit ${incubators.size + 1}`).slice(0, 100),
    location: String(location || '').slice(0, 100),
    status: 'online',
    lastSeen: new Date().toISOString(),
    telemetry: null,
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

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'lifeloop',
    version: APP_VERSION,
  });
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

wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'init', incubators: [...incubators.values()] }));
  ws.on('error', err => console.error('[ws]', err.message));
});

// ── Start ─────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`LifeLoop Hub · http://localhost:${PORT} · ${process.env.NODE_ENV || 'development'}`);
});
