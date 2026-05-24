// /api/v1/ventas/* — dashboard de ventas TPV.
//
// Filtros aceptados por todos los endpoints (query string):
//   fecha_desde, fecha_hasta  → 'YYYY-MM-DD'
//   semanas                   → '12,13,14' (ints 1-53)
//   locales                   → 'ARENALES,THADER'
//   familias                  → 'Burgers,EXTRAS'
//   productos                 → 'Kraken Burger,Wilson Burger'
//   canal                     → 'all'|'glovo'|'sala'
//   marca                     → 'all'|'aires'|'chicken'
//   franja                    → 'all'|'12'|'16'|'19'   (12-16h / 16-19h / 19h-2am)
//   solo_jueves               → 'true' (filtra a dia=4 ISO)
//
// "marca" se deriva del campo `local`: nombres que arrancan con
// "CHICKEN " son Chicken, el resto Aires.
//
// El permiso `ventas` ya está en lib/roles.js — incluye admin, socio,
// gerente, pedidos y personal. El acceso fino por columna/tab (Fabricio
// sólo Productos sin €, Agustina sólo Día y Hora, etc.) se aplica en el
// frontend al renderizar; los endpoints devuelven el dataset completo
// para los roles autorizados.

const express = require('express');
const { many, one } = require('../lib/db');
const { requireAuth, requirePerm } = require('../lib/auth');

const router = express.Router();
router.use(requireAuth);
router.use(requirePerm('ventas'));

// ─── Helpers ──────────────────────────────────────────────────────────

const FRANJAS = {
  '12': { desde: 12, hasta: 16 },   // 12-16h
  '16': { desde: 16, hasta: 19 },   // 16-19h
  '19': { desde: 19, hasta: 26 },   // 19h-2am (next day) → comparar con MOD 24
};

// Convierte string CSV de query a array sanitizado.
function csvList(v) {
  if (v == null) return [];
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

// Construye WHERE + params reusables. Devuelve { sql, vals, nextIdx }.
function buildWhere(q) {
  const where = [];
  const vals = [];
  const add = (clause, ...vs) => { where.push(clause.replace(/\?/g, () => `$${vals.length + 1}`)); vals.push(...vs); };

  if (q.fecha_desde) add('fecha >= ?', q.fecha_desde);
  if (q.fecha_hasta) add('fecha <= ?', q.fecha_hasta);

  const semanas = csvList(q.semanas).map((s) => parseInt(s, 10)).filter(Number.isFinite);
  if (semanas.length) add('semana = ANY(?::int[])', semanas);

  const locales = csvList(q.locales);
  if (locales.length) add('local = ANY(?::text[])', locales);

  const familias = csvList(q.familias);
  if (familias.length) add('familia = ANY(?::text[])', familias);

  const productos = csvList(q.productos);
  if (productos.length) add('producto = ANY(?::text[])', productos);

  if (q.canal === 'glovo') add('es_glovo = TRUE');
  else if (q.canal === 'sala') add('es_glovo = FALSE');

  if (q.marca === 'aires') add("local NOT ILIKE 'CHICKEN%'");
  else if (q.marca === 'chicken') add("local ILIKE 'CHICKEN%'");

  // Franja horaria: el campo `periodo` viene como 'HH-HH'.
  if (q.franja && FRANJAS[q.franja]) {
    const { desde, hasta } = FRANJAS[q.franja];
    // Extraemos la hora de inicio del string (parte antes de '-').
    // CAST a INT y filtramos por rango.
    // Para franja '19' (19-26 → wrap 0-2), aceptamos hora<2 también.
    if (hasta <= 24) {
      add("CAST(split_part(periodo, '-', 1) AS INT) >= ?", desde);
      add("CAST(split_part(periodo, '-', 1) AS INT) <  ?", hasta);
    } else {
      add("(CAST(split_part(periodo, '-', 1) AS INT) >= ? OR CAST(split_part(periodo, '-', 1) AS INT) < ?)", desde, hasta - 24);
    }
    // Filtramos filas sin periodo numérico para evitar CAST error.
    where.push("periodo ~ '^[0-9]+'");
  }

  if (q.solo_jueves === 'true' || q.solo_jueves === '1') {
    add('dia = 4');
    // Además, si quiere "Jueves 2×1" estricto, podríamos filtrar por
    // promocion ILIKE '%2x1%'. Por ahora sólo dia=jueves; el filtro
    // de promo "Jueves 2x1" del sidebar se aplica con productos[].
  }

  const sql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  return { sql, vals };
}

// Excluye filas con coste anómalo (>500). Para los cálculos de margen
// estos rows se descartan; aparecen sólo en la nota de advertencia.
function buildWhereSinAnomalas(q) {
  const w = buildWhere(q);
  const clause = '(coste IS NULL OR coste <= 500)';
  w.sql = w.sql ? `${w.sql} AND ${clause}` : `WHERE ${clause}`;
  return w;
}

// Devuelve el % de comisión Glovo del config global (slider en
// Parámetros). Hoy el sistema usa la constante 22%×27% para los
// cálculos del engine; mantenemos esa fórmula como fallback hasta
// que se agregue un slider explícito.
async function pctComisionGlovo() {
  try {
    const row = await one("SELECT valor FROM ab_config WHERE clave = 'pctComisionGlovo'");
    if (row && row.valor != null) {
      const v = typeof row.valor === 'number' ? row.valor : parseFloat(JSON.stringify(row.valor));
      if (Number.isFinite(v) && v > 0 && v < 1) return v;
    }
  } catch {}
  // Fallback: 22% × 27% ≈ 5,94% (la constante histórica del engine).
  return 0.22 * 0.27;
}

// ─── Endpoints ────────────────────────────────────────────────────────

// META: opciones para poblar el sidebar de filtros.
router.get('/filtros-meta', async (req, res) => {
  try {
    // Locales con totales para ordenar el listado.
    const locales = await many(
      `SELECT local AS nombre,
              COUNT(*)::int AS n_lineas,
              SUM(COALESCE(total,0))::float8 AS venta_total
         FROM ab_ventas_tpv
        GROUP BY local
        ORDER BY venta_total DESC NULLS LAST`
    );
    const familias = await many(
      `SELECT familia AS nombre,
              COUNT(*)::int AS n_lineas,
              SUM(COALESCE(total,0))::float8 AS venta_total
         FROM ab_ventas_tpv
        WHERE familia IS NOT NULL
        GROUP BY familia
        ORDER BY venta_total DESC NULLS LAST`
    );
    const semanas = await many(
      `SELECT anio, semana,
              MIN(fecha)::text AS fecha_min,
              MAX(fecha)::text AS fecha_max,
              SUM(COALESCE(total,0))::float8 AS venta_total
         FROM ab_ventas_tpv
        GROUP BY anio, semana
        ORDER BY anio, semana`
    );
    const productos = await many(
      `SELECT producto AS nombre, familia,
              SUM(cantidad)::float8 AS uds,
              SUM(COALESCE(total,0))::float8 AS venta_total
         FROM ab_ventas_tpv
        GROUP BY producto, familia
        ORDER BY venta_total DESC NULLS LAST
        LIMIT 1000`
    );
    const rango = await one(
      `SELECT MIN(fecha)::text AS fecha_min,
              MAX(fecha)::text AS fecha_max,
              COUNT(*)::int    AS total_lineas
         FROM ab_ventas_tpv`
    );
    res.json({ locales, familias, semanas, productos, rango });
  } catch (e) {
    console.error('[ventas.filtros-meta]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// KPIs principales.
router.get('/kpis', async (req, res) => {
  try {
    const { sql: where, vals } = buildWhere(req.query);
    const { sql: whereSA, vals: valsSA } = buildWhereSinAnomalas(req.query);
    const pctGlovo = await pctComisionGlovo();

    const agg = await one(
      `SELECT SUM(COALESCE(total,0))::float8 AS venta_total,
              SUM(CASE WHEN es_glovo THEN COALESCE(total,0) ELSE 0 END)::float8 AS venta_glovo,
              COUNT(*)::int AS n_lineas
         FROM ab_ventas_tpv ${where}`,
      vals
    );
    const aggMargen = await one(
      `SELECT SUM(COALESCE(margen,0))::float8 AS margen_total,
              SUM(COALESCE(total,0))::float8  AS venta_para_margen,
              COUNT(*)::int                    AS n_lineas_validas
         FROM ab_ventas_tpv ${whereSA}`,
      valsSA
    );
    const anomalas = await one(
      `SELECT COUNT(*)::int AS n
         FROM ab_ventas_tpv ${where ? where + ' AND' : 'WHERE'} coste > 500`,
      vals
    );

    const venta_total = agg.venta_total || 0;
    const venta_glovo = agg.venta_glovo || 0;
    const comision_glovo = venta_glovo * pctGlovo;
    const neto_glovo = venta_glovo - comision_glovo;
    const margen_total = aggMargen.margen_total || 0;
    const ventaParaMg = aggMargen.venta_para_margen || 0;
    const pct_margen_medio = ventaParaMg > 0 ? margen_total / ventaParaMg : null;

    res.json({
      venta_total,
      venta_glovo,
      pct_comision_glovo: pctGlovo,
      comision_glovo,
      neto_glovo,
      margen_bruto_total: margen_total,
      pct_margen_medio,
      n_lineas: agg.n_lineas,
      n_lineas_anomalas: anomalas.n,
      mostrar_aviso_anomalas: anomalas.n > 0,
    });
  } catch (e) {
    console.error('[ventas.kpis]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// PRODUCTOS: tabla ordenable con métricas por producto+canal.
router.get('/productos', async (req, res) => {
  try {
    const { sql: where, vals } = buildWhere(req.query);
    const pctGlovo = await pctComisionGlovo();
    const limit = Math.min(+req.query.limit || 500, 2000);
    const rows = await many(
      `SELECT producto,
              familia,
              CASE WHEN es_glovo THEN 'glovo' ELSE 'sala' END AS canal,
              SUM(cantidad)::float8                          AS uds,
              SUM(COALESCE(total,0))::float8                  AS venta_total,
              CASE WHEN SUM(cantidad)>0 THEN SUM(COALESCE(total,0))/SUM(cantidad) END::float8 AS p_medio_venta,
              CASE WHEN SUM(cantidad)>0 AND SUM(CASE WHEN coste IS NULL OR coste<=500 THEN cantidad ELSE 0 END)>0
                   THEN SUM(CASE WHEN coste IS NULL OR coste<=500 THEN COALESCE(coste,0)*cantidad ELSE 0 END)
                      / SUM(CASE WHEN coste IS NULL OR coste<=500 THEN cantidad ELSE 0 END)
              END::float8 AS costo_ud,
              SUM(CASE WHEN coste IS NULL OR coste<=500 THEN COALESCE(margen,0) ELSE 0 END)::float8 AS margen_total,
              CASE WHEN SUM(CASE WHEN coste IS NULL OR coste<=500 THEN COALESCE(total,0) ELSE 0 END) > 0
                   THEN SUM(CASE WHEN coste IS NULL OR coste<=500 THEN COALESCE(margen,0) ELSE 0 END)
                      / SUM(CASE WHEN coste IS NULL OR coste<=500 THEN COALESCE(total,0) ELSE 0 END)
              END::float8 AS pct_margen,
              MAX(promocion) AS promocion_sample
         FROM ab_ventas_tpv ${where}
        GROUP BY producto, familia, es_glovo
        ORDER BY venta_total DESC NULLS LAST
        LIMIT $${vals.length + 1}`,
      [...vals, limit]
    );

    // Enriquecemos con comision y neto por unidad de Glovo (sólo aplica
    // a filas canal=glovo).
    const enriched = rows.map((r) => {
      const com_ud = r.canal === 'glovo' && r.p_medio_venta ? r.p_medio_venta * pctGlovo : 0;
      const neto_ud_real = r.p_medio_venta != null ? r.p_medio_venta - com_ud : null;
      const margen_ud = (neto_ud_real != null && r.costo_ud != null) ? neto_ud_real - r.costo_ud : null;
      return { ...r, com_glovo_ud: com_ud, neto_ud_real, margen_ud };
    });

    res.json({ productos: enriched, pct_comision_glovo: pctGlovo });
  } catch (e) {
    console.error('[ventas.productos]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// SUCURSALES: agregado por local.
router.get('/sucursales', async (req, res) => {
  try {
    const { sql: where, vals } = buildWhere(req.query);
    const pctGlovo = await pctComisionGlovo();
    const rows = await many(
      `SELECT local,
              SUM(cantidad)::float8 AS uds,
              SUM(COALESCE(total,0))::float8 AS venta_total,
              SUM(CASE WHEN es_glovo THEN COALESCE(total,0) ELSE 0 END)::float8 AS venta_glovo,
              SUM(CASE WHEN coste IS NULL OR coste<=500 THEN COALESCE(margen,0) ELSE 0 END)::float8 AS margen_bruto,
              SUM(CASE WHEN coste IS NULL OR coste<=500 THEN COALESCE(total,0)  ELSE 0 END)::float8 AS venta_para_margen
         FROM ab_ventas_tpv ${where}
        GROUP BY local
        ORDER BY venta_total DESC NULLS LAST`,
      vals
    );
    const enriched = rows.map((r) => {
      const com_glovo = (r.venta_glovo || 0) * pctGlovo;
      const neto_glovo = (r.venta_glovo || 0) - com_glovo;
      const pct_margen = r.venta_para_margen > 0 ? r.margen_bruto / r.venta_para_margen : null;
      return { ...r, comision_glovo: com_glovo, neto_glovo, pct_margen };
    });
    res.json({ sucursales: enriched, pct_comision_glovo: pctGlovo });
  } catch (e) {
    console.error('[ventas.sucursales]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// PROMOCIONES: agregado por promocion+producto.
router.get('/promociones', async (req, res) => {
  try {
    const { sql: where, vals } = buildWhere(req.query);
    const pctGlovo = await pctComisionGlovo();
    const sqlWherePromo = where
      ? `${where} AND promocion IS NOT NULL AND promocion <> ''`
      : `WHERE promocion IS NOT NULL AND promocion <> ''`;
    const rows = await many(
      `SELECT promocion,
              producto,
              CASE WHEN es_glovo THEN 'glovo' ELSE 'sala' END AS canal,
              SUM(cantidad)::float8 AS uds,
              SUM(COALESCE(total,0))::float8 AS venta_total,
              CASE WHEN SUM(cantidad)>0 AND SUM(CASE WHEN coste IS NULL OR coste<=500 THEN cantidad ELSE 0 END)>0
                   THEN SUM(CASE WHEN coste IS NULL OR coste<=500 THEN COALESCE(coste,0)*cantidad ELSE 0 END)
                      / SUM(CASE WHEN coste IS NULL OR coste<=500 THEN cantidad ELSE 0 END)
              END::float8 AS costo_ud,
              SUM(CASE WHEN coste IS NULL OR coste<=500 THEN COALESCE(margen,0) ELSE 0 END)::float8 AS margen_total,
              CASE WHEN SUM(CASE WHEN coste IS NULL OR coste<=500 THEN COALESCE(total,0) ELSE 0 END) > 0
                   THEN SUM(CASE WHEN coste IS NULL OR coste<=500 THEN COALESCE(margen,0) ELSE 0 END)
                      / SUM(CASE WHEN coste IS NULL OR coste<=500 THEN COALESCE(total,0) ELSE 0 END)
              END::float8 AS pct_margen
         FROM ab_ventas_tpv ${sqlWherePromo}
        GROUP BY promocion, producto, es_glovo
        ORDER BY venta_total DESC NULLS LAST
        LIMIT 1000`,
      vals
    );
    const enriched = rows.map((r) => {
      const com_glovo = r.canal === 'glovo' ? (r.venta_total || 0) * pctGlovo : 0;
      const neto = (r.venta_total || 0) - com_glovo;
      const neto_ud = r.uds > 0 ? neto / r.uds : null;
      const margen_ud = (neto_ud != null && r.costo_ud != null) ? neto_ud - r.costo_ud : null;
      return { ...r, neto, neto_ud, margen_ud };
    });
    res.json({ promociones: enriched, pct_comision_glovo: pctGlovo });
  } catch (e) {
    console.error('[ventas.promociones]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// DÍA Y HORA: dos series, una por día (1-7 ISO) y otra por franja horaria.
router.get('/dia-hora', async (req, res) => {
  try {
    const { sql: where, vals } = buildWhere(req.query);
    const porDia = await many(
      `SELECT dia,
              SUM(cantidad)::float8 AS uds,
              SUM(COALESCE(total,0))::float8 AS venta_total,
              COUNT(*)::int AS n_lineas
         FROM ab_ventas_tpv ${where}
        GROUP BY dia
        ORDER BY dia`,
      vals
    );
    const totalGlobal = porDia.reduce((s, r) => s + (r.venta_total || 0), 0);
    const dias = porDia.map((r) => ({
      ...r,
      pct: totalGlobal > 0 ? (r.venta_total || 0) / totalGlobal : 0,
    }));

    const porFranja = await many(
      `SELECT periodo AS franja,
              SUM(cantidad)::float8 AS uds,
              SUM(COALESCE(total,0))::float8 AS venta_total,
              COUNT(*)::int AS n_lineas
         FROM ab_ventas_tpv
         ${where ? where + ' AND' : 'WHERE'} periodo IS NOT NULL AND periodo <> ''
        GROUP BY periodo
        ORDER BY periodo`,
      vals
    );
    res.json({ dias, franjas: porFranja });
  } catch (e) {
    console.error('[ventas.dia-hora]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// CAMAREROS: tabla por usuario+local. Sólo admin / socio / gerente.
const { hasPerm } = require('../lib/roles');
router.get('/camareros', async (req, res) => {
  try {
    const role = req.session?.user?.role;
    const VISIBLES = new Set(['admin', 'socio', 'gerente']);
    if (!VISIBLES.has(role)) return res.status(403).json({ error: 'forbidden' });
    const { sql: where, vals } = buildWhere(req.query);
    const rows = await many(
      `SELECT usuario, local,
              SUM(cantidad)::float8 AS uds,
              SUM(COALESCE(total,0))::float8 AS venta_total,
              COUNT(*)::int AS n_lineas
         FROM ab_ventas_tpv
         ${where ? where + ' AND' : 'WHERE'} usuario IS NOT NULL AND usuario <> ''
        GROUP BY usuario, local
        ORDER BY venta_total DESC NULLS LAST
        LIMIT 1000`,
      vals
    );
    res.json({ camareros: rows });
  } catch (e) {
    console.error('[ventas.camareros]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// UPLOADS: historial de imports (admin only).
router.get('/uploads', requirePerm('ventas_upload'), async (req, res) => {
  try {
    const rows = await many(
      `SELECT u.id, u.nombre_archivo, u.periodo_descripcion,
              u.fecha_desde::text AS fecha_desde,
              u.fecha_hasta::text AS fecha_hasta,
              u.total_lineas, u.locales_detectados, u.estado,
              u.created_at::text AS created_at,
              au.email AS subido_por_email
         FROM ab_ventas_uploads u
         LEFT JOIN ab_users au ON au.id = u.subido_por
        ORDER BY u.created_at DESC
        LIMIT 100`
    );
    res.json({ uploads: rows });
  } catch (e) {
    console.error('[ventas.uploads]', e);
    res.status(500).json({ error: 'internal' });
  }
});

module.exports = router;
