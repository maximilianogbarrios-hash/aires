require('dotenv').config();
const { runMigrations } = require('../lib/migrations');
const { pool } = require('../lib/db');

(async () => {
  try {
    await runMigrations();
    console.log('[migrate] done');
  } catch (e) {
    console.error('[migrate] failed:', e.message);
    if (e.code)     console.error('[migrate]   code:    ', e.code);
    if (e.detail)   console.error('[migrate]   detail:  ', e.detail);
    if (e.hint)     console.error('[migrate]   hint:    ', e.hint);
    if (e.position) console.error('[migrate]   position:', e.position);
    if (e.where)    console.error('[migrate]   where:   ', e.where);
    if (e.routine)  console.error('[migrate]   routine: ', e.routine);
    if (e.stack)    console.error('[migrate]   stack:\n', e.stack);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
