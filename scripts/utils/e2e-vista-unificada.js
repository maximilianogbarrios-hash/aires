// E2E: verifica que /bancos/proveedores devuelve EXACTAMENTE los mismos
// slices y los mismos importes para todos los roles. La única diferencia
// permitida es `fusion_direccion.puede_drilldown` (true para admin/socio,
// false para el resto) y la respuesta de drill-down sobre "Gastos
// Dirección" (200 admin/socio, 403 resto).
//
// Uso: server local corriendo en :3000, DB con usuarios admin + gerente
// + administrativo creados. `npm run e2e:vista-unificada`.

require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const { one, query } = require(path.resolve(__dirname, '..', '..', 'lib', 'db'));

const BASE = 'http://localhost:3000';
// Acepta override por CLI: node e2e-vista-unificada.js 2025-06
const PERIODO = process.argv[2] || '2026-04';
const FILTRO = `?sociedad_id=sin_elche&periodo=${PERIODO}`;
// Categorías cuya presencia (al menos un slice cae en ellas) garantiza
// que el donut está mostrando el espectro completo, no sólo operativos.
// Lista basada en lo que pidió el user: nóminas, TGSS, AEAT, alquileres,
// energía, mantenimiento, equipamiento, vehículos, comisiones, GD.
const CATEGORIAS_ESPERADAS_AMPLIO = [
  'NOMINAS', 'SS_LABORAL', 'IMPUESTOS', 'ALQUILER',
  'SUMINISTROS_ENERGIA', 'MANTENIMIENTO',
  'GASTOS_DIRECCION', // siempre presente como categoría del slice fusionado
];

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
    // totp_enabled true para no caer en requireAuth → /account redirect
    user: { id: u.id, email: u.email, role: u.role, totp_enabled: true },
  };
  await query(
    'INSERT INTO ab_session (sid, sess, expire) VALUES ($1, $2, $3)',
    [sid, sess, new Date(Date.now() + 86400000)]
  );
  return { sid, role, user: u };
}

function sidCookie(sid) {
  const cookieSign = require('cookie-signature');
  const secret = process.env.SESSION_SECRET || 'devtestsecret-localrun';
  const sig = cookieSign.sign(sid, secret).split('.').slice(1).join('.');
  return 'aires.sid=s%3A' + sid + '.' + encodeURIComponent(sig);
}

async function fetchJson(cookie, path_) {
  const r = await fetch(`${BASE}${path_}`, { headers: { Cookie: cookie } });
  const txt = await r.text();
  let body = null;
  try { body = JSON.parse(txt); } catch {}
  return { status: r.status, body, raw: txt };
}

function fmtEur(v) { return (v != null ? v : 0).toFixed(2) + ' €'; }

(async () => {
  const sids = [];
  let ok = true;
  try {
    const ROLES = ['admin', 'socio', 'gerente', 'administrativo'];
    const sessions = {};
    for (const r of ROLES) {
      try {
        sessions[r] = await createSession(r);
        sids.push(sessions[r].sid);
      } catch (e) {
        console.warn(`  ⚠ sin user ${r} — skip`);
      }
    }
    const presentes = Object.keys(sessions);
    if (presentes.length < 2) {
      console.error('Necesito al menos 2 roles con users en DB');
      process.exit(2);
    }

    console.log(`Fetch /api/v1/bancos/proveedores${FILTRO} para roles:`, presentes);

    const respuestas = {};
    for (const r of presentes) {
      const ck = sidCookie(sessions[r].sid);
      const res = await fetchJson(ck, `/api/v1/bancos/proveedores${FILTRO}`);
      if (res.status !== 200) {
        console.error(`  ✗ ${r}: HTTP ${res.status} — ${res.raw.slice(0, 200)}`);
        ok = false; continue;
      }
      respuestas[r] = res.body;
    }

    const rolesOk = Object.keys(respuestas);
    if (rolesOk.length < 2) { console.error('Falló fetch para varios roles'); process.exit(2); }

    // Comparar totales
    console.log('\n── Totales globales ──');
    const ref = respuestas[rolesOk[0]].total_gasto;
    for (const r of rolesOk) {
      const t = respuestas[r].total_gasto;
      const eq = Math.abs(t - ref) < 0.01;
      console.log(`  ${r.padEnd(15)} → ${fmtEur(t)}  ${eq ? '✓' : '✗ DIFERENTE'}`);
      if (!eq) ok = false;
    }

    // Comparar set de slices (proveedor + total_importe)
    console.log('\n── Slices ──');
    const slicesRef = new Map((respuestas[rolesOk[0]].proveedores || [])
      .map((p) => [p.proveedor, Math.round(p.total_importe * 100) / 100]));
    console.log(`  ${rolesOk[0]}: ${slicesRef.size} slices`);
    for (let i = 1; i < rolesOk.length; i++) {
      const r = rolesOk[i];
      const sl = new Map((respuestas[r].proveedores || [])
        .map((p) => [p.proveedor, Math.round(p.total_importe * 100) / 100]));
      const mismatches = [];
      if (sl.size !== slicesRef.size) {
        mismatches.push(`tamaño ${sl.size} vs ${slicesRef.size}`);
      }
      for (const [name, val] of slicesRef.entries()) {
        const other = sl.get(name);
        if (other == null) mismatches.push(`falta "${name}"`);
        else if (Math.abs(other - val) > 0.01) mismatches.push(`"${name}" ${val} vs ${other}`);
      }
      for (const [name] of sl.entries()) {
        if (!slicesRef.has(name)) mismatches.push(`extra "${name}"`);
      }
      console.log(`  ${r.padEnd(15)} → ${sl.size} slices  ${mismatches.length === 0 ? '✓ idéntico' : '✗ ' + mismatches.slice(0,3).join('; ')}`);
      if (mismatches.length) ok = false;
    }

    // Slice "Gastos Dirección" presente con mismo importe para todos
    console.log('\n── Slice "Gastos Dirección" ──');
    for (const r of rolesOk) {
      const gd = (respuestas[r].proveedores || []).find((p) => p.proveedor === 'Gastos Dirección');
      const fd = respuestas[r].fusion_direccion;
      console.log(`  ${r.padEnd(15)} → ${gd ? fmtEur(gd.total_importe) : '(no slice)'}  miembros=${gd?._miembros ?? '—'}  puede_drilldown=${fd?.puede_drilldown ?? '—'}`);
      if (!gd) { console.error(`    ✗ ${r} NO ve el slice`); ok = false; }
      const esAdmin = ['admin','socio'].includes(r);
      if (gd && fd?.puede_drilldown !== esAdmin) {
        console.error(`    ✗ ${r} puede_drilldown debería ser ${esAdmin}`);
        ok = false;
      }
    }

    // Cobertura: el donut tiene slices de las categorías "amplias".
    console.log('\n── Cobertura de categorías ──');
    for (const r of rolesOk) {
      const cats = new Set((respuestas[r].proveedores || [])
        .map((p) => p.categoria).filter(Boolean));
      const missing = CATEGORIAS_ESPERADAS_AMPLIO.filter((c) => !cats.has(c));
      console.log(`  ${r.padEnd(15)} → ${cats.size} categorías distintas  ${missing.length === 0 ? '✓ todas las esperadas presentes' : '✗ faltan: ' + missing.join(', ')}`);
      if (missing.length) ok = false;
    }

    // Drill-down: admin 200, no-admin 403
    console.log('\n── Drill-down /grupo-detalle?grupo=Gastos Dirección ──');
    for (const r of rolesOk) {
      const ck = sidCookie(sessions[r].sid);
      const res = await fetchJson(ck, `/api/v1/bancos/grupo-detalle${FILTRO}&grupo=${encodeURIComponent('Gastos Dirección')}`);
      const esAdmin = ['admin','socio'].includes(r);
      const expected = esAdmin ? 200 : 403;
      const okDrill = res.status === expected;
      const detail = (esAdmin && res.body)
        ? `${res.body.num_conceptos} conceptos · total ${fmtEur(res.body.total)}`
        : (res.body?.error || '');
      console.log(`  ${r.padEnd(15)} → HTTP ${res.status}  esperado ${expected}  ${okDrill ? '✓' : '✗'}  ${detail}`);
      if (!okDrill) ok = false;
    }

    console.log('\n──────────');
    console.log(ok ? 'RESULTADO: ✓ TODOS LOS CHECKS PASARON' : 'RESULTADO: ✗ HAY DIFERENCIAS');
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error('FATAL:', e);
    process.exit(2);
  } finally {
    // Cleanup sessions
    for (const sid of sids) {
      await query('DELETE FROM ab_session WHERE sid=$1', [sid]).catch(() => {});
    }
  }
})();
