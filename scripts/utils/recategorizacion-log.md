# Log de recategorización de `ab_movimientos`

Última ejecución: **2026-05-21T09:18:51.966Z** — modo: **APPLY**

Total movimientos procesados (importe<0): **9921**
- Cambios de categoría: **0**
- Sin cambios: **9921**
- Sociedades×periodos a recalcular: **0**

## Distribución final por categoría (nueva taxonomía)

| Categoría | Nº movs | Total € |
|---|---:|---:|
| `INTRAGRUPO` | 1688 | 1.087.738 € |
| `PROVEEDOR_CARNES` | 566 | 566.929 € |
| `ALQUILER` | 629 | 499.095 € |
| `NOMINAS` | 390 | 459.111 € |
| `SS_LABORAL` | 140 | 438.099 € |
| `PROVEEDOR_OTROS` | 2367 | 436.094 € |
| `SUMINISTROS_LUZ` | 556 | 302.840 € |
| `IMPUESTOS` | 142 | 225.048 € |
| `MANTENIMIENTO` | 771 | 197.574 € |
| `PROVEEDOR_MAKRO` | 660 | 197.561 € |
| `PROVEEDOR_PANADERIA` | 76 | 137.945 € |
| `PROVEEDOR_FRITAS` | 125 | 127.068 € |
| `PROVEEDOR_BEBIDAS` | 245 | 95.800 € |
| `PROVEEDOR_ACEITES` | 229 | 88.460 € |
| `PROVEEDOR_PACKAGING` | 181 | 66.632 € |
| `SERVICIOS_PROF` | 147 | 60.900 € |
| `FINANCIERO` | 655 | 58.471 € |
| `SEGUROS` | 48 | 28.395 € |
| `PUBLICIDAD` | 136 | 26.852 € |
| `SUMINISTROS_AGUA` | 50 | 15.474 € |
| `OTROS` | 88 | 11.797 € |
| `TELECOMUNICACIONES` | 13 | 2941 € |
| `DELIVERY` | 19 | 325 € |

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

### Ronda 3 (comisiones bancarias + nóminas con stopwords + SaaS + Facebook Ads)

Objetivo: bajar PROVEEDOR_OTROS y OTROS reagrupando los conceptos más frecuentes que caían en el cubo genérico.

- **Comisiones bancarias Sabadell**: regex `^comisi[oó]nes?\s+\d{10}` (formato "Comision XXXXXXXXXX 01/02 NombreSociedad XXXXXXXXX") → **FINANCIERO** / proveedor `Comisiones Bancarias Sabadell`. También `^COMISIONES$`, `^COMISIÓN DIVISA NO EURO`, `^INTERESES Y/O COMISIONES CUENTA` → FINANCIERO.
- **Comisiones de TPV** (`Comision Por Instalacion O Mantenimiento De Tpv 0049...`) se MANTIENEN en MANTENIMIENTO porque la regex de financiero exige el dígito al **inicio** del concepto, no en medio.
- **Nóminas — stopwords en nombres compuestos**: `esTransferenciaPersonaFisica` ahora acepta `de`, `del`, `la`, `las`, `el`, `los`, `y`, `da`, `do`, `das`, `dos` como filler entre tokens de nombre. Necesita ≥2 tokens con mayúscula (Title o TODO MAYUSCULAS). Recupera "Francisco de Asis Fernandez", "Joao da Silva", "Maria del Carmen" etc.
- **IVA autoliquidación**: `^\d{0,4}\s*iva\s+autoliquidaci` → IMPUESTOS / proveedor `IVA Autoliquidación`.
- **DGT sanciones + Generalitat Valenciana** → IMPUESTOS.
- **SERVICIOS_PROF** (SaaS / software / hosting): Adobe Systems, Google One/Workspace, Microsoft/Office 365, CapCut, Hostinger, Hello Ventures BV, App-Sorteos, 4Shine, Promotty, Soluciones Host, Helloprint, TOT-Digital, Yalt Business/Magical Insights.
- **PUBLICIDAD** ahora matchea Facebook ads truncados en Sabadell: `\bfacebk\b`, `fb.me/ads` → proveedor `Meta Ads (Facebook/Instagram)`.
- **MANTENIMIENTO** ampliado: New Matelsa, Maquinaria Hostelería TIE, Saniagua SL, TodoElectrico, Eléctricas Maisa, Obramat, Sumin Surec, Thomann, AliExpress, OBM Murcia, Viveros Carmaet, Coop. Eléctrica Benéfica San Francisco.

**Resultado**: cambios=866. OTROS bajó de 645 a 88 movimientos. FINANCIERO captura 604 comisiones bancarias nuevas. SERVICIOS_PROF y PUBLICIDAD ya tienen contenido real (147 y 136 movs respectivamente). PROVEEDOR_OTROS baja de 2676 a 2367 movimientos.

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

