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
// Helper DB-driven (preferido). categoriaDeSubtipoCajaSync se llama
// dentro de loops sobre filas; antes hay que await loadMapeos() para
// precargar la cache. Si la tabla está vacía/falla → fallback al
// hardcoded `categoriaDeSubtipoCaja`.
const {
  loadMapeos, invalidateMapeosCache, categoriaDeSubtipoCajaSync,
  categoriaDeSubtipoCajaAsync,
} = require('../lib/caja/mapeo-db');
const {
  proveedorDeCaja, esTraspasoInternoCaja, esTraspasoInternoBanco,
} = require('../lib/caja/proveedor-caja');
const { esIntraGrupo, normalizarProveedor } = require('../lib/bank/normalizers');
const { loadReglas, matchRegla } = require('../lib/bank/db-rules');
const bankDb = require('../lib/bank/db');
const { query } = require('../lib/db');
const { jsonSanitizerMiddleware, markEndpoint } = require('../lib/access/sanitize');
const tagAggregate = markEndpoint('aggregate');
const tagDetail    = markEndpoint('detail');

const router = express.Router();
router.use(requireAuth);
router.use(requirePerm('caja_view'));
// Red de seguridad: ver lib/access/sanitize.js. Para no-admin elimina
// GASTOS_DIRECCION/NOMINAS_DIRECCION/PRESTAMOS de cualquier array y
// enmascara strings que matcheen el patrón Raba con RABA_MASK.
router.use(jsonSanitizerMiddleware);

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
router.get('/resumen', tagAggregate, async (req, res) => {
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
router.get('/por-sucursal', tagAggregate, async (req, res) => {
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
router.get('/por-sociedad', tagAggregate, async (req, res) => {
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
router.get('/categorias', tagAggregate, async (req, res) => {
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
router.get('/flujo-mensual', tagAggregate, async (req, res) => {
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
router.get('/movimientos', tagDetail, async (req, res) => {
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
router.get('/combinado', tagAggregate, async (req, res) => {
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
router.get('/flujo-total', tagAggregate, async (req, res) => {
  try {
    // Precarga el mapeo DB-driven (cache 60s) antes del loop sobre cajaRows.
    await loadMapeos();
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

    // ─── KPIs agregados (UNA sola base con el donut combinado) ────────
    // Reconciliado 2026-06-07: los KPIs de ARRIBA aplican EXACTAMENTE
    // los mismos filtros que el donut, para que ambos bloques cuadren
    // al céntimo en cualquier período (mes único y rango). Antes el
    // bloque de arriba sumaba bruto, lo que dejaba dentro:
    //   · esIntraGrupo(concepto) en banco — aportaciones/préstamos
    //     entre sociedades del grupo y Raba Buildings (no son flujo
    //     real, son neteo intragrupo).
    //   · esTraspasoInternoBanco(concepto) — depósitos efectivo→banco.
    //   · esTraspasoInternoCaja(subtipo) — depósitos caja→banco.
    // Misma base = misma definición de "real" en toda la tab.
    //
    // PRESTAMOS / FINANCIERO regulares (cuotas hipoteca, comisiones
    // bancarias, etc.) siguen contando como gasto/ingreso real. Solo
    // se descartan los movs heurísticamente intragrupo o traspasos.
    let ingB = 0, gasB = 0, ingC = 0, gasC = 0;
    let banco_traspaso_kpi = 0, caja_traspaso_kpi = 0;
    for (const r of bancoRows) {
      if (esTraspasoInternoBanco(r.concepto)) {
        banco_traspaso_kpi += Math.abs(r.importe);
        continue;
      }
      if (esIntraGrupo(r.concepto) || r.categoria === 'INTRAGRUPO') continue;
      if (r.importe > 0) ingB += r.importe;
      else gasB += Math.abs(r.importe);
    }
    for (const r of cajaRows) {
      const t = (r.tipo || '').toLowerCase();
      if (esTraspasoInternoCaja(r.subtipo, r.observaciones)) {
        caja_traspaso_kpi += r.monto;
        continue;
      }
      if (t === 'ingreso') ingC += r.monto;
      else if (t === 'egreso') gasC += r.monto;
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
      // Misma base que los KPIs: descartar intragrupo + traspasos.
      if (esTraspasoInternoBanco(r.concepto)) continue;
      if (esIntraGrupo(r.concepto) || r.categoria === 'INTRAGRUPO') continue;
      const o = origenIngresoBanco(r.concepto);
      ensureIng(o, 'banco').banco += r.importe;
    }
    for (const r of cajaRows) {
      if ((r.tipo || '').toLowerCase() !== 'ingreso') continue;
      if (esTraspasoInternoCaja(r.subtipo, r.observaciones)) continue;
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
      // Misma base que los KPIs: descartar intragrupo + traspasos.
      if (esTraspasoInternoBanco(r.concepto)) continue;
      if (esIntraGrupo(r.concepto) || r.categoria === 'INTRAGRUPO') continue;
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
      if (esTraspasoInternoCaja(r.subtipo, r.observaciones)) continue;
      const cat = categoriaDeSubtipoCajaSync(r.subtipo);
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
        // Traspasos internos / intragrupo neutralizados — informativos
        // para que el frontend pueda mostrar "ignorados: €X" si quisiera.
        // Misma definición que el donut combinado.
        traspasos_internos_banco: Math.round(banco_traspaso_kpi * 100) / 100,
        traspasos_internos_caja:  Math.round(caja_traspaso_kpi * 100) / 100,
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

// ─── GUARDRAIL ANTI-DOBLE-CONTEO ─────────────────────────────────────────
//
// Regla invariante: en el donut combinado, los EGRESOS de las cajas
// internas (ESPECIALES, PRODUCCIÓN, OFICINA, NAVE, etc.) NUNCA deben
// sumar al gasto, porque esas cajas son CONTENEDORES PADRE cuyo monto
// total ya viene repartido por el sistema externo como "Prorrateo
// desde ESPECIALES/PRODUCCIÓN" a las cajas operativas. Si entrasen
// ambos, se duplicaría ~€196k (€99k ESPECIALES + €97k PRODUCCIÓN).
//
// Este helper devuelve el WHERE de CAJA para egresos del donut con
// `es_especial = FALSE` FORZADO — ignora el query param
// `incluir_especiales` (que el toggle del frontend expone). El toggle
// puede seguir afectando ingresos / KPIs, pero el cálculo de gasto del
// donut combinado SIEMPRE excluye padres.
function buildWhereCajaEgresoDonut(req) {
  // Clonar req quitando incluir_especiales: el helper buildFilters
  // sólo añade el filtro es_especial=FALSE cuando NO se setea el flag,
  // así que basta con forzar incluir_especiales=false.
  const safeQuery = Object.assign({}, req.query);
  safeQuery.incluir_especiales = 'false';
  const safeReq = Object.assign({}, req, { query: safeQuery });
  return buildFilters(safeReq);
}

// Sanity check: después de leer las filas de caja, verifica que
// ninguna venga de una caja interna/excluir según
// ab_caja_mapeo_sociedades. Si las hay, loguea warning con el monto
// para que se vea en Railway logs y no se pase silenciosamente.
let _internasSet = null;
let _internasSetUntil = 0;
async function loadInternasSet() {
  const now = Date.now ? Date.now() : new Date().getTime();
  if (_internasSet && now < _internasSetUntil) return _internasSet;
  try {
    const rows = await many(
      `SELECT caja_origen FROM ab_caja_mapeo_sociedades
        WHERE tipo IN ('interno','excluir') AND activa=TRUE`,
      []
    );
    _internasSet = new Set(rows.map((r) => r.caja_origen));
    _internasSetUntil = (Date.now ? Date.now() : new Date().getTime()) + 60_000;
    return _internasSet;
  } catch (e) {
    return new Set();
  }
}
async function sanityNoInternasEnEgresos(rows, label) {
  const set = await loadInternasSet();
  if (set.size === 0) return;
  let n = 0, t = 0;
  const cajas = new Set();
  for (const r of rows) {
    if ((r.tipo || '').toLowerCase() !== 'egreso') continue;
    const key = String(r.sucursal || '').trim().toUpperCase();
    if (set.has(key)) { n++; t += +r.monto || 0; cajas.add(key); }
  }
  if (n > 0) {
    console.warn(
      `[GUARDRAIL ${label}] ⚠ ${n} egresos de cajas internas filtraron al donut: €${t.toFixed(2)} desde ${[...cajas].join(', ')} — debería ser 0. ` +
      'Revisar buildWhereCajaEgresoDonut() y es_especial.'
    );
  }
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
  // Precarga el mapeo DB-driven una vez por request — las llamadas
  // sincronas `categoriaDeSubtipoCajaSync` dentro del loop usarán la
  // cache ya caliente. Si la tabla está vacía, recae en el hardcoded.
  await loadMapeos();
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
    // Fallback 'TRUE' por si quedaran 0 condiciones (histórico completo).
    const wAll = wB.filter((c) => c !== 'importe < 0');
    const whereClause = wAll.length ? wAll.join(' AND ') : 'TRUE';
    const rows = await many(
      `SELECT concepto, categoria, importe::float8 AS importe, proveedor_normalizado
         FROM ab_movimientos WHERE ${whereClause}`,
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

  // CAJA — dos queries separados para blindar contra doble conteo:
  //   · EGRESOS  → buildWhereCajaEgresoDonut() FUERZA es_especial=FALSE,
  //                ignora el toggle incluir_especiales del frontend.
  //                Las cajas padre (ESPECIALES/PRODUCCIÓN) ya están
  //                repartidas en operativas como "Prorrateo desde X";
  //                contar también la padre duplicaría ~€196k.
  //   · INGRESOS → respeta incluir_especiales (no hay riesgo de
  //                duplicación porque las padre no generan ingresos
  //                que se repartan).
  if (fuente === 'todo' || fuente === 'efectivo') {
    // Egresos blindados.
    const { sql: sqlE, vals: valsE } = buildWhereCajaEgresoDonut(
      Object.assign({}, req, { query: Object.assign({}, req.query, { tipo: 'egreso' }) })
    );
    const rowsEgr = await many(
      `SELECT id, fecha::text, sucursal, sociedad_id, tipo, subtipo,
              monto::float8 AS monto, observaciones
         FROM ab_caja_movimientos ${sqlE}`,
      valsE
    );
    await sanityNoInternasEnEgresos(rowsEgr, 'agregarPorCategoria');
    for (const r of rowsEgr) {
      if (esTraspasoInternoCaja(r.subtipo, r.observaciones)) { caja_traspaso += r.monto; continue; }
      const cat = categoriaDeSubtipoCajaSync(r.subtipo);
      if (cat === 'INTRAGRUPO') continue;
      const ent = ensure(cat);
      ent.n_movs++;
      const prov = proveedorDeCaja(r.subtipo);
      proveedorSet.get(cat).add(prov);
      ent.caja_egr += r.monto;
    }
    // Ingresos (respeta toggle).
    const { sql: sqlI, vals: valsI } = buildWhereCaja(
      Object.assign({}, req, { query: Object.assign({}, req.query, { tipo: 'ingreso' }) }), false
    );
    const rowsIng = await many(
      `SELECT id, fecha::text, sucursal, sociedad_id, tipo, subtipo,
              monto::float8 AS monto, observaciones
         FROM ab_caja_movimientos ${sqlI}`,
      valsI
    );
    for (const r of rowsIng) {
      if (esTraspasoInternoCaja(r.subtipo, r.observaciones)) { caja_traspaso += r.monto; continue; }
      const cat = categoriaDeSubtipoCajaSync(r.subtipo);
      if (cat === 'INTRAGRUPO') continue;
      const ent = ensure(cat);
      ent.n_movs++;
      const prov = proveedorDeCaja(r.subtipo);
      proveedorSet.get(cat).add(prov);
      ent.caja_ing += r.monto;
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
router.get('/donut-categorias', tagAggregate, async (req, res) => {
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
// NOTA: marcado tagAggregate porque devuelve TOP de proveedores agregados
// por categoría — pero si la cat solicitada ES sensible (GASTOS_DIRECCION /
// NOMINAS_DIRECCION), exponer la lista interna de proveedores es DETALLE
// → 403 explícito abajo. Defense in depth: el sanitizer también bloquea
// los items individuales con proveedor=FUSE o Raba.
router.get('/donut-proveedores', tagAggregate, async (req, res) => {
    // Bloqueo: cat sensible solicitada por no-admin → 403, no se expone
    // qué proveedores la componen.
    {
      const catReq = String(req.query.categoria || '').trim();
      if (!esAdminLike(req) && (catReq === 'GASTOS_DIRECCION' || catReq === 'NOMINAS_DIRECCION')) {
        return res.status(403).json({ error: 'Forbidden: categoría restringida por rol' });
      }
    }
  try {
    const cat = String(req.query.categoria || '').trim();
    if (!cat) return res.status(400).json({ error: 'categoria requerida' });
    const fuente = (req.query.fuente || 'todo').toLowerCase();
    const validFuente = ['todo', 'banco', 'efectivo'].includes(fuente) ? fuente : 'todo';

    const reglasDb = await loadReglas();
    await loadMapeos();
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
      // GUARDRAIL: egresos del donut SIEMPRE excluyen cajas internas
      // (es_especial=FALSE forzado). Los ingresos respetan el toggle.
      const { sql: sqlE, vals: valsE } = buildWhereCajaEgresoDonut(
        Object.assign({}, req, { query: Object.assign({}, req.query, { tipo: 'egreso' }) })
      );
      const rowsEgr = await many(
        `SELECT sucursal, subtipo, tipo, monto::float8 AS monto, observaciones
           FROM ab_caja_movimientos ${sqlE}`,
        valsE
      );
      await sanityNoInternasEnEgresos(rowsEgr, 'donut-proveedores');
      for (const r of rowsEgr) {
        if (esTraspasoInternoCaja(r.subtipo, r.observaciones)) continue;
        const c = categoriaDeSubtipoCajaSync(r.subtipo);
        if (c !== cat) continue;
        const prov = proveedorDeCaja(r.subtipo);
        const ent = ensure(prov);
        ent.n_movs++;
        ent.caja_egr += r.monto;
      }
      const { sql: sqlI, vals: valsI } = buildWhereCaja(
        Object.assign({}, req, { query: Object.assign({}, req.query, { tipo: 'ingreso' }) }), false
      );
      const rowsIng = await many(
        `SELECT subtipo, tipo, monto::float8 AS monto, observaciones
           FROM ab_caja_movimientos ${sqlI}`,
        valsI
      );
      for (const r of rowsIng) {
        if (esTraspasoInternoCaja(r.subtipo, r.observaciones)) continue;
        const c = categoriaDeSubtipoCajaSync(r.subtipo);
        if (c !== cat) continue;
        const prov = proveedorDeCaja(r.subtipo);
        const ent = ensure(prov);
        ent.n_movs++;
        ent.caja_ing += r.monto;
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
router.get('/donut-movimientos', tagDetail, async (req, res) => {
  try {
    const cat = String(req.query.categoria || '').trim();
    const prov = String(req.query.proveedor || '').trim();
    if (!cat || !prov) return res.status(400).json({ error: 'categoria + proveedor requeridos' });
    const fuente = (req.query.fuente || 'todo').toLowerCase();
    const validFuente = ['todo', 'banco', 'efectivo'].includes(fuente) ? fuente : 'todo';

    const reglasDb = await loadReglas();
    await loadMapeos();
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
      // GUARDRAIL: el drill-down de movs sigue la misma regla — los
      // egresos NUNCA muestran movs de cajas internas (padres). Los
      // ingresos respetan el toggle.
      const { sql: sqlE, vals: valsE } = buildWhereCajaEgresoDonut(
        Object.assign({}, req, { query: Object.assign({}, req.query, { tipo: 'egreso' }) })
      );
      const rowsEgr = await many(
        `SELECT id, fecha::text, sucursal, sociedad_id, tipo, subtipo,
                monto::float8 AS monto, observaciones
           FROM ab_caja_movimientos ${sqlE}
          ORDER BY fecha DESC, id DESC`,
        valsE
      );
      await sanityNoInternasEnEgresos(rowsEgr, 'donut-movimientos');
      const { sql: sqlI, vals: valsI } = buildWhereCaja(
        Object.assign({}, req, { query: Object.assign({}, req.query, { tipo: 'ingreso' }) }), false
      );
      const rowsIng = await many(
        `SELECT id, fecha::text, sucursal, sociedad_id, tipo, subtipo,
                monto::float8 AS monto, observaciones
           FROM ab_caja_movimientos ${sqlI}
          ORDER BY fecha DESC, id DESC`,
        valsI
      );
      for (const r of [...rowsEgr, ...rowsIng]) {
        if (esTraspasoInternoCaja(r.subtipo, r.observaciones)) continue;
        const c = categoriaDeSubtipoCajaSync(r.subtipo);
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
router.get('/reconciliacion', tagAggregate, async (req, res) => {
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

// ─── Mapeo subtipo caja → categoría banco (CRUD) ─────────────────────────
// Editor role-gated a admin/socio. El refactor del donut combinado lee
// estas reglas con cache (60s TTL), invalidada en cada PUT.

function soloAdmin(req, res, next) {
  if (!esAdminLike(req)) return res.status(403).json({ error: 'forbidden' });
  next();
}

// Lista todas las reglas (incluso inactivas), ordenadas como las evalúa
// el matcher: prioridad desc, id asc. Útil para mostrar en el editor.
router.get('/mapeos', soloAdmin, async (req, res) => {
  try {
    const rows = await many(
      `SELECT id, patron, tipo_match, prioridad, categoria_destino,
              notas, autor, activa, created_at, updated_at
         FROM ab_caja_mapeo_subtipos
        ORDER BY prioridad DESC, id ASC`,
      []
    );
    res.json({ reglas: rows });
  } catch (e) {
    console.error('[caja.mapeos.list]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// Bulk save: acepta { upserts: [{id?, patron, tipo_match, prioridad,
// categoria_destino, notas, activa}], deletes: [id, ...] }. Devuelve
// counts. Invalida cache en éxito.
router.put('/mapeos', soloAdmin, express.json(), async (req, res) => {
  try {
    const upserts = Array.isArray(req.body?.upserts) ? req.body.upserts : [];
    const deletes = Array.isArray(req.body?.deletes) ? req.body.deletes : [];
    const autor = req.session?.user?.email || 'desconocido';
    let nIns = 0, nUpd = 0, nDel = 0, nErr = 0;

    // Validar categoría destino contra ab_categorias (anti-typo silencioso).
    const cats = await many('SELECT codigo FROM ab_categorias', []);
    const catsValid = new Set(cats.map((c) => c.codigo));
    catsValid.add('SIN_CATEGORIA_CAJA'); // permitido como destino explícito
    catsValid.add('SIN_CLASIFICAR');

    for (const r of upserts) {
      const patron = String(r.patron || '').trim();
      const tipo_match = ['exact', 'prefix', 'regex'].includes(r.tipo_match) ? r.tipo_match : 'regex';
      const prioridad = Number.isFinite(+r.prioridad) ? +r.prioridad : 100;
      const cat = String(r.categoria_destino || '').trim();
      const notas = r.notas ? String(r.notas) : null;
      const activa = r.activa === false ? false : true;
      if (!patron || !cat) { nErr++; continue; }
      if (!catsValid.has(cat)) { nErr++; continue; }
      // Si es regex, validar que compila — evita romper el matcher.
      if (tipo_match === 'regex') {
        try { new RegExp(patron, 'i'); } catch (e) { nErr++; continue; }
      }

      if (r.id) {
        const upd = await one(
          `UPDATE ab_caja_mapeo_subtipos
             SET patron=$1, tipo_match=$2, prioridad=$3,
                 categoria_destino=$4, notas=$5, activa=$6,
                 autor=$7, updated_at=NOW()
           WHERE id=$8
           RETURNING id`,
          [patron, tipo_match, prioridad, cat, notas, activa, autor, r.id]
        );
        if (upd) nUpd++; else nErr++;
      } else {
        // Insert con ON CONFLICT (patron, tipo_match) DO UPDATE.
        const ins = await one(
          `INSERT INTO ab_caja_mapeo_subtipos
             (patron, tipo_match, prioridad, categoria_destino, notas, activa, autor)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (patron, tipo_match) DO UPDATE
             SET prioridad=EXCLUDED.prioridad,
                 categoria_destino=EXCLUDED.categoria_destino,
                 notas=EXCLUDED.notas,
                 activa=EXCLUDED.activa,
                 autor=EXCLUDED.autor,
                 updated_at=NOW()
           RETURNING (xmax = 0) AS inserted, id`,
          [patron, tipo_match, prioridad, cat, notas, activa, autor]
        );
        if (ins?.inserted) nIns++; else nUpd++;
      }
    }
    for (const id of deletes) {
      const del = await one(
        `DELETE FROM ab_caja_mapeo_subtipos WHERE id=$1 RETURNING id`,
        [id]
      );
      if (del) nDel++;
    }
    invalidateMapeosCache();
    res.json({ ok: true, inserted: nIns, updated: nUpd, deleted: nDel, errors: nErr });
  } catch (e) {
    console.error('[caja.mapeos.save]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// Lista las categorías canónicas para el dropdown del editor.
// Role-gated igual que el resto del CRUD.
router.get('/mapeos/categorias', soloAdmin, async (req, res) => {
  try {
    const rows = await many(
      `SELECT codigo, nombre_display
         FROM ab_categorias
        ORDER BY orden ASC, codigo ASC`,
      []
    );
    res.json({ categorias: rows });
  } catch (e) {
    console.error('[caja.mapeos.categorias]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// Subtipos de caja con sus € y nº movs + cómo mapean ACTUALMENTE.
// Filtros: ?solo_sin_clasificar=true para listar únicamente los que
// caen en SIN_CATEGORIA_CAJA. Útil para alimentar el panel del editor.
router.get('/mapeos/pendientes', soloAdmin, async (req, res) => {
  try {
    await loadMapeos();
    const soloSin = req.query.solo_sin_clasificar === 'true' || req.query.solo_sin_clasificar === '1';
    // Sólo gasto_directo egresos no especiales — el universo a
    // categorizar. cierre_pos/prorrateo_automatico/ingreso_directo no
    // van al donut de gastos.
    const rows = await many(
      `SELECT subtipo, COUNT(*)::int AS n,
              SUM(monto)::float8 AS total,
              MAX(fecha)::text AS ultimo_uso
         FROM ab_caja_movimientos
        WHERE categoria_caja='gasto_directo'
          AND LOWER(tipo)='egreso'
          AND es_especial=FALSE
        GROUP BY subtipo
        ORDER BY SUM(monto) DESC NULLS LAST`,
      []
    );
    const out = rows.map((r) => {
      const cat = categoriaDeSubtipoCajaSync(r.subtipo);
      return {
        subtipo: r.subtipo || '(vacío)',
        n: r.n,
        total: r.total,
        ultimo_uso: r.ultimo_uso,
        categoria_actual: cat,
        sin_clasificar: cat === 'SIN_CATEGORIA_CAJA',
      };
    }).filter((r) => !soloSin || r.sin_clasificar);
    const sumSinClasif = out
      .filter((r) => r.sin_clasificar)
      .reduce((s, r) => s + r.total, 0);
    res.json({
      subtipos: out,
      n_total: out.length,
      n_sin_clasif: out.filter((r) => r.sin_clasificar).length,
      total_sin_clasif: sumSinClasif,
    });
  } catch (e) {
    console.error('[caja.mapeos.pendientes]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ─── Mapeo caja externa → sociedad SL (CRUD) ──────────────────────────────
// Reemplaza el match por nombre de SUCURSAL_A_SOCIEDAD (hardcoded).
// Cada PUT re-ejecuta el backfill que sincroniza
// ab_caja_movimientos.sociedad_id con la tabla.

// GET — lista completa, ordenada por tipo (pendientes arriba para que
// el admin las atienda primero). Devuelve también las cajas presentes
// en ab_caja_movimientos que NO tienen entrada en la tabla (huérfanas
// — pueden aparecer cuando se importa un CSV con sucursal nueva).
router.get('/sociedades', soloAdmin, async (req, res) => {
  try {
    // Reglas de mapeo persistidas.
    const rows = await many(
      `SELECT id, caja_origen, tipo, sociedad_slug, sociedad_cif,
              sociedad_nombre, nombre_canonico, notas, autor, activa,
              created_at, updated_at
         FROM ab_caja_mapeo_sociedades
        ORDER BY
          CASE tipo WHEN 'pendiente' THEN 0 WHEN 'sociedad' THEN 1
                    WHEN 'interno'   THEN 2 ELSE 3 END,
          caja_origen ASC`,
      []
    );
    // Stats por caja desde la tabla de movs (para mostrar volumen).
    const stats = await many(
      `SELECT UPPER(TRIM(sucursal)) AS caja_origen,
              COUNT(*)::int AS n_movs,
              MIN(fecha)::text AS primer_mov,
              MAX(fecha)::text AS ultimo_mov,
              SUM(CASE WHEN LOWER(tipo)='ingreso'
                       THEN monto ELSE -monto END)::float8 AS saldo_neto
         FROM ab_caja_movimientos
        GROUP BY UPPER(TRIM(sucursal))`,
      []
    );
    const statsMap = new Map(stats.map((s) => [s.caja_origen, s]));
    const reglas = rows.map((r) => ({
      ...r,
      ...statsMap.get(r.caja_origen) || { n_movs: 0, saldo_neto: 0 },
    }));
    // Cajas huérfanas: existen en movs pero no tienen regla.
    const conRegla = new Set(rows.map((r) => r.caja_origen));
    const huerfanas = stats
      .filter((s) => !conRegla.has(s.caja_origen))
      .map((s) => ({ caja_origen: s.caja_origen, tipo: 'pendiente', ...s, _huerfana: true }));
    // Catálogo de sociedades para los dropdowns.
    const catalogo = await many(
      `SELECT DISTINCT sociedad_slug, sociedad_cif, sociedad_nombre
         FROM ab_caja_mapeo_sociedades
        WHERE tipo='sociedad' AND sociedad_slug IS NOT NULL
        ORDER BY sociedad_nombre`,
      []
    );
    res.json({
      reglas: [...huerfanas, ...reglas],
      catalogo_sociedades: catalogo,
      n_pendientes: reglas.filter((r) => r.tipo === 'pendiente').length + huerfanas.length,
    });
  } catch (e) {
    console.error('[caja.sociedades.list]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// Helper interno: re-ejecuta el backfill desde ab_caja_mapeo_sociedades
// hacia ab_caja_movimientos. Idempotente — solo toca filas con
// sociedad_id distinto del esperado.
async function backfillSociedadId() {
  const r1 = await one(
    `WITH upd AS (
      UPDATE ab_caja_movimientos m
         SET sociedad_id = s.sociedad_slug
        FROM ab_caja_mapeo_sociedades s
       WHERE s.caja_origen = UPPER(TRIM(m.sucursal))
         AND s.activa = TRUE
         AND m.sociedad_id IS DISTINCT FROM s.sociedad_slug
      RETURNING m.id
    ) SELECT COUNT(*)::int AS n FROM upd`,
    []
  );
  const r2 = await one(
    `WITH upd AS (
      UPDATE ab_caja_movimientos m
         SET sociedad_id = NULL
       WHERE m.sociedad_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM ab_caja_mapeo_sociedades s
            WHERE s.caja_origen = UPPER(TRIM(m.sucursal))
              AND s.activa = TRUE
              AND s.sociedad_slug IS NOT NULL
         )
      RETURNING m.id
    ) SELECT COUNT(*)::int AS n FROM upd`,
    []
  );
  return { reasignados: r1?.n || 0, nullificados: r2?.n || 0 };
}

// PUT bulk save + backfill automático. Body: { upserts: [...], deletes: [id, ...] }.
router.put('/sociedades', soloAdmin, express.json(), async (req, res) => {
  try {
    const upserts = Array.isArray(req.body?.upserts) ? req.body.upserts : [];
    const deletes = Array.isArray(req.body?.deletes) ? req.body.deletes : [];
    const autor = req.session?.user?.email || 'desconocido';
    let nIns = 0, nUpd = 0, nDel = 0, nErr = 0;

    const TIPOS = new Set(['sociedad', 'interno', 'pendiente', 'excluir']);

    for (const r of upserts) {
      const caja_origen = String(r.caja_origen || '').trim().toUpperCase();
      const tipo = TIPOS.has(r.tipo) ? r.tipo : 'pendiente';
      if (!caja_origen) { nErr++; continue; }

      // Si tipo='sociedad', requiere slug + cif + nombre.
      const slug = tipo === 'sociedad' ? String(r.sociedad_slug || '').trim() || null : null;
      const cif  = tipo === 'sociedad' ? String(r.sociedad_cif  || '').trim() || null : null;
      const nom  = tipo === 'sociedad' ? String(r.sociedad_nombre || '').trim() || null : null;
      if (tipo === 'sociedad' && (!slug || !nom)) { nErr++; continue; }

      const canonico = r.nombre_canonico ? String(r.nombre_canonico).trim() : null;
      const notas = r.notas ? String(r.notas).trim() : null;
      const activa = r.activa === false ? false : true;

      if (r.id) {
        const upd = await one(
          `UPDATE ab_caja_mapeo_sociedades
             SET caja_origen=$1, tipo=$2, sociedad_slug=$3,
                 sociedad_cif=$4, sociedad_nombre=$5,
                 nombre_canonico=$6, notas=$7, activa=$8,
                 autor=$9, updated_at=NOW()
           WHERE id=$10
           RETURNING id`,
          [caja_origen, tipo, slug, cif, nom, canonico, notas, activa, autor, r.id]
        );
        if (upd) nUpd++; else nErr++;
      } else {
        const ins = await one(
          `INSERT INTO ab_caja_mapeo_sociedades
             (caja_origen, tipo, sociedad_slug, sociedad_cif,
              sociedad_nombre, nombre_canonico, notas, activa, autor)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (caja_origen) DO UPDATE SET
             tipo=EXCLUDED.tipo,
             sociedad_slug=EXCLUDED.sociedad_slug,
             sociedad_cif=EXCLUDED.sociedad_cif,
             sociedad_nombre=EXCLUDED.sociedad_nombre,
             nombre_canonico=EXCLUDED.nombre_canonico,
             notas=EXCLUDED.notas,
             activa=EXCLUDED.activa,
             autor=EXCLUDED.autor,
             updated_at=NOW()
           RETURNING (xmax = 0) AS inserted, id`,
          [caja_origen, tipo, slug, cif, nom, canonico, notas, activa, autor]
        );
        if (ins?.inserted) nIns++; else nUpd++;
      }
    }
    for (const id of deletes) {
      const del = await one(
        `DELETE FROM ab_caja_mapeo_sociedades WHERE id=$1 RETURNING id`,
        [id]
      );
      if (del) nDel++;
    }
    // Backfill — re-sincroniza ab_caja_movimientos.sociedad_id con la
    // tabla recién editada.
    const bf = await backfillSociedadId();
    res.json({
      ok: true,
      inserted: nIns, updated: nUpd, deleted: nDel, errors: nErr,
      backfill: bf,
    });
  } catch (e) {
    console.error('[caja.sociedades.save]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ─── Mover proveedor a otra categoría (admin/socio) ──────────────────────
//
// REUTILIZA los motores existentes — no crea un sistema paralelo:
//   · BANCO    → ab_reglas_normalizacion (motor de Gestionar reglas).
//                  El backfill UPDATE ab_movimientos + recalc resumen es
//                  idéntico al de /api/v1/bancos/reglas-prov/asignar.
//   · EFECTIVO → ab_caja_mapeo_subtipos (motor del editor de mapeo).
//                Una regla `exact` por subtipo distinto que pertenezca
//                al proveedor, con prioridad 1500 (gana sobre las 1100
//                de prorrateo y las 700 de proveedores específicos).
//
// La regla queda guardada y se ve en su editor respectivo. Reversible:
// mover de vuelta = update de las mismas reglas con la cat original.
//
// `modo` controla el comportamiento:
//   · 'preview'   → solo cuenta, no escribe. Devuelve resumen.
//   · 'confirmar' → ejecuta upsert + UPDATE + recalc + invalidate cache.

// Validación de categoría destino contra ab_categorias.
async function _loadCategoriasValidas() {
  const rows = await many('SELECT codigo FROM ab_categorias', []);
  return new Set(rows.map((r) => r.codigo));
}

router.post('/mover-proveedor', soloAdmin, express.json(), async (req, res) => {
  try {
    const proveedor = String(req.body?.proveedor || '').trim();
    const categoria_origen = String(req.body?.categoria_origen || '').trim();
    const categoria_destino = String(req.body?.categoria_destino || '').trim();
    const modo = String(req.body?.modo || 'preview');
    if (!proveedor || !categoria_destino) {
      return res.status(400).json({ error: 'proveedor y categoria_destino requeridos' });
    }
    if (categoria_destino === categoria_origen) {
      return res.status(400).json({ error: 'categoria_destino igual a categoria_origen — nada que mover' });
    }
    const validas = await _loadCategoriasValidas();
    if (!validas.has(categoria_destino)) {
      return res.status(400).json({ error: `categoría inválida: "${categoria_destino}"` });
    }

    // ─── BANCO: contar movs con proveedor_normalizado = proveedor ───
    // Incluimos también match por concepto (substring) porque el motor
    // de reglas de banco hace exactamente eso al reclasificar.
    const movsBancoCnt = await one(
      `SELECT COUNT(*)::int AS n,
              COALESCE(SUM(ABS(importe)), 0)::float8 AS total
         FROM ab_movimientos
        WHERE (proveedor_normalizado = $1
               OR position(LOWER($1) IN LOWER(concepto)) > 0)
          AND importe < 0`,
      [proveedor]
    );

    // ─── CAJA: identificar subtipos que pertenecen al proveedor ────
    // Carga TODOS los subtipos distintos egresos y filtra por
    // proveedorDeCaja(subtipo) === proveedor. Esto refleja la misma
    // agrupación que ve el donut.
    const subtiposRows = await many(
      `SELECT subtipo, COUNT(*)::int AS n, SUM(monto)::float8 AS total
         FROM ab_caja_movimientos
        WHERE LOWER(tipo) = 'egreso'
          AND subtipo IS NOT NULL
        GROUP BY subtipo`,
      []
    );
    const subtiposMatch = subtiposRows.filter(
      (r) => proveedorDeCaja(r.subtipo) === proveedor
    );
    const movsCajaTotal = subtiposMatch.reduce((s, r) => s + r.n, 0);
    const importeCajaTotal = subtiposMatch.reduce((s, r) => s + r.total, 0);

    if (modo === 'preview') {
      return res.json({
        modo: 'preview',
        proveedor, categoria_origen, categoria_destino,
        banco: { n_movs: movsBancoCnt.n, total: movsBancoCnt.total },
        efectivo: {
          n_movs: movsCajaTotal,
          total: importeCajaTotal,
          subtipos: subtiposMatch.map((r) => ({ subtipo: r.subtipo, n: r.n, total: r.total })),
        },
        n_total_movs: movsBancoCnt.n + movsCajaTotal,
      });
    }

    if (modo !== 'confirmar') {
      return res.status(400).json({ error: 'modo debe ser preview o confirmar' });
    }

    // ─── EJECUTAR ─────────────────────────────────────────────────
    let banco_regla_id = null, banco_affected = 0;
    if (movsBancoCnt.n > 0) {
      // 1) Upsert regla idéntico al de /reglas-prov/asignar.
      let regla = await one(
        `SELECT id FROM ab_reglas_normalizacion
          WHERE proveedor_normalizado = $1 AND patron = $1 AND activo = TRUE
          LIMIT 1`,
        [proveedor]
      );
      if (regla) {
        await query(
          `UPDATE ab_reglas_normalizacion
              SET categoria = $1, prioridad = 120, forzar_visible = TRUE
            WHERE id = $2`,
          [categoria_destino, regla.id]
        );
      } else {
        regla = await one(
          `INSERT INTO ab_reglas_normalizacion
             (patron, tipo_match, categoria, proveedor_normalizado, prioridad, forzar_visible)
           VALUES ($1, 'ilike', $2, $1, 120, TRUE)
           RETURNING id`,
          [proveedor, categoria_destino]
        );
      }
      banco_regla_id = regla.id;
      // 2) UPDATE histórico de ab_movimientos.
      const upd = await query(
        `UPDATE ab_movimientos
            SET categoria = $1, proveedor_normalizado = $2
          WHERE (proveedor_normalizado = $2 OR position(LOWER($2) IN LOWER(concepto)) > 0)
            AND importe < 0
          RETURNING sociedad_id, periodo`,
        [categoria_destino, proveedor]
      );
      banco_affected = upd.rowCount || 0;
      const combos = new Set((upd.rows || []).map((r) => `${r.sociedad_id}|${r.periodo}`));
      // 3) Recalc resumen y cruces para los combos tocados.
      for (const c of combos) {
        const [soc, per] = c.split('|');
        try { await bankDb.recalcResumenMensual(soc, per); } catch (e) { /* tolerante */ }
        try { await bankDb.recalcCrucesParaSociedadPeriodo(soc, per); } catch (e) { /* tolerante */ }
      }
    }

    let caja_reglas_upsert = 0;
    const autor = req.session?.user?.email || 'desconocido';
    for (const sub of subtiposMatch) {
      // upsert por subtipo: tipo_match='exact', prioridad 1500.
      // Sobreescribe siempre por categoria_destino (pasamos así el "mover").
      await one(
        `INSERT INTO ab_caja_mapeo_subtipos
           (patron, tipo_match, prioridad, categoria_destino, autor, notas, activa)
         VALUES ($1, 'exact', 1500, $2, $3, $4, TRUE)
         ON CONFLICT (patron, tipo_match) DO UPDATE SET
           categoria_destino = EXCLUDED.categoria_destino,
           prioridad = GREATEST(EXCLUDED.prioridad, ab_caja_mapeo_subtipos.prioridad),
           notas = EXCLUDED.notas,
           autor = EXCLUDED.autor,
           activa = TRUE,
           updated_at = NOW()
         RETURNING id`,
        [sub.subtipo, categoria_destino, autor,
         `Mover proveedor "${proveedor}" → ${categoria_destino} (desde donut)`]
      );
      caja_reglas_upsert++;
    }
    if (caja_reglas_upsert > 0) invalidateMapeosCache();

    res.json({
      ok: true,
      modo: 'confirmar',
      proveedor, categoria_origen, categoria_destino,
      banco: { regla_id: banco_regla_id, movs_afectados: banco_affected },
      efectivo: {
        reglas_upsert: caja_reglas_upsert,
        movs_afectados: movsCajaTotal,
        subtipos: subtiposMatch.map((r) => r.subtipo),
      },
    });
  } catch (e) {
    console.error('[caja.mover-proveedor]', e);
    res.status(500).json({ error: e.message || 'internal' });
  }
});

module.exports = router;
