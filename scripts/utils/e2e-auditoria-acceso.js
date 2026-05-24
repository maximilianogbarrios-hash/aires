// Auditoría de control de acceso /api/v1/bancos/* por rol.
// Para cada endpoint que devuelve datos potencialmente sensibles, verifica
// con sesiones de gerente, administrativo, pedidos, personal vs admin/socio.
//
// Pre-fix: revela gaps. Post-fix: confirma que están cerrados.

require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const { one, query } = require(path.resolve(__dirname, '..', '..', 'lib', 'db'));

const BASE = 'http://localhost:3000';
const ROLES_NO_ADMIN = ['gerente', 'administrativo', 'pedidos', 'personal'];
const ROLES_ADMIN    = ['admin', 'socio'];

// Categorías sensibles (no deben aparecer en respuestas para no-admin).
const SENSIBLES_CAT = ['NOMINAS_DIRECCION', 'GASTOS_DIRECCION', 'PRESTAMOS', 'FINANCIERO'];
const SENSIBLES_PROV = ['Raba Buildings', 'Raba'];

async function createSession(role) {
  const u = await one('SELECT id, email, role FROM ab_users WHERE role=$1 LIMIT 1', [role]);
  if (!u) return null;
  const sid = crypto.randomBytes(24).toString('hex');
  const sess = {
    cookie: { originalMaxAge: 86400000, expires: new Date(Date.now()+86400000).toISOString(), httpOnly: true, path:'/' },
    user: { id: u.id, email: u.email, role: u.role, totp_enabled: true },
  };
  await query('INSERT INTO ab_session (sid, sess, expire) VALUES ($1, $2, $3)',
    [sid, sess, new Date(Date.now() + 86400000)]);
  return { sid, role, email: u.email };
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
  return { status: r.status, body, raw: txt };
}

function detectarLeaks(body, label) {
  // Busca recursivamente categorías/proveedores sensibles en la respuesta.
  let leakCat = [], leakProv = [];
  const visit = (v) => {
    if (v == null) return;
    if (typeof v === 'string') {
      if (SENSIBLES_PROV.includes(v)) leakProv.push(v);
      return;
    }
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (typeof v === 'object') {
      for (const k of Object.keys(v)) {
        if (['categoria', 'categoria_top'].includes(k) && SENSIBLES_CAT.includes(v[k])) leakCat.push(v[k]);
        if (['proveedor', 'proveedor_normalizado', 'nombre'].includes(k) && SENSIBLES_PROV.includes(v[k])) leakProv.push(v[k]);
        visit(v[k]);
      }
    }
  };
  visit(body);
  return { leakCat: [...new Set(leakCat)], leakProv: [...new Set(leakProv)] };
}

(async () => {
  const sids = [];
  const sessions = {};
  for (const r of [...ROLES_ADMIN, ...ROLES_NO_ADMIN]) {
    const s = await createSession(r);
    if (s) { sessions[r] = s; sids.push(s.sid); }
  }
  console.log('Roles con sesión:', Object.keys(sessions).join(', '));

  // Endpoints a auditar para cada rol no-admin. Lista lo que esperamos
  // ver (o 403). El test reporta leaks, no aprueba/falla por solo.
  const PRUEBAS = [
    { ep: '/api/v1/bancos/movimientos?periodo=2026-04&limit=500',           label: 'movimientos' },
    { ep: '/api/v1/bancos/gastos-por-proveedor?periodo=2026-04',            label: 'gastos-por-proveedor' },
    { ep: '/api/v1/bancos/proveedores-lista',                                label: 'proveedores-lista' },
    { ep: '/api/v1/bancos/resumen',                                          label: 'resumen' },
    { ep: '/api/v1/bancos/cruces?periodo=2026-04',                           label: 'cruces' },
    { ep: '/api/v1/bancos/proveedor-evolucion?desde=2026-01&hasta=2026-04&proveedores=Raba%20Buildings', label: 'proveedor-evolucion (Raba)' },
    { ep: '/api/v1/bancos/reglas-normalizacion',                             label: 'reglas-normalizacion (GET)' },
  ];

  for (const rol of ROLES_NO_ADMIN) {
    if (!sessions[rol]) continue;
    console.log(`\n══ ROL: ${rol} (${sessions[rol].email}) ══`);
    const ck = sidCookie(sessions[rol].sid);
    for (const p of PRUEBAS) {
      const r = await fetchJson(ck, p.ep);
      const leaks = detectarLeaks(r.body, p.label);
      const flag = (leaks.leakCat.length + leaks.leakProv.length) > 0 ? '✗ LEAK' : (r.status === 200 ? '✓' : 'HTTP ' + r.status);
      const detail = leaks.leakCat.length || leaks.leakProv.length
        ? ` · cats=${leaks.leakCat.join(',')} provs=${leaks.leakProv.join(',')}`
        : '';
      console.log(`  ${flag.padEnd(8)} ${p.label}${detail}`);
    }
  }

  // POST /reclasificar — comportamiento esperado:
  //   pedidos/personal → 403 router (sin acceso a /bancos)
  //   gerente/administrativo → 200 para destinos normales, 403 para sensibles
  console.log('\n── POST /reclasificar — bloqueos por destino sensible ──');
  for (const rol of ROLES_NO_ADMIN) {
    if (!sessions[rol]) continue;
    const ck = sidCookie(sessions[rol].sid);
    async function post(payload, label, expected) {
      const r = await fetch(`${BASE}/api/v1/bancos/reclasificar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: ck },
        body: JSON.stringify(payload),
      });
      const flag = expected === r.status ? '✓' : '⚠';
      console.log(`  ${rol.padEnd(15)} ${label.padEnd(40)} → HTTP ${r.status} ${flag} (esperado ${expected})`);
    }
    const bloqueadoRouter = ['pedidos', 'personal'].includes(rol);
    if (bloqueadoRouter) {
      await post({ concepto: 'TEST', categoria_nueva: 'OTROS', proveedor_nuevo: 'TEST' }, 'cualquier reclasif', 403);
      continue;
    }
    // gerente/administrativo
    await post({ concepto: 'TEST-NONEXISTENT', categoria_nueva: 'OTROS', proveedor_nuevo: 'NuevoProvTest' }, 'destino normal',          200);
    await post({ concepto: 'TEST-NONEXISTENT', categoria_nueva: 'GASTOS_DIRECCION', proveedor_nuevo: 'X' }, 'categoria sensible',     403);
    await post({ concepto: 'TEST-NONEXISTENT', categoria_nueva: 'OTROS', proveedor_nuevo: 'Raba Buildings' }, 'destino Raba',         403);
    await post({ concepto: 'TEST-NONEXISTENT', categoria_nueva: 'OTROS', proveedor_nuevo: 'Gastos Dirección' }, 'destino fusionado', 403);
  }

  // Cleanup sesiones
  for (const sid of sids) await query('DELETE FROM ab_session WHERE sid=$1', [sid]).catch(()=>{});
})();
