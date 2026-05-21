// Reglas de normalización persistidas en ab_reglas_normalizacion.
// Tienen precedencia sobre las reglas hardcodeadas de normalizers.js
// y categorizer.js — se evalúan primero al subir un extracto y al
// agrupar proveedores en /proveedores.
//
// Diseño:
// - loadReglas(client?) carga todas las reglas activas ordenadas por
//   prioridad descendente. Pensado para llamarse UNA VEZ por request
//   (no por fila) y cachear el resultado en memoria local del handler.
// - matchRegla(concepto, reglas) devuelve la primera regla que matchea
//   o null. Soporta tres tipos: ilike (substring case-insensitive),
//   exacto (igualdad case-insensitive) y regex (RegExp con flags 'i').

const { many } = require('../db');

async function loadReglas(client) {
  const sql = `SELECT id, patron, tipo_match, categoria, proveedor_normalizado, prioridad
                 FROM ab_reglas_normalizacion
                WHERE activo = TRUE
                ORDER BY prioridad DESC, id ASC`;
  if (client) {
    const r = await client.query(sql);
    return r.rows;
  }
  return many(sql);
}

function compileRegla(r) {
  if (r._compiled !== undefined) return r._compiled;
  const tipo = r.tipo_match || 'ilike';
  if (tipo === 'regex') {
    try { r._compiled = new RegExp(r.patron, 'i'); }
    catch (e) { r._compiled = null; }
  } else if (tipo === 'exacto') {
    r._compiled = String(r.patron).toLowerCase();
  } else { // ilike
    r._compiled = String(r.patron).toLowerCase();
  }
  return r._compiled;
}

function matchRegla(concepto, reglas) {
  if (!reglas || !reglas.length) return null;
  const c = String(concepto || '');
  const cLow = c.toLowerCase();
  for (const r of reglas) {
    const re = compileRegla(r);
    if (!re) continue;
    if (r.tipo_match === 'regex') {
      if (re.test(c)) return r;
    } else if (r.tipo_match === 'exacto') {
      if (cLow === re) return r;
    } else {
      if (cLow.includes(re)) return r;
    }
  }
  return null;
}

module.exports = { loadReglas, matchRegla };
