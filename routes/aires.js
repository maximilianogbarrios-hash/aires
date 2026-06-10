const express = require('express');
const { query, one, many, tx } = require('../lib/db');
const { requireAuth, requirePerm } = require('../lib/auth');

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

// ─── CONFIG · PUT ────────────────────────────────────────────────────
// Requiere config_w (admin/socio/gerente). Para gerente: cada cambio
// numérico queda registrado en ab_parametros_historial con valor anterior
// y nuevo (audita quién bajó margen, subió costos, etc.).
router.put('/config', requirePerm('config_w'), async (req, res) => {
  try {
    const body = req.body || {};
    const allowed = new Set([
      'pctMP', 'pctPersonal', 'pctImpuestos', 'pctPublicidad', 'euroHora',
      'incluirGlovo', 'modoSociedad', 'poolGroups', 'poolProduccion', 'poolEspeciales',
    ]);
    const camposNumericos = new Set(['pctMP','pctPersonal','pctImpuestos','pctPublicidad','euroHora','poolProduccion','poolEspeciales']);
    const email = req.session?.user?.email || 'desconocido';
    // Spec Bloque 2: el log de auditoría aplica a TODOS los roles que pueden
    // editar (admin/socio/gerente). Antes sólo gerente quedaba registrado.
    const debeLoguear = true;

    // Snapshot del estado previo (para diffs en el log).
    const prev = {};
    if (debeLoguear) {
      const rows = await many('SELECT clave, valor FROM ab_config');
      for (const r of rows) prev[r.clave] = r.valor;
    }

    await tx(async (client) => {
      for (const [k, v] of Object.entries(body)) {
        if (!allowed.has(k)) continue;
        await client.query(
          `INSERT INTO ab_config (clave, valor, updated_at) VALUES ($1, $2, NOW())
           ON CONFLICT (clave) DO UPDATE SET valor=EXCLUDED.valor, updated_at=NOW()`,
          [k, JSON.stringify(v)]
        );
        // Log de cambios numéricos para gerente.
        if (debeLoguear && camposNumericos.has(k)) {
          const before = prev[k];
          const beforeNum = (typeof before === 'number' || (typeof before === 'string' && before.trim() !== ''))
            ? Number(before) : null;
          const afterNum = (v == null || v === '') ? null : Number(v);
          if (beforeNum !== afterNum) {
            await client.query(
              `INSERT INTO ab_parametros_historial (usuario_email, campo, valor_anterior, valor_nuevo)
               VALUES ($1, $2, $3, $4)`,
              [email, k, beforeNum, afterNum]
            );
          }
        }
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

const { tabsPermitidas, subTabsPedidosPermitidas, subTabsBancosPermitidas, PERMS } = require('../lib/roles');

// GET /api/v1/aires/parametros/last-mod
// Última modificación registrada en ab_parametros_historial. Devuelve
// { fecha, usuario_email, campo, valor_anterior, valor_nuevo } o {} si
// nunca se modificó.
router.get('/parametros/last-mod', async (req, res) => {
  try {
    const row = await one(
      `SELECT usuario_email, campo, valor_anterior::float8 AS valor_anterior,
              valor_nuevo::float8 AS valor_nuevo, fecha
         FROM ab_parametros_historial ORDER BY fecha DESC LIMIT 1`
    );
    res.json(row || {});
  } catch (e) {
    console.error('[aires.params.lastmod]', e);
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

    // Mejora 8: matriz de pestañas + flags visuales por rol.
    const role = req.session?.user?.role;
    const tabs = role ? tabsPermitidas(role) : [];
    const sub_tabs_pedidos = role ? subTabsPedidosPermitidas(role) : [];
    const sub_tabs_bancos = role ? subTabsBancosPermitidas(role) : [];
    const flags = {
      dashboard_kpis:        !!(role && PERMS.dashboard_kpis.includes(role)),
      vista_sociedad:        !!(role && PERMS.vista_sociedad.includes(role)),
      config_w:              !!(role && PERMS.config_w.includes(role)),
      config_w_log_only:     !!(role && PERMS.config_w_log_only.includes(role)),
      bancos:                !!(role && PERMS.bancos.includes(role)),
      bancos_upload_admin:   !!(role && PERMS.bancos_upload_admin.includes(role)),
      pedidos_pagar:         !!(role && PERMS.pedidos_pagar_w.includes(role)),
      export_w:              !!(role && PERMS.export_w.includes(role)),
      print_w:               !!(role && PERMS.print_w.includes(role)),
      meta_ads_view:         !!(role && PERMS.meta_ads_view.includes(role)),
      meta_ads_admin:        !!(role && PERMS.meta_ads_admin.includes(role)),
    };
    res.json({ config, locales, historial, presupuesto, user: req.session.user, tabs, sub_tabs_pedidos, sub_tabs_bancos, flags });
  } catch (e) {
    console.error('[aires.bootstrap]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ════════════════════════════════════════════════════════════════════
// Simulador de presupuesto de COSTOS por categoría
// (panel al final del tab Presupuesto)
//
// Concepto:
//   · Ingresos PRESUPUESTADOS del mes+scope (fac_presupuestada) →
//     denominador del seed escalado. Fijo, no editable acá.
//   · Seed por categoría = ratio_histórico × ingresos_presupuestados,
//     donde:
//       ratio_histórico = gasto_combinado_cat_mes_anterior /
//                         ingresos_REALES_combinados_mes_anterior
//     ─ gasto_combinado: banco + efectivo, con el anti-doble-conteo
//       de Flujo Total ya aplicado (excluye cajas padre ESPECIALES/
//       PRODUCCIÓN, cuenta solo los prorrateos repartidos en operativas,
//       excluye INTRAGRUPO y traspasos internos). Reusa
//       `agregarPorCategoria` de routes/caja.js — mismo pipeline que
//       el donut combinado, sin duplicar lógica.
//     ─ ingresos_reales_combinados: ingreso TOTAL real del mes-1
//       (banco + efectivo). Fallback en cascada: si 0 → fac_presupuestada
//       del mes-1; si 0 → gasto_total_anterior (degradación graceful).
//   · Persiste por (anio, mes, scope, categoria) en
//     ab_presupuesto_costos_categoria.
//
// Antes (#1, sólo banco): NÓMINAS aparecía con €30k (banco) e ignoraba
// los ~€85k mensuales en efectivo → seed total subestimado, neto seed
// falsamente POSITIVO. Ahora: NÓMINAS combinado ~€115k, neto seed
// coherente con el neto real de Flujo Total.
// ════════════════════════════════════════════════════════════════════

const cajaRouter = require('./caja');
const agregarPorCategoria = cajaRouter.agregarPorCategoria;
const loadCatDisplayCaja  = cajaRouter.loadCatDisplay;

const VALID_SCOPES = new Set(['sin_elche', 'solo_elche', 'todas']);

// Filtro de scope sobre ab_locales para la facturación presupuestada
// (denominador del seed escalado).
function scopeFilterPresupuesto(scope) {
  if (scope === 'sin_elche')  return 'l.dani_only = FALSE';
  if (scope === 'solo_elche') return 'l.dani_only = TRUE';
  return 'TRUE';
}

function periodoAnterior(anio, mes) {
  if (mes <= 1) return { anio: anio - 1, mes: 12 };
  return { anio, mes: mes - 1 };
}
function mesStartIso(anio, mes) {
  return `${anio}-${String(mes).padStart(2, '0')}-01`;
}
function mesEndIso(anio, mes) {
  const last = new Date(anio, mes, 0).getDate();
  return `${anio}-${String(mes).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}

async function ingresosPresupuestadosScope(anio, mes, scope) {
  const r = await one(
    `SELECT COALESCE(SUM(p.fac_presupuestada), 0)::float8 AS total
       FROM ab_presupuesto p
       JOIN ab_locales l ON l.id = p.local_id
      WHERE p.anio = $1 AND p.mes = $2
        AND ${scopeFilterPresupuesto(scope)}`,
    [anio, mes]
  );
  return r.total || 0;
}

// Mapea scope del simulador → sociedad_id que entiende agregarPorCategoria
// (el helper acepta 'sin_elche' / 'solo_elche' / slug específico / null).
function scopeToSociedadId(scope) {
  if (scope === 'sin_elche' || scope === 'solo_elche') return scope;
  return null; // 'todas' → sin filtro
}

// Llama al agregador combinado del módulo Caja con un req mock que
// replica los parámetros que usaría /api/v1/caja/donut-categorias para
// el mes+scope dados. Devuelve {catAgg, ingresoTotalReal} ya con el
// anti-doble-conteo aplicado.
async function gastoCombinadoMes(req, anio, mes, scope) {
  const sociedad_id = scopeToSociedadId(scope);
  const reqMock = {
    session: req.session, // necesario para esAdminLike (PERIODO_FLOOR_NO_ADMIN)
    query: {
      desde: mesStartIso(anio, mes),
      hasta: mesEndIso(anio, mes),
      incluir_especiales: 'false',  // forzado FALSE → coherente con Flujo Total
      incluir_prorrateo:  'true',
    },
  };
  if (sociedad_id) reqMock.query.sociedad_id = sociedad_id;
  const { catAgg } = await agregarPorCategoria(reqMock, 'todo');
  let ingresoTotal = 0;
  const porCategoria = [];
  for (const [cat, v] of catAgg.entries()) {
    const egreso = (v.banco_egr || 0) + (v.caja_egr || 0);
    const ingreso = (v.banco_ing || 0) + (v.caja_ing || 0);
    ingresoTotal += ingreso;
    if (egreso > 0) {
      porCategoria.push({
        categoria: cat,
        total: egreso,
        banco_egreso: v.banco_egr || 0,
        efectivo_egreso: v.caja_egr || 0,
        n_movs: v.n_movs || 0,
      });
    }
  }
  porCategoria.sort((a, b) => b.total - a.total);
  return { ingresoTotal, porCategoria };
}

// GET /presupuesto-costos/seed?anio=&mes=&scope=
router.get('/presupuesto-costos/seed', async (req, res) => {
  try {
    const anio = parseInt(req.query.anio, 10);
    const mes = parseInt(req.query.mes, 10);
    const scope = String(req.query.scope || 'sin_elche');
    if (!anio || !mes || !VALID_SCOPES.has(scope)) {
      return res.status(400).json({ error: 'anio, mes y scope válido requeridos' });
    }
    const prev = periodoAnterior(anio, mes);
    const [ingresosActuales, ingresosPresupAnt, combinadoAnt, catDisplayMap] = await Promise.all([
      ingresosPresupuestadosScope(anio, mes, scope),
      ingresosPresupuestadosScope(prev.anio, prev.mes, scope),
      gastoCombinadoMes(req, prev.anio, prev.mes, scope),
      loadCatDisplayCaja().catch(() => new Map()),
    ]);
    const gastosAnt = combinadoAnt.porCategoria;
    const ingresosRealesAnt = combinadoAnt.ingresoTotal;
    const totalGastosAnt = gastosAnt.reduce((s, x) => s + x.total, 0);

    // Cascada para el denominador del ratio: real → presupuestado → gasto total.
    let baseRatio = ingresosRealesAnt;
    let baseRatioFuente = 'ingresos_reales_anteriores';
    if (!(baseRatio > 0)) {
      baseRatio = ingresosPresupAnt;
      baseRatioFuente = baseRatio > 0 ? 'ingresos_presupuestados_anteriores' : baseRatioFuente;
    }
    if (!(baseRatio > 0)) {
      baseRatio = totalGastosAnt;
      baseRatioFuente = baseRatio > 0 ? 'gastos_totales_anteriores' : null;
    }

    const categorias = gastosAnt.map((g) => {
      const ratio = baseRatio > 0 ? g.total / baseRatio : 0;
      const monto_seed = Math.round(ratio * ingresosActuales * 100) / 100;
      return {
        codigo: g.categoria,
        nombre_display: catDisplayMap.get(g.categoria) || g.categoria,
        ratio_historico: ratio,
        monto_anterior: Math.round(g.total * 100) / 100,
        // Desglose informativo banco vs efectivo del mes anterior.
        anterior_banco:    Math.round((g.banco_egreso || 0) * 100) / 100,
        anterior_efectivo: Math.round((g.efectivo_egreso || 0) * 100) / 100,
        monto_seed,
      };
    });
    const totalSeed = categorias.reduce((s, c) => s + c.monto_seed, 0);

    res.json({
      anio, mes, scope,
      periodo_anterior: prev,
      ingresos_presupuestados: Math.round(ingresosActuales * 100) / 100,
      ingresos_reales_anteriores: Math.round(ingresosRealesAnt * 100) / 100,
      ingresos_presupuestados_anteriores: Math.round(ingresosPresupAnt * 100) / 100,
      total_gastos_seed: Math.round(totalSeed * 100) / 100,
      neto_seed: Math.round((ingresosActuales - totalSeed) * 100) / 100,
      base_ratio: baseRatioFuente,
      fuente_gasto: 'combinado_banco_efectivo', // marca explícita del cambio
      categorias,
    });
  } catch (e) {
    console.error('[aires.presupuesto-costos.seed]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// GET /presupuesto-costos?anio=&mes=&scope=
// Devuelve lo guardado por el user para ese mes+scope. Si no hay nada
// guardado, devuelve categorias=[] (el frontend usa el seed entonces).
router.get('/presupuesto-costos', async (req, res) => {
  try {
    const anio = parseInt(req.query.anio, 10);
    const mes = parseInt(req.query.mes, 10);
    const scope = String(req.query.scope || 'sin_elche');
    if (!anio || !mes || !VALID_SCOPES.has(scope)) {
      return res.status(400).json({ error: 'anio, mes y scope válido requeridos' });
    }
    // ORDER BY updated_at DESC: si por algún motivo quedaran duplicados
    // (defense in depth tras migration 32), el frontend hace Map.set
    // por categoria — el ÚLTIMO set wins; ordenando DESC el último
    // procesado sería el más viejo, así el Map se queda con el más
    // reciente como primer set. Tras el UNIQUE nuevo no debería haber
    // duplicados, pero el ORDER explícito lo blinda.
    const rows = await many(
      `SELECT categoria, monto::float8 AS monto, updated_at
         FROM ab_presupuesto_costos_categoria
        WHERE anio = $1 AND mes = $2 AND scope = $3
        ORDER BY updated_at DESC`,
      [anio, mes, scope]
    );
    res.json({ anio, mes, scope, categorias: rows, n: rows.length });
  } catch (e) {
    console.error('[aires.presupuesto-costos.get]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// PUT /presupuesto-costos — bulk upsert. Body:
// { anio, mes, scope, categorias: [{categoria, monto}, ...] }
router.put('/presupuesto-costos', express.json({ limit: '256kb' }), async (req, res) => {
  try {
    const { anio, mes, scope, categorias } = req.body || {};
    if (!Number.isInteger(anio) || !Number.isInteger(mes) || !VALID_SCOPES.has(scope)) {
      return res.status(400).json({ error: 'anio, mes y scope válido requeridos' });
    }
    if (!Array.isArray(categorias)) {
      return res.status(400).json({ error: 'categorias[] requerido' });
    }
    // UPSERT por (anio, mes, scope, categoria) — sin user_id en la key
    // (migration 32). Antes el ON CONFLICT incluía user_id que siempre
    // es NULL → NULL≠NULL en Postgres → cada save insertaba fila nueva.
    // Resultado del fix: 1 fila por categoría, monto pisado en cada save.
    let saved = 0;
    let inserted = 0;
    let updated = 0;
    for (const c of categorias) {
      const cat = String(c?.categoria || '').trim();
      const monto = Number(c?.monto);
      if (!cat || !Number.isFinite(monto)) continue;
      const r = await query(
        `INSERT INTO ab_presupuesto_costos_categoria (anio, mes, scope, categoria, monto, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (anio, mes, scope, categoria) DO UPDATE
           SET monto = EXCLUDED.monto, updated_at = NOW()
         RETURNING (xmax = 0) AS was_insert`,
        [anio, mes, scope, cat, monto]
      );
      saved++;
      if (r.rows[0]?.was_insert) inserted++; else updated++;
    }
    res.json({ ok: true, saved, inserted, updated });
  } catch (e) {
    console.error('[aires.presupuesto-costos.put]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// DELETE /presupuesto-costos?anio=&mes=&scope= — restaura al seed
// (borra todas las filas guardadas para ese mes+scope; el frontend
// luego vuelve a usar el seed devuelto por /seed).
router.delete('/presupuesto-costos', async (req, res) => {
  try {
    const anio = parseInt(req.query.anio, 10);
    const mes = parseInt(req.query.mes, 10);
    const scope = String(req.query.scope || 'sin_elche');
    if (!anio || !mes || !VALID_SCOPES.has(scope)) {
      return res.status(400).json({ error: 'anio, mes y scope válido requeridos' });
    }
    const r = await query(
      `DELETE FROM ab_presupuesto_costos_categoria
        WHERE anio = $1 AND mes = $2 AND scope = $3`,
      [anio, mes, scope]
    );
    res.json({ ok: true, deleted: r.rowCount });
  } catch (e) {
    console.error('[aires.presupuesto-costos.delete]', e);
    res.status(500).json({ error: 'internal' });
  }
});

module.exports = router;
