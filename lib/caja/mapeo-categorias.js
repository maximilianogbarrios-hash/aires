// Mapeo subtipo libre (caja) → categoría canónica (taxonomía banco
// ab_categorias). Permite unificar los desgloses de gasto banco+efectivo
// en la tab "Flujo Total".
//
// Regla: el primer patrón que matcha gana. Si nada matchea, devuelve
// 'SIN_CATEGORIA_CAJA' — esos movs se listan en la sección "Sin
// categoría — pendientes" para que admin/socio los reclasifiquen.
//
// Orden de prioridad importante: GASTOS_DIRECCION antes que NOMINAS
// porque "PAGO DANI Y MAXI" (socios) debe ir a dirección, no a
// nóminas; pero "PAGO MARIUS" / "PAGO CRISTIAN" (empleados) sí va a
// NOMINAS — capturado por el patrón genérico /pago\s+[a-z]+$/.

const PATRONES_EGRESO = [
  // Dirección / socios (antes que NOMINAS para que "DANI" y "MAXI" no
  // caigan en nóminas).
  { rx: /direcci[oó]n|\bmaxi\b|\bdani\b|maxi\s+y\s+dani|dani\s+y\s+maxi|prorrateo\s+desde/i, cat: 'GASTOS_DIRECCION' },
  // Nóminas y similares.
  { rx: /sueld|n[oó]mina|liq\.?\s*final|^pago\s+[a-zÀ-ſ]+\s*$|^[a-zÀ-ſ]+\s+marius$|pago\s+(cristian|marius)/i, cat: 'NOMINAS' },
  // Seguridad Social.
  { rx: /\bss\b|seguridad\s*social|cotizaci[oó]n|tgss/i, cat: 'SS_LABORAL' },
  // Alquileres.
  { rx: /alquil|renta\b|arrend/i, cat: 'ALQUILER' },
  // Proveedores específicos (orden — más específicos primero).
  { rx: /makro/i,                                            cat: 'PROVEEDOR_MAKRO' },
  { rx: /carnic|carn[eé]s|hamgus|don\s+hangus|mulas?|polo/i, cat: 'PROVEEDOR_CARNES' },
  { rx: /panad|panet|^pan\s/i,                               cat: 'PROVEEDOR_PANADERIA' },
  { rx: /bebid|coca|cerveza|cervez|refresc|aguad?\s*natural/i, cat: 'PROVEEDOR_BEBIDAS' },
  { rx: /lacteo|queso|leche|yogur/i,                         cat: 'PROVEEDOR_LACTEOS' },
  { rx: /aceit|oliva/i,                                       cat: 'PROVEEDOR_ACEITES' },
  { rx: /papas|patatas|fritas?\b/i,                          cat: 'PROVEEDOR_FRITAS' },
  { rx: /pack|envase|cubierto|servilleta|caja[s]?\s*carton/i, cat: 'PROVEEDOR_PACKAGING' },
  { rx: /limpi|jab[oó]n|detergente|lej[ií]a|papel\s+hig/i,   cat: 'PROVEEDOR_LIMPIEZA' },
  // Suministros.
  { rx: /luz|electric|iberdrola|endesa|naturgy|edp/i,         cat: 'SUMINISTROS_ENERGIA' },
  { rx: /\bagua\b|aigua|hidraqua/i,                            cat: 'SUMINISTROS_AGUA' },
  { rx: /internet|tel[eé]fon|wifi|fibra|m[oó]vil|orange|vodafone|movistar|jazztel/i, cat: 'TELECOMUNICACIONES' },
  // Servicios profesionales y obras.
  { rx: /honor|asesor|gestor|abogad|fiscal|notari/i,          cat: 'SERVICIOS_PROF' },
  { rx: /obra|reform|manten|reparac|arregl|migraci[oó]n/i,    cat: 'MANTENIMIENTO' },
  // Publicidad.
  { rx: /publici|marketing|facebook|google\s*ads|instagram|tiktok/i, cat: 'PUBLICIDAD' },
  // Impuestos y financiero.
  { rx: /impuest|\biva\b|hacienda|modelo\s*\d|tasa|recibo\s+suma/i, cat: 'IMPUESTOS' },
  { rx: /seguro|insurance/i,                                  cat: 'SEGUROS' },
  { rx: /prestam|cuota\s*prest/i,                             cat: 'PRESTAMOS' },
  { rx: /comisi[oó]n|cargo\s*banc/i,                          cat: 'FINANCIERO' },
  // Vehículos.
  { rx: /veh[ií]culo|gasolin|combustib|coche|moto\b|peaje/i, cat: 'GASTOS_VEHICULOS' },
  { rx: /equip|mobiliari|mueble|herram|maquin/i,              cat: 'EQUIPAMIENTO' },
  { rx: /dieta|comida\s*personal/i,                           cat: 'DIETAS' },
];

const PATRONES_INGRESO = [
  // Subtipo libre "cierre" / "cierre caja" — los cierres diarios de TPV
  // que se cargan a la caja como ingresos.
  { rx: /\bcierre/i,                              origen: 'Cierres caja' },
  // "Prorrateo desde X" sólo en ingresos — re-distribuciones de cuentas
  // centralizadas a los locales. Marca para auditoría pero no es venta.
  { rx: /prorrateo\s+desde/i,                     origen: 'Prorrateos entrantes' },
  // Cualquier ingreso etiquetado explícitamente como devolución / abono.
  { rx: /devoluci[oó]n|reembolso|abono/i,         origen: 'Devoluciones / abonos' },
];

// Patrones para clasificar INGRESOS BANCARIOS por origen (en su CONCEPTO).
// La taxonomía es deliberadamente acotada — los 4 grandes orígenes son
// liquidaciones TPV (Santander), ABONO TPV (Sabadell), Glovo, y un
// catch-all "Otros banco".
const PATRONES_INGRESO_BANCO = [
  { rx: /^liquidacion\s+efectuada/i,    origen: 'TPV liquidaciones (Santander)' },
  { rx: /^abono\s+tpv/i,                origen: 'TPV abonos (Sabadell)' },
  { rx: /glovo|glovoapp/i,              origen: 'Glovo' },
  { rx: /just\s*eat|justeat/i,          origen: 'Just Eat' },
  { rx: /uber\s*eats|ubereats/i,        origen: 'Uber Eats' },
  { rx: /bizum/i,                        origen: 'Bizum' },
  { rx: /stripe|promotty/i,             origen: 'Stripe' },
];

function categoriaDeSubtipoCaja(subtipo) {
  const s = String(subtipo || '').trim();
  if (!s) return 'SIN_CATEGORIA_CAJA';
  for (const p of PATRONES_EGRESO) if (p.rx.test(s)) return p.cat;
  return 'SIN_CATEGORIA_CAJA';
}

function origenIngresoCaja(subtipo) {
  const s = String(subtipo || '').trim();
  if (!s) return 'Otros ingresos caja';
  for (const p of PATRONES_INGRESO) if (p.rx.test(s)) return p.origen;
  return 'Otros ingresos caja';
}

function origenIngresoBanco(concepto) {
  const c = String(concepto || '').trim();
  if (!c) return 'Otros banco';
  for (const p of PATRONES_INGRESO_BANCO) if (p.rx.test(c)) return p.origen;
  return 'Otros banco';
}

module.exports = {
  PATRONES_EGRESO, PATRONES_INGRESO, PATRONES_INGRESO_BANCO,
  categoriaDeSubtipoCaja, origenIngresoCaja, origenIngresoBanco,
};
