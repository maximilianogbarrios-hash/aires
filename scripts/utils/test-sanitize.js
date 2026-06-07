// Unit tests del sanitizador centralizado.
const {
  RABA_REGEX, RABA_MASK, SENSITIVE_CATEGORIES,
  matchesRaba, maskRabaString, sanitizeForNonAdmin, esAdminLike,
  esMovimientoIndividual, objEsEntradaSensible,
  esAgregadoSensible,
} = require('../../lib/access/sanitize');

let pass = 0, fail = 0;
function t(name, ok, detail) {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

console.log('=== matchesRaba: positivos (debe matchear) ===');
t('"Raba Buildings"',           matchesRaba('Raba Buildings'));
t('"raba buildings"',           matchesRaba('raba buildings'));
t('"RABA BUILDINGS SL"',        matchesRaba('RABA BUILDINGS SL'));
t('"Raba Building Sl" (singular)', matchesRaba('Raba Building Sl'));
t('"... A Raba Buildings Sl"',  matchesRaba('Traspaso: Aportacion/ Prestamo Aires Murcia Sl A Raba Buildings Sl'));
t('"TRANSFERENCIA A RABA BUILDINGS SL"', matchesRaba('TRANSFERENCIA A RABA BUILDINGS SL'));
t('"Raba"',                     matchesRaba('Raba'));
t('"Buildings"',                matchesRaba('Buildings'));
t('"buildings"',                matchesRaba('buildings'));

console.log('\n=== matchesRaba: negativos (NO debe matchear — false positives) ===');
t('"TRABAJO"',                  !matchesRaba('TRABAJO'));
t('"TRABAJADAS"',               !matchesRaba('TRABAJADAS'));
t('"PAGO HS TRABAJADAS MARKETING AGUSTIN"', !matchesRaba('PAGO HS TRABAJADAS MARKETING AGUSTIN'));
t('"PAGO SEMANA TRABAJO MADERO"', !matchesRaba('PAGO SEMANA TRABAJO MADERO'));
t('"HAS TRABAJADAS PABLO FLORES"', !matchesRaba('HAS TRABAJADAS PABLO FLORES'));
t('"pago 30 mariam por trabajo"', !matchesRaba('pago 30 mariam por trabajo'));
t('"trabajo"',                  !matchesRaba('trabajo'));
t('"trabajadas"',               !matchesRaba('trabajadas'));
t('"sobraba"',                  !matchesRaba('sobraba'));
t('"" (vacío)',                 !matchesRaba(''));
t('null',                       !matchesRaba(null));

console.log('\n=== maskRabaString ===');
t('reemplaza "Raba Buildings SL" → RABA_MASK',
  maskRabaString('Raba Buildings SL') === RABA_MASK);
t('NO toca "PAGO TRABAJO MADERO"',
  maskRabaString('PAGO TRABAJO MADERO') === 'PAGO TRABAJO MADERO');
t('reemplaza "Traspaso: ... A Raba Buildings Sl"',
  maskRabaString('Traspaso: Aportacion/ Prestamo Aires Murcia Sl A Raba Buildings Sl') === RABA_MASK);

console.log('\n=== esMovimientoIndividual ===');
t('{id,fecha,concepto,importe} → mov',
  esMovimientoIndividual({id:1, fecha:'2026-01-01', concepto:'X', importe:-100}));
t('{subtipo,monto} → mov',
  esMovimientoIndividual({subtipo:'CIERRE', monto:200}));
t('{codigo,total} → agregado (NO mov)',
  !esMovimientoIndividual({codigo:'GASTOS_DIRECCION', total:1000}));
t('{categoria:"X", total:100} → agregado (NO mov)',
  !esMovimientoIndividual({categoria:'PROVEEDOR_CARNES', total:100, n_movs:5}));

console.log('\n=== objEsEntradaSensible: filtra SOLO movs individuales sensibles ===');
t('mov individual GASTOS_DIRECCION → filtrar',
  objEsEntradaSensible({id:1, fecha:'2026-01-01', concepto:'X', categoria:'GASTOS_DIRECCION', importe:-100}));
t('mov individual NOMINAS_DIRECCION → filtrar',
  objEsEntradaSensible({id:1, concepto:'Z', categoria:'NOMINAS_DIRECCION', importe:-150}));
t('mov individual PRESTAMOS → NO filtrar (PRESTAMOS desbloqueado)',
  !objEsEntradaSensible({id:2, concepto:'Préstamo bancario', categoria:'PRESTAMOS', importe:-200}));
t('mov individual proveedor=FUSE → filtrar',
  objEsEntradaSensible({id:3, concepto:'X', proveedor:'Gastos Dirección', importe:-100}));
t('mov individual Raba → filtrar',
  objEsEntradaSensible({id:4, concepto:'TRANSFERENCIA A RABA BUILDINGS SL', proveedor_normalizado:'Raba Buildings', importe:-100}));
t('mov individual NORMAL → NO filtrar',
  !objEsEntradaSensible({id:5, concepto:'Carnicas Mulas factura', categoria:'PROVEEDOR_CARNES', importe:-500}));
t('AGREGADO {codigo:GASTOS_DIRECCION,total} → NO filtrar (queda visible)',
  !objEsEntradaSensible({codigo:'GASTOS_DIRECCION', total:100000, n_movs:50}));
t('AGREGADO {codigo:NOMINAS_DIRECCION,total} → NO filtrar',
  !objEsEntradaSensible({codigo:'NOMINAS_DIRECCION', total:30000}));
t('AGREGADO {categoria:PRESTAMOS,total} → NO filtrar',
  !objEsEntradaSensible({categoria:'PRESTAMOS', total:30000}));

console.log('\n=== esAgregadoSensible ===');
t('{codigo:"GASTOS_DIRECCION",total} → SÍ',
  esAgregadoSensible({codigo:'GASTOS_DIRECCION', total:100000}));
t('{codigo:"NOMINAS_DIRECCION",total} → SÍ',
  esAgregadoSensible({codigo:'NOMINAS_DIRECCION', total:30000}));
t('{nombre:"Gastos Dirección",total} → SÍ',
  esAgregadoSensible({nombre:'Gastos Dirección', total:100000}));
t('mov individual GD → NO (es mov, no agregado)',
  !esAgregadoSensible({id:1, concepto:'X', categoria:'GASTOS_DIRECCION', importe:-100}));
t('{codigo:"PRESTAMOS",total} → NO (PRESTAMOS desbloqueado)',
  !esAgregadoSensible({codigo:'PRESTAMOS', total:30000}));
t('{codigo:"NOMINAS",total} → NO',
  !esAgregadoSensible({codigo:'NOMINAS', total:100}));

console.log('\n=== sanitizeForNonAdmin v2: AGREGADO de GD se MANTIENE ===');
const payload = {
  por_categoria: [
    { codigo:'PROVEEDOR_CARNES', total: 50000, proveedores: ['Carnicas Mulas SL'] },
    { codigo:'GASTOS_DIRECCION', total: 100000, proveedores: ['Raba Buildings', 'Honorarios X'],
      top_proveedores: [{nombre:'Raba Buildings', total:50000}], n_movs: 25 },
    { codigo:'NOMINAS_DIRECCION', total: 30000, proveedores:['Nominas Dir'] },
    { codigo:'ALQUILER', total: 25000 },
  ],
  movimientos: [
    { id:1, concepto:'Carnicas Mulas factura', categoria:'PROVEEDOR_CARNES', importe:-500 },
    { id:2, concepto:'Traspaso: Prestamo Grupo Hostelero Sl A Raba Buildings Sl', categoria:'GASTOS_DIRECCION', importe:-3000 },
    { id:3, concepto:'TRANSFERENCIA A RABA BUILDINGS SL', categoria:'GASTOS_DIRECCION', importe:-400 },
    { id:4, concepto:'PAGO HS TRABAJADAS', categoria:'NOMINAS', importe:-200 },
  ],
  total_general: 205000,
};
sanitizeForNonAdmin(payload);

t('por_categoria SIGUE con los 4 items (GD no se elimina)',
  payload.por_categoria.length === 4,
  'got ' + payload.por_categoria.length + ': ' + JSON.stringify(payload.por_categoria.map(c=>c.codigo)));
const gd = payload.por_categoria.find(c=>c.codigo==='GASTOS_DIRECCION');
t('agregado GD mantiene total=100000', gd?.total === 100000);
t('agregado GD mantiene n_movs=25', gd?.n_movs === 25);
t('agregado GD vacía proveedores[]',
  Array.isArray(gd?.proveedores) && gd.proveedores.length === 0);
t('agregado GD vacía top_proveedores[]',
  Array.isArray(gd?.top_proveedores) && gd.top_proveedores.length === 0);
t('agregado GD marca puede_drilldown=false',
  gd?.puede_drilldown === false);
const nomDir = payload.por_categoria.find(c=>c.codigo==='NOMINAS_DIRECCION');
t('agregado NOMINAS_DIRECCION mantiene total=30000', nomDir?.total === 30000);
t('agregado NOMINAS_DIRECCION vacía proveedores[]',
  Array.isArray(nomDir?.proveedores) && nomDir.proveedores.length === 0);

t('movimientos: quita rows con categoria GD (queda 2)',
  payload.movimientos.length === 2,
  'got ' + payload.movimientos.length);
t('PAGO TRABAJADAS NO enmascarado',
  payload.movimientos.find(m=>m.id===4)?.concepto === 'PAGO HS TRABAJADAS');

console.log('\n=== sanitizeForNonAdmin: shape /movimientos plano ===');
const movs = [
  { id:1, concepto:'TRANSFERENCIA A Raba Buildings SL', categoria:'GASTOS_DIRECCION', importe:-400, proveedor_normalizado:'Raba Buildings' },
  { id:2, concepto:'CARNICAS MULAS factura', categoria:'PROVEEDOR_CARNES', importe:-500 },
];
sanitizeForNonAdmin(movs);
t('Array filtra row GASTOS_DIRECCION', movs.length === 1);
t('Row sobreviviente NO contiene "raba"', !JSON.stringify(movs).match(/raba|buildings/i));

console.log('\n=== sanitizeForNonAdmin: defense in depth (row escapó del filtro) ===');
const escaped = [
  { id:99, concepto:'Traspaso Raba Buildings Sl', categoria:'OTROS', importe:-1000 },
];
sanitizeForNonAdmin(escaped);
t('concepto enmascarado a RABA_MASK',
  escaped[0]?.concepto === RABA_MASK,
  'got "' + escaped[0]?.concepto + '"');

console.log('\n=== sanitizeForNonAdmin: total general y % coinciden con admin ===');
// Simulamos que admin recibió este payload; el no-admin debe ver el MISMO
// total general y el mismo % por categoría (los totales se mantienen).
const adminPayload = {
  por_categoria: [
    { codigo:'PROVEEDOR_CARNES', total: 50000, pct: 0.40 },
    { codigo:'GASTOS_DIRECCION', total: 50000, pct: 0.40 },
    { codigo:'ALQUILER', total: 25000, pct: 0.20 },
  ],
  total: 125000,
};
const noAdminPayload = JSON.parse(JSON.stringify(adminPayload));
sanitizeForNonAdmin(noAdminPayload);
t('total general INTACTO', noAdminPayload.total === adminPayload.total);
const adminGd = adminPayload.por_categoria.find(c=>c.codigo==='GASTOS_DIRECCION');
const noAdminGd = noAdminPayload.por_categoria.find(c=>c.codigo==='GASTOS_DIRECCION');
t('agregado GD total IDÉNTICO entre admin y no-admin',
  adminGd.total === noAdminGd?.total);
t('agregado GD % IDÉNTICO entre admin y no-admin',
  adminGd.pct === noAdminGd?.pct);

console.log('\n=== Matriz AGREGADO vs DETALLE con shape REAL del donut caja ===');
// Réplica exacta del payload que devuelve routes/caja.js#donut-categorias.
// El no-admin debe ver:
//   · GASTOS_DIRECCION presente con total_egreso/pct intactos (sin detalle)
//   · NOMINAS_DIRECCION presente con total_egreso/pct intactos (sin detalle)
//   · PRESTAMOS presente con TODO intacto (agregado + detalle)
const donutReal = {
  filtros: { sociedad_id: null, fuente: 'todo' },
  kpis: {
    gasto_total: 100000, gasto_banco: 60000, gasto_caja: 40000,
    ingreso_total: 120000, neto: 20000, n_movs: 500,
  },
  categorias: [
    { codigo:'PROVEEDOR_CARNES', nombre_display:'Proveedor Carnes', total_egreso:30000, banco_egreso:30000, efectivo_egreso:0, n_movs:50, pct_sobre_gasto:30 },
    { codigo:'GASTOS_DIRECCION', nombre_display:'Gastos Dirección', total_egreso:25000, banco_egreso:15000, efectivo_egreso:10000, n_movs:40, pct_sobre_gasto:25, n_proveedores:5 },
    { codigo:'NOMINAS_DIRECCION', nombre_display:'Nóminas Dirección', total_egreso:15000, banco_egreso:15000, efectivo_egreso:0, n_movs:12, pct_sobre_gasto:15, n_proveedores:2 },
    { codigo:'PRESTAMOS', nombre_display:'Préstamos', total_egreso:20000, banco_egreso:20000, efectivo_egreso:0, n_movs:8, pct_sobre_gasto:20, n_proveedores:1 },
    { codigo:'ALQUILER', nombre_display:'Alquiler', total_egreso:10000, banco_egreso:10000, efectivo_egreso:0, n_movs:6, pct_sobre_gasto:10 },
  ],
};
const adminCopy = JSON.parse(JSON.stringify(donutReal));
const noAdminCopy = JSON.parse(JSON.stringify(donutReal));
sanitizeForNonAdmin(noAdminCopy);

t('AGREGADO — todas las 5 categorías SIGUEN presentes',
  noAdminCopy.categorias.length === 5,
  'got ' + noAdminCopy.categorias.length + ': ' + JSON.stringify(noAdminCopy.categorias.map(c=>c.codigo)));
const naGd = noAdminCopy.categorias.find(c=>c.codigo==='GASTOS_DIRECCION');
const naNd = noAdminCopy.categorias.find(c=>c.codigo==='NOMINAS_DIRECCION');
const naPr = noAdminCopy.categorias.find(c=>c.codigo==='PRESTAMOS');
t('GASTOS_DIRECCION presente para no-admin', !!naGd);
t('NOMINAS_DIRECCION presente para no-admin', !!naNd);
t('PRESTAMOS presente para no-admin', !!naPr);
t('GD total_egreso IDÉNTICO admin↔no-admin (25000)',
  adminCopy.categorias.find(c=>c.codigo==='GASTOS_DIRECCION').total_egreso === naGd?.total_egreso);
t('GD pct_sobre_gasto IDÉNTICO (25%)',
  adminCopy.categorias.find(c=>c.codigo==='GASTOS_DIRECCION').pct_sobre_gasto === naGd?.pct_sobre_gasto);
t('NOMINAS_DIRECCION total_egreso IDÉNTICO (15000)',
  adminCopy.categorias.find(c=>c.codigo==='NOMINAS_DIRECCION').total_egreso === naNd?.total_egreso);
t('PRESTAMOS total_egreso IDÉNTICO (20000)',
  adminCopy.categorias.find(c=>c.codigo==='PRESTAMOS').total_egreso === naPr?.total_egreso);
t('PRESTAMOS n_proveedores INTACTO (no se vacía)',
  adminCopy.categorias.find(c=>c.codigo==='PRESTAMOS').n_proveedores === naPr?.n_proveedores);
t('KPIs (gasto_total, etc.) INTACTOS',
  noAdminCopy.kpis.gasto_total === adminCopy.kpis.gasto_total
  && noAdminCopy.kpis.gasto_banco === adminCopy.kpis.gasto_banco);

console.log('\n=== Matriz DETALLE: drill-down de cada categoría ===');
// Caso GD: drill-down con proveedores y movimientos individuales.
const drillGd = {
  codigo:'GASTOS_DIRECCION', total_egreso:25000,
  proveedores: [{nombre:'Raba Buildings', total:15000}, {nombre:'Honorarios X', total:10000}],
  movimientos: [
    { id:1, fecha:'2026-05-01', concepto:'Pago Raba Buildings', categoria:'GASTOS_DIRECCION', importe:-5000 },
    { id:2, fecha:'2026-05-02', concepto:'Honorarios X', categoria:'GASTOS_DIRECCION', importe:-3000 },
  ],
};
sanitizeForNonAdmin(drillGd);
t('GD drill: proveedores[] VACÍO', Array.isArray(drillGd.proveedores) && drillGd.proveedores.length === 0);
t('GD drill: movimientos[] VACÍO', Array.isArray(drillGd.movimientos) && drillGd.movimientos.length === 0);
t('GD drill: puede_drilldown=false', drillGd.puede_drilldown === false);
t('GD drill: total_egreso conservado',  drillGd.total_egreso === 25000);

// Caso NOMINAS_DIRECCION: idem GD.
const drillNd = {
  codigo:'NOMINAS_DIRECCION', total_egreso:15000,
  proveedores:[{nombre:'Sueldos Dirección', total:15000}],
  movimientos:[{id:11, concepto:'Sueldo Dani', categoria:'NOMINAS_DIRECCION', importe:-7500}],
};
sanitizeForNonAdmin(drillNd);
t('NOMINAS_DIRECCION drill: proveedores[] VACÍO', drillNd.proveedores.length === 0);
t('NOMINAS_DIRECCION drill: movimientos[] VACÍO', drillNd.movimientos.length === 0);

// Caso PRESTAMOS: TODO debe sobrevivir intacto.
const drillPr = {
  codigo:'PRESTAMOS', total_egreso:20000,
  proveedores:[{nombre:'Banco Santander', total:20000}],
  movimientos:[
    { id:21, fecha:'2026-04-15', concepto:'Cuota préstamo Santander', categoria:'PRESTAMOS', importe:-8000 },
    { id:22, fecha:'2026-05-15', concepto:'Cuota préstamo Santander', categoria:'PRESTAMOS', importe:-8000 },
  ],
};
sanitizeForNonAdmin(drillPr);
t('PRESTAMOS drill: proveedores INTACTOS (1)', drillPr.proveedores.length === 1);
t('PRESTAMOS drill: movimientos INTACTOS (2)', drillPr.movimientos.length === 2);
t('PRESTAMOS drill: puede_drilldown NO se setea a false',
  drillPr.puede_drilldown !== false);
t('PRESTAMOS drill: concepto NO modificado',
  drillPr.movimientos[0].concepto === 'Cuota préstamo Santander');

console.log('\n=== Defense in depth: Raba en categoría no-sensible se enmascara ===');
const escapeNoCat = [
  { id:99, concepto:'Pago a Raba Buildings SL', categoria:'PRESTAMOS', importe:-1000 },
];
sanitizeForNonAdmin(escapeNoCat);
t('Row PRESTAMOS sigue presente (NO se filtra)', escapeNoCat.length === 1);
t('Pero el concepto Raba SE enmascara',
  escapeNoCat[0]?.concepto === RABA_MASK,
  'got "' + escapeNoCat[0]?.concepto + '"');

console.log('\n=== Set SENSITIVE_CATEGORIES correcto ===');
t('GASTOS_DIRECCION sensible', SENSITIVE_CATEGORIES.has('GASTOS_DIRECCION'));
t('NOMINAS_DIRECCION sensible', SENSITIVE_CATEGORIES.has('NOMINAS_DIRECCION'));
t('PRESTAMOS NO sensible', !SENSITIVE_CATEGORIES.has('PRESTAMOS'));
t('Set tiene exactamente 2 elementos', SENSITIVE_CATEGORIES.size === 2);

console.log('\n=== esAdminLike ===');
t('admin',          esAdminLike({session:{user:{role:'admin'}}}));
t('socio',          esAdminLike({session:{user:{role:'socio'}}}));
t('gerente NO',     !esAdminLike({session:{user:{role:'gerente'}}}));
t('personal NO',    !esAdminLike({session:{user:{role:'personal'}}}));
t('administrativo NO', !esAdminLike({session:{user:{role:'administrativo'}}}));
t('pedidos NO',     !esAdminLike({session:{user:{role:'pedidos'}}}));
t('sin sesión NO',  !esAdminLike({}));

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
