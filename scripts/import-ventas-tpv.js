// Importador de ventas TPV → ab_ventas_tpv.
//
// Lee un .xlsx con esquema de 22 columnas (Fecha/Año/Mes/Semana/Día/
// Familia/Categorías/Producto/Cantidad/Base/Total/Coste/Margen/Local/
// TPV/Perfil/Usuario/Centro Venta/Descuento/Promoción/Periodo).
//
// El TPV genera 3 tipos de fila intercaladas:
//   1) Sub-total diario     → col[0] = 'DD/MM/YYYY'                  → ignorar
//   2) Cabecera de ticket   → col[0] = 'DD/MM/YYYY -> T/NNNNNN'      → ignorar
//   3) Línea de producto    → col[0] = null + col[8] = 'Producto'   → IMPORTAR
//
// Idempotencia: borra el upload anterior con el mismo (nombre_archivo,
// fecha_desde, fecha_hasta) antes de reimportar — la FK con
// ON DELETE CASCADE limpia las líneas hijas.
//
// Uso:
//   node scripts/import-ventas-tpv.js <archivo.xlsx> [<archivo2.xlsx> ...]
//
// Variables de entorno requeridas: DATABASE_URL.

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { one, many, query, tx } = require('../lib/db');

// ─── Parsers ──────────────────────────────────────────────────────────

// Excel exporta números con coma como separador de miles y punto como
// decimal: "3,277.000" → 3277.000. También maneja "1.000" como mil
// (no como uno) sólo si tiene punto antes del decimal completo de 3
// dígitos. Para el TPV de Aires el formato consistente es:
//   "1.000"           → cantidad 1 unidad (3 decimales)
//   "17,244.42"       → 17 244,42 €
// Usamos un parser tolerante que confía en la cantidad de dígitos
// después del último separador.
function parseNum(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (!s) return null;
  // Si tiene coma Y punto, el último símbolo es el decimal.
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let normalized;
  if (lastComma >= 0 && lastDot >= 0) {
    if (lastDot > lastComma) {
      // 17,244.42 → 17244.42
      normalized = s.replace(/,/g, '');
    } else {
      // 17.244,42 → 17244.42
      normalized = s.replace(/\./g, '').replace(',', '.');
    }
  } else if (lastComma >= 0) {
    // Solo coma: si tiene 1-2 dígitos tras la coma asumimos decimal.
    const tras = s.length - lastComma - 1;
    normalized = tras <= 2 ? s.replace(',', '.') : s.replace(/,/g, '');
  } else {
    normalized = s;
  }
  const n = parseFloat(normalized);
  return Number.isFinite(n) ? n : null;
}

function parseFechaDDMMYYYY(v) {
  if (!v) return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm}-${dd}`;
}

// Normaliza el nombre del local: trim + colapsa espacios + uppercase.
//   "THADER  " → "THADER"
//   "elche centro" → "ELCHE CENTRO"
function normalizarLocal(v) {
  if (!v) return null;
  return String(v).trim().replace(/\s+/g, ' ').toUpperCase();
}

function normalizarTexto(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

// ─── Reconocimiento del tipo de fila ──────────────────────────────────

function tipoDeFila(row) {
  const col0 = row[0];
  const producto = row[8];
  if (col0 == null && producto && String(producto).trim() !== '') return 'producto';
  if (col0 && /^\d{2}\/\d{2}\/\d{4}\s*->\s*T\//.test(String(col0))) return 'ticket';
  if (col0 && /^\d{2}\/\d{2}\/\d{4}\s*$/.test(String(col0))) return 'subtotal';
  return 'otra';
}

// ─── Procesamiento del archivo ────────────────────────────────────────

const COL = {
  FECHA: 1, ANIO: 2, MES: 3, SEMANA: 4, DIA: 5,
  FAMILIA: 6, CATEGORIAS: 7, PRODUCTO: 8,
  CANTIDAD: 9, BASE: 10, TOTAL: 11, COSTE: 12, MARGEN: 13,
  LOCAL: 14, TPV: 15, PERFIL: 16, USUARIO: 17, CENTRO_VENTA: 18,
  DESCUENTO: 19, PROMOCION: 20, PERIODO: 21,
};

function leerArchivo(filePath) {
  console.log(`[import] leyendo ${path.basename(filePath)}…`);
  const wb = XLSX.readFile(filePath, { cellDates: false });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error('XLSX sin hojas');
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: null });

  const productos = [];
  const stats = { subtotal: 0, ticket: 0, producto: 0, otra: 0 };
  let fechaMin = null, fechaMax = null;
  const locales = new Set();
  const coste_anomalo = [];

  // Saltamos la fila 0 (headers).
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r.length) continue;
    const tipo = tipoDeFila(r);
    stats[tipo]++;
    if (tipo !== 'producto') continue;

    // Parsing.
    const fecha = parseFechaDDMMYYYY(r[COL.FECHA]);
    const anio = parseInt(r[COL.ANIO], 10);
    const mes  = parseInt(r[COL.MES], 10);
    const semana = parseInt(r[COL.SEMANA], 10);
    const dia  = parseInt(r[COL.DIA], 10);
    const producto = normalizarTexto(r[COL.PRODUCTO]);
    const local = normalizarLocal(r[COL.LOCAL]);
    const cantidad = parseNum(r[COL.CANTIDAD]);
    if (!fecha || !producto || !local || cantidad == null) continue;
    if (!Number.isFinite(anio) || !Number.isFinite(mes) || !Number.isFinite(semana) || !Number.isFinite(dia)) {
      continue;
    }

    const coste = parseNum(r[COL.COSTE]);
    if (coste != null && coste > 500) coste_anomalo.push({ fecha, producto, local, coste });

    productos.push({
      fecha, anio, mes, semana, dia,
      familia:      normalizarTexto(r[COL.FAMILIA]),
      categorias:   normalizarTexto(r[COL.CATEGORIAS]),
      producto,
      cantidad,
      base:    parseNum(r[COL.BASE]),
      total:   parseNum(r[COL.TOTAL]),
      coste,
      margen:  parseNum(r[COL.MARGEN]),
      local,
      tpv:          normalizarTexto(r[COL.TPV]),
      centro_venta: normalizarTexto(r[COL.CENTRO_VENTA]),
      perfil:       normalizarTexto(r[COL.PERFIL]),
      usuario:      normalizarTexto(r[COL.USUARIO]),
      descuento:    normalizarTexto(r[COL.DESCUENTO]),
      promocion:    normalizarTexto(r[COL.PROMOCION]),
      periodo:      normalizarTexto(r[COL.PERIODO]),
    });
    locales.add(local);
    if (!fechaMin || fecha < fechaMin) fechaMin = fecha;
    if (!fechaMax || fecha > fechaMax) fechaMax = fecha;
  }

  return {
    productos,
    stats,
    fecha_desde: fechaMin,
    fecha_hasta: fechaMax,
    locales: [...locales].sort(),
    coste_anomalo,
  };
}

// ─── Persistencia ─────────────────────────────────────────────────────

async function importarArchivo(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error('archivo no existe: ' + filePath);
  }
  const nombre_archivo = path.basename(filePath);
  const parsed = leerArchivo(filePath);
  const { productos, stats, fecha_desde, fecha_hasta, locales, coste_anomalo } = parsed;

  console.log(`[import] ${nombre_archivo}: ${productos.length} productos · ${stats.ticket} tickets · ${stats.subtotal} subtotales diarios · ${locales.length} locales · ${fecha_desde} → ${fecha_hasta}`);

  if (!productos.length) {
    console.warn('[import] sin filas de producto válidas, salgo');
    return null;
  }

  // Idempotencia: si existe un upload anterior con mismo nombre +
  // mismo rango, lo borramos (cascade limpia ab_ventas_tpv).
  const prev = await one(
    `SELECT id FROM ab_ventas_uploads
      WHERE nombre_archivo = $1 AND fecha_desde = $2 AND fecha_hasta = $3
      ORDER BY id DESC LIMIT 1`,
    [nombre_archivo, fecha_desde, fecha_hasta]
  );
  if (prev) {
    console.log(`[import] re-import detectado (upload #${prev.id}) → borro filas y meta anteriores`);
    await query('DELETE FROM ab_ventas_uploads WHERE id = $1', [prev.id]);
  }

  // Insert metadata.
  const periodoDesc = (() => {
    const meses = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
    const [yA, mA] = fecha_desde.split('-').map(Number);
    const [yB, mB] = fecha_hasta.split('-').map(Number);
    if (yA === yB && mA === mB) return `${meses[mA - 1]} ${yA}`;
    if (yA === yB) return `${meses[mA - 1]} – ${meses[mB - 1]} ${yA}`;
    return `${meses[mA - 1]} ${yA} – ${meses[mB - 1]} ${yB}`;
  })();

  const upload = await one(
    `INSERT INTO ab_ventas_uploads
      (nombre_archivo, periodo_descripcion, fecha_desde, fecha_hasta,
       total_lineas, locales_detectados, estado, subido_por)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'procesando', NULL)
     RETURNING id`,
    [nombre_archivo, periodoDesc, fecha_desde, fecha_hasta,
     productos.length, JSON.stringify(locales)]
  );
  const uploadId = upload.id;

  // Batch insert por chunks de 500 (parametrizado, evita "too many parameters").
  const COLS = ['fecha','anio','mes','semana','dia','familia','categorias','producto',
                'cantidad','base','total','coste','margen','local','tpv','centro_venta',
                'perfil','usuario','descuento','promocion','periodo','upload_id'];
  const N = COLS.length;
  const CHUNK = 400;
  let inserted = 0;
  await tx(async (client) => {
    for (let i = 0; i < productos.length; i += CHUNK) {
      const slice = productos.slice(i, i + CHUNK);
      const values = [];
      const params = [];
      slice.forEach((p, idx) => {
        const off = idx * N;
        values.push('(' + Array.from({ length: N }, (_, k) => `$${off + k + 1}`).join(',') + ')');
        params.push(
          p.fecha, p.anio, p.mes, p.semana, p.dia,
          p.familia, p.categorias, p.producto,
          p.cantidad, p.base, p.total, p.coste, p.margen,
          p.local, p.tpv, p.centro_venta,
          p.perfil, p.usuario, p.descuento, p.promocion, p.periodo,
          uploadId
        );
      });
      await client.query(
        `INSERT INTO ab_ventas_tpv (${COLS.join(',')}) VALUES ${values.join(',')}`,
        params
      );
      inserted += slice.length;
      if (productos.length > CHUNK) process.stdout.write(`\r[import] insertadas ${inserted}/${productos.length}`);
    }
    if (productos.length > CHUNK) process.stdout.write('\n');
    await client.query(
      `UPDATE ab_ventas_uploads SET estado = 'ok' WHERE id = $1`,
      [uploadId]
    );
  });

  console.log(`[import] ✓ upload #${uploadId} · ${inserted} líneas · ${locales.length} locales`);
  if (coste_anomalo.length) {
    console.log(`[import] ⚠️  ${coste_anomalo.length} líneas con coste > 500 (importadas; revisar en TPV)`);
    for (const x of coste_anomalo.slice(0, 5)) {
      console.log(`         · ${x.fecha} · ${x.local} · ${x.producto} · coste=${x.coste}`);
    }
    if (coste_anomalo.length > 5) console.log(`         · … (+${coste_anomalo.length - 5} más)`);
  }
  return { uploadId, inserted, locales, fecha_desde, fecha_hasta, coste_anomalo: coste_anomalo.length };
}

// ─── CLI ──────────────────────────────────────────────────────────────

async function main() {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('uso: node scripts/import-ventas-tpv.js <archivo1.xlsx> [...]');
    process.exit(1);
  }
  const resumen = [];
  for (const f of files) {
    try {
      const r = await importarArchivo(path.resolve(f));
      if (r) resumen.push({ archivo: path.basename(f), ...r });
    } catch (e) {
      console.error(`[import] ERROR en ${f}:`, e.message);
      console.error(e.stack);
    }
  }
  console.log('\n=== resumen ===');
  for (const r of resumen) {
    console.log(`  • ${r.archivo} → upload #${r.uploadId} · ${r.inserted} líneas · ${r.locales.length} locales · ${r.fecha_desde}…${r.fecha_hasta}` + (r.coste_anomalo ? ` · ${r.coste_anomalo} coste>500` : ''));
  }
  process.exit(0);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { leerArchivo, importarArchivo, parseNum, parseFechaDDMMYYYY, normalizarLocal };
