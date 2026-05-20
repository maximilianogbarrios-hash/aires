// /api/v1/bancos/* — módulo bancario.

const express = require('express');
const multer = require('multer');
const { requireAuth } = require('../lib/auth');
const { query, one, many } = require('../lib/db');
const { SOCIEDADES, DIRECCIONES, findSociedad, sociedadDeLocal } = require('../lib/bank/sociedades');
const { parseSantanderBuffer } = require('../lib/bank/parser-santander');
const { parseGetnetBuffer } = require('../lib/bank/parser-getnet');
const bankDb = require('../lib/bank/db');

const router = express.Router();
router.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
});

// ─── METADATA: sociedades + direcciones ────────────────────────────────
router.get('/meta', (req, res) => {
  res.json({ sociedades: SOCIEDADES, direcciones: DIRECCIONES });
});

// ─── UPLOAD EXTRACTO SANTANDER ─────────────────────────────────────────
router.post('/upload-extracto', upload.single('file'), async (req, res) => {
  try {
    const sociedad_id = req.body.sociedad_id;
    const banco = (req.body.banco || 'santander').toLowerCase();
    if (!sociedad_id) return res.status(400).json({ error: 'sociedad_id requerido' });
    if (!findSociedad(sociedad_id)) return res.status(400).json({ error: 'sociedad_id inválido' });
    if (!req.file) return res.status(400).json({ error: 'archivo requerido (campo "file")' });
    if (banco !== 'santander') {
      return res.status(400).json({ error: 'por ahora sólo Santander; Sabadell viene en próxima versión' });
    }

    const parsed = parseSantanderBuffer(req.file.buffer, { sociedad_id, banco });
    if (!parsed.header_found) {
      return res.status(400).json({ error: 'no se encontró la fila de headers (Concepto/Importe)' });
    }

    const { inserted, duplicated } = await bankDb.insertMovimientos(parsed.movimientos);
    const periodos = Array.from(new Set(parsed.movimientos.map((m) => m.periodo)));
    for (const p of periodos) {
      await bankDb.recalcResumenMensual(sociedad_id, p);
      await bankDb.recalcCrucesParaSociedadPeriodo(sociedad_id, p);
    }

    res.json({
      ok: true,
      sociedad_id, banco,
      total_filas: parsed.movimientos.length,
      insertadas: inserted,
      duplicadas: duplicated,
      skipped: parsed.skipped,
      periodos,
      preview: parsed.movimientos.slice(0, 10).map((m) => ({
        fecha: m.fecha, concepto: m.concepto, importe: m.importe,
        categoria: m.categoria, codigo_banco: m.codigo_banco, local_id: m.local_id,
      })),
    });
  } catch (e) {
    console.error('[bancos.upload-extracto]', e);
    res.status(500).json({ error: e.message || 'internal' });
  }
});

// ─── UPLOAD CIERRES TPV (Getnet) ───────────────────────────────────────
router.post('/upload-cierres-tpv', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'archivo requerido (campo "file")' });
    const local_id_override = req.body.local_id || null;

    const parsed = parseGetnetBuffer(req.file.buffer, { local_id_override });
    if (!parsed.header_found) {
      return res.status(400).json({ error: 'no se encontró la fila de headers (Fecha/Bruto/Neto)' });
    }
    if (!parsed.local_id) {
      return res.status(400).json({
        error: 'no se pudo detectar el local; pasá local_id explícito',
        comercio_detectado: parsed.comercio_detectado,
      });
    }
    if (!parsed.sociedad_id) {
      return res.status(400).json({ error: `local ${parsed.local_id} no pertenece a ninguna sociedad conocida` });
    }

    const { inserted, duplicated } = await bankDb.insertCierres(parsed.cierres);
    const periodos = Array.from(new Set(parsed.cierres.map((c) => c.periodo)));
    for (const p of periodos) {
      await bankDb.recalcCrucesParaSociedadPeriodo(parsed.sociedad_id, p);
    }

    // Cruce inmediato para devolver feedback
    const cruces = await many(
      `SELECT periodo, total_bruto_tpv::float8 AS bruto, total_neto_tpv::float8 AS neto,
              total_banco::float8 AS banco, diferencia::float8 AS diferencia,
              tasa_efectiva::float8 AS tasa, estado
       FROM ab_cruces WHERE sociedad_id=$1 AND local_id=$2 AND periodo = ANY($3::text[])
       ORDER BY periodo`,
      [parsed.sociedad_id, parsed.local_id, periodos]
    );

    res.json({
      ok: true,
      local_id: parsed.local_id,
      sociedad_id: parsed.sociedad_id,
      comercio_detectado: parsed.comercio_detectado,
      total_cierres: parsed.cierres.length,
      insertados: inserted,
      duplicados: duplicated,
      skipped: parsed.skipped,
      periodos, cruces,
    });
  } catch (e) {
    console.error('[bancos.upload-cierres]', e);
    res.status(500).json({ error: e.message || 'internal' });
  }
});

// ─── QUERIES ───────────────────────────────────────────────────────────

// Listado paginado de movimientos con filtros.
router.get('/movimientos', async (req, res) => {
  try {
    const sociedad_id = req.query.sociedad_id || null;
    const periodo = req.query.periodo || null;
    const categoria = req.query.categoria || null;
    const banco = req.query.banco || null;
    const local_id = req.query.local_id || null;
    const search = req.query.q || null;
    const limit = Math.min(+req.query.limit || 50, 500);
    const offset = +req.query.offset || 0;

    const where = []; const vals = [];
    if (sociedad_id) { where.push(`sociedad_id=$${vals.length+1}`); vals.push(sociedad_id); }
    if (periodo)     { where.push(`periodo=$${vals.length+1}`);     vals.push(periodo); }
    if (categoria)   { where.push(`categoria=$${vals.length+1}`);   vals.push(categoria); }
    if (banco)       { where.push(`banco=$${vals.length+1}`);       vals.push(banco); }
    if (local_id)    { where.push(`local_id=$${vals.length+1}`);    vals.push(local_id); }
    if (search)      { where.push(`concepto ILIKE $${vals.length+1}`); vals.push(`%${search}%`); }
    const W = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const totalRow = await one(
      `SELECT COUNT(*)::int AS c, COALESCE(SUM(importe), 0)::float8 AS total_importe
         FROM ab_movimientos ${W}`,
      vals
    );
    const rows = await many(
      `SELECT id, sociedad_id, banco, fecha, concepto, importe::float8 AS importe,
              categoria, subcategoria, local_id, codigo_banco, num_documento, periodo
       FROM ab_movimientos ${W}
       ORDER BY fecha DESC, id DESC
       LIMIT $${vals.length+1} OFFSET $${vals.length+2}`,
      [...vals, limit, offset]
    );
    res.json({ total: totalRow.c, total_importe: totalRow.total_importe, limit, offset, rows });
  } catch (e) {
    console.error('[bancos.movimientos]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// Resumen mensual por sociedad (todos los períodos disponibles).
router.get('/resumen', async (req, res) => {
  try {
    const sociedad_id = req.query.sociedad_id || null;
    let sql = `SELECT sociedad_id, periodo,
                      total_ingresos::float8 AS total_ingresos,
                      total_gastos::float8 AS total_gastos,
                      neto::float8 AS neto,
                      detalle_categorias,
                      n_movimientos, updated_at
               FROM ab_resumen_mensual`;
    const vals = [];
    if (sociedad_id) { sql += ' WHERE sociedad_id=$1'; vals.push(sociedad_id); }
    sql += ' ORDER BY sociedad_id, periodo';
    const rows = await many(sql, vals);
    res.json({ resumen: rows });
  } catch (e) {
    console.error('[bancos.resumen]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// Análisis de gastos por categoría/subcategoría.
router.get('/gastos-por-proveedor', async (req, res) => {
  try {
    const sociedad_id = req.query.sociedad_id || null;
    const periodo = req.query.periodo || null;
    const where = ['importe < 0']; const vals = [];
    if (sociedad_id) { where.push(`sociedad_id=$${vals.length+1}`); vals.push(sociedad_id); }
    if (periodo)     { where.push(`periodo=$${vals.length+1}`);     vals.push(periodo); }
    const W = 'WHERE ' + where.join(' AND ');
    const rows = await many(
      `SELECT COALESCE(subcategoria, concepto) AS proveedor,
              categoria,
              SUM(importe)::float8 AS total,
              COUNT(*)::int AS apariciones,
              MIN(fecha) AS desde, MAX(fecha) AS hasta
       FROM ab_movimientos ${W}
       GROUP BY proveedor, categoria
       ORDER BY total ASC
       LIMIT 50`,
      vals
    );
    res.json({ proveedores: rows });
  } catch (e) {
    console.error('[bancos.gastos]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// Cruces TPV vs banco.
router.get('/cruces', async (req, res) => {
  try {
    const sociedad_id = req.query.sociedad_id || null;
    const periodo = req.query.periodo || null;
    const where = []; const vals = [];
    if (sociedad_id) { where.push(`sociedad_id=$${vals.length+1}`); vals.push(sociedad_id); }
    if (periodo)     { where.push(`periodo=$${vals.length+1}`);     vals.push(periodo); }
    const W = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const rows = await many(
      `SELECT sociedad_id, local_id, periodo,
              total_bruto_tpv::float8   AS bruto,
              total_neto_tpv::float8    AS neto,
              total_comision_tpv::float8 AS comision,
              total_banco::float8       AS banco,
              diferencia::float8        AS diferencia,
              tasa_efectiva::float8     AS tasa,
              estado, updated_at
       FROM ab_cruces ${W}
       ORDER BY periodo DESC, sociedad_id, local_id NULLS LAST`,
      vals
    );
    res.json({ cruces: rows });
  } catch (e) {
    console.error('[bancos.cruces]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// Lista de períodos con datos (para selectores).
router.get('/periodos', async (req, res) => {
  try {
    const rows = await many(
      `SELECT DISTINCT periodo FROM ab_movimientos
       UNION
       SELECT DISTINCT periodo FROM ab_cierres_tpv
       ORDER BY periodo`
    );
    res.json({ periodos: rows.map((r) => r.periodo) });
  } catch (e) {
    console.error('[bancos.periodos]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// Recalcular todo (útil tras cambios manuales).
router.post('/recalc', async (req, res) => {
  try {
    const sociedad_id = req.body.sociedad_id;
    const periodo = req.body.periodo;
    if (!sociedad_id || !periodo) return res.status(400).json({ error: 'sociedad_id y periodo requeridos' });
    await bankDb.recalcResumenMensual(sociedad_id, periodo);
    await bankDb.recalcCrucesParaSociedadPeriodo(sociedad_id, periodo);
    res.json({ ok: true });
  } catch (e) {
    console.error('[bancos.recalc]', e);
    res.status(500).json({ error: 'internal' });
  }
});

module.exports = router;
