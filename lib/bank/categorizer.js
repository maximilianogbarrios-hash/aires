// Categorización por concepto de movimiento bancario — taxonomía v2.
//
// El primer match gana. Las reglas se evalúan en este orden:
//   1. INTRAGRUPO (transferencias entre sociedades del grupo)
//   2. IMPUESTOS / SS_LABORAL
//   3. ALQUILER / SUMINISTROS_*  / TELECOMUNICACIONES
//   4. SEGUROS / FINANCIERO / MANTENIMIENTO
//   5. PROVEEDOR_* específicos (packaging, limpieza, makro, bebidas, aceites,
//      lácteos, fritos, panadería, carnes)
//   6. NOMINAS heurística: transferencia a persona física sin sufijos legales
//   7. PROVEEDOR_OTROS: cualquier transferencia/recibo/compra a entidad
//      identificable que no entre en lo anterior
//   8. OTROS: fallback final (operaciones internas, devoluciones, regularizaciones)
//
// Ingresos (importe > 0) usan su propia tabla más simple. No se tocaron.

const { esIntraGrupo } = require('./normalizers');

const CATEGORIAS_GASTO = [
  'IMPUESTOS', 'SS_LABORAL', 'NOMINAS', 'ALQUILER',
  'SUMINISTROS_LUZ', 'SUMINISTROS_GAS', 'SUMINISTROS_AGUA', 'TELECOMUNICACIONES',
  'PROVEEDOR_CARNES', 'PROVEEDOR_PANADERIA', 'PROVEEDOR_FRITAS', 'PROVEEDOR_LACTEOS',
  'PROVEEDOR_ACEITES', 'PROVEEDOR_BEBIDAS', 'PROVEEDOR_MAKRO', 'PROVEEDOR_LIMPIEZA',
  'PROVEEDOR_PACKAGING', 'PROVEEDOR_OTROS',
  'MANTENIMIENTO', 'SEGUROS', 'FINANCIERO', 'INTRAGRUPO', 'OTROS',
];

const CATEGORIAS_INGRESO = [
  'INGRESO_GLOVO', 'INGRESO_JUST_EAT', 'INGRESO_BIZUM', 'INGRESO_STRIPE',
  'INGRESO_TRANSFERENCIA', 'INGRESO_OTROS',
];

// Categorías "de proveedor real" para la vista operativa (mix, ranking compras).
// MANTENIMIENTO se incluye porque suele venir de pedidos a Leroy/ferretería.
const CATEGORIAS_PROVEEDOR_OPERATIVO = [
  'PROVEEDOR_CARNES', 'PROVEEDOR_PANADERIA', 'PROVEEDOR_FRITAS', 'PROVEEDOR_LACTEOS',
  'PROVEEDOR_ACEITES', 'PROVEEDOR_BEBIDAS', 'PROVEEDOR_MAKRO', 'PROVEEDOR_LIMPIEZA',
  'PROVEEDOR_PACKAGING', 'PROVEEDOR_OTROS', 'MANTENIMIENTO',
];

// ─── Ingresos ─────────────────────────────────────────────────────────
const REGLAS_INGRESO = [
  { re: /glovo|glovoapp/i,                        cat: 'INGRESO_GLOVO' },
  { re: /just eat|justeat/i,                      cat: 'INGRESO_JUST_EAT' },
  { re: /bizum/i,                                  cat: 'INGRESO_BIZUM' },
  { re: /stripe|promotty/i,                        cat: 'INGRESO_STRIPE' },
  { re: /transferencia de|abono transferencia/i,  cat: 'INGRESO_TRANSFERENCIA' },
];

function categorizarIngreso(concepto) {
  for (const r of REGLAS_INGRESO) if (r.re.test(concepto)) return r.cat;
  return 'INGRESO_OTROS';
}

// ─── Gastos: bloque 1, impuestos / SS / alquiler / suministros ────────
const REGLAS_FISCALES_Y_FIJOS = [
  // Impuestos / Hacienda — incluye "Impuesto:" como prefijo de Santander
  { re: /\baeat\b|agencia tributaria|abonare\s+a\.?\s*e\.?\s*a\.?\s*t/i,                    cat: 'IMPUESTOS' },
  { re: /^impuestos?\b|^impuesto:|domiciliacion impuesto|tributo|hacienda/i,                cat: 'IMPUESTOS' },
  { re: /\birpf\b|retenciones e ing|imp\.?\s*sociedades|imp\.?\s*s\/?\s*soc|s\/renta de no residente/i, cat: 'IMPUESTOS' },

  // Seguridad Social
  { re: /\btgss\b|tesoreria(\s+general)?\s+(de\s+la\s+)?seguridad\s+social/i,               cat: 'SS_LABORAL' },
  { re: /\bseguridad social\b/i,                                                            cat: 'SS_LABORAL' },

  // Seguros (antes de ALQUILER porque "seguros allianz" no debe matchear)
  { re: /\bmapfre\b|\baxa\b|\ballianz\b|\bgenerali\b|liberty\s+seguros|\bmutua\b|\baseguradora\b|\bseguros\b|allianz/i, cat: 'SEGUROS' },

  // Alquileres — Silicius, Concepción Orive, Real Estate, SOCIMI, Overlease, "Arrendamiento"
  { re: /alquiler|arrendamiento|silicius|concepcion\s+orive|real\s+estate|\bsocimi\b|overlease|inmobil|fianza\s+local|fianza/i, cat: 'ALQUILER' },

  // Suministros: gas primero (Naturgy es ambiguo, se queda como gas por convención)
  { re: /\bnaturgy\b|repsol\s+gas|\bgas\s+natural\b|\bredexis\b/i,                          cat: 'SUMINISTROS_GAS' },
  // Luz
  { re: /\biberdrola\b|\bendesa\b|\bi-?de\b|\b(i\s+de)\s+(redes|distribu)/i,                cat: 'SUMINISTROS_LUZ' },
  { re: /edp\s*comerc|fox\s*energia|total\s*energies|totalenergies|acc\.?green\s*ener|campo\s*luz|radius\s+business|green\s+ener/i, cat: 'SUMINISTROS_LUZ' },
  // Agua
  { re: /\bhidraqua\b|\bamaem\b|aguas\s+municipales|\bemuasa\b|\bcanal\s+de\s+isabel\s+ii\b/i, cat: 'SUMINISTROS_AGUA' },
  // Telecom
  { re: /\bmovistar\b|\bvodafone\b|\borange\b|\btelefonica\b|\bmasmovil\b|\bjazztel\b|\blowi\b|\byoigo\b|\brepublic\s*wireless/i, cat: 'TELECOMUNICACIONES' },
  { re: /\bigualadana\b|\bglobal\s+solution\s+s/i,                                          cat: 'TELECOMUNICACIONES' },
];

// ─── Gastos: bloque 2, financiero y mantenimiento ─────────────────────
const REGLAS_FIN_Y_MANT = [
  // Financiero: préstamos, comisiones, devoluciones, leasing (cuidado con "overlease" que ya cayó en alquiler)
  { re: /liquidacion\s+periodica\s+prestamo|prestamo|leasing|aval|financiacion|descubierto/i, cat: 'FINANCIERO' },
  { re: /\bcomision(es)?\s+(banc|servicio|mantenim|tarjeta|transferenc|devolucion)/i,        cat: 'FINANCIERO' },
  { re: /devolucion\s+recibo|gastos?\s+financieros?|interes(es)?\s+(deudor|prestamo)/i,    cat: 'FINANCIERO' },

  // Mantenimiento: Leroy, ferretería, técnicos, obra, mobiliario
  { re: /leroy\s+merlin|leroymerlin|\bbricomart\b|\bbricodepot\b|\bferreteria/i,             cat: 'MANTENIMIENTO' },
  { re: /\bmantenimiento\b|\breparacion\b|\bfontaneria\b|electricidad\s+(instalac|reparac)|tornilleria|sklum|conduce\s+revel|muebles\s+rosillo|ductoaire|cocinas\s+industriales/i, cat: 'MANTENIMIENTO' },
  { re: /\btecnico\s+frigorif|aire\s+acondic|climatizacion|extincion\s+incend|tienda\s+animales/i, cat: 'MANTENIMIENTO' },
];

// ─── Gastos: bloque 3, proveedores específicos (orden importa) ────────
const REGLAS_PROVEEDORES = [
  // Packaging primero (envases/embalajes específicos)
  { re: /kauapack|kauapak|cartonajes|envases?|embalaje|bolsas?\s+kraft|packaging/i,         cat: 'PROVEEDOR_PACKAGING' },

  // Limpieza
  { re: /\bdiversey\b|\becolab\b|\bkh[-\s]?7\b|productos?\s+limpieza|detergente|\blejia\b|higi[eé]ne\s+industrial/i, cat: 'PROVEEDOR_LIMPIEZA' },

  // Makro (mayorista grande)
  { re: /\bmakro\b/i,                                                                       cat: 'PROVEEDOR_MAKRO' },

  // Bebidas
  { re: /coca[-\s]?cola|europacific|cobega|\bmahou\b|heineken|\bpepsi\b|\bdamm\b|estrella\s+galicia|\bfanta\b|\bsprite\b|\bred\s+bull\b|aguas\s+font|\bschweppes\b|amer\s+picon|vichy\s+catalan/i, cat: 'PROVEEDOR_BEBIDAS' },

  // Aceites
  { re: /aceites\s+millas|\bborges\b|koipe|aceite\s+(oliva|girasol)/i,                       cat: 'PROVEEDOR_ACEITES' },

  // Lácteos (el usuario incluyó Campoluz y Acesur en lácteos — se respeta su instrucción)
  { re: /\bcampoluz\b|\bacesur\b|\bpascual\b|\bkaiku\b|\bpuleva\b|central\s+lechera|\bquesos?\b|\bleche\b/i, cat: 'PROVEEDOR_LACTEOS' },

  // Fritos
  { re: /eurofrits|\bmccain\b|patatas?\s+(prefritas|congeladas)|frito\s+congelado/i,         cat: 'PROVEEDOR_FRITAS' },

  // Panadería (Europastry, Brioche, Landfood)
  { re: /europastry|\blandfood\b|brioche|panaderia|pasteleria|\bpan\s+(de|congelad|preco)/i, cat: 'PROVEEDOR_PANADERIA' },

  // Carnes (el usuario incluyó "entre Pinares" en carnes — se respeta aunque sea queso)
  { re: /don\s+ha[mn]gus|\bhangus\b|carnicas?\s+\w+|\bentre\.?pinares\b|porcinos?\s+\w+|\bpollo\s+(fresco|congelad|despiece)|\bpavo\s+(fresco|congelad)/i, cat: 'PROVEEDOR_CARNES' },
];

// ─── Gastos: bloque 4, NÓMINAS (heurística) ───────────────────────────

// Sufijos / palabras que descartan "es persona física".
const PISTAS_EMPRESA = new RegExp(
  '\\b(S\\.?L\\.?U?\\.?|S\\.?A\\.?U?\\.?|SCOOP|S\\.?C\\.?|C\\.?B\\.?|GMBH|LTD|INC|' +
  'COMUNIDAD|COMUN\\.?\\s+PROP|FUNDACION|ASOC|COOPERATIVA|REAL\\s+ESTATE|SOCIMI|' +
  'AYUNTAMIENTO|MINISTERIO|HACIENDA|TGSS|AEAT|GRUPO|SOCIEDAD|EMPRESA|SERVICIO|' +
  'CONSULTING|MANAGEMENT|BUSINESS|ENERGIA|ENERGY|GAS|LUZ|TELECO|ESPANA|ESPAÑA|' +
  'IBERIA|EUROPE|INTERNATIONAL|RESTAURANT|GRUPO\\s+HOSTELERO|RESTAURACION)\\b',
  'i'
);

// Palabras que indican operación NO laboral aunque sea transferencia a nombre.
const PISTAS_NO_NOMINA = /factura|alquiler|arrendamiento|fianza|recibo|impuesto|prestamo|aportacion|traspaso/i;

function esTransferenciaPersonaFisica(concepto) {
  if (!concepto) return false;
  // 1) Debe empezar con TRANSFERENCIA / Transferencia ... A {nombre}
  //    Aceptamos también "Transferencia Inmediata A Favor De {nombre}".
  const c = String(concepto);
  let nombre = null;
  let m = /^transferencia(?:\s+\w+)?\s+a\s+favor\s+de\s+([A-Za-zÁÉÍÓÚÑáéíóúñ.\s]+?)(?:\s+concepto|\s+nº|\s+ref\.|$)/i.exec(c);
  if (m) nombre = m[1];
  if (!nombre) {
    m = /^transferencia(?:\s+\w+)?\s+a\s+([A-Za-zÁÉÍÓÚÑáéíóúñ.\s]+?)(?:\s+concepto|\s+nº|\s+ref\.|$)/i.exec(c);
    if (m) nombre = m[1];
  }
  if (!nombre) return false;

  if (PISTAS_NO_NOMINA.test(c)) return false;
  if (PISTAS_EMPRESA.test(nombre)) return false;

  const tokens = nombre.trim().split(/\s+/);
  if (tokens.length < 2 || tokens.length > 5) return false;
  // Todos los tokens deben empezar con mayúscula y ser letras (nombres/apellidos)
  return tokens.every((t) => /^[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ.]+$/.test(t));
}

// ─── Gastos: bloque 5, operación comercial → PROVEEDOR_OTROS ─────────

// Si el concepto parece una operación comercial identificable (transferencia
// a empresa, recibo, compra con tarjeta), va a PROVEEDOR_OTROS antes que OTROS.
function esOperacionComercial(concepto) {
  if (!concepto) return false;
  return /^transferencia|^transf\.|^recibo|^compra\s+|^pago\s+|^adeudo\s+recibo|contactless|tarj\.|\bbeneficiario\b/i.test(concepto);
}

// ─── Función principal ───────────────────────────────────────────────
function categorizar(concepto, importe) {
  if (!concepto) return importe > 0 ? 'INGRESO_OTROS' : 'OTROS';
  if (importe > 0) return categorizarIngreso(concepto);
  return categorizarGasto(concepto);
}

function categorizarGasto(concepto) {
  // 1) intra-grupo
  if (esIntraGrupo(concepto)) return 'INTRAGRUPO';
  // 2) fiscales y fijos
  for (const r of REGLAS_FISCALES_Y_FIJOS) if (r.re.test(concepto)) return r.cat;
  // 3) financiero y mantenimiento
  for (const r of REGLAS_FIN_Y_MANT) if (r.re.test(concepto)) return r.cat;
  // 4) proveedores específicos
  for (const r of REGLAS_PROVEEDORES) if (r.re.test(concepto)) return r.cat;
  // 5) nóminas heurística
  if (esTransferenciaPersonaFisica(concepto)) return 'NOMINAS';
  // 6) PROVEEDOR_OTROS si parece operación comercial
  if (esOperacionComercial(concepto)) return 'PROVEEDOR_OTROS';
  // 7) fallback
  return 'OTROS';
}

// ─── Detección de local (no se toca) ─────────────────────────────────
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

function extraerSubcategoria(concepto) {
  if (!concepto) return null;
  const limpio = concepto
    .replace(/\b\d{4,}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (limpio.length < 4) return null;
  return limpio.slice(0, 120);
}

function esProveedorOperativo(categoria) {
  return CATEGORIAS_PROVEEDOR_OPERATIVO.includes(categoria);
}

module.exports = {
  CATEGORIAS_GASTO, CATEGORIAS_INGRESO, CATEGORIAS_PROVEEDOR_OPERATIVO,
  categorizar, categorizarGasto, categorizarIngreso,
  detectarLocal, extraerSubcategoria,
  esProveedorOperativo, esTransferenciaPersonaFisica, esOperacionComercial,
};
