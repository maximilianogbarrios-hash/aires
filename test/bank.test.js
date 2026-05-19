// Tests del módulo bancario (parser + categorizer + sociedades).
// node --test test/bank.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');

const { categorizar, detectarLocal, extraerSubcategoria } = require('../lib/bank/categorizer');
const { sociedadDeLocal, SOCIEDADES, findSociedad } = require('../lib/bank/sociedades');
const { parseSantanderBuffer, toIsoDate, toNumber, hashRow } = require('../lib/bank/parser-santander');
const { parseGetnetBuffer, columnMap } = require('../lib/bank/parser-getnet');

// ─── categorizer ───────────────────────────────────────────────────────
test('categorizar: GLOVO ingreso positivo', () => {
  assert.equal(categorizar('TRANSFERENCIA GLOVO 12345', 5000), 'INGRESO_GLOVO');
});
test('categorizar: carnicas mulas como gasto', () => {
  assert.equal(categorizar('PAGO CARNICAS MULAS SL', -1200), 'GASTO_CARNICAS');
});
test('categorizar: signo opuesto cae a OTROS', () => {
  // "glovo" pero importe negativo → no es ingreso real
  assert.equal(categorizar('DEVOLUCION GLOVO -5', -100), 'GASTO_OTROS');
  // "endesa" pero importe positivo (refund) → no es gasto
  assert.equal(categorizar('DEVOLUCION ENDESA', 50), 'INGRESO_OTROS');
});
test('categorizar: fallback', () => {
  assert.equal(categorizar('ALGO RARO DESCONOCIDO', 100), 'INGRESO_OTROS');
  assert.equal(categorizar('ALGO RARO DESCONOCIDO', -100), 'GASTO_OTROS');
});
test('categorizar: case-insensitive', () => {
  assert.equal(categorizar('TRANSFERENCIA BIZUM', 80), 'INGRESO_BIZUM');
  assert.equal(categorizar('bizum recibido', 80), 'INGRESO_BIZUM');
});

// ─── detectarLocal ─────────────────────────────────────────────────────
test('detectarLocal: por concepto liquidación TPV', () => {
  assert.equal(detectarLocal('LIQUIDACION TPV ALICANTE CALLE PINTOR'), 'ALICANTE');
  assert.equal(detectarLocal('LIQUIDACION TPV ELCHE TRONETA'), 'ELCHE');
  assert.equal(detectarLocal('LIQUIDACION TPV BENIDORM EUROPA 9'), 'BENIDORM');
  assert.equal(detectarLocal('LIQUIDACION CHIKEN UNCLES'), 'CHICKEN_UNCLES');
  assert.equal(detectarLocal('LIQUIDACION SAN VICEN'), 'SAN_VICENTE');
  assert.equal(detectarLocal('LIQUIDACION SMART AIRES'), 'SANTO_DOMINGO');
  assert.equal(detectarLocal(''), null);
  assert.equal(detectarLocal('LIQUIDACION DESCONOCIDA'), null);
});

// ─── sociedades ────────────────────────────────────────────────────────
test('sociedades: mapeo local→sociedad', () => {
  assert.equal(sociedadDeLocal('ELCHE'), 'hostelero');
  assert.equal(sociedadDeLocal('ALICANTE'), 'alicante');
  assert.equal(sociedadDeLocal('BENIDORM'), 'benidorm');
  assert.equal(sociedadDeLocal('THADER'), 'murcia');
  assert.equal(sociedadDeLocal('SANTA_POLA'), 'smart');
  assert.equal(sociedadDeLocal('XX_INEXISTENTE'), null);
});
test('sociedades: las 5 esperadas con CIF', () => {
  assert.equal(SOCIEDADES.length, 5);
  for (const s of SOCIEDADES) {
    assert.ok(s.id && s.cif && s.locales.length > 0);
  }
});
test('sociedades: findSociedad', () => {
  assert.equal(findSociedad('alicante').cif, 'B44897973');
  assert.equal(findSociedad('inexistente'), null);
});

// ─── parser helpers ────────────────────────────────────────────────────
test('toIsoDate: formatos varios', () => {
  assert.equal(toIsoDate('12/06/2025'), '2025-06-12');
  assert.equal(toIsoDate('1/1/2025'),   '2025-01-01');
  assert.equal(toIsoDate('2025-06-12'), '2025-06-12');
  assert.equal(toIsoDate(new Date(2025, 5, 12)), '2025-06-12');
  assert.equal(toIsoDate(null), null);
  assert.equal(toIsoDate(''), null);
});
test('toNumber: formato europeo', () => {
  assert.equal(toNumber('1.234,56'), 1234.56);
  assert.equal(toNumber('-1.234,56'), -1234.56);
  assert.equal(toNumber('1234.56'), 1234.56);
  assert.equal(toNumber(1234.56), 1234.56);
  assert.equal(toNumber(null), null);
});
test('hashRow: determinístico', () => {
  const a = hashRow({ sociedad_id: 'alicante', fecha: '2025-06-01', concepto: 'GLOVO', importe: 100, codigo_banco: '071', num_documento: 'X1' });
  const b = hashRow({ sociedad_id: 'alicante', fecha: '2025-06-01', concepto: 'GLOVO', importe: 100, codigo_banco: '071', num_documento: 'X1' });
  assert.equal(a, b);
  const c = hashRow({ sociedad_id: 'alicante', fecha: '2025-06-01', concepto: 'GLOVO', importe: 101, codigo_banco: '071', num_documento: 'X1' });
  assert.notEqual(a, c);
});

// ─── parser Santander end-to-end con XLS sintético ─────────────────────
function buildSantanderXlsBuffer() {
  const rows = [
    ['EXTRACTO BANCARIO'],                                            // row 1
    [],
    ['Titular', 'Aires Alicante SL'],
    [],
    [],
    ['Cuenta', 'ES00 0000 0000 0000 0000 0000'],
    ['Movimientos Fecha desde 01/06/2025 hasta 30/06/2025'],
    ['Fecha Operación', 'Fecha Valor', 'Concepto', 'Importe',
     'Divisa', 'Saldo', 'Divisa', 'Código', 'Nº Documento'],         // row 8 = headers
    ['02/06/2025', '02/06/2025', 'LIQUIDACION TPV ALICANTE', 1234.56,
     'EUR', 9999.99, 'EUR', '135', 'DOC1'],
    ['05/06/2025', '05/06/2025', 'TRANSFERENCIA GLOVO 0001', 5500.00,
     'EUR', 11000.0, 'EUR', '071', 'DOC2'],
    ['10/06/2025', '10/06/2025', 'PAGO CARNICAS MULAS SL', -1200.00,
     'EUR', 9800.0, 'EUR', '174', 'DOC3'],
    ['15/06/2025', '15/06/2025', 'ENDESA FACTURA LUZ', -345.67,
     'EUR', 9454.33, 'EUR', '174', 'DOC4'],
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Movimientos');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

test('parseSantanderBuffer: end-to-end', () => {
  const buf = buildSantanderXlsBuffer();
  const out = parseSantanderBuffer(buf, { sociedad_id: 'alicante' });
  assert.equal(out.header_found, true);
  assert.equal(out.movimientos.length, 4);

  const [tpv, glovo, carn, luz] = out.movimientos;
  assert.equal(tpv.fecha, '2025-06-02');
  assert.equal(tpv.codigo_banco, '135');
  assert.equal(tpv.local_id, 'ALICANTE');
  assert.equal(tpv.importe, 1234.56);
  assert.equal(tpv.periodo, '2025-06');

  assert.equal(glovo.categoria, 'INGRESO_GLOVO');
  assert.equal(carn.categoria, 'GASTO_CARNICAS');
  assert.equal(luz.categoria, 'GASTO_LUZ');

  // Hashes únicos
  const hashes = new Set(out.movimientos.map((m) => m.hash));
  assert.equal(hashes.size, 4);
});

test('parseSantanderBuffer: sin headers devuelve vacío', () => {
  const rows = [['JUNK ROW']];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'X');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const out = parseSantanderBuffer(buf, { sociedad_id: 'alicante' });
  assert.equal(out.header_found, false);
});

// ─── parser Getnet ─────────────────────────────────────────────────────
function buildGetnetXlsBuffer({ comercioName = 'BURGER ALICANTE SL' } = {}) {
  const rows = [
    ['Informe de cierre TPV'],
    [],
    ['Comercio', comercioName],
    [],
    [],
    [],
    [],
    [],
    ['Fecha de cierre', 'Hora', 'Terminal', 'Banco', 'Cuenta',
     'Pos', 'Empresa', 'Vendor',
     'Núm. Ventas', 'Núm. Devoluc',
     'Forma pago', 'Divisa',
     'Importe Neto', 'Divisa',
     'Importe Bruto', 'Divisa'],
    ['01/06/2025', '23:59', 'T1', 'Getnet', 'CC',
     'POS1', 'EMP', 'V1', 100, 2, 'Tarjeta', 'EUR', 994.76, 'EUR', 1000.00, 'EUR'],
    ['02/06/2025', '23:59', 'T1', 'Getnet', 'CC',
     'POS1', 'EMP', 'V1', 120, 1, 'Tarjeta', 'EUR', 1989.52, 'EUR', 2000.00, 'EUR'],
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Cierres');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

test('parseGetnetBuffer: end-to-end con detección', () => {
  const buf = buildGetnetXlsBuffer();
  const out = parseGetnetBuffer(buf);
  assert.equal(out.header_found, true);
  assert.equal(out.comercio_detectado, 'BURGER ALICANTE SL');
  assert.equal(out.local_id, 'ALICANTE');
  assert.equal(out.sociedad_id, 'alicante');
  assert.equal(out.cierres.length, 2);

  const c0 = out.cierres[0];
  assert.equal(c0.fecha_cierre, '2025-06-01');
  assert.equal(c0.importe_bruto, 1000);
  assert.equal(c0.importe_neto, 994.76);
  assert.ok(c0.tasa_comision > 0.005 && c0.tasa_comision < 0.006);
  assert.equal(c0.periodo, '2025-06');
});

test('parseGetnetBuffer: local_id_override', () => {
  const buf = buildGetnetXlsBuffer({ comercioName: 'COMERCIO DESCONOCIDO' });
  const out = parseGetnetBuffer(buf, { local_id_override: 'BENIDORM' });
  assert.equal(out.local_id, 'BENIDORM');
  assert.equal(out.sociedad_id, 'benidorm');
});
