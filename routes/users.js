const express = require('express');
const {
  listUsers, createUser, updateUserPassword, deleteUser, countUsers,
  requireAuth, requireAdmin,
} = require('../lib/auth');

const router = express.Router();

router.use(requireAuth, requireAdmin);

router.get('/', async (req, res) => {
  try {
    const users = await listUsers();
    res.json({ users });
  } catch (e) {
    console.error('[users.list]', e);
    res.status(500).json({ error: 'internal' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { email, password, role } = req.body || {};
    if (!email || !password || !role) return res.status(400).json({ error: 'email/password/role requeridos' });
    const c = await countUsers();
    if (c >= 5) return res.status(400).json({ error: 'máximo 5 usuarios' });
    const u = await createUser({ email, password, role });
    res.json({ ok: true, user: u });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'email ya existe' });
    console.error('[users.create]', e);
    res.status(500).json({ error: 'internal' });
  }
});

router.put('/:id/password', async (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: 'password requerido' });
    await updateUserPassword(+req.params.id, password);
    res.json({ ok: true });
  } catch (e) {
    console.error('[users.password]', e);
    res.status(500).json({ error: 'internal' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    if (+req.params.id === req.session.user.id) return res.status(400).json({ error: 'no podés borrarte a vos mismo' });
    await deleteUser(+req.params.id);
    res.json({ ok: true });
  } catch (e) {
    console.error('[users.delete]', e);
    res.status(500).json({ error: 'internal' });
  }
});

module.exports = router;
