// Mapeo sucursal (CSV de caja) → sociedad_id (matriz de SOCIEDADES en
// lib/bank/sociedades.js). Las sucursales operativas se asignan a su
// sociedad; las especiales (ESPECIALES, NAVE, OFICINA, etc.) quedan
// como null porque no representan un local operativo.

// Matriz hardcoded — usada SOLO como fallback si la tabla DB
// ab_caja_mapeo_sociedades (migration 28) está vacía o inaccesible.
// En runtime, lo autoritativo es esa tabla; el backfill mantiene
// ab_caja_movimientos.sociedad_id sincronizado con ella.
//
// Bug corregido 2026-06-07: 'CHICKEN ELCHE' apuntaba a 'hostelero'
// (Grupo Hostelero Aires SL) por coincidencia del token "ELCHE", pero
// es Chicken Uncles (Aires Alicante SL).
const SUCURSAL_A_SOCIEDAD = {
  'ELCHE':           'hostelero',
  'CHICKEN ELCHE':   'alicante',
  'CHICKEN UNCLES':  'alicante',
  'ALICANTE':        'alicante',
  'ARENALES':        'alicante',
  'CREVILLENTE':     'alicante',
  'SANTA POLA':      'smart',
  'TORREVIEJA':      'smart',
  'SAN VICENTE':     'smart',
  'SANTO DOMINGO':   'murcia',
  'MURCIA MERCED':   'murcia',
  'ORIHUELA':        'murcia',
  'THADER':          'murcia',
  'CHICKEN THADER':  'murcia',
  'BENIDORM':        'benidorm',
};

// Set de sucursales "especiales" — no son locales operativos sino
// cuentas administrativas / depósitos. Replica el filtro de la columna
// generada `es_especial` en ab_caja_movimientos.
//
// Importante: las claves van en UPPERCASE porque normalizarSucursal
// uppercasea. 'OFICINA' aparece una sola vez (antes había 'Oficina'
// separada — el sistema externo las trata como una sola caja).
const SUCURSALES_ESPECIALES = new Set([
  'ESPECIALES', 'CAJA MAXI Y DANI', 'NAVE', 'NAVE NUEVA',
  'OFICINA', 'OFICINA VERONICA', 'PRODUCCIÓN',
  'IFA', 'TRASTERO', 'MADRID', 'MURCIA NUEVO',
]);

// Normalización del nombre de sucursal: uppercase + trim + colapsar
// espacios. El uppercase unifica casing inconsistente (OFICINA / Oficina
// que el sistema externo "Control de Cajas" reporta como una sola caja).
// NO fusiona cajas legítimamente distintas: NAVE vs NAVE NUEVA y
// MURCIA MERCED vs MURCIA NUEVO se preservan porque difieren en sufijo,
// no en casing.
function normalizarSucursal(s) {
  return String(s || '').trim().replace(/\s+/g, ' ').toUpperCase();
}

function sociedadDeSucursal(sucursal) {
  const norm = normalizarSucursal(sucursal);
  return SUCURSAL_A_SOCIEDAD[norm] || null;
}

function esSucursalEspecial(sucursal) {
  return SUCURSALES_ESPECIALES.has(normalizarSucursal(sucursal));
}

module.exports = {
  SUCURSAL_A_SOCIEDAD,
  SUCURSALES_ESPECIALES,
  normalizarSucursal,
  sociedadDeSucursal,
  esSucursalEspecial,
};
