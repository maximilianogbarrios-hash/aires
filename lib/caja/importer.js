// Importador idempotente del archivo "Control de Cajas" → ab_caja_movimientos.
//
// Extraído de scripts/import-caja.js para que pueda ser invocado tanto
// desde el CLI (script) como desde un endpoint HTTP (upload manual desde
// el tab Efectivo). NO duplica lógica de parseo / upsert.
//
// API pública:
//   parseCsvLine(line)              → array de celdas (separador ';', quoting con '"')
//   parseFechaCarga(s)              → 'YYYY-MM-DD' o null
//   parseResumen(metadataLines)     → array {sucursal, primer_mov, …, saldo_actual, n_movimientos}
//   xlsxBufferToCsvText(buffer)     → convierte .xls/.xlsx a CSV con separador ';'
//                                     respetando líneas '#' y bloque ## RESUMEN
//   importCajaCsvText(rawText, opts) → orquesta TODO el import desde un string
//                                       crudo. Devuelve un reporte completo.
//
// El upsert preserva el patrón del script v2: idempotente por id externo,
// detecta inserts vs updates vs unchanged via xmax + WHERE IS DISTINCT FROM,
// y persiste el bloque RESUMEN en ab_caja_saldos_externos para la
// reconciliación.

const { sociedadDeSucursal, normalizarSucursal } = require('./sucursales');

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

// Parsea la sección "## RESUMEN" del CSV.
//
// El bloque RESUMEN puede tener:
//   - una línea cabecera `##;sucursal;primer_mov;ultimo_mov;total_ingresos;
//     total_egresos;saldo_actual;n_movimientos[;columnas_extra...]`
//   - filas de datos `##;ELCHE;2025-07-09;2026-06-08;123.45;67.89;...`
//
// TOLERANCIA: si vienen columnas extra (ej. n_prorrateos_incluidos al
// final), las ignoramos. Detección por NOMBRE cuando existe cabecera;
// fallback a las posiciones legacy (1..7) si no hay cabecera o la
// cabecera no tiene los nombres esperados.
function parseResumen(metadataLines) {
  let header = null;          // mapa nombre → índice (si hay cabecera)
  const out = [];
  for (const ln of metadataLines) {
    if (!ln.startsWith('##')) continue;
    const cells = parseCsvLine(ln).map((c) => c.trim());
    // Detectar cabecera: alguno de los nombres conocidos en cells.
    const lower = cells.map((c) => c.toLowerCase());
    const hayNombres = lower.includes('sucursal') || lower.includes('saldo_actual');
    if (hayNombres && !header) {
      header = {};
      for (let i = 0; i < lower.length; i++) header[lower[i]] = i;
      continue; // No es fila de datos.
    }
    if (cells.length < 8) continue;
    // Posiciones según header si existe, sino legacy:
    //   cells = ['##', sucursal, primer_mov, ultimo_mov, total_ing,
    //            total_egr, saldo_actual, n_mov, (extras)]
    const get = (name, fallbackIdx) => {
      if (header && header[name] !== undefined) return cells[header[name]];
      return cells[fallbackIdx];
    };
    const sucursalRaw = get('sucursal', 1);
    if (!sucursalRaw) continue;
    const sucursal = normalizarSucursal(sucursalRaw);
    out.push({
      sucursal,
      primer_mov:     get('primer_mov', 2) || null,
      ultimo_mov:     get('ultimo_mov', 3) || null,
      total_ingresos: Number(get('total_ingresos', 4)) || 0,
      total_egresos:  Number(get('total_egresos', 5)) || 0,
      saldo_actual:   Number(get('saldo_actual', 6)) || 0,
      n_movimientos:  parseInt(get('n_movimientos', 7), 10) || 0,
    });
  }
  // Defensivo: fusión OFICINA/Oficina (el sistema externo las trata como una sola).
  const dedup = new Map();
  for (const r of out) {
    if (!dedup.has(r.sucursal)) { dedup.set(r.sucursal, r); continue; }
    const prev = dedup.get(r.sucursal);
    prev.total_ingresos += r.total_ingresos;
    prev.total_egresos  += r.total_egresos;
    prev.saldo_actual   += r.saldo_actual;
    prev.n_movimientos  += r.n_movimientos;
    if (r.primer_mov && (!prev.primer_mov || r.primer_mov < prev.primer_mov)) prev.primer_mov = r.primer_mov;
    if (r.ultimo_mov && (!prev.ultimo_mov || r.ultimo_mov > prev.ultimo_mov)) prev.ultimo_mov = r.ultimo_mov;
  }
  return [...dedup.values()];
}

// Convierte un buffer .xls/.xlsx al MISMO formato CSV que ya consume
// el parser (separador `;`). Usa la librería `xlsx` (ya dependencia
// del proyecto). Lee el primer sheet, lo serializa con xlsx.utils.
// Los Excel del Control de Cajas tienen las líneas '#' como filas con
// una sola celda — sheet_to_csv las preserva tal cual.
function xlsxBufferToCsvText(buffer) {
  const XLSX = require('xlsx');
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, raw: false });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error('Excel sin hojas');
  const ws = wb.Sheets[sheetName];
  return XLSX.utils.sheet_to_csv(ws, { FS: ';', strip: false, blankrows: false });
}

// Helper: aplica las migraciones in-place que ya hacía el script CLI.
// Idempotente; si las columnas/tablas existen no hace nada.
async function applyMigrationInPlace(query) {
  await query(`ALTER TABLE ab_caja_movimientos
                ADD COLUMN IF NOT EXISTS categoria_caja VARCHAR(40)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_caja_categoria
                ON ab_caja_movimientos(categoria_caja)`);
  await query(`CREATE TABLE IF NOT EXISTS ab_caja_saldos_externos (
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
  // Unificar legacy 'Oficina' → 'OFICINA'.
  await query(`UPDATE ab_caja_movimientos SET sucursal='OFICINA'
                WHERE sucursal='Oficina'`);
}

async function upsertResumen(query, resumen, fuente) {
  for (const r of resumen) {
    await query(
      `INSERT INTO ab_caja_saldos_externos
         (sucursal, primer_mov, ultimo_mov, total_ingresos, total_egresos,
          saldo_actual, n_movimientos, fuente, imported_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, NOW())
       ON CONFLICT (sucursal) DO UPDATE SET
         primer_mov     = EXCLUDED.primer_mov,
         ultimo_mov     = EXCLUDED.ultimo_mov,
         total_ingresos = EXCLUDED.total_ingresos,
         total_egresos  = EXCLUDED.total_egresos,
         saldo_actual   = EXCLUDED.saldo_actual,
         n_movimientos  = EXCLUDED.n_movimientos,
         fuente         = EXCLUDED.fuente,
         imported_at    = NOW()`,
      [r.sucursal, r.primer_mov, r.ultimo_mov, r.total_ingresos,
       r.total_egresos, r.saldo_actual, r.n_movimientos, fuente]
    );
  }
}

// Orquesta TODO el import desde un string CSV crudo. Compatible con el
// CLI legacy: aceptar opts.queryFn (función query(sql, vals)→{rows,rowCount})
// o usar el helper de lib/db por default. Devuelve un objeto reporte
// listo para serializar como JSON.
//
// opts:
//   fuente     → nombre del archivo / fuente (default 'upload')
//   queryFn    → fn (sql, params) → Promise<{rows, rowCount}> (default usa lib/db)
//   logger     → fn(msg) opcional para logs progresivos (default no-op)
async function importCajaCsvText(rawText, opts = {}) {
  const fuente = opts.fuente || 'upload';
  const logger = typeof opts.logger === 'function' ? opts.logger : () => {};
  let queryFn = opts.queryFn;
  if (!queryFn) {
    // Lazy require para evitar acoplar el CLI con el DB pool por default.
    const db = require('../db');
    queryFn = (sql, vals) => db.query(sql, vals);
  }
  // Wrapper: db.query devuelve {rows,rowCount}; pool.query también.
  const q = (sql, vals) => queryFn(sql, vals);

  const raw = String(rawText || '').replace(/^﻿/, ''); // strip BOM
  const allLines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);

  // Localizar dinámicamente la cabecera real de movimientos.
  let headerIdx = -1;
  for (let i = 0; i < allLines.length; i++) {
    if (/^id;fecha;hora/i.test(allLines[i])) { headerIdx = i; break; }
  }
  if (headerIdx < 0) throw new Error('Cabecera de movimientos no encontrada (línea "id;fecha;hora;…")');

  const metadataLines = allLines.slice(0, headerIdx);
  const header = parseCsvLine(allLines[headerIdx]).map((h) => h.trim());
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  for (const req of ['id', 'fecha', 'sucursal', 'tipo', 'monto']) {
    if (idx[req] === undefined) throw new Error('Falta columna requerida en cabecera: ' + req);
  }
  const hasCategoria = idx.categoria !== undefined;

  await applyMigrationInPlace(q);

  // Parsear y persistir RESUMEN.
  const resumen = parseResumen(metadataLines);
  await upsertResumen(q, resumen, fuente);
  logger(`[resumen] ${resumen.length} cajas con saldo externo persistidas`);

  // Snapshot pre-import.
  const before = await q('SELECT COUNT(*)::int n FROM ab_caja_movimientos', []);
  const nBefore = before.rows[0].n;

  let inserted = 0, updated = 0, unchanged = 0, errors = 0;
  const porSucursal = new Map();
  let minFecha = null, maxFecha = null;
  let totalIng = 0, totalEgr = 0;
  const idsVistos = new Set();
  const sucursalesArchivo = new Set();
  const idsDuplicadosEnCsv = [];

  const BATCH = 500;
  let batch = [];

  async function flush() {
    if (!batch.length) return;
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
      const r = await q(sql, vals);
      let ins = 0, upd = 0;
      for (const row of r.rows) { if (row.was_insert) ins++; else upd++; }
      inserted += ins;
      updated += upd;
      unchanged += batch.length - ins - upd;
    } catch (e) {
      logger('error en lote (ids ' + batch[0].id + '..' + batch[batch.length-1].id + '): ' + e.message);
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
      idsDuplicadosEnCsv.push(id);
      continue;
    }
    idsVistos.add(id);
    sucursalesArchivo.add(sucursal);

    const metodoRaw = (cells[idx.metodo_pago] || '').trim();
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

  const after = await q('SELECT COUNT(*)::int n, MIN(fecha)::text mn, MAX(fecha)::text mx FROM ab_caja_movimientos', []);
  const a = after.rows[0];

  // Cajas desconocidas: aparecen en el archivo pero no tienen regla en
  // ab_caja_mapeo_sociedades. Solo reportar — el admin las atribuye luego
  // en el editor de mapeo.
  let cajasDesconocidas = [];
  try {
    const map = await q(
      `SELECT caja_origen FROM ab_caja_mapeo_sociedades WHERE activa = TRUE`,
      []
    );
    const conocidas = new Set(map.rows.map((r) => r.caja_origen));
    cajasDesconocidas = [...sucursalesArchivo].filter((s) => !conocidas.has(s));
  } catch (e) {
    // Tabla puede no existir en deploy fresco — tolerante.
  }

  return {
    ok: true,
    fuente,
    archivo: {
      n_filas_procesadas: idsVistos.size,
      n_filas_duplicadas_en_csv: idsDuplicadosEnCsv.length,
      rango_fechas: { desde: minFecha, hasta: maxFecha },
      total_ingresos: Math.round(totalIng * 100) / 100,
      total_egresos: Math.round(totalEgr * 100) / 100,
      neto: Math.round((totalIng - totalEgr) * 100) / 100,
    },
    upsert: {
      insertadas_nuevas: inserted,
      actualizadas:      updated,
      ya_presentes_sin_cambios: unchanged,
      errores:           errors,
    },
    db: {
      antes: nBefore,
      despues: a.n,
      delta: a.n - nBefore,
      rango_total: { desde: a.mn, hasta: a.mx },
    },
    cajas: {
      en_archivo: [...sucursalesArchivo].sort(),
      desconocidas_en_mapeo: cajasDesconocidas.sort(),
    },
    por_sucursal: [...porSucursal.entries()]
      .sort((x, y) => y[1] - x[1])
      .map(([s, n]) => ({ sucursal: s, n_movs: n, sociedad: sociedadDeSucursal(s) || null })),
    resumen_externo: {
      n_cajas: resumen.length,
    },
  };
}

module.exports = {
  parseCsvLine,
  parseFechaCarga,
  parseResumen,
  xlsxBufferToCsvText,
  importCajaCsvText,
};
