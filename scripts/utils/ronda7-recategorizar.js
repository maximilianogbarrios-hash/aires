// Ronda 7 (2026-05-21): correcciones puntuales sobre Ronda 6.
// - Viveros: cambio de EQUIPAMIENTO → MANTENIMIENTO (gasto corriente,
//   no inversión de equipamiento).
// - SUMA Gestion Tributaria → IMPUESTOS (tasas municipales pagadas a
//   la agencia provincial Suma de Alicante).
// - BSSG: 1 sola fila ("ADEUDO RECIBO BSSG"). Conservador → mantener
//   en PROVEEDOR_OTROS pero con proveedor_normalizado='BSSG' para que
//   sea visible como slice identificable.
//
// Mantenemos la separación EQUIPAMIENTO vs MANTENIMIENTO definida
// en Ronda 5 (GGM Gastro, Amazon, IKEA, Argent 3D, Maquinas Febal
// son inversiones de equipamiento; Leroy Merlin/Bricomart/Obramat
// son mantenimiento corriente). Viveros se traslada por su naturaleza
// recurrente.
//
// Uso: node scripts/utils/ronda7-recategorizar.js [--dry-run]

require('dotenv').config();
const { Pool } = require('pg');
const { recalcResumenMensual } = require('../../lib/bank/db');

const DRY = process.argv.includes('--dry-run');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const REGLAS = [
  // Viveros: MOVER de EQUIPAMIENTO → MANTENIMIENTO. La regla anterior
  // de Ronda 5 será reemplazada (DELETE + INSERT).
  { patron: 'vivero',                  tipo: 'ilike', cat: 'MANTENIMIENTO', prov: 'Viveros',           prio: 110 },

  // SUMA Gestion Tributaria → IMPUESTOS (tasas municipales).
  { patron: 'suma gestion tributaria', tipo: 'ilike', cat: 'IMPUESTOS',     prov: 'SUMA - Impuestos',   prio: 110 },
  // Variante corta para uploads futuros que vengan ya sin "Gestion".
  { patron: 'IMPUESTOS SUMA',          tipo: 'ilike', cat: 'IMPUESTOS',     prov: 'SUMA - Impuestos',   prio: 110 },

  // BSSG conservador → PROVEEDOR_OTROS con su nombre.
  { patron: 'BSSG',                    tipo: 'ilike', cat: 'PROVEEDOR_OTROS', prov: 'BSSG',             prio: 110 },
];

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('Missing DATABASE_URL');
  console.log('=== RONDA 7 ===  Modo:', DRY ? 'DRY-RUN' : 'APPLY');

  if (!DRY) {
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
    console.log('Reglas Ronda 7 insertadas:', REGLAS.length);
  }

  console.log('\n--- UPDATE retroactivo ---');
  const combosAfectados = new Set();
  let totalUpdated = 0;
  for (const r of REGLAS) {
    const cnt = await pool.query(
      `SELECT COUNT(*)::int n FROM ab_movimientos
        WHERE importe < 0 AND categoria <> 'INTRAGRUPO'
          AND concepto ILIKE $1
          AND (categoria <> $2 OR proveedor_normalizado IS DISTINCT FROM $3)`,
      ['%' + r.patron + '%', r.cat, r.prov]
    );
    const willUpdate = cnt.rows[0].n;
    if (!willUpdate) {
      console.log('  [skip 0]  ' + r.patron.padEnd(28) + ' → ' + r.cat + ' / ' + r.prov);
      continue;
    }
    if (!DRY) {
      const upd = await pool.query(
        `UPDATE ab_movimientos
            SET categoria = $2, proveedor_normalizado = $3
          WHERE importe < 0 AND categoria <> 'INTRAGRUPO'
            AND concepto ILIKE $1
            AND (categoria <> $2 OR proveedor_normalizado IS DISTINCT FROM $3)
        RETURNING sociedad_id, periodo`,
        ['%' + r.patron + '%', r.cat, r.prov]
      );
      for (const row of upd.rows) combosAfectados.add(row.sociedad_id + '|' + row.periodo);
      totalUpdated += upd.rowCount;
      console.log('  [' + String(upd.rowCount).padStart(4) + ']  ' + r.patron.padEnd(28) + ' → ' + r.cat + ' / ' + r.prov);
    } else {
      console.log('  [DRY ' + String(willUpdate).padStart(3) + ']  ' + r.patron.padEnd(28) + ' → ' + r.cat + ' / ' + r.prov);
    }
  }
  console.log('Total filas actualizadas:', totalUpdated);

  if (!DRY) {
    console.log('\n--- Recalc ab_resumen_mensual ---');
    let ok = 0, fail = 0;
    for (const combo of combosAfectados) {
      const [sociedad_id, periodo] = combo.split('|');
      try { await recalcResumenMensual(sociedad_id, periodo); ok++; }
      catch (e) { fail++; console.error('  ERR ' + combo + ': ' + e.message); }
    }
    console.log('Recalc:', ok, 'OK ·', fail, 'errores');
  }

  // Verificación final: EQUIPAMIENTO sin Viveros
  const eq = await pool.query("SELECT proveedor_normalizado, COUNT(*)::int n, SUM(ABS(importe))::float8 total FROM ab_movimientos WHERE importe<0 AND categoria='EQUIPAMIENTO' GROUP BY proveedor_normalizado ORDER BY total DESC");
  console.log('\nEQUIPAMIENTO final:');
  eq.rows.forEach((r) => console.log('  ' + (r.proveedor_normalizado || '(null)').padEnd(22) + ' ' + r.n + ' tx · ' + Math.round(r.total) + '€'));

  await pool.end();
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
