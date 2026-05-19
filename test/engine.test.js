// Smoke test del engine — corre sin DB. node --test test/engine.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Load engine.js (es browser global) en un sandbox vm con window={}
function loadEngine() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'engine.js'), 'utf8');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window.Engine;
}

const Engine = loadEngine();

const baseConfig = {
  pctMP: 38, pctPersonal: 28, pctImpuestos: 2, pctPublicidad: 1.5, euroHora: 12,
  incluirGlovo: true, modoSociedad: false,
  poolGroups: ['A'], poolProduccion: 17530, poolEspeciales: 16440,
};

const mockLocales = [
  { id: 'ELCHE', nombre_display: 'ELCHE', short_name: 'ELCHE', grupo: 'A', dani_only: true, alquiler: 2700, suministros: 1432, fac_mi_analisis: 50000, horas_sem_override: null },
  { id: 'BENIDORM', nombre_display: 'BENIDORM', short_name: 'BENIDORM', grupo: 'A', dani_only: false, alquiler: 5242, suministros: 2536, fac_mi_analisis: 55000, horas_sem_override: null },
  { id: 'ORIHUELA', nombre_display: 'ORIHUELA', short_name: 'ORIHUELA', grupo: 'B', dani_only: false, alquiler: 1326, suministros: 895, fac_mi_analisis: 25000, horas_sem_override: null },
  { id: 'CHICKEN_THADER', nombre_display: 'CHICKEN THADER', short_name: 'CH.THADER', grupo: 'D', dani_only: false, alquiler: 1554, suministros: 666, fac_mi_analisis: 10320, horas_sem_override: null },
];

test('calcAll produces one row per local in non-sociedad mode', () => {
  const R = Engine.calcAll({ config: baseConfig, locales: mockLocales });
  assert.equal(R.length, 4);
  assert.deepEqual(R.map(r => r.id).sort(), ['BENIDORM','CHICKEN_THADER','ELCHE','ORIHUELA']);
});

test('modoSociedad excludes ELCHE (dani_only)', () => {
  const R = Engine.calcAll({ config: { ...baseConfig, modoSociedad: true }, locales: mockLocales });
  assert.equal(R.length, 3);
  assert.ok(!R.find((r) => r.id === 'ELCHE'));
});

test('ELCHE no recibe pool de producción ni especiales', () => {
  const R = Engine.calcAll({ config: baseConfig, locales: mockLocales });
  const elche = R.find((r) => r.id === 'ELCHE');
  assert.equal(elche.prod, 0);
  assert.equal(elche.esp, 0);
});

test('Grupo B fuera del pool no recibe producción', () => {
  const R = Engine.calcAll({ config: baseConfig, locales: mockLocales });
  const ori = R.find((r) => r.id === 'ORIHUELA');
  assert.equal(ori.prod, 0); // poolGroups=['A'], B fuera
});

test('Grupo B recibe producción si está en poolGroups', () => {
  const R = Engine.calcAll({ config: { ...baseConfig, poolGroups: ['A','B'] }, locales: mockLocales });
  const ori = R.find((r) => r.id === 'ORIHUELA');
  assert.ok(ori.prod > 0);
});

test('Glovo se incluye/excluye según config', () => {
  const Ron = Engine.calcAll({ config: { ...baseConfig, incluirGlovo: true }, locales: mockLocales });
  const Roff = Engine.calcAll({ config: { ...baseConfig, incluirGlovo: false }, locales: mockLocales });
  const beniOn = Ron.find((r) => r.id === 'BENIDORM');
  const beniOff = Roff.find((r) => r.id === 'BENIDORM');
  assert.ok(beniOn.glv > 0);
  assert.equal(beniOff.glv, 0);
});

test('horas_sem_override fuerza personal = horas*4.3*euroHora', () => {
  const locs = [{ ...mockLocales[1], horas_sem_override: 100 }];
  const R = Engine.calcAll({ config: baseConfig, locales: locs });
  const beni = R[0];
  assert.equal(beni.hS, 100);
  // pers = 100 * 4.3 * 12 = 5160
  assert.equal(beni.pers, 5160);
});

test('grpSum agrega correctamente', () => {
  const R = Engine.calcAll({ config: baseConfig, locales: mockLocales });
  const sA = Engine.grpSum(R, ['A']);
  assert.equal(sA.n, 2); // ELCHE + BENIDORM
  assert.equal(sA.f, 50000 + 55000);
});

test('calcElche existe sólo si dani_only existe', () => {
  const ed = Engine.calcElche({ config: baseConfig, locales: mockLocales });
  assert.ok(ed);
  assert.equal(ed.id, 'ELCHE');
  const noEd = Engine.calcElche({ config: baseConfig, locales: mockLocales.filter((l) => !l.dani_only) });
  assert.equal(noEd, null);
});

test('calcBudget usa fac_presupuestada cuando existe', () => {
  const presupuestoMap = { BENIDORM: { fac_presupuestada: 80000, fac_real: 75000 } };
  const R = Engine.calcBudget({ config: baseConfig, locales: mockLocales, h25: {}, presupuestoMap }, 4);
  const beni = R.find((r) => r.id === 'BENIDORM');
  assert.equal(beni.fac, 80000);
  assert.equal(beni.real, 75000);
  assert.equal(beni.presBase, 80000);
});

test('calcBudget fallback a h25 cuando no hay presupuesto', () => {
  const h25 = { ORIHUELA: [10000,11000,12000,13000,14000,15000,16000,17000,18000,19000,20000,21000] };
  const R = Engine.calcBudget({ config: baseConfig, locales: mockLocales, h25, presupuestoMap: {} }, 4);
  const ori = R.find((r) => r.id === 'ORIHUELA');
  assert.equal(ori.fac, 14000); // mes 5 = idx 4
});

test('Margen % positivo viable', () => {
  const R = Engine.calcAll({ config: baseConfig, locales: mockLocales });
  for (const r of R) {
    // suma de costos parciales = tG
    const sum = r.mp + r.pers + r.imp + r.pub + r.alq + r.sum + r.glv + r.prod + r.esp;
    assert.ok(Math.abs(sum - r.tG) < 0.01, `${r.id} suma de costos != tG`);
    assert.equal(r.mg, r.fac - r.tG);
  }
});
