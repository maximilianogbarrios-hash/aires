// Normalización de conceptos bancarios → nombre canónico de proveedor.
// Reglas en orden: la primera que matchee gana.

// Sociedades del grupo: cualquier movimiento que mencione a alguna de
// estas razones sociales se considera transferencia interna y se EXCLUYE
// del análisis de gasto. DON HAMGUS NO está en este grupo (proveedor
// externo según indicación del usuario).
const INTRA_GRUPO_KEYWORDS = [
  'Aires Burger Bar Murcia',
  'Aires Burger Bar Benidorm',
  'Aires Alicante',
  'Smart Aires',
  'Grupo Hostelero Aires',
  'Aires Murcia',
  'Aires Benidorm',
];

function esIntraGrupo(concepto) {
  const c = String(concepto || '').toLowerCase();
  return INTRA_GRUPO_KEYWORDS.some((kw) => c.includes(kw.toLowerCase()));
}

const STOP_LOW = new Set(['de', 'del', 'el', 'la', 'los', 'las', 'y', 'a', 'en', 'al', 'para', 'por']);

function titleCaseKeepSuffix(s) {
  const SUFIJOS = new Set(['SL', 'SLU', 'SA', 'SAU', 'SCOOP', 'SC', 'CB', 'GMBH', 'LTD', 'INC']);
  return String(s).trim().replace(/\s+/g, ' ').split(' ').map((w, i) => {
    const up = w.replace(/\./g, '').toUpperCase();
    const lo = w.toLowerCase();
    if (SUFIJOS.has(up)) return w.toUpperCase();
    if (i > 0 && STOP_LOW.has(lo)) return lo;
    if (w.length <= 2) return w.toUpperCase();
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(' ');
}

// Reglas específicas por palabra clave. Se aplican antes que el parsing
// genérico de TRANSFERENCIA / COMPRA / Recibo.
const PROVEEDORES_KEYWORDS = [
  { re: /tgss/i,                              proveedor: 'TGSS',                  categoria: 'GASTO_SS_TGSS' },
  { re: /(aeat|abonare|imp\. sociedades|irpf|^impuestos\b|domiciliacion impuesto)/i, proveedor: 'AEAT - Impuestos', categoria: 'GASTO_HACIENDA' },
  { re: /iberdrola/i,                         proveedor: 'Iberdrola',             categoria: 'GASTO_LUZ' },
  { re: /leroy merlin/i,                      proveedor: 'Leroy Merlin',          categoria: 'GASTO_OTROS' },
  { re: /eurofrits/i,                         proveedor: 'Eurofrits SA',          categoria: 'GASTO_EUROFRITS' },
  { re: /ggm gastro/i,                        proveedor: 'GGM Gastro GmbH',       categoria: 'GASTO_OTROS' },
  { re: /brioche de juanito/i,                proveedor: 'El Brioche de Juanito SL', categoria: 'GASTO_OTROS' },
  { re: /conduce revel/i,                     proveedor: 'Conduce Revel SL',      categoria: 'GASTO_OTROS' },
  { re: /liquidacion periodica prestamo/i,    proveedor: 'Banco - Préstamos',     categoria: 'GASTO_OTROS' },
  { re: /don ha[mn]gus/i,                     proveedor: 'Don Hamgus SL',         categoria: 'GASTO_HANGUS' },
  { re: /carnicas garcia/i,                   proveedor: 'Carnicas Garcia SL',    categoria: 'GASTO_CARNICAS' },
  { re: /coca[- ]?cola/i,                     proveedor: 'Coca-Cola Europacific Partners Iberia', categoria: 'GASTO_COCA_COLA' },
  { re: /carnicas mulas/i,                    proveedor: 'Carnicas Mulas SL',     categoria: 'GASTO_CARNICAS' },
  { re: /makro/i,                             proveedor: 'Makro',                 categoria: 'GASTO_MAKRO' },
  { re: /distribuciones batoy/i,              proveedor: 'Distribuciones Batoy',  categoria: 'GASTO_DISTRIBUCIONES_BATOY' },
  { re: /europastry/i,                        proveedor: 'Europastry SA',         categoria: 'GASTO_OTROS' },
];

function limpiarSufijoLegal(s) {
  return String(s)
    .replace(/[,.]+$/, '')
    .replace(/\s+(S\.\s*L\.|S\.\s*A\.|S\.\s*L\.\s*U\.|S\.\s*A\.\s*U\.)\s*$/i, (m) => ' ' + m.trim().replace(/\./g, '').toUpperCase())
    .trim();
}

function normalizarProveedor(concepto, categoriaOriginal) {
  const c = String(concepto || '').trim();
  if (!c) return { proveedor: 'Sin descripción', categoria: categoriaOriginal || 'GASTO_OTROS' };

  // Reglas por palabra clave.
  for (const rule of PROVEEDORES_KEYWORDS) {
    if (rule.re.test(c)) return { proveedor: rule.proveedor, categoria: rule.categoria };
  }

  // Familia TRANSFERENCIA: prioriza "A Favor De X" (acepta "Inmediata"
  // u otro adjetivo entre Transferencia y A) sobre "A X".
  let m = /A\s+Favor\s+De\s+(.+?)(?:\s+Concepto|\s+Nº\s+|\s+Ref\.|$)/i.exec(c);
  if (m && /^Transferencia/i.test(c)) {
    return { proveedor: titleCaseKeepSuffix(limpiarSufijoLegal(m[1])), categoria: categoriaOriginal || 'GASTO_OTROS' };
  }
  m = /^TRANSFERENCIA(?:\s+\w+)?\s+A\s+(.+)$/i.exec(c);
  if (m) return { proveedor: titleCaseKeepSuffix(limpiarSufijoLegal(m[1])), categoria: categoriaOriginal || 'GASTO_OTROS' };

  // Recibo X (corto)
  m = /^Recibo\s+(.+?)(?:\s+Nº Recibo|\s+Ref\.|\s+Cod\.|[,.])/i.exec(c);
  if (m) return { proveedor: titleCaseKeepSuffix(limpiarSufijoLegal(m[1])), categoria: categoriaOriginal || 'GASTO_OTROS' };

  // COMPRA TARJ. 5540XXX MERCANTE NOMBRE-LOC/LOC
  m = /^COMPRA TARJ\.\s+\S+\s+(.+?)(?:-[A-ZÁÉÍÓÚ\/]+)?$/i.exec(c);
  if (m) return { proveedor: titleCaseKeepSuffix(m[1].split('-')[0]), categoria: categoriaOriginal || 'GASTO_OTROS' };

  // Transaccion Contactless En X, Loc, Tarj.
  m = /^Transaccion Contactless En\s+(.+?)(?:,|$)/i.exec(c);
  if (m) return { proveedor: titleCaseKeepSuffix(m[1]), categoria: categoriaOriginal || 'GASTO_OTROS' };

  // Compra X, Y, Tarjeta...
  m = /^Compra\s+(.+?)(?:,|\s+Tarjeta|$)/i.exec(c);
  if (m) return { proveedor: titleCaseKeepSuffix(limpiarSufijoLegal(m[1])), categoria: categoriaOriginal || 'GASTO_OTROS' };

  // Traspaso: X — devolvemos el destino, recortado.
  m = /^Traspaso:\s*(.+)$/i.exec(c);
  if (m) {
    const t = m[1].length > 60 ? m[1].slice(0, 57) + '…' : m[1];
    return { proveedor: titleCaseKeepSuffix(t), categoria: categoriaOriginal || 'GASTO_OTROS' };
  }

  // Fallback: concepto recortado.
  const trimmed = c.length > 60 ? c.slice(0, 57) + '…' : c;
  return { proveedor: titleCaseKeepSuffix(trimmed), categoria: categoriaOriginal || 'GASTO_OTROS' };
}

module.exports = { esIntraGrupo, normalizarProveedor, INTRA_GRUPO_KEYWORDS };
