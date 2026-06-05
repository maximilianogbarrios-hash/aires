// Derivación del "proveedor canónico" para movimientos de caja.
// ab_caja_movimientos no tiene campo proveedor — se reconstruye desde
// el `subtipo` (texto libre) aplicando normalizaciones para colapsar
// variantes (mayúsculas, fechas mes/año, espacios).
//
// Decisiones de normalización:
//  - "SUELDOS MES 05 2026" / "SUELDOS MES 04/2025" / "sueldos mes 10/2025"
//    → "Sueldos" (colapsa todas las nóminas mensuales en un proveedor)
//  - "PAGO SUELDOS MES 03 2026" → "Sueldos"
//  - "PAGO MARIUS" / "PAGO CRISTIAN" → "Marius" / "Cristian"
//  - "HONORARIOS FRAN 03 2026" → "Honorarios Fran"
//  - "Prorrateo desde ESPECIALES" → "Prorrateo desde Especiales" (preserva
//    el origen porque es informativo a nivel auditoría)
//  - "CIERRE" / "cierre" → "Cierre caja diario"
//  - Trim, colapsar espacios, capitalizar (excepto siglas conocidas).
//  - Si el subtipo está vacío/null → "Efectivo (sin proveedor)"

const SIGLAS = new Set(['SL', 'SLU', 'SA', 'SAU', 'SC', 'CB', 'IVA', 'SS']);

function _titleCase(s) {
  return s.split(/\s+/).map((w) => {
    const u = w.replace(/[.,;]/g, '').toUpperCase();
    if (SIGLAS.has(u)) return u;
    if (!w) return w;
    return w[0].toUpperCase() + w.slice(1).toLowerCase();
  }).join(' ');
}

// Patrones que reducen el subtipo a su proveedor canónico ANTES del
// title-case. El primero que matchea gana — orden por especificidad.
const PATRONES = [
  // Sueldos en todas sus variantes — siempre colapsan a "Sueldos".
  // Cubre: "SUELDOS", "PAGO SUELDOS", "SUELDOS MES 05 2026",
  // "sueldos mes 10/2025", "PAGOS SUELDOS MES 03 2026".
  { rx: /^(pagos?\s+)?(sueld(?:o|os)?|n[oó]minas?)(\s.*)?$/i,                       canonico: 'Sueldos' },
  // Honorarios — colapsa fecha pero mantiene a quién.
  { rx: /^honorarios?\s+([a-zà-ÿ]+)(\s+\d.*)?$/i,                                  canonico: (m) => 'Honorarios ' + _titleCase(m[1]) },
  // Cierre/CIERRE diario.
  { rx: /^cierres?\s*$/i,                                                          canonico: 'Cierre caja diario' },
  // Prorrateos — preserva origen para auditoría.
  { rx: /^prorrateo\s+desde\s+(.+)$/i,                                             canonico: (m) => 'Prorrateo desde ' + _titleCase(m[1]) },
  // Pagos a personas: "PAGO MARIUS" → "Marius". Hasta 2 palabras.
  { rx: /^pago\s+([a-zà-ÿ]+(?:\s+[a-zà-ÿ]+)?)\s*$/i,                              canonico: (m) => _titleCase(m[1]) },
  // Liquidaciones finales.
  { rx: /^liq\.?\s*final\s+(.+)$/i,                                                canonico: (m) => 'Liquidación final ' + _titleCase(m[1]) },
  // Asesoría / consultoría con nombre.
  { rx: /^asesor[ií]a\s+([a-zà-ÿ]+).*$/i,                                          canonico: (m) => 'Asesoría ' + _titleCase(m[1]) },
];

function proveedorDeCaja(subtipo) {
  const s = String(subtipo || '').trim().replace(/\s+/g, ' ');
  if (!s) return 'Efectivo (sin proveedor)';
  for (const p of PATRONES) {
    const m = p.rx.exec(s);
    if (m) {
      return typeof p.canonico === 'function' ? p.canonico(m) : p.canonico;
    }
  }
  // Fallback: title-case del subtipo crudo.
  return _titleCase(s);
}

// Detección de traspasos internos caja↔banco. Devuelve true cuando el
// mov es trazabilidad interna (no gasto ni ingreso operativo real).
// Patrones DEFENSIVOS — en la data actual prácticamente no aparecen,
// pero esto deja la infraestructura armada para el caso futuro.
function esTraspasoInternoCaja(subtipo, observaciones) {
  const s = String(subtipo || '').toLowerCase();
  const o = String(observaciones || '').toLowerCase();
  return (
    /traspaso\s+a\s+(cuenta|banco)/.test(s) ||
    /dep[oó]sito\s+(en\s+)?banco/.test(s) ||
    /ingreso\s+banco|ingreso\s+en\s+(cuenta|ventanilla)/.test(s) ||
    /\bcuenta\s+\d{3,}/.test(s) ||  // "CUENTA 2374 KLT" — depósito a cuenta numérica
    /traspaso\s+(efectivo\s+)?a\s+banco/.test(o)
  );
}

function esTraspasoInternoBanco(concepto) {
  const c = String(concepto || '').toLowerCase();
  return (
    /ingreso\s+efectivo|ingreso\s+en\s+ventanilla|ingreso\s+ventanilla/.test(c) ||
    /dep[oó]sito\s+efectivo/.test(c) ||
    /entrada\s+efectivo\s+oficina/.test(c)
  );
}

module.exports = { proveedorDeCaja, esTraspasoInternoCaja, esTraspasoInternoBanco };
