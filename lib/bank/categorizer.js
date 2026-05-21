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
  // SUMINISTROS_ENERGIA unifica luz + gas (Ronda 4); _LUZ y _GAS quedan
  // como categorías legacy para back-compat. SUMINISTROS_AGUA aparte.
  'SUMINISTROS_ENERGIA', 'SUMINISTROS_LUZ', 'SUMINISTROS_GAS', 'SUMINISTROS_AGUA', 'TELECOMUNICACIONES',
  'PROVEEDOR_CARNES', 'PROVEEDOR_PANADERIA', 'PROVEEDOR_FRITAS', 'PROVEEDOR_LACTEOS',
  'PROVEEDOR_ACEITES', 'PROVEEDOR_BEBIDAS', 'PROVEEDOR_MAKRO', 'PROVEEDOR_LIMPIEZA',
  'PROVEEDOR_PACKAGING', 'PROVEEDOR_OTROS',
  'MANTENIMIENTO', 'SEGUROS', 'FINANCIERO', 'INTRAGRUPO', 'OTROS',
  // Taxonomía v3 (recategorización masiva 2026-05-21):
  'PUBLICIDAD', 'SERVICIOS_PROF', 'DELIVERY',
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

// Regla pre-INTRAGRUPO: las comisiones bancarias formato Sabadell tienen
// "AIRES BURGER BAR MURCIA" o similar en el concepto (porque el banco
// describe a qué sociedad cobra la comisión), lo que las haría caer en
// INTRAGRUPO si no las chequeamos primero.
const REGEX_COMISIONES_BANCARIAS = /^\s*comisi[oó]nes?\s+\d{4,}/i;

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

// ─── Gastos: bloque 0, intra-grupo y publicidad/RRHH digital (prioridad alta) ──
// Estas reglas se aplican ANTES de las fiscales porque "Compra Google ads"
// debe ir a PUBLICIDAD aunque "google.com" suene a servicio web.
const REGLAS_DIGITAL_Y_RRHH = [
  // Publicidad digital (categoria v3)
  { re: /\bgoogle[\s*]*ads?\b|adwords|google\.com\b|google\*ads/i,                            cat: 'PUBLICIDAD' },
  { re: /\bmeta\b\s*plat|\bfacebook\s+ads?|\bmeta\s+ads?|facebookmkt|\binstagram\s+ads?|\bfb\s+ads?|\bfacebk\b|fb\.me\/ads/i, cat: 'PUBLICIDAD' },
  { re: /tiktok\s*ads?|tiktok\.com|byte\s*dance\s+ads/i,                                      cat: 'PUBLICIDAD' },
  { re: /linkedin\s+ads?|linkedin\.com\/(?:ads|marketing)/i,                                  cat: 'PUBLICIDAD' },
  // Portales de empleo (SERVICIOS_PROF — RRHH)
  { re: /jobtoday|\binfojobs\b|\bindeed\b|linkedin\s+jobs?/i,                                  cat: 'SERVICIOS_PROF' },
  // Plataformas de delivery (cuando aparecen como gasto: pagos por subscripción, paneles, etc.)
  { re: /\bglovo\b|glovoapp|just\s*eat|justeat|uber\s*eats|deliveroo/i,                         cat: 'DELIVERY' },
];

// ─── Gastos: bloque 1, impuestos / SS / alquiler / suministros ────────
const REGLAS_FISCALES_Y_FIJOS = [
  // Impuestos / Hacienda — incluye "Impuesto:" como prefijo de Santander
  { re: /\baeat\b|agencia tributaria|abonare\s+a\.?\s*e\.?\s*a\.?\s*t/i,                    cat: 'IMPUESTOS' },
  { re: /^impuestos?\b|^impuesto:|domiciliacion impuesto|tributo|hacienda/i,                cat: 'IMPUESTOS' },
  { re: /\birpf\b|retenciones e ing|imp\.?\s*sociedades|imp\.?\s*s\/?\s*soc|s\/renta de no residente/i, cat: 'IMPUESTOS' },
  // IVA autoliquidación, recargos, DGT sanciones, Generalitat
  { re: /^\d{0,4}\s*iva\s+autoliquidaci|\biva\s+autoliquidaci|^iva\s|\brecargo\s+ejecutivo|dgt\s+sanciones?|sancion(es)?\s+(de\s+)?trafico|pago\s+recibo\s+de\s+generalitat/i, cat: 'IMPUESTOS' },
  // Tasas municipales (pagos a Ayuntamiento)
  { re: /(excmo\.?\s+)?ayto\.?|ayuntamiento|exmo\.?\s+ayunta/i,                              cat: 'IMPUESTOS' },

  // Seguridad Social — incluye las variantes truncadas que aparecen en Sabadell
  { re: /\btgss\b|tesoreria(\s+general)?\s+(de\s+la\s+)?seguridad\s+social/i,               cat: 'SS_LABORAL' },
  { re: /\bseguridad social\b|\bs\.?\s*sociale\b|\bss\/|seguros?\s+sociales/i,              cat: 'SS_LABORAL' },

  // Seguros (antes de ALQUILER porque "seguros allianz" no debe matchear)
  { re: /\bmapfre\b|\baxa\b|\ballianz\b|\bgenerali\b|liberty\s+seguros|\bmutua\b|\baseguradora\b|\bseguros\b|allianz/i, cat: 'SEGUROS' },

  // Alquileres — Silicius, Concepción Orive, Real Estate, SOCIMI, Overlease, Dialque, TGT Dialque, "Arrendamiento"
  // El patrón `alqui+ler|alqui+iler` tolera typos comunes ("Alquiiler" en extractos de Sabadell).
  { re: /alqui+ler|alqui+iler|arrendamiento|silicius|concepcion\s+orive|real\s+estate|\bsocimi\b|overlease|inmobil|fianza\s+local|fianza|dialque|tgt\s+dialque/i, cat: 'ALQUILER' },

  // Suministros de energía (luz + gas unificados en SUMINISTROS_ENERGIA — Ronda 4)
  { re: /\bnaturgy\b|repsol\s+gas|\bgas\s+natural\b|\bredexis\b/i,                          cat: 'SUMINISTROS_ENERGIA' },
  { re: /\biberdrola\b|\bendesa\b|\bendesax\b|\bi-?de\b|\b(i\s+de)\s+(redes|distribu)/i,    cat: 'SUMINISTROS_ENERGIA' },
  { re: /edp\s*comerc|fox\s*energia|total\s*energies|totalenergies|acc\.?green\s*ener|campo\s*luz|radius\s+business|green\s+ener|fons\s+energia|\bviesgo\b/i, cat: 'SUMINISTROS_ENERGIA' },
  // Agua — incluye Aigües (Elx), Aguas Municipales, AMAEM, EMUASA, etc.
  { re: /\bhidraqua\b|\bamaem\b|aguas\s+municipales|\bemuasa\b|\bcanal\s+de\s+isabel\s+ii\b|\baigues\b|\baigües\b|sanejament|aigua\s+i|\bagua\s+aigues\b|servicio\s+agua/i, cat: 'SUMINISTROS_AGUA' },
  // Telecom
  { re: /\bmovistar\b|\bvodafone\b|\borange\b|\btelefonica\b|\bmasmovil\b|\bjazztel\b|\blowi\b|\byoigo\b|\brepublic\s*wireless/i, cat: 'TELECOMUNICACIONES' },
  { re: /\bigualadana\b|\bglobal\s+solution\s+s/i,                                          cat: 'TELECOMUNICACIONES' },
];

// ─── Gastos: bloque 2, financiero y mantenimiento ─────────────────────
const REGLAS_FIN_Y_MANT = [
  // Financiero: préstamos, comisiones, devoluciones, leasing (cuidado con "overlease" que ya cayó en alquiler)
  { re: /liquidacion\s+periodica\s+prestamo|prestamo|leasing|aval|financiacion|descubierto/i, cat: 'FINANCIERO' },
  // Comisiones bancarias específicas del formato Sabadell: "Comision XXXXXXXXXX 01/02 NombreSociedad XXXXXXXXX"
  // 10 dígitos de número de cuenta al inicio. Evita matchear "Comision Por Instalacion O Mantenimiento" (que va a MANTENIMIENTO).
  { re: /^comisi[oó]nes?\s+\d{10}\b|^comisi[oó]nes?\s+sabadell\b|^comisi[oó]nes?\s+bs\b/i,    cat: 'FINANCIERO' },
  // Comisiones genéricas standalone y otros gastos bancarios típicos
  { re: /^comisiones?$|^comisi[oó]n\s+divisa|^intereses?\s+y\/?o\s+comisiones?\s+cuenta|^com\.?\s+por\s+(transferencia|cambio|recibo|cancelaci)/i, cat: 'FINANCIERO' },
  { re: /\bcomision(es)?\s+(banc|servicio|mantenim|tarjeta|transferenc|devolucion|sepa)/i,   cat: 'FINANCIERO' },
  { re: /\bcom\.?\s+mantenim|cuota\s+mantenimiento\s+cuenta|canon(\s+mantenim|\s+banc)?|comision\s+apertura/i, cat: 'FINANCIERO' },
  { re: /devolucion\s+recibo|gastos?\s+financieros?|interes(es)?\s+(deudor|prestamo)/i,    cat: 'FINANCIERO' },
  // Vehículos y leasing (v3): financieras de automóviles
  { re: /\bstellantis\b|volkswagen\s+(financial|leas|bank)|\bseat\s+financial|santander\s+consumer|bbva\s+autorenting|\brenting\b/i, cat: 'FINANCIERO' },
  // BBVA y otros bancos como destinatario explícito (no es nómina aunque sea transferencia)
  { re: /banco\s+bilbao\s+viscaya\s+argentaria|\bbbva\b|caixabank|kutxabank|banco\s+sabadell/i, cat: 'FINANCIERO' },

  // Mantenimiento: Leroy, ferretería, técnicos, obra, mobiliario, equipamiento.
  // "leory" tolera typo común en extractos manuales.
  { re: /\bleroy\s+merlin|\bleory\s+merlin|leroymerlin|\bbricomart\b|\bbrico\s*depot\b|\bferreteria/i, cat: 'MANTENIMIENTO' },
  { re: /\bmantenimiento\b|\breparacion\b|\bfontaneria\b|electricidad\s+(instalac|reparac)|tornilleria|sklum|conduce\s+revel|muebles\s+rosillo|ductoaire|cocinas\s+industriales/i, cat: 'MANTENIMIENTO' },
  { re: /\btecnico\s+frigorif|aire\s+acondic|climatizacion|extincion\s+incend|tienda\s+animales/i, cat: 'MANTENIMIENTO' },
  // Equipamiento / mobiliario / electrodomésticos / decoración
  { re: /ggm\s+gastro|bolsemack|\bikea\b|media\s*markt|\bworten\b|materiales\s+cano|maquinas\s+febal|ecoclima|fibraclim|decoraciones?\s+decomaber|inox\s+levante|escoda|argent\s*3d|argen\s*3d|\bpaypal\s*\*?temu|\btemu\b|alcomar\s+herrega/i, cat: 'MANTENIMIENTO' },
  // Más equipamiento, herrajes, electricidad y compras varias online
  { re: /new\s+matelsa|\bmatelsa\b|maquinaria\s+hosteler|saniagua|todoelectrico|electricas?\s+maisa|obramat|sumin\s+surec|thomann|aliexpress|\bobm\s+murcia\b|el\s+corte\s+electr|viveros\s+carmaet|discount_es|\bsanitarios?\b\s+y\s+griferia|electrod[ó]mestic|coop\s+electrica\s+benefica/i, cat: 'MANTENIMIENTO' },
  // Rotulación, imagen del local, timbrados de cocina
  { re: /rros\s+imagen|rios\s+imagen|timbrad[oa]s|\brotulaci[oó]n\b|cartel(er[ií]a)?/i,    cat: 'MANTENIMIENTO' },
  // Amazon (v3): genérico para herramientas/equipamiento/consumibles
  { re: /\bamazon\b|\bamz\b\s*mktp|amazon\s+(es|eu|web|marketplace|seller|pago)/i,           cat: 'MANTENIMIENTO' },
];

// ─── Gastos: bloque 2.5, servicios profesionales (gestoría, prevención) ──
// Se evalúa DESPUÉS de los proveedores específicos para que casos como
// "Restaurant Consulting Group" y "Mundo Franquicia Consulting" no caigan
// en gestoría genérica antes de su regla propia.
const REGLAS_SERVICIOS_PROF = [
  // Prevención de riesgos laborales y mutuas
  { re: /europreven|prevencion\s+(de\s+)?riesgos?|prevenci[óo]n\s+laboral|\bmutual?\b/i,     cat: 'SERVICIOS_PROF' },
  // Gestoría / asesoría / abogacía / notaría
  { re: /\bgestor[íi]a\b|\basesor(ia|ía|amiento|es?)?\b|abogad[oa]s?\b|\bnotaria\b|administradores?\s+de\s+fincas/i, cat: 'SERVICIOS_PROF' },
  // Consulting genérico — sólo si NO matchea consultings ya conocidos (que tienen su propia regla)
  { re: /\bconsulting\b/i,                                                                    cat: 'SERVICIOS_PROF' },
  // SaaS / software / hosting / herramientas online
  { re: /\badobe\b\s*(systems|creative|cc|stock|sign|acrobat|premiere|photoshop)?|adobe\.com/i, cat: 'SERVICIOS_PROF' },
  { re: /google[\s*]*one\b|google[\s*]*(workspace|drive|cloud)|\bgsuite\b|m365|office\s+365|\bmicrosoft\b|notion\.so|\bnotion\b|\bfigma\b|\bslack\b|\bzoom\.us\b|\bcanva\b|\bgithub\b|\bgitlab\b|atlassian|jira|capcut|hostinger|hello\s+ventures|app[-\s]?sorteos|sp\s+4shine|\bpromotty\b|soluciones\s+host|helloprint|tot[\s-]?digital|yalt\s+business/i, cat: 'SERVICIOS_PROF' },
  // Servicios externos a la operativa — RRHH, consultores nominales, ocio
  { re: /\bangel\s+linares\b|\balcomar\b|restaurant\s+consulting|\bociobar\b|societat\s+valenciana|mundo[\s-]?franquicia/i, cat: 'SERVICIOS_PROF' },
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

  // Lácteos — incluye Entrepinares (queso, movido aquí en Ronda 4)
  { re: /\bcampoluz\b|\bacesur\b|\bpascual\b|\bkaiku\b|\bpuleva\b|central\s+lechera|\bquesos?\b|\bleche\b|\bentre\.?pinares\b/i, cat: 'PROVEEDOR_LACTEOS' },

  // Fritos
  { re: /eurofrits|\bmccain\b|patatas?\s+(prefritas|congeladas)|frito\s+congelado/i,         cat: 'PROVEEDOR_FRITAS' },

  // Panadería (Europastry, Brioche, Landfood)
  { re: /europastry|\blandfood\b|land\s+food|brioche|panaderia|pasteleria|\bpan\s+(de|congelad|preco)/i, cat: 'PROVEEDOR_PANADERIA' },

  // Carnes
  { re: /don\s+ha[mn]gus|\bhangus\b|carnicas?\s+\w+|porcinos?\s+\w+|\bpollo\s+(fresco|congelad|despiece)|\bpavo\s+(fresco|congelad)/i, cat: 'PROVEEDOR_CARNES' },
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
// Excluye "nomina|nóminas|salario|paga" — esas indican nómina explícita.
const PISTAS_NO_NOMINA = /\bfactura\b|\balquiler\b|arrendamiento|\bfianza\b|\brecibo\b|\bimpuesto\b|\bprestamo\b|aportacion/i;

// Pistas explícitas de nómina dentro del concepto (cualquier parte del string).
const PISTA_NOMINA_EXPLICITA = /\bnomin[ae]s?\b|^nomina\s+a\b|concepto:\s*nomina|traspaso:\s*nomina|\bsalario\b|\bsueldo\b|\bnomina\s+leonardo\b/i;

function esTransferenciaPersonaFisica(concepto) {
  if (!concepto) return false;
  const c = String(concepto);

  // 0) Pista explícita: cualquier mención a "nómina" / "salario" / "Concepto: Nomina"
  //    cuando el concepto NO es una factura/alquiler/recibo bancario.
  if (PISTA_NOMINA_EXPLICITA.test(c) && !PISTAS_NO_NOMINA.test(c)) return true;

  // 1) Debe empezar con TRANSFERENCIA / Transferencia ... A {nombre}
  //    Aceptamos también "Transferencia Inmediata A Favor De {nombre}".
  let nombre = null;
  let m = /^transferencia(?:\s+\w+)?\s+a\s+favor\s+de\s+([A-Za-zÁÉÍÓÚÑáéíóúñ.,\s]+?)(?:\s+concepto|\s+nº|\s+ref\.|$)/i.exec(c);
  if (m) nombre = m[1];
  if (!nombre) {
    m = /^transferencia(?:\s+\w+)?\s+a\s+([A-Za-zÁÉÍÓÚÑáéíóúñ.,\s]+?)(?:\s+concepto|\s+nº|\s+ref\.|$)/i.exec(c);
    if (m) nombre = m[1];
  }
  if (!nombre) return false;

  if (PISTAS_NO_NOMINA.test(c)) return false;
  if (PISTAS_EMPRESA.test(nombre)) return false;

  // Acepta tokens que empiezan con mayúscula O son stopwords típicos en
  // nombres compuestos en español/portugués: "Francisco de Asis Fernandez",
  // "Joao da Silva", "Maria del Carmen". Necesita al menos 2 tokens
  // "nombre" (mayúsculas) y ningún token de empresa.
  const NOMBRE_STOP = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'y', 'da', 'do', 'das', 'dos']);
  const tokens = nombre.trim().replace(/[,.]/g, '').split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 6) return false;
  let mayusCount = 0;
  for (const t of tokens) {
    if (NOMBRE_STOP.has(t.toLowerCase())) continue;
    // Token "nombre": Mayuscula+resto letras (Title) o TODO_MAYUSCULAS
    if (/^[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ.]+$/.test(t) || /^[A-ZÁÉÍÓÚÑ]{2,}$/.test(t)) {
      mayusCount++;
    } else {
      return false;
    }
  }
  return mayusCount >= 2;
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
  // 0) comisiones bancarias formato Sabadell — ANTES que INTRAGRUPO.
  //    "COMISIONES 0354... AIRES BURGER BAR MURCIA" contiene el nombre de
  //    la sociedad porque es a quien el banco cobra, pero NO es transferencia
  //    intra-grupo.
  if (REGEX_COMISIONES_BANCARIAS.test(concepto)) return 'FINANCIERO';
  // 1) intra-grupo
  if (esIntraGrupo(concepto)) return 'INTRAGRUPO';
  // 2) publicidad digital / RRHH digital / delivery (taxonomía v3)
  //    Se evalúa temprano para que "Compra Google ads..." vaya a PUBLICIDAD
  //    en lugar de caer en PROVEEDOR_OTROS por la regla genérica de Compra.
  for (const r of REGLAS_DIGITAL_Y_RRHH) if (r.re.test(concepto)) return r.cat;
  // 3) nómina explícita (palabra "NOMINA" en el concepto) — antes que fiscales
  //    para que "NOMINA A YANINA" o "Traspaso: Nomina Daniel" no caigan en OTROS.
  if (PISTA_NOMINA_EXPLICITA.test(concepto) && !PISTAS_NO_NOMINA.test(concepto)) return 'NOMINAS';
  // 4) fiscales y fijos (incluye alquiler con tolerancia a typos)
  for (const r of REGLAS_FISCALES_Y_FIJOS) if (r.re.test(concepto)) return r.cat;
  // 5) financiero y mantenimiento
  for (const r of REGLAS_FIN_Y_MANT) if (r.re.test(concepto)) return r.cat;
  // 6) proveedores específicos (Restaurant Consulting Group, Mundo Franquicia, etc.)
  for (const r of REGLAS_PROVEEDORES) if (r.re.test(concepto)) return r.cat;
  // 7) servicios profesionales genéricos (gestoría, asesoría, consulting que no
  //    matcheó arriba) — después de los proveedores específicos.
  for (const r of REGLAS_SERVICIOS_PROF) if (r.re.test(concepto)) return r.cat;
  // 8) nóminas heurística por transferencia a persona física
  if (esTransferenciaPersonaFisica(concepto)) return 'NOMINAS';
  // 9) PROVEEDOR_OTROS si parece operación comercial
  if (esOperacionComercial(concepto)) return 'PROVEEDOR_OTROS';
  // 10) fallback
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
