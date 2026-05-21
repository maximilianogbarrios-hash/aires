// Ronda 5 (2026-05-21): aplica las 10 correcciones de categorización
// solicitadas: Dialque/Campoluz/Entrepinares/TGT → Lácteos, Sueldos
// Dirección → NOMINAS_DIRECCION, Equipamiento → EQUIPAMIENTO,
// Préstamos → PRESTAMOS, Radius/Arrolas, fix Carnicas Mulas, etc.
//
// Flujo:
//   1. INSERT en ab_reglas_normalizacion (cada regla con su prioridad).
//   2. UPDATE retroactivo en ab_movimientos según cada regla, respetando:
//      - INTRAGRUPO NO se sobrescribe nunca (protección de traspasos).
//      - Reglas con AND/NOT extra (ej. TGT excluye Dialque) usan SQL directo.
//   3. Recalc de ab_resumen_mensual para las (sociedad, periodo) afectadas.
//   4. Reporta totales y casos dudosos.
//
// Uso: node scripts/utils/ronda5-recategorizar.js [--dry-run]

require('dotenv').config();
const { Pool } = require('pg');
const { recalcResumenMensual } = require('../../lib/bank/db');

const DRY = process.argv.includes('--dry-run');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// patron, tipo_match, categoria, proveedor_normalizado, prioridad, [where SQL adicional para el UPDATE retroactivo]
// El campo `extraWhere` cubre casos como "TGT excluye Dialque" que la
// regla DB sola no expresa (matchRegla es ilike puro). En el upload
// futuro Dialque (prioridad igual pero inserta antes) gana porque su
// pattern matchea primero en `matchRegla`.
const REGLAS = [
  // Punto 2 — Sueldos Dirección (prioridad alta para que no caigan en NOMINAS).
  { patron: 'maximiliano g barrios',     tipo: 'ilike', cat: 'NOMINAS_DIRECCION', prov: 'Sueldos Dirección', prio: 120 },
  { patron: 'maximiliano barrios',       tipo: 'ilike', cat: 'NOMINAS_DIRECCION', prov: 'Sueldos Dirección', prio: 120 },
  { patron: 'maximiliano gaston barrios',tipo: 'ilike', cat: 'NOMINAS_DIRECCION', prov: 'Sueldos Dirección', prio: 120 },
  { patron: 'daniel romero',             tipo: 'ilike', cat: 'NOMINAS_DIRECCION', prov: 'Sueldos Dirección', prio: 120 },
  { patron: 'daniel oscar romero',       tipo: 'ilike', cat: 'NOMINAS_DIRECCION', prov: 'Sueldos Dirección', prio: 120 },
  { patron: 'yanina barrios',            tipo: 'ilike', cat: 'NOMINAS_DIRECCION', prov: 'Sueldos Dirección', prio: 120 },
  { patron: 'yanina paola barrios',      tipo: 'ilike', cat: 'NOMINAS_DIRECCION', prov: 'Sueldos Dirección', prio: 120 },

  // Punto 1 — Dialque (Lácteos). Va antes que TGT porque "TGT Dialque" debe caer en Dialque.
  { patron: 'dialque',                   tipo: 'ilike', cat: 'PROVEEDOR_LACTEOS', prov: 'Dialque SAU',       prio: 110 },

  // Punto 10 — Lácteos consolidado: TGT y Entrepinares (Campoluz va en punto 4).
  { patron: 'TGT',                       tipo: 'ilike', cat: 'PROVEEDOR_LACTEOS', prov: 'TGT',              prio: 110,
    extraWhere: "AND NOT (concepto ILIKE '%dialque%')" },
  { patron: 'entrepinares',              tipo: 'ilike', cat: 'PROVEEDOR_LACTEOS', prov: 'Entrepinares',     prio: 110 },

  // Punto 4 — Campoluz (Lácteos)
  { patron: 'campoluz',                  tipo: 'ilike', cat: 'PROVEEDOR_LACTEOS', prov: 'Campoluz',         prio: 110 },
  { patron: 'campo luz',                 tipo: 'ilike', cat: 'PROVEEDOR_LACTEOS', prov: 'Campoluz',         prio: 110 },

  // Punto 3 — Equipamiento (cada subregla con su proveedor canónico)
  { patron: 'GGM',                       tipo: 'ilike', cat: 'EQUIPAMIENTO',     prov: 'GGM Gastro',       prio: 110 },
  { patron: 'amazon',                    tipo: 'ilike', cat: 'EQUIPAMIENTO',     prov: 'Amazon',           prio: 110 },
  { patron: 'AMZ',                       tipo: 'ilike', cat: 'EQUIPAMIENTO',     prov: 'Amazon',           prio: 110 },
  { patron: 'ikea',                      tipo: 'ilike', cat: 'EQUIPAMIENTO',     prov: 'IKEA',             prio: 110 },
  { patron: 'vivero',                    tipo: 'ilike', cat: 'EQUIPAMIENTO',     prov: 'Viveros',          prio: 110 },
  { patron: 'febal',                     tipo: 'ilike', cat: 'EQUIPAMIENTO',     prov: 'Maquinas Febal',   prio: 110 },
  { patron: 'argent',                    tipo: 'ilike', cat: 'EQUIPAMIENTO',     prov: 'Argent 3D',        prio: 110,
    extraWhere: "AND NOT (concepto ILIKE '%argentina%')" },
  { patron: 'argen ',                    tipo: 'ilike', cat: 'EQUIPAMIENTO',     prov: 'Argent 3D',        prio: 110 },

  // Punto 5 — Arrolas (alimentación, PROVEEDOR_OTROS hasta que aparezca mejor categoría)
  { patron: 'arrolas',                   tipo: 'ilike', cat: 'PROVEEDOR_OTROS',  prov: 'Arrolas',          prio: 110 },

  // Punto 6 — Carnicas Mulas: setear proveedor_normalizado canónico
  { patron: 'carnicas mulas',            tipo: 'ilike', cat: 'PROVEEDOR_CARNES', prov: 'Carnicas Mulas SL', prio: 110 },

  // Punto 7 — Radius. Tiene 72 tx / 6.734€ → supera el umbral menores → OTROS_GASTOS.
  { patron: 'radius',                    tipo: 'ilike', cat: 'OTROS_GASTOS',     prov: 'Radius',           prio: 110 },

  // Punto 9 — Préstamos Bancarios (NUNCA sobre INTRAGRUPO — el handler de upload
  // ya protege; aquí el UPDATE filtra por categoria != 'INTRAGRUPO').
  { patron: 'liquidacion periodica prestamo', tipo: 'ilike', cat: 'PRESTAMOS', prov: 'Préstamos Bancarios', prio: 110 },
  { patron: 'liquidacion periodica',     tipo: 'ilike', cat: 'PRESTAMOS',       prov: 'Préstamos Bancarios', prio: 110 },
  { patron: 'liquidación periódica',     tipo: 'ilike', cat: 'PRESTAMOS',       prov: 'Préstamos Bancarios', prio: 110 },
  { patron: 'cuota prestamo',            tipo: 'ilike', cat: 'PRESTAMOS',       prov: 'Préstamos Bancarios', prio: 110 },
  { patron: 'amortizacion',              tipo: 'ilike', cat: 'PRESTAMOS',       prov: 'Préstamos Bancarios', prio: 110 },
  { patron: 'amortización',              tipo: 'ilike', cat: 'PRESTAMOS',       prov: 'Préstamos Bancarios', prio: 110 },
];

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('Missing DATABASE_URL');
  console.log('=== RONDA 5 — Recategorización ===');
  console.log('Modo:', DRY ? 'DRY-RUN' : 'APPLY');

  // 1) INSERT reglas (idempotente: DELETE previas con mismos patrones).
  if (!DRY) {
    const patrones = REGLAS.map((r) => r.patron);
    const del = await pool.query(
      'DELETE FROM ab_reglas_normalizacion WHERE LOWER(patron) = ANY($1::text[])',
      [patrones.map((p) => p.toLowerCase())]
    );
    console.log('Reglas previas borradas (mismos patrones):', del.rowCount);
    for (const r of REGLAS) {
      await pool.query(
        `INSERT INTO ab_reglas_normalizacion (patron, tipo_match, categoria, proveedor_normalizado, prioridad)
         VALUES ($1, $2, $3, $4, $5)`,
        [r.patron, r.tipo, r.cat, r.prov, r.prio]
      );
    }
    console.log('Reglas insertadas:', REGLAS.length);
  } else {
    console.log('Reglas que se insertarían:', REGLAS.length);
  }

  // 2) UPDATE retroactivo. Orden: prio DESC, luego respeta extraWhere.
  // INTRAGRUPO se preserva siempre. El primer match (mayor prio, más
  // específico) gana porque se aplica en orden.
  console.log('\n--- UPDATE retroactivo ---');
  const sorted = [...REGLAS].sort((a, b) => b.prio - a.prio);
  const transitions = new Map();
  const combosAfectados = new Set();
  let totalUpdated = 0;
  for (const r of sorted) {
    const extra = r.extraWhere || '';
    // Conteo previo
    const cnt = await pool.query(
      `SELECT COUNT(*)::int n FROM ab_movimientos
        WHERE importe < 0 AND categoria <> 'INTRAGRUPO'
          AND concepto ILIKE $1 ${extra}
          AND (categoria <> $2 OR proveedor_normalizado IS DISTINCT FROM $3)`,
      ['%' + r.patron + '%', r.cat, r.prov]
    );
    const willUpdate = cnt.rows[0].n;
    if (!willUpdate) {
      console.log('  [skip 0]  '+r.patron.padEnd(32)+' → '+r.cat+' / '+r.prov);
      continue;
    }
    if (!DRY) {
      const upd = await pool.query(
        `UPDATE ab_movimientos
            SET categoria = $2, proveedor_normalizado = $3
          WHERE importe < 0 AND categoria <> 'INTRAGRUPO'
            AND concepto ILIKE $1 ${extra}
            AND (categoria <> $2 OR proveedor_normalizado IS DISTINCT FROM $3)
        RETURNING sociedad_id, periodo`,
        ['%' + r.patron + '%', r.cat, r.prov]
      );
      for (const row of upd.rows) combosAfectados.add(row.sociedad_id + '|' + row.periodo);
      totalUpdated += upd.rowCount;
      console.log('  [' + String(upd.rowCount).padStart(4) + ']  ' + r.patron.padEnd(32) + ' → ' + r.cat + ' / ' + r.prov);
    } else {
      console.log('  [DRY '+String(willUpdate).padStart(3)+']  '+r.patron.padEnd(32)+' → '+r.cat+' / '+r.prov);
    }
  }
  console.log('Total filas actualizadas:', totalUpdated);

  // 3) Recalc resumen mensual para las (sociedad, periodo) afectadas.
  if (!DRY) {
    console.log('\n--- Recalc ab_resumen_mensual ---');
    let ok = 0, fail = 0;
    for (const combo of combosAfectados) {
      const [sociedad_id, periodo] = combo.split('|');
      try { await recalcResumenMensual(sociedad_id, periodo); ok++; }
      catch (e) { console.error('  ERR ' + combo + ': ' + e.message); fail++; }
    }
    console.log('Recalculados:', ok, '· Errores:', fail);
  }

  // 4) Verificación final
  console.log('\n--- Verificación final ---');
  const fin = await pool.query(`
    SELECT categoria, COUNT(*)::int n, SUM(ABS(importe))::float8 total
    FROM ab_movimientos WHERE importe < 0
    GROUP BY categoria ORDER BY total DESC
  `);
  console.table(fin.rows.map((r) => ({ cat: r.categoria, n: r.n, total: Math.round(r.total) })));

  // 5) Punto 8 — Proveedores menores recalculado por proveedor_normalizado
  const men = await pool.query(`
    SELECT proveedor_normalizado, COUNT(*)::int tx, SUM(ABS(importe))::float8 total
    FROM ab_movimientos
    WHERE importe < 0 AND categoria <> 'INTRAGRUPO' AND proveedor_normalizado IS NOT NULL
    GROUP BY proveedor_normalizado
    HAVING COUNT(*) < 5 AND SUM(ABS(importe)) < 2000
    ORDER BY total DESC LIMIT 20
  `);
  console.log('\nPunto 8 — proveedores menores (tx<5 AND total<2000) detectados ahora:', men.rowCount);
  if (men.rowCount) console.table(men.rows.map((r) => ({ prov: r.proveedor_normalizado, tx: r.tx, total: Math.round(r.total) })));

  await pool.end();
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
