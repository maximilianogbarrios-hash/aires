// Categorización por concepto de movimiento bancario.
// Orden de evaluación: el primer match gana. Si el signo no coincide
// con la categoría (gasto vs ingreso), cae a OTROS.

const CATEGORIAS = {
  // Ingresos
  INGRESO_GLOVO:              ['glovo', 'glovoapp'],
  INGRESO_JUST_EAT:           ['just eat', 'justeat'],
  INGRESO_BIZUM:              ['bizum'],
  INGRESO_STRIPE:             ['stripe', 'promotty'],
  INGRESO_TRANSFERENCIA:      ['transferencia de', 'abono transferencia'],

  // Gastos — proveedores
  GASTO_CARNICAS:             ['carnicas mulas', 'carnicas '],
  GASTO_MAKRO:                ['makro'],
  GASTO_DISTRIBUCIONES_BATOY: ['batoy'],
  GASTO_COCA_COLA:            ['coca cola', 'europacific', 'cobega'],
  GASTO_HANGUS:               ['don hangus', 'hangus'],
  GASTO_EUROFRITS:            ['eurofrits'],
  GASTO_ACEITES:              ['aceites millas'],
  GASTO_ELAN_FOODS:           ['elan foods'],
  GASTO_KAUAPACK:             ['kauapack', 'kauapak'],
  GASTO_ENTREPINARES:         ['entrepinares'],

  // Gastos — servicios
  GASTO_LUZ:                  ['endesa', 'iberdrola', 'naturgy', 'campoluz', 'campo luz', 'radius business'],
  GASTO_AGUA:                 ['hidraqua', 'aguas municipales', 'emuasa'],
  GASTO_INTERNET:             ['vodafone', 'movistar', 'orange', 'igualadana', 'global solution'],
  GASTO_ALQUILER:             ['alquiler', 'arrendamiento'],

  // Gastos — fiscal / personal
  GASTO_SS_TGSS:              ['tgss', 'seguridad social', 'tesoreria'],
  GASTO_NOMINAS:              ['nomina', 'nominas', 'salario'],
  GASTO_HACIENDA:             ['abonare a.e.a.t', 'irpf', 'retenciones e ing', 'imp. sociedades'],

  // Gastos — varios
  GASTO_PUBLICIDAD:           ['google', 'facebk', 'instagram'],
  GASTO_SEGUROS:              ['seguros', 'allianz', 'axa', 'mapfre', 'generali'],
  GASTO_SGAE:                 ['sgae', 'agedi'],
  GASTO_PRESTAMO_INTERGRUPO:  ['prestamo', 'traspaso: prestamo', 'traspaso: aportacion'],
};

// Códigos Santander relevantes
const CODIGOS_BANCO = {
  '135': 'Liquidación TPV',
  '136': 'Compras con tarjeta empresa',
  '071': 'Transferencia recibida',
  '072': 'Transferencia enviada',
  '174': 'Recibo domiciliado',
};

function categorizar(concepto, importe) {
  if (!concepto) return importe > 0 ? 'INGRESO_OTROS' : 'GASTO_OTROS';
  const c = concepto.toLowerCase();
  for (const [cat, keywords] of Object.entries(CATEGORIAS)) {
    if (keywords.some((kw) => c.includes(kw))) {
      // Signo debe coincidir con la categoría
      if (cat.startsWith('INGRESO_') && importe < 0) return 'GASTO_OTROS';
      if (cat.startsWith('GASTO_') && importe > 0) return 'INGRESO_OTROS';
      return cat;
    }
  }
  return importe > 0 ? 'INGRESO_OTROS' : 'GASTO_OTROS';
}

// Detecta el local a partir del concepto de un movimiento (típicamente
// liquidaciones TPV, código 135).
function detectarLocal(concepto) {
  if (!concepto) return null;
  const c = concepto.toLowerCase();
  if (c.includes('alicante'))                              return 'ALICANTE';
  if (c.includes('crevillente'))                           return 'CREVILLENTE';
  if (c.includes('chiken') || c.includes('chicken uncles'))return 'CHICKEN_UNCLES';
  if (c.includes('san vicen'))                             return 'SAN_VICENTE';
  if (c.includes('smart aires'))                           return 'SANTO_DOMINGO';
  if (c.includes('murcia'))                                return 'MURCIA_MERCED';
  if (c.includes('orihuela'))                              return 'ORIHUELA';
  if (c.includes('benidorm'))                              return 'BENIDORM';
  if (c.includes('elche'))                                 return 'ELCHE';
  if (c.includes('santa pola') || c.includes('santa-pola'))return 'SANTA_POLA';
  if (c.includes('torrevieja'))                            return 'TORREVIEJA';
  if (c.includes('arenales'))                              return 'ARENALES';
  if (c.includes('thader') && c.includes('chick'))         return 'CHICKEN_THADER';
  if (c.includes('thader'))                                return 'THADER';
  if (c.includes('santo domingo') || c.includes('santo dom')) return 'SANTO_DOMINGO';
  if (c.includes('merced'))                                return 'MURCIA_MERCED';
  return null;
}

// Heurística para extraer un "proveedor" / subcategoría legible del concepto.
function extraerSubcategoria(concepto) {
  if (!concepto) return null;
  // Patrones típicos Santander: "PAGO RECIBO 12345 EMPRESA XXX SL"
  // Lo más simple: quedarnos con la parte significativa, sin códigos numéricos largos.
  const limpio = concepto
    .replace(/\b\d{4,}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (limpio.length < 4) return null;
  return limpio.slice(0, 120);
}

module.exports = { CATEGORIAS, CODIGOS_BANCO, categorizar, detectarLocal, extraerSubcategoria };
