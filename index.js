require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);

const { pool } = require('./lib/db');
const { runMigrations } = require('./lib/migrations');
const { requireAuth, requirePerm } = require('./lib/auth');

const authRoutes = require('./routes/auth');
const usersRoutes = require('./routes/users');
const airesRoutes = require('./routes/aires');
const bancosRoutes = require('./routes/bancos');
const facturacionRoutes = require('./routes/facturacion');
const pedidosRoutes = require('./routes/pedidos');

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

if (!SESSION_SECRET) throw new Error('Missing env var: SESSION_SECRET');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: true, limit: '256kb' }));

app.use(session({
  store: new pgSession({
    pool,
    tableName: 'ab_session',
    createTableIfMissing: false,
  }),
  name: 'aires.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    maxAge: SEVEN_DAYS_MS,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  },
}));

// ─── Health (sin auth, para Railway) ──────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ─── API ──────────────────────────────────────────────────────────────
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/users', usersRoutes);
app.use('/api/v1/aires', airesRoutes);
app.use('/api/v1/bancos', bancosRoutes);
app.use('/api/v1/facturacion', facturacionRoutes);
app.use('/api/v1/pedidos', pedidosRoutes);

// ─── Static (login y assets públicos) ─────────────────────────────────
app.use('/login', express.static(path.join(__dirname, 'public', 'login')));
app.use('/css', express.static(path.join(__dirname, 'public', 'css')));
app.use('/js', express.static(path.join(__dirname, 'public', 'js')));
app.use('/img', express.static(path.join(__dirname, 'public', 'img')));

// ─── Dashboard (con auth) ─────────────────────────────────────────────
app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard', 'index.html'));
});

app.get('/dashboard', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard', 'index.html'));
});

app.get('/admin', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') return res.status(403).send('Forbidden');
  res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
});

app.get('/account', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'account', 'index.html'));
});

app.get('/bancos', requireAuth, requirePerm('bancos'), (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'bancos', 'index.html'));
});

// ─── 404 ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not found' });
  res.status(404).send('Not found');
});

// ─── Boot ─────────────────────────────────────────────────────────────
(async () => {
  try {
    await runMigrations();
    app.listen(PORT, () => {
      console.log(`[aires-solo] listening on http://localhost:${PORT}`);
    });
  } catch (e) {
    console.error('[boot] failed:', e);
    process.exit(1);
  }
})();
