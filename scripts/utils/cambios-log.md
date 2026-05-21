# Cambios-log — mejoras dashboard Aires Burger

Este archivo documenta decisiones tomadas durante las series de mejoras
funcionales (mejoras 5-9 y siguientes). El log de recategorizaciones
está separado en [recategorizacion-log.md](recategorizacion-log.md).

## Refactor de roles y permisos — control granular tabs/sub-tabs/UI (5 bloques)

Reescritura coordinada en backend y frontend del sistema de permisos del
dashboard, /bancos y módulo Pedidos, todo manejado desde `lib/roles.js`
como single source of truth.

### Bloque A — `lib/roles.js`
- `PERMS` nuevos: `print_w` (admin/socio), `config_w_log_only` (gerente).
- `PERMS.locales_w` pierde `'administrativo'`.
- `PERMS.pedidos_view/w` ganan `'personal'`.
- `TABS_DASHBOARD` ajustada: `resumen` y `ranking` quitan administrativo/
  pedidos/personal; `costos` queda admin/socio; `evolucion` y `traspasos`
  quedan admin/socio; `seguimiento` y `pedidos` ganan pedidos+personal.
- `SUB_TABS_PEDIDOS` ajustada: `mp` para todos los roles con acceso a
  Pedidos; `personal` para admin/socio/gerente/pedidos/personal; `mix`
  solo admin/socio; `cmp` admin/socio/administrativo; `hist`+`rk`
  admin/socio/gerente.
- `SUB_TABS_BANCOS` nueva: `resumen`+`proveedores` admin/socio/gerente/
  administrativo; `movimientos`+`gastos`+`cruce` solo admin/socio.
- Nuevo helper `subTabsBancosPermitidas(role)`.

### Bloque B — Migration 11 `ab_parametros_historial`
Tabla de auditoría para cambios al panel de Parámetros. Schema:
`(id serial, usuario_email, campo, valor_anterior numeric, valor_nuevo
numeric, fecha timestamptz default NOW())`. Índices por fecha DESC y
usuario_email. La id=10 ya estaba ocupada por `gastos_direccion_overrides`.

### Bloque C — Backend
- `PUT /api/v1/aires/config` ahora exige `requirePerm('config_w')`
  (admin/socio/gerente). Para `'gerente'` cada cambio numérico (pctMP,
  pctPersonal, pctImpuestos, pctPublicidad, euroHora, poolProduccion,
  poolEspeciales) que difiera del valor previo se inserta en
  `ab_parametros_historial`. **Decisión**: admin y socio NO loggean
  porque introduce ruido sin valor — el objetivo es rastrear quién
  bajó márgenes desde el rol gerente.
- `GET /api/v1/aires/bootstrap` ahora devuelve además `sub_tabs_bancos[]`
  y nuevos flags: `config_w_log_only`, `bancos_upload_admin`, `print_w`.
- `GET /api/v1/auth/me` ahora devuelve `sub_tabs_bancos[]` y `flags{}`.
  Lo consume `public/js/bancos.js` sin hardcodear matrices en cliente.

### Bloque D — Frontend dashboard (`public/js/main.js`)
- `setUserUI()` consume `ctx.flags` como única fuente de visibilidad UI:
  - Panel `#params-panel` visible cuando `flags.config_w`
    (admin/socio/gerente). Antes hard-coded admin+socio; gerente no
    podía editar.
  - Botón `#tb-imprimir` visible cuando `flags.print_w` (admin/socio).
  - Cuando `flags.config_w_log_only` (rol gerente) se inserta un aviso
    amarillo dentro del panel: "Tus cambios al panel de parámetros
    quedan registrados en el historial de auditoría".

### Bloque E — Frontend bancos (`public/js/bancos.js`)
- `boot()` lee `me.sub_tabs_bancos` y `me.flags` y aplica:
  - Filtrado de tabs: gerente/administrativo ven solo Resumen +
    Proveedores. Movimientos/Análisis gastos/Cruce TPV ocultos.
  - Botón "⬆ Subir extracto / cierres" → flag `bancos_upload_admin`.
  - Botones "Export CSV" → flag `export_w`.
- `showTab(name)` ignora navegación a tabs fuera de `state.subTabsBancos`
  (defense-in-depth contra acceso por consola).

### 2FA obligatorio (commit f21090b previo)
- `requireAuth` redirige a `/account?msg=2fa-required` (browser) o devuelve
  403 (API) si `req.session.user.totp_enabled === false` y la ruta no está
  en whitelist (`/account` + `/api/v1/auth/*`).
- Banner en `/account` se muestra automáticamente y abre el wizard.
- `req.session.user.totp_enabled` se setea al login y se actualiza tras
  `/2fa/confirm` y `/2fa/disable`.

### Matriz autoritativa final
| Rol | Tabs dashboard | Sub-tabs Pedidos | Sub-tabs Bancos | Otros |
|---|---|---|---|---|
| **admin** | todas | todas | todas | export, print, upload, KPIs, vista soc |
| **socio** | todas | todas | todas | print, KPIs, vista soc |
| **gerente** | resumen, ranking, presupuesto, seguimiento, pedidos | mp, personal, hist, rk | resumen, proveedores | KPIs, edita params (loggeado) |
| **administrativo** | seguimiento, pedidos | mp, cmp | resumen, proveedores | pagar pedidos |
| **pedidos** | seguimiento, pedidos | mp, personal | — (sin acceso) | — |
| **personal** | seguimiento, pedidos | mp, personal | — (sin acceso) | — |

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

## Mejora F — Suelo de fecha 2026-01 para no-admin en /bancos → Proveedores (2026-05-21)

**Objetivo**: para roles que no son admin ni socio, restringir el
análisis de proveedores (donut, tabla, drill-down, evolución) a datos
de enero 2026 en adelante. admin/socio sin restricción.

**Cambios backend** (`routes/bancos.js`):

- Constante `PERIODO_FLOOR_NO_ADMIN = '2026-01'`.
- Helper `clampPeriodoParaNoAdmin(req, params)` que:
  - admin/socio → devuelve los params sin tocar.
  - no-admin → si `periodo < suelo` o `periodo_hasta < suelo`,
    marca `fueraDeRango=true` (el endpoint corto-circuita con
    respuesta vacía + `periodo_floor_aplicado`).
  - no-admin → si `periodo_desde < suelo`, lo eleva al suelo.
- Aplicado en `/proveedores`, `/grupo-detalle` y
  `/proveedor-evolucion`. En este último, los params se llaman
  `desde`/`hasta` y la lógica se inlinea.

**Cambios frontend**:

- `public/bancos/index.html`: nota visible `prov-period-floor-note`
  ("Solo se pueden ver datos desde enero 2026."), oculta por defecto.
- `public/js/bancos.js#initProvFiltros`: para no-admin se filtra
  `state.periodos` a `p >= '2026-01'` antes de poblar los selectores
  Desde/Hasta + se muestra la nota. El default Desde/Hasta usa la
  lista filtrada (no se cae al periodo más antiguo del rango total).

**E2E smoke** (server corriendo local, sesiones inyectadas en `ab_session`):

| Caso                                        | Resultado |
|---------------------------------------------|-----------|
| A) admin periodo=2025-08                    | sin restricción: 395 010 € · 43 grupos |
| B) gerente periodo=2025-08                  | empty + floor=2026-01 (`total_gasto=0`) |
| C) gerente desde=2025-10 hasta=2026-03      | clamp desde→2026-01: 413 410 € · 33 grupos |
| D) gerente periodo=2026-02                  | datos normales: 131 376 € · 22 grupos |
| E) gerente rango 2025-08..2025-12           | empty + floor (sin overlap) |
| F) gerente /grupo-detalle periodo=2025-08   | empty + floor |
| G) gerente /proveedor-evolucion 2025-06..2026-04 | 4 meses (2026-01..2026-04), desde clamped |

**Defense in depth**: el filtro UI oculta las opciones; el backend
clampea (o devuelve vacío) en los 3 endpoints aunque el cliente
intente saltarse el selector via URL/herramienta externa.


## 5 bloques — Personal pestaña + parámetros con confirmación + Resumen/Presupuesto Elche + 2FA obligatorio

Refactor coordinado mayo 2026 que toca matriz de permisos, UX
de parámetros, Resumen, Presupuesto y enforcement de 2FA.

### Bloque 1 — Personal como pestaña principal + matriz tabs ajustada

**Backend (`lib/roles.js`):**

- `TABS_DASHBOARD` agrega `personal` entre `seguimiento` y `pedidos`
  (orden final: `resumen·ranking·costos·presupuesto·seguimiento·personal·pedidos·evolucion·traspasos`).
- Se elimina `personal` de `SUB_TABS_PEDIDOS` (ya no es sub-pestaña).
- `evolucion` ahora incluye `gerente` además de admin/socio.

**Frontend:**

- `public/dashboard/index.html`: nuevo `<button data-tab='personal'>` +
  `<div id='sect-personal'>` con KPIs Disponibles/Cargadas/Util%/Rojo y
  tabla `#ped-personal-table`. Se quita el sub-botón Personal en
  Pedidos.
- `public/js/main.js#showTab()`: si `name === 'personal'` invoca
  `window.pedEnterPersonal()`.
- `public/js/pedidos.js`: nueva función `pedEnterPersonal()` que
  renderiza el selector año/mes y llama `renderPersonal()`. Antes era
  ejecutado por `enterPedidosTab()` cuando `sub === 'personal'`.

### Bloque 2 — Parámetros con confirmación explícita + historial auditoría

**Backend:**

- `routes/aires.js` PUT `/api/v1/aires/config` ahora loguea **todos**
  los roles en `ab_parametros_historial` (antes solo gerente).
  `debeLoguear` pasa a `true` siempre.
- Nuevo `GET /api/v1/aires/parametros/last-mod` que devuelve último
  registro (`updated_at`, `email`, campos modificados).
- Migration 11 `ab_parametros_historial` ya estaba en `lib/migrations.js`
  (se mantuvo el id 11 porque el 10 estaba ocupado por
  `gastos_direccion_overrides`).

**Frontend:**

- `public/js/api.js`: nuevo wrapper `lastParamsMod()`.
- `public/js/main.js`:
  - Snapshot `_paramsOriginal` al boot.
  - `_paramsTienenCambios()` compara estado actual vs snapshot.
  - `_showParamsConfirmBar()` muestra/oculta la barra y marca sliders
    sucios con clase `.param-dirty`.
  - `syncSlider()` **ya no auto-guarda**: solo refresca display y
    activa barra de confirmación.
  - Nuevas funciones `confirmParams()` (guarda + recarga
    `fetchLastParamsMod`) y `discardParams()` (restaura snapshot).
  - `updLocalField()` (servicios) ahora bufferea en `_srvDirty`,
    pinta celdas con `.srv-cell-dirty` + ✏️ y muestra `#srv-confirm-bar`.
  - `confirmSrv()` / `discardSrv()` análogos a parámetros.
  - `beforeunload` listener: avisa si hay cambios sin guardar en
    ninguno de los dos buffers.
- `public/dashboard/index.html`:
  - Sliders nuevos rangos: MP `0-60`, Personal `0-50`,
    Impuestos `0-15`, Publicidad `0-10`, €/hora `8-20`.
  - `<div id="params-confirm-bar">` con botones Confirmar/Descartar
    + `<p id="params-last-mod">` ("Última modificación: dd/mm hh:mm por email@…").
  - `<div id="srv-confirm-bar">` dentro de la sección Servicios.
- `public/css/styles.css`:
  - `input[type=range].param-dirty` con accent naranja + track
    amarillo.
  - `.srv-cell-dirty{background:#FEF3C7!important}`.

### Bloque 3 — Resumen: aclaratorio + Elche separado en Vista Sociedad

**Frontend `public/js/main.js`:**

- `rKPIs()` calcula margen total rojo (incluye Elche siempre) **y**
  margen de vista actual. Si difieren, muestra `<p id="mg-comparativa">`
  con la comparativa.
- `elcheCard()` cuando `modoSociedad` está activo, envuelve la card
  con un divisor visual (línea + título violeta
  `⌁ Grupo Hostelero Aires (separado del modo Sociedad)`) para
  enfatizar que Elche está fuera del agregado de sociedad.
- Filtros A/B y por grupos disponibles para gerente (no solo admin/socio).

### Bloque 4 — Presupuesto: Elche siempre visible

**Backend (`public/js/engine.js`):**

- Nueva función `calcBudgetElche(ctx, monthIdx)` exportada en el
  return del IIFE. Devuelve filas de Elche con misma estructura que
  `calcBudget()` (incluye `presBase`, `real`, todas las columnas).
  No se afecta por `modoSociedad`.

**Frontend `public/js/main.js#updPresupuesto()`:**

- Después de la fila TOTAL, si `modoSociedad` está activo, inserta:
  - Separador visual violeta.
  - Subtítulo "Presupuesto Elche (Hostelero, separado de Sociedad)".
  - Filas de `calcBudgetElche()` con todas las columnas (Fac. año
    anterior, Tend. 3M, Var. último mes, Fac. presup., Fac. real,
    etc.).

### Bloque 5 — 2FA obligatorio (verificación)

Ya implementado en commit `f21090b`. Se verifica que sigue activo:

- `lib/auth.js#requireAuth()`:
  - Si `req.session.user.totp_enabled === false` y la ruta no está en
    la whitelist → redirige a `/account?msg=2fa-required`.
  - Para endpoints `/api/*` devuelve 403 con
    `{error: '2fa_required', message, redirect}`.
- `pathPermitidoSin2FA(path)` whitelistea `/account` y todo
  `/api/v1/auth/*` (login, logout, me, 2fa/setup, 2fa/confirm,
  2fa/status) para que un usuario nuevo pueda completar el setup
  sin redirect loop.
- `req.session.user.totp_enabled` se setea en login y se actualiza
  tras `/2fa/confirm` y `/2fa/disable`.

**Commits:**

```
1fe2c6f feat(roles): Personal pestaña principal + matriz tabs ajustada (Bloque 1)
6254583 feat(params): confirmación explícita + historial auditoría + rangos sliders (Bloque 2)
f70c4d0 fix(resumen): margen aclaratorio + Elche separado con divisor visual (Bloque 3)
1d9cc44 fix(presupuesto): Elche siempre visible en sección separada (Bloque 4)
```

(Bloque 5 sin commit nuevo — solo verificación de `f21090b` ya
desplegado.)

## Mejora G — Defaults de la pestaña Proveedores (2026-05-21)

**Objetivo**: arrancar la pestaña /bancos → Proveedores con un set
de filtros más "útil por defecto", evitando que el usuario tenga que
configurar y hacer click en Aplicar para ver algo relevante.

**Cambios**:

1. **Sociedad por defecto**: `sin_elche` ("Sin Elche · 4 sociedades")
   en lugar de "Todas las sociedades". Se setea en
   `initProvFiltros` sólo si el `<select>` aún no tiene valor.

2. **Período por defecto**: mes anterior al actual (Desde = Hasta =
   ese mes). Cálculo al vuelo con `new Date()` → `prev`. Para
   no-admin/socio se eleva al suelo `2026-01` si el mes anterior es
   menor. Si el período calculado no existe en
   `periodosPermitidos` (porque aún no se cargó ese extracto), se
   cae al último período disponible.

3. **Auto-aplicar al cargar la pestaña**: ya estaba implementado vía
   `showTab('proveedores')` → `initProvFiltros()` →
   `loadProvRanking()` (la primera vez `state.prov.loaded=false`).
   No requirió cambios.

4. **Umbral del donut**: default `null` ("Ver todos") en lugar de
   `0.01` (> 1%). Cambios: `state.prov.donutThreshold = null` y el
   `<option value="all">` marcado como `selected` en HTML.

**Edge cases**:

- Estamos a 2026-05-21 → `prev = 2026-04`, sin clamp ni fallback.
- Si fuera enero, `getMonth()-1 = -1` resuelve a diciembre del año
  anterior (`new Date(2026, -1, 1)` → 2025-12), que para no-admin
  cae bajo el suelo y se eleva a `2026-01`. ✓
- Si el extracto del mes anterior no está cargado, el `<select>` no
  tendría esa opción y `.value = '2026-04'` quedaría en blanco; el
  fallback al último período disponible evita ese estado vacío.

**Smoke** (API simulando lo que el front pediría con los defaults):

```
gerente · sin_elche · 2026-04 → 131 160 € · 21 grupos
admin   · sin_elche · 2026-04 → 323 336 € · 37 grupos
```

## Fix H — 2FA setup roto para usuarios sin 2FA aún (2026-05-21)

**Síntoma**: Dani (`daniel.romeroarmada@gmail.com`, rol `socio`) abrió
`/account` para activar 2FA y vio el QR como imagen rota. Admin
(maximilianogbarrios) no tenía el problema.

**Causa raíz** (`lib/auth.js#requireAuth`):

`POST /api/v1/auth/2fa/setup` requiere auth pero NO requiere TOTP ya
activado (sino sería imposible activarlo la primera vez). La whitelist
`pathPermitidoSin2FA(path)` chequeaba `path.startsWith('/api/v1/auth/')`
para dejar pasar esa ruta. Pero `requireAuth` se aplica DENTRO de
`router.post('/2fa/setup', requireAuth, ...)` y el router está montado
con `app.use('/api/v1/auth', ...)`. Dentro de un router montado,
`req.path` es RELATIVO al mount point — `/2fa/setup`, no
`/api/v1/auth/2fa/setup`. Resultado:

- `pathPermitidoSin2FA('/2fa/setup')` → `false` (no match).
- `req.path.startsWith('/api/')` → `false` (también relativo).
- → `res.redirect('/account?msg=2fa-required')` (302 a HTML).
- `fetch` del frontend sigue el 302 → recibe HTML del /account →
  `JSON.parse` falla silenciosamente → `qr_data_url=undefined` →
  `<img src="undefined">` → ícono de imagen rota.

Admin no veía el bug porque `totp_enabled=true` corto-circuita el
chequeo en `requireAuth` antes de llegar a la whitelist.

**Fix** (`lib/auth.js`): usar `req.originalUrl` (sin query) en lugar
de `req.path` para los dos chequeos:

```js
const fullPath = ((req.originalUrl || req.url || '').split('?')[0]) || '';
if (!req.session?.user) {
  if (fullPath.startsWith('/api/')) return res.status(401)...
  return res.redirect('/login');
}
...
if (u.totp_enabled === false && !pathPermitidoSin2FA(fullPath)) {
  if (fullPath.startsWith('/api/')) return res.status(403)...
  return res.redirect('/account?msg=2fa-required');
}
```

**Hardening de UI** (`public/account/index.html`):

- `<img id="qr-img">` gana `width="240" height="240"` +
  `min-width/min-height:240px` y `display:block`, así el placeholder
  reserva espacio antes de cargar y se ve correctamente incluso si la
  fuente del QR tarda. No es la causa del bug pero evita layout-shift.
- `setup()` valida que `qr_data_url` empiece con
  `data:image/png;base64,` antes de asignarlo y agrega `img.onerror`
  para no quedar en "imagen rota" sin feedback.

**E2E completo** (Dani sin 2FA, sesión inyectada, código TOTP
computado en vivo con `authenticator.generate(secret)`):

```
STEP 1 · POST /2fa/setup        → 200 JSON  · qr_data_url 4 550 chars · OK
STEP 2 · POST /2fa/confirm code → 200 {ok:true}
STEP 3 · GET  /2fa/status       → 200 {enabled:true}
STEP 4 · GET  /auth/me          → totp_enabled:true en sesión
STEP 5 · GET  /aires/locales    → 200 (protegida, ya autorizada)
STEP 6 · rollback DB             → totp_enabled=false, totp_secret=null
```

**Regresión verificada** (Dani con `totp_enabled=false`, rutas
no-whitelist deben rebotar):

```
/api/v1/aires/locales       → 403 · 2fa_required
/api/v1/bancos/proveedores  → 403 · 2fa_required
/api/v1/pedidos             → 403 · 2fa_required
/dashboard                  → 302 · /account?msg=2fa-required
/bancos                     → 302 · /account?msg=2fa-required
```

Whitelist (deben pasar):

```
/api/v1/auth/me           → 200 application/json
/api/v1/auth/2fa/status   → 200 application/json
/account                  → 200 text/html
```

`qrcode 1.5.4` y `otplib 12.0.1` ya estaban instalados — sin cambios
de dependencias.
