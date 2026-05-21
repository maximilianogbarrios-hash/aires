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

  // Energía y Gas (Ronda 4 — colapsado a un solo proveedor canónico)
  { re: /iberdrola|\bendesa\b|\bendesax\b|\bi-?de\b|i\s+de\s+redes|fox\s*energia|total\s*energies|totalenergies|edp\s*comerc|acc\.?green\s*ener|\bnaturgy\b|repsol\s+gas|gas\s+natural|fons\s+energia|\bviesgo\b|campo\s*luz|radius\s+business/i, proveedor: 'Energía y Gas', categoria: 'SUMINISTROS_ENERGIA' },

  // Agua — se mantiene aparte (no es ENERGÍA)
  { re: /\bhidraqua\b|\bemuasa\b|\bamaem\b|aguas\s+municipales|\baigues\b|\baigües\b|sanejament|servicio\s+agua/i, proveedor: 'Aigües / Servicio Agua', categoria: 'SUMINISTROS_AGUA' },

  // Telecomunicaciones
  { re: /\bmovistar\b|\btelefonica\b|\bvodafone\b|\borange\b|\bmasmovil\b|\bjazztel\b|\blowi\b|\byoigo\b|\bigualadana\b|global\s+solution\s+s/i, proveedor: 'Telecomunicaciones', categoria: 'TELECOMUNICACIONES' },

  // Seguros — colapsado
  { re: /\bmapfre\b|\baxa\b|\ballianz\b|\bgenerali\b|liberty\s+seguros|\bmutua\b|\baseguradora\b|\bseguros\b/i, proveedor: 'Seguros', categoria: 'SEGUROS' },

  // Seguridad Social — incluye variantes truncadas Sabadell
  { re: /\btgss\b|tesoreria(\s+general)?\s+(de\s+la\s+)?seguridad\s+social|\bseguridad\s+social\b|\bs\.?\s*sociale\b|\bss\/|seguros?\s+sociales/i, proveedor: 'Seguridad Social', categoria: 'SS_LABORAL' },

  // Banco — Operaciones (préstamos, comisiones, bancos como destinatario)
  { re: /^\s*comisi[oó]nes?\s+\d{4,}/i,                                       proveedor: 'Banco - Operaciones',        categoria: 'FINANCIERO' },
  { re: /liquidacion\s+periodica\s+prestamo|\bprestamo\b|leasing|aval|financiacion|descubierto/i, proveedor: 'Banco - Operaciones', categoria: 'FINANCIERO' },
  { re: /^comisiones?$|^comisi[oó]n\s+divisa|^intereses?\s+y\/?o\s+comisiones?|^com\.?\s+por\s+(transferencia|cambio|recibo|cancelaci)/i, proveedor: 'Banco - Operaciones', categoria: 'FINANCIERO' },
  { re: /\bcomision(es)?\s+(banc|servicio|mantenim|tarjeta|transferenc|devolucion|sepa)|com\.?\s+mantenim|cuota\s+mantenimiento\s+cuenta|canon(\s+mantenim|\s+banc)?|comision\s+apertura|devolucion\s+recibo|gastos?\s+financieros?|interes(es)?\s+(deudor|prestamo)/i, proveedor: 'Banco - Operaciones', categoria: 'FINANCIERO' },
  { re: /banco\s+bilbao\s+viscaya\s+argentaria|\bbbva\b|caixabank|kutxabank|banco\s+sabadell|sabadell\s+com|santander\s+com/i, proveedor: 'Banco - Operaciones', categoria: 'FINANCIERO' },

  // Mantenimiento y Equipamiento — colapsado a un solo proveedor canónico
  { re: /\bleroy\s+merlin|\bleory\s+merlin|leroymerlin|\bbricomart\b|\bbrico\s*depot\b|\bferreteria/i, proveedor: 'Mantenimiento y Equipamiento', categoria: 'MANTENIMIENTO' },
  { re: /conduce\s+revel|muebles\s+rosillo|sklum|ductoaire|ggm\s+gastro|bolsemack|\bikea\b|media\s*markt|\bworten\b|materiales\s+cano|maquinas\s+febal|ecoclima|fibraclim|decoraciones?\s+decomaber|inox\s+levante|escoda|argent\s*3d|argen\s*3d|paypal\s*\*?temu|\btemu\b|new\s+matelsa|\bmatelsa\b|maquinaria\s+hosteler|saniagua|todoelectrico|electricas?\s+maisa|obramat|sumin\s+surec|thomann|aliexpress|\bobm\s+murcia\b|viveros\s+carmaet|coop\s+electrica\s+benefica|el\s+corte\s+electr|rros\s+imagen|rios\s+imagen|timbrad[oa]s|rotulaci[oó]n|cartel(er[ií]a)?/i, proveedor: 'Mantenimiento y Equipamiento', categoria: 'MANTENIMIENTO' },

  // Servicios Profesionales — gestoría, asesoría, SaaS, consultores, RRHH digitales, ocio
  { re: /europreven|prevencion\s+(de\s+)?riesgos?|prevenci[óo]n\s+laboral|gestor[íi]a|asesor(ia|ía|amiento|es?)?|abogad[oa]s?|notaria|administradores?\s+de\s+fincas|\bconsulting\b/i, proveedor: 'Servicios Profesionales', categoria: 'SERVICIOS_PROF' },
  { re: /\badobe\b|google[\s*]*one|google[\s*]*workspace|gsuite|\bmicrosoft\b|office\s+365|\bm365\b|capcut|hostinger|hello\s+ventures|app[-\s]?sorteos|sp\s+4shine|\bpromotty\b|soluciones?\s+host|helloprint|tot[\s-]?digital|yalt\s+business|magical\s+insights/i, proveedor: 'Servicios Profesionales', categoria: 'SERVICIOS_PROF' },
  { re: /\bangel\s+linares\b|\balcomar\b|restaurant\s+consulting|\bociobar\b|societat\s+valenciana|mundo[\s-]?franquicia|jobtoday|\binfojobs\b|\bindeed\b|linkedin\s+jobs?/i, proveedor: 'Servicios Profesionales', categoria: 'SERVICIOS_PROF' },

  // Publicidad — Google Ads y Meta Ads
  { re: /google[\s*]*ads?|adwords|\bfacebk\b|facebookmkt|facebook\s+ads?|meta\s+ads?|fb\.me\/ads|tiktok\s*ads?|tiktok\.com|linkedin\s+ads?/i, proveedor: 'Publicidad Online', categoria: 'PUBLICIDAD' },

  // Tasas e impuestos extras
  { re: /^\d{0,4}\s*iva\s+autoliquidaci|^iva\s+autoliquidaci/i,              proveedor: 'IVA Autoliquidación',        categoria: 'IMPUESTOS' },
  { re: /dgt\s+sanciones?|sancion(es)?\s+(de\s+)?trafico/i,                  proveedor: 'DGT - Sanciones',            categoria: 'IMPUESTOS' },
  { re: /pago\s+recibo\s+de\s+generalitat/i,                                 proveedor: 'Generalitat Valenciana',     categoria: 'IMPUESTOS' },

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
  // Entrepinares (movido a LACTEOS en Ronda 4 — queso, no carne)
  { re: /entre\.?pinares/i,                                                  proveedor: 'Entrepinares',                categoria: 'PROVEEDOR_LACTEOS' },

  // Proveedores de alimentación reales (nombres específicos, no agrupados)
  { re: /distribuciones?\s+batoy|\bdist\.?\s+batoy\b|distrib\s+batoy|\bbatoy\b/i, proveedor: 'Distribuciones Batoy',   categoria: 'PROVEEDOR_OTROS' },
  { re: /elan\s*foods?/i,                                                    proveedor: 'Elan Foods',                  categoria: 'PROVEEDOR_OTROS' },
  { re: /\bavimed\b/i,                                                       proveedor: 'Avimed',                      categoria: 'PROVEEDOR_OTROS' },
  { re: /gardoy/i,                                                           proveedor: 'Gardoy SL',                   categoria: 'PROVEEDOR_OTROS' },
  { re: /etihad|emirates/i,                                                  proveedor: 'Etihad / Emirates (viajes)',  categoria: 'PROVEEDOR_OTROS' },

  // Tasas municipales
  { re: /(excmo\.?\s+)?ayto\.?|ayuntamiento|exmo\.?\s+ayunta/i,               proveedor: 'Ayuntamiento (tasas)',        categoria: 'IMPUESTOS' },

  // Embargos
  { re: /\bembargo\b/i,                                                       proveedor: 'Embargo judicial',            categoria: 'OTROS' },

  // ─── Reglas residuales (Ronda 4) ─────────────────────────────────────
  // Plataformas delivery — categoría DELIVERY (proveedor con nombre individual)
  { re: /\bglovo\b|glovoapp/i,                                                proveedor: 'Glovo',                        categoria: 'DELIVERY' },
  { re: /just\s*eat|justeat/i,                                                proveedor: 'Just Eat',                     categoria: 'DELIVERY' },
  { re: /uber\s*eats/i,                                                       proveedor: 'Uber Eats',                    categoria: 'DELIVERY' },
  { re: /deliveroo/i,                                                         proveedor: 'Deliveroo',                    categoria: 'DELIVERY' },

  // Vehículos y leasing — se contabilizan como "Banco - Operaciones" para
  // consolidar en un único proveedor canónico (Ronda 4).
  { re: /\bstellantis\b|volkswagen\s+(financial|leas|bank)|\bseat\s+financial|santander\s+consumer|bbva\s+autorenting|\brenting\b|\bleasing\b/i, proveedor: 'Banco - Operaciones', categoria: 'FINANCIERO' },

  // Amazon — como "Mantenimiento y Equipamiento" (consumibles / herramientas)
  { re: /\bamazon\b|\bamz\b\s*mktp|amazon\s+(es|eu|web|marketplace|seller|pago)/i, proveedor: 'Mantenimiento y Equipamiento', categoria: 'MANTENIMIENTO' },
];

// Heurística inline (no importa categorizer.js para evitar require circular):
// si el concepto cae en NOMINAS por categoría o por patrón de persona física,
// devolvemos un único nombre canónico para que el donut lo agrupe.
const PISTA_NOMINA_EXPLICITA_NORM = /\bnomin[ae]s?\b|^nomina\s+a\b|concepto:\s*nomina|traspaso:\s*nomina|\bsalario\b|\bsueldo\b/i;
const PISTAS_NO_NOMINA_NORM = /\bfactura\b|alqui+ler|alqui+iler|arrendamiento|\bfianza\b|\brecibo\b|\bimpuesto\b|\bprestamo\b|aportacion/i;
const PISTAS_EMPRESA_NORM = /\b(S\.?L\.?U?\.?|S\.?A\.?U?\.?|SCOOP|S\.?C\.?|C\.?B\.?|GMBH|LTD|INC|COMUNIDAD|FUNDACION|ASOC|COOPERATIVA|REAL\s+ESTATE|SOCIMI|AYUNTAMIENTO|MINISTERIO|HACIENDA|TGSS|AEAT|GRUPO|SOCIEDAD|EMPRESA|SERVICIO|CONSULTING|MANAGEMENT|BUSINESS|ENERGIA|ENERGY|GAS|LUZ|TELECO|ESPANA|ESPAÑA|IBERIA|EUROPE|INTERNATIONAL|RESTAURANT|RESTAURACION|BANCO|BANK)\b/i;

function pareceTransferenciaPersonaFisica(c) {
  if (PISTA_NOMINA_EXPLICITA_NORM.test(c) && !PISTAS_NO_NOMINA_NORM.test(c)) return true;
  let nombre = null;
  let m = /^transferencia(?:\s+\w+)?\s+a\s+favor\s+de\s+([A-Za-zÁÉÍÓÚÑáéíóúñ.,\s]+?)(?:\s+concepto|\s+nº|\s+ref\.|$)/i.exec(c);
  if (m) nombre = m[1];
  if (!nombre) {
    m = /^transferencia(?:\s+\w+)?\s+a\s+([A-Za-zÁÉÍÓÚÑáéíóúñ.,\s]+?)(?:\s+concepto|\s+nº|\s+ref\.|$)/i.exec(c);
    if (m) nombre = m[1];
  }
  if (!nombre) return false;
  if (PISTAS_NO_NOMINA_NORM.test(c)) return false;
  if (PISTAS_EMPRESA_NORM.test(nombre)) return false;
  // Acepta stopwords (de/del/la/las/el/los/y/da/do/das/dos) entre tokens de
  // nombre — match con la heurística mejorada de categorizer.js (Ronda 3).
  const NOMBRE_STOP_N = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'y', 'da', 'do', 'das', 'dos']);
  const tokens = nombre.trim().replace(/[,.]/g, '').split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 6) return false;
  let mayusCount = 0;
  for (const t of tokens) {
    if (NOMBRE_STOP_N.has(t.toLowerCase())) continue;
    if (/^[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ.]+$/.test(t) || /^[A-ZÁÉÍÓÚÑ]{2,}$/.test(t)) {
      mayusCount++;
    } else {
      return false;
    }
  }
  return mayusCount >= 2;
}

function normalizarProveedor(concepto, categoriaOriginal) {
  const c = String(concepto || '').trim();
  if (!c) return { proveedor: 'Sin descripción', categoria: categoriaOriginal || 'OTROS' };

  // 0) Colapsar nóminas en un único proveedor canónico, sea por categoría
  //    ya asignada en DB o por heurística sobre el concepto. Esto evita que
  //    cada persona física aparezca como slice individual en el donut.
  if (categoriaOriginal === 'NOMINAS' || pareceTransferenciaPersonaFisica(c)) {
    return { proveedor: 'Nóminas Personal', categoria: 'NOMINAS' };
  }

  // 0.bis) Si la categoría ya en DB es ALQUILER y no matchea una regla específica
  //        (Silicius, Dialque, Concepción Orive), colapsar todos los arrendadores
  //        individuales en "Alquileres y Arrendamientos" — esencial para
  //        mantener el conteo de grupos ≤30 (Ronda 4).
  if (categoriaOriginal === 'ALQUILER') {
    return { proveedor: 'Alquileres y Arrendamientos', categoria: 'ALQUILER' };
  }

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
