const bcrypt = require('bcryptjs');
const { one, query } = require('./db');

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
}

async function disableTotp(userId) {
  await query(
    'UPDATE ab_users SET totp_enabled=FALSE, totp_secret=NULL, updated_at=NOW() WHERE id=$1',
    [userId]
  );
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

function requireAuth(req, res, next) {
  // Dentro de un router montado con app.use('/api/v1/auth', ...), req.path
  // queda relativo al mount point (ej. '/2fa/setup'), por lo que tanto el
  // chequeo de '/api/' como el whitelist de pathPermitidoSin2FA fallaban
  // silenciosamente y redirigían a /account incluso en el endpoint de
  // setup. Usamos el path completo (originalUrl sin query) para todos
  // los chequeos.
  const fullPath = ((req.originalUrl || req.url || '').split('?')[0]) || '';
  if (!req.session?.user) {
    if (fullPath.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
    return res.redirect('/login');
  }
  // 2FA obligatorio: si la sesión indica que el user no tiene TOTP
  // habilitado y la ruta no está en la whitelist, redirigir a /account
  // para que active 2FA. El flag totp_enabled se setea al login y se
  // actualiza después de /2fa/confirm y /2fa/disable.
  const u = req.session.user;
  if (u.totp_enabled === false && !pathPermitidoSin2FA(fullPath)) {
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
