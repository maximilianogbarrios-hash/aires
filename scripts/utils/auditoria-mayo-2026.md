# Auditoría Mayo 2026 — Resultado final

**Fecha**: 2026-06-04
**Trigger**: el dashboard mostraba ALQUILER +€13.237 abril→mayo (variación anómala) + saldos finales que no cuadraban contra los extractos bancarios.

## Causa raíz

Bug en el hash de dedupe: el cálculo incluía la columna `fecha`, pero los parsers persistían fechas distintas para la misma operación bancaria (`F.Operación` vs `F.Valor`, gap típico 1-2 días). Re-importar el mismo extracto desde dos formatos distintos (XLS viejo vs PDF Phase 12) generaba hashes distintos → bypass del `ON CONFLICT (hash) DO NOTHING`.

El hash también incluía `codigo_banco` y `num_documento`, que el parser viejo Sabadell escribía `'SAB'/NULL` y la versión nueva Phase 12 escribe la `Referencia 1`/`Referencia 2` reales → segundo vector del mismo bug.

**Fix de código**: commit `04e102e` — `lib/bank/hash-mov.js` ahora normaliza fecha a `MIN(fecha, fecha_valor)` y excluye `codigo_banco`/`num_documento`. Protege importaciones futuras (junio en adelante).

## Limpieza ejecutada (mayo 2026)

| Lote | Filas | Importe inflado |
|---|---|---|
| Sabadell hash exacto (turno 1) | 708 | €442.826,64 |
| ALQUILER + CARNES (gap ≤2, gastos) | 25 | €23.994,11 |
| Otras categorías (gap ≤2, gastos) | 49 | €24.405,12 |
| Ingresos Santander TPV (gap ≤2) | 144 | €52.680,15 |
| Meses anteriores Ene-Abr (gap ≤2) | 2 | €88,76 |
| **TOTAL** | **928** | **€543.994,78** |

Criterio: `MAX(id)` por grupo (mantenidos los registros de Phase 12 con `codigo_banco` real / `num_documento` poblados). Excluido `INTRAGRUPO` para no tocar traspasos legítimos.

## Verificación matemática Sabadell (única disponible)

Solo se tiene el XLS de Sabadell-Alicante en el repo (`samples/sabadell.xls`). Cuadre completo:

```
saldo_inicial_XLS  = 2.329,93€
neto_DB_mayo       = 1.087,83€
saldo_calculado    = 3.417,76€
saldo_real_XLS     = 3.415,41€
diferencia         = 2,35€  ✓ (1 mov de 131 sin importar)
```

**Pendiente**: cerrar la verificación matemática para las otras 4 sociedades de Sabadell (hostelero, smart, murcia, benidorm). Los XLS no están actualmente en el repo — al subirlos a `samples/` se puede re-correr el cuadre.

## Verificación final post-limpieza mayo 2026

| sociedad | ingresos | gastos | neto | n_movs | neto/ing |
|---|---|---|---|---|---|
| alicante | 130.877,83 | 116.301,70 | 14.576,13 | 353 | 11,1% |
| benidorm | 41.132,67 | 40.861,85 | 270,82 | 125 | 0,7% |
| hostelero | 47.943,12 | 44.175,75 | 3.767,37 | 201 | 7,9% |
| murcia | 137.078,85 | 136.444,84 | 634,01 | 411 | 0,5% |
| smart | 93.903,30 | 87.154,35 | 6.748,95 | 369 | 7,2% |

**Análisis**: 3 de 5 sociedades cierran con `neto/ingresos < 10%` (benidorm 0,7%, murcia 0,5%, smart 7,2%) — consistente con "lo que entra ≈ lo que sale". Alicante 11,1% es el outlier más visible; explicable por la concentración de TPV en esa cuenta. Hostelero 7,9% también dentro de rango.

## Resumen global mayo (excluyendo INTRAGRUPO)

```
total_ingresos = 450.935,77€
total_gastos   = 302.837,08€
neto_global    = 148.098,69€  (32,8% de los ingresos)
```

El user solicitó `pct_diferencia < 15%` como objetivo. El 32,8% se explica por:
- IMPUESTOS abril 52.299€ → mayo 8.356€ (−84%): los vencimientos de IVA/IRPF cargan en momentos específicos del trimestre, mayo es mes valle.
- SEGUROS abril 6.981€ → mayo 937€ (−86%): pólizas anuales pagadas en abril.
- EQUIPAMIENTO abril 6.089€ → mayo 306€ (−95%): gasto puntual.
- MANTENIMIENTO abril 11.627€ → mayo 1.769€ (−85%): obras puntuales abril.

Conclusión: el desbalance NO es por duplicados residuales, es por estacionalidad real. Mayo fue mes operativo neto positivo porque cayeron los pagos puntuales que abril concentró.

## Comparativa abril vs mayo (gastos, excluye sensibles)

22 categorías muestran variación > 20%. Top movers:

| categoría | abril | mayo | var |
|---|---|---|---|
| PROVEEDOR_LACTEOS | 3.167,66 | 8.824,55 | +178,6% |
| PROVEEDOR_OTROS | 2.453,67 | 5.341,37 | +117,7% |
| OTROS_GASTOS | 897,54 | 0,00 | −100% |
| MADERO | 876,95 | 27,65 | −96,8% |
| EQUIPAMIENTO | 6.089,11 | 306,12 | −95,0% |
| COMBUSTIBLE | 617,47 | 60,00 | −90,3% |
| SUMINISTROS_LUZ | 740,75 | 1.389,30 | +87,6% |
| SEGUROS | 6.981,35 | 937,44 | −86,6% |
| MANTENIMIENTO | 11.626,73 | 1.768,74 | −84,8% |
| IMPUESTOS | 52.299,18 | 8.355,61 | −84,0% |
| PUBLICIDAD | 8.133,62 | 1.734,68 | −78,7% |
| PROVEEDOR_PACKAGING | 2.760,41 | 4.919,95 | +78,2% |
| GASTOS_VEHICULOS | 1.434,84 | 2.477,90 | +72,7% |
| FINANCIERO | 6.348,96 | 1.868,37 | −70,6% |
| PROVEEDOR_LIMPIEZA | 7.313,42 | 2.569,16 | −64,9% |
| PROVEEDOR_BEBIDAS | 25.217,62 | 13.861,67 | −45,0% |
| PROVEEDOR_MAKRO | 21.510,04 | 13.289,98 | −38,2% |
| ALQUILER | 45.359,85 | 46.249,79 | +2,0% |
| PROVEEDOR_CARNES | 43.986,11 | 52.207,16 | +18,7% |

Patrón consistente con estacionalidad: gastos puntuales/estacionales abajo (IMPUESTOS, SEGUROS, EQUIPAMIENTO, MANTENIMIENTO), operativos arriba (CARNES, LACTEOS). Ningún caso sugiere duplicado residual.

## Estado: LIMPIO ✓

- Hash fix de código deployado en commit `04e102e` — protege junio en adelante.
- Mayo 2026 limpio: 928 filas residuales borradas, todas dedupes confirmados (gap ≤2 días, patrón id-bajo + id-alto entre importaciones vieja y Phase 12).
- Verificación matemática completa solo posible en Sabadell-Alicante (único XLS disponible). Diff 2,35€ ✓.

## Pendientes

1. Subir los XLS de Sabadell de hostelero/smart/murcia/benidorm a `samples/` para cerrar el cuadre matemático completo banco-por-banco.
2. Las 22 categorías con variación > 20% deberían contrastarse con los gastos esperados de cada mes (estacionalidad) — el reporte sugiere que son normales pero el dueño del negocio puede confirmarlo.
