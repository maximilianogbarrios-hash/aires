// /api/v1/bancos/* — módulo bancario.

const express = require('express');
const multer = require('multer');
const { requireAuth, requirePerm } = require('../lib/auth');
const { query, one, many } = require('../lib/db');
const { SOCIEDADES, DIRECCIONES, findSociedad, sociedadDeLocal } = require('../lib/bank/sociedades');
const { parseSantanderBuffer } = require('../lib/bank/parser-santander');
const { parseGetnetBuffer } = require('../lib/bank/parser-getnet');
const { esIntraGrupo, normalizarProveedor } = require('../lib/bank/normalizers');
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

// Vista unificada: TODOS los roles ven el mismo set de slices (proveedores
// operativos + slice fusionado "Gastos Dirección"), con los mismos totales
// y los mismos %. La única diferencia es el drill-down sobre el slice
// fusionado, que sólo admin/socio pueden expandir (ver /grupo-detalle).
// La función queda como compat para el campo `vista_efectiva` del response.
function vistaEfectivaParaRol(/* rol, vistaQuery */) {
  return 'unificado';
}

// Fusión de grupos sensibles aplicada para TODOS los roles. Los
// movimientos con estas categorías se colapsan en un único slice
// "Gastos Dirección" con total sumado. Antes admin/socio veían cada
// proveedor desglosado y el resto el slice fusionado — eso causaba
// totales distintos y slices distintos entre roles. Ahora la única
// diferencia es quién puede hacer drill-down (admin/socio sí, el resto
// recibe 403 con 🔒 en la UI).
const ROLES_ADMIN = new Set(['admin', 'socio']);
const CATEGORIAS_DIRECCION_FUSE = new Set([
  'NOMINAS_DIRECCION', 'GASTOS_DIRECCION', 'PRESTAMOS', 'FINANCIERO',
]);
const FUSE_PROVEEDOR = 'Gastos Dirección';

// Suelo de fecha para roles no-admin/socio en /bancos → Proveedores
// (y sus drill-downs). Solo ven datos desde enero 2026 en adelante.
// admin/socio sin restricción.
const PERIODO_FLOOR_NO_ADMIN = '2026-01';

function esAdminLike(req) {
  return ROLES_ADMIN.has(req.session?.user?.role);
}

// Helper: cláusula SQL para excluir movimientos sensibles cuando el rol
// no es admin/socio. Cubre Raba Buildings (intra-grupo persistido como
// PROVEEDOR_OTROS), todas las categorías que se fusionan en "Gastos
// Dirección" (NOMINAS_DIRECCION, GASTOS_DIRECCION, PRESTAMOS, FINANCIERO)
// y la categoría INTRAGRUPO completa. Devuelve { sql, vals } o null si
// el rol no requiere filtro.
function clausulaVisibilidadParaRol(req, paramIndex) {
  if (esAdminLike(req)) return null;
  const sql = `categoria NOT IN ('INTRAGRUPO', 'NOMINAS_DIRECCION', 'GASTOS_DIRECCION', 'PRESTAMOS', 'FINANCIERO')
               AND (proveedor_normalizado IS NULL
                    OR proveedor_normalizado NOT IN ('Raba Buildings', 'Raba'))`;
  return { sql, vals: [] };
}

// Aplica el suelo de periodo para roles no-admin/socio. Recibe los
// params crudos y devuelve los valores efectivos a usar en la query.
// Si el rango entero queda fuera del suelo, devuelve { fueraDeRango: true }
// para que el endpoint pueda corto-circuitar con respuesta vacía.
function clampPeriodoParaNoAdmin(req, { periodo, periodo_desde, periodo_hasta }) {
  if (esAdminLike(req)) return { periodo, periodo_desde, periodo_hasta, fueraDeRango: false };
  const F = PERIODO_FLOOR_NO_ADMIN;
  if (periodo && periodo < F) return { periodo, periodo_desde, periodo_hasta, fueraDeRango: true };
  if (periodo_hasta && periodo_hasta < F) return { periodo, periodo_desde, periodo_hasta, fueraDeRango: true };
  const desdeClamped = periodo_desde && periodo_desde < F ? F : periodo_desde;
  return {
    periodo,
    periodo_desde: desdeClamped,
    periodo_hasta,
    fueraDeRango: false,
  };
}

// Carga los overrides admin sobre la membresía del slice "Gastos Dirección".
// Devuelve un Map<proveedor_normalizado, 'include'|'exclude'>.
async function loadGdOverrides() {
  const rows = await many('SELECT proveedor_normalizado, accion FROM ab_gastos_direccion_overrides');
  const m = new Map();
  for (const r of rows) m.set(r.proveedor_normalizado, r.accion);
  return m;
}

// Resuelve si un proveedor canónico pertenece al slice fusionado
// "Gastos Dirección", combinando default por categoría con overrides.
function perteneceAGastosDireccion(proveedor, categoria, overrides) {
  const ov = overrides.get(proveedor);
  if (ov === 'exclude') return false;
  if (ov === 'include') return true;
  return CATEGORIAS_DIRECCION_FUSE.has(categoria);
}

const router = express.Router();
// Defense in depth: requireAuth garantiza sesión; requirePerm('bancos')
// bloquea roles que NO tienen acceso al módulo (PERMS.bancos en
// lib/roles.js — actualmente sólo admin/socio/gerente/administrativo).
// Sin esta línea, pedidos/personal podían hacer GET a cualquier endpoint
// /api/v1/bancos/* aunque el frontend les escondiera la pestaña.
router.use(requireAuth);
router.use(requirePerm('bancos'));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
});

// ─── METADATA: sociedades + direcciones ────────────────────────────────
router.get('/meta', (req, res) => {
  res.json({ sociedades: SOCIEDADES, direcciones: DIRECCIONES });
});

// ─── UPLOAD EXTRACTO SANTANDER ─────────────────────────────────────────
router.post('/upload-extracto', requirePerm('bancos_upload_admin'), upload.single('file'), async (req, res) => {
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
    // misclasifique un Aires→Aires). EXCEPCIÓN: las reglas marcadas como
    // `protegida` (ej. Raba Buildings → GASTOS_DIRECCION) SÍ overrideán
    // INTRAGRUPO — son la fuente de verdad permanente.
    const reglasDb = await loadReglas();
    let reglasAplicadas = 0;
    for (const m of parsed.movimientos) {
      const r = matchRegla(m.concepto, reglasDb);
      if (!r) continue;
      if (m.categoria === 'INTRAGRUPO' && r.categoria !== 'INTRAGRUPO' && !r.protegida) continue;
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
router.post('/upload-cierres-tpv', requirePerm('bancos_upload_admin'), upload.single('file'), async (req, res) => {
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
    // Filtro de visibilidad: no-admin no ve INTRAGRUPO/Raba/categorías de dirección.
    const visCl = clausulaVisibilidadParaRol(req, vals.length + 1);
    if (visCl) { where.push(visCl.sql); vals.push(...visCl.vals); }
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
    // Para no-admin: ocultar categorías sensibles del detalle_categorias.
    // El total_gastos/neto NO se ajustan a propósito (siguen reflejando
    // la realidad financiera; sólo se oculta el desglose por categoría).
    if (!esAdminLike(req)) {
      for (const r of rows) {
        if (r.detalle_categorias && typeof r.detalle_categorias === 'object') {
          const filtrado = {};
          for (const k of Object.keys(r.detalle_categorias)) {
            if (CATEGORIAS_DIRECCION_FUSE.has(k)) continue;
            if (k === 'INTRAGRUPO') continue;
            filtrado[k] = r.detalle_categorias[k];
          }
          r.detalle_categorias = filtrado;
        }
      }
    }
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
    const visCl = clausulaVisibilidadParaRol(req, vals.length + 1);
    if (visCl) { where.push(visCl.sql); vals.push(...visCl.vals); }
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
    const clamped = clampPeriodoParaNoAdmin(req, {
      periodo: req.query.periodo || null,
      periodo_desde: req.query.periodo_desde || null,
      periodo_hasta: req.query.periodo_hasta || null,
    });
    if (clamped.fueraDeRango) {
      return res.json({
        filtros: { sociedad_id, periodo: clamped.periodo, periodo_desde: clamped.periodo_desde, periodo_hasta: clamped.periodo_hasta, vista: 'unificado' },
        vista_efectiva: 'unificado',
        total_gasto: 0, total_excluido_intra_grupo: 0, n_excluido_intra_grupo: 0,
        n_grupos_finales: 0, rollup_menores: null,
        fusion_direccion: null,
        proveedores: [],
        periodo_floor_aplicado: PERIODO_FLOOR_NO_ADMIN,
      });
    }
    const periodo = clamped.periodo;
    const periodo_desde = clamped.periodo_desde;
    const periodo_hasta = clamped.periodo_hasta;

    const vista = vistaEfectivaParaRol(req.session?.user?.role, req.query.vista);

    const where = ['importe < 0'];
    const vals = [];
    const socCl = buildSociedadClause(sociedad_id, vals.length + 1);
    if (socCl) { where.push(socCl.sql); vals.push(...socCl.vals); }
    if (periodo)          { where.push(`periodo=$${vals.length+1}`);  vals.push(periodo); }
    if (periodo_desde)    { where.push(`periodo>=$${vals.length+1}`); vals.push(periodo_desde); }
    if (periodo_hasta)    { where.push(`periodo<=$${vals.length+1}`); vals.push(periodo_hasta); }
    // Vista unificada para TODOS los roles: traemos operativas + sensibles
    // (CATEGORIAS_DIRECCION_FUSE) y filtramos el resto en JS, después de
    // derivar el proveedor canónico (necesario porque los overrides
    // 'include' pueden traer proveedores de categorías arbitrarias).
    // Antes el filtro SQL aplicaba sólo para admin con vista=operativo —
    // ya no, porque la vista admin desglosada se eliminó.
    const gdOverridesPre = await loadGdOverrides();

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
    // Conjunto de proveedor_normalizado con alguna regla activa y
    // forzar_visible=TRUE. Estos slices nunca son absorbidos por
    // "Proveedores Menores" ni por el cap top-N — garantía de
    // visibilidad para reclasificaciones manuales.
    const proveedoresForzados = new Set(
      reglasDb.filter((r) => r.forzar_visible).map((r) => r.proveedor_normalizado)
    );

    // Agrupar por proveedor normalizado, excluyendo intra-grupo.
    // Precedencia: ab_movimientos.proveedor_normalizado > regla DB > normalizarProveedor().
    const agg = new Map(); // proveedor → { total, n, categorias: Map<cat, count>, ultima_fecha }
    let totalExcluido = 0;
    let nExcluido = 0;
    for (const r of rows) {
      // INTRAGRUPO se excluye en dos pasadas:
      //   1) heurística por concepto (Aires→Aires sin categorizar correctamente)
      //   2) categoría persistida === 'INTRAGRUPO' (defense in depth)
      if (esIntraGrupo(r.concepto) || r.categoria === 'INTRAGRUPO') {
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
        // El normalizer puede haber recategorizado a INTRAGRUPO algo
        // que el SQL dejó pasar (caso poco común pero posible si la
        // categoría persistida estaba mal). Re-chequeo defensivo.
        if (categoria === 'INTRAGRUPO') {
          totalExcluido += Math.abs(+r.importe);
          nExcluido++;
          continue;
        }
      }
      // Defense in depth: Raba Buildings es información intra-grupo
      // sensible. Si una fila quedara mal categorizada (no INTRAGRUPO)
      // pero el proveedor canónico es Raba, no debe aparecer en el
      // donut para roles no-admin.
      if (!esAdminLike(req) && RABA_NOMBRES.has(proveedor)) {
        totalExcluido += Math.abs(+r.importe);
        nExcluido++;
        continue;
      }
      // Sin filtro por categoría: el donut muestra TODOS los gastos
      // (impuestos, nóminas, alquileres, suministros, etc.) salvo
      // INTRAGRUPO. Los sensibles (NOMINAS_DIRECCION, GASTOS_DIRECCION,
      // PRESTAMOS, FINANCIERO) y los con override 'include' se fusionan
      // más abajo en el slice "Gastos Dirección" (admin/socio pueden
      // expandirlo; el resto ve 🔒).
      const k = proveedor;
      if (!agg.has(k)) agg.set(k, { total: 0, n: 0, cats: new Map(), ultima_fecha: null });
      const a = agg.get(k);
      a.total += Math.abs(+r.importe);
      a.n += 1;
      a.cats.set(categoria, (a.cats.get(categoria) || 0) + 1);
      if (!a.ultima_fecha || r.fecha > a.ultima_fecha) a.ultima_fecha = r.fecha;
    }

    // Anexamos métricas de pedidos cargados por el usuario
    // (ab_pedidos_semana): nº pedidos y fecha del último pedido por proveedor.
    const pedRows = await many(
      `SELECT proveedor, COUNT(*)::int AS n, MAX(confirmado_en)::text AS ultimo
         FROM ab_pedidos_semana
        WHERE estado IN ('enviado','recibido')
        GROUP BY proveedor`
    );
    const pedidosInfo = new Map(pedRows.map((r) => [r.proveedor, r]));

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

    // Fusión "Gastos Dirección" — aplicada a TODOS los roles. Los
    // proveedores cuya categoría pertenece a CATEGORIAS_DIRECCION_FUSE
    // (o tienen override 'include') se colapsan en un único slice.
    // El total global y los % por slice son idénticos para todos los
    // roles. La única diferencia es el drill-down: admin/socio pueden
    // expandirlo en /grupo-detalle, el resto recibe 403 + 🔒 en UI.
    let fusionados = 0;
    {
      const overrides = gdOverridesPre || new Map();
      const sensibles = proveedores.filter((p) => perteneceAGastosDireccion(p.proveedor, p.categoria, overrides));
      const restantes = proveedores.filter((p) => !perteneceAGastosDireccion(p.proveedor, p.categoria, overrides));
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
        !proveedoresForzados.has(p.proveedor) &&
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
        p.proveedor !== 'Proveedores Menores' &&
        !proveedoresForzados.has(p.proveedor) &&
        p.total_importe < cutOff
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
      // El slice "Gastos Dirección" se ve por todos los roles con el
      // mismo importe. `puede_drilldown` indica si este rol puede pedir
      // /grupo-detalle?grupo=Gastos Dirección (admin/socio sí, el resto
      // recibe 403 — la UI muestra 🔒).
      fusion_direccion: fusionados > 0 ? {
        proveedor: FUSE_PROVEEDOR,
        miembros: fusionados,
        puede_drilldown: esAdminLike(req),
      } : null,
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
    let desde = req.query.desde || null;
    const hasta = req.query.hasta || null;
    const proveedores = (req.query.proveedores || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    const categorias = (req.query.categorias || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    const yoy = req.query.yoy === '1';

    if (!desde || !hasta) return res.status(400).json({ error: 'desde y hasta requeridos (YYYY-MM)' });
    if (!proveedores.length && !categorias.length) return res.json({ meses: [], series: [], series_yoy: [] });

    // Suelo de fecha para no-admin/socio: solo datos desde enero 2026.
    // Si hasta < suelo, no hay rango visible → devolvemos vacío.
    // Si desde < suelo, lo subimos al suelo.
    if (!esAdminLike(req)) {
      const F = PERIODO_FLOOR_NO_ADMIN;
      if (hasta < F) return res.json({ meses: [], proveedores: [], categorias: [], yoy: null, periodo_floor_aplicado: F });
      if (desde < F) desde = F;
    }

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

    // Vista unificada: la serie agregada "Gastos Dirección" puede ser
    // solicitada por cualquier rol (igual que el slice en /proveedores).
    // Para roles no-admin además ocultamos las series individuales de
    // proveedores fusionados, para mantener la opacidad sobre la
    // composición. Admin/socio sí puede pedirlos individualmente si
    // quiere (no hay restricción).
    const noAdmin = !esAdminLike(req);
    const pideFusion = proveedores.includes(FUSE_PROVEEDOR);
    const gdOverridesEvol = await loadGdOverrides();
    // Para no-admin filtramos las categorías sensibles solicitadas
    // explícitamente (no debe poder ver la serie de NOMINAS_DIRECCION
    // por nombre de categoría). Admin sí puede.
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
        // INTRAGRUPO por categoría persistida (Raba Buildings y otros
        // movimientos clasificados como intra-grupo) se excluye para
        // todos: nunca debe aparecer en series de proveedor.
        if (r.categoria === 'INTRAGRUPO') continue;
        const { proveedor: provDerivado, categoria } = normalizarProveedor(r.concepto, r.categoria);
        // Prefer proveedor_normalizado persistido; si no, el derivado.
        const proveedor = r.proveedor_normalizado || provDerivado;
        const cat = categoria || r.categoria;
        // Defense in depth: Raba Buildings para no-admin → skip silencioso.
        if (noAdmin && RABA_NOMBRES.has(proveedor)) continue;
        const abs = Math.abs(+r.importe);
        const esSensible = noAdmin && perteneceAGastosDireccion(proveedor, r.categoria, gdOverridesEvol);

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
// Cache por rol (admin/noadmin) — el filtro de visibilidad cambia el set
// y un cache global filtraría sensibles a admin.
const provCache = { admin: { ts: 0, rows: null }, noadmin: { ts: 0, rows: null } };
router.get('/proveedores-lista', async (req, res) => {
  try {
    const now = Date.now();
    const key = esAdminLike(req) ? 'admin' : 'noadmin';
    const c = provCache[key];
    if (c.rows && (now - c.ts) < 60 * 60 * 1000) {
      return res.json({ proveedores: c.rows });
    }
    const rows = await many(
      `SELECT concepto, categoria, proveedor_normalizado FROM ab_movimientos WHERE importe<0`
    );
    const set = new Map();
    const noAdmin = !esAdminLike(req);
    for (const r of rows) {
      if (esIntraGrupo(r.concepto) || r.categoria === 'INTRAGRUPO') continue;
      const { proveedor, categoria } = normalizarProveedor(r.concepto, r.categoria);
      const provFinal = r.proveedor_normalizado || proveedor;
      // No-admin: excluir Raba + categorías de dirección.
      if (noAdmin) {
        if (RABA_NOMBRES.has(provFinal)) continue;
        if (CATEGORIAS_DIRECCION_FUSE.has(categoria)) continue;
        if (CATEGORIAS_DIRECCION_FUSE.has(r.categoria)) continue;
      }
      if (!set.has(provFinal)) set.set(provFinal, { proveedor: provFinal, categoria });
    }
    const out = [...set.values()].sort((a, b) => a.proveedor.localeCompare(b.proveedor));
    c.rows = out;
    c.ts = now;
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
// reclasificación. Devuelve TODOS los grupos canónicos que aparecen
// en el donut — incluye los proveedor_normalizado persistidos +
// derivados via reglas DB + normalizarProveedor (la misma pipeline
// que /proveedores). Antes el endpoint sólo devolvía rows con
// proveedor_normalizado IS NOT NULL, por eso faltaban grupos virtuales
// como "Alquileres y Arrendamientos", "Nóminas Personal", "TGSS",
// "AEAT - Impuestos", "Energía y Gas", etc.
//
// Seguridad (P2 — Raba Buildings): para roles no-admin/socio
// excluímos INTRAGRUPO (que es donde cae 'Raba Buildings') + cualquier
// match defensivo por nombre. Defense in depth aunque INTRAGRUPO ya
// se filtra arriba.
const RABA_NOMBRES = new Set(['Raba Buildings', 'Raba']);
router.get('/proveedores-normalizados', async (req, res) => {
  try {
    const categoria = req.query.categoria || null;
    const q = (req.query.q || '').trim();
    const limit = Math.min(+req.query.limit || 200, 500);
    const noAdmin = !esAdminLike(req);
    // Filtros de contexto: mismos parámetros que /proveedores (sociedad +
    // período) para que el dropdown sea un reflejo exacto del donut, no
    // una lista global. Si no se envían, devolvemos todos los grupos.
    const sociedad_id = req.query.sociedad_id || null;
    const clamped = clampPeriodoParaNoAdmin(req, {
      periodo: req.query.periodo || null,
      periodo_desde: req.query.periodo_desde || null,
      periodo_hasta: req.query.periodo_hasta || null,
    });
    if (clamped.fueraDeRango) {
      return res.json({
        proveedores: [],
        filtros: { sociedad_id, periodo: clamped.periodo, periodo_desde: clamped.periodo_desde, periodo_hasta: clamped.periodo_hasta },
        periodo_floor_aplicado: PERIODO_FLOOR_NO_ADMIN,
      });
    }
    const { periodo, periodo_desde, periodo_hasta } = clamped;

    // Traemos todos los gastos (proveedor_normalizado puede ser NULL).
    // Para no-admin descartamos INTRAGRUPO directo en SQL.
    const where = ['importe < 0'];
    const vals = [];
    if (categoria)  { where.push(`categoria = $${vals.length + 1}`); vals.push(categoria); }
    if (noAdmin)    { where.push(`categoria <> 'INTRAGRUPO'`); }
    // Filtros sociedad/período idénticos a los del donut /proveedores.
    const socCl = buildSociedadClause(sociedad_id, vals.length + 1);
    if (socCl)         { where.push(socCl.sql);                       vals.push(...socCl.vals); }
    if (periodo)       { where.push(`periodo=$${vals.length + 1}`);   vals.push(periodo); }
    if (periodo_desde) { where.push(`periodo>=$${vals.length + 1}`);  vals.push(periodo_desde); }
    if (periodo_hasta) { where.push(`periodo<=$${vals.length + 1}`);  vals.push(periodo_hasta); }
    const rows = await many(
      `SELECT concepto, categoria, importe::float8 AS importe, proveedor_normalizado
         FROM ab_movimientos
        WHERE ${where.join(' AND ')}`,
      vals
    );
    const reglasDb = await loadReglas();
    const gdOverrides = await loadGdOverrides();

    // Agrupar por proveedor canónico derivado (misma pipeline que
    // /proveedores): proveedor_normalizado > regla DB > normalizarProveedor().
    // Paridad estricta con el donut: INTRAGRUPO se excluye para TODOS los
    // roles (igual que /proveedores). Si admin quiere reasignar a un grupo
    // intra-grupo, puede escribirlo y usar "Crear nuevo: <nombre>".
    const agg = new Map(); // nombre → { total, n, categoria_top: { cat→count } }
    for (const r of rows) {
      if (esIntraGrupo(r.concepto) || r.categoria === 'INTRAGRUPO') continue;
      let nombre, cat;
      if (r.proveedor_normalizado) {
        nombre = r.proveedor_normalizado; cat = r.categoria;
      } else {
        const rule = matchRegla(r.concepto, reglasDb);
        if (rule) { nombre = rule.proveedor_normalizado; cat = rule.categoria; }
        else {
          const n = normalizarProveedor(r.concepto, r.categoria);
          nombre = n.proveedor; cat = n.categoria;
        }
      }
      // Re-chequeo post-derivación: el normalizer puede recategorizar a
      // INTRAGRUPO. Excluir para todos los roles.
      if (cat === 'INTRAGRUPO') continue;
      // Raba: defense in depth para no-admin (Raba se persiste como
      // PROVEEDOR_OTROS, no INTRAGRUPO, así que el filtro anterior no
      // la atrapaba).
      if (noAdmin && RABA_NOMBRES.has(nombre)) continue;
      // Filtro por categoría solicitada (post-derivación, porque el
      // proveedor canónico puede caer en una categoría distinta a la
      // persistida cuando hay regla DB).
      if (categoria && cat !== categoria) continue;
      if (!agg.has(nombre)) agg.set(nombre, { total: 0, n: 0, cats: new Map() });
      const a = agg.get(nombre);
      a.total += Math.abs(+r.importe);
      a.n += 1;
      a.cats.set(cat, (a.cats.get(cat) || 0) + 1);
    }

    // Aplicar mismas transformaciones que /proveedores para paridad
    // estricta dropdown ↔ donut: (a) fusión "Gastos Dirección" y
    // (b) rollup "Proveedores Menores" con mismos thresholds.
    let proveedores = [...agg.entries()].map(([nombre, a]) => {
      let topCat = null, topCnt = 0;
      for (const [c, n] of a.cats.entries()) if (n > topCnt) { topCnt = n; topCat = c; }
      return { nombre, n: a.n, total_importe: a.total, categoria: topCat };
    });

    // (a) Fusión Gastos Dirección — mismas reglas que /proveedores.
    {
      const sensibles = proveedores.filter((p) => perteneceAGastosDireccion(p.nombre, p.categoria, gdOverrides));
      const restantes = proveedores.filter((p) => !perteneceAGastosDireccion(p.nombre, p.categoria, gdOverrides));
      if (sensibles.length) {
        const tot = sensibles.reduce((s, p) => s + p.total_importe, 0);
        const tx = sensibles.reduce((s, p) => s + p.n, 0);
        restantes.push({
          nombre: FUSE_PROVEEDOR,
          n: tx,
          total_importe: tot,
          categoria: 'GASTOS_DIRECCION',
          _es_grupo_fusion: true,
          _miembros: sensibles.length,
        });
      }
      proveedores = restantes;
    }

    // (b) Rollup "Proveedores Menores" — mismas reglas que /proveedores.
    const proveedoresForzados = new Set(
      reglasDb.filter((r) => r.forzar_visible).map((r) => r.proveedor_normalizado)
    );
    const minTx = req.query.menores_min_tx ? +req.query.menores_min_tx : 5;
    const minEur = req.query.menores_min_eur ? +req.query.menores_min_eur : 2000;
    const maxGrupos = req.query.max_grupos ? +req.query.max_grupos : 50;
    function colapsar(lista, predicate) {
      const grandes = lista.filter((p) => !predicate(p));
      const menores = lista.filter(predicate);
      if (menores.length <= 1) return lista;
      const tot = menores.reduce((s, p) => s + p.total_importe, 0);
      const tx = menores.reduce((s, p) => s + p.n, 0);
      const existente = grandes.find((p) => p.nombre === 'Proveedores Menores');
      if (existente) {
        existente.total_importe += tot;
        existente.n += tx;
        existente._miembros = (existente._miembros || 0) + menores.length;
        return grandes;
      }
      grandes.push({
        nombre: 'Proveedores Menores',
        n: tx,
        total_importe: tot,
        categoria: 'PROVEEDOR_OTROS',
        _es_bucket_virtual: true,
        _miembros: menores.length,
      });
      return grandes;
    }
    proveedores = colapsar(proveedores, (p) =>
      !proveedoresForzados.has(p.nombre) && p.n < minTx && p.total_importe < minEur
    );
    if (proveedores.length > maxGrupos) {
      const sortDesc = [...proveedores].sort((a, b) => b.total_importe - a.total_importe);
      const cutOff = sortDesc[maxGrupos - 2]?.total_importe ?? 0;
      proveedores = colapsar(proveedores, (p) =>
        p.nombre !== 'Proveedores Menores' &&
        !proveedoresForzados.has(p.nombre) &&
        p.total_importe < cutOff
      );
    }

    // Filtro de texto sobre el set final (post-fusión + rollup).
    const qNorm = q.toLowerCase();
    if (q) proveedores = proveedores.filter((p) => p.nombre.toLowerCase().includes(qNorm));

    // Orden: total DESC, desempate alfabético.
    proveedores.sort((a, b) => b.total_importe - a.total_importe
      || a.nombre.localeCompare(b.nombre));

    if (proveedores.length > limit) proveedores = proveedores.slice(0, limit);

    res.json({ proveedores });
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
    const clamped = clampPeriodoParaNoAdmin(req, {
      periodo: req.query.periodo || null,
      periodo_desde: req.query.periodo_desde || null,
      periodo_hasta: req.query.periodo_hasta || null,
    });
    if (clamped.fueraDeRango) {
      return res.json({
        grupo,
        es_bucket_menores: false,
        proveedores_menores: null,
        total: 0, num_conceptos: 0, conceptos: [],
        periodo_floor_aplicado: PERIODO_FLOOR_NO_ADMIN,
      });
    }
    const periodo = clamped.periodo;
    const periodo_desde = clamped.periodo_desde;
    const periodo_hasta = clamped.periodo_hasta;

    // Bloqueo de drill-down sobre grupos sensibles para roles no-admin.
    // El slice "Gastos Dirección" no se expande, y tampoco se permite
    // acceder por URL a los proveedores individuales que pertenecen a
    // ese grupo (default por categoría + overrides admin-managed).
    // Además Raba Buildings (INTRAGRUPO) está bloqueado por nombre y por
    // categoría como defense in depth.
    if (!esAdminLike(req)) {
      if (grupo === FUSE_PROVEEDOR) {
        return res.status(403).json({ error: 'Forbidden: grupo restringido por rol' });
      }
      if (RABA_NOMBRES.has(grupo)) {
        return res.status(403).json({ error: 'Forbidden: grupo restringido por rol' });
      }
      const overrides = await loadGdOverrides();
      const cat = await one(
        'SELECT MAX(categoria) AS cat FROM ab_movimientos WHERE proveedor_normalizado = $1',
        [grupo]
      );
      if (cat?.cat === 'INTRAGRUPO') {
        return res.status(403).json({ error: 'Forbidden: grupo restringido por rol' });
      }
      if (perteneceAGastosDireccion(grupo, cat?.cat, overrides)) {
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
    // Caso especial 2: el slice "Gastos Dirección" es un bucket virtual
    // que agrupa proveedores con categorías sensibles + overrides admin.
    // El drill-down sólo es accesible para admin/socio (el bloqueo de
    // arriba ya garantiza esto). Aquí resolvemos qué proveedores caen
    // en el bucket para incluir sus conceptos.
    const ES_FUSE_DIRECCION = (grupo === FUSE_PROVEEDOR);
    let provsMenores = null;
    let provsFuseDireccion = null;
    if (ES_MENORES) {
      // Espejo del filtro de /proveedores: el bucket "Proveedores Menores"
      // se construye con count<5 AND total<2000€, PERO excluye a los
      // proveedores con regla forzar_visible=TRUE (que en /proveedores
      // aparecen como slice individual, no en el bucket). Sin esta
      // exclusión, una reclasificación manual hace aparecer el slice
      // en el donut pero el concepto sigue viéndose en el drill-down
      // de Menores — disonancia que confunde al usuario.
      const proveedoresForzados = new Set(
        reglasDb.filter((r) => r.forzar_visible).map((r) => r.proveedor_normalizado)
      );
      const totPorProv = new Map();
      for (const e of enriched) {
        const x = totPorProv.get(e._proveedor) || { total: 0, n: 0 };
        x.total += Math.abs(+e.importe);
        x.n += 1;
        totPorProv.set(e._proveedor, x);
      }
      provsMenores = new Set(
        [...totPorProv.entries()]
          .filter(([prov, x]) => !proveedoresForzados.has(prov) && x.n < 5 && x.total < 2000)
          .map(([p]) => p)
      );
    }
    if (ES_FUSE_DIRECCION) {
      const overrides = await loadGdOverrides();
      // Tomamos la categoría más frecuente por proveedor para resolver
      // pertenencia al slice (mismo criterio que /proveedores).
      const catPorProv = new Map();
      for (const e of enriched) {
        if (!catPorProv.has(e._proveedor)) catPorProv.set(e._proveedor, new Map());
        const cm = catPorProv.get(e._proveedor);
        cm.set(e._categoria, (cm.get(e._categoria) || 0) + 1);
      }
      const setFuse = new Set();
      for (const [prov, cm] of catPorProv.entries()) {
        let topCat = null, topCnt = 0;
        for (const [c, n] of cm.entries()) if (n > topCnt) { topCnt = n; topCat = c; }
        if (perteneceAGastosDireccion(prov, topCat, overrides)) setFuse.add(prov);
      }
      provsFuseDireccion = setFuse;
    }

    const porConcepto = new Map();
    for (const r of enriched) {
      if (ES_MENORES) {
        if (!provsMenores.has(r._proveedor)) continue;
      } else if (ES_FUSE_DIRECCION) {
        if (!provsFuseDireccion.has(r._proveedor)) continue;
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
      es_bucket_direccion: !!provsFuseDireccion,
      proveedores_direccion: provsFuseDireccion ? [...provsFuseDireccion].sort() : null,
      total: totalGrupo,
      num_conceptos: conceptos.length,
      conceptos,
    });
  } catch (e) {
    console.error('[bancos.grupo-detalle]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ─── GASTOS DIRECCIÓN · gestión admin-only ─────────────────────────────
// Estos endpoints permiten a admin/socio inspeccionar y manipular qué
// proveedores caen en el slice fusionado "Gastos Dirección" que ven
// los roles no-admin. La membresía default está dada por la categoría
// (CATEGORIAS_DIRECCION_FUSE). La tabla ab_gastos_direccion_overrides
// permite override por proveedor: 'include' lo agrega aunque su
// categoría no esté en el set, 'exclude' lo saca aunque sí esté.

function requireAdminLike(req, res, next) {
  if (!esAdminLike(req)) return res.status(403).json({ error: 'admin/socio only' });
  return next();
}

// GET /api/v1/bancos/gastos-direccion/composicion
// Devuelve la composición actual del grupo fusionado, agrupada por
// categoría, con los overrides admin marcados explícitamente. Usa la
// misma lógica de derivación que /proveedores (proveedor_normalizado
// columna > regla DB > normalizarProveedor()).
router.get('/gastos-direccion/composicion', requireAdminLike, async (req, res) => {
  try {
    const [overrides, reglasDb] = await Promise.all([loadGdOverrides(), loadReglas()]);
    const rows = await many(
      `SELECT proveedor_normalizado, categoria, importe::float8 AS importe,
              concepto, fecha::text AS fecha
         FROM ab_movimientos
        WHERE importe < 0`
    );
    // Agregar por (proveedor canónico) sumando importe + tx + categoría top.
    const agg = new Map();
    for (const r of rows) {
      if (esIntraGrupo(r.concepto)) continue;
      let prov, cat;
      if (r.proveedor_normalizado) { prov = r.proveedor_normalizado; cat = r.categoria; }
      else {
        const rule = matchRegla(r.concepto, reglasDb);
        if (rule) { prov = rule.proveedor_normalizado; cat = rule.categoria; }
        else {
          const n = normalizarProveedor(r.concepto, r.categoria);
          prov = n.proveedor; cat = n.categoria;
        }
      }
      const key = prov;
      if (!agg.has(key)) agg.set(key, { proveedor: prov, total: 0, n: 0, cats: new Map(), ultima_fecha: null });
      const a = agg.get(key);
      a.total += Math.abs(+r.importe);
      a.n += 1;
      a.cats.set(cat, (a.cats.get(cat) || 0) + 1);
      if (!a.ultima_fecha || r.fecha > a.ultima_fecha) a.ultima_fecha = r.fecha;
    }
    // Construir mapa por categoría con los miembros del grupo.
    const porCategoria = {};
    for (const c of CATEGORIAS_DIRECCION_FUSE) porCategoria[c] = [];
    porCategoria.__INCLUIDOS_EXTRA__ = []; // override 'include' con categoría no-default
    const incluidosOverride = [];
    const excluidosOverride = [];
    let totalFusionado = 0;
    for (const a of agg.values()) {
      let topCat = null, topCnt = 0;
      for (const [c, n] of a.cats.entries()) if (n > topCnt) { topCnt = n; topCat = c; }
      const ov = overrides.get(a.proveedor) || null;
      const pertenece = perteneceAGastosDireccion(a.proveedor, topCat, overrides);
      const item = {
        proveedor: a.proveedor,
        categoria: topCat,
        total_importe: Math.round(a.total * 100) / 100,
        num_transacciones: a.n,
        ultima_fecha: a.ultima_fecha,
        override: ov,
      };
      if (pertenece) {
        totalFusionado += a.total;
        if (porCategoria[topCat]) porCategoria[topCat].push(item);
        else porCategoria.__INCLUIDOS_EXTRA__.push(item);
        if (ov === 'include') incluidosOverride.push(item);
      } else if (ov === 'exclude') {
        excluidosOverride.push(item);
      }
    }
    // Sort cada bucket por total DESC.
    for (const k of Object.keys(porCategoria)) porCategoria[k].sort((a, b) => b.total_importe - a.total_importe);
    incluidosOverride.sort((a, b) => b.total_importe - a.total_importe);
    excluidosOverride.sort((a, b) => b.total_importe - a.total_importe);

    res.json({
      slice_proveedor: FUSE_PROVEEDOR,
      categorias_default: [...CATEGORIAS_DIRECCION_FUSE],
      por_categoria: porCategoria,
      incluidos_via_override: incluidosOverride,
      excluidos_via_override: excluidosOverride,
      total_fusionado: Math.round(totalFusionado * 100) / 100,
      n_proveedores: Object.values(porCategoria).reduce((s, arr) => s + arr.length, 0),
    });
  } catch (e) {
    console.error('[bancos.gd.composicion]', e);
    res.status(500).json({ error: e.message || 'internal' });
  }
});

// POST /api/v1/bancos/gastos-direccion/override
// body: { proveedor, accion: 'include' | 'exclude' }
router.post('/gastos-direccion/override', express.json(), requireAdminLike, async (req, res) => {
  try {
    const { proveedor, accion } = req.body || {};
    if (!proveedor || !['include', 'exclude'].includes(accion)) {
      return res.status(400).json({ error: 'proveedor y accion ∈ {include, exclude} requeridos' });
    }
    const r = await one(
      `INSERT INTO ab_gastos_direccion_overrides (proveedor_normalizado, accion, creado_por)
       VALUES ($1, $2, $3)
       ON CONFLICT (proveedor_normalizado) DO UPDATE
         SET accion = EXCLUDED.accion, creado_en = NOW(), creado_por = EXCLUDED.creado_por
       RETURNING proveedor_normalizado, accion, creado_en, creado_por`,
      [proveedor, accion, req.session?.user?.email || null]
    );
    res.json({ ok: true, override: r });
  } catch (e) {
    console.error('[bancos.gd.override.post]', e);
    res.status(500).json({ error: e.message || 'internal' });
  }
});

// DELETE /api/v1/bancos/gastos-direccion/override/:proveedor
// Quita el override → el proveedor vuelve al comportamiento default
// (en el grupo si su categoría es sensible, fuera si no).
router.delete('/gastos-direccion/override/:proveedor', requireAdminLike, async (req, res) => {
  try {
    const proveedor = decodeURIComponent(req.params.proveedor || '');
    if (!proveedor) return res.status(400).json({ error: 'proveedor requerido' });
    const r = await query('DELETE FROM ab_gastos_direccion_overrides WHERE proveedor_normalizado = $1', [proveedor]);
    res.json({ ok: true, deleted: r.rowCount });
  } catch (e) {
    console.error('[bancos.gd.override.delete]', e);
    res.status(500).json({ error: e.message || 'internal' });
  }
});

// Reclasificar un concepto: UPDATE en ab_movimientos para todas las filas
// con ese concepto exacto y, opcionalmente, guardar una regla persistente.
router.post('/reclasificar', express.json(), async (req, res) => {
  try {
    const { concepto, proveedor_nuevo, guardar_regla, tipo_match, patron } = req.body || {};
    let { categoria_nueva } = req.body || {};
    if (!concepto || !categoria_nueva || !proveedor_nuevo) {
      return res.status(400).json({ error: 'concepto, categoria_nueva y proveedor_nuevo requeridos' });
    }
    // Si el concepto matchea una regla protegida (ej. Raba), la regla
    // gana siempre — nadie (ni admin) puede sobreescribir el destino.
    // Esto blindar la seed Raba → GASTOS_DIRECCION contra cualquier
    // intento de reclasificación manual.
    const reglasDb = await loadReglas();
    const reglaProtegida = matchRegla(concepto, reglasDb);
    if (reglaProtegida?.protegida) {
      const okDestino = categoria_nueva === reglaProtegida.categoria
        && proveedor_nuevo === reglaProtegida.proveedor_normalizado;
      if (!okDestino) {
        return res.status(409).json({
          error: 'Concepto regido por regla protegida',
          regla: { categoria: reglaProtegida.categoria, proveedor: reglaProtegida.proveedor_normalizado },
        });
      }
    }
    // Restricciones para no-admin:
    //   1) No pueden tocar conceptos que ya pertenecen a categorías sensibles
    //      (NOMINAS_DIRECCION, GASTOS_DIRECCION, PRESTAMOS, FINANCIERO, INTRAGRUPO)
    //      ni a Raba Buildings.
    //   2) No pueden asignar a categoría sensible ni a Raba como destino.
    if (!esAdminLike(req)) {
      const blocked = ['INTRAGRUPO', ...CATEGORIAS_DIRECCION_FUSE];
      if (blocked.includes(categoria_nueva) || RABA_NOMBRES.has(proveedor_nuevo) || proveedor_nuevo === FUSE_PROVEEDOR) {
        return res.status(403).json({ error: 'Destino restringido: requiere admin/socio' });
      }
      const actual = await one(
        'SELECT MAX(categoria) AS cat, MAX(proveedor_normalizado) AS prov FROM ab_movimientos WHERE concepto=$1',
        [concepto]
      );
      if (actual?.cat && (blocked.includes(actual.cat) || RABA_NOMBRES.has(actual.prov))) {
        return res.status(403).json({ error: 'Concepto restringido: requiere admin/socio' });
      }
    }
    // "Gastos Dirección" es un destino canónico hacia el slice fusionado:
    // forzamos categoria=GASTOS_DIRECCION para que el movimiento quede
    // dentro del grupo protegido (default-by-category de la fusión),
    // independientemente de la categoría que haya elegido la UI.
    if (proveedor_nuevo === FUSE_PROVEEDOR) {
      categoria_nueva = 'GASTOS_DIRECCION';
    }
    // 1) UPDATE ab_movimientos por concepto exacto — MOVE, no COPY.
    // Sin filtro de fecha ni sociedad: la reclasificación es de
    // alcance global sobre todos los períodos y sociedades donde
    // exista ese concepto. Es lo que permite que una sola operación
    // del usuario tape todo el histórico.
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
    const periodosAfectados = new Set((upd.rows || []).map((r) => r.periodo));

    // 2) Si toggle "Aplicar a futuros extractos" → guardar regla.
    // Prioridad 110: por encima de las reglas seed (≤100) y por encima
    // de las reglas históricas creadas con prioridad 100. La regla más
    // reciente del usuario gana ante conflictos.
    let regla_id = null;
    if (guardar_regla) {
      const tipo = ['ilike', 'regex', 'exacto'].includes(tipo_match) ? tipo_match : 'ilike';
      // Por default usamos el concepto completo como patrón ilike — captura
      // el caso típico (mismo extracto futuro). Si el usuario pasa `patron`
      // explícito (ej. substring corto), respetamos.
      const pat = patron || concepto;
      // forzar_visible=TRUE: reclasificación manual desde el sidebar →
      // garantiza que el slice del nuevo proveedor sea visible en el
      // donut aunque su importe sea pequeño (no cae en Proveedores
      // Menores ni en el cap top-N).
      const ins = await one(
        `INSERT INTO ab_reglas_normalizacion (patron, tipo_match, categoria, proveedor_normalizado, prioridad, forzar_visible)
         VALUES ($1, $2, $3, $4, 110, TRUE)
         RETURNING id`,
        [pat, tipo, categoria_nueva, proveedor_nuevo]
      );
      regla_id = ins?.id || null;
    }

    // 3) Recalcular resumen mensual + cruces TPV/banco para cada
    // (sociedad, periodo) afectado. Tolerante: si una sociedad/periodo
    // no tiene cierres TPV, el cruce falla silenciosamente — está bien.
    for (const combo of combos) {
      const [sociedad_id, periodo] = combo.split('|');
      try { await bankDb.recalcResumenMensual(sociedad_id, periodo); } catch (e) { /* tolerante */ }
      try { await bankDb.recalcCrucesParaSociedadPeriodo(sociedad_id, periodo); } catch (e) { /* tolerante */ }
    }

    res.json({
      ok: true,
      affected,
      regla_id,
      combos: combos.size,
      periodos_afectados: [...periodosAfectados].sort(),
    });
  } catch (e) {
    console.error('[bancos.reclasificar]', e);
    res.status(500).json({ error: e.message || 'internal' });
  }
});

// Listado de reglas persistentes (activas e inactivas).
// Para no-admin: ocultar reglas que apunten a categorías sensibles o a
// Raba Buildings (exponerlas filtraría la composición de Gastos Dirección).
router.get('/reglas-normalizacion', async (req, res) => {
  try {
    let rows = await many(
      `SELECT id, patron, tipo_match, categoria, proveedor_normalizado,
              prioridad, activo, creado_en, forzar_visible, protegida
         FROM ab_reglas_normalizacion
        ORDER BY prioridad DESC, id ASC`
    );
    if (!esAdminLike(req)) {
      const blocked = new Set(['INTRAGRUPO', ...CATEGORIAS_DIRECCION_FUSE]);
      rows = rows.filter((r) => !blocked.has(r.categoria) && !RABA_NOMBRES.has(r.proveedor_normalizado));
    }
    res.json({ reglas: rows });
  } catch (e) {
    console.error('[bancos.reglas.list]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// Borrar regla (hard delete — no soft, para no acumular ruido).
// Reservado a admin/socio (cambios estructurales sobre la pipeline).
// Las reglas marcadas `protegida=TRUE` no pueden borrarse (ej. la regla
// seed Raba Buildings → GASTOS_DIRECCION).
router.delete('/reglas-normalizacion/:id', requireAdminLike, async (req, res) => {
  try {
    const id = +req.params.id;
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
    const existente = await one('SELECT protegida FROM ab_reglas_normalizacion WHERE id=$1', [id]);
    if (existente?.protegida) {
      return res.status(409).json({ error: 'Regla protegida: no se puede borrar' });
    }
    const r = await query('DELETE FROM ab_reglas_normalizacion WHERE id=$1', [id]);
    res.json({ ok: true, deleted: r.rowCount });
  } catch (e) {
    console.error('[bancos.reglas.delete]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// Recalcular todo (útil tras cambios manuales). Admin/socio only — toca
// totales agregados que se sirven a todos los roles.
router.post('/recalc', requireAdminLike, async (req, res) => {
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

// ─── REGLAS DE PROVEEDORES (drag & drop admin) ────────────────────────
// Pantalla admin para clasificar proveedores en categorías de una vez
// para siempre. Crea/borra reglas en ab_reglas_normalizacion + actualiza
// movimientos históricos. Sólo admin + socio (perm bancos_reglas_admin).
const { CATEGORIAS_GASTO } = require('../lib/bank/categorizer');

// Categorías ofrecidas como drop-zones. Excluye INTRAGRUPO (regla
// distinta, no se asigna manualmente) e INGRESO_* (son ingresos).
const CATEGORIAS_PARA_REGLAS = CATEGORIAS_GASTO.filter((c) => c !== 'INTRAGRUPO');

router.get('/reglas-prov/categorias', requirePerm('bancos_reglas_admin'), (req, res) => {
  res.json({ categorias: CATEGORIAS_PARA_REGLAS });
});

// Lista de proveedores únicos SIN regla en ab_reglas_normalizacion.
// Deriva proveedor canónico via pipeline runtime (mismo que /proveedores)
// para que la lista refleje la categorización efectiva actual.
router.get('/reglas-prov/sin-clasificar', requirePerm('bancos_reglas_admin'), async (req, res) => {
  try {
    const limit = Math.min(+req.query.limit || 500, 2000);
    const rows = await many(
      `SELECT concepto, categoria, importe::float8 AS importe, proveedor_normalizado
         FROM ab_movimientos
        WHERE importe < 0`
    );
    const reglas = await loadReglas();
    // Set de proveedor_normalizado que YA tienen al menos una regla.
    const conRegla = new Set(reglas.map((r) => r.proveedor_normalizado));

    const agg = new Map(); // proveedor → { n, total }
    for (const r of rows) {
      if (esIntraGrupo(r.concepto)) continue;
      let proveedor;
      if (r.proveedor_normalizado) {
        proveedor = r.proveedor_normalizado;
      } else {
        const rule = matchRegla(r.concepto, reglas);
        proveedor = rule
          ? rule.proveedor_normalizado
          : normalizarProveedor(r.concepto, r.categoria).proveedor;
      }
      if (!proveedor) continue;
      if (proveedor === FUSE_PROVEEDOR) continue;            // virtual
      if (proveedor === 'Proveedores Menores') continue;     // virtual
      if (conRegla.has(proveedor)) continue;
      if (!agg.has(proveedor)) agg.set(proveedor, { n: 0, total: 0 });
      const o = agg.get(proveedor);
      o.n++;
      o.total += Math.abs(r.importe);
    }
    const proveedores = [...agg.entries()]
      .map(([proveedor, x]) => ({ proveedor, n_movimientos: x.n, total_importe: x.total }))
      .sort((a, b) => b.total_importe - a.total_importe)
      .slice(0, limit);
    res.json({ proveedores, total: agg.size });
  } catch (e) {
    console.error('[bancos.reglas-prov.sin-clasificar]', e);
    res.status(500).json({ error: e.message || 'internal' });
  }
});

// Lista de proveedores YA clasificados, agrupados por categoría que
// dicta la regla. Incluye stats agregadas (n_movs + total) calculadas
// matcheando contra ab_movimientos.
router.get('/reglas-prov/clasificados', requirePerm('bancos_reglas_admin'), async (req, res) => {
  try {
    const reglasActivas = await many(
      `SELECT id, patron, tipo_match, categoria, proveedor_normalizado,
              prioridad, forzar_visible, protegida
         FROM ab_reglas_normalizacion
        WHERE activo = TRUE
        ORDER BY categoria, proveedor_normalizado`
    );
    // Stats vía MISMO PIPELINE que /proveedores (matchRegla +
    // normalizarProveedor), no por proveedor_normalizado literal.
    // Garantiza que los números mostrados acá coincidan exactamente
    // con el donut, sin importar si el backfill se materializó o no
    // en la columna proveedor_normalizado. Sin filtro de fecha
    // (la pantalla cubre todo el histórico).
    const rows = await many(
      `SELECT concepto, categoria, importe::float8 AS importe, proveedor_normalizado
         FROM ab_movimientos
        WHERE importe < 0`
    );
    const reglasPipeline = await loadReglas();
    const statMap = new Map();
    for (const r of rows) {
      if (esIntraGrupo(r.concepto)) continue;
      let prov;
      if (r.proveedor_normalizado) prov = r.proveedor_normalizado;
      else {
        const rule = matchRegla(r.concepto, reglasPipeline);
        prov = rule ? rule.proveedor_normalizado
                    : normalizarProveedor(r.concepto, r.categoria).proveedor;
      }
      if (!prov) continue;
      if (!statMap.has(prov)) statMap.set(prov, { n_movimientos: 0, total_importe: 0 });
      const s = statMap.get(prov);
      s.n_movimientos++;
      s.total_importe += Math.abs(r.importe);
    }
    const enriched = reglasActivas.map((r) => ({
      ...r,
      n_movimientos: statMap.get(r.proveedor_normalizado)?.n_movimientos || 0,
      total_importe: statMap.get(r.proveedor_normalizado)?.total_importe || 0,
    }));
    // Agrupar por categoría
    const porCategoria = {};
    for (const c of CATEGORIAS_PARA_REGLAS) porCategoria[c] = [];
    for (const r of enriched) {
      if (!porCategoria[r.categoria]) porCategoria[r.categoria] = [];
      porCategoria[r.categoria].push(r);
    }
    for (const c of Object.keys(porCategoria)) {
      porCategoria[c].sort((a, b) => b.total_importe - a.total_importe);
    }
    res.json({ por_categoria: porCategoria, total_reglas: reglasActivas.length });
  } catch (e) {
    console.error('[bancos.reglas-prov.clasificados]', e);
    res.status(500).json({ error: e.message || 'internal' });
  }
});

// Detalle (top movimientos) para un proveedor — abre el mini-modal del
// panel izquierdo. Match: proveedor_normalizado exacto OR substring en
// concepto (defensive — captura filas sin proveedor_normalizado seteado).
router.get('/reglas-prov/detalle/:proveedor', requirePerm('bancos_reglas_admin'), async (req, res) => {
  try {
    const prov = decodeURIComponent(req.params.proveedor || '').trim();
    if (!prov) return res.status(400).json({ error: 'proveedor requerido' });
    const rows = await many(
      `SELECT id, fecha::text AS fecha, concepto, categoria,
              importe::float8 AS importe, sociedad_id, proveedor_normalizado
         FROM ab_movimientos
        WHERE (proveedor_normalizado = $1 OR position(LOWER($1) IN LOWER(concepto)) > 0)
          AND importe < 0
        ORDER BY ABS(importe) DESC
        LIMIT 50`,
      [prov]
    );
    const total = await one(
      `SELECT COUNT(*)::int AS n, SUM(ABS(importe))::float8 AS total
         FROM ab_movimientos
        WHERE (proveedor_normalizado = $1 OR position(LOWER($1) IN LOWER(concepto)) > 0)
          AND importe < 0`,
      [prov]
    );
    res.json({ proveedor: prov, movimientos: rows, total });
  } catch (e) {
    console.error('[bancos.reglas-prov.detalle]', e);
    res.status(500).json({ error: e.message || 'internal' });
  }
});

// Asignar un proveedor a una categoría → crea regla + reclasifica
// históricos. Idempotente: si ya hay regla para ese proveedor, la
// actualiza (no inserta duplicada).
router.post('/reglas-prov/asignar', express.json(), requirePerm('bancos_reglas_admin'), async (req, res) => {
  try {
    const proveedor = (req.body?.proveedor || '').trim();
    const categoria = (req.body?.categoria || '').trim();
    if (!proveedor || !categoria) return res.status(400).json({ error: 'proveedor y categoria requeridos' });
    if (!CATEGORIAS_PARA_REGLAS.includes(categoria)) return res.status(400).json({ error: 'categoria inválida' });

    // 1) Upsert regla. Si ya hay una con mismo proveedor_normalizado +
    // patron == proveedor, la actualizamos para no acumular duplicadas.
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
        [categoria, regla.id]
      );
    } else {
      regla = await one(
        `INSERT INTO ab_reglas_normalizacion
           (patron, tipo_match, categoria, proveedor_normalizado, prioridad, forzar_visible)
         VALUES ($1, 'ilike', $2, $1, 120, TRUE)
         RETURNING id`,
        [proveedor, categoria]
      );
    }

    // 2) Reclasificar HISTÓRICOS: match por proveedor_normalizado exacto
    // O substring case-insensitive en concepto. Todos a nueva categoría.
    const upd = await query(
      `UPDATE ab_movimientos
          SET categoria = $1,
              proveedor_normalizado = $2
        WHERE (proveedor_normalizado = $2 OR position(LOWER($2) IN LOWER(concepto)) > 0)
          AND importe < 0
        RETURNING sociedad_id, periodo`,
      [categoria, proveedor]
    );
    const affected = upd.rowCount || 0;
    const combos = new Set((upd.rows || []).map((r) => `${r.sociedad_id}|${r.periodo}`));

    // 3) Recalcular resumen + cruces para los combos tocados.
    for (const c of combos) {
      const [soc, per] = c.split('|');
      try { await bankDb.recalcResumenMensual(soc, per); } catch (e) { /* tolerante */ }
      try { await bankDb.recalcCrucesParaSociedadPeriodo(soc, per); } catch (e) { /* tolerante */ }
    }

    res.json({ ok: true, regla_id: regla.id, affected, combos: combos.size });
  } catch (e) {
    console.error('[bancos.reglas-prov.asignar]', e);
    res.status(500).json({ error: e.message || 'internal' });
  }
});

// IA: clasifica un batch de proveedores. Frontend chunkea y llama N
// veces para mostrar barra de progreso. Sólo admin (perm
// bancos_reglas_ia). Requiere OPENROUTER_API_KEY en el entorno.
//
// Transporte: OpenRouter (OpenAI-compatible). Modelo:
// anthropic/claude-sonnet-4-6 — mismo Claude que usaríamos vía Anthropic
// directo, servido por OpenRouter. NO hay prompt caching disponible
// (OpenRouter no soporta cache_control de Anthropic), así que cada
// batch paga el system completo. La lógica (prompt + parse + validación)
// vive en lib/ai/classify-proveedores.js para mantener el route handler
// fino y reutilizable desde otros call sites a futuro.
const { classifyProveedores } = require('../lib/ai/classify-proveedores');
router.post('/reglas-prov/ia-clasificar', express.json({ limit: '256kb' }), requirePerm('bancos_reglas_ia'), async (req, res) => {
  try {
    const proveedores = Array.isArray(req.body?.proveedores) ? req.body.proveedores : [];
    if (!proveedores.length) return res.json({ sugerencias: [] });
    if (proveedores.length > 60) return res.status(400).json({ error: 'máximo 60 proveedores por batch' });

    // Top 40 reglas existentes como ejemplos in-context.
    const reglasEjemplo = await many(
      `SELECT r.proveedor_normalizado, r.categoria
         FROM ab_reglas_normalizacion r
        WHERE r.activo = TRUE AND r.proveedor_normalizado IS NOT NULL
        ORDER BY r.prioridad DESC, r.id ASC
        LIMIT 40`
    );

    const result = await classifyProveedores({
      proveedores,
      reglasEjemplo,
      categorias: CATEGORIAS_PARA_REGLAS,
    });
    return res.json(result);
  } catch (e) {
    // Errores tipados del helper → mapeo a HTTP status.
    if (e.type === 'no_api_key') {
      return res.status(503).json({
        error: 'OPENROUTER_API_KEY no configurada',
        hint: 'Setear la variable de entorno en Railway / .env y reiniciar el server.',
      });
    }
    if (e.type === 'http') {
      console.error('[reglas-prov.ia] OpenRouter HTTP', e.status, e.body?.slice(0, 200));
      return res.status(502).json({ error: `OpenRouter ${e.status}`, detalle: e.body?.slice(0, 200) });
    }
    if (e.type === 'parse') {
      console.error('[reglas-prov.ia] parse fail, raw:', e.raw);
      return res.status(502).json({ error: 'respuesta del modelo no parseable', raw: e.raw });
    }
    console.error('[reglas-prov.ia-clasificar]', e);
    res.status(500).json({ error: e.message || 'internal' });
  }
});

// Borrar una regla (devuelve al proveedor al panel "sin clasificar").
// NO revierte los movimientos históricos ya reclasificados — la spec
// dice "eliminar la regla y devolverlo al panel izquierdo", el historial
// queda en la categoría que se asignó (consistencia retro).
router.delete('/reglas-prov/:id', requirePerm('bancos_reglas_admin'), async (req, res) => {
  try {
    const id = +req.params.id;
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
    // No borrar reglas protegidas (Raba Buildings).
    const r = await one('SELECT protegida FROM ab_reglas_normalizacion WHERE id = $1', [id]);
    if (!r) return res.status(404).json({ error: 'regla no existe' });
    if (r.protegida) return res.status(403).json({ error: 'regla protegida, no se puede borrar' });
    await query('DELETE FROM ab_reglas_normalizacion WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[bancos.reglas-prov.delete]', e);
    res.status(500).json({ error: e.message || 'internal' });
  }
});

module.exports = router;
