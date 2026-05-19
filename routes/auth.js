const express = require('express');
const { findUserByEmail, verifyPassword } = require('../lib/auth');

const router = express.Router();

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email y password requeridos' });
    const user = await findUserByEmail(email);
    if (!user) return res.status(401).json({ error: 'credenciales inválidas' });
    const ok = await verifyPassword(user, password);
    if (!ok) return res.status(401).json({ error: 'credenciales inválidas' });
    req.session.user = { id: user.id, email: user.email, role: user.role };
    res.json({ ok: true, user: req.session.user });
  } catch (e) {
    console.error('[auth.login]', e);
    res.status(500).json({ error: 'internal' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('aires.sid');
    res.json({ ok: true });
  });
});

router.get('/me', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'unauthorized' });
  res.json({ user: req.session.user });
});

module.exports = router;
