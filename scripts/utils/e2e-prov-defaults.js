// Smoke test: verifica que la lógica de defaults de /bancos → Proveedores
// se comporta como se espera, simulando la inicialización del frontend.
// Requiere server local en :3000 + DB con users admin y gerente.

require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const { one, query } = require(path.resolve(__dirname, '..', '..', 'lib', 'db'));

const BASE = 'http://localhost:3000';

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
  return { sid, role };
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
  return { status: r.status, body: JSON.parse(txt) };
}

// Réplica del cálculo de período por defecto del frontend.
function calcPeriodoDefault(periodos, esAdmin) {
  const FLOOR = '2026-01';
  const permitidos = esAdmin ? periodos : periodos.filter((p) => p >= FLOOR);
  if (!permitidos.length) return null;
  const hoy = new Date();
  const prev = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);
  let target = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
  if (!esAdmin && target < FLOOR) target = FLOOR;
  return permitidos.includes(target) ? target : permitidos[permitidos.length - 1];
}

(async () => {
  const sids = [];
  let ok = true;
  try {
    const adminSess = await createSession('admin');
    sids.push(adminSess.sid);
    const ckAdmin = sidCookie(adminSess.sid);

    // 1) Listado de períodos
    console.log('── Períodos disponibles ──');
    const per = await fetchJson(ckAdmin, '/api/v1/bancos/periodos');
    const periodos = per.body.periodos || [];
    console.log(`   ${periodos.length} períodos: ${periodos.slice(0,3).join(', ')} ... ${periodos.slice(-3).join(', ')}`);

    // 2) Cálculo del default (mes anterior al actual)
    const hoy = new Date();
    const expectedPrev = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);
    const expectedPeriodo = `${expectedPrev.getFullYear()}-${String(expectedPrev.getMonth() + 1).padStart(2, '0')}`;
    console.log(`\n── Default período (mes anterior a hoy) ──`);
    console.log(`   esperado: ${expectedPeriodo}`);

    const defaultAdmin = calcPeriodoDefault(periodos, true);
    const defaultGerente = calcPeriodoDefault(periodos, false);
    console.log(`   admin   → ${defaultAdmin}  ${defaultAdmin === expectedPeriodo ? '✓' : (periodos.includes(expectedPeriodo) ? '✗' : '⚠ no disponible, cayó al último')}`);
    console.log(`   gerente → ${defaultGerente}`);
    if (periodos.includes(expectedPeriodo) && defaultAdmin !== expectedPeriodo) ok = false;

    // 3) Llamar /api/v1/bancos/proveedores con los defaults calculados
    //    (simulando el primer load del frontend)
    console.log(`\n── Carga con defaults (sociedad=sin_elche, periodo=${defaultAdmin}) ──`);
    const provRes = await fetchJson(
      ckAdmin,
      `/api/v1/bancos/proveedores?sociedad_id=sin_elche&periodo_desde=${defaultAdmin}&periodo_hasta=${defaultAdmin}`
    );
    const total = provRes.body.total_gasto;
    const slices = (provRes.body.proveedores || []).length;
    console.log(`   total: ${total?.toFixed(2)} €  slices: ${slices}  HTTP ${provRes.status}`);
    if (provRes.status !== 200 || total <= 0 || slices === 0) {
      console.error('   ✗ Respuesta vacía o error');
      ok = false;
    } else {
      console.log('   ✓ Datos no vacíos con los defaults aplicados');
    }

    // 4) Verificar HTML inicial: el selector de sociedad NO tiene 'selected'
    //    en sin_elche por hardcoding — el default debe venir del JS.
    console.log('\n── HTML estático ──');
    const fs = require('fs');
    const html = fs.readFileSync(path.resolve(__dirname, '..', '..', 'public', 'bancos', 'index.html'), 'utf8');
    const tieneSelectedSinElche = /value=["']sin_elche["'][^>]*\bselected\b/.test(html);
    console.log(`   <option value="sin_elche" selected> en HTML? ${tieneSelectedSinElche ? 'SÍ (sería redundante)' : 'NO (correcto — viene del JS)'}`);

    console.log('\n──────────');
    console.log(ok ? 'RESULTADO: ✓ Defaults funcionan' : 'RESULTADO: ✗ Hay problemas');
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error('FATAL:', e);
    process.exit(2);
  } finally {
    for (const sid of sids) {
      await query('DELETE FROM ab_session WHERE sid=$1', [sid]).catch(() => {});
    }
  }
})();
