// /api/v1/mp2/* — Módulo Materia Prima v2 (pedidos por volumen).
// Convive con /api/v1/pedidos/materia-prima (la pestaña original sin tocar).
//
// Modelo:
//   - Cabecera (sociedad + proveedor + semana) + N líneas (producto×cantidad×precio)
//   - Distribución automática a locales según fac_presupuestada
//   - Conciliación 1:N con débitos bancarios
//
// Permisos definidos en lib/roles.js:
//   mp2_view, mp2_w, mp2_avanzado_w, mp2_conciliar_w, mp2_catalogo_w, mp2_delete

const express = require('express');
const { query, one, many, tx } = require('../lib/db');
const { requireAuth, requirePerm } = require('../lib/auth');
const { SOCIEDADES, findSociedad } = require('../lib/bank/sociedades');
const { mondayOfIsoWeek, isoStr, addDays } = require('../lib/iso-weeks');

const router = express.Router();
router.use(requireAuth);
router.use(requirePerm('mp2_view'));

const ESTADOS = ['borrador', 'confirmado', 'recibido', 'facturado', 'pagado'];
const ESTADOS_BASICOS = new Set(['borrador', 'confirmado']);
const ESTADOS_AVANZADOS = new Set(['recibido', 'facturado', 'pagado']);

// Roles helper
const ADMIN_LIKE = new Set(['admin', 'socio']);
function esAdminLike(req) { return ADMIN_LIKE.has(req.session?.user?.role); }
const { hasPerm } = require('../lib/roles');

// Conciliación bancaria es sensible: admin O Dani específicamente
// (rol socio + email exacto). Otros socios futuros NO automático.
const EMAIL_DANI = 'daniel.romeroarmada@gmail.com';
function puedeConciliarMp2(req) {
  const u = req.session?.user;
  if (!u) return false;
  if (u.role === 'admin') return true;
  if (u.role === 'socio' && (u.email || '').toLowerCase() === EMAIL_DANI) return true;
  return false;
}
function requireConciliarMp2(req, res, next) {
  if (!puedeConciliarMp2(req)) {
    return res.status(403).json({ error: 'Conciliación restringida: admin o Dani únicamente' });
  }
  return next();
}

function asNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }

// ─── METADATA ─────────────────────────────────────────────────────────
// Devuelve sociedades + locales + user + flags de permisos del rol actual,
// para que el frontend pinte la UI sin tener que duplicar la matriz.
router.get('/meta', async (req, res) => {
  try {
    const role = req.session?.user?.role;
    res.json({
      sociedades: SOCIEDADES.map((s) => ({ id: s.id, nombre: s.nombre, locales: s.locales })),
      user: { id: req.session.user.id, email: req.session.user.email, role },
      flags: {
        mp2_w:           hasPerm(role, 'mp2_w'),
        mp2_avanzado_w:  hasPerm(role, 'mp2_avanzado_w'),
        // mp2_conciliar_w usa puedeConciliarMp2: admin o Dani específicamente.
        // No basta con hasPerm(role,...) porque la matriz permite a todos
        // los socios; el check fino requiere el email.
        mp2_conciliar_w: puedeConciliarMp2(req),
        mp2_catalogo_w:  hasPerm(role, 'mp2_catalogo_w'),
        mp2_delete:      hasPerm(role, 'mp2_delete'),
      },
    });
  } catch (e) {
    console.error('[mp2.meta]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ─── CATÁLOGO DE PRECIOS ──────────────────────────────────────────────
router.get('/catalogo', async (req, res) => {
  try {
    const proveedor = req.query.proveedor || null;
    const where = ['c.activo = TRUE']; const vals = [];
    if (proveedor) { where.push(`c.proveedor_normalizado = $${vals.length+1}`); vals.push(proveedor); }
    const rows = await many(
      `SELECT c.id, c.proveedor_normalizado, c.producto, c.unidad,
              c.precio_ref::float8 AS precio_ref,
              c.vigente_desde::text AS vigente_desde,
              c.notas_temporada,
              u.email AS actualizado_por_email,
              EXTRACT(DAY FROM NOW() - c.vigente_desde)::int AS dias_desde_actualizacion
         FROM ab_mp_catalogo_precios c
         LEFT JOIN ab_users u ON u.id = c.actualizado_por
        WHERE ${where.join(' AND ')}
        ORDER BY c.proveedor_normalizado, c.producto`,
      vals
    );
    res.json({ catalogo: rows });
  } catch (e) {
    console.error('[mp2.catalogo.get]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// PUT /catalogo  body { proveedor_normalizado, producto, unidad, precio_ref, motivo, notas_temporada }
// Upsert + auditoría. Si cambia el precio, inserta en ab_mp_precios_historico.
router.put('/catalogo', requirePerm('mp2_catalogo_w'), async (req, res) => {
  try {
    const { proveedor_normalizado, producto, unidad, motivo } = req.body || {};
    const precio_ref = asNum(req.body?.precio_ref);
    const notas = req.body?.notas_temporada ?? null;
    if (!proveedor_normalizado || !producto || !unidad || precio_ref == null || precio_ref < 0) {
      return res.status(400).json({ error: 'proveedor, producto, unidad, precio_ref requeridos' });
    }
    const userId = req.session?.user?.id || null;
    const result = await tx(async (client) => {
      const prev = await client.query(
        'SELECT precio_ref::float8 AS p FROM ab_mp_catalogo_precios WHERE proveedor_normalizado=$1 AND producto=$2',
        [proveedor_normalizado, producto]
      );
      const precioAnterior = prev.rows[0]?.p ?? null;
      const r = await client.query(
        `INSERT INTO ab_mp_catalogo_precios
           (proveedor_normalizado, producto, unidad, precio_ref, vigente_desde, actualizado_por, notas_temporada, activo)
         VALUES ($1, $2, $3, $4, CURRENT_DATE, $5, $6, TRUE)
         ON CONFLICT (proveedor_normalizado, producto) DO UPDATE
           SET unidad = EXCLUDED.unidad,
               precio_ref = EXCLUDED.precio_ref,
               vigente_desde = CASE WHEN ab_mp_catalogo_precios.precio_ref <> EXCLUDED.precio_ref
                                    THEN CURRENT_DATE ELSE ab_mp_catalogo_precios.vigente_desde END,
               actualizado_por = EXCLUDED.actualizado_por,
               notas_temporada = EXCLUDED.notas_temporada,
               activo = TRUE
         RETURNING id, precio_ref::float8 AS precio_ref`,
        [proveedor_normalizado, producto, unidad, precio_ref, userId, notas]
      );
      // Auditoría sólo si cambió el precio (o no existía antes).
      if (precioAnterior == null || Math.abs(precioAnterior - precio_ref) > 0.0001) {
        await client.query(
          `INSERT INTO ab_mp_precios_historico
             (proveedor_normalizado, producto, precio_anterior, precio_nuevo, usuario_id, motivo)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [proveedor_normalizado, producto, precioAnterior, precio_ref, userId, motivo || null]
        );
      }
      return r.rows[0];
    });
    res.json({ ok: true, id: result.id, precio_ref: result.precio_ref });
  } catch (e) {
    console.error('[mp2.catalogo.put]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// GET /catalogo/historico?proveedor=&producto=
router.get('/catalogo/historico', async (req, res) => {
  try {
    const proveedor = req.query.proveedor;
    const producto = req.query.producto;
    if (!proveedor || !producto) return res.status(400).json({ error: 'proveedor y producto requeridos' });
    const rows = await many(
      `SELECT h.id, h.precio_anterior::float8 AS precio_anterior,
              h.precio_nuevo::float8 AS precio_nuevo,
              h.fecha, h.motivo, u.email AS usuario_email
         FROM ab_mp_precios_historico h
         LEFT JOIN ab_users u ON u.id = h.usuario_id
        WHERE h.proveedor_normalizado = $1 AND h.producto = $2
        ORDER BY h.fecha DESC`,
      [proveedor, producto]
    );
    res.json({ historico: rows });
  } catch (e) {
    console.error('[mp2.catalogo.hist]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ─── PEDIDOS ──────────────────────────────────────────────────────────
// GET /pedidos?anio=&semana=&sociedad_id=&proveedor=&estado=
router.get('/pedidos', async (req, res) => {
  try {
    const where = []; const vals = [];
    if (req.query.anio)         { where.push(`anio=$${vals.length+1}`); vals.push(+req.query.anio); }
    if (req.query.semana)       { where.push(`semana=$${vals.length+1}`); vals.push(+req.query.semana); }
    if (req.query.sociedad_id)  { where.push(`sociedad_id=$${vals.length+1}`); vals.push(req.query.sociedad_id); }
    if (req.query.proveedor)    { where.push(`proveedor_normalizado=$${vals.length+1}`); vals.push(req.query.proveedor); }
    if (req.query.estado)       { where.push(`estado=$${vals.length+1}`); vals.push(req.query.estado); }
    if (req.query.anio_mes)     {
      // anio_mes='2026-04' → todos los pedidos de ese mes (por semana_lunes)
      const [y, m] = req.query.anio_mes.split('-').map(Number);
      where.push(`fecha_creacion >= make_date($${vals.length+1},$${vals.length+2},1)`);
      vals.push(y, m);
      where.push(`fecha_creacion < (make_date($${vals.length+1},$${vals.length+2},1) + INTERVAL '1 month')`);
      vals.push(y, m);
    }
    const W = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const rows = await many(
      `SELECT c.id, c.semana, c.anio, c.sociedad_id, c.proveedor_normalizado,
              c.estado,
              c.importe_estimado::float8 AS importe_estimado,
              c.importe_real::float8 AS importe_real,
              c.fecha_creacion, c.fecha_confirmacion, c.fecha_pago,
              c.notas, c.movimiento_banco_id,
              c.diferencia_conciliacion::float8 AS diferencia_conciliacion,
              u.email AS usuario_creacion_email,
              (SELECT COUNT(*)::int FROM ab_mp_pedidos_lineas WHERE pedido_id = c.id) AS n_lineas
         FROM ab_mp_pedidos_cabecera c
         LEFT JOIN ab_users u ON u.id = c.usuario_creacion
         ${W}
         ORDER BY c.anio DESC, c.semana DESC, c.id DESC
         LIMIT 500`,
      vals
    );
    res.json({ pedidos: rows });
  } catch (e) {
    console.error('[mp2.pedidos.list]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// GET /pedidos/:id — devuelve cabecera + líneas + distribución.
// Fabricio (rol pedidos) no recibe distribución detallada, sólo el total.
router.get('/pedidos/:id', async (req, res) => {
  try {
    const id = +req.params.id;
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });
    const cab = await one(
      `SELECT c.*, u.email AS usuario_creacion_email,
              c.importe_estimado::float8 AS importe_estimado,
              c.importe_real::float8 AS importe_real,
              c.diferencia_conciliacion::float8 AS diferencia_conciliacion
         FROM ab_mp_pedidos_cabecera c
         LEFT JOIN ab_users u ON u.id = c.usuario_creacion
        WHERE c.id = $1`,
      [id]
    );
    if (!cab) return res.status(404).json({ error: 'pedido no encontrado' });
    const lineas = await many(
      `SELECT id, producto, cantidad::float8 AS cantidad, unidad,
              precio_estimado::float8 AS precio_estimado,
              precio_real::float8 AS precio_real,
              importe_estimado::float8 AS importe_estimado,
              importe_real::float8 AS importe_real, orden
         FROM ab_mp_pedidos_lineas WHERE pedido_id = $1 ORDER BY orden, id`,
      [id]
    );
    let distribucion = null;
    if (hasPerm(req.session?.user?.role, 'mp2_avanzado_w')) {
      distribucion = await many(
        `SELECT local_id, pct_distribucion::float8 AS pct,
                importe_estimado::float8 AS importe_estimado,
                importe_real::float8 AS importe_real
           FROM ab_mp_pedidos_distribucion WHERE pedido_id = $1
          ORDER BY pct_distribucion DESC`,
        [id]
      );
    }
    res.json({ pedido: cab, lineas, distribucion });
  } catch (e) {
    console.error('[mp2.pedidos.get]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// POST /pedidos — crea o actualiza (upsert por id).
// body: { id?, semana, anio, sociedad_id, proveedor_normalizado, notas?, lineas:[{producto,cantidad,unidad,precio_estimado}] }
router.post('/pedidos', requirePerm('mp2_w'), async (req, res) => {
  try {
    const b = req.body || {};
    const id = b.id ? +b.id : null;
    const semana = +b.semana;
    const anio = +b.anio;
    const sociedad_id = b.sociedad_id;
    const proveedor = b.proveedor_normalizado;
    if (!semana || !anio || !sociedad_id || !proveedor) {
      return res.status(400).json({ error: 'semana, anio, sociedad_id, proveedor_normalizado requeridos' });
    }
    if (!findSociedad(sociedad_id)) return res.status(400).json({ error: 'sociedad_id inválido' });
    const lineas = Array.isArray(b.lineas) ? b.lineas : [];
    // Calcular importe estimado
    let totalEst = 0;
    for (const l of lineas) {
      const cant = asNum(l.cantidad);
      const precio = asNum(l.precio_estimado);
      if (cant != null && precio != null) totalEst += cant * precio;
    }
    const userId = req.session?.user?.id;
    const result = await tx(async (client) => {
      let pedidoId = id;
      if (pedidoId) {
        // Verificar permisos de edición: borrador, o avanzado_w para confirmados/etc.
        const cab = await client.query(
          'SELECT estado, usuario_creacion FROM ab_mp_pedidos_cabecera WHERE id=$1',
          [pedidoId]
        );
        if (!cab.rows.length) throw new Error('pedido no encontrado');
        const estado = cab.rows[0].estado;
        const esCreador = cab.rows[0].usuario_creacion === userId;
        if (estado !== 'borrador' && !hasPerm(req.session?.user?.role, 'mp2_avanzado_w')) {
          throw new Error('pedido confirmado: requiere mp2_avanzado_w para editar');
        }
        // Si estado === borrador, sólo creador (rol pedidos) o avanzado lo edita.
        if (estado === 'borrador' && !esCreador && !hasPerm(req.session?.user?.role, 'mp2_avanzado_w')) {
          throw new Error('borrador de otro usuario');
        }
        await client.query(
          `UPDATE ab_mp_pedidos_cabecera
              SET semana=$1, anio=$2, sociedad_id=$3, proveedor_normalizado=$4,
                  notas=$5, importe_estimado=$6
            WHERE id=$7`,
          [semana, anio, sociedad_id, proveedor, b.notas ?? null, round2(totalEst), pedidoId]
        );
        await client.query('DELETE FROM ab_mp_pedidos_lineas WHERE pedido_id=$1', [pedidoId]);
      } else {
        const r = await client.query(
          `INSERT INTO ab_mp_pedidos_cabecera
             (semana, anio, sociedad_id, proveedor_normalizado, estado, importe_estimado, usuario_creacion, notas)
           VALUES ($1, $2, $3, $4, 'borrador', $5, $6, $7)
           RETURNING id`,
          [semana, anio, sociedad_id, proveedor, round2(totalEst), userId, b.notas ?? null]
        );
        pedidoId = r.rows[0].id;
      }
      // Re-insertar líneas
      for (let i = 0; i < lineas.length; i++) {
        const l = lineas[i];
        const cant = asNum(l.cantidad);
        const precio = asNum(l.precio_estimado);
        if (cant == null || cant <= 0) continue;
        const importe = precio != null ? round2(cant * precio) : null;
        await client.query(
          `INSERT INTO ab_mp_pedidos_lineas
             (pedido_id, producto, cantidad, unidad, precio_estimado, importe_estimado, orden)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [pedidoId, l.producto, cant, l.unidad || 'ud', precio, importe, i]
        );
      }
      return pedidoId;
    });
    res.json({ ok: true, id: result, importe_estimado: round2(totalEst) });
  } catch (e) {
    console.error('[mp2.pedidos.post]', e);
    res.status(400).json({ error: e.message || 'internal' });
  }
});

// POST /pedidos/:id/confirmar — calcula distribución y cambia estado.
router.post('/pedidos/:id/confirmar', requirePerm('mp2_w'), async (req, res) => {
  try {
    const id = +req.params.id;
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });
    const result = await tx(async (client) => {
      const cab = await client.query(
        'SELECT * FROM ab_mp_pedidos_cabecera WHERE id=$1 FOR UPDATE',
        [id]
      );
      if (!cab.rows.length) throw new Error('pedido no encontrado');
      const c = cab.rows[0];
      if (c.estado !== 'borrador' && c.estado !== 'confirmado') {
        throw new Error(`no se puede confirmar desde estado "${c.estado}"`);
      }
      // Validaciones
      const lineas = await client.query(
        'SELECT cantidad, precio_estimado FROM ab_mp_pedidos_lineas WHERE pedido_id=$1',
        [id]
      );
      if (!lineas.rows.length) throw new Error('debe tener al menos una línea');
      for (const l of lineas.rows) {
        if (+l.cantidad <= 0) throw new Error('todas las líneas deben tener cantidad > 0');
        if (l.precio_estimado == null) throw new Error('todas las líneas deben tener precio_estimado');
      }
      // Distribución por local según fac_presupuestada del mes actual.
      const soc = findSociedad(c.sociedad_id);
      if (!soc) throw new Error('sociedad_id inválido');
      // Mes del lunes de la semana
      const monday = mondayOfIsoWeek(c.anio, c.semana);
      const mes = monday.getUTCMonth() + 1;
      const anioPres = monday.getUTCFullYear();
      const presRows = await client.query(
        `SELECT local_id, fac_presupuestada::float8 AS fac
           FROM ab_presupuesto
          WHERE anio=$1 AND mes=$2 AND local_id = ANY($3::text[])`,
        [anioPres, mes, soc.locales]
      );
      const presMap = new Map(presRows.rows.map((r) => [r.local_id, +r.fac || 0]));
      const totalFac = soc.locales.reduce((s, l) => s + (presMap.get(l) || 0), 0);
      // Borrar distribución previa
      await client.query('DELETE FROM ab_mp_pedidos_distribucion WHERE pedido_id=$1', [id]);
      const importe = +c.importe_estimado || 0;
      for (const localId of soc.locales) {
        const fac = presMap.get(localId) || 0;
        // Fallback partes iguales si nadie tiene fac_presupuestada
        const pct = totalFac > 0 ? (fac / totalFac) : (1 / soc.locales.length);
        const importeLocal = round2(importe * pct);
        await client.query(
          `INSERT INTO ab_mp_pedidos_distribucion
             (pedido_id, local_id, pct_distribucion, importe_estimado)
           VALUES ($1, $2, $3, $4)`,
          [id, localId, round4(pct), importeLocal]
        );
      }
      await client.query(
        `UPDATE ab_mp_pedidos_cabecera
            SET estado='confirmado', fecha_confirmacion = COALESCE(fecha_confirmacion, NOW())
          WHERE id=$1`,
        [id]
      );
      return { distribuidos: soc.locales.length, total: importe };
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[mp2.pedidos.confirmar]', e);
    res.status(400).json({ error: e.message || 'internal' });
  }
});

// PUT /pedidos/:id/estado — recibido/facturado/pagado (avanzado_w).
router.put('/pedidos/:id/estado', requirePerm('mp2_avanzado_w'), async (req, res) => {
  try {
    const id = +req.params.id;
    const estado = req.body?.estado;
    if (!ESTADOS.includes(estado)) return res.status(400).json({ error: 'estado inválido' });
    const c = await one('SELECT estado FROM ab_mp_pedidos_cabecera WHERE id=$1', [id]);
    if (!c) return res.status(404).json({ error: 'no encontrado' });
    // Reabrir borrador desde confirmado lo puede hacer mp2_avanzado_w (que ya tiene este endpoint).
    await query(
      `UPDATE ab_mp_pedidos_cabecera
          SET estado=$1::varchar(20),
              fecha_pago = CASE WHEN $1::varchar(20)='pagado' THEN COALESCE(fecha_pago, NOW()) ELSE fecha_pago END
        WHERE id=$2::int`,
      [estado, id]
    );
    res.json({ ok: true, estado });
  } catch (e) {
    console.error('[mp2.pedidos.estado]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// PUT /pedidos/:id/lineas/:lineaId — actualizar precio_real, recalcular cascada.
router.put('/pedidos/:id/lineas/:lineaId', requirePerm('mp2_avanzado_w'), async (req, res) => {
  try {
    const pedidoId = +req.params.id;
    const lineaId = +req.params.lineaId;
    const precioReal = asNum(req.body?.precio_real);
    const actualizarCatalogo = !!req.body?.actualizar_catalogo;
    const motivoCatalogo = req.body?.motivo_catalogo || null;
    if (precioReal == null || precioReal < 0) return res.status(400).json({ error: 'precio_real inválido' });
    const result = await tx(async (client) => {
      const linRow = await client.query(
        'SELECT * FROM ab_mp_pedidos_lineas WHERE id=$1 AND pedido_id=$2',
        [lineaId, pedidoId]
      );
      if (!linRow.rows.length) throw new Error('línea no encontrada');
      const lin = linRow.rows[0];
      const cant = +lin.cantidad;
      const importeReal = round2(cant * precioReal);
      await client.query(
        `UPDATE ab_mp_pedidos_lineas SET precio_real=$1, importe_real=$2 WHERE id=$3`,
        [precioReal, importeReal, lineaId]
      );
      // Recalcular cabecera importe_real = SUM(importe_real ?? importe_estimado)
      const sumRow = await client.query(
        `SELECT COALESCE(SUM(COALESCE(importe_real, importe_estimado, 0)), 0)::float8 AS tot
           FROM ab_mp_pedidos_lineas WHERE pedido_id=$1`,
        [pedidoId]
      );
      const totalReal = round2(+sumRow.rows[0].tot);
      await client.query(
        'UPDATE ab_mp_pedidos_cabecera SET importe_real=$1 WHERE id=$2',
        [totalReal, pedidoId]
      );
      // Recalcular distribución importe_real con mismos %.
      const distRows = await client.query(
        'SELECT id, pct_distribucion::float8 AS pct FROM ab_mp_pedidos_distribucion WHERE pedido_id=$1',
        [pedidoId]
      );
      for (const d of distRows.rows) {
        await client.query(
          'UPDATE ab_mp_pedidos_distribucion SET importe_real=$1 WHERE id=$2',
          [round2(totalReal * d.pct), d.id]
        );
      }
      // Si difiere >5% del estimado y el caller pidió actualizar catálogo
      const precioEst = +lin.precio_estimado || 0;
      const desvia = precioEst > 0 ? Math.abs((precioReal - precioEst) / precioEst) : 0;
      let catalogoActualizado = false;
      if (actualizarCatalogo && desvia > 0.05) {
        const cab = await client.query(
          'SELECT proveedor_normalizado FROM ab_mp_pedidos_cabecera WHERE id=$1', [pedidoId]
        );
        const provNorm = cab.rows[0]?.proveedor_normalizado;
        if (provNorm) {
          const prev = await client.query(
            'SELECT precio_ref::float8 AS p FROM ab_mp_catalogo_precios WHERE proveedor_normalizado=$1 AND producto=$2',
            [provNorm, lin.producto]
          );
          const previo = prev.rows[0]?.p ?? null;
          await client.query(
            `INSERT INTO ab_mp_catalogo_precios
               (proveedor_normalizado, producto, unidad, precio_ref, vigente_desde, actualizado_por, notas_temporada, activo)
             VALUES ($1, $2, $3, $4, CURRENT_DATE, $5, $6, TRUE)
             ON CONFLICT (proveedor_normalizado, producto) DO UPDATE
               SET precio_ref = EXCLUDED.precio_ref,
                   vigente_desde = CURRENT_DATE,
                   actualizado_por = EXCLUDED.actualizado_por`,
            [provNorm, lin.producto, lin.unidad, precioReal, req.session?.user?.id || null,
             motivoCatalogo || 'Auto-actualizado desde precio real']
          );
          await client.query(
            `INSERT INTO ab_mp_precios_historico
               (proveedor_normalizado, producto, precio_anterior, precio_nuevo, usuario_id, motivo)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [provNorm, lin.producto, previo, precioReal, req.session?.user?.id || null,
             motivoCatalogo || `Sync desde pedido #${pedidoId}`]
          );
          catalogoActualizado = true;
        }
      }
      return { totalReal, desvia, catalogoActualizado };
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[mp2.pedidos.linea.put]', e);
    res.status(400).json({ error: e.message || 'internal' });
  }
});

// DELETE /pedidos/:id — sólo admin/socio.
router.delete('/pedidos/:id', requirePerm('mp2_delete'), async (req, res) => {
  try {
    const id = +req.params.id;
    const r = await query('DELETE FROM ab_mp_pedidos_cabecera WHERE id=$1', [id]);
    res.json({ ok: true, deleted: r.rowCount });
  } catch (e) {
    console.error('[mp2.pedidos.delete]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ─── SEMÁFORO PRESUPUESTO POR PROVEEDOR ──────────────────────────────
// GET /semaforo?anio_mes=2026-04 → devuelve por proveedor:
//   { proveedor, presupuesto_mes, estimado_mes, pagado_mes, semaforo }
// Calcula presupuesto desde ab_proveedores_mix:
//   presupuesto_proveedor = SUM(local: budget_mp_local_mes * mix.pct/100)
router.get('/semaforo', async (req, res) => {
  try {
    const am = req.query.anio_mes;
    if (!am) return res.status(400).json({ error: 'anio_mes requerido (YYYY-MM)' });
    const [anio, mes] = am.split('-').map(Number);
    // 1) Budget MP por local del mes = fac_presupuestada * pctMP/100
    const cfg = await one("SELECT valor FROM ab_config WHERE clave='pctMP'");
    const pctMP = (+cfg?.valor || 38) / 100;
    const pres = await many(
      'SELECT local_id, fac_presupuestada::float8 AS fac FROM ab_presupuesto WHERE anio=$1 AND mes=$2',
      [anio, mes]
    );
    const budgetMpLocal = new Map();
    for (const p of pres) budgetMpLocal.set(p.local_id, (+p.fac || 0) * pctMP);
    // 2) Mix: % proveedor por local
    const mix = await many(
      'SELECT local_id, proveedor, porcentaje::float8 AS pct FROM ab_proveedores_mix WHERE activo=TRUE'
    );
    const presupuestoProv = new Map();
    for (const m of mix) {
      const b = budgetMpLocal.get(m.local_id) || 0;
      const aporte = b * ((+m.pct || 0) / 100);
      presupuestoProv.set(m.proveedor, (presupuestoProv.get(m.proveedor) || 0) + aporte);
    }
    // 3) Pedidos del mes (semana_lunes en el mes)
    const peds = await many(
      `SELECT proveedor_normalizado, estado,
              importe_estimado::float8 AS est,
              importe_real::float8 AS real_
         FROM ab_mp_pedidos_cabecera
        WHERE EXTRACT(YEAR FROM fecha_creacion) = $1
          AND EXTRACT(MONTH FROM fecha_creacion) = $2`,
      [anio, mes]
    );
    const acumEst = new Map();
    const acumPag = new Map();
    for (const p of peds) {
      acumEst.set(p.proveedor_normalizado, (acumEst.get(p.proveedor_normalizado) || 0) + (+p.est || 0));
      if (p.estado === 'facturado' || p.estado === 'pagado') {
        acumPag.set(p.proveedor_normalizado, (acumPag.get(p.proveedor_normalizado) || 0) + (+p.real_ || +p.est || 0));
      }
    }
    const todos = new Set([...presupuestoProv.keys(), ...acumEst.keys()]);
    const out = [];
    for (const prov of todos) {
      const presup = presupuestoProv.get(prov) || 0;
      const est = acumEst.get(prov) || 0;
      const pag = acumPag.get(prov) || 0;
      let sem = 'sin_dato';
      if (presup > 0) {
        const desv = Math.abs((est - presup) / presup);
        sem = desv <= 0.10 ? 'verde' : desv <= 0.20 ? 'amarillo' : 'rojo';
      }
      out.push({
        proveedor: prov,
        presupuesto_mes: round2(presup),
        estimado_mes: round2(est),
        pagado_mes: round2(pag),
        semaforo: sem,
      });
    }
    out.sort((a, b) => b.estimado_mes - a.estimado_mes);
    res.json({ anio, mes, proveedores: out });
  } catch (e) {
    console.error('[mp2.semaforo]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ─── BUDGET MP POR SEMANA + POR PROVEEDOR ───────────────────────────
// GET /budget-semana?anio=&semana=&sociedad_id?
// Calcula:
//   - total_budget_mp: budget MP de la semana (Σ por local: fac_estim_semana × pctMP)
//   - por_proveedor: budget MP por proveedor en esa semana usando el mix activo
// Útil para:
//   (a) KPI "Budget MP semana" en el header (acumulado pedidos vs budget total)
//   (b) Aviso naranja cuando la suma de pedidos a un proveedor en la semana
//       supera su budget asignado (multiples pedidos al mismo proveedor).
router.get('/budget-semana', async (req, res) => {
  try {
    const anio = +req.query.anio;
    const semana = +req.query.semana;
    if (!anio || !semana) return res.status(400).json({ error: 'anio y semana requeridos' });
    const socFiltro = req.query.sociedad_id || null;

    // Locales a considerar (filtrados por sociedad si vino).
    let localIds;
    if (socFiltro) {
      const soc = findSociedad(socFiltro);
      if (!soc) return res.status(400).json({ error: 'sociedad_id inválido' });
      localIds = soc.locales;
    } else {
      const allLoc = await many('SELECT id FROM ab_locales');
      localIds = allLoc.map((l) => l.id);
    }
    if (!localIds.length) return res.json({ anio, semana, total_budget_mp: 0, por_proveedor: {} });

    // pctMP desde config.
    const cfg = await one("SELECT valor FROM ab_config WHERE clave='pctMP'");
    const pctMP = (+cfg?.valor || 38) / 100;

    // Días de la semana ISO repartidos por mes (la semana puede tocar dos meses).
    const monday = mondayOfIsoWeek(anio, semana);
    const monthDays = new Map();
    for (let i = 0; i < 7; i++) {
      const day = new Date(monday); day.setUTCDate(day.getUTCDate() + i);
      const k = `${day.getUTCFullYear()}-${day.getUTCMonth() + 1}`;
      monthDays.set(k, (monthDays.get(k) || 0) + 1);
    }
    const pairs = [...monthDays.keys()].map((k) => k.split('-').map(Number));
    const placeholders = pairs.map((_, i) => `($${i * 2 + 2}, $${i * 2 + 3})`).join(',');
    const presRows = await many(
      `SELECT local_id, anio, mes, fac_presupuestada::float8 AS fac
         FROM ab_presupuesto
        WHERE local_id = ANY($1::text[])
          AND (anio, mes) IN (${placeholders})`,
      [localIds, ...pairs.flat()]
    );
    const presMap = new Map();
    for (const r of presRows) presMap.set(`${r.local_id}|${r.anio}|${r.mes}`, +r.fac || 0);

    // Fac semana por local = Σ fac_mes × (días_en_semana / días_del_mes).
    const facSem = new Map();
    for (const lid of localIds) {
      let fs = 0;
      for (const [k, dias] of monthDays.entries()) {
        const [a, mm] = k.split('-').map(Number);
        const fac = presMap.get(`${lid}|${a}|${mm}`) || 0;
        const last = new Date(Date.UTC(a, mm, 0)).getUTCDate();
        fs += fac * (dias / last);
      }
      facSem.set(lid, fs);
    }
    const totalBudgetMp = [...facSem.values()].reduce((s, v) => s + v * pctMP, 0);

    // Mix activo por local → reparto por proveedor.
    const mix = await many(
      `SELECT local_id, proveedor, porcentaje::float8 AS pct
         FROM ab_proveedores_mix
        WHERE activo = TRUE AND local_id = ANY($1::text[])`,
      [localIds]
    );
    const porProv = {};
    for (const m of mix) {
      const b = (facSem.get(m.local_id) || 0) * pctMP;
      const aporte = b * ((+m.pct || 0) / 100);
      porProv[m.proveedor] = (porProv[m.proveedor] || 0) + aporte;
    }
    for (const k of Object.keys(porProv)) porProv[k] = round2(porProv[k]);

    res.json({
      anio, semana,
      total_budget_mp: round2(totalBudgetMp),
      por_proveedor: porProv,
    });
  } catch (e) {
    console.error('[mp2.budget-semana]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ─── KPIs cabecera (vista lista) ─────────────────────────────────────
// GET /kpis?anio=&semana=&anio_mes=
router.get('/kpis', async (req, res) => {
  try {
    const anio = +req.query.anio;
    const semana = +req.query.semana;
    const am = req.query.anio_mes;
    const k = { confirmados: 0, borradores: 0, estimado_semana: 0, real_pagado_mes: 0 };
    if (anio && semana) {
      const r = await one(
        `SELECT
           SUM(CASE WHEN estado='confirmado' THEN 1 ELSE 0 END)::int AS conf,
           SUM(CASE WHEN estado='borrador'   THEN 1 ELSE 0 END)::int AS borr,
           COALESCE(SUM(importe_estimado), 0)::float8 AS est
         FROM ab_mp_pedidos_cabecera WHERE anio=$1 AND semana=$2`,
        [anio, semana]
      );
      k.confirmados = r.conf || 0;
      k.borradores = r.borr || 0;
      k.estimado_semana = round2(+r.est || 0);
    }
    if (am) {
      const [y, m] = am.split('-').map(Number);
      const r2 = await one(
        `SELECT COALESCE(SUM(COALESCE(importe_real, importe_estimado, 0)), 0)::float8 AS tot
           FROM ab_mp_pedidos_cabecera
          WHERE estado='pagado'
            AND EXTRACT(YEAR FROM fecha_pago) = $1
            AND EXTRACT(MONTH FROM fecha_pago) = $2`,
        [y, m]
      );
      k.real_pagado_mes = round2(+r2.tot || 0);
    }
    res.json({ kpis: k });
  } catch (e) {
    console.error('[mp2.kpis]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ─── CONCILIACIÓN BANCO ──────────────────────────────────────────────
// GET /conciliacion/debitos?anio=&mes=&sociedad_id=&proveedor=
// Devuelve movimientos bancarios (importe < 0) sin pedido vinculado en MP v2.
// Heurística simple: subcategoria coincide con proveedor_normalizado o
// el proveedor_normalizado del mov matchea con uno de los pedidos.
router.get('/conciliacion/debitos', requireConciliarMp2, async (req, res) => {
  try {
    const anio = +req.query.anio;
    const mes = +req.query.mes;
    if (!anio || !mes) return res.status(400).json({ error: 'anio y mes requeridos' });
    const where = ['m.importe < 0'];
    const vals = [anio, mes];
    where.push(`EXTRACT(YEAR FROM m.fecha)=$1 AND EXTRACT(MONTH FROM m.fecha)=$2`);
    if (req.query.sociedad_id) { where.push(`m.sociedad_id=$${vals.length+1}`); vals.push(req.query.sociedad_id); }
    if (req.query.proveedor)   { where.push(`m.proveedor_normalizado=$${vals.length+1}`); vals.push(req.query.proveedor); }
    // Excluimos los que ya están conciliados a algún pedido MP v2.
    where.push(`NOT EXISTS (SELECT 1 FROM ab_mp_pedidos_cabecera WHERE movimiento_banco_id = m.id)`);
    const rows = await many(
      `SELECT m.id, m.fecha::text AS fecha, m.concepto, m.sociedad_id,
              m.proveedor_normalizado, m.categoria,
              m.importe::float8 AS importe
         FROM ab_movimientos m
        WHERE ${where.join(' AND ')}
        ORDER BY m.fecha DESC
        LIMIT 200`,
      vals
    );
    res.json({ debitos: rows });
  } catch (e) {
    console.error('[mp2.conciliacion.debitos]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// GET /conciliacion/pendientes?proveedor=&sociedad_id=
// Pedidos confirmados/facturados sin movimiento_banco_id.
router.get('/conciliacion/pendientes', requireConciliarMp2, async (req, res) => {
  try {
    const where = [`estado IN ('confirmado','recibido','facturado')`, `movimiento_banco_id IS NULL`];
    const vals = [];
    if (req.query.proveedor)   { where.push(`proveedor_normalizado=$${vals.length+1}`); vals.push(req.query.proveedor); }
    if (req.query.sociedad_id) { where.push(`sociedad_id=$${vals.length+1}`); vals.push(req.query.sociedad_id); }
    const rows = await many(
      `SELECT id, semana, anio, sociedad_id, proveedor_normalizado, estado,
              importe_estimado::float8 AS importe_estimado,
              importe_real::float8 AS importe_real,
              fecha_creacion
         FROM ab_mp_pedidos_cabecera
        WHERE ${where.join(' AND ')}
        ORDER BY anio DESC, semana DESC, id DESC
        LIMIT 100`,
      vals
    );
    res.json({ pedidos: rows });
  } catch (e) {
    console.error('[mp2.conciliacion.pendientes]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// POST /conciliacion — body { movimiento_id, pedido_ids:[], nota? }
// Marca los pedidos como pagados, asigna movimiento_banco_id y registra
// diferencia (suma pedidos vs importe del débito).
router.post('/conciliacion', requireConciliarMp2, async (req, res) => {
  try {
    const movId = +req.body?.movimiento_id;
    const pedidoIds = Array.isArray(req.body?.pedido_ids) ? req.body.pedido_ids.map(Number).filter(Number.isFinite) : [];
    const nota = req.body?.nota || null;
    if (!movId || !pedidoIds.length) return res.status(400).json({ error: 'movimiento_id y pedido_ids[] requeridos' });
    const result = await tx(async (client) => {
      const mov = await client.query('SELECT importe::float8 AS imp FROM ab_movimientos WHERE id=$1', [movId]);
      if (!mov.rows.length) throw new Error('movimiento no encontrado');
      const impBanco = Math.abs(+mov.rows[0].imp);
      const peds = await client.query(
        `SELECT id, COALESCE(importe_real, importe_estimado, 0)::float8 AS imp
           FROM ab_mp_pedidos_cabecera WHERE id = ANY($1::int[])`,
        [pedidoIds]
      );
      const sumPed = peds.rows.reduce((s, p) => s + +p.imp, 0);
      const diferencia = round2(impBanco - sumPed);
      if (Math.abs(diferencia) > 0.01 && !nota) {
        throw new Error(`Diferencia ${diferencia.toFixed(2)}€ — nota obligatoria`);
      }
      await client.query(
        `UPDATE ab_mp_pedidos_cabecera
            SET movimiento_banco_id=$1,
                estado='pagado',
                fecha_pago = COALESCE(fecha_pago, NOW()),
                diferencia_conciliacion=$2,
                nota_conciliacion=$3
          WHERE id = ANY($4::int[])`,
        [movId, diferencia, nota, pedidoIds]
      );
      return { conciliados: pedidoIds.length, importe_banco: impBanco, suma_pedidos: round2(sumPed), diferencia };
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[mp2.conciliacion.post]', e);
    res.status(400).json({ error: e.message || 'internal' });
  }
});

// ─── VISTA RESUMEN (grid local × proveedor read-only) ────────────────
// GET /resumen?anio=&semana= → genera grilla a partir de distribución.
router.get('/resumen', async (req, res) => {
  try {
    const anio = +req.query.anio;
    const semana = +req.query.semana;
    if (!anio || !semana) return res.status(400).json({ error: 'anio y semana requeridos' });
    const rows = await many(
      `SELECT d.local_id, c.proveedor_normalizado AS proveedor,
              SUM(d.importe_estimado)::float8 AS est,
              SUM(d.importe_real)::float8 AS real_
         FROM ab_mp_pedidos_distribucion d
         JOIN ab_mp_pedidos_cabecera c ON c.id = d.pedido_id
        WHERE c.anio=$1 AND c.semana=$2 AND c.estado <> 'borrador'
        GROUP BY d.local_id, c.proveedor_normalizado
        ORDER BY d.local_id, c.proveedor_normalizado`,
      [anio, semana]
    );
    res.json({ rows });
  } catch (e) {
    console.error('[mp2.resumen]', e);
    res.status(500).json({ error: 'internal' });
  }
});

module.exports = router;
