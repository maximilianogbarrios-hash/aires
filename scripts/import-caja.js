// Import del CSV histórico de caja a ab_caja_movimientos.
// Uso: node scripts/import-caja.js <ruta-csv>
//      DATABASE_URL=... node scripts/import-caja.js cajas_historico_completo_v2.csv
//
// CSV v2 esperado (separador ';', quote '"', BOM UTF-8). Estructura:
//   - líneas '#'         → metadatos (rango, totales, leyenda)
//   - bloque "## RESUMEN" + "##;..."  → saldos por sucursal del sistema
//     externo "Control de Cajas". Se persisten en ab_caja_saldos_externos
//     para reconciliación.
//   - cabecera v2:
//       id;fecha;hora;mes_texto;sucursal;tipo;categoria;subtipo;
//       metodo_pago;monto;saldo_acumulado_caja;observaciones;fecha_carga
//   - 10.986 filas de movimientos.
//
// Idempotente: la PK ab_caja_movimientos.id ES el id del CSV externo
// (decisión histórica del importador v1). UPSERT por id externo. Aplica
// migration in-place para agregar categoria_caja (campo nuevo en v2).

require('dotenv').config();
const fs = require('fs');
const { Pool } = require('pg');
const { sociedadDeSucursal, normalizarSucursal } = require('../lib/caja/sucursales');

// Parser CSV simple para separador `;` y quoting con `"`. Tolerante a CRLF/LF y BOM.
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
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : null;
}

// Migration: agregar columna categoria_caja, crear tabla de saldos
// externos, unificar 'Oficina' → 'OFICINA' en filas pre-existentes.
async function applyMigration(pool) {
  await pool.query(`ALTER TABLE ab_caja_movimientos
                    ADD COLUMN IF NOT EXISTS categoria_caja VARCHAR(40)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_caja_categoria
                    ON ab_caja_movimientos(categoria_caja)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ab_caja_saldos_externos (
    sucursal        VARCHAR PRIMARY KEY,
    primer_mov      DATE,
    ultimo_mov      DATE,
    total_ingresos  NUMERIC,
    total_egresos   NUMERIC,
    saldo_actual    NUMERIC,
    n_movimientos   INTEGER,
    fuente          TEXT,
    imported_at     TIMESTAMPTZ DEFAULT NOW()
  )`);
  // Unificar 'Oficina' (10 filas) con 'OFICINA' (25) — sistema externo
  // reporta una sola caja. UPDATE no choca con PK (cada mov tiene id único).
  const r = await pool.query(
    `UPDATE ab_caja_movimientos SET sucursal='OFICINA'
      WHERE sucursal='Oficina' RETURNING id`
  );
  if (r.rowCount > 0) {
    console.log(`[migration] unificadas ${r.rowCount} filas 'Oficina' → 'OFICINA'`);
  }
}

// Parsea la sección "## RESUMEN" del CSV. Devuelve array de
// {sucursal, primer_mov, ultimo_mov, total_ingresos, total_egresos,
//  saldo_actual, n_movimientos}.
function parseResumen(lines) {
  const out = [];
  // Las filas de resumen arrancan con '##;'. Cabecera arranca con '## RESUMEN'.
  for (const ln of lines) {
    if (!ln.startsWith('##;')) continue;
    const cells = parseCsvLine(ln);
    // cells = ['##', sucursal, primer_mov, ultimo_mov, total_ing, total_egr,
    //          saldo_actual, n_mov]
    if (cells.length < 8) continue;
    const sucursalRaw = cells[1];
    const sucursal = normalizarSucursal(sucursalRaw);
    out.push({
      sucursal,
      primer_mov: cells[2] || null,
      ultimo_mov: cells[3] || null,
      total_ingresos: Number(cells[4]) || 0,
      total_egresos: Number(cells[5]) || 0,
      saldo_actual: Number(cells[6]) || 0,
      n_movimientos: parseInt(cells[7], 10) || 0,
    });
  }
  // Si el CSV reporta 'OFICINA' y 'Oficina' separadas (no es el caso del
  // v2 actual pero defensivo), las fusionamos a una sola fila canónica.
  const dedup = new Map();
  for (const r of out) {
    if (!dedup.has(r.sucursal)) { dedup.set(r.sucursal, r); continue; }
    const prev = dedup.get(r.sucursal);
    prev.total_ingresos += r.total_ingresos;
    prev.total_egresos += r.total_egresos;
    prev.saldo_actual += r.saldo_actual;
    prev.n_movimientos += r.n_movimientos;
    if (r.primer_mov && (!prev.primer_mov || r.primer_mov < prev.primer_mov)) prev.primer_mov = r.primer_mov;
    if (r.ultimo_mov && (!prev.ultimo_mov || r.ultimo_mov > prev.ultimo_mov)) prev.ultimo_mov = r.ultimo_mov;
  }
  return [...dedup.values()];
}

async function upsertResumen(pool, resumen, fuente) {
  for (const r of resumen) {
    await pool.query(
      `INSERT INTO ab_caja_saldos_externos
         (sucursal, primer_mov, ultimo_mov, total_ingresos, total_egresos,
          saldo_actual, n_movimientos, fuente, imported_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, NOW())
       ON CONFLICT (sucursal) DO UPDATE SET
         primer_mov = EXCLUDED.primer_mov,
         ultimo_mov = EXCLUDED.ultimo_mov,
         total_ingresos = EXCLUDED.total_ingresos,
         total_egresos = EXCLUDED.total_egresos,
         saldo_actual = EXCLUDED.saldo_actual,
         n_movimientos = EXCLUDED.n_movimientos,
         fuente = EXCLUDED.fuente,
         imported_at = NOW()`,
      [r.sucursal, r.primer_mov, r.ultimo_mov, r.total_ingresos,
       r.total_egresos, r.saldo_actual, r.n_movimientos, fuente]
    );
  }
}

async function main() {
  const path = process.argv[2] || 'cajas_historico_completo_v2.csv';
  if (!fs.existsSync(path)) {
    console.error('CSV no encontrado: ' + path);
    process.exit(1);
  }
  const raw = fs.readFileSync(path, 'utf8').replace(/^﻿/, ''); // strip BOM
  const allLines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);

  // Localizar la cabecera real de movimientos (línea que arranca con "id;fecha;hora").
  let headerIdx = -1;
  for (let i = 0; i < allLines.length; i++) {
    if (/^id;fecha;hora/i.test(allLines[i])) { headerIdx = i; break; }
  }
  if (headerIdx < 0) { console.error('Cabecera de movimientos no encontrada'); process.exit(1); }

  const metadataLines = allLines.slice(0, headerIdx);
  const header = parseCsvLine(allLines[headerIdx]).map((h) => h.trim());
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  for (const req of ['id', 'fecha', 'sucursal', 'tipo', 'monto']) {
    if (idx[req] === undefined) {
      console.error('falta columna requerida: ' + req);
      process.exit(1);
    }
  }
  const hasCategoria = idx.categoria !== undefined;
  if (!hasCategoria) {
    console.warn('[warn] CSV no incluye columna `categoria`, se persistirá NULL en categoria_caja');
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL,
                          ssl: { rejectUnauthorized: false } });

  await applyMigration(pool);

  // Parsear y persistir RESUMEN.
  const resumen = parseResumen(metadataLines);
  const csvBaseName = path.split(/[\\/]/).pop();
  await upsertResumen(pool, resumen, csvBaseName);
  console.log(`[resumen] ${resumen.length} cajas con saldo externo persistidas`);

  // Snapshot pre-import para reportar diff.
  const before = await pool.query('SELECT COUNT(*)::int n FROM ab_caja_movimientos');
  const nBefore = before.rows[0].n;

  let inserted = 0, updated = 0, unchanged = 0, errors = 0;
  const porSucursal = new Map();
  let minFecha = null, maxFecha = null;
  let totalIng = 0, totalEgr = 0;
  const idsVistos = new Set();

  const BATCH = 500;
  let batch = [];

  async function flush() {
    if (!batch.length) return;
    // UPSERT por id. Detectamos insert vs update vs unchanged comparando
    // xmin (versión de tupla) — si cambió hubo write efectivo. Más simple:
    // RETURNING xmax — xmax=0 ⇒ insert; sino update.
    const vals = [];
    const phs = [];
    for (let i = 0; i < batch.length; i++) {
      const r = batch[i];
      const b = i * 12;
      phs.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11},$${b+12})`);
      vals.push(r.id, r.fecha, r.hora, r.sucursal, r.sociedad_id, r.tipo,
                r.subtipo, r.metodo_pago, r.monto, r.observaciones,
                r.fecha_carga, r.categoria_caja);
    }
    // ON CONFLICT DO UPDATE solo si difiere algún campo (evita escribir
    // 10.986 filas idénticas en cada re-run). Detección de fila escrita
    // vía xmax: 0 = insert nuevo, ≠0 = update efectivo.
    const sql = `
      INSERT INTO ab_caja_movimientos
        (id, fecha, hora, sucursal, sociedad_id, tipo, subtipo, metodo_pago,
         monto, observaciones, fecha_carga, categoria_caja)
      VALUES ${phs.join(',')}
      ON CONFLICT (id) DO UPDATE SET
        fecha          = EXCLUDED.fecha,
        hora           = EXCLUDED.hora,
        sucursal       = EXCLUDED.sucursal,
        sociedad_id    = EXCLUDED.sociedad_id,
        tipo           = EXCLUDED.tipo,
        subtipo        = EXCLUDED.subtipo,
        metodo_pago    = EXCLUDED.metodo_pago,
        monto          = EXCLUDED.monto,
        observaciones  = EXCLUDED.observaciones,
        fecha_carga    = EXCLUDED.fecha_carga,
        categoria_caja = EXCLUDED.categoria_caja
      WHERE
        ab_caja_movimientos.fecha          IS DISTINCT FROM EXCLUDED.fecha
        OR ab_caja_movimientos.hora        IS DISTINCT FROM EXCLUDED.hora
        OR ab_caja_movimientos.sucursal    IS DISTINCT FROM EXCLUDED.sucursal
        OR ab_caja_movimientos.sociedad_id IS DISTINCT FROM EXCLUDED.sociedad_id
        OR ab_caja_movimientos.tipo        IS DISTINCT FROM EXCLUDED.tipo
        OR ab_caja_movimientos.subtipo     IS DISTINCT FROM EXCLUDED.subtipo
        OR ab_caja_movimientos.metodo_pago IS DISTINCT FROM EXCLUDED.metodo_pago
        OR ab_caja_movimientos.monto       IS DISTINCT FROM EXCLUDED.monto
        OR ab_caja_movimientos.observaciones IS DISTINCT FROM EXCLUDED.observaciones
        OR ab_caja_movimientos.fecha_carga IS DISTINCT FROM EXCLUDED.fecha_carga
        OR ab_caja_movimientos.categoria_caja IS DISTINCT FROM EXCLUDED.categoria_caja
      RETURNING (xmax = 0) AS was_insert`;
    try {
      const r = await pool.query(sql, vals);
      let ins = 0, upd = 0;
      for (const row of r.rows) { if (row.was_insert) ins++; else upd++; }
      inserted += ins;
      updated += upd;
      unchanged += batch.length - ins - upd;
    } catch (e) {
      console.error('error en lote (ids ' + batch[0].id + '..' + batch[batch.length-1].id + '):', e.message);
      errors += batch.length;
    }
    batch = [];
  }

  for (let li = headerIdx + 1; li < allLines.length; li++) {
    const cells = parseCsvLine(allLines[li]);
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
    if (idsVistos.has(id)) {
      console.warn(`[warn] id duplicado en CSV: ${id} (línea ${li + 1}) — ignorado`);
      continue;
    }
    idsVistos.add(id);

    const metodoRaw = (cells[idx.metodo_pago] || '').trim();
    // 3 filas tienen metodo_pago vacío — tratar como 'Efectivo'.
    const metodo_pago = metodoRaw || 'Efectivo';

    batch.push({
      id,
      fecha,
      hora: cells[idx.hora] || null,
      sucursal,
      sociedad_id,
      tipo,
      subtipo: cells[idx.subtipo] || null,
      metodo_pago,
      monto,
      observaciones: cells[idx.observaciones] || null,
      fecha_carga: parseFechaCarga(cells[idx.fecha_carga]),
      categoria_caja: hasCategoria ? (cells[idx.categoria] || null) : null,
    });
    porSucursal.set(sucursal, (porSucursal.get(sucursal) || 0) + 1);
    if (!minFecha || fecha < minFecha) minFecha = fecha;
    if (!maxFecha || fecha > maxFecha) maxFecha = fecha;
    if (tipo === 'Ingreso') totalIng += monto;
    else if (tipo === 'Egreso') totalEgr += monto;
    if (batch.length >= BATCH) await flush();
  }
  await flush();

  const after = await pool.query('SELECT COUNT(*)::int n, MIN(fecha)::text mn, MAX(fecha)::text mx FROM ab_caja_movimientos');
  const a = after.rows[0];

  console.log('\n=== Import completo ===');
  console.log('  filas procesadas:', idsVistos.size);
  console.log('  insertadas nuevas:', inserted);
  console.log('  actualizadas:    ', updated);
  console.log('  sin cambios:     ', unchanged);
  console.log('  errores:         ', errors);
  console.log('  rango CSV:       ', minFecha, '→', maxFecha);
  console.log('  total ingresos:  €' + totalIng.toFixed(2));
  console.log('  total egresos:   €' + totalEgr.toFixed(2));
  console.log('  neto:            €' + (totalIng - totalEgr).toFixed(2));
  console.log(`\n  DB antes: ${nBefore} filas`);
  console.log(`  DB después: ${a.n} filas (rango ${a.mn} → ${a.mx})`);
  console.log('\n  Por sucursal:');
  for (const [s, n] of [...porSucursal.entries()].sort((a, b) => b[1] - a[1])) {
    const soc = sociedadDeSucursal(s) || '(especial)';
    console.log('    ' + s.padEnd(20) + ' ' + String(n).padStart(5) + ' movs  → ' + soc);
  }
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
