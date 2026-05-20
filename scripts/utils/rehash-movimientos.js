require('dotenv').config();
const crypto = require('crypto');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const BATCH = 500;

function newHash({ sociedad_id, fecha, concepto, importe, codigo_banco, num_documento }) {
  const key = [
    sociedad_id,
    fecha,
    concepto,
    Number(importe).toFixed(2),
    codigo_banco || '',
    num_documento || '',
  ].join('|');
  return crypto.createHash('sha256').update(key).digest('hex');
}

async function updateBatchRetry(batch, attempt = 1) {
  // batch: array of { id, hash }
  const placeholders = [];
  const vals = [];
  let p = 1;
  for (const r of batch) {
    placeholders.push(`($${p++}::int, $${p++}::text)`);
    vals.push(r.id, r.hash);
  }
  const sql = `UPDATE ab_movimientos AS m
               SET hash = v.h
               FROM (VALUES ${placeholders.join(',')}) AS v(id, h)
               WHERE m.id = v.id`;
  try {
    const r = await pool.query(sql, vals);
    return r.rowCount;
  } catch (e) {
    if (attempt < 3 && /terminated|ENOTFOUND|ECONNRESET|timeout/i.test(e.message)) {
      const wait = 1000 * attempt;
      console.error(`  retry ${attempt} en ${wait}ms (${e.message})`);
      await new Promise((res) => setTimeout(res, wait));
      return updateBatchRetry(batch, attempt + 1);
    }
    throw e;
  }
}

async function run() {
  if (!process.env.DATABASE_URL) throw new Error('Missing DATABASE_URL');

  const r = await pool.query(
    `SELECT id, sociedad_id,
            TO_CHAR(fecha, 'YYYY-MM-DD') AS fecha,
            concepto, importe::float8 AS importe,
            codigo_banco, num_documento, hash AS old_hash
     FROM ab_movimientos
     ORDER BY id`
  );
  const rows = r.rows;
  console.log(`Filas leídas: ${rows.length}`);

  // Compute new hashes + detect intra-set collisions
  const seen = new Map();
  const toUpdate = [];
  const collisions = [];
  let unchanged = 0;
  for (const row of rows) {
    const h = newHash(row);
    if (h === row.old_hash) { unchanged++; continue; }
    if (seen.has(h)) {
      collisions.push({ id: row.id, dup_of: seen.get(h), hash: h });
    } else {
      seen.set(h, row.id);
      toUpdate.push({ id: row.id, hash: h });
    }
  }
  console.log(`Sin cambios:       ${unchanged}`);
  console.log(`A actualizar:      ${toUpdate.length}`);
  console.log(`Colisiones SHA256: ${collisions.length}`);
  for (const c of collisions.slice(0, 10)) {
    console.log(`   ⚠ id=${c.id} duplica id=${c.dup_of}`);
  }

  let changed = 0, batchErrors = 0;
  for (let i = 0; i < toUpdate.length; i += BATCH) {
    const batch = toUpdate.slice(i, i + BATCH);
    try {
      const n = await updateBatchRetry(batch);
      changed += n;
      console.log(`  batch ${i+1}-${i+batch.length}: ${n} updated`);
    } catch (e) {
      batchErrors++;
      console.error(`  ERR batch ${i+1}-${i+batch.length}: ${e.message}`);
    }
  }

  console.log('---');
  console.log(`ACTUALIZADAS:    ${changed}`);
  console.log(`SIN CAMBIOS:     ${unchanged}`);
  console.log(`COLISIONES SHA:  ${collisions.length}  (NO actualizadas)`);
  console.log(`BATCHES FALLADOS:${batchErrors}`);

  await pool.end();
}

run().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
