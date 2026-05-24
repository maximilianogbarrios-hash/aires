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

    // Margen real: usa costos de ab_ventas_costos en lugar del campo
    // margen del TPV (que tiene errores en filas de promo 2x1). Sólo
    // considera productos que tienen costo cargado — a medida que se
    // completen los costos, el cálculo se vuelve más representativo.
    // Match case-insensitive + trim para tolerar variaciones del TPV.
    const margenReal = await one(
      `SELECT
         SUM(v.cantidad * (COALESCE(v.total,0)/NULLIF(v.cantidad,0) - c.costo_total))::float8 AS margen_real,
         SUM(COALESCE(v.total,0))::float8                                                     AS venta_cubierta,
         COUNT(DISTINCT LOWER(TRIM(v.producto)))::int                                         AS n_productos_con_costo,
         SUM(v.cantidad)::float8                                                              AS uds_cubiertas
       FROM ab_ventas_tpv v
       JOIN ab_ventas_costos c ON LOWER(TRIM(c.producto)) = LOWER(TRIM(v.producto))
       ${where}`,
      vals
    );
    const totalProductos = await one(
      `SELECT COUNT(DISTINCT LOWER(TRIM(producto)))::int AS n FROM ab_ventas_tpv ${where}`,
      vals
    );

    res.json({
      venta_total,
      venta_glovo,
      pct_comision_glovo: pctGlovo,
      comision_glovo,
      neto_glovo,
      margen_bruto_total: margen_total,
      pct_margen_medio,
      // Margen real basado en ab_ventas_costos (no en el campo margen del TPV).
      margen_real: margenReal.margen_real || 0,
      venta_cubierta: margenReal.venta_cubierta || 0,
      pct_margen_real: margenReal.venta_cubierta > 0 ? margenReal.margen_real / margenReal.venta_cubierta : null,
      n_productos_con_costo: margenReal.n_productos_con_costo || 0,
      n_productos_total: totalProductos.n || 0,
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
// ─── COSTOS ───────────────────────────────────────────────────────────
// Lista todos los productos vendidos en el TPV con su costo cargado (si
// lo tienen). El match es case-insensitive + trim. Orden por uds DESC.
router.get('/costos', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const familia = (req.query.familia || '').trim();
    const estado = req.query.estado || 'all'; // all | con-costo | sin-costo
    const where = ['v.importe IS NOT NULL OR v.cantidad IS NOT NULL', '1=1'];
    const vals = [];
    // No usamos buildWhere acá porque queremos TODO el dataset (catálogo,
    // no filtro temporal). Sólo filtros sobre el producto en sí.
    let extra = '';
    if (q) { extra += ` AND LOWER(v.producto) LIKE LOWER($${vals.length + 1})`; vals.push('%' + q + '%'); }
    if (familia) { extra += ` AND v.familia = $${vals.length + 1}`; vals.push(familia); }
    const rows = await many(
      `SELECT v.producto, v.familia,
              SUM(v.cantidad)::float8           AS uds_vendidas,
              SUM(COALESCE(v.total,0))::float8  AS venta_total,
              CASE WHEN SUM(v.cantidad)>0 THEN SUM(COALESCE(v.total,0))/SUM(v.cantidad) END::float8 AS pvp_medio,
              c.id              AS costo_id,
              c.costo_mp::float8      AS costo_mp,
              c.mano_obra::float8     AS mano_obra,
              c.costo_fritura::float8 AS costo_fritura,
              c.costo_total::float8   AS costo_total,
              c.notas                 AS notas,
              c.updated_at::text      AS updated_at,
              au.email                AS actualizado_por_email,
              (c.id IS NOT NULL)      AS tiene_costo
         FROM ab_ventas_tpv v
         LEFT JOIN ab_ventas_costos c ON LOWER(TRIM(c.producto)) = LOWER(TRIM(v.producto))
         LEFT JOIN ab_users au        ON au.id = c.actualizado_por
        WHERE v.producto IS NOT NULL ${extra}
        GROUP BY v.producto, v.familia, c.id, c.costo_mp, c.mano_obra, c.costo_fritura,
                 c.costo_total, c.notas, c.updated_at, au.email
        ORDER BY uds_vendidas DESC NULLS LAST
        LIMIT 2000`,
      vals
    );
    // Filtro estado en JS (más simple que mezclar con la query).
    let filtered = rows;
    if (estado === 'con-costo') filtered = rows.filter((r) => r.tiene_costo);
    else if (estado === 'sin-costo') filtered = rows.filter((r) => !r.tiene_costo);
    // Margen PVP por producto (sólo donde hay costo y pvp).
    filtered = filtered.map((r) => {
      const margen_pvp = (r.pvp_medio != null && r.costo_total != null && r.pvp_medio > 0)
        ? (r.pvp_medio - r.costo_total) / r.pvp_medio
        : null;
      return { ...r, margen_pvp };
    });
    const stats = {
      total: rows.length,
      con_costo: rows.filter((r) => r.tiene_costo).length,
      sin_costo: rows.filter((r) => !r.tiene_costo).length,
    };
    stats.pct_cubierto = stats.total > 0 ? stats.con_costo / stats.total : 0;
    res.json({ productos: filtered, stats });
  } catch (e) {
    console.error('[ventas.costos.list]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// Detalle de un producto: costo + receta + métricas de venta agregadas.
router.get('/costos/:producto', async (req, res) => {
  try {
    const prod = decodeURIComponent(req.params.producto || '');
    if (!prod) return res.status(400).json({ error: 'producto requerido' });
    const costo = await one(
      `SELECT c.*, au.email AS actualizado_por_email
         FROM ab_ventas_costos c
         LEFT JOIN ab_users au ON au.id = c.actualizado_por
        WHERE LOWER(TRIM(c.producto)) = LOWER(TRIM($1))`,
      [prod]
    );
    const recetas = costo ? await many(
      `SELECT id, ingrediente, costo_unitario::float8 AS costo_unitario,
              formato::float8 AS formato, rendimiento::float8 AS rendimiento,
              costo_por_gr::float8 AS costo_por_gr, cantidad_receta::float8 AS cantidad_receta,
              subtotal::float8 AS subtotal, orden
         FROM ab_ventas_recetas
        WHERE costo_id = $1
        ORDER BY orden, id`,
      [costo.id]
    ) : [];
    const ventas = await one(
      `SELECT SUM(cantidad)::float8           AS uds_vendidas,
              SUM(COALESCE(total,0))::float8   AS venta_total,
              CASE WHEN SUM(cantidad)>0 THEN SUM(COALESCE(total,0))/SUM(cantidad) END::float8 AS pvp_medio
         FROM ab_ventas_tpv
        WHERE LOWER(TRIM(producto)) = LOWER(TRIM($1))`,
      [prod]
    );
    res.json({ producto: prod, costo, recetas, ventas });
  } catch (e) {
    console.error('[ventas.costos.detail]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// Crear / actualizar costo de un producto. Requiere ventas_costos_edit.
router.put('/costos/:producto', express.json(), requirePerm('ventas_costos_edit'), async (req, res) => {
  try {
    const prod = decodeURIComponent(req.params.producto || '').trim();
    if (!prod) return res.status(400).json({ error: 'producto requerido' });
    const { familia, costo_mp, mano_obra, costo_fritura, costo_total, notas } = req.body || {};
    // Si no viene costo_total explícito, lo derivamos de los 3 componentes.
    const mp = costo_mp != null ? +costo_mp : null;
    const mo = mano_obra != null ? +mano_obra : 0.65;
    const cf = costo_fritura != null ? +costo_fritura : 0;
    const total = costo_total != null ? +costo_total
                 : (mp != null ? (mp + mo + cf) : null);
    const userId = req.session?.user?.id || null;
    const row = await one(
      `INSERT INTO ab_ventas_costos
         (producto, familia, costo_mp, mano_obra, costo_fritura, costo_total, notas, actualizado_por, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
       ON CONFLICT (producto) DO UPDATE
         SET familia = EXCLUDED.familia,
             costo_mp = EXCLUDED.costo_mp,
             mano_obra = EXCLUDED.mano_obra,
             costo_fritura = EXCLUDED.costo_fritura,
             costo_total = EXCLUDED.costo_total,
             notas = EXCLUDED.notas,
             actualizado_por = EXCLUDED.actualizado_por,
             updated_at = NOW()
       RETURNING id`,
      [prod, familia || null, mp, mo, cf, total, notas || null, userId]
    );
    res.json({ ok: true, costo_id: row.id });
  } catch (e) {
    console.error('[ventas.costos.put]', e);
    res.status(500).json({ error: e.message || 'internal' });
  }
});

// Reemplazar la receta entera del producto (delete + insert). Requiere
// ventas_costos_edit. Body: { lineas: [{ingrediente, costo_unitario, ...}] }
router.post('/costos/:producto/receta', express.json(), requirePerm('ventas_costos_edit'), async (req, res) => {
  try {
    const prod = decodeURIComponent(req.params.producto || '').trim();
    if (!prod) return res.status(400).json({ error: 'producto requerido' });
    const lineas = Array.isArray(req.body?.lineas) ? req.body.lineas : [];
    const costo = await one('SELECT id FROM ab_ventas_costos WHERE LOWER(TRIM(producto)) = LOWER(TRIM($1))', [prod]);
    if (!costo) return res.status(404).json({ error: 'producto sin costo cargado — usá PUT /costos/:producto primero' });
    await query('DELETE FROM ab_ventas_recetas WHERE costo_id = $1', [costo.id]);
    let i = 0;
    for (const l of lineas) {
      const ing = (l.ingrediente || '').trim();
      if (!ing) continue;
      const cu = l.costo_unitario != null ? +l.costo_unitario : null;
      const fmt = l.formato != null ? +l.formato : null;
      const rend = l.rendimiento != null ? +l.rendimiento : null;
      const cpg = l.costo_por_gr != null ? +l.costo_por_gr
                 : (cu != null && fmt > 0 && rend > 0 ? (cu / fmt / rend) : null);
      const cant = l.cantidad_receta != null ? +l.cantidad_receta : null;
      const sub = l.subtotal != null ? +l.subtotal
                  : (cpg != null && cant != null ? cpg * cant : null);
      await query(
        `INSERT INTO ab_ventas_recetas
          (costo_id, ingrediente, costo_unitario, formato, rendimiento, costo_por_gr, cantidad_receta, subtotal, orden)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [costo.id, ing, cu, fmt, rend, cpg, cant, sub, i++]
      );
    }
    res.json({ ok: true, lineas: i });
  } catch (e) {
    console.error('[ventas.costos.receta]', e);
    res.status(500).json({ error: e.message || 'internal' });
  }
});

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
