// Inspecciona los payloads donde se vio leak para entender por qué el
// sanitizador no los capturó.
require('dotenv').config();
const express = require('express');
const http = require('http');
const bancosRouter = require('../../routes/bancos');
const cajaRouter = require('../../routes/caja');

function buildApp(role) {
  const app = express();
  app.use((req, res, next) => {
    req.session = { user: { role, email: 'x', id:1, totp_enabled: true } };
    next();
  });
  app.use('/api/v1/bancos', bancosRouter);
  app.use('/api/v1/caja', cajaRouter);
  return app;
}
function request(app, path) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = server.address().port;
      http.get({ host: '127.0.0.1', port, path }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body }); });
      }).on('error', e => { server.close(); reject(e); });
    });
  });
}

const PATTERN = /GASTOS_DIRECCION|NOMINAS_DIRECCION|PRESTAMOS|"Gastos Dirección"|\braba\b|\bbuildings?\b/gi;

function inspectMatches(body) {
  const obj = JSON.parse(body);
  // Recorrer y reportar PATHs donde aparecen los términos sensibles.
  const hits = [];
  function walk(node, path) {
    if (node == null) return;
    if (typeof node === 'string') {
      const matches = node.match(PATTERN);
      if (matches) hits.push({ path, value: node.slice(0,140), matches });
      return;
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i], path + '[' + i + ']');
      return;
    }
    if (typeof node === 'object') {
      for (const k of Object.keys(node)) walk(node[k], path + '.' + k);
    }
  }
  walk(obj, '');
  return hits;
}

(async () => {
  const app = buildApp('gerente');
  const endpoints = [
    '/api/v1/bancos/movimientos?limit=10',
    '/api/v1/bancos/proveedores',
    '/api/v1/caja/flujo-total',
  ];
  for (const ep of endpoints) {
    console.log('\n=== ' + ep + ' ===');
    const { status, body } = await request(app, ep);
    if (status !== 200) { console.log('status=' + status); continue; }
    const hits = inspectMatches(body);
    if (!hits.length) { console.log('(no hits, raro)'); continue; }
    console.log('size=' + body.length + ' hits=' + hits.length);
    const byPath = {};
    for (const h of hits.slice(0, 25)) {
      const p = h.path.replace(/\[\d+\]/g, '[N]');
      if (!byPath[p]) byPath[p] = { count: 0, sample: h };
      byPath[p].count++;
    }
    for (const [p, info] of Object.entries(byPath)) {
      console.log('  ' + info.count + 'x ' + p + ' = ' + JSON.stringify(info.sample.value).slice(0, 160));
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
