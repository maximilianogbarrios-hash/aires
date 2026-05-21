require('dotenv').config();
const path = require('path');
const { one, many } = require(path.resolve(__dirname, '..', '..', 'lib', 'db'));
const crypto = require('crypto');

const BASE = 'http://localhost:3000';

async function createSession(role) {
  const sid = crypto.randomBytes(24).toString('hex');
  const u = await one("select id, email, role from ab_users where role=$1 limit 1", [role]);
  const sess = {
    cookie: { originalMaxAge: 86400000, expires: new Date(Date.now()+86400000).toISOString(), httpOnly: true, path: '/' },
    user: { id: u.id, email: u.email, role: u.role },
  };
  const expire = new Date(Date.now()+86400000);
  await one(
    "insert into ab_session(sid, sess, expire) values($1,$2,$3) returning sid",
    [sid, sess, expire]
  );
  return { sid, role, user: u };
}

function sidCookie(sid) {
  // express-session uses 's:' prefix + sid + '.' + signature. But also accepts the cookie as
  // just s:sid for unsigned? No — we need a signed value. Workaround: use connect-pg-simple's
  // raw `sid` which express-session reads from cookie keyed by name 'connect.sid' default.
  // The cookie is "connect.sid=s:<sid>.<sig>". To bypass signing, we have two options:
  // 1) Sign with SESSION_SECRET ourselves
  // 2) Use express's cookie-signature module
  const cookieSign = require('cookie-signature');
  const secret = process.env.SESSION_SECRET || 'devtestsecret-localrun';
  const sig = cookieSign.sign(sid, secret).split('.').slice(1).join('.');
  return 'aires.sid=s%3A' + sid + '.' + encodeURIComponent(sig);
}

async function fetchProveedores(cookie, vista='operativo') {
  const r = await fetch(`${BASE}/api/v1/bancos/proveedores?vista=${vista}`, {
    headers: { Cookie: cookie },
  });
  const txt = await r.text();
  if (r.status !== 200) {
    console.error('HTTP', r.status, txt.slice(0,300));
    throw new Error('proveedores fail');
  }
  const parsed = JSON.parse(txt);
  if (!parsed.data && Array.isArray(parsed.proveedores)) parsed.data = parsed.proveedores;
  if (!parsed.data) parsed.data = [];
  return parsed;
}

async function postOverride(cookie, proveedor, accion) {
  const r = await fetch(`${BASE}/api/v1/bancos/gastos-direccion/override`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ proveedor, accion }),
  });
  return { status: r.status, body: await r.text() };
}

async function delOverride(cookie, proveedor) {
  const r = await fetch(`${BASE}/api/v1/bancos/gastos-direccion/override/${encodeURIComponent(proveedor)}`, {
    method: 'DELETE',
    headers: { Cookie: cookie },
  });
  return { status: r.status, body: await r.text() };
}

(async () => {
  try {
    // Clean any stale overrides for Energía y Gas/Revel from prior runs
    await one("delete from ab_gastos_direccion_overrides where proveedor_normalizado in ('Energía y Gas','Revel') returning 1", []).catch(()=>{});

    const admin = await createSession('admin');
    const gerente = await createSession('gerente');
    const adminCk = sidCookie(admin.sid);
    const gerenteCk = sidCookie(gerente.sid);

    console.log('1) Baseline (gerente):');
    const base = await fetchProveedores(gerenteCk);
    const gd0 = base.data.find(p => p.proveedor === 'Gastos Dirección') || { total_importe: 0, _miembros: 0 };
    console.log('   GD total:', gd0.total_importe?.toFixed(2), '€  miembros:', gd0._miembros);
    const ib0 = base.data.find(p => p.proveedor === 'Energía y Gas');
    console.log('   Energía y Gas visible?:', !!ib0, ib0 ? `(${ib0.total_importe.toFixed(2)}€)` : '');

    console.log('\n2) Admin: INCLUDE Energía y Gas');
    const inc = await postOverride(adminCk, 'Energía y Gas', 'include');
    console.log('   resp:', inc.status, inc.body.slice(0,160));

    console.log('\n3) Re-fetch (gerente):');
    const after = await fetchProveedores(gerenteCk);
    const gd1 = after.data.find(p => p.proveedor === 'Gastos Dirección') || { total_importe: 0, _miembros: 0 };
    console.log('   GD total:', gd1.total_importe?.toFixed(2), '€  miembros:', gd1._miembros);
    const ib1 = after.data.find(p => p.proveedor === 'Energía y Gas');
    console.log('   Energía y Gas visible separate?:', !!ib1);
    const delta = (gd1.total_importe||0) - (gd0.total_importe||0);
    const dMem = (gd1._miembros||0) - (gd0._miembros||0);
    console.log('   Δ:', delta.toFixed(2), '€  Δ miembros:', dMem);

    const ok = delta > 0 && dMem === 1 && !ib1;
    console.log('\n   ✓ INCLUDE OK:', ok ? 'YES' : 'NO');

    console.log('\n4) Cleanup: DELETE override');
    const del = await delOverride(adminCk, 'Energía y Gas');
    console.log('   resp:', del.status, del.body.slice(0,160));

    console.log('\n5) Verify rollback (gerente):');
    const back = await fetchProveedores(gerenteCk);
    const gd2 = back.data.find(p => p.proveedor === 'Gastos Dirección') || { total_importe: 0 };
    console.log('   GD total:', gd2.total_importe?.toFixed(2), '€  miembros:', gd2._miembros);
    const restored = Math.abs((gd2.total_importe||0) - (gd0.total_importe||0)) < 0.01;
    console.log('   ✓ ROLLBACK OK:', restored ? 'YES' : 'NO');

    // Cleanup sessions
    await one("delete from ab_session where sid in ($1,$2) returning sid",[admin.sid, gerente.sid]).catch(()=>{});
    process.exit(ok && restored ? 0 : 1);
  } catch (e) {
    console.error('FAIL', e);
    process.exit(2);
  }
})();
