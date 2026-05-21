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

### Ronda 5 (correcciones puntuales + 4 categorías nuevas, 2026-05-21)

**Categorías nuevas en `CATEGORIAS_GASTO`:**

- `NOMINAS_DIRECCION` — sueldos de socios/directivos separados de NOMINAS.
- `EQUIPAMIENTO` — herramientas, mobiliario y equipo separados de MANTENIMIENTO (este último queda con Leroy/Bricomart/Obramat y obra real).
- `PRESTAMOS` — cuotas de préstamos bancarios separadas de FINANCIERO (este queda con comisiones y operaciones).
- `OTROS_GASTOS` — gastos de servicios externos identificables que no encajan en proveedor operativo (Radius, etc.).

**Reglas DB persistidas** (todas en `ab_reglas_normalizacion`, prioridad indicada). Las reglas se insertaron mediante `scripts/utils/ronda5-recategorizar.js`. La protección INTRAGRUPO en el handler de `/upload-extracto` se reforzó: `if (m.categoria === 'INTRAGRUPO') continue` antes de aplicar reglas DB — los traspasos internos del grupo (Aires↔Aires) tienen precedencia absoluta.

| nombre canónico         | patrón ILIKE                                         | categoría          | prio |
|---|---|---|---:|
| Sueldos Dirección       | `maximiliano (g/gaston) barrios`, `daniel (oscar) romero`, `yanina (paola) barrios` | NOMINAS_DIRECCION | 120 |
| Dialque SAU             | `dialque`                                           | PROVEEDOR_LACTEOS | 110 |
| TGT                     | `TGT` (excluye conceptos con `dialque`)             | PROVEEDOR_LACTEOS | 110 |
| Entrepinares            | `entrepinares`                                       | PROVEEDOR_LACTEOS | 110 |
| Campoluz                | `campoluz`, `campo luz`                              | PROVEEDOR_LACTEOS | 110 |
| GGM Gastro              | `GGM`                                                | EQUIPAMIENTO      | 110 |
| Amazon                  | `amazon`, `AMZ`                                      | EQUIPAMIENTO      | 110 |
| IKEA                    | `ikea`                                               | EQUIPAMIENTO      | 110 |
| Viveros                 | `vivero`                                             | EQUIPAMIENTO      | 110 |
| Maquinas Febal          | `febal`                                              | EQUIPAMIENTO      | 110 |
| Argent 3D               | `argent` (excluye `argentina`), `argen `             | EQUIPAMIENTO      | 110 |
| Arrolas                 | `arrolas`                                            | PROVEEDOR_OTROS   | 110 |
| Carnicas Mulas SL       | `carnicas mulas`                                     | PROVEEDOR_CARNES  | 110 |
| Radius                  | `radius`                                             | OTROS_GASTOS      | 110 |
| Préstamos Bancarios     | `liquidacion periodica (prestamo)`, `cuota prestamo`, `amortizaci(ó)n` | PRESTAMOS | 110 |

**UPDATE retroactivo:** **1 313 filas actualizadas** sobre las 5 sociedades × 12 períodos. Se preservó `INTRAGRUPO` (286 filas) en todos los casos. Recálculo de `ab_resumen_mensual`: 60 combos × 0 errores.

**Transiciones más relevantes:**

| categoría origen → destino                            | filas | importe   |
|---|---:|---:|
| ALQUILER → PROVEEDOR_LACTEOS (Dialque)                | 423   | 93 281€   |
| SUMINISTROS_ENERGIA → PROVEEDOR_LACTEOS (Campoluz)    | 229   | 97 390€   |
| Resto → PROVEEDOR_LACTEOS (Entrepinares + TGT)        | 112   | 50 267€   |
| MANTENIMIENTO → EQUIPAMIENTO (Amazon + IKEA + GGM + ...) | 177 | 44 021€   |
| NOMINAS → NOMINAS_DIRECCION (Sueldos Dirección)       | 29    | 40 265€   |
| FINANCIERO → PRESTAMOS (Préstamos Bancarios)          | 28    | 36 316€   |
| SUMINISTROS_ENERGIA → OTROS_GASTOS (Radius)           | 72    | 6 734€    |
| PROVEEDOR_CARNES (proveedor_normalizado solo)         | 244   | —         |

**Distribución final (gastos)** vs Ronda 4:

| categoría              | mov     | total       | delta vs ronda 4 |
|---|---:|---:|---|
| INTRAGRUPO             | 286     | 1 084 885€  | (sin cambios)    |
| PROVEEDOR_CARNES       | 469     |   518 546€  | (sin cambios)    |
| SS_LABORAL             | 140     |   438 099€  | (sin cambios)    |
| NOMINAS                | 356     |   417 816€  | −33 mov / −53k   |
| ALQUILER               | 206     |   405 815€  | −423 mov / −93k  |
| PROVEEDOR_OTROS        | 2 173   |   392 187€  | −56 mov / −4k    |
| PROVEEDOR_LACTEOS      | **764** |  **240 937€** | +667 mov / +192k |
| IMPUESTOS              | 142     |   225 048€  | (sin cambios)    |
| SUMINISTROS_ENERGIA    | 286     |   199 077€  | −301 mov / −104k |
| PROVEEDOR_MAKRO        | 660     |   197 561€  | (sin cambios)    |
| MANTENIMIENTO          | 666     |   174 952€  | −125 mov / −39k  |
| **EQUIPAMIENTO**       | **176** |  **44 021€** | nueva            |
| **NOMINAS_DIRECCION**  | **29**  |  **40 265€** | nueva            |
| **PRESTAMOS**          | **28**  |  **36 316€** | nueva            |
| FINANCIERO             | 2 026   |    22 843€  | −31 mov / −38k   |
| **OTROS_GASTOS**       | **72**  |   **6 734€** | nueva            |

**Punto 8 — "Proveedores Menores muestra 0€":** la query del usuario devolvía 0 resultados porque `proveedor_normalizado` estaba NULL en casi todos los movimientos. Tras la Ronda 5 (1 313 filas tienen nombre canónico) la query devuelve 1 caso real: Viveros (3 tx, 1 272€, total<2 000€ AND count<5). El endpoint `/proveedores` ya agrupa correctamente: el slice "Proveedores Menores" muestra **355 185€ en 2 206 tx** (no 0€). El bug original era de datos (columna NULL), no de lógica del endpoint. Se conservó el rollup automático actual.

**Punto 10 — Grupo Lácteos en el donut:** los 4 proveedores aparecen como slices individuales cuando el umbral lo permite (con `max_grupos≥125` o vista expandida). Cada uno con `categoria=PROVEEDOR_LACTEOS`:

| proveedor       | total      | tx  |
|---|---:|---:|
| Campoluz        | 97 390€    | 229 |
| Dialque SAU     | 93 281€    | 423 |
| Entrepinares    | 48 383€    |  97 |
| TGT             |  1 884€    |  15 |

**Reversibilidad:**

```bash
# DRY-RUN para ver qué cambiaría:
node scripts/utils/ronda5-recategorizar.js --dry-run

# APPLY:
node scripts/utils/ronda5-recategorizar.js

# Si necesitás borrar las 29 reglas de Ronda 5:
#   DELETE FROM ab_reglas_normalizacion WHERE prioridad IN (110, 120);
# Después correr scripts/utils/recategorize-movimientos.js para
# regenerar las categorías desde el categorizer hardcoded.
```

### Ronda 6 (correcciones puntuales sobre Ronda 5, 2026-05-21)

**Categorías nuevas en `CATEGORIAS_GASTO`:**

- `GASTOS_DIRECCION` — gastos personales/operativos de la dirección
  (Revel, Créditos Dirección, etc.).
- `GASTOS_VEHICULOS` — Stellantis, leasing, renting, antes "Vehículos
  y Leasing" → separados de FINANCIERO.

**Reglas DB Ronda 6** (insertadas vía `scripts/utils/ronda6-recategorizar.js`):

| nombre canónico       | patrón ILIKE                    | categoría         | prio | nota |
|---|---|---|---:|---|
| TGT                   | `TGT`, `T.G.T`                  | PROVEEDOR_LACTEOS | **120** | sube de 110 → 120 (gana sobre Dialque excluido por `extraWhere`) |
| Revel                 | `revel`, `conduce revel`        | GASTOS_DIRECCION  | 110  |  |
| Créditos Dirección    | `credito`, `crédito`            | GASTOS_DIRECCION  | 110  | `extraWhere: AND categoria <> 'NOMINAS_DIRECCION'` para no pisar sueldos |
| Gastos Vehículos      | `stellantis`, `leasing`, `renting` | GASTOS_VEHICULOS | 110  |  |

**UPDATE retroactivo:** **78 filas** actualizadas. 19 combos sociedad×periodo recalculados, 0 errores.

| transición                                         | filas | importe   |
|---|---:|---:|
| FINANCIERO → GASTOS_VEHICULOS (Stellantis+leasing+renting) | 66 | 14 908€ |
| MANTENIMIENTO → GASTOS_DIRECCION (Revel/Conduce Revel)     | 12 | 13 164€ |

**Distribución final** (cambios vs Ronda 5):

- MANTENIMIENTO: 666 → 654 mov (−12 a GASTOS_DIRECCION)
- FINANCIERO:    2 026 → 1 960 mov (−66 a GASTOS_VEHICULOS)
- GASTOS_VEHICULOS: 66 mov / 14 908€ (NUEVA)
- GASTOS_DIRECCION: 12 mov / 13 164€ (NUEVA)

**Verificación de slices independientes** en `/proveedores?max_grupos=200`:

| proveedor       | total    | tx  | categoría         |
|---|---:|---:|---|
| Campoluz        | 97 390€  | 229 | PROVEEDOR_LACTEOS |
| Dialque SAU     | 93 281€  | 423 | PROVEEDOR_LACTEOS |
| Entrepinares    | 48 383€  |  97 | PROVEEDOR_LACTEOS |
| **TGT**         |  1 884€  |  15 | PROVEEDOR_LACTEOS |
| Gastos Vehículos| 14 908€  |  66 | GASTOS_VEHICULOS  |
| Revel           | 13 164€  |  12 | GASTOS_DIRECCION  |

"Créditos Dirección" no aparece porque los 2 hits actuales con concepto que contiene "crédito" caen en `Sueldos Dirección` (NOMINAS_DIRECCION, prio 120). La regla existe en DB para uploads futuros que sí matcheen.

**Reversibilidad:**

```bash
# DRY-RUN para preview:
node scripts/utils/ronda6-recategorizar.js --dry-run
# APPLY:
node scripts/utils/ronda6-recategorizar.js
```

### Ronda 6b (corrección TGT + cap50, 2026-05-21)

**Cambio 1 — TGT absorbe "TGT Dialque"**: el spec original de Ronda 6
incluía un `extraWhere AND NOT (concepto ILIKE '%dialque%')` para que
los conceptos "TRANSFERENCIA A TGT Dialque Murcia" cayeran en Dialque
SAU. Revisión: el usuario pidió que TGT sea **slice independiente** con
proveedor='TGT' incluyendo "TGT Dialque". Se eliminó la exclusión:

| antes (Ronda 6)            | después (Ronda 6b)         |
|---|---|
| Regla TGT prio 120 con `NOT dialque` | Regla TGT prio 120 SIN exclusión |
| "TGT Dialque Murcia" → Dialque SAU   | "TGT Dialque Murcia" → TGT       |

**UPDATE retroactivo**: 97 filas reclasificadas de `Dialque SAU` →
`TGT` (todos los conceptos que contienen "TGT" y antes estaban en
Dialque). Recalc resumen: 12 combos.

**Resultado donut**:

| proveedor       | antes Ronda 6b | después Ronda 6b |
|---|---:|---:|
| TGT             |  1 884€ /  15 tx | **24 882€ / 112 tx** |
| Dialque SAU     | 93 281€ / 423 tx |  70 283€ / 326 tx |

**Cambio 2 — `max_grupos` default 30 → 50** en `routes/bancos.js`
endpoint `/proveedores`. Con las nuevas categorías (PROVEEDOR_LACTEOS
con 4 slices, GASTOS_DIRECCION, GASTOS_VEHICULOS, EQUIPAMIENTO, etc.)
el límite de 30 ocultaba proveedores legítimos en "Proveedores
Menores". El cap de 50 permite ver los 49 grupos individuales relevantes
sin saturar.

### Ronda 7 (correcciones puntuales sobre Ronda 6, 2026-05-21)

**Objetivo: separar definitivamente EQUIPAMIENTO (inversión, locales
nuevos) de MANTENIMIENTO (gasto corriente).**

| antes (Ronda 5/6) | después (Ronda 7) |
|---|---|
| Viveros: EQUIPAMIENTO | **Viveros: MANTENIMIENTO** (gasto recurrente de cuidado de plantas/exterior) |

EQUIPAMIENTO definitivo (5 proveedores, 173 filas, 42 750€):
- GGM Gastro, Argent 3D, Amazon, IKEA, Maquinas Febal.

MANTENIMIENTO (654+ filas): Leroy Merlin, Bricomart, Obramat, **Viveros**,
herramientas, reparaciones, y todo lo previamente clasificado en
MANTENIMIENTO por categorizer hardcoded.

**Otras correcciones:**

| patrón                            | categoría    | proveedor canónico   | filas | total  |
|---|---|---|---:|---:|
| `vivero`                          | MANTENIMIENTO | Viveros             |  3    |  1 272€ |
| `suma gestion tributaria`         | IMPUESTOS     | SUMA - Impuestos    |  9    |  2 524€ |
| `BSSG`                            | PROVEEDOR_OTROS | BSSG               |  1    |    801€ |

**SUMA**: la regla cubre 9 movimientos (recibos + tarjetas de la
Suma Gestión Tributaria de Diputación de Alicante — tasas residuos
Ajunt Elx). Los 2 "IMPUESTOS SUMA GESTION TRIBUTARIA" están incluidos
en la primera regla (skip 0 al ya estar correctos).

**BSSG**: 1 sola transacción ("ADEUDO RECIBO BSSG" / 801€). No hay
suficiente evidencia para clasificarlo como FINANCIERO ni SERVICIOS_PROF
con certeza. Opción conservadora: mantener en PROVEEDOR_OTROS con
nombre canónico 'BSSG' para que aparezca como slice identificable. El
usuario puede reclasificarlo desde el sidebar cuando confirme qué es.

**UPDATE retroactivo aplicado:** 13 filas, 9 combos sociedad×periodo
recalculados, 0 errores. Script: `scripts/utils/ronda7-recategorizar.js`
(idempotente, soporta `--dry-run`).

