// /api/v1/pedidos/* — Módulo Pedidos (Materia Prima, Personal, Mix proveedores).
//
// Tablas: ab_proveedores_mix (mix editable por local/categoría) y
//         ab_pedidos_semana (pedidos semanales editables con estado).
//
// Permisos:
//   - pedidos_view  (lectura): admin/socio/gerente/administrativo/pedidos
//   - pedidos_w     (escribir pedidos + confirmar): mismos
//   - pedidos_mix_w (editar % proveedores): sólo admin/socio

const express = require('express');
const { query, one, many, tx } = require('../lib/db');
const { requireAuth, requirePerm } = require('../lib/auth');
const { weeksInMonth, mondayOfIsoWeek, isoStr, addDays } = require('../lib/iso-weeks');
const { normalizarProveedor, esIntraGrupo } = require('../lib/bank/normalizers');
const { sociedadDeLocal } = require('../lib/bank/sociedades');
const { jsonSanitizerMiddleware } = require('../lib/access/sanitize');

const router = express.Router();
router.use(requireAuth);
// Sanitizer transversal: el endpoint /comparativa-bancos cruza con
// ab_movimientos y devuelve concepto crudo de transferencias bancarias,
// donde aparecen los pagos a Raba Buildings sin enmascarar. Defense in
// depth — la lógica de rol vive en lib/access/sanitize.js.
router.use(jsonSanitizerMiddleware);

// Categorías canónicas de Materia Prima (UI/mix). El usuario las puede usar
// libremente como tag; aquí sólo se valida que pertenezca al set.
const CATEGORIAS_MP = ['Carnes', 'Lácteos', 'Verduras', 'Bebidas', 'Packaging', 'Limpieza', 'Otros MP'];

// Mapeo desde categorías nuevas (taxonomía v2 en categorizer.js) a la
// categoría MP del módulo Pedidos.
const CAT_BANCO_TO_MP = {
  PROVEEDOR_CARNES:    'Carnes',
  PROVEEDOR_PANADERIA: 'Otros MP',
  PROVEEDOR_FRITAS:    'Otros MP',
  PROVEEDOR_LACTEOS:   'Lácteos',
  PROVEEDOR_ACEITES:   'Otros MP',
  PROVEEDOR_BEBIDAS:   'Bebidas',
  PROVEEDOR_MAKRO:     'Otros MP',
  PROVEEDOR_LIMPIEZA:  'Limpieza',
  PROVEEDOR_PACKAGING: 'Packaging',
  PROVEEDOR_OTROS:     'Otros MP',
};

// ─── Helpers ──────────────────────────────────────────────────────────
function asNumOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function getConfigCached(_cacheRef) {
  // Sin cache: ab_config se modifica desde UI. La latencia es mínima.
  return many('SELECT clave, valor FROM ab_config').then((rows) => {
    const out = {};
    rows.forEach((r) => { out[r.clave] = r.valor; });
    return out;
  });
}

// Resolución de la semana solicitada: si vienen anio+semana_iso se usan;
// si no, calcula la semana ISO de hoy.
function resolveWeek(req) {
  const anio = req.query.anio ? +req.query.anio : null;
  const semanaIso = req.query.semana_iso ? +req.query.semana_iso : null;
  if (anio && semanaIso) {
    const monday = mondayOfIsoWeek(anio, semanaIso);
    return {
      anio, semana_iso: semanaIso,
      fecha_lunes: isoStr(monday),
      fecha_domingo: isoStr(addDays(monday, 6)),
    };
  }
  // Default: semana ISO actual.
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // isoMonday helper inline
  const dow = (today.getUTCDay() + 6) % 7;
  const mon = new Date(today); mon.setUTCDate(mon.getUTCDate() - dow);
  const t = new Date(mon); t.setUTCDate(t.getUTCDate() + 3); // jueves de la semana
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const sem = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return {
    anio: t.getUTCFullYear(),
    semana_iso: sem,
    fecha_lunes: isoStr(mon),
    fecha_domingo: isoStr(addDays(mon, 6)),
  };
}

// Pesos semanales por local. Si hay 4 o 5 semanas, normalizamos los pesos
// promedio fijos a la cantidad real de semanas del mes. Fallback: equipartido.
const DEFAULT_WEEK_WEIGHTS = [0.20, 0.22, 0.23, 0.22, 0.13];
function normalizeWeights(weights, n) {
  const slice = weights.slice(0, n);
  const sum = slice.reduce((s, v) => s + v, 0);
  return sum > 0 ? slice.map((v) => v / sum) : slice.map(() => 1 / n);
}

// ─── BOOTSTRAP ──────────────────────────────────────────────────────────
// Datos iniciales para la pestaña: locales, config, mix y pedidos de la semana actual.
router.get('/bootstrap', requirePerm('pedidos_view'), async (req, res) => {
  try {
    const week = resolveWeek(req);
    const [config, locales, mix, pedidosSemana] = await Promise.all([
      getConfigCached(),
      many(
        `SELECT id, nombre_display, short_name, grupo, dani_only, orden
           FROM ab_locales ORDER BY orden ASC, id ASC`
      ),
      many(
        `SELECT local_id, proveedor, categoria,
                porcentaje::float8 AS porcentaje, activo, updated_at
           FROM ab_proveedores_mix
          ORDER BY local_id, categoria, proveedor`
      ),
      many(
        `SELECT local_id, anio, semana_iso, proveedor, categoria,
                importe_sugerido::float8 AS importe_sugerido,
                importe_real::float8     AS importe_real,
                estado, notas, updated_at, confirmado_en
           FROM ab_pedidos_semana
          WHERE anio=$1 AND semana_iso=$2`,
        [week.anio, week.semana_iso]
      ),
    ]);
    res.json({
      categorias_mp: CATEGORIAS_MP,
      week, config, locales, mix, pedidos_semana: pedidosSemana,
      user: req.session.user,
    });
  } catch (e) {
    console.error('[pedidos.bootstrap]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ─── PROVEEDORES ACTIVOS ────────────────────────────────────────────────
// Lista blanca de proveedores autorizados en Materia Prima (v1 y v2).
// Compartido entre las dos vistas para que cualquier filtro/autocomplete
// muestre exactamente el mismo set. Modificable mañana desde un panel admin
// editando ab_mp_proveedores_activos sin tocar código.
router.get('/proveedores-activos', requirePerm('pedidos_view'), async (req, res) => {
  try {
    const rows = await many(
      `SELECT proveedor, orden
         FROM ab_mp_proveedores_activos
        WHERE activo = TRUE
        ORDER BY orden, proveedor`
    );
    res.json({ proveedores: rows.map((r) => r.proveedor) });
  } catch (e) {
    console.error('[pedidos.proveedores-activos]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ─── PROVEEDORES MIX ────────────────────────────────────────────────────
router.get('/proveedores-mix', requirePerm('pedidos_view'), async (req, res) => {
  try {
    const local_id = req.query.local_id || null;
    const params = [];
    let sql = `SELECT local_id, proveedor, categoria,
                      porcentaje::float8 AS porcentaje, activo, updated_at
                 FROM ab_proveedores_mix`;
    if (local_id) { sql += ' WHERE local_id=$1'; params.push(local_id); }
    sql += ' ORDER BY local_id, categoria, proveedor';
    const mix = await many(sql, params);
    res.json({ mix, categorias_mp: CATEGORIAS_MP });
  } catch (e) {
    console.error('[pedidos.mix.get]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// PUT bulk: { rows: [{local_id, proveedor, categoria, porcentaje, activo}, ...] }
// Reemplaza el mix de cada (local_id, proveedor, categoria) provisto.
// Soporta también delete: pasar porcentaje=null para borrar la fila.
router.put('/proveedores-mix', requirePerm('pedidos_mix_w'), async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!rows || !rows.length) return res.status(400).json({ error: 'rows[] requerido' });
    let upserted = 0, deleted = 0;
    await tx(async (client) => {
      for (const r of rows) {
        const { local_id, proveedor, categoria } = r;
        if (!local_id || !proveedor || !categoria) continue;
        if (!CATEGORIAS_MP.includes(categoria)) continue;
        if (r.porcentaje === null || r.porcentaje === '__delete__') {
          const d = await client.query(
            'DELETE FROM ab_proveedores_mix WHERE local_id=$1 AND proveedor=$2 AND categoria=$3',
            [local_id, String(proveedor).trim(), categoria]
          );
          deleted += d.rowCount;
          continue;
        }
        const pct = asNumOrNull(r.porcentaje);
        if (pct == null || pct < 0 || pct > 100) continue;
        const activo = r.activo === false ? false : true;
        const u = await client.query(
          `INSERT INTO ab_proveedores_mix (local_id, proveedor, categoria, porcentaje, activo)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (local_id, proveedor, categoria)
           DO UPDATE SET porcentaje=EXCLUDED.porcentaje,
                         activo=EXCLUDED.activo,
                         updated_at=NOW()`,
          [local_id, String(proveedor).trim(), categoria, pct, activo]
        );
        upserted += u.rowCount;
      }
    });
    res.json({ ok: true, upserted, deleted });
  } catch (e) {
    console.error('[pedidos.mix.put]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// POST /proveedores-mix/copiar { from_local_id, to_local_ids: [...] }
// Copia el mix de un local a otros. Útil para "Aplicar a todos".
router.post('/proveedores-mix/copiar', requirePerm('pedidos_mix_w'), async (req, res) => {
  try {
    const { from_local_id, to_local_ids } = req.body || {};
    if (!from_local_id || !Array.isArray(to_local_ids) || !to_local_ids.length) {
      return res.status(400).json({ error: 'from_local_id y to_local_ids[] requeridos' });
    }
    const fuente = await many(
      `SELECT proveedor, categoria, porcentaje::float8 AS porcentaje, activo
         FROM ab_proveedores_mix WHERE local_id=$1`,
      [from_local_id]
    );
    if (!fuente.length) return res.json({ ok: true, copied: 0, note: 'origen sin mix' });
    let copied = 0;
    await tx(async (client) => {
      for (const dest of to_local_ids) {
        if (dest === from_local_id) continue;
        // Limpiar destino y volcar el origen.
        await client.query('DELETE FROM ab_proveedores_mix WHERE local_id=$1', [dest]);
        for (const r of fuente) {
          await client.query(
            `INSERT INTO ab_proveedores_mix (local_id, proveedor, categoria, porcentaje, activo)
             VALUES ($1,$2,$3,$4,$5)`,
            [dest, r.proveedor, r.categoria, r.porcentaje, r.activo]
          );
          copied++;
        }
      }
    });
    res.json({ ok: true, copied, destinos: to_local_ids.length });
  } catch (e) {
    console.error('[pedidos.mix.copiar]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// POST /proveedores-mix/importar-bancos { local_id, meses=6 }
// Calcula el % histórico de cada proveedor de MP en los últimos N meses
// y devuelve la sugerencia (no la guarda — el usuario decide).
router.post('/proveedores-mix/importar-bancos', requirePerm('pedidos_mix_w'), async (req, res) => {
  try {
    const { local_id, meses = 6 } = req.body || {};
    if (!local_id) return res.status(400).json({ error: 'local_id requerido' });
    const n = Math.max(1, Math.min(24, +meses || 6));
    const rows = await many(
      `SELECT subcategoria AS proveedor, categoria, SUM(ABS(importe))::float8 AS total
         FROM ab_movimientos
        WHERE local_id=$1
          AND importe < 0
          AND fecha >= (CURRENT_DATE - ($2::int || ' months')::interval)
          AND categoria = ANY($3::text[])
          AND subcategoria IS NOT NULL
        GROUP BY subcategoria, categoria
        ORDER BY total DESC
        LIMIT 40`,
      [local_id, n, Object.keys(CAT_BANCO_TO_MP)]
    );
    const totalGasto = rows.reduce((s, r) => s + +r.total, 0);
    const sugerencia = rows.map((r) => ({
      proveedor: r.proveedor,
      categoria_mp: CAT_BANCO_TO_MP[r.categoria] || 'Otros MP',
      categoria_banco: r.categoria,
      total_periodo: +r.total,
      porcentaje: totalGasto > 0 ? Math.round((+r.total / totalGasto) * 1000) / 10 : 0,
    }));
    res.json({ local_id, meses: n, total_periodo: totalGasto, sugerencia });
  } catch (e) {
    console.error('[pedidos.mix.import]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ─── MATERIA PRIMA ──────────────────────────────────────────────────────
// GET /pedidos/materia-prima?anio=&semana_iso=&local_id=
// Calcula budget MP por local y por proveedor para la semana indicada.
router.get('/materia-prima', requirePerm('pedidos_view'), async (req, res) => {
  try {
    const week = resolveWeek(req);
    const local_id = req.query.local_id || null;
    const config = await getConfigCached();
    const pctMP = (+config.pctMP || 38) / 100;

    // Locales objetivo.
    const localesParams = [];
    let localesSql = `SELECT id, nombre_display, short_name, grupo, dani_only, orden
                        FROM ab_locales`;
    if (local_id) { localesSql += ' WHERE id=$1'; localesParams.push(local_id); }
    localesSql += ' ORDER BY orden ASC, id ASC';
    const locales = await many(localesSql, localesParams);
    if (!locales.length) return res.json({ week, items: [], kpis: emptyKpis() });

    const localIds = locales.map((l) => l.id);

    // Para prorratear la semana, necesitamos el presupuesto mensual de cada
    // local. La semana puede tocar 2 meses; usamos pesos por días.
    // Construimos pares (anio, mes) implicados por la semana ISO.
    const monday = new Date(week.fecha_lunes + 'T00:00:00Z');
    const monthDays = new Map(); // 'YYYY-M' -> dias_en_semana
    for (let i = 0; i < 7; i++) {
      const day = new Date(monday); day.setUTCDate(day.getUTCDate() + i);
      const k = `${day.getUTCFullYear()}-${day.getUTCMonth() + 1}`;
      monthDays.set(k, (monthDays.get(k) || 0) + 1);
    }
    const pairs = [...monthDays.keys()].map((k) => k.split('-').map(Number));
    const placeholders = pairs.map((_, i) => `($${i * 2 + 2}, $${i * 2 + 3})`).join(',');
    const presRows = await many(
      `SELECT local_id, anio, mes,
              fac_presupuestada::float8 AS fac_presupuestada
         FROM ab_presupuesto
        WHERE local_id = ANY($1::text[])
          AND (anio, mes) IN (${placeholders})`,
      [localIds, ...pairs.flat()]
    );
    const presMap = new Map(); // 'local|anio|mes' -> fac
    for (const r of presRows) {
      presMap.set(`${r.local_id}|${r.anio}|${r.mes}`, +r.fac_presupuestada || 0);
    }

    // Estimación de fac de la semana por local: para cada mes que toca,
    // sumamos fac_mes * (dias_en_semana / dias_del_mes).
    function facSemanaPorLocal(localId) {
      let est = 0;
      for (const [k, diasSem] of monthDays.entries()) {
        const [a, mm] = k.split('-').map(Number);
        const fac = presMap.get(`${localId}|${a}|${mm}`) || 0;
        const lastDay = new Date(Date.UTC(a, mm, 0)).getUTCDate();
        est += fac * (diasSem / lastDay);
      }
      return est;
    }

    // Mix por local — filtrado contra la lista blanca ab_mp_proveedores_activos.
    // El INNER JOIN garantiza que sólo proveedores activos lleguen a la respuesta:
    // las columnas dinámicas de la grilla y los totales por local se derivan
    // exclusivamente de proveedores activos. Pedidos históricos a proveedores
    // ya inactivos siguen en ab_pedidos_semana pero no aparecen en la vista.
    const mixRows = await many(
      `SELECT m.local_id, m.proveedor, m.categoria,
              m.porcentaje::float8 AS porcentaje, m.activo
         FROM ab_proveedores_mix m
         INNER JOIN ab_mp_proveedores_activos a
           ON a.proveedor = m.proveedor AND a.activo = TRUE
        WHERE m.local_id = ANY($1::text[]) AND m.activo = TRUE
        ORDER BY m.local_id, m.categoria, m.proveedor`,
      [localIds]
    );
    const mixByLocal = new Map();
    for (const r of mixRows) {
      if (!mixByLocal.has(r.local_id)) mixByLocal.set(r.local_id, []);
      mixByLocal.get(r.local_id).push(r);
    }

    // Pedidos ya creados de esta semana.
    const pedRows = await many(
      `SELECT local_id, proveedor, categoria,
              importe_sugerido::float8 AS importe_sugerido,
              importe_real::float8     AS importe_real,
              estado, notas, updated_at
         FROM ab_pedidos_semana
        WHERE local_id = ANY($1::text[]) AND anio=$2 AND semana_iso=$3`,
      [localIds, week.anio, week.semana_iso]
    );
    const pedByKey = new Map();
    for (const r of pedRows) pedByKey.set(`${r.local_id}|${r.proveedor}|${r.categoria}`, r);

    // Cruce con ab_movimientos: para los pedidos en estado 'recibido',
    // sumamos pagos del mismo proveedor en la semana ISO completa
    // (lunes-domingo) que sean de la SOCIEDAD del local (no de todas).
    // Antes el cruce distribuía pagos de cualquier sociedad al local,
    // lo que atribuía a ELCHE (hostelero) pagos de smart/murcia/etc.
    const provsRecibidos = new Set(
      pedRows.filter((p) => p.estado === 'recibido').map((p) => p.proveedor)
    );
    const pagadoPorProv = new Map(); // 'local|proveedor' -> total pagado banco
    if (provsRecibidos.size > 0) {
      const movRows = await many(
        `SELECT concepto, categoria, importe::float8 AS importe, sociedad_id
           FROM ab_movimientos
          WHERE importe < 0 AND fecha BETWEEN $1 AND $2`,
        [week.fecha_lunes, week.fecha_domingo]
      );
      for (const m of movRows) {
        if (esIntraGrupo(m.concepto)) continue;
        const { proveedor: prov } = normalizarProveedor(m.concepto, m.categoria);
        if (!provsRecibidos.has(prov)) continue;
        const abs = Math.abs(+m.importe);
        // Distribuimos el pago a los locales que lo tienen marcado
        // recibido Y pertenecen a la sociedad que efectivamente realizó
        // el pago bancario. ELCHE (hostelero) sólo cuenta pagos de
        // sociedad_id='hostelero'.
        for (const ped of pedRows) {
          if (ped.estado !== 'recibido' || ped.proveedor !== prov) continue;
          if (sociedadDeLocal(ped.local_id) !== m.sociedad_id) continue;
          const k = `${ped.local_id}|${ped.proveedor}`;
          pagadoPorProv.set(k, (pagadoPorProv.get(k) || 0) + abs);
        }
      }
    }

    // Componer respuesta por local.
    const items = locales.map((l) => {
      const facSem = facSemanaPorLocal(l.id);
      const budgetMP = facSem * pctMP;
      const mix = mixByLocal.get(l.id) || [];
      const proveedores = mix.map((m) => {
        const sugerido = budgetMP * ((+m.porcentaje || 0) / 100);
        const ped = pedByKey.get(`${l.id}|${m.proveedor}|${m.categoria}`);
        const real = ped ? ped.importe_real : null;
        const variacion = (real != null && sugerido > 0) ? (real - sugerido) / sugerido : null;
        const semaforo = variacion == null ? 'sin_dato'
          : Math.abs(variacion) <= 0.10 ? 'verde'
          : Math.abs(variacion) <= 0.20 ? 'amarillo'
          : 'rojo';
        const pagado_banco = pagadoPorProv.get(`${l.id}|${m.proveedor}`) || null;
        // BUG 2 fix — el cruce bancario compara contra el importe CONFIRMADO
        // (importe_real) cuando existe, o cae al sugerido si el usuario no
        // editó nada. La diferencia es siempre "pago bancario - referencia".
        const refImporte = real != null ? real : sugerido;
        const diferencia_banco = (pagado_banco != null) ? (pagado_banco - refImporte) : null;
        const mismatch_banco = (pagado_banco != null && refImporte > 0)
          ? Math.abs(diferencia_banco) / refImporte > 0.05
          : false;
        return {
          proveedor: m.proveedor,
          categoria: m.categoria,
          porcentaje_mix: +m.porcentaje,
          importe_sugerido: Math.round(sugerido * 100) / 100,
          importe_real: real,
          estado: ped?.estado || 'pendiente',
          notas: ped?.notas || null,
          variacion_pct: variacion == null ? null : Math.round(variacion * 10000) / 100,
          semaforo,
          pagado_banco: pagado_banco != null ? Math.round(pagado_banco * 100) / 100 : null,
          diferencia_banco: diferencia_banco != null ? Math.round(diferencia_banco * 100) / 100 : null,
          mismatch_banco,
          ref_importe: Math.round(refImporte * 100) / 100, // qué se usó como referencia
          updated_at: ped?.updated_at || null,
        };
      });
      const totalPedido = proveedores.reduce((s, p) => s + (p.importe_real ?? p.importe_sugerido ?? 0), 0);
      // Estado global del local en la semana: si todos enviados/recibidos → 'enviado',
      // si alguno pendiente y hoy >= miércoles → 'tardio', si no 'pendiente'.
      const allDispatched = proveedores.length > 0 && proveedores.every((p) => p.estado !== 'pendiente');
      const someDispatched = proveedores.some((p) => p.estado !== 'pendiente');
      const estadoLocal = !proveedores.length ? 'sin_mix'
        : allDispatched ? 'enviado'
        : someDispatched ? 'parcial' : 'pendiente';
      // MEJORA — Diferencia por local: suma (pago banco − confirmado) de los
      // proveedores con dato bancario. % sobre la referencia (real o sugerido).
      // Semáforo: verde ≤±10%, amarillo ±10-20%, rojo >±20%. Sin dato → null.
      const provsConBanco = proveedores.filter((p) => p.pagado_banco != null);
      let diferencia_local = null;
      let diferencia_local_pct = null;
      let diferencia_local_semaforo = 'sin_dato';
      let total_banco_local = null;
      let total_ref_local = null;
      if (provsConBanco.length > 0) {
        total_banco_local = provsConBanco.reduce((s, p) => s + p.pagado_banco, 0);
        total_ref_local = provsConBanco.reduce((s, p) => s + p.ref_importe, 0);
        diferencia_local = total_banco_local - total_ref_local;
        diferencia_local_pct = total_ref_local > 0 ? diferencia_local / total_ref_local : null;
        if (diferencia_local_pct != null) {
          const abs = Math.abs(diferencia_local_pct);
          diferencia_local_semaforo = abs <= 0.10 ? 'verde' : abs <= 0.20 ? 'amarillo' : 'rojo';
        }
      }
      return {
        local_id: l.id, nombre: l.nombre_display, short: l.short_name,
        grupo: l.grupo, dani_only: !!l.dani_only,
        fac_estimada_semana: Math.round(facSem * 100) / 100,
        pct_mp: +config.pctMP || 38,
        budget_mp_semana: Math.round(budgetMP * 100) / 100,
        total_pedido: Math.round(totalPedido * 100) / 100,
        estado_local: estadoLocal,
        // Resumen de diferencia banco vs confirmado (Mejora MP)
        total_banco_local: total_banco_local != null ? Math.round(total_banco_local * 100) / 100 : null,
        total_ref_local: total_ref_local != null ? Math.round(total_ref_local * 100) / 100 : null,
        diferencia_local: diferencia_local != null ? Math.round(diferencia_local * 100) / 100 : null,
        diferencia_local_pct: diferencia_local_pct != null ? Math.round(diferencia_local_pct * 10000) / 100 : null,
        diferencia_local_semaforo,
        proveedores,
      };
    });

    // KPIs globales.
    const totalBudget = items.reduce((s, it) => s + it.budget_mp_semana, 0);
    const totalPedidoReal = items.reduce((s, it) => s + it.proveedores.reduce(
      (ss, p) => ss + (p.importe_real || 0), 0), 0);
    const totalSugerido = items.reduce((s, it) => s + it.proveedores.reduce(
      (ss, p) => ss + (p.importe_sugerido || 0), 0), 0);
    const confirmados = items.reduce((s, it) => s + it.proveedores.filter(
      (p) => p.estado !== 'pendiente').length, 0);
    const pendientes = items.reduce((s, it) => s + it.proveedores.filter(
      (p) => p.estado === 'pendiente').length, 0);
    // KPIs nuevos: pendiente de pago (confirmados pero no pagados) y total pagado.
    const total_pendiente_pago = items.reduce((s, it) => s + it.proveedores.reduce(
      (ss, p) => ss + (p.estado === 'enviado' ? (p.importe_real ?? p.importe_sugerido ?? 0) : 0), 0), 0);
    const total_pagado = items.reduce((s, it) => s + it.proveedores.reduce(
      (ss, p) => ss + (p.estado === 'recibido' ? (p.importe_real ?? p.importe_sugerido ?? 0) : 0), 0), 0);
    // Alerta tardía: hoy >= miércoles (dow 3 con dom=0).
    const today = new Date();
    const dow = today.getDay();
    const tardio = dow >= 3 && items.some((it) => it.estado_local === 'pendiente' || it.estado_local === 'parcial');

    res.json({
      week,
      items,
      kpis: {
        total_budget_mp: Math.round(totalBudget * 100) / 100,
        total_sugerido:  Math.round(totalSugerido * 100) / 100,
        total_pedido_real: Math.round(totalPedidoReal * 100) / 100,
        confirmados, pendientes,
        total_pendiente_pago: Math.round(total_pendiente_pago * 100) / 100,
        total_pagado: Math.round(total_pagado * 100) / 100,
        pct_ejecutado: totalBudget > 0 ? Math.round((totalPedidoReal / totalBudget) * 1000) / 10 : 0,
        alerta_tardia: tardio,
      },
    });
  } catch (e) {
    console.error('[pedidos.mp.get]', e);
    res.status(500).json({ error: 'internal' });
  }
});

function emptyKpis() {
  return {
    total_budget_mp: 0, total_sugerido: 0, total_pedido_real: 0,
    confirmados: 0, pendientes: 0,
    total_pendiente_pago: 0, total_pagado: 0,
    pct_ejecutado: 0, alerta_tardia: false,
  };
}

// PUT /pedidos/pedido — edita importe_real / notas / estado de un pedido puntual.
// Crea la fila si no existe (upsert) para que el usuario pueda capturar antes
// de "confirmar semana".
router.put('/pedido', requirePerm('pedidos_w'), async (req, res) => {
  try {
    const { local_id, anio, semana_iso, proveedor } = req.body || {};
    if (!local_id || !anio || !semana_iso || !proveedor) {
      return res.status(400).json({ error: 'local_id, anio, semana_iso, proveedor requeridos' });
    }
    const categoria = req.body.categoria && CATEGORIAS_MP.includes(req.body.categoria)
      ? req.body.categoria : 'Otros MP';
    const importe_sugerido = asNumOrNull(req.body.importe_sugerido) ?? 0;
    const importe_real = asNumOrNull(req.body.importe_real);
    const estado = ['pendiente','enviado','recibido'].includes(req.body.estado) ? req.body.estado : 'pendiente';
    const notas = req.body.notas == null ? null : String(req.body.notas).slice(0, 500);
    const userId = req.session?.user?.id || null;
    const confirmado = estado !== 'pendiente';

    await query(
      `INSERT INTO ab_pedidos_semana
         (local_id, anio, semana_iso, proveedor, categoria,
          importe_sugerido, importe_real, estado, notas,
          updated_at, confirmado_en, confirmado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::varchar(15),$9, NOW(),
               CASE WHEN $8::varchar(15) <> 'pendiente' THEN NOW() ELSE NULL END,
               CASE WHEN $8::varchar(15) <> 'pendiente' THEN $10::int ELSE NULL END)
       ON CONFLICT (local_id, anio, semana_iso, proveedor)
       DO UPDATE SET
         categoria        = EXCLUDED.categoria,
         importe_sugerido = EXCLUDED.importe_sugerido,
         importe_real     = EXCLUDED.importe_real,
         estado           = EXCLUDED.estado,
         notas            = EXCLUDED.notas,
         updated_at       = NOW(),
         confirmado_en    = CASE WHEN EXCLUDED.estado <> 'pendiente' AND ab_pedidos_semana.confirmado_en IS NULL THEN NOW() ELSE ab_pedidos_semana.confirmado_en END,
         confirmado_por   = CASE WHEN EXCLUDED.estado <> 'pendiente' AND ab_pedidos_semana.confirmado_por IS NULL THEN $10::int ELSE ab_pedidos_semana.confirmado_por END`,
      [local_id, +anio, +semana_iso, String(proveedor).trim(), categoria,
       importe_sugerido, importe_real, estado, notas, userId]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[pedidos.pedido.put]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// PUT /pedidos/marcar-pagado { local_id, anio, semana_iso, proveedor, pagado: true|false }
// Marca como 'recibido' (o vuelve a 'enviado') y cruza con ab_movimientos
// para detectar si el pago bancario del mismo proveedor en esa semana
// coincide con el importe_real cargado.
router.put('/marcar-pagado', requirePerm('pedidos_pagar_w'), async (req, res) => {
  try {
    const { local_id, anio, semana_iso, proveedor } = req.body || {};
    const pagado = req.body.pagado !== false; // default true
    if (!local_id || !anio || !semana_iso || !proveedor) {
      return res.status(400).json({ error: 'local_id, anio, semana_iso, proveedor requeridos' });
    }
    const userId = req.session?.user?.id || null;
    const nuevoEstado = pagado ? 'recibido' : 'enviado';
    // Aceptamos categoria + importe_sugerido del body para poder UPSERT si la
    // fila no existe aún (ej. admin marca pagado en una celda nueva sin
    // importe confirmado previamente).
    const categoria = req.body.categoria && CATEGORIAS_MP.includes(req.body.categoria)
      ? req.body.categoria : 'Otros MP';
    const importeSugIn = asNumOrNull(req.body.importe_sugerido) ?? 0;

    const upserted = await query(
      `INSERT INTO ab_pedidos_semana
         (local_id, anio, semana_iso, proveedor, categoria,
          importe_sugerido, estado, updated_at, confirmado_en, confirmado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7::varchar(15),NOW(),
               CASE WHEN $7::varchar(15)<>'pendiente' THEN NOW() ELSE NULL END,
               CASE WHEN $7::varchar(15)<>'pendiente' THEN $8::int ELSE NULL END)
       ON CONFLICT (local_id, anio, semana_iso, proveedor)
       DO UPDATE SET
         estado          = EXCLUDED.estado,
         updated_at      = NOW(),
         confirmado_en   = CASE WHEN EXCLUDED.estado<>'pendiente' AND ab_pedidos_semana.confirmado_en IS NULL THEN NOW() ELSE ab_pedidos_semana.confirmado_en END,
         confirmado_por  = CASE WHEN EXCLUDED.estado<>'pendiente' AND ab_pedidos_semana.confirmado_por IS NULL THEN $8::int ELSE ab_pedidos_semana.confirmado_por END
       RETURNING importe_real::float8 AS importe_real, importe_sugerido::float8 AS importe_sugerido`,
      [local_id, +anio, +semana_iso, String(proveedor).trim(), categoria,
       importeSugIn, nuevoEstado, userId]
    );
    const fila = upserted.rows[0] || {};
    const importeReal = fila.importe_real ?? fila.importe_sugerido ?? importeSugIn ?? 0;

    // Cruce con ab_movimientos: rango lunes-domingo de la semana ISO,
    // filtrado por la SOCIEDAD del local. Antes el cruce traía pagos de
    // todas las sociedades — lo que atribuía a ELCHE (hostelero) pagos
    // hechos por smart/murcia/etc.
    const monday = mondayOfIsoWeek(+anio, +semana_iso);
    const sunday = addDays(monday, 6);
    const desde = isoStr(monday);
    const hasta = isoStr(sunday);
    const socId = sociedadDeLocal(local_id);
    const movsParams = [desde, hasta];
    let movsSql = `SELECT concepto, categoria, importe::float8 AS importe, fecha::text AS fecha
                     FROM ab_movimientos
                    WHERE importe < 0 AND fecha BETWEEN $1 AND $2`;
    if (socId) {
      movsSql += ' AND sociedad_id = $3';
      movsParams.push(socId);
    }
    const movs = await many(movsSql, movsParams);
    let pagado_banco = 0;
    const matches = [];
    for (const r of movs) {
      if (esIntraGrupo(r.concepto)) continue;
      const { proveedor: prov } = normalizarProveedor(r.concepto, r.categoria);
      if (prov === proveedor) {
        const abs = Math.abs(+r.importe);
        pagado_banco += abs;
        matches.push({ fecha: r.fecha, importe: abs, concepto: r.concepto.slice(0, 80) });
      }
    }
    const diferencia = pagado_banco - importeReal;
    const ratio = importeReal > 0 ? Math.abs(diferencia) / importeReal : null;
    const ok_match = ratio == null ? false : ratio <= 0.05;

    res.json({
      ok: true, estado: nuevoEstado,
      semana: { desde, hasta },
      importe_real: importeReal,
      pagado_banco: Math.round(pagado_banco * 100) / 100,
      diferencia: Math.round(diferencia * 100) / 100,
      ratio_diff: ratio,
      ok_match,
      matches: matches.slice(0, 8),
    });
  } catch (e) {
    console.error('[pedidos.marcar-pagado]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// POST /pedidos/confirmar-semana { local_id, anio, semana_iso, proveedores?: [nombre,...] }
// Marca como 'enviado' todos los pedidos pendientes del local en esa semana
// (o sólo los proveedores indicados). Crea filas faltantes desde el mix actual.
router.post('/confirmar-semana', requirePerm('pedidos_w'), async (req, res) => {
  try {
    const { local_id, anio, semana_iso } = req.body || {};
    if (!local_id || !anio || !semana_iso) {
      return res.status(400).json({ error: 'local_id, anio, semana_iso requeridos' });
    }
    const filtroProvs = Array.isArray(req.body.proveedores) ? req.body.proveedores : null;
    const userId = req.session?.user?.id || null;

    // Crear filas faltantes desde el mix activo, con importe_sugerido calculado.
    const config = await getConfigCached();
    const pctMP = (+config.pctMP || 38) / 100;
    const mixActivo = await many(
      `SELECT proveedor, categoria, porcentaje::float8 AS porcentaje
         FROM ab_proveedores_mix
        WHERE local_id=$1 AND activo=TRUE`,
      [local_id]
    );
    // Estimación fac semana basada en presupuesto mensual.
    const monday = mondayOfIsoWeek(+anio, +semana_iso);
    let facSem = 0;
    const monthDays = new Map();
    for (let i = 0; i < 7; i++) {
      const day = new Date(monday); day.setUTCDate(day.getUTCDate() + i);
      const k = `${day.getUTCFullYear()}-${day.getUTCMonth() + 1}`;
      monthDays.set(k, (monthDays.get(k) || 0) + 1);
    }
    for (const [k, diasSem] of monthDays.entries()) {
      const [a, mm] = k.split('-').map(Number);
      const pres = await one(
        'SELECT fac_presupuestada::float8 AS fac FROM ab_presupuesto WHERE local_id=$1 AND anio=$2 AND mes=$3',
        [local_id, a, mm]
      );
      const lastDay = new Date(Date.UTC(a, mm, 0)).getUTCDate();
      facSem += (+pres?.fac || 0) * (diasSem / lastDay);
    }
    const budgetMP = facSem * pctMP;

    let confirmados = 0;
    await tx(async (client) => {
      for (const m of mixActivo) {
        if (filtroProvs && !filtroProvs.includes(m.proveedor)) continue;
        const sugerido = budgetMP * ((+m.porcentaje || 0) / 100);
        const r = await client.query(
          `INSERT INTO ab_pedidos_semana
             (local_id, anio, semana_iso, proveedor, categoria,
              importe_sugerido, estado, confirmado_en, confirmado_por, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,'enviado', NOW(), $7, NOW())
           ON CONFLICT (local_id, anio, semana_iso, proveedor)
           DO UPDATE SET
             estado='enviado',
             importe_sugerido = CASE WHEN ab_pedidos_semana.importe_sugerido = 0
                                     THEN EXCLUDED.importe_sugerido
                                     ELSE ab_pedidos_semana.importe_sugerido END,
             confirmado_en  = COALESCE(ab_pedidos_semana.confirmado_en, NOW()),
             confirmado_por = COALESCE(ab_pedidos_semana.confirmado_por, $7),
             updated_at     = NOW()
           WHERE ab_pedidos_semana.estado = 'pendiente' OR ab_pedidos_semana.estado IS NULL`,
          [local_id, +anio, +semana_iso, m.proveedor, m.categoria,
           Math.round(sugerido * 100) / 100, userId]
        );
        confirmados += r.rowCount;
      }
    });

    res.json({ ok: true, confirmados, local_id, anio: +anio, semana_iso: +semana_iso });
  } catch (e) {
    console.error('[pedidos.confirmar]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ─── PERSONAL ───────────────────────────────────────────────────────────
// GET /pedidos/personal?anio=&mes=&local_id=
// Devuelve horas disponibles vs cargadas por local y por semana.
router.get('/personal', requirePerm('pedidos_view'), async (req, res) => {
  try {
    const anio = req.query.anio ? +req.query.anio : new Date().getFullYear();
    const mes = req.query.mes ? +req.query.mes : (new Date().getMonth() + 1);
    if (mes < 1 || mes > 12) return res.status(400).json({ error: 'mes inválido' });
    const local_id = req.query.local_id || null;

    const config = await getConfigCached();
    const pctPers = (+config.pctPersonal || 28) / 100;
    const euroHora = +config.euroHora || 12;

    const params = [];
    let sql = `SELECT id, nombre_display, short_name, grupo, dani_only,
                      horas_sem_override::float8 AS horas_sem_override, orden
                 FROM ab_locales`;
    if (local_id) { sql += ' WHERE id=$1'; params.push(local_id); }
    sql += ' ORDER BY orden ASC, id ASC';
    const locales = await many(sql, params);
    if (!locales.length) return res.json({ anio, mes, items: [], kpis: { total_disp: 0, total_cargado: 0, pct_utilizacion: 0, locales_en_rojo: 0 } });

    const localIds = locales.map((l) => l.id);
    // Presupuesto del mes por local
    const presRows = await many(
      `SELECT local_id, fac_presupuestada::float8 AS fac
         FROM ab_presupuesto
        WHERE anio=$1 AND mes=$2 AND local_id = ANY($3::text[])`,
      [anio, mes, localIds]
    );
    const presMap = new Map(presRows.map((r) => [r.local_id, +r.fac || 0]));

    // Semanas ISO que tocan el mes.
    const semanas = weeksInMonth(anio, mes);
    const totalDiasMes = semanas.reduce((s, w) => s + w.dias_en_mes, 0);

    // Horas cargadas persistidas — leen de ab_facturacion_semanal.horas
    // (extendido por migration 8). Una sola query para todos los locales.
    const isoWeeksList = semanas.map((s) => s.semana_iso);
    const horasRows = await many(
      `SELECT local_id, semana_iso, horas::float8 AS horas, fuente_horas
         FROM ab_facturacion_semanal
        WHERE local_id = ANY($1::text[])
          AND anio=$2
          AND semana_iso = ANY($3::int[])
          AND horas IS NOT NULL`,
      [localIds, anio, isoWeeksList]
    );
    const horasMap = new Map(); // 'local|semana' -> {horas, fuente}
    for (const r of horasRows) {
      horasMap.set(`${r.local_id}|${r.semana_iso}`, { horas: +r.horas, fuente: r.fuente_horas });
    }

    const items = locales.map((l) => {
      const fac = presMap.get(l.id) || 0;
      const budgetPers = fac * pctPers;
      const horasMes = euroHora > 0 ? budgetPers / euroHora : 0;
      const pesos = normalizeWeights(DEFAULT_WEEK_WEIGHTS, semanas.length);
      const horasPorSemana = semanas.map((w, i) => {
        const hk = horasMap.get(`${l.id}|${w.semana_iso}`);
        return {
          semana_iso: w.semana_iso,
          fecha_lunes: w.fecha_lunes,
          fecha_domingo: w.fecha_domingo,
          dias_en_mes: w.dias_en_mes,
          horas_disponibles: Math.round(horasMes * pesos[i] * 10) / 10,
          horas_cargadas: hk ? Math.round(hk.horas * 10) / 10 : null,
          fuente_horas: hk?.fuente || null,
        };
      });
      return {
        local_id: l.id, nombre: l.nombre_display, short: l.short_name,
        grupo: l.grupo, dani_only: !!l.dani_only,
        fac_presup_mes: Math.round(fac * 100) / 100,
        pct_personal: +config.pctPersonal || 28,
        budget_personal: Math.round(budgetPers * 100) / 100,
        euro_hora: euroHora,
        horas_disponibles_mes: Math.round(horasMes * 10) / 10,
        horas_override: l.horas_sem_override,
        semanas: horasPorSemana,
      };
    });

    const totalDisp = items.reduce((s, it) => s + it.horas_disponibles_mes, 0);
    let totalCargado = 0;
    let enRojo = 0;
    for (const it of items) {
      const cargs = it.semanas.map((s) => s.horas_cargadas).filter((v) => v != null);
      if (!cargs.length) continue;
      const sum = cargs.reduce((s, v) => s + v, 0);
      totalCargado += sum;
      if (it.horas_disponibles_mes > 0) {
        const v = Math.abs((sum - it.horas_disponibles_mes) / it.horas_disponibles_mes);
        if (v > 0.12) enRojo++;
      }
    }
    res.json({
      anio, mes,
      semanas: semanas.map((w) => ({ semana_iso: w.semana_iso, fecha_lunes: w.fecha_lunes, fecha_domingo: w.fecha_domingo, dias_en_mes: w.dias_en_mes })),
      items,
      kpis: {
        total_disp: Math.round(totalDisp * 10) / 10,
        total_cargado: Math.round(totalCargado * 10) / 10,
        pct_utilizacion: totalDisp > 0 ? Math.round((totalCargado / totalDisp) * 1000) / 10 : 0,
        locales_en_rojo: enRojo,
      },
    });
  } catch (e) {
    console.error('[pedidos.personal.get]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ─── COMPARATIVA BANCOS ─────────────────────────────────────────────────
// GET /pedidos/comparativa-bancos?anio=&mes=&local_id=
// Cruza ab_pedidos_semana (suma del mes) vs ab_movimientos (pagos del mes)
// por proveedor. Útil para detectar facturas pendientes.
router.get('/comparativa-bancos', requirePerm('pedidos_view'), async (req, res) => {
  try {
    const anio = req.query.anio ? +req.query.anio : new Date().getFullYear();
    const mes = req.query.mes ? +req.query.mes : (new Date().getMonth() + 1);
    const local_id = req.query.local_id || null;
    if (mes < 1 || mes > 12) return res.status(400).json({ error: 'mes inválido' });

    // Semanas ISO del mes (para sumar pedidos).
    const semanas = weeksInMonth(anio, mes);
    const isoWeekList = semanas.map((s) => s.semana_iso);

    const pedParams = [anio, isoWeekList];
    let pedSql = `SELECT local_id, proveedor,
                         SUM(COALESCE(importe_real, importe_sugerido))::float8 AS pedido
                    FROM ab_pedidos_semana
                   WHERE anio=$1 AND semana_iso = ANY($2::int[])`;
    if (local_id) { pedSql += ' AND local_id=$3'; pedParams.push(local_id); }
    pedSql += ' GROUP BY local_id, proveedor';
    const pedRows = await many(pedSql, pedParams);

    // Pagos del mes desde ab_movimientos.
    const periodo = `${anio}-${mes < 10 ? '0' + mes : mes}`;
    const movParams = [periodo];
    let movSql = `SELECT local_id, subcategoria AS proveedor, categoria,
                         SUM(ABS(importe))::float8 AS pagado
                    FROM ab_movimientos
                   WHERE periodo=$1 AND importe < 0`;
    if (local_id) { movSql += ' AND local_id=$2'; movParams.push(local_id); }
    movSql += ' GROUP BY local_id, subcategoria, categoria';
    const movRows = await many(movSql, movParams);

    // Join por (local_id, proveedor). Nota: el "proveedor" del banco viene
    // del normalizer (subcategoria). El usuario va a ver match parcial: lo
    // dejamos visible para que ajuste manualmente nombres.
    const byKey = new Map();
    for (const p of pedRows) {
      const k = `${p.local_id}|${p.proveedor}`;
      byKey.set(k, { local_id: p.local_id, proveedor: p.proveedor, pedido: +p.pedido, pagado: 0, categoria_banco: null });
    }
    for (const m of movRows) {
      const k = `${m.local_id}|${m.proveedor}`;
      const cur = byKey.get(k) || { local_id: m.local_id, proveedor: m.proveedor, pedido: 0, pagado: 0, categoria_banco: m.categoria };
      cur.pagado = +m.pagado;
      cur.categoria_banco = m.categoria;
      byKey.set(k, cur);
    }
    const rows = [...byKey.values()].map((r) => {
      const diff = (r.pedido || 0) - (r.pagado || 0);
      const ratio = r.pedido > 0 ? r.pagado / r.pedido : null;
      let estado = 'sin_dato';
      if (r.pedido > 0 && r.pagado > 0) {
        estado = Math.abs(diff) / r.pedido <= 0.05 ? 'ok'
               : ratio < 0.95 ? 'pago_pendiente'
               : 'sobrepago';
      } else if (r.pedido > 0 && r.pagado === 0) estado = 'sin_pago';
      else if (r.pedido === 0 && r.pagado > 0) estado = 'sin_pedido';
      return {
        local_id: r.local_id, proveedor: r.proveedor,
        categoria_banco: r.categoria_banco,
        pedido: Math.round((r.pedido || 0) * 100) / 100,
        pagado: Math.round((r.pagado || 0) * 100) / 100,
        diferencia: Math.round(diff * 100) / 100,
        ratio_pago: ratio,
        estado,
      };
    }).sort((a, b) => Math.abs(b.diferencia) - Math.abs(a.diferencia));

    res.json({ anio, mes, items: rows });
  } catch (e) {
    console.error('[pedidos.comparativa]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ─── HISTORIAL ──────────────────────────────────────────────────────────
// GET /pedidos/historial?local_id=&semanas=8
router.get('/historial', requirePerm('pedidos_view'), async (req, res) => {
  try {
    const local_id = req.query.local_id || null;
    const semanas = Math.max(1, Math.min(52, +req.query.semanas || 8));
    const params = [semanas];
    let sql = `SELECT local_id, anio, semana_iso, proveedor, categoria,
                      importe_sugerido::float8 AS importe_sugerido,
                      importe_real::float8     AS importe_real,
                      estado, notas, updated_at
                 FROM ab_pedidos_semana`;
    if (local_id) { sql += ' WHERE local_id=$2'; params.push(local_id); }
    sql += ` ORDER BY anio DESC, semana_iso DESC, local_id, proveedor
             LIMIT $1 * 200`;
    const rows = await many(sql, params);
    res.json({ items: rows });
  } catch (e) {
    console.error('[pedidos.historial]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ─── RANKING EFICIENCIA ─────────────────────────────────────────────────
// GET /pedidos/ranking-eficiencia?anio=&mes=
// Ratio gasto_real / budget_MP del mes por local, ordenado mejor a peor.
router.get('/ranking-eficiencia', requirePerm('pedidos_view'), async (req, res) => {
  try {
    const anio = req.query.anio ? +req.query.anio : new Date().getFullYear();
    const mes = req.query.mes ? +req.query.mes : (new Date().getMonth() + 1);
    const config = await getConfigCached();
    const pctMP = (+config.pctMP || 38) / 100;

    const locales = await many(
      'SELECT id, nombre_display, short_name, grupo, dani_only FROM ab_locales ORDER BY orden ASC'
    );
    const presRows = await many(
      'SELECT local_id, fac_presupuestada::float8 AS fac FROM ab_presupuesto WHERE anio=$1 AND mes=$2',
      [anio, mes]
    );
    const presMap = new Map(presRows.map((r) => [r.local_id, +r.fac || 0]));

    const semanas = weeksInMonth(anio, mes);
    const isoWeekList = semanas.map((s) => s.semana_iso);
    const pedRows = await many(
      `SELECT local_id,
              SUM(COALESCE(importe_real, importe_sugerido))::float8 AS gastado
         FROM ab_pedidos_semana
        WHERE anio=$1 AND semana_iso = ANY($2::int[])
        GROUP BY local_id`,
      [anio, isoWeekList]
    );
    const gastoMap = new Map(pedRows.map((r) => [r.local_id, +r.gastado || 0]));

    const items = locales.map((l) => {
      const budget = (presMap.get(l.id) || 0) * pctMP;
      const gastado = gastoMap.get(l.id) || 0;
      const ratio = budget > 0 ? gastado / budget : null;
      return {
        local_id: l.id, nombre: l.nombre_display, short: l.short_name,
        grupo: l.grupo, dani_only: !!l.dani_only,
        budget_mp_mes: Math.round(budget * 100) / 100,
        gastado: Math.round(gastado * 100) / 100,
        ratio,
      };
    }).filter((it) => it.budget_mp_mes > 0 || it.gastado > 0)
      .sort((a, b) => {
        // Mejor = ratio más bajo (gasta menos del budget). Sin ratio al final.
        if (a.ratio == null && b.ratio == null) return 0;
        if (a.ratio == null) return 1;
        if (b.ratio == null) return -1;
        return a.ratio - b.ratio;
      });
    res.json({ anio, mes, items });
  } catch (e) {
    console.error('[pedidos.ranking]', e);
    res.status(500).json({ error: 'internal' });
  }
});

module.exports = router;
