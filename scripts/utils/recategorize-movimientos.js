// One-shot: re-aplica categorizar() sobre todas las filas de ab_movimientos
// y persiste los cambios. Pensado para correr después de cambios en
// lib/bank/categorizer.js o normalizers.js. Idempotente.
//
// Uso: node scripts/utils/recategorize-movimientos.js [--dry-run]

require('dotenv').config();
const { Pool } = require('pg');
const { categorizar } = require('../../lib/bank/categorizer');

const DRY = process.argv.includes('--dry-run');
const BATCH = 500;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function updateBatch(items) {
  // UPDATE ... FROM (VALUES) — un solo statement por batch.
  const placeholders = [];
  const vals = [];
  let p = 1;
  for (const it of items) {
    placeholders.push(`($${p++}::int, $${p++}::text)`);
    vals.push(it.id, it.nueva);
  }
  const sql = `UPDATE ab_movimientos AS m
               SET categoria = v.cat
               FROM (VALUES ${placeholders.join(',')}) AS v(id, cat)
               WHERE m.id = v.id`;
  await pool.query(sql, vals);
}

async function run() {
  if (!process.env.DATABASE_URL) throw new Error('Missing DATABASE_URL');

  const r = await pool.query(
    `SELECT id, concepto, importe::float8 AS importe, categoria
       FROM ab_movimientos
      ORDER BY id`
  );
  const rows = r.rows;
  console.log(`Filas en ab_movimientos: ${rows.length}`);

  // Transiciones: { 'OLD → NEW': n }
  const transiciones = new Map();
  // Subtotales: { 'OLD → NEW': sumImporte }
  const subtotales = new Map();
  const cambios = [];

  for (const row of rows) {
    const nueva = categorizar(row.concepto, +row.importe);
    if (nueva === row.categoria) continue;
    const key = `${row.categoria || '∅'} → ${nueva}`;
    transiciones.set(key, (transiciones.get(key) || 0) + 1);
    subtotales.set(key, (subtotales.get(key) || 0) + Math.abs(+row.importe));
    cambios.push({ id: row.id, vieja: row.categoria, nueva, importe: +row.importe, concepto: row.concepto });
  }

  console.log(`Cambios detectados: ${cambios.length}`);
  console.log('\nTransiciones (count · €):');
  const ordered = [...transiciones.entries()].sort((a, b) => (subtotales.get(b[0]) || 0) - (subtotales.get(a[0]) || 0));
  for (const [k, n] of ordered) {
    console.log(`  ${k.padEnd(55)} ${String(n).padStart(5)}  ${Math.round(subtotales.get(k) || 0).toString().padStart(9)}€`);
  }

  if (DRY) {
    console.log('\n--dry-run: no se aplicaron UPDATEs');
    await pool.end();
    return { cambios, transiciones, subtotales };
  }

  if (cambios.length) {
    console.log(`\nAplicando UPDATEs en batches de ${BATCH}...`);
    for (let i = 0; i < cambios.length; i += BATCH) {
      const items = cambios.slice(i, i + BATCH).map((c) => ({ id: c.id, nueva: c.nueva }));
      await updateBatch(items);
    }
    console.log(`UPDATEs aplicados: ${cambios.length}`);
  }

  await pool.end();
  return { cambios, transiciones, subtotales };
}

run().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
