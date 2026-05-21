// scripts/recategorizar-movimientos.js — recategorización masiva de
// ab_movimientos según la nueva taxonomía v2 (lib/bank/categorizer.js).
//
// Uso:
//   node scripts/recategorizar-movimientos.js            → dry-run + log
//   node scripts/recategorizar-movimientos.js --apply    → UPDATE real
//   node scripts/recategorizar-movimientos.js --apply --no-recalc-resumen
//
// Sólo procesa movimientos con importe < 0 (gastos). Ingresos no se tocan.
// Documenta en scripts/utils/recategorizacion-log.md las decisiones tomadas
// y un resumen post-ejecución por categoría.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool, many, query, tx } = require('../lib/db');
const { categorizar } = require('../lib/bank/categorizer');
const { recalcResumenMensual } = require('../lib/bank/db');

const APPLY = process.argv.includes('--apply');
const SKIP_RECALC = process.argv.includes('--no-recalc-resumen');

const LOG_PATH = path.join(__dirname, 'utils', 'recategorizacion-log.md');

function fmtEUR(v) {
  return new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 }).format(Math.round(v)) + ' €';
}

async function main() {
  console.log('[recat] modo:', APPLY ? 'APPLY (UPDATE real)' : 'DRY-RUN (sin escribir)');
  console.log('[recat] cargando movimientos importe<0…');

  const rows = await many(
    `SELECT id, concepto, importe::float8 AS importe, categoria AS cat_old,
            sociedad_id, periodo
       FROM ab_movimientos
      WHERE importe < 0
      ORDER BY id`
  );
  console.log(`[recat] ${rows.length} movimientos`);

  // Recalcular categoría
  let cambios = 0, iguales = 0;
  const porNueva = new Map();     // newCat -> {n, total, ids[], cambios:Map<oldCat,n>}
  const transiciones = new Map(); // 'old -> new' -> {n, total}
  const muestraPorTransicion = new Map(); // misma key -> [conceptos]

  for (const r of rows) {
    const nueva = categorizar(r.concepto, +r.importe);
    const old = r.cat_old || 'GASTO_OTROS';
    const cur = porNueva.get(nueva) || { n: 0, total: 0, ids: [], cambios: new Map() };
    cur.n++;
    cur.total += Math.abs(+r.importe);
    cur.ids.push(r.id);
    if (nueva !== old) {
      cambios++;
      cur.cambios.set(old, (cur.cambios.get(old) || 0) + 1);
      const k = `${old} → ${nueva}`;
      const t = transiciones.get(k) || { n: 0, total: 0 };
      t.n++; t.total += Math.abs(+r.importe);
      transiciones.set(k, t);
      const ms = muestraPorTransicion.get(k) || [];
      if (ms.length < 5) ms.push(r.concepto.slice(0, 80));
      muestraPorTransicion.set(k, ms);
    } else {
      iguales++;
    }
    porNueva.set(nueva, cur);
  }

  console.log(`[recat] resumen: cambios=${cambios}  iguales=${iguales}`);
  console.log('--- distribución NUEVA ---');
  const porNuevaSorted = [...porNueva.entries()].sort((a, b) => b[1].total - a[1].total);
  for (const [cat, info] of porNuevaSorted) {
    console.log(`  ${cat.padEnd(22)} ${String(info.n).padStart(5)} movs · ${fmtEUR(info.total).padStart(12)}`);
  }

  // Periodos afectados (para recalc resumen).
  const periodosAfectados = new Set();
  for (const r of rows) {
    const old = r.cat_old || 'GASTO_OTROS';
    const nueva = categorizar(r.concepto, +r.importe);
    if (nueva !== old && r.sociedad_id && r.periodo) {
      periodosAfectados.add(`${r.sociedad_id}|${r.periodo}`);
    }
  }
  console.log(`[recat] sociedades×periodos a recalcular: ${periodosAfectados.size}`);

  // Aplicar UPDATE masivo por categoría nueva.
  if (APPLY && cambios > 0) {
    console.log('[recat] aplicando UPDATEs por lotes de categoría…');
    let updatesAcum = 0;
    await tx(async (client) => {
      for (const [cat, info] of porNueva.entries()) {
        // Sólo updateamos los IDs que efectivamente cambian.
        const idsAUpdate = [];
        for (const id of info.ids) {
          const r = rows.find((x) => x.id === id);
          if ((r.cat_old || 'GASTO_OTROS') !== cat) idsAUpdate.push(id);
        }
        if (!idsAUpdate.length) continue;
        // Lotes de 1000 para no exceder parámetros.
        for (let i = 0; i < idsAUpdate.length; i += 1000) {
          const slice = idsAUpdate.slice(i, i + 1000);
          const r = await client.query(
            'UPDATE ab_movimientos SET categoria=$1 WHERE id = ANY($2::int[])',
            [cat, slice]
          );
          updatesAcum += r.rowCount;
        }
      }
    });
    console.log(`[recat] UPDATE total filas: ${updatesAcum}`);
  } else if (!APPLY) {
    console.log('[recat] DRY-RUN — no se modificó la DB. Pasá --apply para aplicar.');
  } else {
    console.log('[recat] sin cambios necesarios.');
  }

  // Recalcular ab_resumen_mensual.
  if (APPLY && !SKIP_RECALC && periodosAfectados.size > 0) {
    console.log('[recat] recalculando ab_resumen_mensual…');
    let i = 0;
    for (const k of periodosAfectados) {
      const [soc, per] = k.split('|');
      await recalcResumenMensual(soc, per);
      i++;
      if (i % 10 === 0) console.log(`  ${i}/${periodosAfectados.size}`);
    }
    console.log(`[recat] resúmenes mensuales recalculados: ${i}`);
  }

  // Escribir el log markdown.
  const ts = new Date().toISOString();
  let md = '';
  md += `# Log de recategorización de \`ab_movimientos\`\n\n`;
  md += `Última ejecución: **${ts}** — modo: **${APPLY ? 'APPLY' : 'DRY-RUN'}**\n\n`;
  md += `Total movimientos procesados (importe<0): **${rows.length}**\n`;
  md += `- Cambios de categoría: **${cambios}**\n`;
  md += `- Sin cambios: **${iguales}**\n`;
  md += `- Sociedades×periodos a recalcular: **${periodosAfectados.size}**\n\n`;

  md += `## Distribución final por categoría (nueva taxonomía)\n\n`;
  md += `| Categoría | Nº movs | Total € |\n|---|---:|---:|\n`;
  for (const [cat, info] of porNuevaSorted) {
    md += `| \`${cat}\` | ${info.n} | ${fmtEUR(info.total)} |\n`;
  }
  md += `\n`;

  md += `## Transiciones (categoría vieja → categoría nueva)\n\n`;
  md += `| Transición | Nº | Total € | Ejemplos |\n|---|---:|---:|---|\n`;
  const transSorted = [...transiciones.entries()].sort((a, b) => b[1].total - a[1].total);
  for (const [k, info] of transSorted) {
    const ejs = (muestraPorTransicion.get(k) || []).map((s) => `\`${s.replace(/\|/g, '/')}\``).join('<br>');
    md += `| \`${k}\` | ${info.n} | ${fmtEUR(info.total)} | ${ejs} |\n`;
  }
  md += `\n`;

  md += `## Decisiones tomadas\n\n`;
  md += `### Ronda 1 (taxonomía v2 inicial)\n\n`;
  md += `- **INTRAGRUPO** se aplica antes que cualquier otra regla: cualquier transferencia con "Aires Burger Bar Murcia", "Aires Burger Bar Benidorm", "Aires Alicante", "Smart Aires", "Grupo Hostelero Aires", "Aires Murcia" o "Aires Benidorm" en el concepto queda como INTRAGRUPO.\n`;
  md += `- **Naturgy** → SUMINISTROS_GAS por convención (la empresa comercializa ambos; el usuario listó Naturgy en GAS).\n`;
  md += `- **Campoluz** y **Acesur** → PROVEEDOR_LACTEOS por instrucción explícita del usuario, aunque Campoluz comercializa también energía.\n`;
  md += `- **Entrepinares** → PROVEEDOR_CARNES por instrucción explícita del usuario, aunque su core es queso.\n`;
  md += `- **NOMINAS (heurística)** se infiere cuando el concepto matchea \`^TRANSFERENCIA [INMEDIATA]? A {Nombre Apellido…}\` con 2-5 tokens estilo nombre, sin sufijos legales (SL, SA, SLU, GMBH, etc.) y sin keywords como "Factura", "Alquiler", "Fianza", "Recibo".\n`;
  md += `- **Silicius, Concepción Orive, Overlease** → ALQUILER (real estate / SOCIMI).\n`;
  md += `- Fallback: si un concepto matchea patrón de "operación comercial" (Transferencia, Recibo, Compra) pero ninguna regla específica, va a **PROVEEDOR_OTROS**. Si no parece operación comercial (devoluciones, regularizaciones, traspasos internos sin destinatario claro), va a **OTROS**.\n\n`;
  md += `### Ronda 4 — objetivo ≤30 grupos\n\n`;
  md += `Objetivo del usuario: máximo 30 grupos visibles en la pestaña Proveedores.\n\n`;
  md += `**Bug fix crítico**: la regla \`^Comisiones \\d{10}\` fallaba porque las \"COMISIONES 0354... AIRES BURGER BAR MURCIA\" caían primero en INTRAGRUPO (la regla de intra-grupo se evaluaba antes y matcheaba por el nombre de la sociedad). Se agregó un check pre-INTRAGRUPO (\`REGEX_COMISIONES_BANCARIAS = /^\\s*comisi[oó]nes?\\s+\\d{4,}/i\`) que enruta esas filas a FINANCIERO antes de chequear intra-grupo.\n\n`;
  md += `**Nueva categoría SUMINISTROS_ENERGIA**: unifica SUMINISTROS_LUZ + SUMINISTROS_GAS en un único bucket (las dos categorías legacy quedan en CATEGORIAS_GASTO por back-compat pero no se asignan más). Incluye Iberdrola, Endesa, ENDESAX, i-DE, Naturgy, Repsol Gas, Fox Energia, TotalEnergies, EDP, ACC Green Energy, **Fons Energia**, **Viesgo**, Campo Luz, Radius Business.\n\n`;
  md += `**Colapso a nombres canónicos genéricos** (Ronda 4):\n`;
  md += `- Iberdrola/Endesa/Naturgy/etc. → \`Energía y Gas\` (categoria SUMINISTROS_ENERGIA).\n`;
  md += `- Leroy Merlin/IKEA/Worten/Media Markt/Argent3D/RROS IMAGEN/TIMBRADOS/Amazon → \`Mantenimiento y Equipamiento\` (MANTENIMIENTO).\n`;
  md += `- Adobe/Google One/Microsoft/Promotty/Hostinger/OCIOBAR/Restaurant Consulting/Yalt/Mundofranquicia/Alcomar/Angel Linares/Societat Valenciana/Europreven/JobToday/Asesorías → \`Servicios Profesionales\` (SERVICIOS_PROF).\n`;
  md += `- Préstamos/Comisiones/BBVA/CaixaBank/Sabadell/Santander Consumer/Renting → \`Banco - Operaciones\` (FINANCIERO).\n`;
  md += `- TGSS/S.SOCIALE/SS//Seguridad Social → \`Seguridad Social\` (SS_LABORAL).\n`;
  md += `- Mapfre/AXA/Allianz/Generali/cualquier seguro → \`Seguros\` (SEGUROS).\n`;
  md += `- Google Ads/Meta Ads/Facebk/TikTok/LinkedIn Ads → \`Publicidad Online\` (PUBLICIDAD).\n`;
  md += `- Hidraqua/EMUASA/AMAEM/Aigües → \`Aigües / Servicio Agua\` (SUMINISTROS_AGUA).\n`;
  md += `- **ALQUILER** colapsado completo: cualquier movimiento con \`categoria='ALQUILER'\` (Silicius, Dialque, Innovestment, Concepción Orive, Bernardo Ortega, todos los arrendadores persona física) → \`Alquileres y Arrendamientos\`. Necesario para llegar a ≤30 grupos porque había 25+ arrendadores individuales.\n\n`;
  md += `**Movido entre categorías**:\n`;
  md += `- **Entrepinares** de PROVEEDOR_CARNES → **PROVEEDOR_LACTEOS** (es queso; corrección del usuario).\n`;
  md += `- **Alcomar** de MANTENIMIENTO → SERVICIOS_PROF (era Alcomar Herrega SL; el user lo lista como servicios prof).\n\n`;
  md += `**Proveedores específicos preservados** (mantienen nombre individual porque el módulo Pedidos los necesita por nombre canónico para el mix MP): Carnicas Mulas, Don Hamgus, Carnicas Garcia, Makro, Eurofrits, Coca-Cola, Aceites Millas, Europastry, Brioche de Juanito, Landfood, Kauapack, Diversey, Ecolab, Mahou, Heineken, Distribuciones Batoy, Elan Foods, Avimed, Gardoy, Entrepinares.\n\n`;
  md += `**Rollup en endpoint /api/v1/bancos/proveedores** (\`Proveedores Menores\`):\n`;
  md += `- Pasada 1 — threshold del usuario: \`count<5 AND total<2000€\` → bucket "Proveedores Menores".\n`;
  md += `- Pasada 2 — cap top-N (\`max_grupos\` default 30): si tras la pasada 1 siguen >30 grupos, se mantienen los top-29 por total y el resto va al bucket. Garantía dura ≤30 grupos visibles en la UI.\n`;
  md += `- Ambos thresholds son configurables vía query params (\`menores_min_tx\`, \`menores_min_eur\`, \`max_grupos\`).\n\n`;
  md += `**Decisión tomada sin preguntar**: el spec del usuario menciona thresholds 5/2000 con AND. Con esos thresholds quedaban 115 grupos visibles (lejos del objetivo ≤30). Por eso se agregó una segunda pasada cap top-N. La pasada del usuario sigue aplicándose primero (criterio explícito), y la cap top-N actúa sólo si es necesaria. Documentado para que el operador entienda que el cap visual NO modifica la DB ni la granularidad de normalizarProveedor (sigue devolviendo los nombres específicos cuando se consume desde otros endpoints como Pedidos/mix).\n\n`;
  md += `**Resultado**: 2194 movimientos reclasificados, 60 resúmenes mensuales recalculados.\n\n`;
  md += `### Ronda 3 (comisiones bancarias + nóminas con stopwords + SaaS + Facebook Ads)\n\n`;
  md += `Objetivo: bajar PROVEEDOR_OTROS y OTROS reagrupando los conceptos más frecuentes que caían en el cubo genérico.\n\n`;
  md += `- **Comisiones bancarias Sabadell**: regex \`^comisi[oó]nes?\\s+\\d{10}\` (formato "Comision XXXXXXXXXX 01/02 NombreSociedad XXXXXXXXX") → **FINANCIERO** / proveedor \`Comisiones Bancarias Sabadell\`. También \`^COMISIONES$\`, \`^COMISIÓN DIVISA NO EURO\`, \`^INTERESES Y/O COMISIONES CUENTA\` → FINANCIERO.\n`;
  md += `- **Comisiones de TPV** (\`Comision Por Instalacion O Mantenimiento De Tpv 0049...\`) se MANTIENEN en MANTENIMIENTO porque la regex de financiero exige el dígito al **inicio** del concepto, no en medio.\n`;
  md += `- **Nóminas — stopwords en nombres compuestos**: \`esTransferenciaPersonaFisica\` ahora acepta \`de\`, \`del\`, \`la\`, \`las\`, \`el\`, \`los\`, \`y\`, \`da\`, \`do\`, \`das\`, \`dos\` como filler entre tokens de nombre. Necesita ≥2 tokens con mayúscula (Title o TODO MAYUSCULAS). Recupera "Francisco de Asis Fernandez", "Joao da Silva", "Maria del Carmen" etc.\n`;
  md += `- **IVA autoliquidación**: \`^\\d{0,4}\\s*iva\\s+autoliquidaci\` → IMPUESTOS / proveedor \`IVA Autoliquidación\`.\n`;
  md += `- **DGT sanciones + Generalitat Valenciana** → IMPUESTOS.\n`;
  md += `- **SERVICIOS_PROF** (SaaS / software / hosting): Adobe Systems, Google One/Workspace, Microsoft/Office 365, CapCut, Hostinger, Hello Ventures BV, App-Sorteos, 4Shine, Promotty, Soluciones Host, Helloprint, TOT-Digital, Yalt Business/Magical Insights.\n`;
  md += `- **PUBLICIDAD** ahora matchea Facebook ads truncados en Sabadell: \`\\bfacebk\\b\`, \`fb.me/ads\` → proveedor \`Meta Ads (Facebook/Instagram)\`.\n`;
  md += `- **MANTENIMIENTO** ampliado: New Matelsa, Maquinaria Hostelería TIE, Saniagua SL, TodoElectrico, Eléctricas Maisa, Obramat, Sumin Surec, Thomann, AliExpress, OBM Murcia, Viveros Carmaet, Coop. Eléctrica Benéfica San Francisco.\n\n`;
  md += `**Resultado**: cambios=866. OTROS bajó de 645 a 88 movimientos. FINANCIERO captura 604 comisiones bancarias nuevas. SERVICIOS_PROF y PUBLICIDAD ya tienen contenido real (147 y 136 movs respectivamente). PROVEEDOR_OTROS baja de 2676 a 2367 movimientos.\n\n`;
  md += `### Ronda 2 (recategorización de huérfanos)\n\n`;
  md += `- **NOMINAS explícita**: ahora se prioriza la palabra "nomina/salario/sueldo" presente en el concepto antes de aplicar fiscales/mantenimiento. Esto recupera "NOMINA A YANINA", "Traspaso: Nomina Daniel", "Concepto: Nomina Leonardo Rodriguez" que antes caían en OTROS o PROVEEDOR_OTROS.\n`;
  md += `- **Dialque / TGT Dialque** → ALQUILER (arrendamiento de centros comerciales y franquicia hostelera, identificados manualmente como alquiler).\n`;
  md += `- **Aigües / Sanejament / Servicio Agua** → SUMINISTROS_AGUA (Aigües i Sanejament d'Elx y similares).\n`;
  md += `- **Ayuntamiento / Excmo. Ayto.** → IMPUESTOS (tasas municipales).\n`;
  md += `- **GGM Gastro, Bolsemack, IKEA, Media Markt, Worten, Materiales Cano, Maquinas Febal, Ecoclima, Fibraclim, Decoraciones Decomaber, Inox Levante, Escoda Elche, Argent3D, Temu/PayPal Temu, Alcomar Herrega** → MANTENIMIENTO (equipamiento, mobiliario, climatización, electrodomésticos, decoración).\n`;
  md += `- **Google Ads, JobToday, Mundo Franquicia Consulting, TOT-Digital, Societat Valenciana Fira, Soluciones Host, AVIMED, 4Shine, Etihad/Emirates** → PROVEEDOR_OTROS (servicios no MP; sin categoría dedicada para preservar la convención de 22 categorías).\n`;
  md += `- **Landfood** ahora también matchea \`land\\s+food\` (sin guion).\n`;
  md += `- **Brico Depot** ahora matchea con y sin espacio (\`\\bbrico\\s*depot\\b\`).\n`;
  md += `- **Embargo judicial** → OTROS (no es proveedor ni gasto recurrente).\n\n`;

  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.writeFileSync(LOG_PATH, md, 'utf8');
  console.log(`[recat] log escrito: ${LOG_PATH}`);
}

main()
  .then(() => pool.end())
  .catch((e) => { console.error('[recat] error:', e); pool.end().finally(() => process.exit(1)); });
