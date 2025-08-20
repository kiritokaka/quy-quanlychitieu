const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();                   // đọc mybudget-app/.env

const app = express();
app.use(cors());
app.use(express.json());
const fs   = require('fs');     // nếu dùng fs.existsSync(...)
const path = require('path');   // để dùng path.join(...)

// KHÔNG dùng connectionString nữa
const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || '12345',     // <- sẽ là STRING '12345'
  database: process.env.PGDATABASE || 'mybudget',
});
const q = (s,p=[]) => pool.query(s,p);

// ---------------- ENVELOPES ----------------

// GET /api/envelopes?all=1  -> nếu không truyền all=1 sẽ chỉ lấy active=true
app.get('/api/envelopes', async (req, res) => {
  try {
    const includeInactive = req.query.all === '1';
    const sql = includeInactive
      ? `SELECT * FROM envelope_balances ORDER BY created_at DESC`
      : `SELECT * FROM envelope_balances WHERE active = true ORDER BY created_at DESC`;
    const { rows } = await q(sql);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// POST /api/envelopes { name, initialAmount?, startDate?, endDate? }
app.post('/api/envelopes', async (req, res) => {
  try {
    const { name, initialAmount = 0, startDate = null, endDate = null } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    const { rows } = await q(
      `INSERT INTO envelopes (name, initial_amount, start_date, end_date)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [name, initialAmount, startDate, endDate]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

// DELETE /api/envelopes/:id            -> ẩn (soft delete)
// DELETE /api/envelopes/:id?hard=1     -> xóa hẳn (hard delete, kèm tất cả transactions)
app.delete('/api/envelopes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const hard = req.query.hard === '1';
    if (hard) {
      await q(`DELETE FROM envelopes WHERE id=$1`, [id]);
      return res.json({ ok: true, mode: 'hard' });
    }
    const { rows } = await q(
      `UPDATE envelopes SET active=false WHERE id=$1 RETURNING *`,
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, mode: 'soft', envelope: rows[0] });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

// PATCH /api/envelopes/:id/restore  -> khôi phục quỹ đã ẩn
app.patch('/api/envelopes/:id/restore', async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await q(
      `UPDATE envelopes SET active=true WHERE id=$1 RETURNING *`,
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, envelope: rows[0] });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

// ---------------- TRANSACTIONS ----------------

// POST /api/transactions
// { envelopeId, direction:'in'|'out', amount, who, note?, occurredAt?, preventNegative?=true }
app.post('/api/transactions', async (req, res) => {
  const {
    envelopeId, direction, amount, who,
    note = null, occurredAt = null, preventNegative = true
  } = req.body || {};

  if (!envelopeId || !['in', 'out'].includes(direction) || !amount || !who) {
    return res.status(400).json({
      error: 'envelopeId, direction(in|out), amount, who are required'
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Khoá quỹ để tránh race-condition
    await client.query('SELECT id FROM envelopes WHERE id=$1 FOR UPDATE', [envelopeId]);

    // Lấy số dư hiện tại
    const bal = await client.query(
      `SELECT balance FROM envelope_balances WHERE id=$1`,
      [envelopeId]
    );
    const balance = Number(bal.rows[0]?.balance ?? 0);

    if (preventNegative && direction === 'out' && balance < amount) {
      throw new Error(`Quỹ không đủ: còn ${balance}, định chi ${amount}`);
    }

    // Ghi giao dịch
    const ins = await client.query(
      `INSERT INTO transactions (envelope_id, direction, amount, who, note, occurred_at)
       VALUES ($1,$2,$3,$4,$5, COALESCE($6, now()))
       RETURNING *`,
      [envelopeId, direction, amount, who, note, occurredAt]
    );

    // Số dư mới
    const bal2 = await client.query(
      `SELECT balance FROM envelope_balances WHERE id=$1`,
      [envelopeId]
    );

    await client.query('COMMIT');
    res.status(201).json({ tx: ins.rows[0], newBalance: Number(bal2.rows[0].balance) });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: String(e.message || e) });
  } finally {
    client.release();
  }
});

// GET /api/transactions?envelopeId=&who=&from=&to=&limit=
app.get('/api/transactions', async (req, res) => {
  try {
    const { envelopeId, who, from, to } = req.query;
    const limit = Math.min(Number(req.query.limit || 200), 1000);

    let sql = `SELECT * FROM transactions WHERE 1=1`;
    const p = [];
    if (envelopeId) { p.push(envelopeId); sql += ` AND envelope_id=$${p.length}`; }
    if (who)       { p.push(who);        sql += ` AND who=$${p.length}`; }
    if (from)      { p.push(from);       sql += ` AND occurred_at >= $${p.length}`; }
    if (to)        { p.push(to);         sql += ` AND occurred_at <  $${p.length}`; }
    sql += ` ORDER BY occurred_at DESC LIMIT ${limit}`;

    const { rows } = await q(sql, p);
    res.json(rows);
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

// ---------------- Serve UI (tùy chọn) ----------------
// Nếu có file index.html ở cùng thư mục, map luôn "/" cho tiện:
const INDEX = path.join(__dirname, 'index.html');
if (fs.existsSync(INDEX)) {
  app.get('/', (_req, res) => res.sendFile(INDEX));
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ API chạy: http://localhost:${PORT}`));
