const express = require('express');
const {
  findUserByEmail, findUserById, verifyPassword,
  setTotpSecret, enableTotp, disableTotp, requireAuth,
} = require('../lib/auth');
const totp = require('../lib/totp');

const router = express.Router();

const PARTIAL_TTL_MS = 5 * 60 * 1000; // 5 min para completar el 2do paso

// ─── LOGIN paso 1: email + password ───────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email y password requeridos' });
    const user = await findUserByEmail(email);
    if (!user) return res.status(401).json({ error: 'credenciales inválidas' });
    const ok = await verifyPassword(user, password);
    if (!ok) return res.status(401).json({ error: 'credenciales inválidas' });

    if (user.totp_enabled) {
      req.session.partial = { user_id: user.id, ts: Date.now() };
      req.session.user = undefined;
      return res.json({ needs2fa: true });
    }

    req.session.partial = undefined;
    req.session.user = { id: user.id, email: user.email, role: user.role };
    res.json({ ok: true, user: req.session.user });
  } catch (e) {
    console.error('[auth.login]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ─── LOGIN paso 2: TOTP code ──────────────────────────────────────────
router.post('/login/2fa', async (req, res) => {
  try {
    const { code } = req.body || {};
    const partial = req.session?.partial;
    if (!partial || !partial.user_id) return res.status(400).json({ error: 'sin sesión parcial — empezá de nuevo' });
    if (Date.now() - partial.ts > PARTIAL_TTL_MS) {
      req.session.partial = undefined;
      return res.status(401).json({ error: 'expiró el código, empezá de nuevo' });
    }
    if (!code) return res.status(400).json({ error: 'código requerido' });
    const user = await findUserById(partial.user_id);
    if (!user || !user.totp_enabled || !user.totp_secret) {
      req.session.partial = undefined;
      return res.status(400).json({ error: '2FA no configurado' });
    }
    if (!totp.verifyCode(code, user.totp_secret)) {
      return res.status(401).json({ error: 'código inválido' });
    }
    req.session.partial = undefined;
    req.session.user = { id: user.id, email: user.email, role: user.role };
    res.json({ ok: true, user: req.session.user });
  } catch (e) {
    console.error('[auth.login.2fa]', e);
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

// ─── 2FA management (requiere full auth) ──────────────────────────────
router.post('/2fa/setup', requireAuth, async (req, res) => {
  try {
    const user = await findUserById(req.session.user.id);
    if (!user) return res.status(404).json({ error: 'usuario no encontrado' });
    const secret = totp.generateSecret();
    await setTotpSecret(user.id, secret); // queda enabled=false hasta que confirme
    const url = totp.buildOtpAuthUrl(user.email, secret);
    const qr = await totp.toQrDataUrl(url);
    res.json({ secret, otpauth_url: url, qr_data_url: qr });
  } catch (e) {
    console.error('[auth.2fa.setup]', e);
    res.status(500).json({ error: 'internal' });
  }
});

router.post('/2fa/confirm', requireAuth, async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: 'código requerido' });
    const user = await findUserById(req.session.user.id);
    if (!user || !user.totp_secret) return res.status(400).json({ error: 'primero ejecutá /2fa/setup' });
    if (!totp.verifyCode(code, user.totp_secret)) return res.status(401).json({ error: 'código inválido' });
    await enableTotp(user.id);
    res.json({ ok: true });
  } catch (e) {
    console.error('[auth.2fa.confirm]', e);
    res.status(500).json({ error: 'internal' });
  }
});

router.post('/2fa/disable', requireAuth, async (req, res) => {
  try {
    const { password, code } = req.body || {};
    if (!password || !code) return res.status(400).json({ error: 'password y código requeridos' });
    const userFull = await findUserByEmail(req.session.user.email);
    if (!userFull) return res.status(404).json({ error: 'usuario no encontrado' });
    const okPw = await verifyPassword(userFull, password);
    if (!okPw) return res.status(401).json({ error: 'password inválido' });
    if (!userFull.totp_enabled || !userFull.totp_secret) return res.status(400).json({ error: '2FA no está activo' });
    if (!totp.verifyCode(code, userFull.totp_secret)) return res.status(401).json({ error: 'código inválido' });
    await disableTotp(userFull.id);
    res.json({ ok: true });
  } catch (e) {
    console.error('[auth.2fa.disable]', e);
    res.status(500).json({ error: 'internal' });
  }
});

router.get('/2fa/status', requireAuth, async (req, res) => {
  try {
    const user = await findUserById(req.session.user.id);
    res.json({ enabled: !!user?.totp_enabled });
  } catch (e) {
    console.error('[auth.2fa.status]', e);
    res.status(500).json({ error: 'internal' });
  }
});

module.exports = router;
