// Capa central de control de acceso a datos sensibles.
//
// Reglas para usuarios que NO son esAdminLike:
//   1) AGREGADO de GASTOS_DIRECCION y NOMINAS_DIRECCION — VISIBLE con
//      monto y % para que los gráficos cuadren. Mismo número que ven
//      admin/socio. Su detalle (proveedores/movimientos) se VACÍA a
//      [] / null para que el donut sume bien pero no se pueda drillear.
//   2) DETALLE (movimientos individuales) de GASTOS_DIRECCION o
//      NOMINAS_DIRECCION — BLOQUEADO. Cualquier row con
//      concepto/subtipo + importe categorizado en cat sensible se
//      ELIMINA del array contenedor.
//   3) ENMASCARADO de Raba Buildings — cualquier string visible que
//      matchee el patrón Raba se reemplaza por la cadena fija
//      RABA_MASK. Defense in depth — aunque el row escape al filtrado
//      categórico, el nombre nunca aparece literal para no-admins.
//
// PRESTAMOS NO está en este set: es una categoría operativa visible
// para todos los roles con acceso al módulo, agregado y detalle.
// (Estaba acá durante el hardening inicial; se quitó porque rompía la
// visibilidad de préstamos operativos. La fusión en "Gastos Dirección"
// que hace routes/bancos.js#CATEGORIAS_DIRECCION_FUSE es un asunto
// separado del sanitizer.)
//
// Match Raba — word boundary, case-insensitive:
//   /\b(?:raba|buildings?)\b/i
//
// IMPORTANTE: el patrón NO matchea "TRABAJADAS" / "TRABAJO" (en caja
// existen al menos 3 movs con esas palabras — sueldos/jornales — que
// NO son Raba y NO deben enmascararse). Validado contra producción.
//
// Uso:
//   const { jsonSanitizerMiddleware } = require('../lib/access/sanitize');
//   router.use(jsonSanitizerMiddleware);    // antes de los handlers
//
//   o, manualmente en un handler:
//   const { sanitizeForNonAdmin, esAdminLike } = require('...');
//   res.json(esAdminLike(req) ? data : sanitizeForNonAdmin(data));

const RABA_REGEX = /\b(?:raba|buildings?)\b/i;
const RABA_MASK = 'Transferencia a Gastos Dirección';

// Categorías sensibles a nivel sanitizer: el AGREGADO sigue visible
// con monto y % (para que el donut cuadre), pero el DETALLE
// (proveedores, movimientos individuales) se BLOQUEA para no-admin.
//
// Nota: la fusión visual de bancos.js#CATEGORIAS_DIRECCION_FUSE
// (que aún incluye PRESTAMOS) es una capa distinta, controlada en
// routes/bancos.js. Este sanitizer es transversal y NO trata PRESTAMOS
// como sensible — sus movimientos deben fluir intactos para no-admin.
const SENSITIVE_CATEGORIES = new Set([
  'GASTOS_DIRECCION', 'NOMINAS_DIRECCION',
]);

const FUSE_PROVEEDOR = 'Gastos Dirección';

const ROLES_ADMIN_LIKE = new Set(['admin', 'socio']);

function esAdminLike(req) {
  return ROLES_ADMIN_LIKE.has(req?.session?.user?.role);
}

function esCategoriaSensible(codigo) {
  return SENSITIVE_CATEGORIES.has(codigo);
}

function matchesRaba(s) {
  return s != null && RABA_REGEX.test(String(s));
}

function maskRabaString(s) {
  if (typeof s !== 'string') return s;
  if (!RABA_REGEX.test(s)) return s;
  return RABA_MASK;
}

// ─── Distinción AGREGADO vs MOVIMIENTO INDIVIDUAL ────────────────────
// El cambio v2 del control de acceso requiere que los AGREGADOS de
// GASTOS_DIRECCION sigan visibles (monto + %) para no-admin, y SOLO
// se filtren los MOVIMIENTOS INDIVIDUALES (rows con concepto/subtipo +
// importe + id|fecha) — son lo que muestra "detalle".
//
// Heurística: un objeto es movimiento individual si tiene texto libre
// (concepto/subtipo/descripcion) Y un importe numérico. Los agregados
// (por_categoria items, flujo-mensual.categorias items, etc.) carecen
// de texto libre — sólo tienen codigo + total + n_movs.
function esMovimientoIndividual(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  const tieneTexto = typeof o.concepto === 'string'
                   || typeof o.subtipo === 'string'
                   || typeof o.descripcion === 'string';
  const tieneImporte = typeof o.importe === 'number'
                    || typeof o.monto === 'number';
  return tieneTexto && tieneImporte;
}

// Detecta si un movimiento individual cae en categoría sensible o
// Raba/FUSE — debe FILTRARSE del array contenedor para no-admin.
// Agregados (sin texto libre) NO se filtran — siguen visibles con
// monto y % aunque sean sensibles.
function objEsEntradaSensible(o) {
  if (!esMovimientoIndividual(o)) return false;
  if (esCategoriaSensible(o.categoria)) return true;
  if (o.proveedor === FUSE_PROVEEDOR) return true;
  if (o.proveedor_normalizado === FUSE_PROVEEDOR) return true;
  if (o.proveedor_resuelto === FUSE_PROVEEDOR) return true;
  if (o.grupo === FUSE_PROVEEDOR) return true;
  if (o.proveedor_normalizado && matchesRaba(o.proveedor_normalizado)) return true;
  return false;
}

// Keys que SI están en un agregado sensible (por_categoria item con
// codigo=GASTOS_DIRECCION) deben vaciarse — exponen detalle interno.
const DETAIL_KEYS_EN_AGREGADO = new Set([
  'proveedores', 'proveedores_lista', 'top_proveedores',
  'movimientos', 'movs', 'rows', 'items',
  'desglose', 'detalle', 'members', 'miembros',
  // top_banco / top_caja / top_efectivo: usados en /caja/flujo-total
  // para listar top conceptos por categoría — son detalle itemizado.
  // (el shape real del endpoint usa `top_caja`; `top_efectivo` lo
  // dejamos por compat si algún endpoint futuro usa ese nombre).
  'top_banco', 'top_caja', 'top_efectivo',
]);

// ¿Es objeto agregado de categoría sensible? Si sí, vaciar sus keys
// de detalle (proveedores, movimientos, top) y dejar SÓLO el agregado
// (total, n_movs, codigo, nombre_display, pct, ...).
function esAgregadoSensible(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  if (esMovimientoIndividual(o)) return false;
  return esCategoriaSensible(o.codigo)
      || esCategoriaSensible(o.categoria)
      || o.proveedor === FUSE_PROVEEDOR
      || o.nombre === FUSE_PROVEEDOR
      || o.grupo === FUSE_PROVEEDOR;
}

function limpiarDetalleAgregadoSensible(o) {
  for (const k of DETAIL_KEYS_EN_AGREGADO) {
    if (k in o) {
      // Mantener el shape: array → []; otro → null.
      o[k] = Array.isArray(o[k]) ? [] : null;
    }
  }
  // Flag opcional para que el frontend sepa que el drill está bloqueado
  // (independiente de puede_drilldown que también puede setearse en
  // los endpoints). No-op si ya viene seteado.
  if (o.puede_drilldown === undefined) o.puede_drilldown = false;
}

// Recorrido recursivo del payload. Reglas para no-admin:
//   · MOVIMIENTOS INDIVIDUALES sensibles (rows con concepto/subtipo
//     + importe en categoría sensible o Raba/FUSE) → eliminados del
//     array contenedor.
//   · AGREGADOS sensibles (item en por_categoria con codigo sensible) →
//     se mantienen visibles, pero se vacían sus keys de detalle
//     (proveedores[], movimientos[], top_*).
//   · Strings que matcheen Raba → enmascarados a RABA_MASK.
// Mutación in-place. Detecta ciclos via WeakSet.
//
// `kind` declara cómo se interpreta el payload:
//   · 'aggregate' → el endpoint devuelve TOTALES por categoría/grupo.
//     NO filtra items con categoria sensible (deben verse con su monto+%).
//     Igual aplica limpiarDetalleAgregadoSensible para vaciar sub-items
//     de detalle (top_*, proveedores[], movimientos[]).
//   · 'detail' → el endpoint devuelve movimientos individuales / drill.
//     Filtra cualquier item con categoría sensible o Raba (no enumerar).
//   · null/undefined → heurística por forma (esMovimientoIndividual)
//     como respaldo. Endpoints sin etiqueta caen acá.
function _walk(node, seen, kind) {
  if (node == null) return node;
  if (typeof node === 'string') return maskRabaString(node);
  if (typeof node !== 'object') return node;
  if (seen.has(node)) return node;
  seen.add(node);
  if (Array.isArray(node)) {
    // En modo 'aggregate' NO filtramos items por categoría — el agregado
    // debe ser visible. En 'detail' o sin marca, filtramos los items que
    // sean movimientos individuales sensibles (objEsEntradaSensible ya
    // chequea esMovimientoIndividual, así que items agregados no se
    // tocan ni siquiera en 'detail').
    if (kind !== 'aggregate') {
      for (let i = node.length - 1; i >= 0; i--) {
        if (objEsEntradaSensible(node[i])) node.splice(i, 1);
      }
    }
    for (let i = 0; i < node.length; i++) {
      node[i] = _walk(node[i], seen, kind);
    }
    return node;
  }
  // Objeto plano. Sub-items de detalle dentro de cat sensible siempre
  // se vacían — aplica en ambos kinds.
  if (esAgregadoSensible(node)) {
    limpiarDetalleAgregadoSensible(node);
  }
  for (const k of Object.keys(node)) {
    node[k] = _walk(node[k], seen, kind);
  }
  return node;
}

function sanitizeForNonAdmin(payload, kind) {
  if (payload == null) return payload;
  _walk(payload, new WeakSet(), kind);
  return payload;
}

// Factory de middleware: marca explícitamente el endpoint como
// 'aggregate' o 'detail'. La etiqueta vive en req._endpointKind y la
// usa jsonSanitizerMiddleware. Ejemplo:
//
//   router.get('/proveedores', markEndpoint('aggregate'), async (req,res)=>{...});
//   router.get('/movimientos', markEndpoint('detail'),    async (req,res)=>{...});
//
// Sin etiqueta, el sanitizer usa la heurística por forma (esMovimiento-
// Individual). La etiqueta es preferida — declarativa y a prueba de
// futuros shapes que la heurística no anticipe.
function markEndpoint(kind) {
  if (kind !== 'aggregate' && kind !== 'detail') {
    throw new Error("markEndpoint(kind): kind debe ser 'aggregate' o 'detail'");
  }
  return (req, res, next) => { req._endpointKind = kind; next(); };
}

// Express middleware: intercepta res.json y aplica sanitización si el
// usuario no es esAdminLike. Para admin/socio pasa sin tocar.
//
// Fail-closed: si la sanitización tira (bug), devuelve 500 — preferimos
// romper la respuesta a leakear datos sensibles.
function jsonSanitizerMiddleware(req, res, next) {
  if (esAdminLike(req)) return next();
  const origJson = res.json.bind(res);
  res.json = function (payload) {
    try {
      sanitizeForNonAdmin(payload, req._endpointKind);
    } catch (e) {
      console.error('[access.sanitize] error en middleware:', e && e.stack ? e.stack : e);
      return res.status(500).json({ error: 'sanitization error' });
    }
    return origJson(payload);
  };
  return next();
}

module.exports = {
  RABA_REGEX, RABA_MASK,
  SENSITIVE_CATEGORIES, FUSE_PROVEEDOR,
  esAdminLike, esCategoriaSensible,
  matchesRaba, maskRabaString,
  esMovimientoIndividual, objEsEntradaSensible,
  esAgregadoSensible, limpiarDetalleAgregadoSensible,
  sanitizeForNonAdmin, markEndpoint, jsonSanitizerMiddleware,
};
