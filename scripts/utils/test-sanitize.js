// Unit tests del sanitizador centralizado.
const {
  RABA_REGEX, RABA_MASK, SENSITIVE_CATEGORIES,
  matchesRaba, maskRabaString, sanitizeForNonAdmin, esAdminLike,
  objEsEntradaSensible,
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

console.log('\n=== objEsEntradaSensible ===');
t('{codigo:"GASTOS_DIRECCION"}',     objEsEntradaSensible({codigo:'GASTOS_DIRECCION', total:1000}));
t('{categoria:"NOMINAS_DIRECCION"}', objEsEntradaSensible({categoria:'NOMINAS_DIRECCION'}));
t('{categoria:"PRESTAMOS"}',         objEsEntradaSensible({categoria:'PRESTAMOS'}));
t('{proveedor_normalizado:"Raba Buildings"}', objEsEntradaSensible({proveedor_normalizado:'Raba Buildings'}));
t('{proveedor:"Gastos Dirección"}',  objEsEntradaSensible({proveedor:'Gastos Dirección'}));
t('NO toca {codigo:"NOMINAS"}',      !objEsEntradaSensible({codigo:'NOMINAS'}));
t('NO toca {categoria:"PROVEEDOR_CARNES"}', !objEsEntradaSensible({categoria:'PROVEEDOR_CARNES'}));

console.log('\n=== sanitizeForNonAdmin: payload típico /proveedores ===');
const payload = {
  por_categoria: [
    { codigo:'PROVEEDOR_CARNES', total: 50000, proveedores: ['Carnicas Mulas SL'] },
    { codigo:'GASTOS_DIRECCION', total: 100000, proveedores: ['Raba Buildings'] },
    { codigo:'NOMINAS_DIRECCION', total: 30000 },
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
t('por_categoria solo PROVEEDOR_CARNES + ALQUILER (2 items)',
  payload.por_categoria.length === 2,
  'got ' + payload.por_categoria.length + ' items: ' + JSON.stringify(payload.por_categoria.map(c=>c.codigo)));
t('movimientos quita los GASTOS_DIRECCION (queda 2)',
  payload.movimientos.length === 2,
  'got ' + payload.movimientos.length);
t('PAGO TRABAJADAS NO enmascarado',
  payload.movimientos.find(m=>m.id===4)?.concepto === 'PAGO HS TRABAJADAS');
t('por_categoria.proveedores no contiene "Raba"',
  !JSON.stringify(payload.por_categoria).match(/raba|buildings/i));

console.log('\n=== sanitizeForNonAdmin: shape /movimientos plano ===');
const movs = [
  { id:1, concepto:'TRANSFERENCIA A Raba Buildings SL', categoria:'GASTOS_DIRECCION', importe:-400, proveedor_normalizado:'Raba Buildings' },
  { id:2, concepto:'CARNICAS MULAS factura', categoria:'PROVEEDOR_CARNES', importe:-500 },
];
sanitizeForNonAdmin(movs);
t('Array filtra row GASTOS_DIRECCION', movs.length === 1);
t('Row sobreviviente NO contiene "raba"', !JSON.stringify(movs).match(/raba|buildings/i));

console.log('\n=== sanitizeForNonAdmin: defense in depth (row escapó del filtro categoria) ===');
const escaped = [
  // Imagina que un endpoint nuevo se olvidó del filtro y devuelve esto:
  { id:99, concepto:'Traspaso Raba Buildings Sl', categoria:'OTROS', importe:-1000 },
];
sanitizeForNonAdmin(escaped);
t('concepto enmascarado a RABA_MASK',
  escaped[0]?.concepto === RABA_MASK,
  'got "' + escaped[0]?.concepto + '"');

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
