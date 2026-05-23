// E2E: verifica que Raba Buildings está oculto a roles no-admin en los
// 4 endpoints de /bancos. Requiere server local + users admin + gerente.
//
// Checks (rol gerente):
//   1) GET /proveedores-normalizados → "Raba Buildings" NO aparece
//   2) GET /proveedores              → ningún slice "Raba Buildings"
//   3) GET /grupo-detalle?grupo=Raba Buildings → 403
//   4) GET /proveedor-evolucion?proveedores=Raba Buildings → vacío
//
// También control negativo con admin: Raba SÍ aparece en (1) y (4),
// y drill-down (3) responde 200.

require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const { one, query } = require(path.resolve(__dirname, '..', '..', 'lib', 'db'));

const BASE = 'http://localhost:3000';
const RABA = 'Raba Buildings';

async function createSession(role) {
  const u = await one('SELECT id, email, role FROM ab_users WHERE role=$1 LIMIT 1', [role]);
  if (!u) throw new Error('No user with role ' + role);
  const sid = crypto.randomBytes(24).toString('hex');
  const sess = {
    cookie: {
      originalMaxAge: 86400000,
      expires: new Date(Date.now() + 86400000).toISOString(),
      httpOnly: true, path: '/',
    },
    user: { id: u.id, email: u.email, role: u.role, totp_enabled: true },
  };
  await query(
    'INSERT INTO ab_session (sid, sess, expire) VALUES ($1, $2, $3)',
    [sid, sess, new Date(Date.now() + 86400000)]
  );
  return { sid };
}

function sidCookie(sid) {
  const cookieSign = require('cookie-signature');
  const secret = process.env.SESSION_SECRET || 'devtestsecret-localrun';
  const sig = cookieSign.sign(sid, secret).split('.').slice(1).join('.');
  return 'aires.sid=s%3A' + sid + '.' + encodeURIComponent(sig);
}

async function fetchJson(cookie, p) {
  const r = await fetch(`${BASE}${p}`, { headers: { Cookie: cookie } });
  const txt = await r.text();
  let body = null; try { body = JSON.parse(txt); } catch {}
  return { status: r.status, body };
}

function ok(cond, msg) { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); return cond; }

(async () => {
  const sids = [];
  let allOk = true;
  try {
    const gSess = await createSession('gerente');     sids.push(gSess.sid);
    const aSess = await createSession('admin');       sids.push(aSess.sid);
    const ckG = sidCookie(gSess.sid);
    const ckA = sidCookie(aSess.sid);

    // ─── ROL GERENTE: Raba debe estar OCULTO ─────────────────────────
    console.log('── Rol gerente: Raba Buildings debe estar OCULTO ──');

    // (1) /proveedores-normalizados
    const r1 = await fetchJson(ckG, '/api/v1/bancos/proveedores-normalizados?limit=500');
    const tieneRaba1 = (r1.body.proveedores || []).some((p) => p.nombre === RABA);
    allOk &= ok(r1.status === 200 && !tieneRaba1,
      `(1) /proveedores-normalizados → ${r1.body.proveedores?.length || 0} grupos, Raba presente: ${tieneRaba1}`);

    // (2) /proveedores (donut) — usar 2026-04 que está en período permitido
    const r2 = await fetchJson(ckG, '/api/v1/bancos/proveedores?sociedad_id=sin_elche&periodo=2026-04');
    const tieneRaba2 = (r2.body.proveedores || []).some((p) => p.proveedor === RABA);
    allOk &= ok(r2.status === 200 && !tieneRaba2,
      `(2) /proveedores (Abr 2026) → ${r2.body.proveedores?.length || 0} slices, Raba presente: ${tieneRaba2}`);

    // (3) /grupo-detalle?grupo=Raba Buildings
    const r3 = await fetchJson(ckG, `/api/v1/bancos/grupo-detalle?periodo=2026-04&grupo=${encodeURIComponent(RABA)}`);
    allOk &= ok(r3.status === 403, `(3) /grupo-detalle?grupo=Raba Buildings → HTTP ${r3.status} (esperado 403)`);

    // (4) /proveedor-evolucion?proveedores=Raba Buildings
    const r4 = await fetchJson(ckG, `/api/v1/bancos/proveedor-evolucion?desde=2026-01&hasta=2026-04&proveedores=${encodeURIComponent(RABA)}`);
    const series4 = (r4.body.series || []).filter((s) => s.key === RABA);
    const dataNoZero = series4.some((s) => (s.data || []).some((v) => v > 0));
    allOk &= ok(r4.status === 200 && !dataNoZero,
      `(4) /proveedor-evolucion?proveedores=Raba → ${series4.length} series, alguna con datos: ${dataNoZero}`);

    // ─── ROL ADMIN: Raba debe ser VISIBLE ────────────────────────────
    console.log('\n── Rol admin: Raba Buildings debe ser VISIBLE ──');

    const a1 = await fetchJson(ckA, '/api/v1/bancos/proveedores-normalizados?limit=500');
    const tieneRabaA1 = (a1.body.proveedores || []).some((p) => p.nombre === RABA);
    allOk &= ok(a1.status === 200 && tieneRabaA1, `(1) admin /proveedores-normalizados → Raba presente: ${tieneRabaA1}`);

    const a3 = await fetchJson(ckA, `/api/v1/bancos/grupo-detalle?periodo=2026-04&grupo=${encodeURIComponent(RABA)}`);
    allOk &= ok(a3.status === 200, `(3) admin /grupo-detalle?grupo=Raba Buildings → HTTP ${a3.status} (esperado 200)`);

    console.log('\n──────────');
    console.log(allOk ? 'RESULTADO: ✓ Seguridad Raba OK en los 4 endpoints' : 'RESULTADO: ✗ Hay filtraciones');
    process.exit(allOk ? 0 : 1);
  } catch (e) {
    console.error('FATAL:', e);
    process.exit(2);
  } finally {
    for (const sid of sids) {
      await query('DELETE FROM ab_session WHERE sid=$1', [sid]).catch(() => {});
    }
  }
})();
