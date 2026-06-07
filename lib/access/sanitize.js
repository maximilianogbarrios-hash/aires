// Capa central de control de acceso a datos sensibles.
//
// Reglas:
//   1) BLOQUEO de la categoría GASTOS_DIRECCION (y subcategorías
//      históricamente fusionadas en el mismo bucket: NOMINAS_DIRECCION,
//      PRESTAMOS) para usuarios que NO son esAdminLike. La cat se
//      EXCLUYE por completo de la respuesta — ni etiqueta, ni monto,
//      ni slice, ni %.
//
//   2) ENMASCARADO de Raba Buildings: cualquier string visible que
//      matchee el patrón Raba se reemplaza por la cadena fija
//      RABA_MASK. Defense in depth — aunque el row escape al filtrado
//      categórico, el nombre nunca aparece literal para no-admins.
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

// Categorías sensibles bloqueadas para no-admin. GASTOS_DIRECCION es la
// principal; NOMINAS_DIRECCION y PRESTAMOS ya estaban históricamente
// fusionadas en el mismo bucket "Gastos Dirección" en /bancos — se
// mantienen aquí para consistencia con CATEGORIAS_DIRECCION_FUSE de
// routes/bancos.js. Si en el futuro se quiere desacoplar, basta editar
// este Set.
const SENSITIVE_CATEGORIES = new Set([
  'GASTOS_DIRECCION', 'NOMINAS_DIRECCION', 'PRESTAMOS',
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

// Detecta si un objeto del payload representa una "entrada de categoría
// sensible" que debe filtrarse completo del array contenedor.
// Mira las keys conocidas que identifican una categoría/proveedor.
function objEsEntradaSensible(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  if (esCategoriaSensible(o.codigo)) return true;
  if (esCategoriaSensible(o.categoria)) return true;
  // El proveedor fusionado "Gastos Dirección" se trata como sensible
  // en el donut/listas — refleja al mismo bucket pero por nombre de
  // proveedor en vez de código.
  if (o.proveedor === FUSE_PROVEEDOR) return true;
  if (o.proveedor_normalizado === FUSE_PROVEEDOR) return true;
  if (o.proveedor_resuelto === FUSE_PROVEEDOR) return true;
  if (o.grupo === FUSE_PROVEEDOR) return true;
  if (o.nombre === FUSE_PROVEEDOR) return true;
  // Objeto descriptor del fuse: { nombre, miembros_codigos: [...] }.
  if (Array.isArray(o.miembros_codigos) && o.miembros_codigos.some(esCategoriaSensible)) return true;
  // Reglas también: si la regla apunta a cat sensible o al fuse.
  if (o.proveedor_normalizado && matchesRaba(o.proveedor_normalizado)) return true;
  return false;
}

// Recorrido recursivo del payload aplicando ambas reglas: filtrado de
// arrays + enmascarado de strings. Mutación in-place (más rápido y
// preserva referencias). Detecta ciclos via WeakSet.
function _walk(node, seen) {
  if (node == null) return node;
  if (typeof node === 'string') return maskRabaString(node);
  if (typeof node !== 'object') return node;
  if (seen.has(node)) return node;
  seen.add(node);
  if (Array.isArray(node)) {
    // Filtrar items que sean entradas sensibles, luego walk al resto.
    for (let i = node.length - 1; i >= 0; i--) {
      if (objEsEntradaSensible(node[i])) node.splice(i, 1);
    }
    for (let i = 0; i < node.length; i++) {
      node[i] = _walk(node[i], seen);
    }
    return node;
  }
  // Objeto plano. Si el objeto MISMO es una entrada sensible (raro
  // pero posible: ej. response = {categoria:'GASTOS_DIRECCION', total: 123}),
  // lo vaciamos sin tirar la respuesta entera para no romper el shape.
  if (objEsEntradaSensible(node)) {
    for (const k of Object.keys(node)) delete node[k];
    return node;
  }
  for (const k of Object.keys(node)) {
    node[k] = _walk(node[k], seen);
  }
  return node;
}

function sanitizeForNonAdmin(payload) {
  if (payload == null) return payload;
  _walk(payload, new WeakSet());
  return payload;
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
      sanitizeForNonAdmin(payload);
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
  objEsEntradaSensible, sanitizeForNonAdmin,
  jsonSanitizerMiddleware,
};
