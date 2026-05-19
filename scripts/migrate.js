require('dotenv').config();
const { runMigrations } = require('../lib/migrations');
const { pool } = require('../lib/db');

(async () => {
  try {
    await runMigrations();
    console.log('[migrate] done');
  } catch (e) {
    console.error('[migrate] failed:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
