const express = require('express');
const { query, one, many, tx } = require('../lib/db');
const { requireAuth } = require('../lib/auth');

const router = express.Router();

router.use(requireAuth);

// ─── CONFIG GLOBAL ─────────────────────────────────────────────────────
router.get('/config', async (req, res) => {
  try {
    const rows = await many('SELECT clave, valor FROM ab_config');
    const cfg = {};
    rows.forEach((r) => { cfg[r.clave] = r.valor; });
    res.json({ config: cfg });
  } catch (e) {
    console.error('[aires.config.get]', e);
    res.status(500).json({ error: 'internal' });
  }
});

router.put('/config', async (req, res) => {
  try {
    const body = req.body || {};
    const allowed = new Set([
      'pctMP', 'pctPersonal', 'pctImpuestos', 'pctPublicidad', 'euroHora',
      'incluirGlovo', 'modoSociedad', 'poolGroups', 'poolProduccion', 'poolEspeciales',
    ]);
    await tx(async (client) => {
      for (const [k, v] of Object.entries(body)) {
        if (!allowed.has(k)) continue;
        await client.query(
          `INSERT INTO ab_config (clave, valor, updated_at) VALUES ($1, $2, NOW())
           ON CONFLICT (clave) DO UPDATE SET valor=EXCLUDED.valor, updated_at=NOW()`,
          [k, JSON.stringify(v)]
        );
      }
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('[aires.config.put]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ─── LOCALES ───────────────────────────────────────────────────────────
router.get('/locales', async (req, res) => {
  try {
    const rows = await many(
      `SELECT id, nombre_display, short_name, grupo, dani_only,
              alquiler::float8 AS alquiler,
              suministros::float8 AS suministros,
              fac_mi_analisis::float8 AS fac_mi_analisis,
              horas_sem_override::float8 AS horas_sem_override,
              orden, updated_at
       FROM ab_locales
       ORDER BY orden ASC, id ASC`
    );
    res.json({ locales: rows });
  } catch (e) {
    console.error('[aires.locales.list]', e);
    res.status(500).json({ error: 'internal' });
  }
});

router.put('/locales/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const exists = await one('SELECT id FROM ab_locales WHERE id=$1', [id]);
    if (!exists) return res.status(404).json({ error: 'local no existe' });
    const fields = ['alquiler', 'suministros', 'fac_mi_analisis', 'horas_sem_override'];
    const sets = [];
    const vals = [];
    let idx = 1;
    for (const f of fields) {
      if (Object.prototype.hasOwnProperty.call(req.body, f)) {
        sets.push(`${f}=$${idx++}`);
        vals.push(req.body[f] === null || req.body[f] === '' ? null : Number(req.body[f]));
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'sin cambios' });
    sets.push('updated_at=NOW()');
    vals.push(id);
    await query(`UPDATE ab_locales SET ${sets.join(', ')} WHERE id=$${idx}`, vals);
    res.json({ ok: true });
  } catch (e) {
    console.error('[aires.locales.put]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ─── PRESUPUESTO ───────────────────────────────────────────────────────
router.get('/presupuesto', async (req, res) => {
  try {
    const anio = req.query.anio ? +req.query.anio : null;
    const mes = req.query.mes ? +req.query.mes : null;
    let sql = `SELECT id, local_id, anio, mes,
                      fac_presupuestada::float8 AS fac_presupuestada,
                      fac_real::float8 AS fac_real,
                      updated_at
               FROM ab_presupuesto`;
    const where = [];
    const vals = [];
    if (anio) { where.push(`anio=$${vals.length+1}`); vals.push(anio); }
    if (mes) { where.push(`mes=$${vals.length+1}`); vals.push(mes); }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY anio, mes, local_id';
    const rows = await many(sql, vals);
    res.json({ presupuesto: rows });
  } catch (e) {
    console.error('[aires.pres.get]', e);
    res.status(500).json({ error: 'internal' });
  }
});

router.put('/presupuesto', async (req, res) => {
  try {
    const { local_id, anio, mes, fac_presupuestada, fac_real } = req.body || {};
    if (!local_id || !anio || !mes) {
      return res.status(400).json({ error: 'local_id/anio/mes requeridos' });
    }
    if (mes < 1 || mes > 12) return res.status(400).json({ error: 'mes inválido' });

    const exists = await one('SELECT id FROM ab_presupuesto WHERE local_id=$1 AND anio=$2 AND mes=$3', [local_id, anio, mes]);
    if (exists) {
      const sets = [];
      const vals = [];
      let idx = 1;
      if (Object.prototype.hasOwnProperty.call(req.body, 'fac_presupuestada')) {
        sets.push(`fac_presupuestada=$${idx++}`);
        vals.push(fac_presupuestada === null || fac_presupuestada === '' ? null : Number(fac_presupuestada));
      }
      if (Object.prototype.hasOwnProperty.call(req.body, 'fac_real')) {
        sets.push(`fac_real=$${idx++}`);
        vals.push(fac_real === null || fac_real === '' ? null : Number(fac_real));
      }
      if (!sets.length) return res.json({ ok: true });
      sets.push('updated_at=NOW()');
      vals.push(exists.id);
      await query(`UPDATE ab_presupuesto SET ${sets.join(', ')} WHERE id=$${idx}`, vals);
    } else {
      await query(
        `INSERT INTO ab_presupuesto (local_id, anio, mes, fac_presupuestada, fac_real)
         VALUES ($1,$2,$3,$4,$5)`,
        [
          local_id, anio, mes,
          fac_presupuestada === undefined || fac_presupuestada === null || fac_presupuestada === '' ? null : Number(fac_presupuestada),
          fac_real === undefined || fac_real === null || fac_real === '' ? null : Number(fac_real),
        ]
      );
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('[aires.pres.put]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ─── HISTORIAL ─────────────────────────────────────────────────────────
router.get('/historial', async (req, res) => {
  try {
    const anio = req.query.anio ? +req.query.anio : null;
    const local_id = req.query.local_id || null;
    const fuente = req.query.fuente || null;
    let sql = `SELECT id, local_id, anio, mes,
                      facturacion::float8 AS facturacion,
                      fuente, created_at
               FROM ab_historial`;
    const where = [];
    const vals = [];
    if (anio) { where.push(`anio=$${vals.length+1}`); vals.push(anio); }
    if (local_id) { where.push(`local_id=$${vals.length+1}`); vals.push(local_id); }
    if (fuente) { where.push(`fuente=$${vals.length+1}`); vals.push(fuente); }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY anio, mes, local_id';
    const rows = await many(sql, vals);
    res.json({ historial: rows });
  } catch (e) {
    console.error('[aires.hist.get]', e);
    res.status(500).json({ error: 'internal' });
  }
});

router.post('/historial', async (req, res) => {
  try {
    const { local_id, anio, mes, facturacion, fuente } = req.body || {};
    if (!local_id || !anio || !mes || facturacion == null || !fuente) {
      return res.status(400).json({ error: 'local_id/anio/mes/facturacion/fuente requeridos' });
    }
    await query(
      `INSERT INTO ab_historial (local_id, anio, mes, facturacion, fuente)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (local_id, anio, mes, fuente)
       DO UPDATE SET facturacion=EXCLUDED.facturacion`,
      [local_id, anio, mes, Number(facturacion), fuente]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[aires.hist.post]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ─── BOOTSTRAP: todo lo que necesita el front en un solo request ──────
router.get('/bootstrap', async (req, res) => {
  try {
    const cfgRows = await many('SELECT clave, valor FROM ab_config');
    const config = {};
    cfgRows.forEach((r) => { config[r.clave] = r.valor; });

    const locales = await many(
      `SELECT id, nombre_display, short_name, grupo, dani_only,
              alquiler::float8 AS alquiler,
              suministros::float8 AS suministros,
              fac_mi_analisis::float8 AS fac_mi_analisis,
              horas_sem_override::float8 AS horas_sem_override,
              orden
       FROM ab_locales
       ORDER BY orden ASC, id ASC`
    );

    const historial = await many(
      `SELECT local_id, anio, mes, facturacion::float8 AS facturacion, fuente
       FROM ab_historial
       ORDER BY anio, mes, local_id`
    );

    const presupuesto = await many(
      `SELECT local_id, anio, mes,
              fac_presupuestada::float8 AS fac_presupuestada,
              fac_real::float8 AS fac_real
       FROM ab_presupuesto
       ORDER BY anio, mes, local_id`
    );

    res.json({ config, locales, historial, presupuesto, user: req.session.user });
  } catch (e) {
    console.error('[aires.bootstrap]', e);
    res.status(500).json({ error: 'internal' });
  }
});

module.exports = router;
