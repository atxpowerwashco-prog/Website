'use strict';
const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── DATABASE ──────────────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'bookings.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_name  TEXT NOT NULL,
    customer_email TEXT NOT NULL,
    customer_phone TEXT NOT NULL,
    service_type   TEXT NOT NULL,
    service_date   TEXT NOT NULL,
    start_time     TEXT NOT NULL,
    end_time       TEXT NOT NULL,
    notes          TEXT DEFAULT '',
    status         TEXT DEFAULT 'confirmed',
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS blocked_slots (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    block_date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    reason     TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── SERVER-SENT EVENTS ────────────────────────────────────────────────────────
const clients = new Set();

app.get('/api/sse', (req, res) => {
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const hb   = setInterval(() => res.write(': ping\n\n'), 25_000);

  clients.add(send);
  send({ type: 'connected', clientCount: clients.size });

  req.on('close', () => { clients.delete(send); clearInterval(hb); });
});

const broadcast = (data) => clients.forEach(fn => fn(data));

// ── SCHEDULING CONSTANTS ──────────────────────────────────────────────────────
// Six 1-hour time slots per day; each booking blocks slot + 30 min travel buffer
const SLOTS       = ['08:00', '09:30', '11:00', '12:30', '14:00', '15:30'];
const SESSION_MIN = 60;
const BUFFER_MIN  = 30;
const BLOCK_MIN   = SESSION_MIN + BUFFER_MIN; // 90 min total block per booking

const toMin   = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const fromMin = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const fmt12   = t => {
  const [h, m] = t.split(':').map(Number);
  const p = h >= 12 ? 'PM' : 'AM';
  return `${h > 12 ? h - 12 : h || 12}:${String(m).padStart(2, '0')} ${p}`;
};

function getBookedMins(date) {
  const bookings = db.prepare("SELECT start_time FROM bookings WHERE service_date=? AND status='confirmed'").all(date);
  const manual   = db.prepare('SELECT start_time FROM blocked_slots WHERE block_date=?').all(date);
  return [...bookings, ...manual].map(r => toMin(r.start_time));
}

function slotOpen(slotTime, bookedMins) {
  const s = toMin(slotTime);
  return !bookedMins.some(b => Math.abs(s - b) < BLOCK_MIN);
}

// ── ROUTES ────────────────────────────────────────────────────────────────────

// Availability for a specific date
app.get('/api/availability/:date', (req, res) => {
  const { date } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date' });

  const bookedMins = getBookedMins(date);
  const now        = new Date();
  const isToday    = date === now.toISOString().split('T')[0];
  const nowMin     = now.getHours() * 60 + now.getMinutes();

  const slots = SLOTS.map(t => {
    const min    = toMin(t);
    const past   = isToday && min < nowMin + 60; // require 1 hr advance notice
    const booked = !slotOpen(t, bookedMins);
    return {
      time: t,
      display: fmt12(t),
      displayEnd: fmt12(fromMin(min + SESSION_MIN)),
      available: !past && !booked,
      status: past ? 'past' : booked ? 'booked' : 'open'
    };
  });

  res.json({ date, slots });
});

// All confirmed bookings (admin)
app.get('/api/bookings', (req, res) => {
  res.json(db.prepare("SELECT * FROM bookings WHERE status='confirmed' ORDER BY service_date,start_time").all());
});

// Create a booking
app.post('/api/bookings', (req, res) => {
  const { customer_name, customer_email, customer_phone, service_type, service_date, start_time, notes } = req.body;

  if (!customer_name || !customer_email || !customer_phone || !service_type || !service_date || !start_time)
    return res.status(400).json({ error: 'All fields are required' });

  if (!SLOTS.includes(start_time))
    return res.status(400).json({ error: 'Invalid time slot' });

  const today = new Date().toISOString().split('T')[0];
  if (service_date < today)
    return res.status(400).json({ error: 'Cannot book a past date' });

  const bookedMins = getBookedMins(service_date);
  if (!slotOpen(start_time, bookedMins))
    return res.status(409).json({ error: 'This slot was just booked — please choose another time' });

  const end_time = fromMin(toMin(start_time) + SESSION_MIN);
  const r = db.prepare(
    'INSERT INTO bookings (customer_name,customer_email,customer_phone,service_type,service_date,start_time,end_time,notes) VALUES (?,?,?,?,?,?,?,?)'
  ).run(
    customer_name.trim(),
    customer_email.trim().toLowerCase(),
    customer_phone.trim(),
    service_type,
    service_date,
    start_time,
    end_time,
    (notes || '').trim()
  );

  const booking = db.prepare('SELECT * FROM bookings WHERE id=?').get(r.lastInsertRowid);
  broadcast({ type: 'slot_updated', date: service_date });
  res.status(201).json({ success: true, booking });
});

// Cancel a booking (admin)
app.delete('/api/bookings/:id', (req, res) => {
  const booking = db.prepare('SELECT * FROM bookings WHERE id=?').get(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE bookings SET status='cancelled' WHERE id=?").run(req.params.id);
  broadcast({ type: 'slot_updated', date: booking.service_date });
  res.json({ success: true });
});

// All manually blocked slots (admin)
app.get('/api/blocked', (req, res) => {
  res.json(db.prepare('SELECT * FROM blocked_slots ORDER BY block_date,start_time').all());
});

// Manually block a slot (admin)
app.post('/api/blocked', (req, res) => {
  const { block_date, start_time, reason } = req.body;
  if (!block_date || !start_time) return res.status(400).json({ error: 'Date and time required' });
  const r = db.prepare('INSERT INTO blocked_slots (block_date,start_time,reason) VALUES (?,?,?)').run(block_date, start_time, reason || '');
  broadcast({ type: 'slot_updated', date: block_date });
  res.status(201).json({ success: true, id: r.lastInsertRowid });
});

// Remove a manual block (admin)
app.delete('/api/blocked/:id', (req, res) => {
  const block = db.prepare('SELECT * FROM blocked_slots WHERE id=?').get(req.params.id);
  if (!block) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM blocked_slots WHERE id=?').run(req.params.id);
  broadcast({ type: 'slot_updated', date: block.block_date });
  res.json({ success: true });
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║   SURGE WASH CO. — Server Ready          ║
  ║   Main site  → http://localhost:${PORT}      ║
  ║   Admin      → http://localhost:${PORT}/admin║
  ╚══════════════════════════════════════════╝
`);
});
