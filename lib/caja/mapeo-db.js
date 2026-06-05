// Mapeo persistente subtipo libre (caja) → categoría canónica banco.
// Lee la tabla ab_caja_mapeo_subtipos (seedeada en migration 27) con
// cache in-memory (TTL 60s) y la invalida cuando el endpoint PUT
// guarda cambios.
//
// Fallback: si la tabla está vacía o falla la consulta, recae en los
// patrones hardcoded de lib/caja/mapeo-categorias.js. Esto garantiza
// continuidad operativa si la tabla queda en blanco accidentalmente.
//
// API:
//   await loadMapeos()          → array de reglas activas, ordenadas
//   categoriaDeSubtipoCajaDB(s) → categoría destino (sincrono, usa cache)
//   invalidateMapeosCache()     → fuerza recarga en próxima llamada

const { many } = require('../db');
const { categoriaDeSubtipoCaja: fallbackCategoria } = require('./mapeo-categorias');

const CACHE_TTL_MS = 60_000;
let _cache = null;        // array de reglas compiladas
let _cacheUntil = 0;
let _loading = null;      // promise para evitar thundering herd

// Compila una fila DB en regla evaluable. Para regex, pre-compila el
// RegExp (ahorra ~10x por movimiento). Si el patrón es inválido,
// loguea y la regla se descarta para esa consulta.
function compileRule(row) {
  const base = {
    id: row.id,
    patron: row.patron,
    tipo_match: row.tipo_match,
    prioridad: row.prioridad,
    categoria_destino: row.categoria_destino,
    notas: row.notas,
    autor: row.autor,
    activa: row.activa,
  };
  if (row.tipo_match === 'regex') {
    try {
      base._rx = new RegExp(row.patron, 'i');
    } catch (e) {
      console.warn(`[mapeo-db] regex inválido id=${row.id} patron=${row.patron}: ${e.message}`);
      base._rx = null;
    }
  } else if (row.tipo_match === 'exact') {
    base._normalized = String(row.patron || '').trim().toLowerCase();
  } else if (row.tipo_match === 'prefix') {
    base._normalized = String(row.patron || '').trim().toLowerCase();
  }
  return base;
}

async function _fetchFromDB() {
  const rows = await many(
    `SELECT id, patron, tipo_match, prioridad, categoria_destino,
            notas, autor, activa
       FROM ab_caja_mapeo_subtipos
      WHERE activa = TRUE
      ORDER BY prioridad DESC, id ASC`,
    []
  );
  return rows.map(compileRule);
}

async function loadMapeos() {
  const now = Date.now ? Date.now() : new Date().getTime();
  if (_cache && now < _cacheUntil) return _cache;
  if (_loading) return _loading;
  _loading = (async () => {
    try {
      const rules = await _fetchFromDB();
      _cache = rules;
      _cacheUntil = (Date.now ? Date.now() : new Date().getTime()) + CACHE_TTL_MS;
      return rules;
    } catch (e) {
      console.error('[mapeo-db] load falló, recurrir a fallback:', e.message);
      _cache = []; // fuerza fallback
      _cacheUntil = (Date.now ? Date.now() : new Date().getTime()) + 5_000;
      return _cache;
    } finally {
      _loading = null;
    }
  })();
  return _loading;
}

function invalidateMapeosCache() {
  _cache = null;
  _cacheUntil = 0;
}

// Evalúa una regla compilada contra el subtipo normalizado.
function matchRule(rule, s, sLower) {
  if (rule.tipo_match === 'regex') {
    return rule._rx ? rule._rx.test(s) : false;
  }
  if (rule.tipo_match === 'exact') {
    return sLower === rule._normalized;
  }
  if (rule.tipo_match === 'prefix') {
    return sLower.startsWith(rule._normalized);
  }
  return false;
}

// Versión async: garantiza que la cache esté cargada antes de evaluar.
// Usar desde endpoints que ya son async/await.
async function categoriaDeSubtipoCajaAsync(subtipo) {
  const s = String(subtipo || '').trim();
  if (!s) return 'SIN_CATEGORIA_CAJA';
  const rules = await loadMapeos();
  if (rules.length === 0) return fallbackCategoria(subtipo);
  const sLower = s.toLowerCase();
  for (const r of rules) {
    if (matchRule(r, s, sLower)) return r.categoria_destino;
  }
  return 'SIN_CATEGORIA_CAJA';
}

// Versión sincrona: úsala dentro de loops sobre filas ya cargadas.
// Asume que loadMapeos() ya fue awaited al menos una vez.
function categoriaDeSubtipoCajaSync(subtipo, rulesOverride) {
  const s = String(subtipo || '').trim();
  if (!s) return 'SIN_CATEGORIA_CAJA';
  const rules = rulesOverride || _cache;
  if (!rules || rules.length === 0) return fallbackCategoria(subtipo);
  const sLower = s.toLowerCase();
  for (const r of rules) {
    if (matchRule(r, s, sLower)) return r.categoria_destino;
  }
  return 'SIN_CATEGORIA_CAJA';
}

module.exports = {
  loadMapeos,
  invalidateMapeosCache,
  categoriaDeSubtipoCajaAsync,
  categoriaDeSubtipoCajaSync,
};
