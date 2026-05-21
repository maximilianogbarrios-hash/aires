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

// ─── PRESUPUESTO · CONTEXTO (tendencias + semanas ISO) ────────────────
// GET /presupuesto/contexto?periodo=YYYY-MM
//
// Fuentes (en orden de preferencia por celda mensual):
//   - ab_historial fuente LIKE '%_real' → real auditado (gana).
//   - ab_historial fuente='manual_semanal' → agregación auto desde
//     ab_facturacion_semanal cuando se completaron todas las semanas.
//   - ab_presupuesto.fac_presupuestada → fallback (flag (P) en UI).
//
// Semanas: el desglose ahora es por semana ISO (lunes-domingo) y se
// devuelven las que tocan el mes con sus fechas, estimado prorrateado
// por días-en-mes y real cargado desde ab_facturacion_semanal.
const presWeeklyCache = { ts: 0, byLocal: null };
const PRES_WEEKLY_TTL_MS = 60 * 60 * 1000;
const DEFAULT_PESOS_SEMANALES = [0.20, 0.22, 0.23, 0.22, 0.13];
const { weeksInMonth: isoWeeksInMonth } = require('../lib/iso-weeks');

function weekIdxOfDay(day) {
  if (day <= 7) return 0;
  if (day <= 14) return 1;
  if (day <= 21) return 2;
  if (day <= 28) return 3;
  return 4;
}

async function computeWeeklyWeights() {
  // Promedio simple: para cada (local, mes histórico) calculamos el peso
  // de cada semana sobre el total del mes, y luego promediamos esos pesos
  // entre todos los meses disponibles. Excluimos meses con total ≤ 0.
  const rows = await many(
    `SELECT local_id,
            DATE_TRUNC('month', fecha_cierre)::date AS mes,
            EXTRACT(DAY FROM fecha_cierre)::int    AS dia,
            SUM(importe_neto)::float8              AS neto
       FROM ab_cierres_tpv
      WHERE importe_neto IS NOT NULL
      GROUP BY local_id, mes, dia`
  );
  // bucket[localId][mesKey] = [s1..s5]
  const bucket = new Map();
  for (const r of rows) {
    if (!r.local_id) continue;
    const mesKey = r.mes instanceof Date ? r.mes.toISOString().slice(0, 7) : String(r.mes).slice(0, 7);
    const wIdx = weekIdxOfDay(+r.dia);
    if (!bucket.has(r.local_id)) bucket.set(r.local_id, new Map());
    const perMes = bucket.get(r.local_id);
    if (!perMes.has(mesKey)) perMes.set(mesKey, [0, 0, 0, 0, 0]);
    perMes.get(mesKey)[wIdx] += +r.neto || 0;
  }
  const byLocal = {};
  for (const [localId, perMes] of bucket.entries()) {
    const acc = [0, 0, 0, 0, 0];
    let n = 0;
    for (const arr of perMes.values()) {
      const tot = arr.reduce((s, v) => s + v, 0);
      if (tot <= 0) continue;
      for (let i = 0; i < 5; i++) acc[i] += arr[i] / tot;
      n += 1;
    }
    if (n > 0) {
      byLocal[localId] = acc.map((v) => v / n);
    }
  }
  return byLocal;
}

async function getWeeklyWeights() {
  const now = Date.now();
  if (presWeeklyCache.byLocal && now - presWeeklyCache.ts < PRES_WEEKLY_TTL_MS) {
    return presWeeklyCache.byLocal;
  }
  const byLocal = await computeWeeklyWeights();
  presWeeklyCache.byLocal = byLocal;
  presWeeklyCache.ts = now;
  return byLocal;
}

router.get('/presupuesto/contexto', async (req, res) => {
  try {
    const periodo = String(req.query.periodo || '').trim();
    const m = /^(\d{4})-(\d{1,2})$/.exec(periodo);
    if (!m) return res.status(400).json({ error: 'periodo inválido (formato YYYY-MM)' });
    const anio = +m[1];
    const mes = +m[2];
    if (mes < 1 || mes > 12) return res.status(400).json({ error: 'mes fuera de rango' });

    // Meses necesarios (este año + anterior). Manejamos cross-year en los 3M.
    const targets = []; // [{anio, mes, tag}]
    const push = (a, mm, tag) => targets.push({ anio: a, mes: mm, tag });
    // mes actual (necesario para el presupuesto que prorratea las semanas)
    push(anio, mes, 'mes_actual');
    // mismo mes año anterior
    push(anio - 1, mes, 'mismo_mes_prev_year');
    // último mes (m-1) — cruzar año si mes=1
    const ultMesAnio = mes === 1 ? anio - 1 : anio;
    const ultMes = mes === 1 ? 12 : mes - 1;
    push(ultMesAnio, ultMes, 'ult_mes_este_anio');
    push(ultMesAnio - 1, ultMes, 'ult_mes_prev_year');
    // 3M previos (m-3, m-2, m-1)
    for (let k = 3; k >= 1; k--) {
      let mm = mes - k;
      let aa = anio;
      if (mm <= 0) { mm += 12; aa -= 1; }
      push(aa, mm, `3m_este_${4 - k}`);
      push(aa - 1, mm, `3m_prev_${4 - k}`);
    }

    // Traemos en paralelo: historial (real auditado o manual_semanal) y
    // presupuesto (fallback) para todos los (anio, mes) que necesitamos.
    // DISTINCT ON prioriza fuente '*_real' sobre 'manual_semanal' (lo
    // explícito del usuario gana sobre la agregación automática).
    const pairs = [...new Set(targets.map((t) => `${t.anio}-${t.mes}`))].map((s) => s.split('-').map(Number));
    const placeholders = pairs.map((_, i) => `($${i*2+1}, $${i*2+2})`).join(',');
    const [histRows, presRows] = await Promise.all([
      many(
        `SELECT DISTINCT ON (local_id, anio, mes)
                local_id, anio, mes, facturacion::float8 AS facturacion, fuente
           FROM ab_historial
          WHERE (fuente LIKE '%_real' OR fuente = 'manual_semanal')
            AND (anio, mes) IN (${placeholders})
          ORDER BY local_id, anio, mes,
                   CASE WHEN fuente LIKE '%_real' THEN 0 ELSE 1 END,
                   created_at DESC`,
        pairs.flat()
      ),
      many(
        `SELECT local_id, anio, mes, fac_presupuestada::float8 AS fac
           FROM ab_presupuesto
          WHERE fac_presupuestada IS NOT NULL
            AND (anio, mes) IN (${placeholders})`,
        pairs.flat()
      ),
    ]);
    const hist = {};
    for (const r of histRows) {
      if (!hist[r.local_id]) hist[r.local_id] = {};
      hist[r.local_id][`${r.anio}-${r.mes}`] = +r.facturacion;
    }
    const pres = {};
    for (const r of presRows) {
      if (!pres[r.local_id]) pres[r.local_id] = {};
      pres[r.local_id][`${r.anio}-${r.mes}`] = +r.fac;
    }

    // Semanas ISO que tocan el mes consultado. Cada semana se prorratea
    // según los días que cae en el mes (S1 puede arrancar el mes anterior).
    const semanasIso = isoWeeksInMonth(anio, mes);
    const diasMes = semanasIso.reduce((s, w) => s + w.dias_en_mes, 0);
    const semanaIsoNums = semanasIso.map((s) => s.semana_iso);

    // Reales semanales cargados manualmente (por todos los locales).
    const facSemRows = await many(
      `SELECT local_id, semana_iso, importe::float8 AS importe, fuente
         FROM ab_facturacion_semanal
        WHERE anio=$1 AND semana_iso = ANY($2::int[])`,
      [anio, semanaIsoNums]
    );
    const facSemByLocalWeek = new Map();
    for (const r of facSemRows) facSemByLocalWeek.set(`${r.local_id}|${r.semana_iso}`, r);

    const pesos = await getWeeklyWeights();

    const ids = new Set([
      ...Object.keys(hist),
      ...Object.keys(pres),
      ...facSemRows.map((r) => r.local_id),
      ...Object.keys(pesos),
    ]);
    // Devuelve { v, src } prefiriendo historial sobre presupuesto.
    const getCell = (id, a, mm) => {
      const k = `${a}-${mm}`;
      const h = hist[id]?.[k];
      if (h != null) return { v: h, src: 'historial' };
      const p = pres[id]?.[k];
      if (p != null) return { v: p, src: 'presupuesto' };
      return { v: null, src: null };
    };
    const porLocal = {};
    for (const id of ids) {
      const k3 = [3, 2, 1].map((kk) => {
        let mm = mes - kk;
        let aa = anio;
        if (mm <= 0) { mm += 12; aa -= 1; }
        return { aa, mm };
      });
      const c3este  = k3.map((p) => getCell(id, p.aa, p.mm));
      const c3prev  = k3.map((p) => getCell(id, p.aa - 1, p.mm));
      const cMm     = getCell(id, anio - 1, mes);
      const cUltE   = getCell(id, ultMesAnio, ultMes);
      const cUltP   = getCell(id, ultMesAnio - 1, ultMes);
      // Semanas ISO del mes: estimado prorrateado + real cargado.
      const presMes = pres[id]?.[`${anio}-${mes}`] ?? null;
      const semanas = semanasIso.map((w) => {
        const peso = diasMes > 0 ? w.dias_en_mes / diasMes : 0;
        const estim = presMes != null ? presMes * peso : null;
        const r = facSemByLocalWeek.get(`${id}|${w.semana_iso}`);
        const real = r ? +r.importe : null;
        return {
          semana_iso: w.semana_iso,
          fecha_lunes: w.fecha_lunes,
          fecha_domingo: w.fecha_domingo,
          dias_en_mes: w.dias_en_mes,
          peso,
          estimado: estim,
          real,
          fuente: r ? r.fuente : null,
        };
      });
      porLocal[id] = {
        fac_mismo_mes_anio_anterior:  cMm.v,
        fac_3meses_este_anio:         c3este.map((c) => c.v),
        fac_3meses_anio_anterior:     c3prev.map((c) => c.v),
        fac_ultimo_mes_este_anio:     cUltE.v,
        fac_ultimo_mes_anio_anterior: cUltP.v,
        // Compat: el front viejo usaba pesos_semanales[5] y real_semanal[5];
        // se mantienen derivados de las semanas ISO mientras migra el front.
        pesos_semanales:              semanas.map((s) => s.peso),
        real_semanal_mes_actual:      semanas.some((s) => s.real != null) ? semanas.map((s) => s.real || 0) : null,
        fuente_3meses_este_anio:      c3este.map((c) => c.src),
        fuente_ultimo_mes_este_anio:  cUltE.src,
        fuente_pesos_semanales:       'prorrata_dias_mes',
        semanas,
      };
    }

    res.json({
      periodo: { anio, mes },
      ult_mes: { anio: ultMesAnio, mes: ultMes },
      por_local: porLocal,
      meta: { weekly_cache_ts: presWeeklyCache.ts },
    });
  } catch (e) {
    console.error('[aires.pres.contexto]', e);
    res.status(500).json({ error: 'internal' });
  }
});

const { tabsPermitidas, PERMS } = require('../lib/roles');

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

    // Mejora 8: matriz de pestañas + flags visuales por rol.
    const role = req.session?.user?.role;
    const tabs = role ? tabsPermitidas(role) : [];
    const flags = {
      dashboard_kpis: !!(role && PERMS.dashboard_kpis.includes(role)),
      vista_sociedad: !!(role && PERMS.vista_sociedad.includes(role)),
      config_w:       !!(role && PERMS.config_w.includes(role)),
      bancos:         !!(role && PERMS.bancos.includes(role)),
      pedidos_pagar:  !!(role && PERMS.pedidos_pagar_w.includes(role)),
    };
    res.json({ config, locales, historial, presupuesto, user: req.session.user, tabs, flags });
  } catch (e) {
    console.error('[aires.bootstrap]', e);
    res.status(500).json({ error: 'internal' });
  }
});

module.exports = router;
