// Mapeo sucursal (CSV de caja) → sociedad_id (matriz de SOCIEDADES en
// lib/bank/sociedades.js). Las sucursales operativas se asignan a su
// sociedad; las especiales (ESPECIALES, NAVE, OFICINA, etc.) quedan
// como null porque no representan un local operativo.

const SUCURSAL_A_SOCIEDAD = {
  'ELCHE':           'hostelero',
  'CHICKEN ELCHE':   'hostelero',
  'ALICANTE':        'alicante',
  'ARENALES':        'alicante',
  'CREVILLENTE':     'alicante',
  'CHICKEN UNCLES':  'alicante',
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
const SUCURSALES_ESPECIALES = new Set([
  'ESPECIALES', 'CAJA MAXI Y DANI', 'NAVE', 'NAVE NUEVA',
  'OFICINA', 'Oficina', 'OFICINA VERONICA', 'PRODUCCIÓN',
  'IFA', 'TRASTERO', 'MADRID', 'MURCIA NUEVO',
]);

// Normalización del nombre de sucursal: trim + colapsar espacios.
// El uppercase NO se aplica porque hay variantes con casing distinto
// (`OFICINA` vs `Oficina`) que el set SUCURSALES_ESPECIALES distingue.
function normalizarSucursal(s) {
  return String(s || '').trim().replace(/\s+/g, ' ');
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
