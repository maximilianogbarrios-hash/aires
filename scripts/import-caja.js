// Import del CSV histórico de caja a ab_caja_movimientos.
// Uso: node scripts/import-caja.js <ruta-csv>
//      DATABASE_URL=... node scripts/import-caja.js cajas_historico_completo.csv
//
// CSV esperado (separador ';', quote '"'):
//   id;fecha;hora;sucursal;tipo;subtipo;metodo_pago;monto;observaciones;fecha_carga
//
// Idempotente: usa el id del CSV como PK y INSERT ON CONFLICT DO NOTHING.

const fs = require('fs');
const { Pool } = require('pg');
const { sociedadDeSucursal, normalizarSucursal } = require('../lib/caja/sucursales');

// Parser CSV simple para separador `;` y quoting con `"`. No usa lib
// externa para minimizar dependencias. Tolerante a CRLF/LF y BOM.
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } // escaped quote
        else { inQ = false; }
      } else { cur += ch; }
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ';') { out.push(cur); cur = ''; }
      else { cur += ch; }
    }
  }
  out.push(cur);
  return out;
}

function parseFechaCarga(s) {
  // "2026-06-04 00:00:00" → "2026-06-04"
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : null;
}

async function main() {
  const path = process.argv[2] || 'cajas_historico_completo.csv';
  if (!fs.existsSync(path)) {
    console.error('CSV no encontrado: ' + path);
    process.exit(1);
  }
  const raw = fs.readFileSync(path, 'utf8').replace(/^﻿/, ''); // strip BOM
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) { console.error('CSV vacío'); process.exit(1); }
  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  for (const req of ['id', 'fecha', 'sucursal', 'tipo', 'monto']) {
    if (idx[req] === undefined) {
      console.error('falta columna requerida: ' + req);
      process.exit(1);
    }
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let inserted = 0, skipped = 0, errors = 0;
  const porSucursal = new Map();
  let minFecha = null, maxFecha = null;
  let totalIng = 0, totalEgr = 0;

  // INSERT en lotes para velocidad (10k rows en ~10s contra Railway).
  const BATCH = 500;
  let batch = [];

  async function flush() {
    if (!batch.length) return;
    // Construir multi-row VALUES
    const vals = [];
    const phs = [];
    for (let i = 0; i < batch.length; i++) {
      const r = batch[i];
      const b = i * 11;
      phs.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11})`);
      vals.push(r.id, r.fecha, r.hora, r.sucursal, r.sociedad_id, r.tipo, r.subtipo, r.metodo_pago, r.monto, r.observaciones, r.fecha_carga);
    }
    const sql = `INSERT INTO ab_caja_movimientos
      (id, fecha, hora, sucursal, sociedad_id, tipo, subtipo, metodo_pago, monto, observaciones, fecha_carga)
      VALUES ${phs.join(',')}
      ON CONFLICT (id) DO NOTHING`;
    try {
      const r = await pool.query(sql, vals);
      inserted += r.rowCount;
      skipped += batch.length - r.rowCount;
    } catch (e) {
      console.error('error en lote (ids ' + batch[0].id + '..' + batch[batch.length-1].id + '):', e.message);
      errors += batch.length;
    }
    batch = [];
  }

  for (let li = 1; li < lines.length; li++) {
    const cells = parseCsvLine(lines[li]);
    if (cells.length < 5) continue;
    const sucursalRaw = cells[idx.sucursal];
    const sucursal = normalizarSucursal(sucursalRaw);
    const sociedad_id = sociedadDeSucursal(sucursal);
    const monto = Number(cells[idx.monto]);
    if (!Number.isFinite(monto)) continue;
    const tipo = (cells[idx.tipo] || '').trim();
    const fecha = cells[idx.fecha];
    const id = parseInt(cells[idx.id], 10);
    if (!id || !fecha) continue;
    batch.push({
      id,
      fecha,
      hora: cells[idx.hora] || null,
      sucursal,
      sociedad_id,
      tipo,
      subtipo: cells[idx.subtipo] || null,
      metodo_pago: cells[idx.metodo_pago] || null,
      monto,
      observaciones: cells[idx.observaciones] || null,
      fecha_carga: parseFechaCarga(cells[idx.fecha_carga]),
    });
    porSucursal.set(sucursal, (porSucursal.get(sucursal) || 0) + 1);
    if (!minFecha || fecha < minFecha) minFecha = fecha;
    if (!maxFecha || fecha > maxFecha) maxFecha = fecha;
    if (tipo === 'Ingreso') totalIng += monto;
    else if (tipo === 'Egreso') totalEgr += monto;
    if (batch.length >= BATCH) await flush();
  }
  await flush();

  console.log('\n=== Import completo ===');
  console.log('  filas procesadas:', lines.length - 1);
  console.log('  insertadas:      ', inserted);
  console.log('  ya existían:     ', skipped);
  console.log('  errores:         ', errors);
  console.log('  rango fechas:    ', minFecha, '→', maxFecha);
  console.log('  total ingresos:  €' + totalIng.toFixed(2));
  console.log('  total egresos:   €' + totalEgr.toFixed(2));
  console.log('  neto:            €' + (totalIng - totalEgr).toFixed(2));
  console.log('\n  Por sucursal:');
  for (const [s, n] of [...porSucursal.entries()].sort((a, b) => b[1] - a[1])) {
    const soc = sociedadDeSucursal(s) || '(especial)';
    console.log('    ' + s.padEnd(20) + ' ' + String(n).padStart(5) + ' movs  → ' + soc);
  }
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
