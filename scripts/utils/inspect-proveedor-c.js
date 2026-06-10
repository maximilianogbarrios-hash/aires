// Diagnóstico boot del dashboard: simular qué le llega al frontend
// y reproducir el crash.
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

(async () => {
  const out = {};

  // Schema de ab_config
  out.schemaConfig = (await pool.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name='ab_config' ORDER BY ordinal_position`
  )).rows;

  // Datos completos de ab_config
  out.config = (await pool.query('SELECT clave, valor FROM ab_config')).rows;

  // Tipos JS de cada valor (numeric viene como string, json como object, etc.)
  out.configTipos = out.config.map((r) => ({
    clave: r.clave,
    valor: r.valor,
    typeof: typeof r.valor,
  }));

  // ¿Hay algún valor que no se pueda parsear como número cuando se espera?
  const numericKeys = ['pctMP', 'pctPersonal', 'pctImpuestos', 'pctPublicidad', 'euroHora', 'poolProduccion', 'poolEspeciales'];
  out.numericCheck = numericKeys.map((k) => {
    const row = out.config.find((r) => r.clave === k);
    if (!row) return { clave: k, presente: false };
    const v = row.valor;
    return {
      clave: k,
      valor_raw: v,
      typeof: typeof v,
      hasToFixed: v && typeof v.toFixed === 'function',
      asNumber: +v,
      isNaN: Number.isNaN(+v),
    };
  });

  await pool.end();
  console.log(JSON.stringify(out, null, 2));
})().catch(e => { console.error('ERROR:', e.message); console.error(e.stack); process.exit(1); });
