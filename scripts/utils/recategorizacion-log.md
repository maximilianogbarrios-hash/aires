# Log de recategorización de `ab_movimientos`

Última ejecución: **2026-05-21T08:25:53.443Z** — modo: **APPLY**

Total movimientos procesados (importe<0): **9921**
- Cambios de categoría: **0**
- Sin cambios: **9921**
- Sociedades×periodos a recalcular: **0**

## Distribución final por categoría (nueva taxonomía)

| Categoría | Nº movs | Total € |
|---|---:|---:|
| `INTRAGRUPO` | 1688 | 1.087.738 € |
| `PROVEEDOR_CARNES` | 566 | 566.929 € |
| `PROVEEDOR_OTROS` | 2909 | 560.606 € |
| `ALQUILER` | 621 | 489.225 € |
| `NOMINAS` | 397 | 470.705 € |
| `SS_LABORAL` | 140 | 438.099 € |
| `SUMINISTROS_LUZ` | 556 | 302.840 € |
| `IMPUESTOS` | 135 | 221.143 € |
| `PROVEEDOR_MAKRO` | 660 | 197.561 € |
| `MANTENIMIENTO` | 586 | 171.125 € |
| `PROVEEDOR_PANADERIA` | 76 | 137.945 € |
| `PROVEEDOR_FRITAS` | 125 | 127.068 € |
| `PROVEEDOR_BEBIDAS` | 245 | 95.800 € |
| `PROVEEDOR_ACEITES` | 229 | 88.460 € |
| `PROVEEDOR_PACKAGING` | 181 | 66.632 € |
| `FINANCIERO` | 51 | 47.465 € |
| `SEGUROS` | 48 | 28.395 € |
| `SUMINISTROS_AGUA` | 50 | 15.474 € |
| `OTROS` | 645 | 14.998 € |
| `TELECOMUNICACIONES` | 13 | 2941 € |

## Transiciones (categoría vieja → categoría nueva)

| Transición | Nº | Total € | Ejemplos |
|---|---:|---:|---|

## Decisiones tomadas

### Ronda 1 (taxonomía v2 inicial)

- **INTRAGRUPO** se aplica antes que cualquier otra regla: cualquier transferencia con "Aires Burger Bar Murcia", "Aires Burger Bar Benidorm", "Aires Alicante", "Smart Aires", "Grupo Hostelero Aires", "Aires Murcia" o "Aires Benidorm" en el concepto queda como INTRAGRUPO.
- **Naturgy** → SUMINISTROS_GAS por convención (la empresa comercializa ambos; el usuario listó Naturgy en GAS).
- **Campoluz** y **Acesur** → PROVEEDOR_LACTEOS por instrucción explícita del usuario, aunque Campoluz comercializa también energía.
- **Entrepinares** → PROVEEDOR_CARNES por instrucción explícita del usuario, aunque su core es queso.
- **NOMINAS (heurística)** se infiere cuando el concepto matchea `^TRANSFERENCIA [INMEDIATA]? A {Nombre Apellido…}` con 2-5 tokens estilo nombre, sin sufijos legales (SL, SA, SLU, GMBH, etc.) y sin keywords como "Factura", "Alquiler", "Fianza", "Recibo".
- **Silicius, Concepción Orive, Overlease** → ALQUILER (real estate / SOCIMI).
- Fallback: si un concepto matchea patrón de "operación comercial" (Transferencia, Recibo, Compra) pero ninguna regla específica, va a **PROVEEDOR_OTROS**. Si no parece operación comercial (devoluciones, regularizaciones, traspasos internos sin destinatario claro), va a **OTROS**.

### Ronda 2 (recategorización de huérfanos)

- **NOMINAS explícita**: ahora se prioriza la palabra "nomina/salario/sueldo" presente en el concepto antes de aplicar fiscales/mantenimiento. Esto recupera "NOMINA A YANINA", "Traspaso: Nomina Daniel", "Concepto: Nomina Leonardo Rodriguez" que antes caían en OTROS o PROVEEDOR_OTROS.
- **Dialque / TGT Dialque** → ALQUILER (arrendamiento de centros comerciales y franquicia hostelera, identificados manualmente como alquiler).
- **Aigües / Sanejament / Servicio Agua** → SUMINISTROS_AGUA (Aigües i Sanejament d'Elx y similares).
- **Ayuntamiento / Excmo. Ayto.** → IMPUESTOS (tasas municipales).
- **GGM Gastro, Bolsemack, IKEA, Media Markt, Worten, Materiales Cano, Maquinas Febal, Ecoclima, Fibraclim, Decoraciones Decomaber, Inox Levante, Escoda Elche, Argent3D, Temu/PayPal Temu, Alcomar Herrega** → MANTENIMIENTO (equipamiento, mobiliario, climatización, electrodomésticos, decoración).
- **Google Ads, JobToday, Mundo Franquicia Consulting, TOT-Digital, Societat Valenciana Fira, Soluciones Host, AVIMED, 4Shine, Etihad/Emirates** → PROVEEDOR_OTROS (servicios no MP; sin categoría dedicada para preservar la convención de 22 categorías).
- **Landfood** ahora también matchea `land\s+food` (sin guion).
- **Brico Depot** ahora matchea con y sin espacio (`\bbrico\s*depot\b`).
- **Embargo judicial** → OTROS (no es proveedor ni gasto recurrente).

### Ronda 3 (agrupación inteligente — taxonomía v3, 2026-05-21)

**Motivación:** el donut de `/bancos → Proveedores` mostraba 243+ slices en "Otros" porque cada persona física aparecía como proveedor individual y muchos servicios digitales/financieros quedaban genéricos.

**Categorías nuevas en `CATEGORIAS_GASTO`:**

- `PUBLICIDAD` — Google Ads, Meta/Facebook/Instagram, TikTok, LinkedIn Ads
- `SERVICIOS_PROF` — Gestoría, asesoría, consulting, abogados, prevención riesgos, portales RRHH
- `DELIVERY` — Glovo, Just Eat, Uber Eats, Deliveroo

**Reglas de agrupación canónica (nombre único en el donut):**

| Slice canónico | Detección (regex resumida) | Categoría |
|---|---|---|
| `Nóminas Personal` | categoría NOMINAS o heurística persona física | NOMINAS |
| `Comisiones Bancarias` | comisión, canon, cuota mantenimiento, devolución recibo | FINANCIERO |
| `Vehículos y Leasing` | Stellantis, VW Financial, Seat Financial, Santander Consumer, renting, leasing | FINANCIERO |
| `Banco - Operaciones` | BBVA, Caixabank, Kutxabank, Banco Sabadell | FINANCIERO |
| `Amazon` | amazon, amz mktp | MANTENIMIENTO |
| `Publicidad Digital` | Google Ads, Meta, Facebook ads, IG, TikTok, LinkedIn ads | PUBLICIDAD |
| `Portales RRHH` | JobToday, InfoJobs, Indeed, LinkedIn Jobs | SERVICIOS_PROF |
| `Prevención Riesgos` | Europreven, prevención riesgos, mutual | SERVICIOS_PROF |
| `Gestoría y Asesoría` | gestoría, asesor, abogado, notaría, **consulting** | SERVICIOS_PROF |

**Excepciones añadidas:**

- Regex de Alquiler tolera typos: `alqui+iler` captura "Alquiiler" (caso María Dolores García Navarro, antes caía erróneamente en NOMINAS).
- Regex de Leroy Merlin tolera typo "leory" (caso "TRANSFERENCIA A Leory Merlin Elche", antes en NOMINAS).
- Transferencias a BBVA / Caixabank ahora van a FINANCIERO antes de evaluar heurística de persona física.

**Reglas removidas** (a favor de la agrupación v3):

- `Restaurant Consulting Group SL` y `Mundo Franquicia Consulting SL` ya no tienen regla propia de proveedor: ambos caen ahora en `Gestoría y Asesoría` por la regla genérica de `consulting`.
- `Google Ads`, `JobToday`, `Europreven Serv PRL SL` ya no tienen regla propia: ahora son `Publicidad Digital`, `Portales RRHH`, `Prevención Riesgos`.

**UPDATE masivo aplicado el 2026-05-21:**

Script: [`recategorize-movimientos.js`](recategorize-movimientos.js). Re-aplica `categorizar()` sobre todas las filas y persiste sólo cambios.

```
Filas en ab_movimientos: 18 858
Cambios detectados: 247

Transiciones (count · importe absoluto):
  PROVEEDOR_OTROS → SERVICIOS_PROF       41       46 162 €
  GASTO_FINANCIERO → INGRESO_TRANSFERENCIA 2      28 703 €   (filas con importe>0 mal categorizadas)
  NOMINAS → ALQUILER                      8        9 871 €
  PROVEEDOR_OTROS → FINANCIERO           48        7 696 €
  PROVEEDOR_OTROS → PUBLICIDAD           27        6 624 €
  PROVEEDOR_OTROS → MANTENIMIENTO        98        6 034 €
  NOMINAS → MANTENIMIENTO                 1        2 476 €   (Leory Merlin typo)
  NOMINAS → FINANCIERO                    3        2 165 €   (BBVA)
  PROVEEDOR_OTROS → DELIVERY             19          325 €
```

Luego `recalc-resumen.js` regeneró `ab_resumen_mensual` (60 combos × 0 errores).

**Verificación post-aplicación** (GET `/api/v1/bancos/proveedores?periodo_desde=2025-06&periodo_hasta=2026-05`):

| pos | proveedor agrupado | total | tx |
|---:|---|---:|---:|
| 1 | Nóminas Personal | 482 906 € | 409 |
| 25 | Gestoría y Asesoría | 35 769 € | 21 |
| 38 | Vehículos y Leasing | 14 908 € | 66 |
| 40 | Comisiones Bancarias | 14 053 € | 12 |
| 57 | Prevención Riesgos | 7 994 € | 19 |
| 68 | Publicidad Digital | 6 624 € | 27 |
| 72 | Amazon | 6 034 € | 98 |
| 111 | Portales RRHH | 2 400 € | 1 |
| 115 | Banco - Operaciones | 2 165 € | 3 |

**Casos dudosos** (per instrucción del usuario: "clasificarlo como NOMINAS si parece nombre de persona física"):

Conceptos del top 100 que la heurística capturó:
- "TRANSFERENCIA A Yanina Paola Barrios Gonzalez" (3 palabras nombre+apellidos, sin sufijo legal)
- "NOMINA A YANINA BARRIOS" (palabra "NOMINA" explícita)
- "Traspaso: Nomina Daniel Romero Armada Dic 2024"
- "Transferencia A Favor De Luciano Todarello Concepto: Nomina 10/2025"
- "Transferencia Inmediata A Favor De Maria Granadino Concepto Nomina"
- "TRANSFERENCIA A Maximiliano Gaston Barrios Gonzalez"
- "Transferencia A Favor De Rodriguez Alvarez, Leonardo Concepto: Nomina"

**Reversibilidad:** el script es idempotente. Si se ajustan reglas:

```bash
node scripts/utils/recategorize-movimientos.js --dry-run
node scripts/utils/recategorize-movimientos.js
node scripts/utils/recalc-resumen.js
```

