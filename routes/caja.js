// /api/v1/caja/* — módulo de caja/efectivo histórico.
// Tabla ab_caja_movimientos alimentada desde CSV (scripts/import-caja.js).
//
// Filtros comunes (query params, opcionales salvo aclaración):
//   desde, hasta             — formato YYYY-MM-DD
//   sucursal                 — nombre exacto (normalizado)
//   sociedad_id              — soporta valores virtuales 'sin_elche', 'solo_elche'
//   tipo                     — 'ingreso' | 'egreso' | (default ambos)
//   incluir_especiales       — bool, default false (excluye sucursales admin)
//   incluir_prorrateo        — bool, default true
//
// Suelo de período por rol: gerente sólo ve desde PERIODO_FLOOR_NO_ADMIN
// (2026-01); admin/socio sin restricción.

const express = require('express');
const { requireAuth, requirePerm } = require('../lib/auth');
const { many, one } = require('../lib/db');
const { SUCURSAL_A_SOCIEDAD } = require('../lib/caja/sucursales');

const router = express.Router();
router.use(requireAuth);
router.use(requirePerm('caja_view'));

const PERIODO_FLOOR_NO_ADMIN = '2026-01-01';
const ROLES_ADMIN = new Set(['admin', 'socio']);
function esAdminLike(req) {
  return ROLES_ADMIN.has(req.session?.user?.role);
}

// Construye el bloque WHERE compartido por todos los endpoints. Devuelve
// `{ sql, vals }` listos para concatenar tras WHERE.
function buildFilters(req, opts = {}) {
  const {
    desde, hasta, sucursal, sociedad_id, tipo,
    incluir_especiales, incluir_prorrateo,
  } = req.query;
  const where = [];
  const vals = [];
  // Floor de período por rol (defense in depth + frontend ya filtra).
  if (!esAdminLike(req)) {
    where.push(`fecha >= $${vals.length + 1}`);
    vals.push(PERIODO_FLOOR_NO_ADMIN);
  }
  if (desde) { where.push(`fecha >= $${vals.length + 1}`); vals.push(desde); }
  if (hasta) { where.push(`fecha <= $${vals.length + 1}`); vals.push(hasta); }
  if (sucursal) { where.push(`sucursal = $${vals.length + 1}`); vals.push(sucursal); }
  if (sociedad_id) {
    if (sociedad_id === 'sin_elche') {
      where.push(`sociedad_id <> $${vals.length + 1} AND sociedad_id IS NOT NULL`);
      vals.push('hostelero');
    } else if (sociedad_id === 'solo_elche') {
      where.push(`sociedad_id = $${vals.length + 1}`);
      vals.push('hostelero');
    } else {
      where.push(`sociedad_id = $${vals.length + 1}`);
      vals.push(sociedad_id);
    }
  }
  if (tipo && tipo !== 'ambos') {
    where.push(`LOWER(tipo) = $${vals.length + 1}`);
    vals.push(tipo.toLowerCase());
  }
  // Defaults: incluir_especiales=false (excluir), incluir_prorrateo=true.
  const incE = incluir_especiales === 'true' || incluir_especiales === '1';
  const incP = incluir_prorrateo !== 'false' && incluir_prorrateo !== '0';
  if (!incE) where.push(`es_especial = FALSE`);
  if (!incP) where.push(`es_prorrateo = FALSE`);
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', vals };
}

// ─── KPIs ──────────────────────────────────────────────────────────────
router.get('/resumen', async (req, res) => {
  try {
    const { sql, vals } = buildFilters(req);
    const r = await one(
      `SELECT
         COUNT(*)::int AS n_movs,
         COALESCE(SUM(CASE WHEN LOWER(tipo)='ingreso' THEN monto ELSE 0 END), 0)::float8 AS ingresos,
         COALESCE(SUM(CASE WHEN LOWER(tipo)='egreso'  THEN monto ELSE 0 END), 0)::float8 AS egresos,
         MIN(fecha)::text AS fecha_min,
         MAX(fecha)::text AS fecha_max
       FROM ab_caja_movimientos ${sql}`,
      vals
    );
    // Rango total disponible (independiente de los filtros — sólo
    // respeta el floor por rol). Lo consume la línea informativa
    // "Datos disponibles: Jul 2025 → Jun 2026" debajo de los KPIs.
    const wRange = []; const vRange = [];
    if (!esAdminLike(req)) {
      wRange.push(`fecha >= $${vRange.length + 1}`);
      vRange.push(PERIODO_FLOOR_NO_ADMIN);
    }
    const rangeSqlWhere = wRange.length ? 'WHERE ' + wRange.join(' AND ') : '';
    const rRange = await one(
      `SELECT MIN(fecha)::text AS fecha_min, MAX(fecha)::text AS fecha_max
         FROM ab_caja_movimientos ${rangeSqlWhere}`,
      vRange
    );
    res.json({
      n_movs: r.n_movs,
      ingresos: r.ingresos,
      egresos: r.egresos,
      neto: r.ingresos - r.egresos,
      fecha_min: r.fecha_min,
      fecha_max: r.fecha_max,
      rango_total: { fecha_min: rRange.fecha_min, fecha_max: rRange.fecha_max },
    });
  } catch (e) {
    console.error('[caja.resumen]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ─── Por sucursal ──────────────────────────────────────────────────────
router.get('/por-sucursal', async (req, res) => {
  try {
    const { sql, vals } = buildFilters(req);
    const rows = await many(
      `SELECT sucursal, sociedad_id,
              COUNT(*)::int AS n_movs,
              COALESCE(SUM(CASE WHEN LOWER(tipo)='ingreso' THEN monto ELSE 0 END), 0)::float8 AS ingresos,
              COALESCE(SUM(CASE WHEN LOWER(tipo)='egreso'  THEN monto ELSE 0 END), 0)::float8 AS egresos
         FROM ab_caja_movimientos ${sql}
         GROUP BY sucursal, sociedad_id
         ORDER BY (SUM(CASE WHEN LOWER(tipo)='ingreso' THEN monto ELSE 0 END)) DESC NULLS LAST`,
      vals
    );
    res.json({
      sucursales: rows.map((r) => ({
        sucursal: r.sucursal,
        sociedad_id: r.sociedad_id,
        n_movs: r.n_movs,
        ingresos: r.ingresos,
        egresos: r.egresos,
        neto: r.ingresos - r.egresos,
        pct_neto: r.ingresos > 0 ? Math.round((r.ingresos - r.egresos) / r.ingresos * 1000) / 10 : 0,
      })),
    });
  } catch (e) {
    console.error('[caja.por-sucursal]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ─── Por sociedad ──────────────────────────────────────────────────────
router.get('/por-sociedad', async (req, res) => {
  try {
    const { sql, vals } = buildFilters(req);
    const rows = await many(
      `SELECT COALESCE(sociedad_id, '__sin_sociedad__') AS sociedad_id,
              COUNT(*)::int AS n_movs,
              COALESCE(SUM(CASE WHEN LOWER(tipo)='ingreso' THEN monto ELSE 0 END), 0)::float8 AS ingresos,
              COALESCE(SUM(CASE WHEN LOWER(tipo)='egreso'  THEN monto ELSE 0 END), 0)::float8 AS egresos
         FROM ab_caja_movimientos ${sql}
         GROUP BY sociedad_id
         ORDER BY (SUM(CASE WHEN LOWER(tipo)='ingreso' THEN monto ELSE 0 END)) DESC NULLS LAST`,
      vals
    );
    res.json({
      sociedades: rows.map((r) => ({
        sociedad_id: r.sociedad_id === '__sin_sociedad__' ? null : r.sociedad_id,
        n_movs: r.n_movs,
        ingresos: r.ingresos,
        egresos: r.egresos,
        neto: r.ingresos - r.egresos,
        pct_neto: r.ingresos > 0 ? Math.round((r.ingresos - r.egresos) / r.ingresos * 1000) / 10 : 0,
      })),
    });
  } catch (e) {
    console.error('[caja.por-sociedad]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ─── Categorías de gasto (subtipos) ────────────────────────────────────
router.get('/categorias', async (req, res) => {
  try {
    const { sql, vals } = buildFilters(req);
    // Top 20 subtipos por monto absoluto agregado (egresos primero).
    const rows = await many(
      `SELECT COALESCE(NULLIF(TRIM(subtipo), ''), '(sin subtipo)') AS subtipo,
              tipo,
              COUNT(*)::int AS n_movs,
              SUM(monto)::float8 AS total
         FROM ab_caja_movimientos ${sql}
         GROUP BY COALESCE(NULLIF(TRIM(subtipo), ''), '(sin subtipo)'), tipo
         ORDER BY SUM(monto) DESC NULLS LAST
         LIMIT 20`,
      vals
    );
    res.json({ categorias: rows });
  } catch (e) {
    console.error('[caja.categorias]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ─── Flujo mensual ─────────────────────────────────────────────────────
router.get('/flujo-mensual', async (req, res) => {
  try {
    const { sql, vals } = buildFilters(req);
    const rows = await many(
      `SELECT TO_CHAR(fecha, 'YYYY-MM') AS mes,
              COUNT(*)::int AS n_movs,
              COALESCE(SUM(CASE WHEN LOWER(tipo)='ingreso' THEN monto ELSE 0 END), 0)::float8 AS ingresos,
              COALESCE(SUM(CASE WHEN LOWER(tipo)='egreso'  THEN monto ELSE 0 END), 0)::float8 AS egresos
         FROM ab_caja_movimientos ${sql}
         GROUP BY TO_CHAR(fecha, 'YYYY-MM')
         ORDER BY mes`,
      vals
    );
    res.json({
      meses: rows.map((r) => ({
        mes: r.mes,
        n_movs: r.n_movs,
        ingresos: r.ingresos,
        egresos: r.egresos,
        neto: r.ingresos - r.egresos,
        pct_neto: r.ingresos > 0 ? Math.round((r.ingresos - r.egresos) / r.ingresos * 1000) / 10 : 0,
      })),
    });
  } catch (e) {
    console.error('[caja.flujo-mensual]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ─── Movimientos paginados ─────────────────────────────────────────────
router.get('/movimientos', async (req, res) => {
  try {
    const limit = Math.min(+req.query.limit || 50, 500);
    const offset = +req.query.offset || 0;
    const { sql, vals } = buildFilters(req);
    const totalRow = await one(
      `SELECT COUNT(*)::int AS c FROM ab_caja_movimientos ${sql}`,
      vals
    );
    const rows = await many(
      `SELECT id, fecha::text, hora::text, sucursal, sociedad_id, tipo, subtipo,
              metodo_pago, monto::float8 AS monto, observaciones,
              es_prorrateo, es_especial
         FROM ab_caja_movimientos ${sql}
         ORDER BY fecha DESC, hora DESC NULLS LAST, id DESC
         LIMIT $${vals.length + 1} OFFSET $${vals.length + 2}`,
      [...vals, limit, offset]
    );
    res.json({ total: totalRow.c, limit, offset, rows });
  } catch (e) {
    console.error('[caja.movimientos]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ─── Combinado banco + efectivo (mensual) ──────────────────────────────
// Devuelve serie mensual con ingresos/gastos de AMBOS canales para el
// período pedido. Usado por la vista combinada de Flujo Anual.
router.get('/combinado', async (req, res) => {
  try {
    // Filtros propios de la query — para banco usamos sociedad+período;
    // para caja aplicamos buildFilters() que ya respeta los mismos
    // params + sus extras (incluir_especiales / incluir_prorrateo).
    const sociedadParam = req.query.sociedad_id || null;
    const desde = req.query.desde || null;
    const hasta = req.query.hasta || null;

    // CAJA — mensual.
    const { sql: sqlC, vals: valsC } = buildFilters(req);
    const cajaRows = await many(
      `SELECT TO_CHAR(fecha, 'YYYY-MM') AS mes,
              COALESCE(SUM(CASE WHEN LOWER(tipo)='ingreso' THEN monto ELSE 0 END), 0)::float8 AS ing,
              COALESCE(SUM(CASE WHEN LOWER(tipo)='egreso'  THEN monto ELSE 0 END), 0)::float8 AS gas
         FROM ab_caja_movimientos ${sqlC}
         GROUP BY TO_CHAR(fecha, 'YYYY-MM')`,
      valsC
    );

    // BANCO — mensual desde ab_movimientos (excluye INTRAGRUPO).
    // Floor por rol espejo del módulo bancos.
    const whereB = [`categoria <> 'INTRAGRUPO'`];
    const valsB = [];
    if (sociedadParam) {
      if (sociedadParam === 'sin_elche') {
        whereB.push(`sociedad_id <> $${valsB.length + 1}`); valsB.push('hostelero');
      } else if (sociedadParam === 'solo_elche') {
        whereB.push(`sociedad_id = $${valsB.length + 1}`); valsB.push('hostelero');
      } else {
        whereB.push(`sociedad_id = $${valsB.length + 1}`); valsB.push(sociedadParam);
      }
    }
    if (desde) { whereB.push(`fecha >= $${valsB.length + 1}`); valsB.push(desde); }
    if (hasta) { whereB.push(`fecha <= $${valsB.length + 1}`); valsB.push(hasta); }
    if (!esAdminLike(req)) {
      whereB.push(`fecha >= $${valsB.length + 1}`);
      valsB.push(PERIODO_FLOOR_NO_ADMIN);
    }
    const bancoRows = await many(
      `SELECT TO_CHAR(fecha, 'YYYY-MM') AS mes,
              COALESCE(SUM(CASE WHEN importe > 0 THEN importe ELSE 0 END), 0)::float8 AS ing,
              COALESCE(SUM(CASE WHEN importe < 0 THEN ABS(importe) ELSE 0 END), 0)::float8 AS gas
         FROM ab_movimientos WHERE ${whereB.join(' AND ')}
         GROUP BY TO_CHAR(fecha, 'YYYY-MM')`,
      valsB
    );

    // Merge en un único array de meses con ambas fuentes.
    const map = new Map();
    function ensure(mes) {
      if (!map.has(mes)) map.set(mes, { mes, banco: { ing: 0, gas: 0 }, caja: { ing: 0, gas: 0 } });
      return map.get(mes);
    }
    for (const r of bancoRows) { const m = ensure(r.mes); m.banco.ing = r.ing; m.banco.gas = r.gas; }
    for (const r of cajaRows)  { const m = ensure(r.mes); m.caja.ing  = r.ing; m.caja.gas  = r.gas; }
    const meses = [...map.keys()].sort();
    const out = meses.map((mes) => {
      const m = map.get(mes);
      const ingTot = m.banco.ing + m.caja.ing;
      const gasTot = m.banco.gas + m.caja.gas;
      const neto = ingTot - gasTot;
      const pctEfectivo = (ingTot + gasTot) > 0
        ? Math.round((m.caja.ing + m.caja.gas) / (ingTot + gasTot) * 1000) / 10
        : 0;
      return {
        mes,
        banco_ingresos: m.banco.ing, banco_gastos: m.banco.gas, banco_neto: m.banco.ing - m.banco.gas,
        caja_ingresos:  m.caja.ing,  caja_gastos:  m.caja.gas,  caja_neto:  m.caja.ing  - m.caja.gas,
        total_ingresos: ingTot, total_gastos: gasTot, total_neto: neto,
        pct_neto: ingTot > 0 ? Math.round(neto / ingTot * 1000) / 10 : 0,
        pct_efectivo: pctEfectivo,
      };
    });
    res.json({ meses: out });
  } catch (e) {
    console.error('[caja.combinado]', e);
    res.status(500).json({ error: 'internal' });
  }
});

module.exports = router;
