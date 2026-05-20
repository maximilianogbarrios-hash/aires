# Log de recategorización de `ab_movimientos`

Última ejecución: **2026-05-20T22:37:56.287Z** — modo: **DRY-RUN**

Total movimientos procesados (importe<0): **9921**
- Cambios de categoría: **0**
- Sin cambios: **9921**
- Sociedades×periodos a recalcular: **0**

## Distribución final por categoría (nueva taxonomía)

| Categoría | Nº movs | Total € |
|---|---:|---:|
| `INTRAGRUPO` | 1688 | 1.087.738 € |
| `PROVEEDOR_OTROS` | 3491 | 755.062 € |
| `PROVEEDOR_CARNES` | 566 | 566.929 € |
| `SS_LABORAL` | 140 | 438.099 € |
| `NOMINAS` | 353 | 410.395 € |
| `ALQUILER` | 198 | 395.944 € |
| `SUMINISTROS_LUZ` | 556 | 302.840 € |
| `IMPUESTOS` | 118 | 212.188 € |
| `PROVEEDOR_MAKRO` | 660 | 197.561 € |
| `PROVEEDOR_PANADERIA` | 76 | 137.945 € |
| `PROVEEDOR_FRITAS` | 125 | 127.068 € |
| `MANTENIMIENTO` | 468 | 99.030 € |
| `PROVEEDOR_BEBIDAS` | 245 | 95.800 € |
| `PROVEEDOR_ACEITES` | 229 | 88.460 € |
| `PROVEEDOR_PACKAGING` | 181 | 66.632 € |
| `OTROS` | 676 | 57.170 € |
| `FINANCIERO` | 58 | 50.715 € |
| `SEGUROS` | 48 | 28.395 € |
| `SUMINISTROS_AGUA` | 32 | 10.239 € |
| `TELECOMUNICACIONES` | 13 | 2941 € |

## Transiciones (categoría vieja → categoría nueva)

| Transición | Nº | Total € | Ejemplos |
|---|---:|---:|---|

## Decisiones tomadas

- **INTRAGRUPO** se aplica antes que cualquier otra regla: cualquier transferencia con "Aires Burger Bar Murcia", "Aires Burger Bar Benidorm", "Aires Alicante", "Smart Aires", "Grupo Hostelero Aires", "Aires Murcia" o "Aires Benidorm" en el concepto queda como INTRAGRUPO.
- **Naturgy** → SUMINISTROS_GAS por convención (la empresa comercializa ambos; el usuario listó Naturgy en GAS).
- **Campoluz** y **Acesur** → PROVEEDOR_LACTEOS por instrucción explícita del usuario, aunque Campoluz comercializa también energía.
- **Entrepinares** → PROVEEDOR_CARNES por instrucción explícita del usuario, aunque su core es queso.
- **NOMINAS** se infiere sólo cuando el concepto matchea `^TRANSFERENCIA [INMEDIATA]? A {Nombre Apellido…}` con 2-5 tokens estilo nombre, sin sufijos legales (SL, SA, SLU, GMBH, etc.) y sin keywords como "Factura", "Alquiler", "Fianza", "Recibo".
- **GASTO_PRESTAMO_INTERGRUPO** (categoría vieja) se reclasifica como **INTRAGRUPO** si el destinatario es del grupo, o **FINANCIERO** si es préstamo bancario externo.
- **Leroy Merlin / Bricomart / Conduce Revel / Muebles Rosillo / Sklum / GGM Gastro / Bolsemack** → MANTENIMIENTO (compras de obra/equipamiento/reparaciones).
- **Restaurant Consulting Group, Yalt Business, Europreven, Distribuciones Batoy, Elan Foods, Gardoy, OCIOBAR** → PROVEEDOR_OTROS (proveedores reales sin encaje en categoría de MP específica).
- **Silicius, Concepción Orive, Overlease, Dialque** → ALQUILER (real estate / SOCIMI / arrendamientos).
- Fallback: si un concepto matchea patrón de "operación comercial" (Transferencia, Recibo, Compra) pero ninguna regla específica, va a **PROVEEDOR_OTROS**. Si no parece operación comercial (devoluciones, regularizaciones, traspasos internos sin destinatario claro), va a **OTROS**.

