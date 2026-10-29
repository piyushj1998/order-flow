require('dotenv').config({ path: require('node:path').resolve(__dirname, '../../.env') });
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { randomUUID } = require('node:crypto');
const { pool, pingDatabase, toIso } = require('../../shared/db');
const { makeToken, requireAuth } = require('../../shared/auth');

const app = express();
const port = Number(process.env.AUTH_PORT || 3001);
app.use(cors());
app.use(express.json({ limit: '100kb' }));

function publicUser(row) {
  return { id: row.id, name: row.name, email: row.email, createdAt: toIso(row.createdAt) };
}

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ service: 'auth-service', status: 'ok', database: 'connected' });
  } catch {
    res.status(503).json({ service: 'auth-service', status: 'degraded', database: 'disconnected' });
  }
});

app.post('/api/auth/register', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (name.length < 2) return res.status(400).json({ error: 'Name must be at least 2 characters.' });
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  const user = {
    id: `usr_${randomUUID().slice(0, 12)}`,
    name,
    email,
    passwordHash: await bcrypt.hash(password, 12),
  };
  try {
    await pool.execute(
      'INSERT INTO users (id, name, email, password_hash) VALUES (?, ?, ?, ?)',
      [user.id, user.name, user.email, user.passwordHash]
    );
    const token = makeToken(user);
    return res.status(201).json({ token, user: { id: user.id, name, email } });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'An account with this email already exists.' });
    console.error('[auth-service] register failed:', error.message);
    return res.status(500).json({ error: 'Could not create account. Check the MySQL connection and service logs.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  try {
    const [rows] = await pool.execute(
      'SELECT id, name, email, password_hash AS passwordHash, created_at AS createdAt FROM users WHERE email = ? LIMIT 1',
      [email]
    );
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: 'Email or password is incorrect.' });
    }
    return res.json({ token: makeToken(user), user: { id: user.id, name: user.name, email: user.email } });
  } catch (error) {
    console.error('[auth-service] login failed:', error.message);
    return res.status(500).json({ error: 'Could not log in. Check the MySQL connection and service logs.' });
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: { id: req.user.id, name: req.user.name, email: req.user.email } }));

async function start() {
  try {
    await pingDatabase();
    app.listen(port, () => console.log(`[auth-service] listening on http://localhost:${port} (MySQL connected)`));
  } catch (error) {
    console.error(`[auth-service] MySQL connection failed: ${error.message}`);
    console.error('Run `npm.cmd run db:setup` and check DB_* values in .env.');
    process.exit(1);
  }
}
start();
