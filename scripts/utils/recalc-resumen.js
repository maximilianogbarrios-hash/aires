require('dotenv').config();
const { many } = require('../../lib/db');
const { recalcResumenMensual } = require('../../lib/bank/db');
const { pool } = require('../../lib/db');

async function run() {
  if (!process.env.DATABASE_URL) throw new Error('Missing DATABASE_URL');

  const combos = await many(
    `SELECT DISTINCT sociedad_id, periodo
     FROM ab_movimientos
     ORDER BY sociedad_id, periodo`
  );
  console.log(`Combos a recalcular: ${combos.length}`);

  let ok = 0, fail = 0;
  for (const c of combos) {
    try {
      await recalcResumenMensual(c.sociedad_id, c.periodo);
      ok++;
      console.log(`  OK  ${c.sociedad_id} / ${c.periodo}`);
    } catch (e) {
      fail++;
      console.error(`  ERR ${c.sociedad_id} / ${c.periodo}: ${e.message}`);
    }
  }

  console.log('---');
  console.log(`RECALCULADOS: ${ok}`);
  console.log(`ERRORES:      ${fail}`);

  await pool.end();
}

run().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
