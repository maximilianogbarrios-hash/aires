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

