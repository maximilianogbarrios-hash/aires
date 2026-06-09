// CLI: import del CSV histórico de caja a ab_caja_movimientos.
// Uso: node scripts/import-caja.js <ruta-csv-o-xlsx>
//      DATABASE_URL=... node scripts/import-caja.js cajas_historico_completo_v2.csv
//
// La lógica de parseo + upsert vive en lib/caja/importer.js — este
// archivo es solo un wrapper CLI que la invoca con un Pool propio.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { importCajaCsvText, xlsxBufferToCsvText } = require('../lib/caja/importer');

async function main() {
  const filePath = process.argv[2] || 'cajas_historico_completo_v2.csv';
  if (!fs.existsSync(filePath)) {
    console.error('Archivo no encontrado: ' + filePath);
    process.exit(1);
  }
  const ext = path.extname(filePath).toLowerCase();
  let rawText;
  if (ext === '.xls' || ext === '.xlsx') {
    rawText = xlsxBufferToCsvText(fs.readFileSync(filePath));
  } else {
    rawText = fs.readFileSync(filePath, 'utf8');
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  const queryFn = (sql, vals) => pool.query(sql, vals);

  const report = await importCajaCsvText(rawText, {
    fuente: path.basename(filePath),
    queryFn,
    logger: (m) => console.log(m),
  });

  console.log('\n=== Import completo ===');
  console.log('  filas procesadas:', report.archivo.n_filas_procesadas);
  console.log('  insertadas nuevas:', report.upsert.insertadas_nuevas);
  console.log('  actualizadas:    ', report.upsert.actualizadas);
  console.log('  sin cambios:     ', report.upsert.ya_presentes_sin_cambios);
  console.log('  errores:         ', report.upsert.errores);
  console.log('  rango archivo:   ', report.archivo.rango_fechas.desde, '→', report.archivo.rango_fechas.hasta);
  console.log('  total ingresos:  €' + report.archivo.total_ingresos.toFixed(2));
  console.log('  total egresos:   €' + report.archivo.total_egresos.toFixed(2));
  console.log('  neto:            €' + report.archivo.neto.toFixed(2));
  console.log(`\n  DB antes: ${report.db.antes} filas`);
  console.log(`  DB después: ${report.db.despues} filas (rango ${report.db.rango_total.desde} → ${report.db.rango_total.hasta})`);
  if (report.cajas.desconocidas_en_mapeo.length) {
    console.log('\n  Cajas SIN mapeo en ab_caja_mapeo_sociedades:');
    for (const s of report.cajas.desconocidas_en_mapeo) console.log('    ⚠ ' + s);
  }
  console.log('\n  Por sucursal:');
  for (const x of report.por_sucursal) {
    console.log('    ' + x.sucursal.padEnd(20) + ' ' + String(x.n_movs).padStart(5) + ' movs  → ' + (x.sociedad || '(especial)'));
  }
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
