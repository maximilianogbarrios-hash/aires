// /api/v1/bancos/* — módulo bancario.

const express = require('express');
const multer = require('multer');
const { requireAuth } = require('../lib/auth');
const { query, one, many } = require('../lib/db');
const { SOCIEDADES, DIRECCIONES, findSociedad, sociedadDeLocal } = require('../lib/bank/sociedades');
const { parseSantanderBuffer } = require('../lib/bank/parser-santander');
const { parseGetnetBuffer } = require('../lib/bank/parser-getnet');
const { esIntraGrupo, normalizarProveedor } = require('../lib/bank/normalizers');
const { CATEGORIAS_PROVEEDOR_OPERATIVO } = require('../lib/bank/categorizer');
const { loadReglas, matchRegla } = require('../lib/bank/db-rules');
const bankDb = require('../lib/bank/db');

// Selector ampliado de sociedad (Mejora B): traduce valores virtuales
// 'sin_elche' (excluye hostelero=Grupo Hostelero Aires SL) y 'solo_elche'
// (solo hostelero) a cláusulas SQL. Devuelve null si no hay filtro o el
// valor es vacío. Para sociedades individuales devuelve la cláusula
// estándar de igualdad.
function buildSociedadClause(sociedad_id, paramIndex) {
  if (!sociedad_id) return null;
  if (sociedad_id === 'sin_elche') {
    return { sql: `sociedad_id <> $${paramIndex}`, vals: ['hostelero'] };
  }
  if (sociedad_id === 'solo_elche') {
    return { sql: `sociedad_id = $${paramIndex}`, vals: ['hostelero'] };
  }
  return { sql: `sociedad_id = $${paramIndex}`, vals: [sociedad_id] };
}

// Vista efectiva según rol del usuario. Admin/socio ven todo; el resto sólo
// proveedores operativos (PROVEEDOR_* + MANTENIMIENTO).
function vistaEfectivaParaRol(rol, vistaQuery) {
  const rolesAdmin = new Set(['admin', 'socio']);
  if (rolesAdmin.has(rol)) {
    return vistaQuery === 'operativo' ? 'operativo' : 'admin';
  }
  return 'operativo';
}

// Fusión de grupos sensibles para roles no-admin. Los movimientos
// con estas categorías se colapsan en un único slice "Gastos Dirección"
// con total sumado — gerente / administrativo / pedidos / personal no
// ven el detalle de nóminas dirección, gastos dirección, préstamos
// bancarios ni financiero.
const ROLES_ADMIN = new Set(['admin', 'socio']);
const CATEGORIAS_DIRECCION_FUSE = new Set([
  'NOMINAS_DIRECCION', 'GASTOS_DIRECCION', 'PRESTAMOS', 'FINANCIERO',
]);
const FUSE_PROVEEDOR = 'Gastos Dirección';

function esAdminLike(req) {
  return ROLES_ADMIN.has(req.session?.user?.role);
}

const router = express.Router();
router.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
});

// ─── METADATA: sociedades + direcciones ────────────────────────────────
router.get('/meta', (req, res) => {
  res.json({ sociedades: SOCIEDADES, direcciones: DIRECCIONES });
});

// ─── UPLOAD EXTRACTO SANTANDER ─────────────────────────────────────────
router.post('/upload-extracto', upload.single('file'), async (req, res) => {
  try {
    const sociedad_id = req.body.sociedad_id;
    const banco = (req.body.banco || 'santander').toLowerCase();
    if (!sociedad_id) return res.status(400).json({ error: 'sociedad_id requerido' });
    if (!findSociedad(sociedad_id)) return res.status(400).json({ error: 'sociedad_id inválido' });
    if (!req.file) return res.status(400).json({ error: 'archivo requerido (campo "file")' });
    if (banco !== 'santander') {
      return res.status(400).json({ error: 'por ahora sólo Santander; Sabadell viene en próxima versión' });
    }

    const parsed = parseSantanderBuffer(req.file.buffer, { sociedad_id, banco });
    if (!parsed.header_found) {
      return res.status(400).json({ error: 'no se encontró la fila de headers (Concepto/Importe)' });
    }

    // Las reglas persistidas en ab_reglas_normalizacion (orden prioridad DESC)
    // sobreescriben la categoría/proveedor que devolvió el categorizer/normalizer
    // hardcodeado. Protección sobre INTRAGRUPO: una regla que apunte a una
    // categoría DISTINTA de INTRAGRUPO NO puede pisar un mov ya marcado como
    // INTRAGRUPO (evita que una regla genérica de 'prestamo' o 'transferencia'
    // misclasifique un Aires→Aires). Las reglas que apuntan a INTRAGRUPO sí
    // se aplican — confirman la categoría y agregan proveedor_normalizado
    // (caso típico: 'raba' → Raba Buildings).
    const reglasDb = await loadReglas();
    let reglasAplicadas = 0;
    for (const m of parsed.movimientos) {
      const r = matchRegla(m.concepto, reglasDb);
      if (!r) continue;
      if (m.categoria === 'INTRAGRUPO' && r.categoria !== 'INTRAGRUPO') continue;
      m.categoria = r.categoria;
      m.proveedor_normalizado = r.proveedor_normalizado;
      reglasAplicadas++;
    }

    const { inserted, duplicated } = await bankDb.insertMovimientos(parsed.movimientos);
    const periodos = Array.from(new Set(parsed.movimientos.map((m) => m.periodo)));
    for (const p of periodos) {
      await bankDb.recalcResumenMensual(sociedad_id, p);
      await bankDb.recalcCrucesParaSociedadPeriodo(sociedad_id, p);
    }

    res.json({
      ok: true,
      sociedad_id, banco,
      total_filas: parsed.movimientos.length,
      insertadas: inserted,
      duplicadas: duplicated,
      skipped: parsed.skipped,
      reglas_db_aplicadas: reglasAplicadas,
      periodos,
      preview: parsed.movimientos.slice(0, 10).map((m) => ({
        fecha: m.fecha, concepto: m.concepto, importe: m.importe,
        categoria: m.categoria, codigo_banco: m.codigo_banco, local_id: m.local_id,
        proveedor_normalizado: m.proveedor_normalizado || null,
      })),
    });
  } catch (e) {
    console.error('[bancos.upload-extracto]', e);
    res.status(500).json({ error: e.message || 'internal' });
  }
});

// ─── UPLOAD CIERRES TPV (Getnet) ───────────────────────────────────────
router.post('/upload-cierres-tpv', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'archivo requerido (campo "file")' });
    const local_id_override = req.body.local_id || null;

    const parsed = parseGetnetBuffer(req.file.buffer, { local_id_override });
    if (!parsed.header_found) {
      return res.status(400).json({ error: 'no se encontró la fila de headers (Fecha/Bruto/Neto)' });
    }
    if (!parsed.local_id) {
      return res.status(400).json({
        error: 'no se pudo detectar el local; pasá local_id explícito',
        comercio_detectado: parsed.comercio_detectado,
      });
    }
    if (!parsed.sociedad_id) {
      return res.status(400).json({ error: `local ${parsed.local_id} no pertenece a ninguna sociedad conocida` });
    }

    const { inserted, duplicated } = await bankDb.insertCierres(parsed.cierres);
    const periodos = Array.from(new Set(parsed.cierres.map((c) => c.periodo)));
    for (const p of periodos) {
      await bankDb.recalcCrucesParaSociedadPeriodo(parsed.sociedad_id, p);
    }

    // Cruce inmediato para devolver feedback
    const cruces = await many(
      `SELECT periodo, total_bruto_tpv::float8 AS bruto, total_neto_tpv::float8 AS neto,
              total_banco::float8 AS banco, diferencia::float8 AS diferencia,
              tasa_efectiva::float8 AS tasa, estado
       FROM ab_cruces WHERE sociedad_id=$1 AND local_id=$2 AND periodo = ANY($3::text[])
       ORDER BY periodo`,
      [parsed.sociedad_id, parsed.local_id, periodos]
    );

    res.json({
      ok: true,
      local_id: parsed.local_id,
      sociedad_id: parsed.sociedad_id,
      comercio_detectado: parsed.comercio_detectado,
      total_cierres: parsed.cierres.length,
      insertados: inserted,
      duplicados: duplicated,
      skipped: parsed.skipped,
      periodos, cruces,
    });
  } catch (e) {
    console.error('[bancos.upload-cierres]', e);
    res.status(500).json({ error: e.message || 'internal' });
  }
});

// ─── QUERIES ───────────────────────────────────────────────────────────

// Listado paginado de movimientos con filtros.
router.get('/movimientos', async (req, res) => {
  try {
    const sociedad_id = req.query.sociedad_id || null;
    const periodo = req.query.periodo || null;
    const categoria = req.query.categoria || null;
    const banco = req.query.banco || null;
    const local_id = req.query.local_id || null;
    const search = req.query.q || null;
    const limit = Math.min(+req.query.limit || 50, 500);
    const offset = +req.query.offset || 0;

    const where = []; const vals = [];
    if (sociedad_id) { where.push(`sociedad_id=$${vals.length+1}`); vals.push(sociedad_id); }
    if (periodo)     { where.push(`periodo=$${vals.length+1}`);     vals.push(periodo); }
    if (categoria)   { where.push(`categoria=$${vals.length+1}`);   vals.push(categoria); }
    if (banco)       { where.push(`banco=$${vals.length+1}`);       vals.push(banco); }
    if (local_id)    { where.push(`local_id=$${vals.length+1}`);    vals.push(local_id); }
    if (search)      { where.push(`concepto ILIKE $${vals.length+1}`); vals.push(`%${search}%`); }
    const W = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const totalRow = await one(
      `SELECT COUNT(*)::int AS c, COALESCE(SUM(importe), 0)::float8 AS total_importe
         FROM ab_movimientos ${W}`,
      vals
    );
    const rows = await many(
      `SELECT id, sociedad_id, banco, fecha, concepto, importe::float8 AS importe,
              categoria, subcategoria, local_id, codigo_banco, num_documento, periodo
       FROM ab_movimientos ${W}
       ORDER BY fecha DESC, id DESC
       LIMIT $${vals.length+1} OFFSET $${vals.length+2}`,
      [...vals, limit, offset]
    );
    res.json({ total: totalRow.c, total_importe: totalRow.total_importe, limit, offset, rows });
  } catch (e) {
    console.error('[bancos.movimientos]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// Resumen mensual por sociedad (todos los períodos disponibles).
router.get('/resumen', async (req, res) => {
  try {
    const sociedad_id = req.query.sociedad_id || null;
    let sql = `SELECT sociedad_id, periodo,
                      total_ingresos::float8 AS total_ingresos,
                      total_gastos::float8 AS total_gastos,
                      neto::float8 AS neto,
                      detalle_categorias,
                      n_movimientos, updated_at
               FROM ab_resumen_mensual`;
    const vals = [];
    if (sociedad_id) { sql += ' WHERE sociedad_id=$1'; vals.push(sociedad_id); }
    sql += ' ORDER BY sociedad_id, periodo';
    const rows = await many(sql, vals);
    res.json({ resumen: rows });
  } catch (e) {
    console.error('[bancos.resumen]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// Análisis de gastos por categoría/subcategoría.
router.get('/gastos-por-proveedor', async (req, res) => {
  try {
    const sociedad_id = req.query.sociedad_id || null;
    const periodo = req.query.periodo || null;
    const where = ['importe < 0']; const vals = [];
    if (sociedad_id) { where.push(`sociedad_id=$${vals.length+1}`); vals.push(sociedad_id); }
    if (periodo)     { where.push(`periodo=$${vals.length+1}`);     vals.push(periodo); }
    const W = 'WHERE ' + where.join(' AND ');
    const rows = await many(
      `SELECT COALESCE(subcategoria, concepto) AS proveedor,
              categoria,
              SUM(importe)::float8 AS total,
              COUNT(*)::int AS apariciones,
              MIN(fecha) AS desde, MAX(fecha) AS hasta
       FROM ab_movimientos ${W}
       GROUP BY proveedor, categoria
       ORDER BY total ASC
       LIMIT 50`,
      vals
    );
    res.json({ proveedores: rows });
  } catch (e) {
    console.error('[bancos.gastos]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// Cruces TPV vs banco.
router.get('/cruces', async (req, res) => {
  try {
    const sociedad_id = req.query.sociedad_id || null;
    const periodo = req.query.periodo || null;
    const where = []; const vals = [];
    if (sociedad_id) { where.push(`sociedad_id=$${vals.length+1}`); vals.push(sociedad_id); }
    if (periodo)     { where.push(`periodo=$${vals.length+1}`);     vals.push(periodo); }
    const W = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const rows = await many(
      `SELECT sociedad_id, local_id, periodo,
              total_bruto_tpv::float8   AS bruto,
              total_neto_tpv::float8    AS neto,
              total_comision_tpv::float8 AS comision,
              total_banco::float8       AS banco,
              diferencia::float8        AS diferencia,
              tasa_efectiva::float8     AS tasa,
              estado, updated_at
       FROM ab_cruces ${W}
       ORDER BY periodo DESC, sociedad_id, local_id NULLS LAST`,
      vals
    );
    res.json({ cruces: rows });
  } catch (e) {
    console.error('[bancos.cruces]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// Ranking de proveedores normalizado: agrupa por concepto canónico
// excluyendo transferencias intra-grupo. Soporta sociedad (todas o
// individual) y periodo (mes único o rango periodo_desde..periodo_hasta).
router.get('/proveedores', async (req, res) => {
  try {
    const sociedad_id = req.query.sociedad_id || null;
    const periodo = req.query.periodo || null;
    const periodo_desde = req.query.periodo_desde || null;
    const periodo_hasta = req.query.periodo_hasta || null;

    const vista = vistaEfectivaParaRol(req.session?.user?.role, req.query.vista);

    const where = ['importe < 0'];
    const vals = [];
    const socCl = buildSociedadClause(sociedad_id, vals.length + 1);
    if (socCl) { where.push(socCl.sql); vals.push(...socCl.vals); }
    if (periodo)          { where.push(`periodo=$${vals.length+1}`);  vals.push(periodo); }
    if (periodo_desde)    { where.push(`periodo>=$${vals.length+1}`); vals.push(periodo_desde); }
    if (periodo_hasta)    { where.push(`periodo<=$${vals.length+1}`); vals.push(periodo_hasta); }
    // Vista operativa: sólo categorías de proveedor real (PROVEEDOR_* +
    // MANTENIMIENTO). Para roles no-admin INCLUIMOS también las
    // categorías sensibles (NOMINAS_DIRECCION/GASTOS_DIRECCION/
    // PRESTAMOS/FINANCIERO) en el filtro, porque después las
    // fusionamos en un único slice "Gastos Dirección" (no se
    // exponen individualmente, pero el total sí debe aparecer).
    if (vista === 'operativo') {
      const catsPermitidas = esAdminLike(req)
        ? CATEGORIAS_PROVEEDOR_OPERATIVO
        : [...CATEGORIAS_PROVEEDOR_OPERATIVO, ...CATEGORIAS_DIRECCION_FUSE];
      where.push(`categoria = ANY($${vals.length+1}::text[])`);
      vals.push(catsPermitidas);
    }

    const rows = await many(
      `SELECT concepto, categoria, importe::float8 AS importe, fecha::text AS fecha, proveedor_normalizado
         FROM ab_movimientos
        WHERE ${where.join(' AND ')}`,
      vals
    );

    // Reglas DB (orden prioridad DESC) sobreescriben categoría/proveedor del
    // categorizer y normalizer en runtime, para que filas viejas reflejen
    // las reglas que el usuario crea desde la UI sin re-procesar la tabla.
    const reglasDb = await loadReglas();

    // Agrupar por proveedor normalizado, excluyendo intra-grupo.
    // Precedencia: ab_movimientos.proveedor_normalizado > regla DB > normalizarProveedor().
    const agg = new Map(); // proveedor → { total, n, categorias: Map<cat, count>, ultima_fecha }
    let totalExcluido = 0;
    let nExcluido = 0;
    for (const r of rows) {
      if (esIntraGrupo(r.concepto)) {
        totalExcluido += Math.abs(+r.importe);
        nExcluido++;
        continue;
      }
      let proveedor, categoria;
      if (r.proveedor_normalizado) {
        proveedor = r.proveedor_normalizado;
        categoria = r.categoria;
      } else {
        const rule = matchRegla(r.concepto, reglasDb);
        if (rule) {
          proveedor = rule.proveedor_normalizado;
          categoria = rule.categoria;
        } else {
          const n = normalizarProveedor(r.concepto, r.categoria);
          proveedor = n.proveedor;
          categoria = n.categoria;
        }
      }
      const k = proveedor;
      if (!agg.has(k)) agg.set(k, { total: 0, n: 0, cats: new Map(), ultima_fecha: null });
      const a = agg.get(k);
      a.total += Math.abs(+r.importe);
      a.n += 1;
      a.cats.set(categoria, (a.cats.get(categoria) || 0) + 1);
      if (!a.ultima_fecha || r.fecha > a.ultima_fecha) a.ultima_fecha = r.fecha;
    }

    // En vista operativa, anexamos métricas de pedidos cargados por el usuario
    // (ab_pedidos_semana): nº pedidos y fecha del último pedido por proveedor.
    let pedidosInfo = new Map();
    if (vista === 'operativo') {
      const pedRows = await many(
        `SELECT proveedor, COUNT(*)::int AS n, MAX(confirmado_en)::text AS ultimo
           FROM ab_pedidos_semana
          WHERE estado IN ('enviado','recibido')
          GROUP BY proveedor`
      );
      pedidosInfo = new Map(pedRows.map((r) => [r.proveedor, r]));
    }

    // Categoría más frecuente por proveedor.
    const totalGasto = [...agg.values()].reduce((s, v) => s + v.total, 0);
    let proveedores = [...agg.entries()].map(([proveedor, a]) => {
      let topCat = null, topCnt = 0;
      for (const [c, n] of a.cats.entries()) if (n > topCnt) { topCnt = n; topCat = c; }
      const ped = pedidosInfo.get(proveedor);
      return {
        proveedor,
        total_importe: a.total,
        porcentaje: totalGasto > 0 ? a.total / totalGasto : 0,
        num_transacciones: a.n,
        categoria: topCat,
        ultima_fecha: a.ultima_fecha,
        num_pedidos: ped?.n || 0,
        ultimo_pedido: ped?.ultimo || null,
      };
    }).sort((a, b) => b.total_importe - a.total_importe);

    // Fusión de grupos sensibles para roles no-admin (Ronda 9): los
    // proveedores con categoría NOMINAS_DIRECCION / GASTOS_DIRECCION /
    // PRESTAMOS / FINANCIERO se colapsan en un único slice "Gastos
    // Dirección". Se aplica ANTES del rollup de "Proveedores Menores"
    // para que el fusionado quede como un slice principal y no caiga
    // en el bucket de menores por casualidad.
    let fusionados = 0;
    if (!esAdminLike(req)) {
      const sensibles = proveedores.filter((p) => CATEGORIAS_DIRECCION_FUSE.has(p.categoria));
      const restantes = proveedores.filter((p) => !CATEGORIAS_DIRECCION_FUSE.has(p.categoria));
      if (sensibles.length) {
        const tot = sensibles.reduce((s, p) => s + p.total_importe, 0);
        const tx = sensibles.reduce((s, p) => s + p.num_transacciones, 0);
        const ultimaFecha = sensibles.reduce((d, p) => (p.ultima_fecha > (d || '')) ? p.ultima_fecha : d, null);
        restantes.push({
          proveedor: FUSE_PROVEEDOR,
          total_importe: tot,
          porcentaje: totalGasto > 0 ? tot / totalGasto : 0,
          num_transacciones: tx,
          categoria: 'GASTOS_DIRECCION',
          ultima_fecha: ultimaFecha,
          num_pedidos: 0, ultimo_pedido: null,
          _es_fusion_direccion: true,
          _miembros: sensibles.length,
        });
        fusionados = sensibles.length;
      }
      proveedores = restantes.sort((a, b) => b.total_importe - a.total_importe);
    }

    // Ronda 4: rollup de proveedores menores en "Proveedores Menores".
    // Dos pasadas:
    //  1) Threshold del usuario: count<5 AND total<2000€ (lo indiscutible).
    //  2) Cap final: si tras la pasada 1 siguen quedando >maxGrupos visibles,
    //     se mantienen los TOP-(maxGrupos-1) por total y el resto va al bucket.
    // El cap garantiza ≤maxGrupos (default 30). Ambos thresholds son query-configurables.
    const minTx = req.query.menores_min_tx ? +req.query.menores_min_tx : 5;
    const minEur = req.query.menores_min_eur ? +req.query.menores_min_eur : 2000;
    // Ronda 6: cap subido de 30 a 50 para acomodar las nuevas categorías
    // (PROVEEDOR_LACTEOS x4, GASTOS_DIRECCION, GASTOS_VEHICULOS, etc.).
    const maxGrupos = req.query.max_grupos ? +req.query.max_grupos : 50;

    function colapsarEnMenores(lista, predicate) {
      const grandes = lista.filter((p) => !predicate(p));
      const menores = lista.filter(predicate);
      if (menores.length <= 1) return { lista, rollup: null };
      const totalMenores = menores.reduce((s, p) => s + p.total_importe, 0);
      const txMenores = menores.reduce((s, p) => s + p.num_transacciones, 0);
      const existente = grandes.find((p) => p.proveedor === 'Proveedores Menores');
      if (existente) {
        existente.total_importe += totalMenores;
        existente.num_transacciones += txMenores;
        existente._miembros = (existente._miembros || 0) + menores.length;
        return { lista: grandes.sort((a, b) => b.total_importe - a.total_importe), rollup: { absorbidos: menores.length, total: totalMenores } };
      }
      grandes.push({
        proveedor: 'Proveedores Menores',
        total_importe: totalMenores,
        porcentaje: totalGasto > 0 ? totalMenores / totalGasto : 0,
        num_transacciones: txMenores,
        categoria: 'PROVEEDOR_OTROS',
        ultima_fecha: menores.reduce((d, p) => (p.ultima_fecha > (d || '')) ? p.ultima_fecha : d, null),
        num_pedidos: 0, ultimo_pedido: null,
        _es_rollup: true, _miembros: menores.length,
      });
      return {
        lista: grandes.sort((a, b) => b.total_importe - a.total_importe),
        rollup: { absorbidos: menores.length, total: totalMenores },
      };
    }

    // Pasada 1: threshold AND (spec del user)
    let proveedoresFinal = proveedores;
    let rollup1 = null;
    {
      const r = colapsarEnMenores(proveedoresFinal, (p) =>
        p.num_transacciones < minTx && p.total_importe < minEur
      );
      proveedoresFinal = r.lista;
      rollup1 = r.rollup;
    }

    // Pasada 2: cap top-N (garantiza ≤maxGrupos)
    let rollup2 = null;
    if (proveedoresFinal.length > maxGrupos) {
      const sortDesc = [...proveedoresFinal].sort((a, b) => b.total_importe - a.total_importe);
      const cutOff = sortDesc[maxGrupos - 2]?.total_importe ?? 0; // (-2 porque uno es Menores)
      const r = colapsarEnMenores(proveedoresFinal, (p) =>
        p.proveedor !== 'Proveedores Menores' && p.total_importe < cutOff
      );
      proveedoresFinal = r.lista;
      rollup2 = r.rollup;
    }

    const rollup_menores = (rollup1 || rollup2) ? {
      pasada_threshold: rollup1,
      pasada_cap_top: rollup2,
      thresholds: { min_tx: minTx, min_eur: minEur, max_grupos: maxGrupos },
    } : null;

    res.json({
      filtros: { sociedad_id, periodo, periodo_desde, periodo_hasta, vista },
      vista_efectiva: vista,
      total_gasto: totalGasto,
      total_excluido_intra_grupo: totalExcluido,
      n_excluido_intra_grupo: nExcluido,
      n_grupos_finales: proveedoresFinal.length,
      rollup_menores,
      // Si el rol no es admin/socio, indica cuántos proveedores
      // se fusionaron en el slice "Gastos Dirección". Permite al
      // frontend desactivar drill-down sobre ese slice.
      fusion_direccion: fusionados > 0 ? { proveedor: FUSE_PROVEEDOR, miembros: fusionados } : null,
      proveedores: proveedoresFinal,
    });
  } catch (e) {
    console.error('[bancos.proveedores]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ─── EVOLUCIÓN TEMPORAL POR PROVEEDOR / CATEGORÍA ─────────────────────
// GET /bancos/proveedor-evolucion?proveedores=A,B&categorias=X,Y&desde=YYYY-MM&hasta=YYYY-MM&sociedad_id=
// Devuelve serie mensual por cada proveedor + serie por cada categoría.
// Si yoy=1, también devuelve la serie del mismo rango del año anterior.
router.get('/proveedor-evolucion', async (req, res) => {
  try {
    const sociedad_id = req.query.sociedad_id || null;
    const desde = req.query.desde || null;
    const hasta = req.query.hasta || null;
    const proveedores = (req.query.proveedores || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    const categorias = (req.query.categorias || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    const yoy = req.query.yoy === '1';

    if (!desde || !hasta) return res.status(400).json({ error: 'desde y hasta requeridos (YYYY-MM)' });
    if (!proveedores.length && !categorias.length) return res.json({ meses: [], series: [], series_yoy: [] });

    function shiftYear(periodo, delta) {
      const [y, m] = periodo.split('-').map(Number);
      return `${y + delta}-${String(m).padStart(2, '0')}`;
    }
    function buildMeses(d, h) {
      const out = [];
      let [y, m] = d.split('-').map(Number);
      const [y2, m2] = h.split('-').map(Number);
      while (y < y2 || (y === y2 && m <= m2)) {
        out.push(`${y}-${String(m).padStart(2, '0')}`);
        m++; if (m > 12) { m = 1; y++; }
      }
      return out;
    }
    const mesesRango = buildMeses(desde, hasta);
    const mesesYoy = yoy ? mesesRango.map((p) => shiftYear(p, -1)) : [];

    // Para roles no-admin: las series sobre categorías sensibles
    // (NOMINAS_DIRECCION/GASTOS_DIRECCION/PRESTAMOS/FINANCIERO) se
    // fusionan en una serie única "Gastos Dirección". Si el cliente
    // pide individualmente una de las 4, la silenciamos. Si pide
    // "Gastos Dirección" como proveedor, le devolvemos la suma de las 4.
    const noAdmin = !esAdminLike(req);
    const pideFusion = noAdmin && proveedores.includes(FUSE_PROVEEDOR);
    // Filtramos las categorías sensibles que pudieran venir como
    // categorias[] explícitas (para no exponerlas como series propias).
    const categoriasFiltradas = noAdmin
      ? categorias.filter((c) => !CATEGORIAS_DIRECCION_FUSE.has(c))
      : categorias;
    // También quitamos los proveedores individuales si su nombre coincide
    // con uno de los que cae en categorías sensibles. Lo resolvemos
    // en runtime (al iterar rows, descartamos los matches).

    async function fetchSeries(mesesArr) {
      if (!mesesArr.length) return { byProv: new Map(), byCat: new Map() };
      const params = [mesesArr];
      let where = 'importe < 0 AND periodo = ANY($1::text[])';
      const socCl = buildSociedadClause(sociedad_id, params.length + 1);
      if (socCl) { where += ` AND ${socCl.sql}`; params.push(...socCl.vals); }
      const rows = await many(
        `SELECT concepto, categoria, periodo, importe::float8 AS importe, proveedor_normalizado
           FROM ab_movimientos
          WHERE ${where}`,
        params
      );

      const byProv = new Map(); // proveedor -> Map<periodo, total>
      const byCat = new Map();  // categoria  -> Map<periodo, total>
      for (const r of rows) {
        if (esIntraGrupo(r.concepto)) continue;
        const { proveedor, categoria } = normalizarProveedor(r.concepto, r.categoria);
        const cat = categoria || r.categoria;
        const abs = Math.abs(+r.importe);
        const esSensible = noAdmin && CATEGORIAS_DIRECCION_FUSE.has(r.categoria);

        if (esSensible) {
          // Suma silenciosa bajo "Gastos Dirección" si fue solicitada.
          if (pideFusion) {
            if (!byProv.has(FUSE_PROVEEDOR)) byProv.set(FUSE_PROVEEDOR, new Map());
            const m = byProv.get(FUSE_PROVEEDOR);
            m.set(r.periodo, (m.get(r.periodo) || 0) + abs);
          }
          // Nunca exponer la categoria/proveedor individual.
          continue;
        }
        // Por proveedor
        if (proveedores.includes(proveedor)) {
          if (!byProv.has(proveedor)) byProv.set(proveedor, new Map());
          byProv.get(proveedor).set(r.periodo, (byProv.get(proveedor).get(r.periodo) || 0) + abs);
        }
        // Por categoría
        if (categoriasFiltradas.includes(cat)) {
          if (!byCat.has(cat)) byCat.set(cat, new Map());
          byCat.get(cat).set(r.periodo, (byCat.get(cat).get(r.periodo) || 0) + abs);
        }
      }
      return { byProv, byCat };
    }

    const main = await fetchSeries(mesesRango);
    const yoyData = yoy ? await fetchSeries(mesesYoy) : { byProv: new Map(), byCat: new Map() };

    function expand(byKey, meses, mesesBase) {
      const out = [];
      for (const [k, m] of byKey.entries()) {
        const data = mesesBase.map((p, i) => m.get(meses[i]) || 0);
        out.push({ key: k, data });
      }
      return out;
    }

    res.json({
      meses: mesesRango,
      proveedores: expand(main.byProv, mesesRango, mesesRango),
      categorias:  expand(main.byCat, mesesRango, mesesRango),
      yoy: yoy ? {
        meses: mesesYoy,
        proveedores: expand(yoyData.byProv, mesesYoy, mesesRango),
        categorias:  expand(yoyData.byCat,  mesesYoy, mesesRango),
      } : null,
    });
  } catch (e) {
    console.error('[bancos.evolucion]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// Lista de proveedores disponibles para autocompletado.
// Cachea por hora — cambia poco entre uploads.
const provCache = { ts: 0, rows: null };
router.get('/proveedores-lista', async (req, res) => {
  try {
    const now = Date.now();
    if (provCache.rows && (now - provCache.ts) < 60 * 60 * 1000) {
      return res.json({ proveedores: provCache.rows });
    }
    const rows = await many(
      `SELECT concepto, categoria FROM ab_movimientos WHERE importe<0`
    );
    const set = new Map();
    for (const r of rows) {
      if (esIntraGrupo(r.concepto)) continue;
      const { proveedor, categoria } = normalizarProveedor(r.concepto, r.categoria);
      if (!set.has(proveedor)) set.set(proveedor, { proveedor, categoria });
    }
    const out = [...set.values()].sort((a, b) => a.proveedor.localeCompare(b.proveedor));
    provCache.rows = out;
    provCache.ts = now;
    res.json({ proveedores: out });
  } catch (e) {
    console.error('[bancos.proveedores-lista]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// Lista de períodos con datos (para selectores).
router.get('/periodos', async (req, res) => {
  try {
    const rows = await many(
      `SELECT DISTINCT periodo FROM ab_movimientos
       UNION
       SELECT DISTINCT periodo FROM ab_cierres_tpv
       ORDER BY periodo`
    );
    res.json({ periodos: rows.map((r) => r.periodo) });
  } catch (e) {
    console.error('[bancos.periodos]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// Autocompletado para el campo "Nombre normalizado" del sidebar de
// reclasificación. Devuelve los proveedor_normalizado únicos ya
// presentes en ab_movimientos, opcionalmente filtrados por categoría
// y/o texto. Ordenado por total DESC (los grupos más grandes primero,
// que son los candidatos más probables de reasignación) y luego por
// nombre ASC para estabilidad.
router.get('/proveedores-normalizados', async (req, res) => {
  try {
    const categoria = req.query.categoria || null;
    const q = (req.query.q || '').trim();
    const limit = Math.min(+req.query.limit || 200, 500);

    const where = ['importe < 0', 'proveedor_normalizado IS NOT NULL'];
    const vals = [];
    if (categoria) { where.push(`categoria = $${vals.length + 1}`); vals.push(categoria); }
    if (q)         { where.push(`proveedor_normalizado ILIKE $${vals.length + 1}`); vals.push('%' + q + '%'); }

    const rows = await many(
      `SELECT proveedor_normalizado AS nombre,
              COUNT(*)::int             AS n,
              SUM(ABS(importe))::float8 AS total_importe,
              MAX(categoria)            AS categoria_top
         FROM ab_movimientos
        WHERE ${where.join(' AND ')}
        GROUP BY proveedor_normalizado
        ORDER BY total_importe DESC, nombre ASC
        LIMIT $${vals.length + 1}`,
      [...vals, limit]
    );
    res.json({ proveedores: rows });
  } catch (e) {
    console.error('[bancos.proveedores-normalizados]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// Detalle de los conceptos que componen un grupo (proveedor canónico).
// Devuelve la lista con totales por concepto, ordenada por importe desc.
// Usa la MISMA lógica de derivación de grupo que /proveedores
// (proveedor_normalizado > regla DB > normalizarProveedor()).
router.get('/grupo-detalle', async (req, res) => {
  try {
    const grupo = String(req.query.grupo || '').trim();
    if (!grupo) return res.status(400).json({ error: 'grupo requerido' });
    const sociedad_id = req.query.sociedad_id || null;
    const periodo = req.query.periodo || null;
    const periodo_desde = req.query.periodo_desde || null;
    const periodo_hasta = req.query.periodo_hasta || null;

    // Bloqueo de drill-down sobre grupos sensibles para roles no-admin.
    // El slice "Gastos Dirección" (fusión de NOMINAS_DIRECCION /
    // GASTOS_DIRECCION / PRESTAMOS / FINANCIERO) no se expande, y
    // tampoco se permite acceder por URL a los proveedores individuales
    // que pertenecen a esas categorías sensibles.
    if (!esAdminLike(req)) {
      if (grupo === FUSE_PROVEEDOR) {
        return res.status(403).json({ error: 'Forbidden: grupo restringido por rol' });
      }
      const cat = await one(
        'SELECT MAX(categoria) AS cat FROM ab_movimientos WHERE proveedor_normalizado = $1',
        [grupo]
      );
      if (cat?.cat && CATEGORIAS_DIRECCION_FUSE.has(cat.cat)) {
        return res.status(403).json({ error: 'Forbidden: grupo restringido por rol' });
      }
    }

    const where = ['importe < 0'];
    const vals = [];
    const socCl = buildSociedadClause(sociedad_id, vals.length + 1);
    if (socCl)         { where.push(socCl.sql);                       vals.push(...socCl.vals); }
    if (periodo)       { where.push(`periodo=$${vals.length+1}`);     vals.push(periodo); }
    if (periodo_desde) { where.push(`periodo>=$${vals.length+1}`);    vals.push(periodo_desde); }
    if (periodo_hasta) { where.push(`periodo<=$${vals.length+1}`);    vals.push(periodo_hasta); }

    const rows = await many(
      `SELECT id, concepto, categoria, importe::float8 AS importe, fecha::text AS fecha,
              proveedor_normalizado, periodo, sociedad_id
         FROM ab_movimientos
        WHERE ${where.join(' AND ')}`,
      vals
    );
    const reglasDb = await loadReglas();

    // Pre-derivar proveedor canónico por fila (evita derivar dos veces).
    const enriched = [];
    for (const r of rows) {
      if (esIntraGrupo(r.concepto)) continue;
      let proveedor, categoria;
      if (r.proveedor_normalizado) {
        proveedor = r.proveedor_normalizado;
        categoria = r.categoria;
      } else {
        const rule = matchRegla(r.concepto, reglasDb);
        if (rule) {
          proveedor = rule.proveedor_normalizado;
          categoria = rule.categoria;
        } else {
          const n = normalizarProveedor(r.concepto, r.categoria);
          proveedor = n.proveedor;
          categoria = n.categoria;
        }
      }
      enriched.push({ ...r, _proveedor: proveedor, _categoria: categoria });
    }

    // Caso especial: el slice "Proveedores Menores" del endpoint
    // /proveedores es un bucket virtual (no es un proveedor real). Para
    // hacer drill-down, identificamos los proveedores que caen debajo
    // del umbral (count < 5 AND total < 2 000€) y devolvemos sus
    // conceptos como si fueran un solo grupo unificado.
    const ES_MENORES = (grupo === 'Proveedores Menores');
    let provsMenores = null;
    if (ES_MENORES) {
      const totPorProv = new Map();
      for (const e of enriched) {
        const x = totPorProv.get(e._proveedor) || { total: 0, n: 0 };
        x.total += Math.abs(+e.importe);
        x.n += 1;
        totPorProv.set(e._proveedor, x);
      }
      provsMenores = new Set(
        [...totPorProv.entries()]
          .filter(([, x]) => x.n < 5 && x.total < 2000)
          .map(([p]) => p)
      );
    }

    const porConcepto = new Map();
    for (const r of enriched) {
      if (ES_MENORES) {
        if (!provsMenores.has(r._proveedor)) continue;
      } else {
        if (r._proveedor !== grupo) continue;
      }
      const k = r.concepto;
      if (!porConcepto.has(k)) {
        porConcepto.set(k, {
          concepto: r.concepto, total: 0, n: 0,
          categoria_actual: r._categoria,
          proveedor_canonico: r._proveedor,
          ultima_fecha: null, ids: [], sociedades: new Map(),
        });
      }
      const c = porConcepto.get(k);
      c.total += Math.abs(+r.importe);
      c.n += 1;
      c.ids.push(r.id);
      if (!c.ultima_fecha || r.fecha > c.ultima_fecha) c.ultima_fecha = r.fecha;
      // Trackeamos qué sociedades aparecen en este concepto y con qué peso
      // (en importe absoluto), para que el frontend muestre el badge 🏢XXX
      // ordenado por relevancia cuando un mismo concepto cruza varias sociedades.
      const abs = Math.abs(+r.importe);
      c.sociedades.set(r.sociedad_id, (c.sociedades.get(r.sociedad_id) || 0) + abs);
    }

    const conceptos = [...porConcepto.values()]
      .map((c) => ({
        concepto: c.concepto,
        total_importe: c.total,
        num_transacciones: c.n,
        categoria_actual: c.categoria_actual,
        // Proveedor canónico del concepto. Útil sobre todo cuando el grupo
        // es "Proveedores Menores" (bucket virtual con N proveedores) para
        // que el sidebar muestre a qué proveedor real pertenece cada fila.
        proveedor_canonico: c.proveedor_canonico,
        ultima_fecha: c.ultima_fecha,
        sample_ids: c.ids.slice(0, 5),
        sociedades: [...c.sociedades.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([id, importe]) => ({ id, importe: Math.round(importe * 100) / 100 })),
      }))
      .sort((a, b) => b.total_importe - a.total_importe);

    const totalGrupo = conceptos.reduce((s, c) => s + c.total_importe, 0);
    res.json({
      grupo,
      es_bucket_menores: !!provsMenores,
      proveedores_menores: provsMenores ? [...provsMenores].sort() : null,
      total: totalGrupo,
      num_conceptos: conceptos.length,
      conceptos,
    });
  } catch (e) {
    console.error('[bancos.grupo-detalle]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// Reclasificar un concepto: UPDATE en ab_movimientos para todas las filas
// con ese concepto exacto y, opcionalmente, guardar una regla persistente.
router.post('/reclasificar', express.json(), async (req, res) => {
  try {
    const { concepto, categoria_nueva, proveedor_nuevo, guardar_regla, tipo_match, patron } = req.body || {};
    if (!concepto || !categoria_nueva || !proveedor_nuevo) {
      return res.status(400).json({ error: 'concepto, categoria_nueva y proveedor_nuevo requeridos' });
    }
    // 1) UPDATE ab_movimientos por concepto exacto.
    const upd = await query(
      `UPDATE ab_movimientos
          SET categoria = $1,
              proveedor_normalizado = $2
        WHERE concepto = $3
        RETURNING sociedad_id, periodo`,
      [categoria_nueva, proveedor_nuevo, concepto]
    );
    const affected = upd.rowCount || 0;
    const combos = new Set((upd.rows || []).map((r) => `${r.sociedad_id}|${r.periodo}`));

    // 2) Si toggle "Aplicar a futuros extractos" → guardar regla.
    let regla_id = null;
    if (guardar_regla) {
      const tipo = ['ilike', 'regex', 'exacto'].includes(tipo_match) ? tipo_match : 'ilike';
      // Por default usamos el concepto completo como patrón ilike — captura
      // el caso típico (mismo extracto futuro). Si el usuario pasa `patron`
      // explícito (ej. substring corto), respetamos.
      const pat = patron || concepto;
      const ins = await one(
        `INSERT INTO ab_reglas_normalizacion (patron, tipo_match, categoria, proveedor_normalizado, prioridad)
         VALUES ($1, $2, $3, $4, 100)
         RETURNING id`,
        [pat, tipo, categoria_nueva, proveedor_nuevo]
      );
      regla_id = ins?.id || null;
    }

    // 3) Recalcular resumen mensual de cada (sociedad, periodo) afectado.
    for (const combo of combos) {
      const [sociedad_id, periodo] = combo.split('|');
      try { await bankDb.recalcResumenMensual(sociedad_id, periodo); } catch (e) { /* tolerante */ }
    }

    res.json({ ok: true, affected, regla_id, combos: combos.size });
  } catch (e) {
    console.error('[bancos.reclasificar]', e);
    res.status(500).json({ error: e.message || 'internal' });
  }
});

// Listado de reglas persistentes (activas e inactivas).
router.get('/reglas-normalizacion', async (req, res) => {
  try {
    const rows = await many(
      `SELECT id, patron, tipo_match, categoria, proveedor_normalizado,
              prioridad, activo, creado_en
         FROM ab_reglas_normalizacion
        ORDER BY prioridad DESC, id ASC`
    );
    res.json({ reglas: rows });
  } catch (e) {
    console.error('[bancos.reglas.list]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// Borrar regla (hard delete — no soft, para no acumular ruido).
router.delete('/reglas-normalizacion/:id', async (req, res) => {
  try {
    const id = +req.params.id;
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
    const r = await query('DELETE FROM ab_reglas_normalizacion WHERE id=$1', [id]);
    res.json({ ok: true, deleted: r.rowCount });
  } catch (e) {
    console.error('[bancos.reglas.delete]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// Recalcular todo (útil tras cambios manuales).
router.post('/recalc', async (req, res) => {
  try {
    const sociedad_id = req.body.sociedad_id;
    const periodo = req.body.periodo;
    if (!sociedad_id || !periodo) return res.status(400).json({ error: 'sociedad_id y periodo requeridos' });
    await bankDb.recalcResumenMensual(sociedad_id, periodo);
    await bankDb.recalcCrucesParaSociedadPeriodo(sociedad_id, periodo);
    res.json({ ok: true });
  } catch (e) {
    console.error('[bancos.recalc]', e);
    res.status(500).json({ error: 'internal' });
  }
});

module.exports = router;
