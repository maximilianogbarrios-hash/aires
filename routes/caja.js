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
const {
  proveedorDeCaja, esTraspasoInternoCaja, esTraspasoInternoBanco,
} = require('../lib/caja/proveedor-caja');
const { esIntraGrupo, normalizarProveedor } = require('../lib/bank/normalizers');
const { loadReglas, matchRegla } = require('../lib/bank/db-rules');

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

// ─── Helpers compartidos para los 3 endpoints del donut combinado ─────
// Construye el WHERE de banco siguiendo el patrón de /proveedores:
// sociedad, período, importe<0 (gastos). INTRAGRUPO se filtra en runtime.
function buildWhereBanco(req) {
  const where = ['importe < 0'];
  const vals = [];
  const sociedad = req.query.sociedad_id || null;
  if (sociedad) {
    if (sociedad === 'sin_elche')      { where.push(`sociedad_id <> $${vals.length+1}`); vals.push('hostelero'); }
    else if (sociedad === 'solo_elche'){ where.push(`sociedad_id  = $${vals.length+1}`); vals.push('hostelero'); }
    else                               { where.push(`sociedad_id  = $${vals.length+1}`); vals.push(sociedad); }
  }
  if (req.query.desde) { where.push(`fecha >= $${vals.length+1}`); vals.push(req.query.desde); }
  if (req.query.hasta) { where.push(`fecha <= $${vals.length+1}`); vals.push(req.query.hasta); }
  if (!esAdminLike(req)) { where.push(`fecha >= $${vals.length+1}`); vals.push(PERIODO_FLOOR_NO_ADMIN); }
  return { where, vals };
}

// Construye el WHERE de caja con misma semántica que buildFilters() pero
// forzando egresos (importe>0 en caja = ingreso, importe<0 = egreso por
// convención de ab_caja_movimientos donde monto es siempre positivo y
// el signo lo determina `tipo='Egreso'|'Ingreso'`).
function buildWhereCaja(req, soloEgreso) {
  const reqCaja = Object.assign({}, req, {
    query: Object.assign({}, req.query, soloEgreso ? { tipo: 'egreso' } : {}),
  });
  return buildFilters(reqCaja);
}

// Pipeline regla>histórico>heurística para banco (igual que /proveedores)
async function categorizarBancoRow(r, reglasDb) {
  let proveedor, categoria;
  const rule = matchRegla(r.concepto, reglasDb);
  if (rule) { proveedor = rule.proveedor_normalizado; categoria = rule.categoria; }
  else if (r.proveedor_normalizado) { proveedor = r.proveedor_normalizado; categoria = r.categoria || 'SIN_CLASIFICAR'; }
  else { const n = normalizarProveedor(r.concepto, r.categoria); proveedor = n.proveedor || r.concepto; categoria = n.categoria || 'SIN_CLASIFICAR'; }
  return { proveedor, categoria };
}

// Catálogo de display de categorías (cached por request).
async function loadCatDisplay() {
  try {
    const cats = await many(`SELECT codigo, nombre_display FROM ab_categorias`);
    return new Map(cats.map((c) => [c.codigo, c.nombre_display]));
  } catch (e) {
    return new Map();
  }
}

// Período anterior del mismo tamaño que el filtro (espejo del helper de bancos.js).
function _shiftMonth(yyyymmdd, deltaMeses) {
  // yyyymmdd YYYY-MM-DD → desplaza meses, devuelve YYYY-MM-DD primer día del mes nuevo.
  const [y, m] = yyyymmdd.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + deltaMeses, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}
function _lastDayOfMonth(yyyymm01) {
  const [y, m] = yyyymm01.split('-').map(Number);
  return `${y}-${String(m).padStart(2, '0')}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
}
function periodoAnteriorCajaBanco(desde, hasta) {
  if (!desde || !hasta) return null;
  const [yd, md] = desde.split('-').map(Number);
  const [yh, mh] = hasta.split('-').map(Number);
  const nMeses = (yh - yd) * 12 + (mh - md) + 1;
  const prevDesde = _shiftMonth(desde, -nMeses);
  const prevHastaMes = _shiftMonth(hasta, -nMeses);
  return { desde: prevDesde, hasta: _lastDayOfMonth(prevHastaMes) };
}

// Agregado por categoría combinando banco + caja. Devuelve Map<cat, {banco_egr, caja_egr, banco_ing, caja_ing, n_movs, n_provs:Set, traspaso_banco, traspaso_caja}>
async function agregarPorCategoria(req, fuente) {
  const reglasDb = await loadReglas();
  const catAgg = new Map();
  const proveedorSet = new Map(); // cat → Set de provs (string)
  function ensure(cat) {
    if (!catAgg.has(cat)) catAgg.set(cat, { banco_egr: 0, caja_egr: 0, banco_ing: 0, caja_ing: 0, n_movs: 0 });
    if (!proveedorSet.has(cat)) proveedorSet.set(cat, new Set());
    return catAgg.get(cat);
  }
  let banco_traspaso = 0, caja_traspaso = 0;

  // BANCO
  if (fuente === 'todo' || fuente === 'banco') {
    const { where: wB, vals: vB } = buildWhereBanco(req);
    // Necesitamos también los ingresos banco — quitar el filtro 'importe<0'.
    const wAll = wB.filter((c) => c !== 'importe < 0');
    const rows = await many(
      `SELECT concepto, categoria, importe::float8 AS importe, proveedor_normalizado
         FROM ab_movimientos WHERE ${wAll.join(' AND ')}`,
      vB
    );
    for (const r of rows) {
      if (esTraspasoInternoBanco(r.concepto)) { banco_traspaso += Math.abs(r.importe); continue; }
      if (esIntraGrupo(r.concepto) || r.categoria === 'INTRAGRUPO') continue;
      const { proveedor, categoria } = await categorizarBancoRow(r, reglasDb);
      if (categoria === 'INTRAGRUPO') continue;
      const ent = ensure(categoria);
      ent.n_movs++;
      const abs = Math.abs(r.importe);
      if (r.importe < 0) ent.banco_egr += abs;
      else ent.banco_ing += r.importe;
      proveedorSet.get(categoria).add(proveedor);
    }
  }

  // CAJA
  if (fuente === 'todo' || fuente === 'efectivo') {
    const { sql: sqlC, vals: valsC } = buildWhereCaja(req, false);
    const rows = await many(
      `SELECT id, fecha::text, sucursal, sociedad_id, tipo, subtipo,
              monto::float8 AS monto, observaciones
         FROM ab_caja_movimientos ${sqlC}`,
      valsC
    );
    for (const r of rows) {
      if (esTraspasoInternoCaja(r.subtipo, r.observaciones)) { caja_traspaso += r.monto; continue; }
      const cat = categoriaDeSubtipoCaja(r.subtipo);
      if (cat === 'INTRAGRUPO') continue;
      const ent = ensure(cat);
      ent.n_movs++;
      const prov = proveedorDeCaja(r.subtipo);
      proveedorSet.get(cat).add(prov);
      if ((r.tipo || '').toLowerCase() === 'egreso') ent.caja_egr += r.monto;
      else if ((r.tipo || '').toLowerCase() === 'ingreso') ent.caja_ing += r.monto;
    }
  }

  // Materializar n_provs como número antes de devolver.
  const result = new Map();
  for (const [cat, v] of catAgg.entries()) {
    result.set(cat, { ...v, n_proveedores: proveedorSet.get(cat).size });
  }
  return { catAgg: result, banco_traspaso, caja_traspaso };
}

// ─── Endpoint principal: donut combinado por categoría ────────────────
router.get('/donut-categorias', async (req, res) => {
  try {
    const fuente = (req.query.fuente || 'todo').toLowerCase(); // todo|banco|efectivo
    const validFuente = ['todo', 'banco', 'efectivo'].includes(fuente) ? fuente : 'todo';
    const { catAgg, banco_traspaso, caja_traspaso } = await agregarPorCategoria(req, validFuente);

    // Período anterior (mismo tamaño) — sólo si hay desde+hasta.
    const prev = (req.query.desde && req.query.hasta)
      ? periodoAnteriorCajaBanco(req.query.desde, req.query.hasta) : null;
    let prevAgg = new Map();
    let prevGastoTot = 0, prevIngresoTot = 0;
    if (prev) {
      const reqPrev = Object.assign({}, req, {
        query: Object.assign({}, req.query, { desde: prev.desde, hasta: prev.hasta }),
      });
      const p = await agregarPorCategoria(reqPrev, validFuente);
      prevAgg = p.catAgg;
      for (const v of prevAgg.values()) {
        prevGastoTot += v.banco_egr + v.caja_egr;
        prevIngresoTot += v.banco_ing + v.caja_ing;
      }
    }

    // KPIs combinados.
    let gasto_banco = 0, gasto_caja = 0, ingreso_banco = 0, ingreso_caja = 0;
    let n_movs_tot = 0;
    const provGlobalSet = new Set();
    for (const v of catAgg.values()) {
      gasto_banco += v.banco_egr; gasto_caja += v.caja_egr;
      ingreso_banco += v.banco_ing; ingreso_caja += v.caja_ing;
      n_movs_tot += v.n_movs;
    }
    const gasto_total = gasto_banco + gasto_caja;
    const ingreso_total = ingreso_banco + ingreso_caja;
    const neto = ingreso_total - gasto_total;

    const catDisplay = await loadCatDisplay();
    const categorias = [...catAgg.entries()].map(([cat, v]) => {
      const total_egreso = v.banco_egr + v.caja_egr;
      const prevV = prevAgg.get(cat) || { banco_egr: 0, caja_egr: 0 };
      const prev_egreso = prevV.banco_egr + prevV.caja_egr;
      const pct_actual = gasto_total > 0 ? total_egreso / gasto_total : 0;
      const pct_prev = prevGastoTot > 0 ? prev_egreso / prevGastoTot : 0;
      const split_banco = total_egreso > 0 ? v.banco_egr / total_egreso : 0;
      return {
        codigo: cat,
        nombre_display: catDisplay.get(cat) || cat,
        total_egreso: Math.round(total_egreso * 100) / 100,
        banco_egreso: Math.round(v.banco_egr * 100) / 100,
        efectivo_egreso: Math.round(v.caja_egr * 100) / 100,
        n_movs: v.n_movs,
        n_proveedores: v.n_proveedores,
        pct_sobre_gasto: Math.round(pct_actual * 1000) / 10,
        pct_sobre_ingreso: ingreso_total > 0 ? Math.round(total_egreso / ingreso_total * 1000) / 10 : 0,
        split_banco_pct: Math.round(split_banco * 1000) / 10,
        split_efectivo_pct: Math.round((1 - split_banco) * 1000) / 10,
        // Comparativa período anterior.
        tiene_anterior: !!prev && prevGastoTot > 0,
        importe_anterior: Math.round(prev_egreso * 100) / 100,
        var_importe: Math.round((total_egreso - prev_egreso) * 100) / 100,
        var_pp: Math.round((pct_actual - pct_prev) * 1000) / 10,
      };
    }).sort((a, b) => b.total_egreso - a.total_egreso);

    res.json({
      filtros: { sociedad_id: req.query.sociedad_id || null, desde: req.query.desde || null, hasta: req.query.hasta || null, fuente: validFuente },
      kpis: {
        gasto_total: Math.round(gasto_total * 100) / 100,
        gasto_banco: Math.round(gasto_banco * 100) / 100,
        gasto_caja:  Math.round(gasto_caja  * 100) / 100,
        ingreso_total: Math.round(ingreso_total * 100) / 100,
        ingreso_banco: Math.round(ingreso_banco * 100) / 100,
        ingreso_caja:  Math.round(ingreso_caja  * 100) / 100,
        neto: Math.round(neto * 100) / 100,
        n_movs: n_movs_tot,
        n_proveedores: categorias.reduce((s, c) => s + c.n_proveedores, 0), // aproximado (puede duplicar entre cats)
        traspasos_internos_banco: Math.round(banco_traspaso * 100) / 100,
        traspasos_internos_caja:  Math.round(caja_traspaso  * 100) / 100,
      },
      categorias,
      comparativa_anterior: prev,
    });
  } catch (e) {
    console.error('[caja.donut-categorias]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ─── Drill-down: proveedores de una categoría ─────────────────────────
router.get('/donut-proveedores', async (req, res) => {
  try {
    const cat = String(req.query.categoria || '').trim();
    if (!cat) return res.status(400).json({ error: 'categoria requerida' });
    const fuente = (req.query.fuente || 'todo').toLowerCase();
    const validFuente = ['todo', 'banco', 'efectivo'].includes(fuente) ? fuente : 'todo';

    const reglasDb = await loadReglas();
    const map = new Map(); // proveedor → { banco_egr, caja_egr, n_movs }
    function ensure(prov) {
      if (!map.has(prov)) map.set(prov, { proveedor: prov, banco_egr: 0, caja_egr: 0, banco_ing: 0, caja_ing: 0, n_movs: 0 });
      return map.get(prov);
    }

    if (validFuente === 'todo' || validFuente === 'banco') {
      const { where, vals } = buildWhereBanco(req);
      const wAll = where.filter((c) => c !== 'importe < 0');
      const rows = await many(
        `SELECT concepto, categoria, importe::float8 AS importe, proveedor_normalizado
           FROM ab_movimientos WHERE ${wAll.join(' AND ')}`,
        vals
      );
      for (const r of rows) {
        if (esTraspasoInternoBanco(r.concepto)) continue;
        if (esIntraGrupo(r.concepto) || r.categoria === 'INTRAGRUPO') continue;
        const { proveedor, categoria } = await categorizarBancoRow(r, reglasDb);
        if (categoria !== cat) continue;
        const ent = ensure(proveedor);
        ent.n_movs++;
        const abs = Math.abs(r.importe);
        if (r.importe < 0) ent.banco_egr += abs; else ent.banco_ing += r.importe;
      }
    }
    if (validFuente === 'todo' || validFuente === 'efectivo') {
      const { sql: sqlC, vals: valsC } = buildWhereCaja(req, false);
      const rows = await many(
        `SELECT subtipo, tipo, monto::float8 AS monto, observaciones
           FROM ab_caja_movimientos ${sqlC}`,
        valsC
      );
      for (const r of rows) {
        if (esTraspasoInternoCaja(r.subtipo, r.observaciones)) continue;
        const c = categoriaDeSubtipoCaja(r.subtipo);
        if (c !== cat) continue;
        const prov = proveedorDeCaja(r.subtipo);
        const ent = ensure(prov);
        ent.n_movs++;
        if ((r.tipo || '').toLowerCase() === 'egreso') ent.caja_egr += r.monto;
        else if ((r.tipo || '').toLowerCase() === 'ingreso') ent.caja_ing += r.monto;
      }
    }

    const proveedores = [...map.values()].map((v) => ({
      proveedor: v.proveedor,
      total_egreso: Math.round((v.banco_egr + v.caja_egr) * 100) / 100,
      banco_egreso: Math.round(v.banco_egr * 100) / 100,
      efectivo_egreso: Math.round(v.caja_egr * 100) / 100,
      total_ingreso: Math.round((v.banco_ing + v.caja_ing) * 100) / 100,
      n_movs: v.n_movs,
    })).sort((a, b) => (b.total_egreso + b.total_ingreso) - (a.total_egreso + a.total_ingreso));

    res.json({ categoria: cat, fuente: validFuente, proveedores });
  } catch (e) {
    console.error('[caja.donut-proveedores]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ─── Drill-down nivel 2: movs individuales de un proveedor en una categoría ──
router.get('/donut-movimientos', async (req, res) => {
  try {
    const cat = String(req.query.categoria || '').trim();
    const prov = String(req.query.proveedor || '').trim();
    if (!cat || !prov) return res.status(400).json({ error: 'categoria + proveedor requeridos' });
    const fuente = (req.query.fuente || 'todo').toLowerCase();
    const validFuente = ['todo', 'banco', 'efectivo'].includes(fuente) ? fuente : 'todo';

    const reglasDb = await loadReglas();
    const movs = [];

    if (validFuente === 'todo' || validFuente === 'banco') {
      const { where, vals } = buildWhereBanco(req);
      const wAll = where.filter((c) => c !== 'importe < 0');
      const rows = await many(
        `SELECT id, fecha::text, concepto, categoria, importe::float8 AS importe,
                sociedad_id, proveedor_normalizado
           FROM ab_movimientos WHERE ${wAll.join(' AND ')}
          ORDER BY fecha DESC, id DESC`,
        vals
      );
      for (const r of rows) {
        if (esTraspasoInternoBanco(r.concepto)) continue;
        if (esIntraGrupo(r.concepto) || r.categoria === 'INTRAGRUPO') continue;
        const { proveedor, categoria } = await categorizarBancoRow(r, reglasDb);
        if (categoria !== cat || proveedor !== prov) continue;
        movs.push({
          origen: 'banco',
          id: r.id, fecha: r.fecha, descripcion: r.concepto,
          importe: Math.round(r.importe * 100) / 100,
          sociedad_id: r.sociedad_id, sucursal: null, tipo: r.importe < 0 ? 'Egreso' : 'Ingreso',
        });
      }
    }
    if (validFuente === 'todo' || validFuente === 'efectivo') {
      const { sql: sqlC, vals: valsC } = buildWhereCaja(req, false);
      const rows = await many(
        `SELECT id, fecha::text, sucursal, sociedad_id, tipo, subtipo,
                monto::float8 AS monto, observaciones
           FROM ab_caja_movimientos ${sqlC}
          ORDER BY fecha DESC, id DESC`,
        valsC
      );
      for (const r of rows) {
        if (esTraspasoInternoCaja(r.subtipo, r.observaciones)) continue;
        const c = categoriaDeSubtipoCaja(r.subtipo);
        if (c !== cat) continue;
        if (proveedorDeCaja(r.subtipo) !== prov) continue;
        const signo = (r.tipo || '').toLowerCase() === 'egreso' ? -1 : 1;
        movs.push({
          origen: 'efectivo',
          id: r.id, fecha: r.fecha, descripcion: r.subtipo || '(sin)',
          importe: Math.round(signo * r.monto * 100) / 100,
          sociedad_id: r.sociedad_id, sucursal: r.sucursal, tipo: r.tipo,
          observaciones: r.observaciones || null,
        });
      }
    }
    movs.sort((a, b) => (b.fecha + '').localeCompare(a.fecha + ''));

    res.json({ categoria: cat, proveedor: prov, fuente: validFuente, n: movs.length, movimientos: movs.slice(0, 200) });
  } catch (e) {
    console.error('[caja.donut-movimientos]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ─── Reconciliación contra sistema externo "Control de Cajas" ──────────
// Compara saldo calculado en Aires Solo (Σ ingresos − Σ egresos por caja)
// contra el saldo_actual reportado por el sistema externo (persistido en
// ab_caja_saldos_externos al importar el CSV).
//
// Devuelve una fila por caja con FULL OUTER JOIN — incluye cajas que
// existen solo en un lado (caso `solo_externo` / `solo_calculado`).
// Tolerancia de cuadre: 0,01 €.
//
// Nota informativa: los saldos parten de 0 al 09/07/2025 (primer mov
// del histórico); NO representan efectivo físico previo. Cuadrar entre
// ambos sistemas significa que el histórico está completo y consistente.
router.get('/reconciliacion', async (req, res) => {
  try {
    const rows = await many(`
      WITH calc AS (
        SELECT sucursal,
               COALESCE(SUM(CASE WHEN tipo='Ingreso' THEN monto ELSE 0 END), 0)::float8 AS ing_calc,
               COALESCE(SUM(CASE WHEN tipo='Egreso'  THEN monto ELSE 0 END), 0)::float8 AS egr_calc,
               COUNT(*)::int AS n_calc
        FROM ab_caja_movimientos
        GROUP BY sucursal
      )
      SELECT COALESCE(calc.sucursal, ext.sucursal) AS sucursal,
             calc.ing_calc, calc.egr_calc,
             (calc.ing_calc - calc.egr_calc) AS saldo_calculado,
             calc.n_calc,
             ext.saldo_actual::float8 AS saldo_externo,
             ext.total_ingresos::float8 AS ing_externo,
             ext.total_egresos::float8 AS egr_externo,
             ext.n_movimientos AS n_externo,
             ext.primer_mov::text AS primer_mov,
             ext.ultimo_mov::text AS ultimo_mov,
             ext.fuente AS fuente_externa,
             ext.imported_at AS importado_en
      FROM calc
      FULL OUTER JOIN ab_caja_saldos_externos ext USING (sucursal)
      ORDER BY sucursal`);

    const TOL = 0.01;
    const cajas = rows.map((r) => {
      const soloCalc = r.saldo_externo === null;
      const soloExt = r.saldo_calculado === null;
      const sc = r.saldo_calculado || 0;
      const se = r.saldo_externo || 0;
      const diff = sc - se;
      let estado;
      if (soloCalc) estado = 'solo_calculado';
      else if (soloExt) estado = 'solo_externo';
      else if (Math.abs(diff) <= TOL) estado = 'OK';
      else estado = 'DIFERENCIA';
      return {
        sucursal: r.sucursal,
        saldo_calculado: r.saldo_calculado,
        saldo_externo: r.saldo_externo,
        diff,
        estado,
        ing_calc: r.ing_calc,
        egr_calc: r.egr_calc,
        n_calc: r.n_calc,
        ing_externo: r.ing_externo,
        egr_externo: r.egr_externo,
        n_externo: r.n_externo,
        primer_mov: r.primer_mov,
        ultimo_mov: r.ultimo_mov,
      };
    });

    const totals = {
      n_cajas: cajas.length,
      n_ok: cajas.filter((c) => c.estado === 'OK').length,
      n_diferencia: cajas.filter((c) => c.estado === 'DIFERENCIA').length,
      n_solo_calculado: cajas.filter((c) => c.estado === 'solo_calculado').length,
      n_solo_externo: cajas.filter((c) => c.estado === 'solo_externo').length,
      saldo_total_calculado: cajas.reduce((s, c) => s + (c.saldo_calculado || 0), 0),
      saldo_total_externo: cajas.reduce((s, c) => s + (c.saldo_externo || 0), 0),
    };

    res.json({
      cajas,
      totals,
      tolerancia: TOL,
      fuente_externa: rows[0]?.fuente_externa || null,
      importado_en: rows[0]?.importado_en || null,
      nota: 'Los saldos parten de 0 al 09/07/2025 (primer mov del histórico). NO representan efectivo físico previo a esa fecha; ambos sistemas deben cuadrar entre sí.',
    });
  } catch (e) {
    console.error('[caja.reconciliacion]', e);
    res.status(500).json({ error: 'internal' });
  }
});

module.exports = router;
