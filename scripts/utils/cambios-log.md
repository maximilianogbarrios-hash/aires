# Cambios-log — mejoras dashboard Aires Burger

Este archivo documenta decisiones tomadas durante las series de mejoras
funcionales (mejoras 5-9 y siguientes). El log de recategorizaciones
está separado en [recategorizacion-log.md](recategorizacion-log.md).

## Mejora 5 — Gráfico evolución temporal por proveedor (`/bancos` → Proveedores)

**Backend**
- Nuevo endpoint `GET /api/v1/bancos/proveedor-evolucion?proveedores=A,B&categorias=X,Y&desde=YYYY-MM&hasta=YYYY-MM&sociedad_id=&yoy=1`
  - Devuelve `{ meses, proveedores: [{key, data[]}], categorias: [{key, data[]}], yoy?: { meses, proveedores, categorias } }`
  - Filtra `importe < 0`, excluye INTRAGRUPO, normaliza proveedor canónico vía `normalizarProveedor`.
  - Para series de "categoría" suma todos los movimientos de esa categoría en el rango.
- Nuevo endpoint `GET /api/v1/bancos/proveedores-lista` para autocompletado (cacheado 1h, no toca DB en cada keystroke).

**Frontend**
- Nuevo gráfico encima del ranking, en la pestaña Proveedores.
- Multiselect con buscador + sugerencias (chips removibles). Las categorías llevan etiqueta azul "cat", los proveedores etiqueta verde "prov".
- Si rango = 1 mes → renderiza como barras; si > 1 mes → líneas.
- Toggle "Comparar año ant." → backend devuelve la serie del mismo rango shifted -1 año y el front la pinta con dash.
- Tooltip muestra mes, etiqueta e importe, más la variación % vs. el mes anterior.

**Decisión**: el endpoint NO devuelve líneas por defecto si no hay selección — el front no llama a la API en ese caso. Esto evita queries pesadas innecesarias.

## Mejora 9b — Persistencia de horas cargadas en Personal

**Decisión de esquema**: en lugar de crear una tabla nueva, se extiende
`ab_facturacion_semanal` (migration 8) con dos columnas nulas (`horas`,
`fuente_horas`) y se hace `importe` nullable. Una fila puede tener
facturación, horas, o ambas — mismo grano semanal por local.

Alternativa descartada: tabla `ab_horas_semanal` separada. Se prefirió la
extensión porque el usuario pidió "que persistan en ab_facturacion_semanal"
y porque la clave primaria `(local_id, anio, semana_iso)` calza exacto.

**Backend**
- Migration 8 (`facturacion_semanal_horas`): `ALTER COLUMN importe DROP NOT NULL`
  + agrega `horas NUMERIC(8,2) NULL` y `fuente_horas VARCHAR(20) NULL`.
- `POST /api/v1/facturacion/semanal` ahora acepta `{ importe?, horas?,
  fuente_horas? }`. Al menos uno de los dos (importe u horas) es requerido.
  UPSERT con CASE WHEN — no pisa con NULL los campos que no vinieron.
- La agregación a `ab_historial` (`maybeAggregateToHistorial`) sigue
  funcionando: ahora filtra `WHERE importe IS NOT NULL` para no contar
  filas que sólo tienen horas. Sólo se dispara cuando el POST trae importe.
- `GET /api/v1/facturacion/semanal` devuelve también `horas` y `fuente_horas`.
- `GET /api/v1/pedidos/personal` hace lookup de `horas` por (local, semana)
  y devuelve `horas_cargadas` poblado para las filas con valor en DB. Los
  KPIs `total_cargado`, `pct_utilizacion` y `locales_en_rojo` ahora se
  calculan en backend desde estos valores.

**Frontend**
- `Api.saveHorasSemanal({ local_id, anio, semana_iso, horas })` envuelve el
  POST con `fuente_horas='manual_pedidos'`.
- `renderPersonal()` hidrata `pState.personalCargado` desde la respuesta
  del backend cada vez que se entra al sub-tab (sobreescribe edits locales
  no guardados aún).
- El debounce de 800ms ya existente ahora hace dos cosas: (1) recalcular
  totales por fila y KPIs in-place, (2) llamar `flushHoursToDB()` para
  persistir las claves marcadas dirty. Pequeña cola `_hoursDirty` evita
  perder cambios si el usuario sigue tecleando durante un flush en curso.
- `Enter` dispara flush inmediato antes de mover foco.

**Smoke test post-migración**: insert/select/delete de fila con `importe=NULL`
y `horas=42.5` OK. Schema verificado.

## Mejora 9 — UX inputs de horas en Personal

**Cambios en `renderPersonal` de `public/js/pedidos.js`**
- Inputs de horas cargadas pasan de `type="number"` a `type="text"` con
  `inputmode="decimal"`. Esto elimina las flechitas spinner y permite
  controlar el sanitizado en JS (acepta dígitos, una sola coma/punto).
- `onfocus="this.select()"` selecciona todo el contenido al entrar.
- `Enter`: hace flush del debounce, recalcula totales y mueve foco al
  mismo `data-week` de la siguiente fila (saltea el input si es el último).
- `Tab`: deja el comportamiento nativo del browser (siguiente input en DOM,
  que es la siguiente semana de la misma fila).
- Debounce 800ms: `pState.personalCargado` se actualiza en cada keystroke
  pero el recálculo de totales/KPIs ocurre 800ms después de la última
  tecla. Esto evita perder el foco durante el typing.
- Recalc parcial: en vez de re-renderizar toda la tabla (lo cual
  destruía el input y perdía el foco), `recalcPersonalRow(localId)`
  actualiza in-place los tds de "H. cargadas", "Var %", y el semáforo
  por fila, y `recalcAllPersonalRows()` actualiza los 4 KPIs superiores.

**Decisión**: el formato visual es con coma (formato locale-es), pero el
valor numérico se guarda con punto internamente. La sanitización colapsa
múltiples puntos/comas en uno solo y descarta caracteres no numéricos.

## Mejora 8 — Control granular de pestañas por rol

**Permisos centralizados** en `lib/roles.js`:
- `PERMS.bancos` ya no incluye `'pedidos'` (la página /bancos rechaza el GET).
- Nuevas perms `dashboard_kpis` (admin/socio/gerente) y `vista_sociedad` (admin/socio).
- Nueva matriz `TABS_DASHBOARD` declarando qué pestañas ve cada rol, con helper
  `tabsPermitidas(role)`.

**Backend**
- `GET /api/v1/aires/bootstrap` ahora devuelve `tabs: [..]` (lista de pestañas
  permitidas para el rol) y `flags: { dashboard_kpis, vista_sociedad, config_w,
  bancos, pedidos_pagar }`.
- `app.get('/bancos')` añade `requirePerm('bancos')` → roles `pedidos` y
  `personal` reciben 403 si entran por URL directa.

**Frontend dashboard**
- `setUserUI()` lee `ctx.tabs` y `ctx.flags` y oculta:
  - Botones de tab no permitidos
  - KPIs financieros (`#kpis-top`, `#hdr-financiero`)
  - Toggle Sociedad/Completo (`#soc-toggle-bar`)
  - Link a Bancos en la topbar (`#tb-bancos-link`)
- Si el rol no ve "resumen" como tab default, se abre la primera tab visible.
- `showTab(name)` agrega defense-in-depth: ignora la navegación si la tab no
  está en `ctx.tabs`.

**Decisión**: la matriz vive en backend (single source of truth) y se envía
al front via bootstrap, en lugar de hardcodearla en JS. Así si se agrega un
rol nuevo, sólo se cambia `lib/roles.js`.

## Mejora 7 — Confirmar pedido con importe real + toggle Pagado + cruce bancos

**Permisos**
- Nuevo perm `pedidos_pagar_w` → admin y administrativo (no socio ni gerente).

**Backend**
- `PUT /api/v1/pedidos/marcar-pagado` cambia estado a 'recibido' (o vuelve a
  'enviado' si `pagado=false`) y cruza con ab_movimientos en el rango
  lunes-domingo de la semana ISO, sumando importes del mismo proveedor
  canónico. Devuelve `pagado_banco`, `diferencia`, `ratio_diff`, `ok_match`
  (true si la diferencia ≤ 5%).
- `GET /api/v1/pedidos/materia-prima` ahora también calcula `pagado_banco`
  y un flag `mismatch_banco` por celda para los pedidos en estado 'recibido'.
  Reutiliza el mismo cruce.
- Decisión: como ab_movimientos no tiene local_id asociado a pagos a
  proveedores, el pagado banco de un proveedor se **distribuye a todos los
  locales** que lo marcaron como recibido en esa semana. Esto puede
  exagerar el match — alternativa más conservadora sería distribuirlo
  proporcionalmente al importe real, pero el usuario verá el total
  bancario "tal cual" cobrado en la semana y lo interpretará bien.

**Frontend (Pedidos → Materia Prima)**
- Cada celda de proveedor ahora muestra:
  - input `Confirmado €` (editable por todos los roles con `pedidos_w`)
  - sugerido como label gris debajo
  - toggle `pagar` (sólo visible para roles con `pedidos_pagar_w`)
  - badge `banco: NNNN€` (debajo) cuando ya está marcado como pagado, en
    rojo con ⚠ si difiere del confirmado en > 5%
- `pedSetReal` ahora promueve el estado a 'enviado' cuando se ingresa un
  importe real (sin pisar 'recibido' si ya estaba pagado). Si el usuario
  borra el importe, vuelve a 'pendiente'.

## Mejora 6 — Ocultar Parámetros según rol

- Card "⚙ Parámetros" del dashboard ahora arranca con `display:none` y
  `setUserUI()` lo desbloquea sólo si `ctx.user.role ∈ {admin, socio}`.
- Decisión: oculto del DOM via CSS (display:none) en vez de no renderizarlo,
  porque los IDs internos (`sMP`, `sPers`, etc.) son referenciados por
  `bindParamSliders()` antes del primer click — si los borráramos de la
  página rompería el flujo de carga. La validación dura sigue siendo
  server-side (`config_w` perm).

## Mejora A — Click en leyenda → panel de detalle con reclasificación (2026-05-21)

**Migration 9 (`reglas_normalizacion`)**:
- Tabla nueva `ab_reglas_normalizacion (id, patron, tipo_match,
  categoria, proveedor_normalizado, prioridad, activo, creado_en)`
  con índice por `(activo, prioridad DESC)` y CHECK sobre
  `tipo_match ∈ {ilike, regex, exacto}`.
- Columna nueva `ab_movimientos.proveedor_normalizado VARCHAR(200) NULL`
  para persistir el nombre canónico cuando el usuario reclasifica
  manualmente.

**Helper `lib/bank/db-rules.js`**:
- `loadReglas()` carga ordenado por `prioridad DESC, id ASC`.
- `matchRegla(concepto, reglas)` matchea por `ilike` (substring
  case-insensitive), `exacto` (igualdad case-insensitive) o `regex`
  (RegExp con flag `i`). Devuelve la primera regla que matchee o `null`.

**Precedencia de derivación de grupo en `/proveedores`**:
1. `ab_movimientos.proveedor_normalizado` si está set (reclasificación
   manual ya persistida).
2. Match contra reglas DB (`matchRegla`).
3. `normalizarProveedor()` hardcodeado.

**Aplicación en `/upload-extracto`**: tras parsear el XLSX y antes del
INSERT, se cargan las reglas DB y se aplican a cada movimiento. Si
matchea, se sobrescribe la categoría del categorizer y se setea
`proveedor_normalizado`. La respuesta reporta `reglas_db_aplicadas`.

**Endpoints nuevos**:
- `GET    /api/v1/bancos/grupo-detalle?grupo=X&periodo_*=&sociedad_id=`
- `POST   /api/v1/bancos/reclasificar  body { concepto, categoria_nueva,
          proveedor_nuevo, guardar_regla, tipo_match?, patron? }`
- `GET    /api/v1/bancos/reglas-normalizacion`
- `DELETE /api/v1/bancos/reglas-normalizacion/:id`

**Sidebar frontend**: click en cualquier item de la leyenda (excepto
"Otros (N)" que mantiene su drill-down) abre un panel lateral fijo
con título, totales, % del gasto y lista de conceptos. Cada concepto
tiene botón "Reclasificar" que expande un form inline (select
categoría, input nombre normalizado, checkbox "Aplicar a futuros
extractos"). Confirmar dispara POST `/reclasificar` y recarga el
donut + tabla ranking.

## Mejora B — Selector de sociedad ampliado (2026-05-21)

Reemplaza el selector dinámico (5 opciones desde `state.sociedades`)
por uno con 7 opciones hardcodeadas en el HTML:

- `""` Todas las sociedades
- `"sin_elche"` Sin Elche (4 sociedades: alicante + smart + murcia + benidorm)
- `"solo_elche"` Solo Elche (Grupo Hostelero)
- `"alicante"`, `"smart"`, `"murcia"`, `"benidorm"` individuales

Helper backend `buildSociedadClause(sociedad_id, paramIndex)` traduce
los valores virtuales a cláusulas SQL: `'sin_elche'` →
`sociedad_id <> 'hostelero'`, `'solo_elche'` → `sociedad_id = 'hostelero'`,
otros → `sociedad_id = <id>`. Aplicado a `/proveedores`, `/grupo-detalle`
y `/proveedor-evolucion` (los endpoints que alimentan donut + leyenda
+ tabla + gráfico evolución + KPIs).

Sanity check con datos 2025-06 → 2026-05:

| filtro       | total gasto | sociedades incluidas |
|--------------|------------:|----------------------|
| Todas        | 4 043 411€  | 5                    |
| Sin Elche    | 3 569 249€  | 4 (sin hostelero)    |
| Solo Elche   |   474 162€  | 1 (hostelero)        |
| alicante     |   954 965€  | 1                    |
| smart        |   917 240€  | 1                    |
| murcia       | 1 140 467€  | 1                    |
| benidorm     |   556 577€  | 1                    |

**Sanity**: sin_elche + solo_elche = 4 043 411 = todas (diff 0€).
alicante + smart + murcia + benidorm = 3 569 249 = sin_elche ✓.

## Mejora C — Verificación E2E: reglas DB aplicadas a futuros extractos (2026-05-21)

**Objetivo**: confirmar que el flujo completo cierra:

1. Usuario reclasifica desde el sidebar → POST `/reclasificar` con
   `guardar_regla=true` → fila en `ab_reglas_normalizacion` con
   `prioridad=100` (mayor que cualquier regla seed por defecto).
2. Cuando se sube un nuevo extracto → `/upload-extracto` carga reglas
   DB, las aplica a cada movimiento antes del INSERT.
3. El nuevo movimiento queda persistido con la categoría y el
   `proveedor_normalizado` que dicta la regla, no con el resultado del
   categorizer hardcoded.

**Test ejecutado** (script inline node, 2026-05-21):

```
=== E2E: regla DB aplicada a futuro upload ===
1) Sin regla DB → categorizer hardcodeado devuelve: PROVEEDOR_OTROS
2) Regla DB creada → id=2 patron="PROVEEDOR DE PRUEBA E2E"
   → PUBLICIDAD / "Proveedor E2E Test"
3) matchRegla devolvió: {cat:PUBLICIDAD, prov:Proveedor E2E Test}
4) insertMovimientos: { inserted: 1, duplicated: 0 }
5) Fila persistida: categoria=PUBLICIDAD
                  · proveedor_normalizado=Proveedor E2E Test
6) Validación: categoria_correcta=true · proveedor_correcto=true
   ✓ PASS — la regla DB tiene precedencia sobre el categorizer hardcoded
7) Cleanup OK
```

**Conclusión**: el ciclo Aprendizaje → Persistencia → Aplicación
funciona en los tres puntos del flujo:

- `POST /reclasificar` ⇒ inserta en `ab_reglas_normalizacion` y
  marca también `ab_movimientos.proveedor_normalizado` para las filas
  existentes con ese concepto exacto.
- `loadReglas()` + `matchRegla()` se invocan tanto en `/proveedores`
  (derivación de grupo en runtime) como en `/upload-extracto` (al
  insertar nuevas filas).
- La precedencia es `ab_movimientos.proveedor_normalizado > regla
  DB > normalizarProveedor()` en consultas, y `regla DB >
  categorizer()` en upload.

**Reversibilidad**: cualquier regla puede borrarse con
`DELETE /reglas-normalizacion/:id` (hard delete). Las filas ya
insertadas mantienen su `categoria` y `proveedor_normalizado` salvo
que se vuelva a correr una reclasificación manual.


## Mejora D — Panel admin "Gestionar Gastos Dirección" + include override (2026-05-21)

**Objetivo**: dar a admin/socio una UI para decidir qué proveedores
entran al slice fusionado "Gastos Dirección" que ven los roles
no-admin, sin tocar código y manteniendo la lista por defecto
(NOMINAS_DIRECCION, GASTOS_DIRECCION, PRESTAMOS, FINANCIERO).

**Cambios**:

- Migration 10 → tabla `ab_gastos_direccion_overrides` (PK proveedor,
  acción include|exclude, auditoría creado_en/creado_por).
- Backend:
  - `loadGdOverrides()` + `perteneceAGastosDireccion(prov, cat, ovr)`
    en `routes/bancos.js`. Precedencia: `exclude > include >
    default-by-category`.
  - `GET /api/v1/bancos/gastos-direccion/composicion` (admin only):
    composición actual del slice fusionado, agrupada por categoría
    default + secciones "incluidos via override" y "excluidos via
    override".
  - `POST /api/v1/bancos/gastos-direccion/override` (admin only):
    UPSERT `{ proveedor, accion: 'include'|'exclude' }`.
  - `DELETE /api/v1/bancos/gastos-direccion/override/:proveedor`
    (admin only): vuelve al default.
  - `/proveedores`, `/grupo-detalle`, `/proveedor-evolucion`
    re-derivan la membresía con `perteneceAGastosDireccion`.

- Frontend (`public/bancos/index.html` + `public/js/bancos.js`):
  - Botón ⚙ "Gastos Dirección" visible sólo para admin/socio.
  - Sidebar con 4 secciones (categorías default), botón "Quitar" por
    proveedor, secciones "Incluidos" / "Excluidos" via override, e
    input de búsqueda con datalist para incluir un proveedor cualquiera.

**Fix de borde — include override para categorías no-operativas**:

Bug detectado en smoke test: si el admin incluía vía override un
proveedor cuya `categoria` NO estaba en `CATEGORIAS_PROVEEDOR_OPERATIVO`
(ej. "Energía y Gas" / SUMINISTROS_ENERGIA), el filtro SQL `categoria
= ANY(CATEGORIAS_PROVEEDOR_OPERATIVO)` que aplicaba `/proveedores` a
roles no-admin descartaba esas filas antes de que el JS pudiera
derivar el proveedor canónico y reconocer el include.

Solución: para roles no-admin, no filtramos por categoría en SQL.
Traemos todas las filas (modulo intra-grupo) y, tras derivar el
proveedor canónico en el bucle de agregación, descartamos las que NO
sean operativas Y tampoco pertenezcan a Gastos Dirección (default o
override include). Para admin con vista=operativo se conserva el
filtro SQL por performance.

**E2E test** (`scripts/utils/e2e-gd-include.js`, 2026-05-21):

```
1) Baseline (gerente): GD total: 55616.20 € · miembros: 6
   "Energía y Gas" visible separado?: false (ya excluido por filtro
   SQL antiguo — no aparecía ni en su slice propio ni en GD)

2) Admin: INCLUDE "Energía y Gas" → 200 OK
3) Re-fetch (gerente):
   GD total: 254693.47 € · miembros: 7 (Δ +199 077 € · +1)
   "Energía y Gas" visible separado?: false (fusionado correctamente)
   ✓ INCLUDE OK: YES

4) DELETE override → 200 OK
5) Re-fetch (gerente): GD total: 55616.20 € · miembros: 6
   ✓ ROLLBACK OK: YES
```

## Mejora E — Gating de exportación / descarga por rol (2026-05-21)

**Objetivo**: restringir cualquier acción que materialice datos en
formato descargable (CSV/Excel/PDF) y la "impresión" del dashboard a
roles autorizados, manteniendo el gating extensible vía permiso para
habilitarlo por usuario desde /admin sin tocar código.

**Cambios**:

- `lib/roles.js`: nuevo permiso `export_w: ['admin']`. Cualquier
  endpoint nuevo que entregue archivos descargables se protege con
  `requirePerm('export_w')`. Hoy no hay endpoints de export en
  `routes/*` (los CSV los arma el front desde `state` ya cargado),
  pero el permiso queda listo para uso futuro.

- `routes/aires.js` bootstrap: expone `flags.export_w` derivado de
  `PERMS.export_w`. El frontend lo lee desde `ctx.flags`.

- `public/dashboard/index.html`: botón "Imprimir" del topbar pasa a
  `id="tb-imprimir"` con `display:none` por defecto.
  `public/js/main.js#setUserUI` lo muestra sólo si rol ∈
  {admin, socio} (criterio: Imprimir es un "soft export" via
  `window.print()` y mantiene el alcance de admin+socio).

- `public/bancos/index.html`: los 2 botones Export CSV reciben
  `id="m-btn-export"` (Movimientos) e `id="prov-btn-export"`
  (Proveedores), ambos con `display:none` por defecto.
  `public/js/bancos.js#boot` los muestra sólo si `me.user.role ===
  'admin'` (export "duro" — descarga archivo).

**Matriz resultante**:

| Acción                       | admin | socio | gerente | administrativo | pedidos | personal |
|------------------------------|:-----:|:-----:|:-------:|:--------------:|:-------:|:--------:|
| Export CSV /bancos→Movim.    |  ✓    |       |         |                |         |          |
| Export CSV /bancos→Proveed.  |  ✓    |       |         |                |         |          |
| Botón Imprimir (window.print)|  ✓    |  ✓    |         |                |         |          |
| Endpoints export_w (futuros) |  ✓    |       |         |                |         |          |

**Defense in depth**: el UI gating evita la acción accidental; el
permiso `export_w` está disponible para que futuros endpoints
declaren `requirePerm('export_w')` y devuelvan 403 a clientes que
intenten saltarse la UI.
