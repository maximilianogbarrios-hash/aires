# Log de recategorización de `ab_movimientos`

Última ejecución: **2026-05-21T09:37:51.938Z** — modo: **APPLY**

Total movimientos procesados (importe<0): **9921**
- Cambios de categoría: **0**
- Sin cambios: **9921**
- Sociedades×periodos a recalcular: **0**

## Distribución final por categoría (nueva taxonomía)

| Categoría | Nº movs | Total € |
|---|---:|---:|
| `INTRAGRUPO` | 286 | 1.084.885 € |
| `PROVEEDOR_CARNES` | 469 | 518.546 € |
| `ALQUILER` | 629 | 499.095 € |
| `NOMINAS` | 389 | 458.576 € |
| `SS_LABORAL` | 140 | 438.099 € |
| `PROVEEDOR_OTROS` | 2229 | 396.397 € |
| `SUMINISTROS_ENERGIA` | 587 | 303.200 € |
| `IMPUESTOS` | 142 | 225.048 € |
| `MANTENIMIENTO` | 791 | 213.819 € |
| `PROVEEDOR_MAKRO` | 660 | 197.561 € |
| `PROVEEDOR_PANADERIA` | 76 | 137.945 € |
| `PROVEEDOR_FRITAS` | 125 | 127.068 € |
| `PROVEEDOR_BEBIDAS` | 245 | 95.800 € |
| `PROVEEDOR_ACEITES` | 229 | 88.460 € |
| `SERVICIOS_PROF` | 235 | 84.525 € |
| `PROVEEDOR_PACKAGING` | 181 | 66.632 € |
| `FINANCIERO` | 2057 | 61.324 € |
| `PROVEEDOR_LACTEOS` | 97 | 48.383 € |
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

### Ronda 4 — objetivo ≤30 grupos

Objetivo del usuario: máximo 30 grupos visibles en la pestaña Proveedores.

**Bug fix crítico**: la regla `^Comisiones \d{10}` fallaba porque las "COMISIONES 0354... AIRES BURGER BAR MURCIA" caían primero en INTRAGRUPO (la regla de intra-grupo se evaluaba antes y matcheaba por el nombre de la sociedad). Se agregó un check pre-INTRAGRUPO (`REGEX_COMISIONES_BANCARIAS = /^\s*comisi[oó]nes?\s+\d{4,}/i`) que enruta esas filas a FINANCIERO antes de chequear intra-grupo.

**Nueva categoría SUMINISTROS_ENERGIA**: unifica SUMINISTROS_LUZ + SUMINISTROS_GAS en un único bucket (las dos categorías legacy quedan en CATEGORIAS_GASTO por back-compat pero no se asignan más). Incluye Iberdrola, Endesa, ENDESAX, i-DE, Naturgy, Repsol Gas, Fox Energia, TotalEnergies, EDP, ACC Green Energy, **Fons Energia**, **Viesgo**, Campo Luz, Radius Business.

**Colapso a nombres canónicos genéricos** (Ronda 4):
- Iberdrola/Endesa/Naturgy/etc. → `Energía y Gas` (categoria SUMINISTROS_ENERGIA).
- Leroy Merlin/IKEA/Worten/Media Markt/Argent3D/RROS IMAGEN/TIMBRADOS/Amazon → `Mantenimiento y Equipamiento` (MANTENIMIENTO).
- Adobe/Google One/Microsoft/Promotty/Hostinger/OCIOBAR/Restaurant Consulting/Yalt/Mundofranquicia/Alcomar/Angel Linares/Societat Valenciana/Europreven/JobToday/Asesorías → `Servicios Profesionales` (SERVICIOS_PROF).
- Préstamos/Comisiones/BBVA/CaixaBank/Sabadell/Santander Consumer/Renting → `Banco - Operaciones` (FINANCIERO).
- TGSS/S.SOCIALE/SS//Seguridad Social → `Seguridad Social` (SS_LABORAL).
- Mapfre/AXA/Allianz/Generali/cualquier seguro → `Seguros` (SEGUROS).
- Google Ads/Meta Ads/Facebk/TikTok/LinkedIn Ads → `Publicidad Online` (PUBLICIDAD).
- Hidraqua/EMUASA/AMAEM/Aigües → `Aigües / Servicio Agua` (SUMINISTROS_AGUA).
- **ALQUILER** colapsado completo: cualquier movimiento con `categoria='ALQUILER'` (Silicius, Dialque, Innovestment, Concepción Orive, Bernardo Ortega, todos los arrendadores persona física) → `Alquileres y Arrendamientos`. Necesario para llegar a ≤30 grupos porque había 25+ arrendadores individuales.

**Movido entre categorías**:
- **Entrepinares** de PROVEEDOR_CARNES → **PROVEEDOR_LACTEOS** (es queso; corrección del usuario).
- **Alcomar** de MANTENIMIENTO → SERVICIOS_PROF (era Alcomar Herrega SL; el user lo lista como servicios prof).

**Proveedores específicos preservados** (mantienen nombre individual porque el módulo Pedidos los necesita por nombre canónico para el mix MP): Carnicas Mulas, Don Hamgus, Carnicas Garcia, Makro, Eurofrits, Coca-Cola, Aceites Millas, Europastry, Brioche de Juanito, Landfood, Kauapack, Diversey, Ecolab, Mahou, Heineken, Distribuciones Batoy, Elan Foods, Avimed, Gardoy, Entrepinares.

**Rollup en endpoint /api/v1/bancos/proveedores** (`Proveedores Menores`):
- Pasada 1 — threshold del usuario: `count<5 AND total<2000€` → bucket "Proveedores Menores".
- Pasada 2 — cap top-N (`max_grupos` default 30): si tras la pasada 1 siguen >30 grupos, se mantienen los top-29 por total y el resto va al bucket. Garantía dura ≤30 grupos visibles en la UI.
- Ambos thresholds son configurables vía query params (`menores_min_tx`, `menores_min_eur`, `max_grupos`).

**Decisión tomada sin preguntar**: el spec del usuario menciona thresholds 5/2000 con AND. Con esos thresholds quedaban 115 grupos visibles (lejos del objetivo ≤30). Por eso se agregó una segunda pasada cap top-N. La pasada del usuario sigue aplicándose primero (criterio explícito), y la cap top-N actúa sólo si es necesaria. Documentado para que el operador entienda que el cap visual NO modifica la DB ni la granularidad de normalizarProveedor (sigue devolviendo los nombres específicos cuando se consume desde otros endpoints como Pedidos/mix).

**Resultado**: 2194 movimientos reclasificados, 60 resúmenes mensuales recalculados.

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

