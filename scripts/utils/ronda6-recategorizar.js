// Ronda 6 (2026-05-21): correcciones puntuales sobre Ronda 5.
// - GASTOS_DIRECCION:  Revel + Créditos Dirección.
// - GASTOS_VEHICULOS:  Stellantis / leasing / renting / proveedor
//                      "Vehículos y Leasing" salido de Ronda 4.
// - TGT como slice independiente con prioridad 120 (la regla previa
//   estaba en 110 — Dialque la pisaba en ciertos casos).
//
// Reglas:
//   - Las nuevas reglas DB se insertan con prio 110 (Revel/Créditos/
//     Stellantis/leasing/renting) y 120 (TGT).
//   - El UPDATE retroactivo protege:
//       * INTRAGRUPO (siempre).
//       * "Créditos" NO sobreescribe NOMINAS_DIRECCION ya asignado por
//         Ronda 5 (e.g. "Crédito a Yanina Barrios" = sueldo dirección).
//       * "TGT" excluye conceptos con "dialque" (Dialque SAU gana).
//
// Uso: node scripts/utils/ronda6-recategorizar.js [--dry-run]

require('dotenv').config();
const { Pool } = require('pg');
const { recalcResumenMensual } = require('../../lib/bank/db');

const DRY = process.argv.includes('--dry-run');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// patron, tipo, categoria, proveedor, prioridad, extraWhere
const REGLAS = [
  // TGT a prio 120 — sube de Ronda 5 (era 110) para garantizar precedencia
  // sobre cualquier regla genérica futura. Mantiene exclusión de "dialque".
  { patron: 'TGT',         tipo: 'ilike', cat: 'PROVEEDOR_LACTEOS', prov: 'TGT',                  prio: 120,
    extraWhere: "AND NOT (concepto ILIKE '%dialque%')" },
  { patron: 'T.G.T',       tipo: 'ilike', cat: 'PROVEEDOR_LACTEOS', prov: 'TGT',                  prio: 120 },

  // GASTOS_DIRECCION (Revel + Créditos)
  { patron: 'revel',       tipo: 'ilike', cat: 'GASTOS_DIRECCION',  prov: 'Revel',                prio: 110 },
  { patron: 'conduce revel',tipo:'ilike', cat: 'GASTOS_DIRECCION',  prov: 'Revel',                prio: 110 },
  // "Créditos" no sobreescribe Sueldos Dirección (asignado en Ronda 5 con
  // prio 120 vía patrones de personas concretas). El extraWhere lo protege.
  { patron: 'credito',     tipo: 'ilike', cat: 'GASTOS_DIRECCION',  prov: 'Créditos Dirección',   prio: 110,
    extraWhere: "AND categoria <> 'NOMINAS_DIRECCION'" },
  { patron: 'crédito',     tipo: 'ilike', cat: 'GASTOS_DIRECCION',  prov: 'Créditos Dirección',   prio: 110,
    extraWhere: "AND categoria <> 'NOMINAS_DIRECCION'" },

  // GASTOS_VEHICULOS (Stellantis + leasing + renting + proveedor heredado)
  { patron: 'stellantis',  tipo: 'ilike', cat: 'GASTOS_VEHICULOS',  prov: 'Gastos Vehículos',     prio: 110 },
  { patron: 'leasing',     tipo: 'ilike', cat: 'GASTOS_VEHICULOS',  prov: 'Gastos Vehículos',     prio: 110 },
  { patron: 'renting',     tipo: 'ilike', cat: 'GASTOS_VEHICULOS',  prov: 'Gastos Vehículos',     prio: 110 },
];

// UPDATE adicional especial: filas que ya tenían proveedor_normalizado
// ILIKE '%vehículos y leasing%' (de la Mejora A / Ronda 4) — moverlas a
// la nueva categoría GASTOS_VEHICULOS / 'Gastos Vehículos'.
const UPDATE_POR_PROVEEDOR_NORMALIZADO = [
  { match: '%vehículos y leasing%', cat: 'GASTOS_VEHICULOS', prov: 'Gastos Vehículos' },
  { match: '%vehiculos y leasing%', cat: 'GASTOS_VEHICULOS', prov: 'Gastos Vehículos' },
];

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('Missing DATABASE_URL');
  console.log('=== RONDA 6 — Recategorización ===');
  console.log('Modo:', DRY ? 'DRY-RUN' : 'APPLY');

  if (!DRY) {
    // Borrar TGT vieja de Ronda 5 (prio 110) para que la nueva (prio 120) sea única.
    const delTgt = await pool.query("DELETE FROM ab_reglas_normalizacion WHERE LOWER(patron) IN ('tgt','t.g.t') AND prioridad < 120");
    console.log('Reglas TGT viejas borradas (Ronda 5):', delTgt.rowCount);
    // Borrar reglas previas de Ronda 6 (idempotente).
    const patrones = REGLAS.map((r) => r.patron.toLowerCase());
    const del = await pool.query(
      'DELETE FROM ab_reglas_normalizacion WHERE LOWER(patron) = ANY($1::text[])',
      [patrones]
    );
    console.log('Reglas previas con esos patrones borradas:', del.rowCount);
    for (const r of REGLAS) {
      await pool.query(
        'INSERT INTO ab_reglas_normalizacion (patron, tipo_match, categoria, proveedor_normalizado, prioridad) VALUES ($1, $2, $3, $4, $5)',
        [r.patron, r.tipo, r.cat, r.prov, r.prio]
      );
    }
    console.log('Reglas Ronda 6 insertadas:', REGLAS.length);
  }

  // UPDATE retroactivo
  console.log('\n--- UPDATE retroactivo por patrón ---');
  const sorted = [...REGLAS].sort((a, b) => b.prio - a.prio);
  const combosAfectados = new Set();
  let totalUpdated = 0;
  for (const r of sorted) {
    const extra = r.extraWhere || '';
    const cnt = await pool.query(
      `SELECT COUNT(*)::int n FROM ab_movimientos
        WHERE importe < 0 AND categoria <> 'INTRAGRUPO'
          AND concepto ILIKE $1 ${extra}
          AND (categoria <> $2 OR proveedor_normalizado IS DISTINCT FROM $3)`,
      ['%' + r.patron + '%', r.cat, r.prov]
    );
    const willUpdate = cnt.rows[0].n;
    if (!willUpdate) {
      console.log('  [skip 0]  '+r.patron.padEnd(20)+' → '+r.cat+' / '+r.prov);
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
      console.log('  ['+String(upd.rowCount).padStart(4)+']  '+r.patron.padEnd(20)+' → '+r.cat+' / '+r.prov);
    } else {
      console.log('  [DRY '+String(willUpdate).padStart(3)+']  '+r.patron.padEnd(20)+' → '+r.cat+' / '+r.prov);
    }
  }

  console.log('\n--- UPDATE por proveedor_normalizado heredado ---');
  for (const u of UPDATE_POR_PROVEEDOR_NORMALIZADO) {
    const cnt = await pool.query(
      `SELECT COUNT(*)::int n FROM ab_movimientos
        WHERE importe < 0 AND proveedor_normalizado ILIKE $1
          AND (categoria <> $2 OR proveedor_normalizado IS DISTINCT FROM $3)`,
      [u.match, u.cat, u.prov]
    );
    const willUpdate = cnt.rows[0].n;
    if (!willUpdate) { console.log('  [skip 0]  '+u.match+' → '+u.cat+' / '+u.prov); continue; }
    if (!DRY) {
      const upd = await pool.query(
        `UPDATE ab_movimientos
            SET categoria = $2, proveedor_normalizado = $3
          WHERE importe < 0 AND proveedor_normalizado ILIKE $1
            AND (categoria <> $2 OR proveedor_normalizado IS DISTINCT FROM $3)
        RETURNING sociedad_id, periodo`,
        [u.match, u.cat, u.prov]
      );
      for (const row of upd.rows) combosAfectados.add(row.sociedad_id + '|' + row.periodo);
      totalUpdated += upd.rowCount;
      console.log('  ['+String(upd.rowCount).padStart(4)+']  '+u.match+' → '+u.cat+' / '+u.prov);
    } else {
      console.log('  [DRY '+String(willUpdate).padStart(3)+']  '+u.match+' → '+u.cat+' / '+u.prov);
    }
  }
  console.log('Total filas actualizadas:', totalUpdated);

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

  // Verificación final
  const fin = await pool.query(`
    SELECT categoria, COUNT(*)::int n, SUM(ABS(importe))::float8 total
    FROM ab_movimientos WHERE importe < 0
    GROUP BY categoria ORDER BY total DESC
  `);
  console.log('\n--- Distribución final ---');
  console.table(fin.rows.map((r) => ({ cat: r.categoria, n: r.n, total: Math.round(r.total) })));

  await pool.end();
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
