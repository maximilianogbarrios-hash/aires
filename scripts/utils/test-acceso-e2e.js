// Test E2E: simula cada rol contra cada endpoint sensible y verifica
// que NO se filtre GASTOS_DIRECCION/NOMINAS_DIRECCION/PRESTAMOS ni
// strings Raba/Buildings. Para admin/socio: sí debe verse.
//
// Ejecuta los routers de Express directamente sin levantar HTTP server
// — usa una sesión mockeada via middleware previo.

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

// Endpoints a auditar — mapa (path, expectedStatusByRole?).
// Para roles sin perm de módulo (bancos no incluye 'personal'/'pedidos';
// caja_view no incluye 'administrativo'/'personal'/'pedidos'), el endpoint
// devuelve 403 que NO es filtración — se cuenta como PASS.
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

// Detector estructural de leaks: NO uses regex sobre todo el body —
// "PRESTAMOS" aparece como texto literal en conceptos bancarios
// ("PRESTAMOS ADEUDO CUOTA N.xxx") y NO es leak. Leak real:
//   1) Una key categórica (categoria/codigo/grupo/proveedor*) que
//      contenga GASTOS_DIRECCION/NOMINAS_DIRECCION/PRESTAMOS o
//      "Gastos Dirección".
//   2) Cualquier string visible que matchee el patrón Raba.
const RABA_REGEX_TEST = /\b(?:raba|buildings?)\b/i;
const SENSITIVE_CATS = new Set(['GASTOS_DIRECCION', 'NOMINAS_DIRECCION', 'PRESTAMOS']);
const CAT_KEYS = new Set(['categoria','codigo','grupo','proveedor','proveedor_normalizado','proveedor_resuelto','nombre','clave']);

function detectLeaks(body) {
  let obj;
  try { obj = JSON.parse(body); } catch { return { raba: [], gd: [] }; }
  const hits = { raba: [], gd: [] };
  function walk(node, parentKey, path) {
    if (node == null) return;
    if (typeof node === 'string') {
      if (RABA_REGEX_TEST.test(node)) hits.raba.push({ path, sample: node.slice(0, 80) });
      if (CAT_KEYS.has(parentKey) && SENSITIVE_CATS.has(node)) hits.gd.push({ path, value: node });
      if (parentKey === 'miembros_codigos' && SENSITIVE_CATS.has(node)) hits.gd.push({ path, value: node });
      return;
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i], parentKey, path + '[' + i + ']');
      return;
    }
    if (typeof node === 'object') {
      // Si el objeto es entrada sensible y aún aparece, leak (no debería).
      if (SENSITIVE_CATS.has(node.codigo)) hits.gd.push({ path, value: 'obj.codigo=' + node.codigo });
      if (SENSITIVE_CATS.has(node.categoria)) hits.gd.push({ path, value: 'obj.categoria=' + node.categoria });
      if (node.proveedor === 'Gastos Dirección' || node.nombre === 'Gastos Dirección' || node.grupo === 'Gastos Dirección') {
        hits.gd.push({ path, value: 'Gastos Dirección as fuse name' });
      }
      for (const k of Object.keys(node)) walk(node[k], k, path + '.' + k);
    }
  }
  walk(obj, '', '');
  return hits;
}

(async () => {
  console.log('Test E2E: ' + ROLES.length + ' roles × ' + ENDPOINTS.length + ' endpoints = ' + (ROLES.length * ENDPOINTS.length) + ' calls\n');

  const matriz = {}; // role -> { endpoint -> {status, leakRaba, leakGD, gdItems, rabaTokens} }
  for (const r of ROLES) matriz[r.alias] = {};

  let totalCalls = 0, totalLeaks = 0;
  for (const r of ROLES) {
    const app = buildApp(r.role, r.email);
    for (const ep of ENDPOINTS) {
      totalCalls++;
      try {
        const { status, body } = await request(app, ep);
        const result = { status, leakRaba: false, leakGD: false };

        // Endpoints denied por perm: 401/403 — NO es leak.
        if (status === 401 || status === 403) {
          matriz[r.alias][ep] = result;
          continue;
        }
        if (status >= 400) {
          result.errorOther = body.slice(0, 80);
          matriz[r.alias][ep] = result;
          continue;
        }

        // ASSERT real: usar detector estructural (NO regex sobre todo el body
        // porque "PRESTAMOS" aparece en concepto literal y NO es leak).
        const hits = detectLeaks(body);

        if (r.esAdmin) {
          // Métricas para validar assert positivo (admin SÍ ve datos).
          result.rabaTokens = hits.raba.length;
          result.gdItems = hits.gd.length;
        } else {
          if (hits.raba.length > 0) {
            result.leakRaba = true;
            result.rabaSample = hits.raba.slice(0, 3);
            totalLeaks++;
          }
          if (hits.gd.length > 0) {
            result.leakGD = true;
            result.gdSample = hits.gd.slice(0, 3);
            totalLeaks++;
          }
        }
        matriz[r.alias][ep] = result;
      } catch (e) {
        matriz[r.alias][ep] = { status: -1, error: e.message };
      }
    }
  }

  // ─── REPORTE: matriz rol × endpoint ────────────────────────────────
  console.log('\n=== MATRIZ rol × endpoint (PASS = sin fuga / 403 / 401) ===\n');
  for (const r of ROLES) {
    console.log(`▶ ${r.alias}`);
    let nPass = 0, nFail = 0, nDenied = 0;
    for (const ep of ENDPOINTS) {
      const r2 = matriz[r.alias][ep];
      if (!r2) continue;
      const denied = r2.status === 401 || r2.status === 403;
      const ok = !r2.leakRaba && !r2.leakGD && !r2.error;
      if (denied) nDenied++;
      else if (ok) nPass++;
      else nFail++;
      if (r2.leakRaba || r2.leakGD || r2.error) {
        const tag = r2.leakRaba ? 'LEAK RABA' : r2.leakGD ? 'LEAK GD' : 'ERROR';
        const sample = r2.rabaSample || r2.gdSample || r2.error || '';
        console.log(`  ✗ ${tag.padEnd(10)} ${ep}  → ${JSON.stringify(sample)}`);
      }
    }
    console.log(`  ${nPass} pass · ${nDenied} denied (403/401) · ${nFail} fail\n`);
  }

  // ─── ASSERT positivo: admin/socio SÍ ven GD y Raba ─────────────────
  console.log('\n=== ASSERT positivo: admin/socio SÍ ven datos sensibles ===');
  for (const r of ROLES.filter((x) => x.esAdmin)) {
    const epRaba = '/api/v1/bancos/grupo-detalle?grupo=Raba%20Buildings';
    const epGD = '/api/v1/bancos/categoria-movimientos?codigo=GASTOS_DIRECCION';
    const rRaba = matriz[r.alias][epRaba];
    const rGD = matriz[r.alias][epGD];
    console.log(`▶ ${r.alias}`);
    console.log(`  ${epRaba} → status=${rRaba?.status} raba_tokens=${rRaba?.rabaTokens} ${rRaba?.rabaTokens > 0 ? '✓' : '✗ NO ve Raba!'}`);
    console.log(`  ${epGD} → status=${rGD?.status} gd_items=${rGD?.gdItems} ${rGD?.gdItems > 0 ? '✓' : '✗ NO ve GD!'}`);
  }

  console.log(`\n=== TOTAL ===`);
  console.log(`Llamadas: ${totalCalls}`);
  console.log(`Leaks no-admin (raba+GD): ${totalLeaks}`);
  process.exit(totalLeaks ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
