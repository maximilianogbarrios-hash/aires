const bcrypt = require('bcryptjs');
const { one, query } = require('./db');

// Cache corto (60s) del flag totp_enabled por user.id — evita query a
// DB en cada request pero permite que reseteos sean rápidos.
const _totpFlagCache = new Map();
function invalidateTotpFlag(userId) { _totpFlagCache.delete(userId); }

async function findUserByEmail(email) {
  if (!email) return null;
  return one(
    'SELECT id, email, password_hash, role, totp_secret, totp_enabled FROM ab_users WHERE email=$1',
    [email.toLowerCase()]
  );
}

async function findUserById(id) {
  if (!id) return null;
  return one(
    'SELECT id, email, role, totp_secret, totp_enabled FROM ab_users WHERE id=$1',
    [id]
  );
}

async function setTotpSecret(userId, secret) {
  await query(
    'UPDATE ab_users SET totp_secret=$1, totp_enabled=FALSE, updated_at=NOW() WHERE id=$2',
    [secret, userId]
  );
}

async function enableTotp(userId) {
  await query(
    'UPDATE ab_users SET totp_enabled=TRUE, updated_at=NOW() WHERE id=$1',
    [userId]
  );
  invalidateTotpFlag(userId);
}

async function disableTotp(userId) {
  await query(
    'UPDATE ab_users SET totp_enabled=FALSE, totp_secret=NULL, updated_at=NOW() WHERE id=$1',
    [userId]
  );
  invalidateTotpFlag(userId);
}

async function verifyPassword(user, password) {
  if (!user || !password) return false;
  return bcrypt.compare(password, user.password_hash);
}

const { ROLES } = require('./roles');

async function createUser({ email, password, role }) {
  if (!ROLES.includes(role)) throw new Error('invalid role');
  const hash = bcrypt.hashSync(password, 10);
  const r = await one(
    'INSERT INTO ab_users (email, password_hash, role) VALUES ($1,$2,$3) RETURNING id, email, role, created_at',
    [email.toLowerCase(), hash, role]
  );
  return r;
}

async function updateUserPassword(id, password) {
  const hash = bcrypt.hashSync(password, 10);
  await query('UPDATE ab_users SET password_hash=$1, updated_at=NOW() WHERE id=$2', [hash, id]);
}

async function deleteUser(id) {
  await query('DELETE FROM ab_users WHERE id=$1', [id]);
}

async function listUsers() {
  const { rows } = await query('SELECT id, email, role, totp_enabled, created_at FROM ab_users ORDER BY created_at ASC');
  return rows;
}

async function countUsers() {
  const r = await one('SELECT COUNT(*)::int AS c FROM ab_users');
  return r.c;
}

// Rutas que pueden accederse SIN tener 2FA activado todavía. Permite que
// un usuario nuevo pueda entrar a /account y completar el setup TOTP sin
// quedar atrapado en un redirect loop. Cualquier otra ruta exige 2FA.
function pathPermitidoSin2FA(path) {
  if (path === '/account') return true;
  // Todo /api/v1/auth/* (login, logout, me, 2fa/setup, 2fa/confirm, 2fa/status).
  if (path.startsWith('/api/v1/auth/')) return true;
  return false;
}

const TOTP_CACHE_TTL_MS = 60 * 1000;
// Re-sync defensivo SOLO cuando la sesión dice totp_enabled=true: chequea
// DB para detectar reseteos hechos por admin. Si DB devuelve null (user
// no existe — tests sintéticos), NO se considera reseteo: respeta el
// flag de sesión.
async function _shouldRevokeTotp(userId) {
  const c = _totpFlagCache.get(userId);
  if (c && Date.now() - c.ts < TOTP_CACHE_TTL_MS) return c.revoke;
  try {
    const u = await findUserById(userId);
    // Solo revoca si el user EXISTE y totp_enabled es explícitamente false.
    const revoke = !!u && u.totp_enabled === false;
    _totpFlagCache.set(userId, { ts: Date.now(), revoke });
    return revoke;
  } catch { return false; } // DB fail → no romper UX, dejar pasar
}

async function requireAuth(req, res, next) {
  const fullPath = ((req.originalUrl || req.url || '').split('?')[0]) || '';
  if (!req.session?.user) {
    if (fullPath.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
    return res.redirect('/login');
  }
  const u = req.session.user;
  // 2FA OBLIGATORIO. Cubre 3 casos:
  //  1) Sesión vieja con totp_enabled undefined/null/false → BLOQUEAR (era el bug).
  //  2) Sesión con totp_enabled=true PERO admin reseteó en DB → revoke (cache 60s).
  //  3) Sesión con totp_enabled=true y DB confirma true → next().
  let needs2fa = !u.totp_enabled; // caso (1): cubre undefined, null, false.
  if (!needs2fa) {
    // Caso (2): la sesión dice true, verificamos contra DB.
    const revoke = await _shouldRevokeTotp(u.id);
    if (revoke) {
      needs2fa = true;
      u.totp_enabled = false; // sincronizar sesión
    }
  }
  if (needs2fa && !pathPermitidoSin2FA(fullPath)) {
    if (fullPath.startsWith('/api/')) {
      return res.status(403).json({
        error: '2fa_required',
        message: 'Debes activar 2FA para continuar usando el sistema. Es obligatorio por seguridad.',
        redirect: '/account?msg=2fa-required',
      });
    }
    return res.redirect('/account?msg=2fa-required');
  }
  return next();
}

function requireAdmin(req, res, next) {
  if (req.session?.user?.role === 'admin') return next();
  if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'forbidden' });
  return res.status(403).send('Forbidden');
}

const { hasPerm } = require('./roles');

// Middleware factory: requirePerm('pedidos_w') → 403 si el rol no incluye ese perm.
function requirePerm(perm) {
  return (req, res, next) => {
    const role = req.session?.user?.role;
    if (!role) return res.status(401).json({ error: 'unauthorized' });
    if (!hasPerm(role, perm)) {
      if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'forbidden', perm });
      return res.status(403).send('Forbidden');
    }
    next();
  };
}

module.exports = {
  findUserByEmail,
  findUserById,
  verifyPassword,
  createUser,
  updateUserPassword,
  deleteUser,
  listUsers,
  countUsers,
  requireAuth,
  requireAdmin,
  requirePerm,
  setTotpSecret,
  enableTotp,
  disableTotp,
};
