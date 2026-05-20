require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const BATCH = 500;

function hashRow(s, b, f, c, i) {
  return crypto.createHash('md5').update(`${s}${b}${f}${c}${i}`).digest('hex');
}

function buildInsert(batch) {
  const cols = ['sociedad_id','banco','fecha','concepto','importe','categoria','codigo_banco','periodo','hash'];
  const placeholders = [];
  const vals = [];
  let p = 1;
  for (const t of batch) {
    placeholders.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
    vals.push(
      t.s, t.b, t.f, t.c, t.i, t.k, t.cod, t.p,
      hashRow(t.s, t.b, t.f, t.c, t.i),
    );
  }
  const sql = `INSERT INTO ab_movimientos (${cols.join(',')}) VALUES ${placeholders.join(',')} ON CONFLICT (hash) DO NOTHING RETURNING id`;
  return { sql, vals };
}

async function insertBatchRetry(batch, attempt = 1) {
  try {
    const { sql, vals } = buildInsert(batch);
    const r = await pool.query(sql, vals);
    return r.rowCount;
  } catch (e) {
    if (attempt < 3 && /terminated|ENOTFOUND|ECONNRESET|timeout/i.test(e.message)) {
      const wait = 1000 * attempt;
      console.error(`  retry ${attempt} en ${wait}ms (${e.message})`);
      await new Promise((res) => setTimeout(res, wait));
      return insertBatchRetry(batch, attempt + 1);
    }
    throw e;
  }
}

async function run() {
  if (!process.env.DATABASE_URL) throw new Error('Missing DATABASE_URL');

  const files = [1, 2, 3, 4].map((n) => path.join(__dirname, '..', `banco_data_${n}.json`));
  let totalRead = 0, totalInserted = 0, totalErrors = 0;

  for (const f of files) {
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    totalRead += data.length;
    let fileInserted = 0, fileErrors = 0;

    for (let i = 0; i < data.length; i += BATCH) {
      const batch = data.slice(i, i + BATCH);
      try {
        const inserted = await insertBatchRetry(batch);
        fileInserted += inserted;
      } catch (e) {
        fileErrors += batch.length;
        if (fileErrors <= BATCH * 2) {
          console.error(`  ERR batch ${i}-${i+batch.length}: ${e.message}`);
        }
      }
    }

    totalInserted += fileInserted;
    totalErrors += fileErrors;
    console.log(`OK ${path.basename(f)}: ${data.length} leídos, ${fileInserted} insertados (${data.length - fileInserted} dups/skipped), ${fileErrors} errores`);
  }

  console.log('---');
  console.log(`TOTAL LEÍDOS:     ${totalRead}`);
  console.log(`TOTAL INSERTADOS: ${totalInserted}`);
  console.log(`TOTAL ERRORES:    ${totalErrors}`);

  await pool.end();
}

run().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
