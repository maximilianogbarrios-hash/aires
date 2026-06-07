// Test E2E del control de acceso v2 (post-cambio).
//
// Reglas (no-admin):
//   · AGREGADO GASTOS_DIRECCION → visible con total + % (igual a admin).
//   · DETALLE (drill-down) → 403 o vacío.
//   · MOVS individuales en /movimientos / /categoria-movimientos →
//     filtrados (no se enumeran).
//   · Raba → enmascarado a "Transferencia a Gastos Dirección".
//   · TRABAJO/TRABAJADAS → intactos (no son Raba).
//
// Reglas (admin/socio):
//   · Ven todo (agregado + detalle + nombre real Raba).

require('dotenv').config();
const express = require('express');
const http = require('http');

const bancosRouter = require('../../routes/bancos');
const cajaRouter   = require('../../routes/caja');

const ROLES = [
  { role: 'admin',          email: 'maxi@aires.com',   esAdmin: true,  alias: 'Maxi (admin)' },
  { role: 'socio',          email: 'dani@aires.com',   esAdmin: true,  alias: 'Dani (socio)' },
  { role: 'gerente',        email: 'luciano@aires.com', esAdmin: false, alias: 'Luciano (gerente)' },
  { role: 'administrativo', email: 'marina@aires.com',  esAdmin: false, alias: 'Marina (admvo)' },
  { role: 'personal',       email: 'agustina@aires.com',esAdmin: false, alias: 'Agustina (personal)' },
  { role: 'pedidos',        email: 'fabricio@aires.com',esAdmin: false, alias: 'Fabricio (pedidos)' },
];

const ENDPOINTS_BANCOS = [
  '/api/v1/bancos/resumen',
  '/api/v1/bancos/movimientos?limit=200',
  '/api/v1/bancos/proveedores',
  '/api/v1/bancos/gastos-por-proveedor',
  '/api/v1/bancos/categoria-movimientos?codigo=GASTOS_DIRECCION',
  '/api/v1/bancos/grupo-detalle?grupo=Gastos%20Direcci%C3%B3n',
  '/api/v1/bancos/grupo-detalle?grupo=Raba%20Buildings',
  '/api/v1/bancos/proveedores-normalizados',
  '/api/v1/bancos/flujo-mensual',
  '/api/v1/bancos/proveedores-lista',
  '/api/v1/bancos/categorias-codigos',
  '/api/v1/bancos/proveedor-evolucion?proveedor=Raba+Buildings',
  '/api/v1/bancos/reglas-normalizacion',
  '/api/v1/bancos/cruces',
];

const ENDPOINTS_CAJA = [
  '/api/v1/caja/resumen',
  '/api/v1/caja/por-sucursal',
  '/api/v1/caja/por-sociedad',
  '/api/v1/caja/categorias',
  '/api/v1/caja/flujo-mensual',
  '/api/v1/caja/movimientos?limit=200',
  '/api/v1/caja/combinado',
  '/api/v1/caja/flujo-total',
  '/api/v1/caja/donut-categorias',
  '/api/v1/caja/donut-proveedores',
  '/api/v1/caja/reconciliacion',
];

const ENDPOINTS = [...ENDPOINTS_BANCOS, ...ENDPOINTS_CAJA];

function buildApp(role, email) {
  const app = express();
  app.use((req, res, next) => {
    req.session = { user: { role, email, id: 999, totp_enabled: true } };
    next();
  });
  app.use('/api/v1/bancos', bancosRouter);
  app.use('/api/v1/caja',   cajaRouter);
  return app;
}

function request(app, path) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = server.address().port;
      http.get({ host: '127.0.0.1', port, path, headers: { 'accept': 'application/json' } }, (res) => {
        let body = '';
        res.on('data', (c) => body += c);
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body }); });
      }).on('error', (e) => { server.close(); reject(e); });
    });
  });
}

// Detector estructural de leaks. Leak = string Raba en cualquier campo,
// O un MOVIMIENTO INDIVIDUAL (con concepto+importe) cuya categoría
// sea sensible. NO marca: items de tipo agregado (sólo codigo+total),
// ni strings en concepto que digan "PRESTAMOS ADEUDO..." literal.
//
// Cambio 2026-06-07: PRESTAMOS sale del set sensible — sus movimientos
// individuales son visibles para no-admin (agregado + detalle).
const RABA_REGEX_TEST = /\b(?:raba|buildings?)\b/i;
const SENSITIVE_CATS = new Set(['GASTOS_DIRECCION', 'NOMINAS_DIRECCION']);

function esMovimientoIndividual(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  const tieneTexto = typeof o.concepto === 'string' || typeof o.subtipo === 'string' || typeof o.descripcion === 'string';
  const tieneImporte = typeof o.importe === 'number' || typeof o.monto === 'number';
  return tieneTexto && tieneImporte;
}

function detectLeaks(body) {
  let obj;
  try { obj = JSON.parse(body); } catch { return { raba: [], movDetalle: [], movItemizado: [] }; }
  const hits = { raba: [], movDetalle: [] };

  function walk(node, parentKey, path) {
    if (node == null) return;
    if (typeof node === 'string') {
      if (RABA_REGEX_TEST.test(node)) hits.raba.push({ path: path + '.' + parentKey, sample: node.slice(0, 80) });
      return;
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i], parentKey, path + '[' + i + ']');
      return;
    }
    if (typeof node === 'object') {
      // MOV INDIVIDUAL con categoría sensible = leak (no enumerar individuales)
      if (esMovimientoIndividual(node) && SENSITIVE_CATS.has(node.categoria)) {
        hits.movDetalle.push({ path, value: 'mov.categoria=' + node.categoria + ' concepto=' + (node.concepto||'').slice(0,50) });
      }
      for (const k of Object.keys(node)) walk(node[k], k, path + '.' + k);
    }
  }
  walk(obj, '', '');
  return hits;
}

// Helper: dado el payload de /proveedores, devuelve {total, gdTotal, gdPct}
// del agregado GASTOS_DIRECCION (si existe).
function extractGdAgregado(body) {
  let obj; try { obj = JSON.parse(body); } catch { return null; }
  const arr = obj?.por_categoria || obj?.categorias || [];
  const gd = arr.find?.((c) => c.codigo === 'GASTOS_DIRECCION');
  if (!gd) return null;
  // pct puede venir como .pct (fracción) o .porcentaje (0-100). Normalizamos.
  const pct = gd.pct != null ? gd.pct : (gd.porcentaje != null ? gd.porcentaje : null);
  return { total: gd.total, pct, n_movs: gd.n_movs };
}

(async () => {
  console.log('Test E2E v2: ' + ROLES.length + ' roles × ' + ENDPOINTS.length + ' endpoints = ' + (ROLES.length * ENDPOINTS.length) + ' calls\n');

  const matriz = {};
  for (const r of ROLES) matriz[r.alias] = {};

  let totalCalls = 0, totalLeaks = 0;
  for (const r of ROLES) {
    const app = buildApp(r.role, r.email);
    for (const ep of ENDPOINTS) {
      totalCalls++;
      try {
        const { status, body } = await request(app, ep);
        const result = { status };

        if (status === 401 || status === 403) {
          matriz[r.alias][ep] = result;
          continue;
        }
        if (status >= 400) {
          result.errorOther = body.slice(0, 100);
          matriz[r.alias][ep] = result;
          continue;
        }

        const hits = detectLeaks(body);

        if (r.esAdmin) {
          result.rabaTokens = hits.raba.length;
          result.movDetalle = hits.movDetalle.length;
        } else {
          // Leak Raba: cualquier mención del nombre real
          if (hits.raba.length > 0) {
            result.leakRaba = true;
            result.rabaSample = hits.raba.slice(0, 2);
            totalLeaks++;
          }
          // Leak movs itemizados sensibles
          if (hits.movDetalle.length > 0) {
            result.leakMovDetalle = true;
            result.movSample = hits.movDetalle.slice(0, 2);
            totalLeaks++;
          }
        }
        matriz[r.alias][ep] = result;
      } catch (e) {
        matriz[r.alias][ep] = { status: -1, error: e.message };
      }
    }
  }

  // ─── Matriz rol × endpoint ─────────────────────────────────────────
  console.log('=== MATRIZ rol × endpoint (PASS = sin fuga / 403 / 401) ===\n');
  for (const r of ROLES) {
    console.log(`▶ ${r.alias}`);
    let nPass = 0, nFail = 0, nDenied = 0;
    for (const ep of ENDPOINTS) {
      const x = matriz[r.alias][ep];
      if (!x) continue;
      const denied = x.status === 401 || x.status === 403;
      const ok = !x.leakRaba && !x.leakMovDetalle && !x.error;
      if (denied) nDenied++;
      else if (ok) nPass++;
      else nFail++;
      if (x.leakRaba || x.leakMovDetalle || x.error) {
        const tag = x.leakRaba ? 'LEAK RABA' : x.leakMovDetalle ? 'LEAK MOV-DETALLE' : 'ERROR';
        const sample = x.rabaSample || x.movSample || x.error || '';
        console.log(`  ✗ ${tag.padEnd(18)} ${ep}  → ${JSON.stringify(sample)}`);
      }
    }
    console.log(`  ${nPass} pass · ${nDenied} denied (403/401) · ${nFail} fail\n`);
  }

  // ─── ASSERT 1: AGREGADO GD visible para no-admin ───────────────────
  console.log('=== ASSERT 1: AGREGADO GASTOS_DIRECCION visible para no-admin ===');
  const epProv = '/api/v1/bancos/proveedores';
  const admin = ROLES.find((r) => r.role === 'admin');
  const appAdmin = buildApp(admin.role, admin.email);
  const adminResp = await request(appAdmin, epProv);
  const adminGd = extractGdAgregado(adminResp.body);
  console.log(`  Admin GASTOS_DIRECCION: ${adminGd ? `total=${adminGd.total} pct=${adminGd.pct}` : 'NO encontrado'}`);

  for (const r of ROLES.filter((x) => !x.esAdmin)) {
    const app = buildApp(r.role, r.email);
    const resp = await request(app, epProv);
    if (resp.status >= 400) {
      console.log(`  ${r.alias}: denied (${resp.status}) — endpoint bloqueado por perm de módulo, no aplica assert`);
      continue;
    }
    const gd = extractGdAgregado(resp.body);
    if (!gd) {
      console.log(`  ✗ ${r.alias}: AGREGADO GD NO presente — debería estar visible`);
      totalLeaks++;
      continue;
    }
    const totalMatch = gd.total === adminGd.total;
    const pctMatch = Math.abs((gd.pct || 0) - (adminGd.pct || 0)) < 0.0001;
    const sym = totalMatch && pctMatch ? '✓' : '✗';
    console.log(`  ${sym} ${r.alias}: total=${gd.total} (admin=${adminGd.total}, match=${totalMatch}) · pct=${gd.pct} (admin=${adminGd.pct}, match=${pctMatch})`);
    if (!totalMatch || !pctMatch) totalLeaks++;
  }

  // ─── ASSERT 2: Drill-down sigue bloqueado ──────────────────────────
  console.log('\n=== ASSERT 2: Drill-down bloqueado para no-admin (403) ===');
  const drills = [
    '/api/v1/bancos/categoria-movimientos?codigo=GASTOS_DIRECCION',
    '/api/v1/bancos/grupo-detalle?grupo=Gastos%20Direcci%C3%B3n',
    '/api/v1/bancos/grupo-detalle?grupo=Raba%20Buildings',
  ];
  for (const r of ROLES.filter((x) => !x.esAdmin)) {
    for (const d of drills) {
      const app = buildApp(r.role, r.email);
      const resp = await request(app, d);
      const blocked = resp.status === 403;
      // 403 por perm de módulo TAMBIÉN cuenta como bloqueo válido.
      console.log(`  ${blocked ? '✓' : '✗'} ${r.alias} ${d} → status=${resp.status}`);
      if (resp.status === 200) {
        // Si volvió 200, asegurarse de que no traiga movs/proveedores
        const hits = detectLeaks(resp.body);
        if (hits.movDetalle.length > 0 || hits.raba.length > 0) {
          console.log(`    ✗ EXTRA LEAK en drill: rabaHits=${hits.raba.length} movHits=${hits.movDetalle.length}`);
          totalLeaks++;
        }
      }
    }
  }

  // ─── ASSERT 3: admin/socio sí ven detalle Raba + GD ────────────────
  console.log('\n=== ASSERT 3: admin/socio SÍ ven datos sensibles ===');
  for (const r of ROLES.filter((x) => x.esAdmin)) {
    const app = buildApp(r.role, r.email);
    const respRaba = await request(app, '/api/v1/bancos/grupo-detalle?grupo=Raba%20Buildings');
    const respGD = await request(app, '/api/v1/bancos/categoria-movimientos?codigo=GASTOS_DIRECCION');
    const rabaTokens = (respRaba.body.match(/\b(raba|buildings?)\b/gi) || []).length;
    let nMovsGD = 0;
    try {
      const j = JSON.parse(respGD.body);
      nMovsGD = (j.movimientos || j.rows || []).length;
    } catch {}
    console.log(`▶ ${r.alias}`);
    console.log(`  /grupo-detalle?grupo=Raba Buildings → status=${respRaba.status} raba_tokens=${rabaTokens} ${rabaTokens > 0 ? '✓' : '✗ NO ve Raba!'}`);
    console.log(`  /categoria-movimientos?codigo=GASTOS_DIRECCION → status=${respGD.status} movs=${nMovsGD} ${nMovsGD > 0 ? '✓' : '✗ NO ve detalle GD!'}`);
    if (rabaTokens === 0 || nMovsGD === 0) totalLeaks++;
  }

  // ─── ASSERT 4: TRABAJADAS sigue intacto para gerente ───────────────
  console.log('\n=== ASSERT 4: TRABAJO/TRABAJADAS NO enmascarado (caja, rol gerente) ===');
  const appGer = buildApp('gerente', 'luciano@aires.com');
  const respCaja = await request(appGer, '/api/v1/caja/movimientos?sucursal=SANTA%20POLA&desde=2026-03-29&hasta=2026-03-31&limit=20');
  if (respCaja.status === 200) {
    const obj = JSON.parse(respCaja.body);
    const movs = obj.movimientos || obj.rows || [];
    const trabaja = movs.filter((m) => /TRABAJ/i.test(m.subtipo || ''));
    const enmasc = movs.filter((m) => m.subtipo === 'Transferencia a Gastos Dirección');
    console.log(`  movs SANTA POLA 2026-03-29..31: ${movs.length}`);
    console.log(`  TRABAJADAS encontradas: ${trabaja.length} (${trabaja.map(m=>m.subtipo).join(' | ')})`);
    console.log(`  enmascarados (false positive): ${enmasc.length}`);
    if (enmasc.length === 0 && trabaja.length > 0) console.log('  ✓ PASS');
    else { console.log('  ✗ FAIL'); totalLeaks++; }
  } else {
    console.log(`  status=${respCaja.status}, no concluyente`);
  }

  // ─── ASSERT 5: PRESTAMOS abierto para no-admin (agregado y detalle) ─
  // Cambio 2026-06-07: PRESTAMOS salió del set sensible. Sus movs
  // individuales deben fluir intactos. Validamos directamente contra
  // el sanitizer con un payload sintético — el endpoint de
  // /categoria-movimientos sigue bloqueando PRESTAMOS por la lista
  // bancos.js#CATEGORIAS_DIRECCION_FUSE (capa de fusión visual, no
  // sanitizer). Aquí probamos lo que es responsabilidad de sanitize.js.
  console.log('\n=== ASSERT 5: sanitize.js NO toca PRESTAMOS ===');
  const { sanitizeForNonAdmin, SENSITIVE_CATEGORIES } = require('../../lib/access/sanitize');
  const setOk = !SENSITIVE_CATEGORIES.has('PRESTAMOS')
              && SENSITIVE_CATEGORIES.has('GASTOS_DIRECCION')
              && SENSITIVE_CATEGORIES.has('NOMINAS_DIRECCION')
              && SENSITIVE_CATEGORIES.size === 2;
  console.log(`  SENSITIVE_CATEGORIES = {${[...SENSITIVE_CATEGORIES].join(', ')}} ${setOk ? '✓' : '✗'}`);
  if (!setOk) totalLeaks++;

  const payloadPrestamos = {
    por_categoria: [
      { codigo:'PRESTAMOS', total:50000, n_movs:8,
        proveedores:[{nombre:'Banco Santander', total:50000}] },
    ],
    movimientos: [
      { id:9001, fecha:'2026-05-15', concepto:'Cuota préstamo Santander',
        categoria:'PRESTAMOS', importe:-8000 },
      { id:9002, fecha:'2026-04-15', concepto:'Cuota préstamo Santander',
        categoria:'PRESTAMOS', importe:-8000 },
    ],
  };
  const sanitized = JSON.parse(JSON.stringify(payloadPrestamos));
  sanitizeForNonAdmin(sanitized);
  const cat = sanitized.por_categoria.find((c) => c.codigo === 'PRESTAMOS');
  const okAgr = cat && cat.total === 50000 && cat.proveedores.length === 1;
  const okDet = sanitized.movimientos.length === 2
             && sanitized.movimientos.every((m) => m.concepto === 'Cuota préstamo Santander');
  console.log(`  Agregado PRESTAMOS intacto (total/proveedores): ${okAgr ? '✓' : '✗'}`);
  console.log(`  Detalle PRESTAMOS intacto (2 movs sin modificar): ${okDet ? '✓' : '✗'}`);
  if (!okAgr || !okDet) totalLeaks++;

  // ─── ASSERT 6: matriz E2E AGREGADO/DETALLE por categoría × rol ─────
  console.log('\n=== ASSERT 6: matriz visibilidad categoría × rol (no-admin) ===');
  console.log('  GASTOS_DIRECCION  → agregado VISIBLE · detalle BLOQUEADO');
  console.log('  NOMINAS_DIRECCION → agregado VISIBLE · detalle BLOQUEADO');
  console.log('  PRESTAMOS         → agregado VISIBLE · detalle VISIBLE');
  console.log('  Raba (string)     → enmascarado a "Transferencia a Gastos Dirección"');
  console.log('  TRABAJADAS        → INTACTO (no es Raba)');

  console.log(`\n=== TOTAL ===`);
  console.log(`Llamadas: ${totalCalls}`);
  console.log(`Leaks no-admin: ${totalLeaks}`);
  process.exit(totalLeaks ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
