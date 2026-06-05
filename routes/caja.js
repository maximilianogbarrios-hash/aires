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
const {
  categoriaDeSubtipoCaja, origenIngresoCaja, origenIngresoBanco,
} = require('../lib/caja/mapeo-categorias');

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

// ─── Flujo Total — banco + caja unidos por origen/categoría ───────────
// Devuelve para el filtro pedido:
//   - kpis: ingresos/egresos/neto/cobertura_efectivo
//   - ingresos_por_origen: una fila por canal (TPV Santander, Glovo,
//     Cierres caja, etc.), con monto banco + monto efectivo + total
//   - egresos_por_categoria: una fila por categoría canónica, con
//     sub-rows top-N proveedores banco y top-N subtipos caja
//   - sin_categoria_efectivo: lista de movs caja cuyo subtipo no
//     matcheó ningún patrón — pendientes de reclasificar
//
// Reusa filtros de buildFilters() (desde/hasta/sociedad_id/etc.) para
// caja; para banco aplica el mismo período + sociedad. Sin sociedad =
// todas. Floor por rol vía el helper.
router.get('/flujo-total', async (req, res) => {
  try {
    // CAJA — aplicamos buildFilters() para reusar período/sociedad/etc.
    // Pero forzamos `tipo` y `incluir_*` por separado para no perder
    // ingresos/egresos en el query principal.
    const reqCaja = Object.assign({}, req, {
      query: Object.assign({}, req.query, { tipo: 'ambos' }),
    });
    const { sql: sqlC, vals: valsC } = buildFilters(reqCaja);
    const cajaRows = await many(
      `SELECT id, fecha::text, sucursal, sociedad_id, tipo, subtipo,
              monto::float8 AS monto, observaciones
         FROM ab_caja_movimientos ${sqlC}`,
      valsC
    );

    // BANCO — período + sociedad, excluye INTRAGRUPO. Floor por rol.
    const sociedadParam = req.query.sociedad_id || null;
    const desde = req.query.desde || null;
    const hasta = req.query.hasta || null;
    const whereB = [`categoria <> 'INTRAGRUPO'`];
    const valsB = [];
    if (sociedadParam) {
      if (sociedadParam === 'sin_elche')      { whereB.push(`sociedad_id <> $${valsB.length+1}`); valsB.push('hostelero'); }
      else if (sociedadParam === 'solo_elche'){ whereB.push(`sociedad_id  = $${valsB.length+1}`); valsB.push('hostelero'); }
      else                                    { whereB.push(`sociedad_id  = $${valsB.length+1}`); valsB.push(sociedadParam); }
    }
    if (desde) { whereB.push(`fecha >= $${valsB.length+1}`); valsB.push(desde); }
    if (hasta) { whereB.push(`fecha <= $${valsB.length+1}`); valsB.push(hasta); }
    if (!esAdminLike(req)) { whereB.push(`fecha >= $${valsB.length+1}`); valsB.push(PERIODO_FLOOR_NO_ADMIN); }
    const bancoRows = await many(
      `SELECT id, fecha::text, sociedad_id, concepto, categoria, importe::float8 AS importe,
              proveedor_normalizado
         FROM ab_movimientos WHERE ${whereB.join(' AND ')}`,
      valsB
    );

    // ─── KPIs agregados ─────
    let ingB = 0, gasB = 0, ingC = 0, gasC = 0;
    for (const r of bancoRows) {
      if (r.importe > 0) ingB += r.importe;
      else gasB += Math.abs(r.importe);
    }
    for (const r of cajaRows) {
      if ((r.tipo || '').toLowerCase() === 'ingreso') ingC += r.monto;
      else if ((r.tipo || '').toLowerCase() === 'egreso') gasC += r.monto;
    }
    const ingTot = ingB + ingC;
    const gasTot = gasB + gasC;
    const flujoBruto = ingTot + gasTot;
    const cobertura_efectivo = flujoBruto > 0 ? (ingC + gasC) / flujoBruto * 100 : 0;

    // ─── Ingresos por origen ─────
    // banco: mapeado con origenIngresoBanco(concepto)
    // caja:  mapeado con origenIngresoCaja(subtipo)
    const ingresosMap = new Map(); // origen → { banco, efectivo, fuente, subitems_efectivo }
    function ensureIng(origen, fuente) {
      if (!ingresosMap.has(origen)) {
        ingresosMap.set(origen, { origen, banco: 0, efectivo: 0, fuente, subitems_efectivo: new Map() });
      }
      return ingresosMap.get(origen);
    }
    for (const r of bancoRows) {
      if (r.importe <= 0) continue;
      const o = origenIngresoBanco(r.concepto);
      ensureIng(o, 'banco').banco += r.importe;
    }
    for (const r of cajaRows) {
      if ((r.tipo || '').toLowerCase() !== 'ingreso') continue;
      const o = origenIngresoCaja(r.subtipo);
      const ent = ensureIng(o, 'caja');
      ent.efectivo += r.monto;
      // Sub-items por subtipo (top 3 después).
      const key = (r.subtipo || '(sin)').slice(0, 50);
      ent.subitems_efectivo.set(key, (ent.subitems_efectivo.get(key) || 0) + r.monto);
    }
    const ingresos_por_origen = [...ingresosMap.values()].map((x) => ({
      origen: x.origen,
      banco: Math.round(x.banco * 100) / 100,
      efectivo: Math.round(x.efectivo * 100) / 100,
      total: Math.round((x.banco + x.efectivo) * 100) / 100,
      pct: ingTot > 0 ? Math.round((x.banco + x.efectivo) / ingTot * 1000) / 10 : 0,
      subitems_efectivo: [...x.subitems_efectivo.entries()]
        .sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([k, v]) => ({ label: k, monto: Math.round(v * 100) / 100 })),
    })).sort((a, b) => b.total - a.total);

    // ─── Egresos por categoría (taxonomía banco) ─────
    const egresosMap = new Map(); // cat → { banco, efectivo, top_banco: Map, top_caja: Map }
    function ensureEgr(cat) {
      if (!egresosMap.has(cat)) {
        egresosMap.set(cat, { cat, banco: 0, efectivo: 0, top_banco: new Map(), top_caja: new Map() });
      }
      return egresosMap.get(cat);
    }
    for (const r of bancoRows) {
      if (r.importe >= 0) continue;
      const cat = r.categoria || 'OTROS';
      const ent = ensureEgr(cat);
      const abs = Math.abs(r.importe);
      ent.banco += abs;
      const prov = r.proveedor_normalizado || (r.concepto || '').slice(0, 40);
      ent.top_banco.set(prov, (ent.top_banco.get(prov) || 0) + abs);
    }
    const sin_categoria_efectivo = [];
    for (const r of cajaRows) {
      if ((r.tipo || '').toLowerCase() !== 'egreso') continue;
      const cat = categoriaDeSubtipoCaja(r.subtipo);
      if (cat === 'SIN_CATEGORIA_CAJA') {
        // Coleccionar para la lista de pendientes (top 50 por monto).
        sin_categoria_efectivo.push({
          id: r.id, fecha: r.fecha, sucursal: r.sucursal,
          subtipo: r.subtipo, monto: r.monto, observaciones: r.observaciones,
        });
        continue;
      }
      const ent = ensureEgr(cat);
      ent.efectivo += r.monto;
      const key = (r.subtipo || '(sin)').slice(0, 50);
      ent.top_caja.set(key, (ent.top_caja.get(key) || 0) + r.monto);
    }
    // Cat especial para los sin clasificar (suma agregada, se muestra
    // separado en la UI).
    const sinTot = sin_categoria_efectivo.reduce((s, x) => s + x.monto, 0);

    // Catálogo de display names (best effort).
    let catDisplay = new Map();
    try {
      const cats = await many(`SELECT codigo, nombre_display FROM ab_categorias`);
      catDisplay = new Map(cats.map((c) => [c.codigo, c.nombre_display]));
    } catch (e) { /* tolerante */ }

    const egresos_por_categoria = [...egresosMap.values()].map((x) => ({
      categoria: x.cat,
      nombre_display: catDisplay.get(x.cat) || x.cat,
      banco: Math.round(x.banco * 100) / 100,
      efectivo: Math.round(x.efectivo * 100) / 100,
      total: Math.round((x.banco + x.efectivo) * 100) / 100,
      pct: gasTot > 0 ? Math.round((x.banco + x.efectivo) / gasTot * 1000) / 10 : 0,
      top_banco: [...x.top_banco.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([k, v]) => ({ label: k, monto: Math.round(v * 100) / 100 })),
      top_caja:  [...x.top_caja.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([k, v]) => ({ label: k, monto: Math.round(v * 100) / 100 })),
    })).sort((a, b) => b.total - a.total);

    sin_categoria_efectivo.sort((a, b) => b.monto - a.monto);

    res.json({
      filtros: { sociedad_id: sociedadParam, desde, hasta,
                 incluir_especiales: req.query.incluir_especiales === 'true',
                 incluir_prorrateo: req.query.incluir_prorrateo !== 'false' },
      kpis: {
        ingresos_total: Math.round(ingTot * 100) / 100,
        egresos_total:  Math.round(gasTot * 100) / 100,
        neto:           Math.round((ingTot - gasTot) * 100) / 100,
        cobertura_efectivo: Math.round(cobertura_efectivo * 10) / 10,
        banco_ingresos: Math.round(ingB * 100) / 100,
        banco_egresos:  Math.round(gasB * 100) / 100,
        caja_ingresos:  Math.round(ingC * 100) / 100,
        caja_egresos:   Math.round(gasC * 100) / 100,
      },
      ingresos_por_origen,
      egresos_por_categoria,
      sin_categoria_efectivo: {
        total: Math.round(sinTot * 100) / 100,
        n: sin_categoria_efectivo.length,
        movs: sin_categoria_efectivo.slice(0, 50),
      },
    });
  } catch (e) {
    console.error('[caja.flujo-total]', e);
    res.status(500).json({ error: 'internal' });
  }
});

module.exports = router;
