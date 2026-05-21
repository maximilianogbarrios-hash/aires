// Normalización de conceptos bancarios → proveedor canónico + categoría v2.
//
// Pipeline en `normalizarProveedor(concepto, categoriaOriginal?)`:
//   1. Reglas específicas (regex → nombre + categoría).
//   2. Parsing genérico de transferencias / recibos / compras → extrae el
//      destinatario y devuelve la categoría que mejor encaje (PROVEEDOR_OTROS,
//      NOMINAS para personas físicas, MANTENIMIENTO si está en lista, etc.).
//
// `esIntraGrupo` permanece como mecanismo separado: cualquier match cae en
// la categoría INTRAGRUPO y se excluye de los gráficos de proveedores.

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

function limpiarSufijoLegal(s) {
  return String(s)
    .replace(/[,.]+$/, '')
    .replace(/\s+(S\.\s*L\.|S\.\s*A\.|S\.\s*L\.\s*U\.|S\.\s*A\.\s*U\.)\s*$/i, (m) => ' ' + m.trim().replace(/\./g, '').toUpperCase())
    .trim();
}

// Reglas específicas por palabra clave. Cada match resuelve nombre canónico
// + categoría nueva (taxonomía v2).
const PROVEEDORES_KEYWORDS = [
  // Fiscales / Personal
  { re: /\btgss\b|tesoreria(\s+general)?\s+(de\s+la\s+)?seguridad\s+social/i, proveedor: 'TGSS',                  categoria: 'SS_LABORAL' },
  { re: /\baeat\b|agencia\s+tributaria|abonare\s+a\.?\s*e\.?\s*a\.?\s*t/i,    proveedor: 'AEAT - Impuestos',      categoria: 'IMPUESTOS' },
  { re: /^impuestos?\b|^impuesto:|\birpf\b|imp\.?\s*sociedades|imp\.?\s*s\/?\s*soc/i, proveedor: 'AEAT - Impuestos', categoria: 'IMPUESTOS' },

  // Alquiler (real estate explícito)
  { re: /silicius/i,                                                         proveedor: 'Silicius Real Estate SOCIMI', categoria: 'ALQUILER' },
  { re: /concepcion\s+orive/i,                                               proveedor: 'Concepción Orive',           categoria: 'ALQUILER' },
  { re: /overlease/i,                                                        proveedor: 'Overlease SA',               categoria: 'ALQUILER' },
  { re: /dialque/i,                                                          proveedor: 'Dialque SAU',                categoria: 'ALQUILER' },

  // Suministros
  { re: /iberdrola/i,                                                        proveedor: 'Iberdrola',                  categoria: 'SUMINISTROS_LUZ' },
  { re: /\bendesa\b/i,                                                       proveedor: 'Endesa',                     categoria: 'SUMINISTROS_LUZ' },
  { re: /\bi-?de\b|i\s+de\s+redes/i,                                         proveedor: 'i-DE Redes',                 categoria: 'SUMINISTROS_LUZ' },
  { re: /fox\s*energia/i,                                                    proveedor: 'Fox Energia SA',             categoria: 'SUMINISTROS_LUZ' },
  { re: /total\s*energies|totalenergies/i,                                   proveedor: 'TotalEnergies Clientes SAU', categoria: 'SUMINISTROS_LUZ' },
  { re: /edp\s*comerc/i,                                                     proveedor: 'EDP Comercializadora',       categoria: 'SUMINISTROS_LUZ' },
  { re: /acc\.?green\s*ener/i,                                               proveedor: 'ACC Green Energy Development SL', categoria: 'SUMINISTROS_LUZ' },
  { re: /\bnaturgy\b|repsol\s+gas|gas\s+natural/i,                           proveedor: 'Naturgy',                    categoria: 'SUMINISTROS_GAS' },
  { re: /\bhidraqua\b/i,                                                     proveedor: 'Hidraqua',                   categoria: 'SUMINISTROS_AGUA' },
  { re: /\bemuasa\b/i,                                                       proveedor: 'EMUASA',                     categoria: 'SUMINISTROS_AGUA' },
  { re: /\bamaem\b|aguas\s+municipales/i,                                    proveedor: 'AMAEM',                      categoria: 'SUMINISTROS_AGUA' },
  { re: /\bmovistar\b|\btelefonica\b/i,                                      proveedor: 'Telefónica / Movistar',      categoria: 'TELECOMUNICACIONES' },
  { re: /\bvodafone\b/i,                                                     proveedor: 'Vodafone',                   categoria: 'TELECOMUNICACIONES' },
  { re: /\borange\b|\bmasmovil\b|\bjazztel\b|\blowi\b|\byoigo\b/i,            proveedor: 'Orange / Otras telco',       categoria: 'TELECOMUNICACIONES' },
  { re: /\bigualadana\b|global\s+solution\s+s/i,                              proveedor: 'Igualadana / Global Solution', categoria: 'TELECOMUNICACIONES' },

  // Seguros
  { re: /\bmapfre\b/i,                                                       proveedor: 'Mapfre',                     categoria: 'SEGUROS' },
  { re: /\baxa\b/i,                                                          proveedor: 'AXA',                        categoria: 'SEGUROS' },
  { re: /\ballianz\b/i,                                                      proveedor: 'Allianz',                    categoria: 'SEGUROS' },
  { re: /\bgenerali\b/i,                                                     proveedor: 'Generali',                   categoria: 'SEGUROS' },

  // Financiero
  { re: /liquidacion\s+periodica\s+prestamo|prestamo/i,                      proveedor: 'Banco - Préstamos',          categoria: 'FINANCIERO' },
  { re: /comision(es)?\s+(banc|servicio|mantenim|tarjeta|transferenc|devolucion)/i, proveedor: 'Banco - Comisiones',  categoria: 'FINANCIERO' },

  // Mantenimiento — bricolaje y equipamiento
  { re: /leroy\s+merlin|leroymerlin/i,                                       proveedor: 'Leroy Merlin',               categoria: 'MANTENIMIENTO' },
  { re: /\bbricomart\b/i,                                                    proveedor: 'Bricomart',                  categoria: 'MANTENIMIENTO' },
  { re: /\bbrico\s*depot\b/i,                                                proveedor: 'Brico Dépôt',                categoria: 'MANTENIMIENTO' },
  { re: /conduce\s+revel/i,                                                  proveedor: 'Conduce Revel SL',           categoria: 'MANTENIMIENTO' },
  { re: /muebles\s+rosillo/i,                                                proveedor: 'Muebles Rosillo SL',         categoria: 'MANTENIMIENTO' },
  { re: /sklum/i,                                                            proveedor: 'Sklum',                      categoria: 'MANTENIMIENTO' },
  { re: /ductoaire/i,                                                        proveedor: 'Ductoaire',                  categoria: 'MANTENIMIENTO' },
  { re: /ggm\s+gastro/i,                                                     proveedor: 'GGM Gastro GmbH',            categoria: 'MANTENIMIENTO' },
  { re: /bolsemack/i,                                                        proveedor: 'Bolsemack SL',               categoria: 'MANTENIMIENTO' },
  { re: /\bikea\b/i,                                                         proveedor: 'IKEA',                       categoria: 'MANTENIMIENTO' },
  { re: /media\s*markt/i,                                                    proveedor: 'Media Markt',                categoria: 'MANTENIMIENTO' },
  { re: /\bworten\b/i,                                                       proveedor: 'Worten',                     categoria: 'MANTENIMIENTO' },
  { re: /materiales\s+cano/i,                                                proveedor: 'Materiales Cano SL',         categoria: 'MANTENIMIENTO' },
  { re: /maquinas\s+febal/i,                                                 proveedor: 'Maquinas Febal SL',          categoria: 'MANTENIMIENTO' },
  { re: /\becoclima\b/i,                                                     proveedor: 'Ecoclima SCP',               categoria: 'MANTENIMIENTO' },
  { re: /fibraclim/i,                                                        proveedor: 'Fibraclim SL',               categoria: 'MANTENIMIENTO' },
  { re: /decoraciones?\s+decomaber/i,                                        proveedor: 'Decoraciones Decomaber SL',  categoria: 'MANTENIMIENTO' },
  { re: /inox\s+levante/i,                                                   proveedor: 'Inox Levante',               categoria: 'MANTENIMIENTO' },
  { re: /escoda\s+elche|^escoda$/i,                                          proveedor: 'Escoda Elche',               categoria: 'MANTENIMIENTO' },
  { re: /argent\s*3d|argen\s*3d/i,                                           proveedor: 'Argent3D Impresiones SL',    categoria: 'MANTENIMIENTO' },
  { re: /paypal\s*\*?temu|\btemu\b/i,                                        proveedor: 'Temu',                       categoria: 'MANTENIMIENTO' },
  { re: /alcomar\s+herrega/i,                                                proveedor: 'Alcomar Herrega SL',         categoria: 'MANTENIMIENTO' },

  // Proveedores específicos
  { re: /kauapack|kauapak/i,                                                 proveedor: 'Kauapack',                    categoria: 'PROVEEDOR_PACKAGING' },
  { re: /\bdiversey\b/i,                                                     proveedor: 'Diversey',                    categoria: 'PROVEEDOR_LIMPIEZA' },
  { re: /\becolab\b/i,                                                       proveedor: 'Ecolab',                      categoria: 'PROVEEDOR_LIMPIEZA' },
  { re: /\bmakro\b/i,                                                        proveedor: 'Makro',                       categoria: 'PROVEEDOR_MAKRO' },
  { re: /coca[-\s]?cola|europacific|cobega/i,                                proveedor: 'Coca-Cola Europacific Partners Iberia', categoria: 'PROVEEDOR_BEBIDAS' },
  { re: /\bmahou\b/i,                                                        proveedor: 'Mahou',                       categoria: 'PROVEEDOR_BEBIDAS' },
  { re: /heineken/i,                                                         proveedor: 'Heineken',                    categoria: 'PROVEEDOR_BEBIDAS' },
  { re: /aceites\s+millas/i,                                                 proveedor: 'Aceites Millas',              categoria: 'PROVEEDOR_ACEITES' },
  { re: /\bcampoluz\b/i,                                                     proveedor: 'Campoluz',                    categoria: 'PROVEEDOR_LACTEOS' },
  { re: /\bacesur\b/i,                                                       proveedor: 'Acesur',                      categoria: 'PROVEEDOR_LACTEOS' },
  { re: /eurofrits/i,                                                        proveedor: 'Eurofrits SA',                categoria: 'PROVEEDOR_FRITAS' },
  { re: /\bmccain\b/i,                                                       proveedor: 'McCain',                      categoria: 'PROVEEDOR_FRITAS' },
  { re: /europastry/i,                                                       proveedor: 'Europastry SA',               categoria: 'PROVEEDOR_PANADERIA' },
  { re: /brioche\s+de\s+juanito/i,                                           proveedor: 'El Brioche de Juanito SL',    categoria: 'PROVEEDOR_PANADERIA' },
  { re: /\blandfood\b/i,                                                     proveedor: 'Landfood',                    categoria: 'PROVEEDOR_PANADERIA' },
  { re: /don\s+ha[mn]gus|\bhangus\b/i,                                       proveedor: 'Don Hamgus SL',               categoria: 'PROVEEDOR_CARNES' },
  { re: /carnicas\s+garcia/i,                                                proveedor: 'Carnicas Garcia SL',          categoria: 'PROVEEDOR_CARNES' },
  { re: /carnicas\s+mulas/i,                                                 proveedor: 'Carnicas Mulas SL',           categoria: 'PROVEEDOR_CARNES' },
  { re: /entre\.?pinares/i,                                                  proveedor: 'Entrepinares',                categoria: 'PROVEEDOR_CARNES' }, // por instrucción del usuario

  // Distribuidores y servicios clasificados como PROVEEDOR_OTROS
  { re: /distribuciones\s+batoy|\bbatoy\b/i,                                 proveedor: 'Distribuciones Batoy',        categoria: 'PROVEEDOR_OTROS' },
  { re: /elan\s*foods/i,                                                     proveedor: 'Elan Foods',                  categoria: 'PROVEEDOR_OTROS' },
  { re: /gardoy/i,                                                           proveedor: 'Gardoy SL',                   categoria: 'PROVEEDOR_OTROS' },
  { re: /restaurant\s+consulting\s+group/i,                                  proveedor: 'Restaurant Consulting Group SL', categoria: 'PROVEEDOR_OTROS' },
  { re: /yalt\s+business/i,                                                  proveedor: 'Yalt Business',               categoria: 'PROVEEDOR_OTROS' },
  { re: /europreven/i,                                                       proveedor: 'Europreven Serv PRL SL',      categoria: 'PROVEEDOR_OTROS' },
  { re: /ociobar/i,                                                          proveedor: 'OCIOBAR Elx SLU',             categoria: 'PROVEEDOR_OTROS' },
  { re: /google[ \t]*\*?ads|google\s+ads/i,                                  proveedor: 'Google Ads',                  categoria: 'PROVEEDOR_OTROS' },
  { re: /jobtoday/i,                                                         proveedor: 'JobToday',                    categoria: 'PROVEEDOR_OTROS' },
  { re: /mundo[\s-]?franquicia\s+consulting/i,                               proveedor: 'Mundo Franquicia Consulting SL', categoria: 'PROVEEDOR_OTROS' },
  { re: /tot[\s-]?digital/i,                                                 proveedor: 'TOT-Digital SL',              categoria: 'PROVEEDOR_OTROS' },
  { re: /societat\s+valenciana\s+fira/i,                                     proveedor: 'Societat Valenciana Fira Alacant SA', categoria: 'PROVEEDOR_OTROS' },
  { re: /soluciones?\s+host/i,                                               proveedor: 'Soluciones Host',             categoria: 'PROVEEDOR_OTROS' },
  { re: /\bavimed\b/i,                                                       proveedor: 'AVIMED',                      categoria: 'PROVEEDOR_OTROS' },
  { re: /etihad|emirates/i,                                                  proveedor: 'Etihad / Emirates (viajes)',  categoria: 'PROVEEDOR_OTROS' },
  { re: /4shine/i,                                                           proveedor: '4Shine',                      categoria: 'PROVEEDOR_OTROS' },

  // Agua local (Elx/Murcia/etc.)
  { re: /\baigues\b|\baigües\b|sanejament|servicio\s+agua/i,                  proveedor: 'Aigües / Servicio Agua',      categoria: 'SUMINISTROS_AGUA' },

  // Tasas municipales
  { re: /(excmo\.?\s+)?ayto\.?|ayuntamiento|exmo\.?\s+ayunta/i,               proveedor: 'Ayuntamiento (tasas)',        categoria: 'IMPUESTOS' },

  // Embargos
  { re: /\bembargo\b/i,                                                       proveedor: 'Embargo judicial',            categoria: 'OTROS' },
];

function normalizarProveedor(concepto, categoriaOriginal) {
  const c = String(concepto || '').trim();
  if (!c) return { proveedor: 'Sin descripción', categoria: categoriaOriginal || 'OTROS' };

  // 1) Reglas por palabra clave.
  for (const rule of PROVEEDORES_KEYWORDS) {
    if (rule.re.test(c)) return { proveedor: rule.proveedor, categoria: rule.categoria };
  }

  // 2) Familia TRANSFERENCIA: prioriza "A Favor De X".
  let m = /A\s+Favor\s+De\s+(.+?)(?:\s+Concepto|\s+Nº\s+|\s+Ref\.|$)/i.exec(c);
  if (m && /^Transferencia/i.test(c)) {
    return { proveedor: titleCaseKeepSuffix(limpiarSufijoLegal(m[1])), categoria: categoriaOriginal || 'PROVEEDOR_OTROS' };
  }
  m = /^TRANSFERENCIA(?:\s+\w+)?\s+A\s+(.+)$/i.exec(c);
  if (m) {
    const nombre = titleCaseKeepSuffix(limpiarSufijoLegal(m[1]));
    return { proveedor: nombre, categoria: categoriaOriginal || 'PROVEEDOR_OTROS' };
  }

  // 3) Recibo X (corto)
  m = /^Recibo\s+(.+?)(?:\s+Nº Recibo|\s+Ref\.|\s+Cod\.|[,.])/i.exec(c);
  if (m) return { proveedor: titleCaseKeepSuffix(limpiarSufijoLegal(m[1])), categoria: categoriaOriginal || 'PROVEEDOR_OTROS' };

  // 4) COMPRA TARJ. 5540XXX MERCANTE NOMBRE-LOC/LOC
  m = /^COMPRA TARJ\.\s+\S+\s+(.+?)(?:-[A-ZÁÉÍÓÚ\/]+)?$/i.exec(c);
  if (m) return { proveedor: titleCaseKeepSuffix(m[1].split('-')[0]), categoria: categoriaOriginal || 'PROVEEDOR_OTROS' };

  // 5) Transaccion Contactless En X, Loc, Tarj.
  m = /^Transaccion Contactless En\s+(.+?)(?:,|$)/i.exec(c);
  if (m) return { proveedor: titleCaseKeepSuffix(m[1]), categoria: categoriaOriginal || 'PROVEEDOR_OTROS' };

  // 6) Compra X, Y, Tarjeta...
  m = /^Compra\s+(.+?)(?:,|\s+Tarjeta|$)/i.exec(c);
  if (m) return { proveedor: titleCaseKeepSuffix(limpiarSufijoLegal(m[1])), categoria: categoriaOriginal || 'PROVEEDOR_OTROS' };

  // 7) Traspaso: X
  m = /^Traspaso:\s*(.+)$/i.exec(c);
  if (m) {
    const t = m[1].length > 60 ? m[1].slice(0, 57) + '…' : m[1];
    return { proveedor: titleCaseKeepSuffix(t), categoria: categoriaOriginal || 'OTROS' };
  }

  // 8) Fallback: concepto recortado.
  const trimmed = c.length > 60 ? c.slice(0, 57) + '…' : c;
  return { proveedor: titleCaseKeepSuffix(trimmed), categoria: categoriaOriginal || 'OTROS' };
}

module.exports = { esIntraGrupo, normalizarProveedor, INTRA_GRUPO_KEYWORDS };
