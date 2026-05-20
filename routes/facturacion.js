// /api/v1/facturacion/* — carga manual semanal y agregación a histórico.
//
// Hoy el flujo es manual (input desde el panel). Cuando la API externa
// de facturación esté lista (~30 días) va a llamar al mismo POST con
// header X-Api-Key y fuente='api_sistema'.

const express = require('express');
const { requireAuth } = require('../lib/auth');
const { query, one, many } = require('../lib/db');
const { weeksInMonth, mondayOfIsoWeek, isoStr, addDays, fromIso } = require('../lib/iso-weeks');

const router = express.Router();

// Auth híbrido: o sesión válida (UI), o X-Api-Key válido (integración API).
// Cuando se autentica vía API key, marcamos req._apiAuth para forzar fuente.
function authHybrid(req, res, next) {
  const apiKey = req.get('X-Api-Key');
  const expected = process.env.FACTURACION_API_KEY;
  if (apiKey && expected && apiKey === expected) {
    req._apiAuth = true;
    return next();
  }
  return requireAuth(req, res, next);
}

router.post('/semanal', express.json(), authHybrid, async (req, res) => {
  try {
    const { local_id, anio, semana_iso, importe } = req.body || {};
    let { fecha_lunes, fecha_domingo, fuente } = req.body || {};
    if (!local_id || !anio || !semana_iso || importe == null) {
      return res.status(400).json({ error: 'local_id, anio, semana_iso, importe requeridos' });
    }
    const imp = Number(importe);
    if (!Number.isFinite(imp) || imp < 0) {
      return res.status(400).json({ error: 'importe debe ser un número >= 0' });
    }
    if (!fecha_lunes || !fecha_domingo) {
      const monday = mondayOfIsoWeek(+anio, +semana_iso);
      fecha_lunes = isoStr(monday);
      fecha_domingo = isoStr(addDays(monday, 6));
    }
    const fnt = req._apiAuth ? 'api_sistema' : (fuente || 'manual');

    await query(
      `INSERT INTO ab_facturacion_semanal
         (local_id, anio, semana_iso, fecha_lunes, fecha_domingo, importe, fuente)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (local_id, anio, semana_iso) DO UPDATE
         SET importe = EXCLUDED.importe,
             fuente = EXCLUDED.fuente,
             fecha_lunes = EXCLUDED.fecha_lunes,
             fecha_domingo = EXCLUDED.fecha_domingo,
             creado_en = NOW()`,
      [local_id, +anio, +semana_iso, fecha_lunes, fecha_domingo, imp, fnt]
    );

    // Para cada mes que la semana toque, intentar agregar a ab_historial
    // si todas las semanas del mes ya tienen real cargado.
    const monthsTouched = new Set();
    const lun = fromIso(fecha_lunes);
    for (let i = 0; i < 7; i++) {
      const day = addDays(lun, i);
      monthsTouched.add(`${day.getUTCFullYear()}-${day.getUTCMonth() + 1}`);
    }
    const aggregated = [];
    for (const key of monthsTouched) {
      const [a, mm] = key.split('-').map(Number);
      const ag = await maybeAggregateToHistorial(local_id, a, mm);
      if (ag) aggregated.push(ag);
    }

    res.json({ ok: true, local_id, anio: +anio, semana_iso: +semana_iso, fuente: fnt, aggregated_to_historial: aggregated });
  } catch (e) {
    console.error('[facturacion.semanal.post]', e);
    res.status(500).json({ error: e.message || 'internal' });
  }
});

// Una sola sesión (UI). La integración API no lee, solo escribe.
router.get('/semanal', requireAuth, async (req, res) => {
  try {
    const local_id = req.query.local_id || null;
    const anio = +req.query.anio;
    const mes = +req.query.mes;
    if (!anio || !mes) return res.status(400).json({ error: 'anio y mes requeridos' });

    const semanas = weeksInMonth(anio, mes);
    const isoWeeksList = semanas.map((s) => s.semana_iso);

    // Una query: si local_id es null, devolvemos para TODOS los locales.
    const params = [anio, isoWeeksList];
    let sql = `SELECT local_id, semana_iso,
                      fecha_lunes::text  AS fecha_lunes,
                      fecha_domingo::text AS fecha_domingo,
                      importe::float8    AS importe,
                      fuente,
                      creado_en
               FROM ab_facturacion_semanal
              WHERE anio=$1 AND semana_iso = ANY($2::int[])`;
    if (local_id) { sql += ' AND local_id=$3'; params.push(local_id); }
    const rows = await many(sql, params);

    // Presupuesto mensual para prorratear el estimado por semana.
    const presParams = [anio, mes];
    let presSql = 'SELECT local_id, fac_presupuestada::float8 AS pres FROM ab_presupuesto WHERE anio=$1 AND mes=$2';
    if (local_id) { presSql += ' AND local_id=$3'; presParams.push(local_id); }
    const presRows = await many(presSql, presParams);
    const presByLocal = Object.fromEntries(presRows.map((r) => [r.local_id, +r.pres || 0]));

    const totalDias = semanas.reduce((s, w) => s + w.dias_en_mes, 0);

    // Agrupamos por local.
    const byLocal = {};
    const rowsByLocalWeek = new Map();
    for (const r of rows) rowsByLocalWeek.set(`${r.local_id}|${r.semana_iso}`, r);

    const locales = local_id ? [local_id] : Array.from(new Set([...Object.keys(presByLocal), ...rows.map((r) => r.local_id)]));
    for (const lid of locales) {
      const pres = presByLocal[lid] || 0;
      byLocal[lid] = {
        presupuesto_mes: pres,
        semanas: semanas.map((w) => {
          const r = rowsByLocalWeek.get(`${lid}|${w.semana_iso}`);
          const est = totalDias > 0 ? pres * (w.dias_en_mes / totalDias) : 0;
          const real = r ? +r.importe : null;
          return {
            semana_iso: w.semana_iso,
            fecha_lunes: w.fecha_lunes,
            fecha_domingo: w.fecha_domingo,
            dias_en_mes: w.dias_en_mes,
            presupuesto_estimado: est,
            real,
            fuente: r ? r.fuente : null,
            var_pct: (real != null && est > 0) ? (real - est) / est : null,
          };
        }),
      };
    }

    res.json({ anio, mes, semanas, por_local: byLocal });
  } catch (e) {
    console.error('[facturacion.semanal.get]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// Cuando todas las semanas que tocan un mes están cargadas, escribimos
// el total prorrateado en ab_historial con fuente='manual_semanal'.
async function maybeAggregateToHistorial(local_id, anio, mes) {
  const semanas = weeksInMonth(anio, mes);
  const isoWeeksList = semanas.map((s) => s.semana_iso);
  const rows = await many(
    `SELECT semana_iso, importe::float8 AS importe
       FROM ab_facturacion_semanal
      WHERE local_id=$1 AND anio=$2 AND semana_iso = ANY($3::int[])`,
    [local_id, anio, isoWeeksList]
  );
  if (rows.length !== semanas.length) return null;
  const byWeek = new Map(rows.map((r) => [r.semana_iso, +r.importe]));

  // Total prorrateado: cada semana contribuye importe × (dias_en_mes/7).
  let total = 0;
  for (const w of semanas) {
    const imp = byWeek.get(w.semana_iso) || 0;
    total += imp * (w.dias_en_mes / 7);
  }

  await query(
    `INSERT INTO ab_historial (local_id, anio, mes, facturacion, fuente)
     VALUES ($1,$2,$3,$4,'manual_semanal')
     ON CONFLICT (local_id, anio, mes, fuente) DO UPDATE
       SET facturacion = EXCLUDED.facturacion`,
    [local_id, anio, mes, Math.round(total * 100) / 100]
  );
  return { local_id, anio, mes, facturacion: Math.round(total * 100) / 100, fuente: 'manual_semanal' };
}

module.exports = router;
