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

function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
  return res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (req.session?.user?.role === 'admin') return next();
  if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'forbidden' });
  return res.status(403).send('Forbidden');
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
  setTotpSecret,
  enableTotp,
  disableTotp,
};
