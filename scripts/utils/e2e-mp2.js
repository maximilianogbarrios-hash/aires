// E2E smoke MP v2: catálogo + crear pedido + confirmar (distribución) +
// actualizar precio real + conciliación + control de acceso por rol.

require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const { one, query } = require(path.resolve(__dirname, '..', '..', 'lib', 'db'));

const BASE = 'http://localhost:3000';

async function sess(role) {
  const u = await one('SELECT id, email, role FROM ab_users WHERE role=$1 LIMIT 1', [role]);
  if (!u) return null;
  const sid = crypto.randomBytes(24).toString('hex');
  const s = {
    cookie: { originalMaxAge: 86400000, expires: new Date(Date.now()+86400000).toISOString(), httpOnly: true, path:'/' },
    user: { id: u.id, email: u.email, role: u.role, totp_enabled: true },
  };
  await query('INSERT INTO ab_session (sid, sess, expire) VALUES ($1,$2,$3)', [sid, s, new Date(Date.now()+86400000)]);
  return { sid, email: u.email, id: u.id };
}
function ck(sid) {
  const cs = require('cookie-signature');
  const sec = process.env.SESSION_SECRET || 'devtestsecret-localrun';
  const sig = cs.sign(sid, sec).split('.').slice(1).join('.');
  return 'aires.sid=s%3A' + sid + '.' + encodeURIComponent(sig);
}
async function call(cookie, method, path_, body) {
  const r = await fetch(BASE + path_, {
    method, headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  let j = null; try { j = JSON.parse(txt); } catch {}
  return { status: r.status, body: j, raw: txt };
}
let _failures = 0;
function ok(c, msg) { const b = !!c; console.log((b ? '  ✓ ' : '  ✗ ') + msg); if (!b) _failures++; return b; }

(async () => {
  const sids = [];
  let allOk = true;
  try {
    const ses = {};
    for (const r of ['admin', 'gerente', 'pedidos', 'personal']) {
      const s = await sess(r); if (s) { ses[r] = s; sids.push(s.sid); }
    }
    console.log('Roles con sesión:', Object.keys(ses).join(', '));

    console.log('\n══ Control de acceso /api/v1/mp2/meta ══');
    const m1 = await call(ck(ses.admin.sid), 'GET', '/api/v1/mp2/meta');
    ok(m1.status === 200, `admin meta → HTTP ${m1.status}`);
    const m2 = await call(ck(ses.gerente.sid), 'GET', '/api/v1/mp2/meta');
    ok(m2.status === 200, `gerente meta → HTTP ${m2.status}`);
    const m3 = await call(ck(ses.pedidos.sid), 'GET', '/api/v1/mp2/meta');
    ok(m3.status === 200, `pedidos (Fabricio) meta → HTTP ${m3.status}`);
    const m4 = await call(ck(ses.personal.sid), 'GET', '/api/v1/mp2/meta');
    ok(m4.status === 403, `personal (Agustina) meta → HTTP ${m4.status} (esperado 403)`);

    console.log('\n══ Catálogo (seed) ══');
    const cat = await call(ck(ses.admin.sid), 'GET', '/api/v1/mp2/catalogo');
    ok(cat.body?.catalogo?.length >= 4, `seed catálogo: ${cat.body?.catalogo?.length} items (esperado >=4)`);

    console.log('\n══ Crear pedido (admin) ══');
    const semana = 21, anio = 2026;
    const create = await call(ck(ses.admin.sid), 'POST', '/api/v1/mp2/pedidos', {
      semana, anio, sociedad_id: 'murcia', proveedor_normalizado: 'Carnicas Mulas SL',
      notas: 'pedido e2e test',
      lineas: [
        { producto: 'Ternera picada 80/20', cantidad: 180, unidad: 'kg', precio_estimado: 8.20 },
        { producto: 'Pechuga de pollo fileteada', cantidad: 120, unidad: 'kg', precio_estimado: 5.40 },
      ],
    });
    ok(create.status === 200 && create.body?.id, `crear: HTTP ${create.status} id=${create.body?.id} est=${create.body?.importe_estimado}`);
    const pedId = create.body?.id;

    console.log('\n══ Confirmar pedido (distribución automática) ══');
    const conf = await call(ck(ses.admin.sid), 'POST', `/api/v1/mp2/pedidos/${pedId}/confirmar`);
    ok(conf.status === 200 && conf.body?.distribuidos > 0, `confirmar: HTTP ${conf.status} distribuidos=${conf.body?.distribuidos} total=${conf.body?.total}`);

    const det = await call(ck(ses.admin.sid), 'GET', `/api/v1/mp2/pedidos/${pedId}`);
    const distSum = (det.body?.distribucion || []).reduce((s, d) => s + (d.importe_estimado || 0), 0);
    ok(Math.abs(distSum - (det.body?.pedido?.importe_estimado || 0)) < 0.5,
      `suma distribución ≈ total cabecera: ${distSum.toFixed(2)} ≈ ${det.body?.pedido?.importe_estimado}`);

    console.log('\n══ Visibilidad distribución por rol ══');
    const detPed = await call(ck(ses.pedidos.sid), 'GET', `/api/v1/mp2/pedidos/${pedId}`);
    ok(detPed.body?.distribucion == null, `Fabricio NO ve distribución (cabecera sí): distribucion=${detPed.body?.distribucion}`);

    console.log('\n══ Actualizar precio real + cascada ══');
    const lineaId = det.body?.lineas?.[0]?.id;
    const upd = await call(ck(ses.admin.sid), 'PUT', `/api/v1/mp2/pedidos/${pedId}/lineas/${lineaId}`, {
      precio_real: 8.80, actualizar_catalogo: true, motivo_catalogo: 'subida temporada',
    });
    ok(upd.status === 200 && upd.body?.totalReal > 0 && upd.body?.catalogoActualizado,
      `precio_real → totalReal=${upd.body?.totalReal} desvia=${(upd.body?.desvia*100).toFixed(1)}% catalogo=${upd.body?.catalogoActualizado}`);

    console.log('\n══ Semáforo del mes ══');
    const sem = await call(ck(ses.admin.sid), 'GET', `/api/v1/mp2/semaforo?anio_mes=${anio}-05`);
    const semProv = (sem.body?.proveedores || []).find((p) => p.proveedor === 'Carnicas Mulas SL');
    ok(semProv && semProv.estimado_mes > 0, `semáforo Mulas: est=${semProv?.estimado_mes} pres=${semProv?.presupuesto_mes} → ${semProv?.semaforo}`);

    console.log('\n══ Permisos avanzados ══');
    const estPed = await call(ck(ses.pedidos.sid), 'PUT', `/api/v1/mp2/pedidos/${pedId}/estado`, { estado: 'recibido' });
    ok(estPed.status === 403, `pedidos NO puede cambiar a recibido → HTTP ${estPed.status} (esperado 403)`);
    const estGer = await call(ck(ses.gerente.sid), 'PUT', `/api/v1/mp2/pedidos/${pedId}/estado`, { estado: 'recibido' });
    ok(estGer.status === 200, `gerente sí puede → HTTP ${estGer.status}`);

    const delPed = await call(ck(ses.gerente.sid), 'DELETE', `/api/v1/mp2/pedidos/${pedId}`);
    ok(delPed.status === 403, `gerente NO puede borrar → HTTP ${delPed.status} (esperado 403)`);
    const delAdm = await call(ck(ses.admin.sid), 'DELETE', `/api/v1/mp2/pedidos/${pedId}`);
    ok(delAdm.status === 200, `admin sí borra → HTTP ${delAdm.status}`);

    console.log('\n──────────');
    console.log(_failures === 0 ? 'RESULTADO: ✓ Smoke MP v2 OK' : `RESULTADO: ✗ ${_failures} fallos`);
    process.exit(_failures === 0 ? 0 : 1);
  } catch (e) {
    console.error('FATAL:', e);
    process.exit(2);
  } finally {
    for (const sid of sids) await query('DELETE FROM ab_session WHERE sid=$1', [sid]).catch(()=>{});
  }
})();
