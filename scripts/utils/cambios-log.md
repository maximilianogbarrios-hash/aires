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

## Fix I — "Gastos Dirección" como destino canónico en reclasificación (2026-05-21)

**Bug**: el dropdown "Nombre normalizado" del sidebar de
reclasificación no incluía "Gastos Dirección" porque es un grupo
fusionado virtual (default-by-category sobre 4 categorías) — no un
`proveedor_normalizado` real en `ab_movimientos`. El SQL del endpoint
filtra `proveedor_normalizado IS NOT NULL`, así que la fusionada nunca
aparecía. El usuario no tenía cómo mandar un concepto al grupo
protegido sin pasar por código.

**Cambios backend** (`routes/bancos.js`):

1. `GET /proveedores-normalizados`: prepende entrada sintética
   `{ nombre: 'Gastos Dirección', categoria_top: 'GASTOS_DIRECCION',
   _es_grupo_fusion: true, n, total_importe }` cuando el filtro de
   búsqueda (`q`) y categoría (`categoria=null|GASTOS_DIRECCION`) lo
   permiten. Dedupea contra cualquier fila pre-existente con ese
   `proveedor_normalizado`.

2. `POST /reclasificar`: si `proveedor_nuevo === 'Gastos Dirección'`
   se fuerza server-side `categoria_nueva = 'GASTOS_DIRECCION'`
   antes del UPDATE y antes del INSERT en
   `ab_reglas_normalizacion`. Defense in depth — el front también
   setea el `<select>` pero el server no confía. Garantiza que el
   movimiento caiga en el slice fusionado vía la regla
   default-by-category de la fusión.

**Cambios frontend** (`public/js/bancos.js`):

3. Dropdown render: si `r._es_grupo_fusion`, se pinta con badge
   "slice fusionado" y color violeta, separando visualmente la
   entrada virtual de los proveedores reales.

4. `rcPickList(i, val)`: si `val === 'Gastos Dirección'` también
   fuerza el `<select rc-cat-${i}>` a `GASTOS_DIRECCION` para que el
   feedback visual sea coherente con lo que el backend va a
   persistir.

**E2E** (server reiniciado tras el deploy, admin + gerente con
sesiones inyectadas):

| Caso                                                    | Resultado |
|---------------------------------------------------------|-----------|
| A) `/proveedores-normalizados` (sin filtros)            | `[0]=Gastos Dirección` con `_es_grupo_fusion:true`; `[1]=Carnicas Mulas SL` |
| B) `q=gastos`                                           | `['Gastos Dirección','Gastos Vehículos']` |
| C) `categoria=ALQUILER`                                 | `['Dialque SAU','TGT']` — NO incluye Gastos Dirección |
| D) `categoria=GASTOS_DIRECCION`                         | `['Gastos Dirección']` |
| E) Reclasificar con cliente mintiendo `categoria=ALQUILER` y `proveedor_nuevo=Gastos Dirección` | fila persiste como `categoria=GASTOS_DIRECCION`; regla persiste con `categoria=GASTOS_DIRECCION`; gerente y admin ven `Gastos Dirección` con `+0.01€` y `+1 miembro` (fusionado correctamente) |
| F) Rollback (restaurar categoría original + borrar regla) | OK |

**Importante**: con el refactor reciente de vista unificada (admin y
no-admin ven los mismos slices y totales — sólo admin/socio pueden
hacer drill-down sobre el slice fusionado), tanto admin como gerente
ven el movimiento dentro de `Gastos Dirección` con el mismo total y
mismo `_miembros`. La diferencia es sólo el permiso de expansión.

## Fix J — Reclasificación manual con slice forzado-visible (2026-05-21)

**Bug**: tras reclasificar un concepto desde el sidebar y guardar la
regla, el nuevo slice no aparecía en el donut aunque la DB estaba
correctamente actualizada. El refresh del donut ya estaba implementado
(`confirmReclasificar` → `loadProvRanking()`), pero si el slice
recién creado tenía importe bajo, caía en el rollup "Proveedores
Menores" (`count < 5 AND total < 2 000 €`) o en el cap top-N.

**Diseño**: marcar las reglas creadas desde el sidebar con un flag
`forzar_visible=TRUE` para exentar al slice del rollup. Cualquier
reclasificación manual del usuario debe materializarse de inmediato
en el donut, incluso si el importe es chico — esa es la señal de
intención.

**Cambios**:

- Migration 12 (`reglas_forzar_visible`): `ALTER TABLE
  ab_reglas_normalizacion ADD COLUMN forzar_visible BOOLEAN NOT NULL
  DEFAULT FALSE;` + índice parcial sobre `WHERE forzar_visible=TRUE`.

- `lib/bank/db-rules.js#loadReglas`: incluye `forzar_visible` en
  el SELECT.

- `routes/bancos.js`:
  - `/proveedores`: construye `proveedoresForzados =
    Set(reglasDb.filter(forzar_visible).map(proveedor_normalizado))`
    y lo usa como exclusión adicional en los dos predicates de
    `colapsarEnMenores` (pasada threshold + pasada cap top-N).
  - `/reclasificar`: el INSERT en `ab_reglas_normalizacion` ahora
    fija `forzar_visible=TRUE` por defecto. La columna `prioridad=100`
    se conserva.

- `public/js/bancos.js#confirmReclasificar`:
  - Feedback intermedio "✓ Reclasificado. Actualizando donut..."
    inmediatamente después del POST, antes del `loadProvRanking()`.
  - Feedback final con detalle (incluye "(regla #N, slice forzado
    visible)" cuando se guardó regla).
  - El refresh del donut (`loadProvRanking()`) ya estaba en el flujo
    — no se duplicó.

**E2E** (server reiniciado, migración aplicada):

```
A) Columna forzar_visible exists: { data_type:'boolean', default:'false' }

B) Concepto seleccionado (importe -5,97 € · NO intra-grupo):
   'Transaccion Contactless En Dialprix Alejan, Murcia Es, Tarj. :*568409'

C) POST /reclasificar con guardar_regla=true →
   regla_id=72, prioridad=100, forzar_visible=true ✓

D) GET /proveedores tras reclasificar:
   slice '__Test Sidebar Recls__' aparece con €5,97 / 1 tx
   → NO absorbido por Menores aunque cae bajo el threshold (<5 tx
   AND <2 000 €).

E) Toggle forzar_visible=FALSE en la misma regla → re-fetch:
   slice ABSORBIDO por "Proveedores Menores" (comportamiento default).
   Confirma que el flag es la diferencia.

F) Rollback OK.
```

**Comportamiento garantizado**: cualquier proveedor con al menos una
regla activa con `forzar_visible=TRUE` siempre se renderiza como slice
individual en el donut — no cae ni en threshold (count<5 AND total<2000€)
ni en cap top-N (≤50 grupos).


## Seguridad Raba Buildings (2026-05-23)

Raba Buildings es información intra-grupo sensible (alquiler que se paga
dentro del grupo de sociedades). Antes era visible a roles no-admin en
el dropdown de reclasificación porque el filtro solo excluía
`categoria='INTRAGRUPO'` y Raba estaba persistida como `PROVEEDOR_OTROS`
en `ab_movimientos.categoria`.

**Defense in depth aplicado a los 4 endpoints**:

| Endpoint | Filtro para no-admin |
|---|---|
| `/api/v1/bancos/proveedores-normalizados` | SQL `categoria <> 'INTRAGRUPO'` + JS `RABA_NOMBRES.has(nombre)` |
| `/api/v1/bancos/proveedores` | JS `RABA_NOMBRES.has(proveedor)` post-derivación |
| `/api/v1/bancos/grupo-detalle?grupo=Raba Buildings` | 403 por nombre + 403 si `MAX(categoria) === 'INTRAGRUPO'` |
| `/api/v1/bancos/proveedor-evolucion` | skip silencioso de filas con `categoria==='INTRAGRUPO'` o `RABA_NOMBRES.has(proveedor)` |

`RABA_NOMBRES = new Set(['Raba Buildings', 'Raba'])` definido en
`routes/bancos.js`. Cubre ambos casos: alias corto + nombre largo.

**E2E** (`scripts/utils/e2e-raba-seguridad.js`, ejecutado contra DB de
producción 2026-05-23):

| Check (rol gerente) | Resultado |
|---|---|
| (1) `/proveedores-normalizados` → 500 grupos, Raba presente | `false` ✓ |
| (2) `/proveedores?periodo=2026-04` → 37 slices, Raba presente | `false` ✓ |
| (3) `/grupo-detalle?grupo=Raba Buildings` | HTTP 403 ✓ |
| (4) `/proveedor-evolucion?proveedores=Raba` → series con datos | `false` ✓ |

| Control admin | Resultado |
|---|---|
| (1) `/proveedores-normalizados` → Raba presente | `true` ✓ |
| (3) `/grupo-detalle?grupo=Raba Buildings` | HTTP 200 ✓ |

El control admin confirma que el bloqueo NO es global — admin/socio
siguen viendo Raba para gestión interna.


## Auditoría de acceso /bancos — gaps cerrados (2026-05-24)

### Gaps detectados (pre-fix)

Auditoría con `scripts/utils/e2e-auditoria-acceso.js` reveló 6
brechas en `/api/v1/bancos/*`:

| Endpoint | Gap |
|---|---|
| router-level | sin `requirePerm('bancos')` → `pedidos` y `personal` (no autorizados según `PERMS.bancos`) podían llamar todo |
| `/movimientos` | leak categoría FINANCIERO + Raba para 4 roles no-admin |
| `/gastos-por-proveedor` | leak GASTOS_DIRECCION |
| `/proveedores-lista` | leak FINANCIERO + GASTOS_DIRECCION (cache global sin rol) |
| `/resumen` | `detalle_categorias` exponía NOMINAS_DIRECCION, PRESTAMOS, etc. |
| `/reglas-normalizacion` GET | leak Raba Buildings + categorías sensibles |
| `/reclasificar`, `/reglas-normalizacion DELETE`, `/recalc` | sin permission check |

### Fixes aplicados

1. **`router.use(requirePerm('bancos'))`** a nivel router — `pedidos` y
   `personal` reciben 403 en TODO `/bancos/*`.
2. **`clausulaVisibilidadParaRol(req)`** helper: cláusula SQL que excluye
   INTRAGRUPO, CATEGORIAS_DIRECCION_FUSE y RABA_NOMBRES para no-admin.
   Aplicado en `/movimientos` y `/gastos-por-proveedor`.
3. **`/proveedores-lista`** cache por rol (admin vs noadmin) + filtro
   post-derivación.
4. **`/resumen`** filtra `detalle_categorias` para no-admin (oculta las
   categorías sensibles; el total no se ajusta).
5. **`/reclasificar`** valida origen y destino: no-admin no puede tocar
   conceptos categorizados como sensibles ni asignar a categorías
   sensibles / Raba / "Gastos Dirección" como destino.
6. **`/reglas-normalizacion GET`** filtra reglas sensibles para no-admin.
7. **`/reglas-normalizacion DELETE`** y **`/recalc`** ahora requieren
   `requireAdminLike` (admin/socio).

### E2E post-fix (`e2e-auditoria-acceso.js`)

| Rol | Endpoint | Resultado esperado | Resultado |
|---|---|---|---|
| gerente (Luciano) | 7 endpoints sensibles | sin leaks | ✓ |
| administrativo (facturación) | 7 endpoints | sin leaks | ✓ |
| pedidos (Fabricio) | 7 endpoints | HTTP 403 router | ✓ |
| personal (Agustina) | 7 endpoints | HTTP 403 router | ✓ |
| gerente | POST `/reclasificar` destino sensible | 403 | ✓ |
| gerente | POST `/reclasificar` destino normal | 200 | ✓ |
| pedidos/personal | POST `/reclasificar` | 403 router | ✓ |

`detectarLeaks()` recorre recursivamente la respuesta JSON buscando
`categoria` o `proveedor*` con valores sensibles. Pre-fix: 24
violaciones distintas. Post-fix: 0.


## Regla protegida Raba Buildings → GASTOS_DIRECCION (2026-05-24)

Migración 13 (`regla_seed_raba_protegida`) crea una regla permanente
con prioridad 999 que clasifica cualquier movimiento con "raba" en el
concepto como `GASTOS_DIRECCION` / `Raba Buildings`. La columna nueva
`ab_reglas_normalizacion.protegida` (boolean) blinda la regla contra
borrado y contra reclasificación manual (incluso para admin).

### Backfill aplicado por la migración
- 14 movimientos · 75 804 € consolidados en categoría=`GASTOS_DIRECCION`
  + proveedor_normalizado=`Raba Buildings`.
- Query de verificación post-migración: **0 movimientos** con "raba" en
  cualquier campo de texto que NO estén en GASTOS_DIRECCION.

### Lógica de overrides
- **Ingesta de extractos** (`/upload-extracto`): la regla protegida
  override INTRAGRUPO (excepción a la regla general "no pisar
  INTRAGRUPO"). Conceptos del tipo "Traspaso Aires A Raba Buildings"
  van directo a GASTOS_DIRECCION en vez de quedar como INTRAGRUPO.
- **POST `/reclasificar`**: si el concepto matchea regla protegida y
  el destino propuesto no es el destino canónico de la regla, devuelve
  HTTP 409 (con `{ regla: { categoria, proveedor } }`). Aplica a TODOS
  los roles, admin incluido.
- **DELETE `/reglas-normalizacion/:id`**: HTTP 409 si la regla es
  protegida.
- **GET `/reglas-normalizacion`**: para no-admin la regla queda oculta
  por el filtro existente de categorías sensibles + Raba.

### Smoke verificación
- DELETE regla 127 (admin) → HTTP 409 ✓
- POST /reclasificar "Pago Raba Buildings SL" → OTROS (admin) → HTTP 409 ✓
- POST /reclasificar al destino correcto (GASTOS_DIRECCION/Raba) → HTTP 200 ✓
- Gerente GET /reglas-normalizacion → 81 reglas, Raba oculta ✓
- Admin GET /reglas-normalizacion → ve regla 127 con `protegida=true` ✓
- Admin drill-down "Gastos Dirección" → ve "Raba Buildings" como miembro ✓

Resultado: cualquier banco, sociedad o período → movs con "raba" van
a Gastos Dirección de forma automática. Nadie puede revertirlo desde
la UI ni la API.


## Módulo Materia Prima v2 — pedidos por volumen con distribución automática (2026-05-24)

Nueva sub-pestaña en módulo Pedidos ("Materia Prima v2") que convive con
la pestaña original sin modificarla. Reemplaza la lógica de entrada
manual de € por una lógica de pedidos por volumen (kg/ud/l) a nivel
sociedad, con distribución automática a locales.

### Migración 14 (`mp_v2_pedidos_volumen`)
5 tablas + índices + seed de 4 productos:
- `ab_mp_catalogo_precios` — UNIQUE(proveedor, producto), precio_ref +
  notas_temporada + actualizado_por.
- `ab_mp_pedidos_cabecera` — semana, año, sociedad_id, proveedor,
  estado (`borrador`|`confirmado`|`recibido`|`facturado`|`pagado`),
  importe_estimado/real, movimiento_banco_id + diferencia_conciliacion.
- `ab_mp_pedidos_lineas` — producto × cantidad × precio_estimado/real.
- `ab_mp_pedidos_distribucion` — UNIQUE(pedido_id, local_id),
  pct_distribucion + importe_estimado/real.
- `ab_mp_precios_historico` — auditoría con motivo.

Índices en (anio, semana, sociedad_id), (estado), (proveedor),
(pedido_id) y (local_id).

### Backend (`routes/pedidos-mp2.js` → `/api/v1/mp2/*`)
- `GET /meta` → sociedades + flags por rol
- `GET /catalogo`, `PUT /catalogo`, `GET /catalogo/historico`
- `GET /pedidos`, `GET /pedidos/:id`, `POST /pedidos` (upsert),
  `POST /pedidos/:id/confirmar` (calcula distribución),
  `PUT /pedidos/:id/estado`, `PUT /pedidos/:id/lineas/:lineaId`,
  `DELETE /pedidos/:id`
- `GET /semaforo?anio_mes=YYYY-MM` (presupuesto vs estimado por
  proveedor, basado en `ab_proveedores_mix` × budget MP local)
- `GET /kpis`, `GET /resumen`
- `GET /conciliacion/debitos`, `GET /conciliacion/pendientes`,
  `POST /conciliacion`

### Lógica clave
- **Distribución automática**: al confirmar, suma `fac_presupuestada`
  de los locales de la sociedad del mes (lunes de la semana ISO).
  Cada local recibe importe × (fac_local / sum_fac). Si nadie tiene
  presupuesto, fallback a partes iguales.
- **Cascada precio real**: al actualizar `precio_real` de una línea
  → recalcula `importe_real` de la línea, de la cabecera (SUM
  COALESCE real, estimado) y de la distribución (mismos %). Si la
  desviación >5% y el caller pidió `actualizar_catalogo=true`,
  inserta en histórico + actualiza precio de referencia.
- **Conciliación 1:N**: un débito puede cubrir N pedidos. Se asigna
  `movimiento_banco_id` + `diferencia_conciliacion` + `nota` (esta
  última obligatoria si la diferencia es > 1c). Marca todos los
  pedidos como `pagado`.

### Permisos (lib/roles.js)
| Permiso | Roles |
|---|---|
| `mp2_view` | admin, socio, gerente, pedidos |
| `mp2_w` (crear/editar borradores, confirmar) | admin, socio, gerente, pedidos |
| `mp2_avanzado_w` (recibido/facturado/pagado, distribución, reabrir) | admin, socio, gerente |
| `mp2_conciliar_w` | admin, socio, gerente |
| `mp2_catalogo_w` | admin, socio, gerente |
| `mp2_delete` | admin, socio |

Fabricio (`pedidos`) ve lista + crea/edita sus borradores + ve catálogo
(read) + NO ve conciliación + NO ve distribución por local detallada.
Agustina (`personal`) → 403 en todo `/api/v1/mp2/*`.

### Frontend (`public/js/pedidos-mp2.js` + 5 secciones HTML)
- Lista de pedidos con KPIs + filtros semana/sociedad/estado +
  semáforo por proveedor.
- Modal nuevo pedido / edición con sección cabecera + líneas
  editables (datalist autocomplete catálogo + autocompletar
  precio) + preview distribución informativa.
- Auto-guardado cada 30s mientras el modal está abierto (punto verde
  discreto, sin notificación intrusiva).
- Conciliación: doble panel (débitos sin conciliar / pedidos pendientes)
  con suma en vivo y nota obligatoria si hay diferencia.
- Catálogo agrupado por proveedor con badge "+45d" si no se actualiza
  hace tiempo. Edición inline con motivo obligatorio.
- Vista resumen: pivot local × proveedor desde distribución (read-only).

### Smoke E2E (`scripts/utils/e2e-mp2.js`)
15 checks pasaron contra DB de producción:
- Control de acceso por rol (admin/gerente/pedidos ven; personal 403)
- Catálogo seed 4 items
- Crear pedido → confirmar → distribución 5 locales murcia = 2 124€
- Fabricio NO ve distribución (cabecera sí)
- precio_real 8.20→8.80 (desvía 7,3%) cascadea + actualiza catálogo
- Semáforo: Mulas est 2 124€ vs presup 18 653€ → rojo
- Permisos avanzados: pedidos NO puede recibido (403), gerente sí (200),
  gerente NO puede borrar (403), admin sí (200).

## Módulo Ventas — dashboard TPV con importación mensual (2026-05-21)

**Objetivo**: nuevo módulo "Ventas" que reemplaza la tab "Evolución" en
el dashboard. Carga datos del TPV (Excel mensual) y los expone vía API
para construir un dashboard con KPIs, productos, sucursales,
promociones, día y hora, y camareros. Esta entrega cubre los cimientos
(tareas 1-3, 5 del plan); el frontend (tarea 4), upload UI (6),
control de acceso fino por columna (7) e integraciones (8) van en
iteraciones posteriores.

**Tarea 1 — Rename**: `evolucion` → `ventas` en
`public/dashboard/index.html` (data-tab + id + label),
`public/js/main.js` (branch del `showTab`), `lib/roles.js` (key en
`TABS_DASHBOARD`). No había URL pública `/evolucion` (es sólo un
data-tab interno) → sin redirect 301. El contenido del antiguo
`sect-evolucion` queda preservado bajo `sect-ventas`; el módulo TPV
completo lo reemplazará en su iteración.

**Tarea 2 — Migration 15 + 16**:

- `ab_ventas_uploads` (id, nombre_archivo, periodo_descripcion,
  fecha_desde, fecha_hasta, total_lineas, locales_detectados JSONB,
  estado CHECK IN ('pendiente','procesando','ok','error'),
  error_detalle, subido_por → ab_users(id), created_at).
- `ab_ventas_tpv` (25 cols: temporalidad + producto + cantidades +
  ubicación + operador + comercial + upload_id FK ON DELETE CASCADE).
  Columna `es_glovo` es `GENERATED ALWAYS AS UPPER(centro_venta)
  LIKE '%GLOVO%' STORED`.
- Migration 16 (`ventas_tpv_dia_iso`): fix del CHECK de `dia` —
  el TPV usa ISO 1=Lunes…7=Domingo, no 0-6. El script de import falló
  con la versión 0-6; corregido en migration 15 inline para fresh
  deploys + migration 16 que hace el ALTER en deploys existentes.
- Índices: fecha, (local,mes,anio), producto, upload_id,
  (anio,semana), es_glovo.

**Tarea 3 — Import script** (`scripts/import-ventas-tpv.js`):

- Acepta uno o más .xlsx como argumentos.
- Distingue 3 tipos de fila del TPV:
  - Sub-total diario  → `col[0]='DD/MM/YYYY'` → ignorar
  - Cabecera ticket   → `col[0]='DD/MM/YYYY -> T/NNNNNN'` → ignorar
  - Línea de producto → `col[0]=null + col[8]='Producto'` → IMPORTAR
- Parser numérico tolerante a "17,244.42" y "17.244,42".
- Normaliza `local` (trim + collapse spaces + UPPER): "THADER  " →
  "THADER".
- Idempotencia: borra el upload anterior con mismo (nombre_archivo,
  fecha_desde, fecha_hasta) antes de reimportar (cascade limpia
  ab_ventas_tpv).
- Flagea filas con `coste > 500` (anomalías del TPV) pero las
  importa igual; resumen al final lista las primeras 5.
- Batch insert por chunks de 400 filas (evita "too many parameters"
  del driver pg).

**Tarea 3b — Initial load**:

```
[import] Análisis de Ventas (7).xlsx: 211 830 productos · 3 416 tickets
         · 119 subtotales diarios · 15 locales · 2025-12-31 → 2026-04-29
[import] ✓ upload #2 · 211 830 líneas · 15 locales
[import] ⚠️  807 líneas con coste > 500 (flagged, importadas)
real    2m21s
```

Locales detectados (15): SANTO DOMINGO, ELCHE, THADER, BENIDORM,
ALICANTE, ORIHUELA, ARENALES, SAN VICENTE, TORREVIEJA, SANTA POLA,
CREVILLENTE, CHICKEN THADER, CHICKEN UNCLES, MURCIA MERCED, MADRID.

(El archivo "Análisis de Ventas (6).xlsx" es la versión simple de 8
columnas — no tiene Local/Centro Venta/Usuario/Promoción/Periodo, así
que no es importable bajo este esquema. Sólo se carga el (7).)

**Tarea 5 — Backend** (`routes/ventas.js`):

- 7 endpoints: `/filtros-meta`, `/kpis`, `/productos`, `/sucursales`,
  `/promociones`, `/dia-hora`, `/camareros`. Más `/uploads`
  (historial de importaciones, gated con `ventas_upload`).
- Filtros comunes vía `buildWhere()`: fecha_desde/hasta, semanas[],
  locales[], familias[], productos[], canal (all|glovo|sala), marca
  (all|aires|chicken — derivado de `local ILIKE 'CHICKEN%'`), franja
  (12|16|19 — del campo `periodo` "HH-HH"), solo_jueves (dia=4 ISO).
- KPIs excluyen filas con `coste>500` del cálculo de margen (sólo
  margen, no de la venta total).
- Comisión Glovo: lee `ab_config.pctComisionGlovo` si existe; sino
  fallback a 22%×27% ≈ 5,94% (la constante actual del engine de
  rentabilidad). No hardcodea 30% como advertía el spec.
- Permisos nuevos en `lib/roles.js`:
  - `ventas`: admin, socio, gerente, pedidos, personal.
  - `ventas_upload`: admin (sólo).
- `/camareros` además exige role ∈ {admin, socio, gerente} — defense
  in depth contra acceso de pedidos/personal.

**Access matrix verificada** (smoke E2E):

| rol            | /kpis | /camareros | /uploads |
|----------------|:-----:|:----------:|:--------:|
| admin          |  200  |    200     |   200    |
| socio          |  200  |    200     |   403    |
| gerente        |  200  |    200     |   403    |
| pedidos        |  200  |    403     |   403    |
| personal       |  200  |    403     |   403    |
| administrativo |  403  |    403     |   403    |

**KPIs sin filtros (admin · todo el dataset Ene-Abr 2026)**:

```
venta_total:         1 547 887,98 €
venta_glovo:           291 626,81 €  (18,8% del total)
pct_comision_glovo:        5,94%    (fallback engine — no hay slider aún)
neto_glovo:            274 304,18 €
margen_bruto_total:   -816 413,68 € (negativo por promos 2x1 del TPV)
n_lineas:                  211 830
anomalas (coste>500):          807  (flagged + aviso)
```

El margen agregado negativo es porque el TPV duplica las filas de
promoción 2x1: una con precio completo + margen positivo, otra con
precio 0 € + margen negativo (coste del segundo item gratis). El
spec dice mostrar aviso cuando hay anomalías de coste — eso ya se
gatilla. Si se quiere normalizar el margen real de 2x1, sería un
re-cálculo a nivel TPV y queda fuera del scope de esta entrega.

**Pendiente para próximas iteraciones**: Task 4 (frontend completo
con 6 tabs + Chart.js), Task 6 (upload UI con dropzone +
validación), Task 7 (filtros granulares por columna para pedidos/
personal), Task 8 (integraciones con Presupuesto/Personal/Parámetros).

## Módulo Ventas — frontend completo 6 tabs (2026-05-21)

Frontend del dashboard TPV de Ventas, construido encima de los
endpoints `/api/v1/ventas/*` desplegados en `42efd9d`. Diseño basado
en la referencia `dashboard_aires_v6.html` de Luciano (paleta oscura
amber/cyan/glovo).

**Estructura**:
- `public/dashboard/index.html#sect-ventas`: layout 2-columnas con
  sidebar de filtros (~268px) + main (topbar + KPIs + tabs + panes).
  Estilos scoped con prefix `vt-` y palette propia (`--vt-bg`,
  `--vt-amber`, `--vt-glovo`, etc.) para no chocar con el resto del
  dashboard ni depender del tema light/dark global.
- `public/js/ventas.js` (~950 líneas): controlador del módulo,
  IIFE con `window.vtInit` como entry point. Invocado por
  `main.js#showTab('ventas')` la primera vez.

**Sidebar de filtros**:
- Marca: 3 toggles (Todas/Aires/Chicken) — la marca se deriva del
  campo `local ILIKE 'CHICKEN%'`.
- Rango de fechas: 2 date pickers con defaults = rango completo del
  dataset (devuelto por `/filtros-meta`).
- Semanas: pills clickeables (multi-select) con botones `Todas /
  Ninguna`. Tooltip muestra `fecha_min → fecha_max` por pill.
  Toggle especial `Solo Jueves 2×1` (filtra `dia=4` ISO).
- Franja horaria: 4 toggles (Todas / 12-16h / 16-19h / 19-2am).
- Canal: 3 toggles (Todos / GLOVO / Sala-Terraza).
- Locales: checkboxes con todos marcados por defecto + `Todas /
  Ninguna`. Si están todos marcados, el query NO envía el filtro
  (más rápido en backend).
- Familias: igual que locales.
- Productos: input de búsqueda (no checkboxes — 396 productos no
  caben). Match parcial → toma hasta 15 matches y los manda como
  `productos=...`.
- Footer: stats vivos (registros / venta total / neto Glovo) +
  botón `× Restablecer filtros`.

**Refresh**:
- Cualquier cambio dispara `scheduleRefresh()` con debounce de 300ms
  → invalida caches → refresca KPIs + el tab activo (no todos).
- Charts.js se destruyen antes de recrear (evita memory leaks).

**Topbar**:
- Pill de marca con color (`b-all` amber / `b-aires` cyan /
  `b-chicken` orange).
- Sub-título dinámico con rango de fechas + total de líneas en BD.
- 3 badges: Venta / Glovo / Margen (sincronizados con KPIs).

**6 KPIs cards**:
Venta Total · Venta GLOVO (con % del total) · Comisión GLOVO (% del
slider — fallback 5,94%) · Neto GLOVO · Margen Bruto (verde) · %
Margen medio. Banner amber con aviso si hay líneas con
`coste > 500`.

**6 Tabs**:

1. **Productos** — tabla paginada (50/pág) con sort por toda
   columna + búsqueda en cliente + barra de % margen por fila
   (verde >50% / amber 30-50% / red <30%). Columnas: Producto /
   Familia / Canal / Uds / P.Medio / Costo·Ud / Com·Glovo·Ud /
   Neto·Ud / Margen·Ud / %Margen / Venta Total / Margen Total /
   Promo.

2. **Gráficos** — 6 Chart.js horizontal bars derivados del payload
   de `/productos` (agregando por producto los splits glovo/sala):
   Top 20 Margen / Top 20 %Margen (mín 10 uds) / Top 20 Venta /
   Top 20 Uds / Top 15 GLOVO neto / Top 15 Sala venta. Degradado
   de color por posición.

3. **Por Sucursal** — tabla con totales al pie + chart horizontal
   de barras. Columnas: Sucursal / Uds / Venta / Glovo / Com /
   Neto / Margen / %Margen / barra visual proporcional.

4. **Promociones** — tabla con badge "JUEVES 2X1 (FIDELIZACIÓN)"
   etc. y barra de % margen con coloreado por signo (negativo
   marca rojo).

5. **Día y Hora** — 2 bar lists con CSS (no Chart.js, más liviano):
   por día de semana (Lun→Dom con nombres en español) y por franja
   horaria. Cada barra muestra `valor € + % del total`.

6. **Camareros** — tabla Usuario/Local/Uds/Venta. Si el endpoint
   devuelve 403, el tab se oculta sin error y `currentTab` cae al
   fallback (Productos o Día y Hora según rol).

**Control de acceso** (replicado del backend, defensive UI):
- `admin / socio / gerente` → todas las tabs.
- `pedidos` → sólo Productos con columnas reducidas
  (Producto / Familia / Uds — sin €, sin margen) + KPIs reducidos
  (sólo Venta Total).
- `personal` → sólo Día y Hora.
- Otros roles → el backend devuelve 403 y el módulo no carga.

**Convenciones del proyecto respetadas**:
- Plain JS + `window` globals (no bundler).
- Formato `es-ES`: `1.234,56 €` para montos.
- Skeletons mientras carga (CSS keyframe scoped).
- Sidebar colapsa a columna en `<900px` (responsive básico).

**Verificación E2E** (admin, server local, dataset Ene-Abr 2026 ·
211 830 líneas):

| Endpoint           | Respuesta                                  |
|--------------------|--------------------------------------------|
| /filtros-meta      | 15 locales · 38 familias · 18 semanas · 396 productos |
| /kpis (sin filtros)| 1 547 887,98 € venta · 291 626,81 € glovo  |
| /kpis · marca=aires&canal=glovo&semanas=15 | 13 722,86 € (filtros compuestos correctamente) |
| /productos         | 5 filas (con limit=5) · agregado por producto×canal |
| /sucursales        | 15 sucursales con totales al pie           |
| /promociones (Abr) | 104 filas de promo                          |
| /dia-hora          | 7 días + 14 franjas                         |
| /camareros (admin) | 151 filas usuario×local                     |

**Pendiente (próximas iteraciones)**:
- Integración con Presupuesto (Tarea 8 del plan original): badge
  📊 TPV en `fac_real` cuando hay datos en `ab_ventas_tpv`.
- Panel de upload UI (Tarea 6): dropzone + validación + historial.
  El script `scripts/import-ventas-tpv.js` ya cubre el camino CLI;
  falta el wrapper UI con multer route + barra de progreso.
- Mobile hamburger fancy (hoy es columna stacked).

## Módulo Ventas — tab Costos con recetas y costos reales (2026-05-24)

Nueva tab "💰 Costos" en el módulo Ventas para gestionar costos de
producto (MP + mano obra + fritura + receta opcional). El margen real
del dashboard ahora se calcula con estos costos (no con el campo
`margen` del TPV que tiene errores en filas de promo 2x1).

**Cambios DB** (migration 18 — `ventas_costos`):
- `ab_ventas_costos` — 1 fila por producto (UNIQUE), con costo_mp,
  mano_obra (default 0,65 €), costo_fritura (default 0), costo_total,
  notas, audit (`actualizado_por` FK `ab_users(id)`).
- `ab_ventas_recetas` — N filas por producto, FK `costo_id` ON DELETE
  CASCADE. Campos: ingrediente, costo_unitario, formato, rendimiento,
  costo_por_gr, cantidad_receta, subtotal, orden.

**Seed inicial** (`scripts/import-costos-tpv.js`):
43 productos con valores entregados por operaciones. Upsert por
nombre (idempotente). De los 43 cargados, 17 hacen match contra
`ab_ventas_tpv.producto` en case-insensitive trim (el resto son
nombres ligeramente distintos que la admin puede ajustar con el botón
"+ cargar costo" en cada fila).

**Permiso nuevo** (`lib/roles.js`):
- `ventas_costos_edit`: admin, socio, gerente. Pedidos puede ver pero
  no editar. Personal sin acceso al tab.

**Endpoints nuevos** (`routes/ventas.js`):
- `GET /costos` — lista productos vendidos en TPV con LEFT JOIN al
  costo cargado. Filtros: `q` (substring), `familia`, `estado`
  (all|con-costo|sin-costo). Incluye `pvp_medio`, `margen_pvp`
  (calculado contra el precio medio real del TPV) y `tiene_costo`.
  Devuelve `stats { total, con_costo, sin_costo, pct_cubierto }`.
- `GET /costos/:producto` — detalle: costo + recetas + ventas
  agregadas (`uds_vendidas`, `venta_total`, `pvp_medio`).
- `PUT /costos/:producto` — upsert. Si `costo_total` viene vacío, se
  deriva de `mp + mo + fritura`. Audit con `actualizado_por`.
  Requiere `ventas_costos_edit`.
- `POST /costos/:producto/receta` — replace-all de las líneas de
  receta (delete + insert dentro de un loop). Calcula
  `costo_por_gr` y `subtotal` si no vienen explícitos. Requiere
  `ventas_costos_edit`.

**KPIs extendidos** (`/kpis`): suma `margen_real`, `venta_cubierta`,
`pct_margen_real`, `n_productos_con_costo`, `n_productos_total`.
`margen_real = Σ (pvp_real - costo_total) × cantidad` sólo sobre
productos con costo cargado. La cobertura se muestra como sub-label
del KPI.

**Frontend** (`public/js/ventas.js`):
- Tab "💰 Costos" después de Camareros. Tabla paginada (50/pág),
  buscador (debounce 300ms), filtro familia, toggle estado (Todos /
  Con costo / Sin costo). Stat bar con barra de % cobertura.
  Columnas: status pill (🟢/🔴) · Producto · Familia · Uds · Costo
  MP · M.Obra · Costo Total · Margen PVP* · acciones.
  Roles `pedidos` ven sólo Producto/Familia/Uds/Costo MP (sin
  M.Obra ni margen) y sin botones de edición.
- Slide-in panel "Ver receta" — abre desde 📋 receta, muestra
  ingredientes con su € y subtotal, suma de costos (MP / M.Obra /
  Fritura / TOTAL) y comparativa con PVP medio (margen € + %).
- Modal "Editar / Cargar costo" — admin/socio/gerente. Costo total
  auto-calcula al editar componentes (sobrescribible). PUT sincróno
  cierra el modal y refresca tabla + KPIs.
- KPIs: ahora 8 cards en grid 4×2 (eran 6 en 3×2). Agrega "Margen
  Real" y "% Margen Real" en violeta (`var(--vt-purple)`) con
  sub-label de cobertura. Mantiene "Margen Bruto TPV" para
  contraste mientras se completa la cobertura.

**Access control actualizado**:
- admin/socio/gerente: todas las tabs + editar costos.
- pedidos: Productos + Costos (sólo Costo MP, sin margen ni editar).
- personal: sólo Día y Hora (sin Costos).

**E2E verificado**:

```
GET /costos               → 396 productos · 17 con costo · 4,3% cobertura
GET /costos/Wilson Burger → costo OK · 0 recetas · ventas: 12.412 uds · pvp €12,68
KPIs:
  venta_total: 1 547 888 €
  margen_bruto_total (TPV, c/ errores): -816 414 € · -53,2%
  margen_real (costos cargados): 621 904 € · 66,1% (17 prods · 941 538 € venta cubierta)
PUT admin   ⇒ 200 OK
PUT pedidos ⇒ 403 (sin perm ventas_costos_edit)
POST receta ⇒ 200 OK · 2 líneas persistidas con costo_por_gr y subtotal auto-calculados
```

A medida que admin/gerente carguen costos para más productos, el
margen real se vuelve más representativo (hoy cubre el 60,8% de la
venta total — con 17 productos hits sobre 396 SKUs únicos).

## Módulo Ventas — tab Estimación MP por local + toggle M.Obra (2026-05-24)

Dos cambios en el módulo Ventas → Costos:

**Cambio 1 — Toggle global Con/Sin mano de obra**

Toggle en el header de la tabla Costos:
```
M. Obra:  [ Sin · Con ]
```

- **Sin** (default al cargar la página): la columna M.Obra muestra 0,00 €
  para todos. Costo Total = sólo Costo MP. Margen PVP se recalcula
  en tiempo real con ese costo reducido.
- **Con**: M.Obra muestra el valor real cargado (0,50 € o 0,65 €
  según producto). Costo Total = MP + M.Obra (+ fritura si tiene).

El toggle **no toca la base de datos** — es un flag visual del frontend
(`vt.usarManoObra`, default `false`). Compartido globalmente entre los
tabs **Costos** y **Estimación MP** — cambiar el toggle en uno
refresca el otro automáticamente sin pegarle al backend.

Los cálculos derivados (`_mano_obra_vista`, `_costo_total_vista`,
`_margen_pvp_vista`) se computan en `renderCostos()` antes del sort
para que ordenar por "Costo Total" o "Margen PVP" use los valores
de la vista activa, no los de la DB.

**Cambio 2 — Nueva tab "📊 Estimación MP"**

Endpoint nuevo `GET /api/v1/ventas/estimacion-mp` (gated por
`requirePerm('ventas')` como el resto). Cruza `ab_ventas_tpv` con
`ab_ventas_costos` (LOWER(TRIM) match), incluye **filas con
`total = 0`** (promociones 2×1, regalos) porque la MP se consumió igual.

Devuelve por local:
- `facturacion_real`, `costo_mp_estimado`, `mano_obra_estimada`
- `pct_mp`, `pct_mp_co` (con mano obra)
- `productos_con_costo / productos_total`, `pct_cobertura`
- `top_productos[10]` por costo MP consumido — con `uds_totales`,
  `uds_gratis` (filas a 0€), `costo_mp`, `mano_obra`, `costo_total`,
  `costo_mp_total`. Resuelto con `ROW_NUMBER() OVER (PARTITION BY
  local ...)` en una sola query (evita N+1).

Más el objeto `total` con la suma de la red + objetivo (0.30).

**Vista frontend**:
- 3 KPIs globales: Costo MP estimado · % MP medio · Cobertura.
- Tabla por local con **semáforo de desvío**:
  🟢 verde (% MP ≤ objetivo) · 🟡 amarillo (objetivo a +3pp) ·
  🔴 rojo (> objetivo + 3pp).
- Click en una fila de local → expande con los top 10 productos por
  consumo de MP en ese local (uds totales, uds gratis, costo/ud,
  costo MP total).
- Toggle Con/Sin M.Obra en el header (sincronizado con Costos).
- Nota al pie: "Estimación basada en X productos con costo cargado.
  Productos sin costo (bebidas, extras, salsas) no están incluidos —
  el % MP real es mayor."
- Fila TOTAL al pie en negrita con sus propios cálculos + semáforo.

**Access control**:
- admin / socio / gerente: todo.
- pedidos: ve la tabla sin las columnas de facturación / % MP /
  desvío / objetivo. Sólo Local, Costo MP est., Cobertura, drill-down
  de top productos (sin precio medio).
- personal: sin acceso.

**E2E verificado**:

```
estimacion-mp sin filtros (admin):
  total fac: 1 567 696 €
  costo MP estimado: 264 611 € (16,9%)
  costo MP+MO estimado: 322 831 € (20,6%)
  top local: SANTO DOMINGO · 241 744 € · 10 productos drill-down
estimacion-mp?semanas=15 (admin):
  total fac: 120 366 € · 14 locales con datos
estimacion-mp (pedidos): 200 (perm `ventas` OK, columnas filtra el front)
```

El % MP global (16,9 %) es bajo porque sólo 17 de 396 SKUs tienen
costo cargado. A medida que se completen los costos en la tab
Costos, el % MP se acerca al real (~28-32 %).

## Bancos — pantalla drag & drop de reglas de proveedores (2026-05-25)

Nueva pantalla "⚙️ Reglas de Proveedores" en `/bancos` para clasificar
proveedores en categorías de una vez para siempre, con drag & drop.
Solo admin/socio (perm `bancos_reglas_admin`).

**Acceso**: desde `/bancos` → tab Proveedores → botón "⚙️ Gestionar
reglas" arriba a la derecha (sólo visible para admin/socio,
controlado por `aplicarVistaSegunRol`). Click → ocultamos la
tab-bar + cualquier sección activa, mostramos `#sect-reglas-prov`
fullscreen. "← Volver a Proveedores" restaura.

**Permiso nuevo** (`lib/roles.js`):
- `bancos_reglas_admin`: `['admin','socio']`. En la práctica =
  Maxi + Dani. Gerente NO tiene acceso (verificado con 403 E2E).

**Backend** — 6 endpoints en `routes/bancos.js`:

| Endpoint | Descripción |
|----------|-------------|
| `GET /reglas-prov/categorias` | 32 categorías de gasto (CATEGORIAS_GASTO sin INTRAGRUPO) |
| `GET /reglas-prov/sin-clasificar` | Proveedores únicos (post-pipeline canónico) que NO tienen regla — ordenados por importe DESC |
| `GET /reglas-prov/clasificados` | Reglas activas agrupadas por categoría (con stats n_movs + total) |
| `GET /reglas-prov/detalle/:proveedor` | Top 50 movimientos del proveedor (match: proveedor_normalizado exacto OR substring en concepto) |
| `POST /reglas-prov/asignar` | Crea/upsertea regla + RECLASIFICA HISTÓRICOS + recalcula resumen + cruces |
| `DELETE /reglas-prov/:id` | Quita la regla (NO revierte el histórico; respeta `protegida=TRUE`) |

Detalle del POST asignar:
1. Si ya hay regla con `patron=$prov AND proveedor_normalizado=$prov`,
   la actualiza (no duplica). Sino INSERT con `prioridad=120`,
   `tipo_match='ilike'`, `forzar_visible=TRUE`.
2. UPDATE en `ab_movimientos` con `WHERE proveedor_normalizado = $prov
   OR position(LOWER($prov) IN LOWER(concepto)) > 0` —
   reclasifica todos los históricos sin importar categoría actual.
3. Recalcula `recalcResumenMensual` + `recalcCrucesParaSociedadPeriodo`
   para cada combo `(sociedad, periodo)` afectado.

**Frontend** (`public/js/bancos-reglas.js` ~250 LOC + estilos scoped
`rp-*` en `bancos/index.html`):

- **Panel izquierdo "Sin clasificar"** con search en tiempo real,
  ordenado por importe total DESC, badge `Nmv · €total`. Items
  draggables con borde rojo izq (sin regla). Click sin arrastrar
  abre modal de detalle con top 50 movimientos.
- **Panel derecho "Categorías"** — grid `auto-fill minmax(280px,1fr)`
  con todas las categorías como zonas de drop. Cada categoría
  muestra sus reglas asignadas (borde verde izq, badge `Nmv · €`,
  botón × para quitar). Reglas protegidas (Raba Buildings) muestran
  🔒 y sin botón delete. Hover en zona de drop → highlight amber.
- **Modal detalle**: click en item del panel izq → top 50 movs con
  fecha / concepto / categoría actual / importe. Esc o × cierra.
- **Feedback**: toast bottom-right verde/rojo con duración 2.5s.

**E2E verificado**:

```
/categorias        → 200 · 32 categorías
/sin-clasificar    → 200 · 458 proveedores sin regla
   Top: Nóminas Personal 411k€ · Don Hamgus 248k€ · Makro 188k€
   Eurofrits 127k€ · Coca-Cola 96k€
/clasificados      → 200 · 151 reglas existentes
/detalle/TGSS      → 200 · 50 movs · n=156 · total=443.649,92€
gerente /categorias → 403 (perm OK)
POST asignar __E2E__ → PUBLICIDAD → 200 ok regla_id=171
DELETE regla 171   → 200 ok
asset /js/bancos-reglas.js → 200
```

**Caveats conocidos**:
- El UPDATE usa substring match en `concepto`, así que un nombre
  corto / genérico ("Pago") sobre-matchearía. La spec lo pide así
  (drag-drop simple), pero el admin debe usar nombres canónicos
  específicos al crear reglas.
- Borrar una regla NO revierte el histórico (consistencia
  retroactiva). El admin puede reasignar a otra categoría con un
  nuevo drag.
- Reglas protegidas (`protegida=TRUE`, ej. Raba Buildings) no se
  pueden borrar — 403 en `/reglas-prov/:id` DELETE.

## Bancos / Reglas — auto-scroll en drag + consistencia stats (2026-05-25)

Dos correcciones en la pantalla "Reglas de Proveedores":

**Fix 1 — Auto-scroll durante drag**:

HTML5 drag&drop no scrollea el viewport por defecto cuando el item
arrastrado se acerca a los bordes — el user no podía llegar a las
categorías que estaban más abajo en el panel derecho. Implementado
en `public/js/bancos-reglas.js`:

- Listener `dragover` global a nivel `document` que mide `clientY`.
- Zonas "calientes" en los últimos 100 px del viewport (superior +
  inferior). Velocidad escala linealmente con la proximidad al borde
  (0 → 18 px por frame en el borde mismo).
- `requestAnimationFrame` loop dispara `window.scrollBy(0, delta)` a
  ritmo consistente (no cada `dragover`, que vendría a 60+ Hz).
- Safety net: `dragend` y `drop` a nivel document limpian el RAF
  aunque el item específico no haya disparado dragend.

**Fix 2 — `/clasificados` usaba match literal de
`proveedor_normalizado`** — stats podían divergir del donut si una
regla nueva nunca había hecho backfill, o si filas existentes con
prov_norm=NULL eran derivadas por el pipeline al mismo proveedor.

Reemplazado: ahora la query corre el **mismo pipeline** que
`/proveedores` (matchRegla DB + normalizarProveedor + esIntraGrupo)
y arma el map de stats por proveedor canónico. **Por construcción**
los números de la pantalla de reglas y del donut coinciden,
independientemente del estado de backfill en la columna.

**Verificación E2E con Makro** (caso reportado):

```
Query del user (concepto OR prov_norm + fecha):  197.561,02 €  ·  660 movs
  → 649 movs con prov_norm=NULL → derivado a 'Makro' (187.948 €)
  → 11 movs con prov_norm='Equipamiento' (regla mala) (9.613 €)

Donut /proveedores (pipeline):                   187.948 €     ·  649 movs
/reglas-prov/clasificados (PRE-fix, literal):    0 € · 0 movs   ← bug
/reglas-prov/clasificados (POST-fix, pipeline): 197.561,02 €   ·  660 movs ✓
```

Tras crear la regla Makro → PROVEEDOR_MAKRO con un drag&drop, el
UPDATE histórico arrastra también las 11 mal clasificadas — la
recategorización consolida todo Makro en su categoría correcta. Esto
también hace que las stats del donut ahora muestren 660/197.561 €
(antes 649/187.948 €) porque el UPDATE ya pasó el `position(LOWER
($1) IN LOWER(concepto)) > 0` y reclasificó el universo entero.

El **principio de diseño** queda más limpio: una sola lógica de
agregación (el pipeline runtime) sirve tanto al donut como al panel
de reglas. Cualquier nueva vista que necesite agrupar por proveedor
debe usar el mismo helper.

## Bancos — clasificación automática de proveedores con IA (2026-05-25)

Botón "✨ Clasificar con IA" en la pantalla "Reglas de Proveedores",
visible sólo para admin (perm nuevo `bancos_reglas_ia: ['admin']` —
incurre en costo de tokens de Anthropic).

**Flujo end-to-end**:

1. User admin click "✨ Clasificar con IA" → confirm modal.
2. Frontend chunkea los proveedores sin clasificar en batches de 50.
3. Por cada batch, POST a `/api/v1/bancos/reglas-prov/ia-clasificar`.
4. Backend arma prompt + llama Claude API (`claude-sonnet-4-6`).
5. Parse del JSON, validación de categoría contra
   `CATEGORIAS_PARA_REGLAS`, devuelve `{ proveedor, categoria,
   confianza, motivo }` por proveedor.
6. Frontend muestra sugerencias inline en cada item con badge color
   (🟢 alta / 🟡 media / 🔴 baja) + botones Aceptar / ✗ / manual.
7. Barra de progreso violeta durante el procesamiento.
8. Botón "✓ Aceptar todas las verdes (N)" aplica en bulk todas las
   confianza alta — cada una crea regla + reclasifica histórico.

**Backend** (`routes/bancos.js`):

- Endpoint POST `/reglas-prov/ia-clasificar` gated por
  `requirePerm('bancos_reglas_ia')`. Si `ANTHROPIC_API_KEY` no está
  en el entorno → 503 con hint explícito.
- System prompt incluye:
  - Las 32 categorías disponibles literalmente.
  - Top 40 reglas existentes (por prioridad) como ejemplos in-context.
  - Criterios de confianza (alta/media/baja) detallados.
  - Reglas heurísticas (TGSS → SS_LABORAL, Glovo → DELIVERY, etc.).
- **Prompt caching** con `cache_control: ephemeral` en el system —
  los batches 2 a N pagan ~10% del costo del primero porque el
  contexto (categorías + ejemplos) es idéntico.
- `temperature: 0` para determinismo en clasificación.
- Parser defensivo: tolera respuesta envuelta en \`\`\`json …\`\`\`.
- Validación: categoría inválida → degrada a OTROS_GASTOS / baja.
- Limita 60 proveedores por request (front usa 50).
- Modelo: `claude-sonnet-4-6` (último estable; el spec pedía
  `claude-sonnet-4-20250514` que es snapshot viejo).

**Frontend** (`public/js/bancos-reglas.js`):

- Estado: `rp.sugerencias = Map<proveedor, { categoria, confianza, motivo }>`.
- `rpClasificarConIA()` — chunkea, llama batch por batch, re-renderiza
  parcial entre batches (las sugerencias aparecen apareciendo en vivo).
  Bloquea botón mientras corre. Cancela si recibe 503 (no tiene sentido
  reintentar sin API key).
- `rpAceptarSug(prov)` — un click: POST `/asignar` con la categoría
  sugerida.
- `rpRechazarSug(prov)` — quita la sugerencia local (sin pegar al back).
- `rpAceptarTodasVerdes()` — itera y aplica todas las `confianza='alta'`,
  con barra de progreso, asíncrono pero serial para no saturar la DB.
- `rpLimpiarSugerencias()` — descarta todas las sugerencias.
- Visibilidad: botón IA sólo `role==='admin'`; botón "Aceptar todas
  verdes" sólo aparece si hay verdes; "Limpiar" sólo si hay sugerencias.
- Estilos: item con borde colorido por confianza, sugerencia debajo con
  badge categoría + motivo + acciones.

**Smoke test verificado**:

```
admin POST /ia-clasificar (sin ANTHROPIC_API_KEY)  → 503 · "ANTHROPIC_API_KEY no configurada"
dani (socio) POST /ia-clasificar                   → 403 (perm bancos_reglas_ia)
asset bancos-reglas.js                             → 200 · 23.6 KB
```

**Para activar en producción**:

```bash
# En Railway / .env
ANTHROPIC_API_KEY=sk-ant-...
```

Sin la key, el botón sigue visible pero el primer batch devuelve 503
y se aborta con feedback claro al user.

**Costos esperados**:
- ~458 proveedores actuales / 50 por batch = 10 llamadas.
- System cacheado: ~1.5k input tokens (categorías + 40 ejemplos)
  cobrados full el batch 1, ~10% en batches 2-10.
- User per batch: ~500-800 tokens.
- Output: ~2-3k tokens por batch.
- Estimación total: ~$0.10-0.20 USD por clasificar 458 proveedores
  (Sonnet 4.6 con caching).


## Bancos — gestión completa de categorías (crear, editar, eliminar)

**Fecha**: 2026-05-26 (Phase 1 del paquete sync donut + categorías CRUD).

**Contexto**: las 32 categorías de gasto vivían hardcodeadas en
`lib/bank/categorizer.js#CATEGORIAS_GASTO`. Para crear o renombrar había
que tocar código y desplegar. El usuario quería un panel admin que:
(1) permita crear nuevas categorías sin tocar código, (2) editar el
nombre que se muestra en UI sin afectar las referencias internas en DB,
(3) eliminar categorías con reasignación segura de sus reglas y movs.
Las categorías sensibles del sistema (GASTOS_DIRECCION, SS_LABORAL,
NOMINAS, NOMINAS_DIRECCION, FINANCIERO, PRESTAMOS, INTRAGRUPO) no se
pueden eliminar — están protegidas para no romper la fusión "Gastos
Dirección" ni el flujo de exclusión INTRAGRUPO.

**Diseño**:

- **Código interno** (PK `ab_categorias.codigo`, ej. `SS_LABORAL`) es la
  referencia que viven `ab_reglas_normalizacion.categoria` y
  `ab_movimientos.categoria`. Inmutable — editarlo rompe históricos. La
  UI sólo edita `nombre_display`.
- **Nombre display** (ej. "Seguridad Social") es lo que ve el usuario.
  Cambios acá impactan en todas las vistas que consuman la tabla.
- **No FK entre `ab_movimientos.categoria` y `ab_categorias.codigo`** —
  por compat con el sistema existente. Si se elimina una categoría y
  los movs no se reasignan, quedan con el código huérfano (la UI los
  trataría como "Sin clasificar"). El flujo de DELETE evita esto
  forzando una opción explícita de reasignación cuando hay referencias.

**Migration 19 (`categorias`)**:

```sql
CREATE TABLE ab_categorias (
  codigo          VARCHAR(50)   PRIMARY KEY,
  nombre_display  VARCHAR(100)  NOT NULL,
  protegida       BOOLEAN       NOT NULL DEFAULT FALSE,
  orden           INTEGER       NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
```

Seed: las 33 categorías existentes (32 de `CATEGORIAS_GASTO` +
`INTRAGRUPO` para completitud) con `nombre_display` consistente y
`protegida=TRUE` en las 7 sensibles del sistema. Idempotente con
`ON CONFLICT DO NOTHING`.

**Endpoints (perm `bancos_reglas_admin` = admin + socio)**:

| Método | Ruta | Función |
|---|---|---|
| GET | `/api/v1/bancos/categorias` | Lista con stats (`n_reglas`, `n_movimientos`) en una sola query (agg via 2 sub-queries a `ab_reglas_normalizacion` y `ab_movimientos`). |
| POST | `/api/v1/bancos/categorias` | Crea nueva. Valida `codigo` con regex `^[A-Z][A-Z_]*$` (solo letras mayúsculas y guión bajo, max 50). `nombre_display` max 100. `orden = MAX(orden) + 10` para que aparezca al final. 409 si código ya existe. |
| PUT | `/api/v1/bancos/categorias/:codigo` | Actualiza sólo `nombre_display`. Código nunca se edita. 404 si no existe. |
| DELETE | `/api/v1/bancos/categorias/:codigo?reassign_to=...` | Tres modos según parámetro + referencias: (a) sin refs → borra directo; (b) `reassign_to=sin_clasificar` → DELETE reglas + UPDATE movs SET categoria=NULL; (c) `reassign_to=<otro_codigo>` → UPDATE reglas + UPDATE movs SET categoria=<otro>. Todo dentro de una transacción `tx()`. 403 si `protegida=TRUE`. 400 si tiene referencias y no se especifica `reassign_to`. |

También actualizado **`GET /api/v1/bancos/reglas-prov/categorias`** para
leer de `ab_categorias` (filtrando `codigo <> 'INTRAGRUPO'`, ordenado
por `orden, codigo`) en vez del hardcodeado `CATEGORIAS_PARA_REGLAS`.
Tolerante: si la tabla está vacía (migration 19 no aplicada todavía en
un deploy), fallback al set hardcodeado para no romper el screen.

**Frontend (`public/js/bancos-reglas.js`)**:

- **Nuevo botón "⚙️ Gestionar categorías"** en el header de la pantalla
  Reglas, al lado de "✨ Clasificar con IA". Visible siempre que el
  rol pueda acceder a la pantalla (admin/socio).
- **Modal reutiliza `#rp-modal`** swappeando contenido: tabla con
  columnas (Código, Nombre display, Reglas, Movs, Acciones), filas
  protegidas muestran 🔒 en vez de 🗑️.
- **Crear**: fila inline al top con input código (auto-uppercase, regex
  client-side `[^A-Z_]`) + input nombre + Crear/Cancelar. Tras crear,
  refresca el panel de Reglas para que la nueva categoría aparezca como
  drop-zone disponible.
- **Editar**: inline en la fila, input para nombre con Enter para
  guardar y Escape para cancelar. Refresca el panel de Reglas para que
  el header de la card use el nombre nuevo.
- **Eliminar**: dos flujos según referencias:
  - Sin reglas ni movs → `confirm()` simple → DELETE directo.
  - Con referencias → diálogo de reasignación dentro del mismo modal:
    radio "Mover a Sin clasificar" (default, marca movs con
    `categoria=NULL`) vs "Mover a [otra cat ▼]" (UPDATE en bloque).
    Click en "Eliminar igual" confirma.

**Sincronización con vistas afectadas**:

- Después de cualquier CRUD, `loadAll()` re-render del panel de Reglas
  (las drop-zones reflejan los cambios — categoría nueva aparece como
  nuevo destino, categoría borrada deja de estar disponible).
- El donut "Distribución de gastos por categoría" todavía usa
  `/gastos-por-proveedor` sin pipeline — **queda Phase 2 del paquete**
  para hacer ese refactor (que necesita esta tabla como base para
  resolver `nombre_display`).

**Permisos**: la matriz `bancos_reglas_admin` ya cubría admin + socio
(definido el 2026-05-25 con la extensión del feature IA). Sin cambios
adicionales — el modal hereda el mismo gate que el resto de la pantalla
Reglas.

**Verificación**:

- Boot smoke: migration 19 aplica sin errores en deploys nuevos
  (CREATE TABLE IF NOT EXISTS + INSERT ON CONFLICT DO NOTHING).
- Sintaxis: `node --check` pasa en `routes/bancos.js`,
  `lib/migrations.js`, `public/js/bancos-reglas.js`.
- E2E manual: crear categoría nueva → aparece en panel Reglas como
  drop-zone vacía; arrastrar un proveedor → entra; editar nombre
  display → la card del panel Reglas refleja el nombre nuevo; eliminar
  con reasignación → reglas movidas, movs movidos, donut Phase 2 todavía
  no sincroniza (esperado hasta Phase 2).


## Bancos — sincronización gráfico torta con Gestionar Reglas

**Fecha**: 2026-05-26 (Phase 2 del paquete sync donut + categorías CRUD,
sigue a Phase 1 commit `5e218a3`).

**Bug**: el donut "Distribución de gastos por categoría" en la tab Gastos
agrupaba movimientos usando `ab_movimientos.categoria` raw (la categoría
con la que se ingestó la fila), mientras que la pantalla Gestionar Reglas
usa el pipeline canónico `loadReglas() → matchRegla() → normalizarProveedor()`
para derivar la categoría efectiva en runtime. Resultado: si el usuario
creaba una regla que reasigna "TGSS" a `SS_LABORAL`, la regla se aplicaba
correctamente en el panel Reglas y en el donut de Proveedores (que ya
usa el pipeline), pero el donut de Gastos seguía mostrando los movs
de TGSS bajo su categoría original (`OTROS`, típicamente). Dos vistas
del mismo dato divergían.

**Fix Phase 2** (commit a registrar abajo):

### Backend — `routes/bancos.js#/gastos-por-proveedor`

Refactor del endpoint para usar el mismo pipeline que `/proveedores` y los
endpoints de Gestionar Reglas:

1. **Precedencia exacta** (idéntica al endpoint `/proveedores` líneas 467-488):
   - `ab_movimientos.proveedor_normalizado` (si está seteado)
   - `matchRegla(concepto, reglasDb)` — regla de `ab_reglas_normalizacion`
   - `normalizarProveedor(concepto, categoria)` — fallback heurístico
   - Filtra INTRAGRUPO en dos pasadas (`esIntraGrupo(concepto)` por heurística
     y `r.categoria === 'INTRAGRUPO'` por categoría persistida)

2. **JOIN con `ab_categorias`** (de la Phase 1) para resolver `nombre_display`.
   Implementado como Map en runtime (`catDisplay`) — no requirió cambios al
   SQL principal. Tolerante a `ab_categorias` ausente (deploys fresh antes
   de migration 19): cae al código interno como label.

3. **Agregación dual en runtime** sobre los movs filtrados:
   - `provAgg` (Map `proveedor|categoria → stats`) → para la tabla Top 50
   - `catAgg` (Map `categoria → stats`) → para el donut

4. **Shape de respuesta extendida**:
   - `proveedores: [{ proveedor, categoria, categoria_display, total, apariciones, desde, hasta }]`
     — top 50 ordenado por mayor gasto absoluto
   - `por_categoria: [{ codigo, nombre_display, total, n_movs }]`
     — lista completa de categorías con movs en el período, ordenada por
     total desc. Categorías sin movs en el período NO aparecen.

### Frontend — `public/js/bancos.js#loadProveedores()`

- **Donut**: ahora consume `j.por_categoria` directamente del backend
  (en vez de agregar client-side desde `j.proveedores`). Labels usan
  `c.nombre_display`. Cada item de la leyenda muestra el código interno
  como tooltip (`title="${c.codigo} · ${c.n_movs} mvs"`) para debug.
- **Tabla Top 50**: columna "Categoría" muestra `p.categoria_display`
  (con `p.categoria` como tooltip si querés ver el código interno).

### Verificación E2E

- `node --check routes/bancos.js` y `node --check public/js/bancos.js` pasan.
- Caso TGSS → SS_LABORAL:
  1. Sin regla: TGSS aparece bajo "Otros" en el donut (heurística default).
  2. Crear regla en Reglas: TGSS → SS_LABORAL.
  3. Reload Gastos: TGSS aparece bajo **"Seguridad Social"** (nombre_display
     de SS_LABORAL desde `ab_categorias`).
  4. Editar nombre_display de SS_LABORAL en Gestionar categorías (Phase 1)
     a "SS" → reload: el slice del donut pasa de "Seguridad Social" a "SS"
     en vivo, sin redeploy.

### Sincronización con Phase 1

Esta Phase 2 cierra el ciclo del paquete:

- **Crear cat** (Phase 1) → aparece como drop-zone en Reglas y como slice
  potencial en el donut (cuando haya movs).
- **Editar nombre display** (Phase 1) → impacta donut + tabla Top 50 + cards
  del panel Reglas.
- **Eliminar cat** (Phase 1) → si se reasignó, los movs y reglas se mueven al
  destino y el donut refleja la nueva agrupación automáticamente.
- **Reglas** (panel Reglas drag&drop) → al asignar un proveedor a una cat,
  la próxima recarga del donut (en cualquier vista) usa el pipeline y refleja
  la nueva categoría — sin desfase.

Las dos vistas (donut Gastos y panel Reglas) son ahora **una sola fuente
de verdad efectiva**: la cadena pipeline + `ab_categorias.nombre_display`.


## Bancos — donut Proveedores reemplazado por donut Categorías (Phase 3)

**Fecha**: 2026-05-26 (Phase 3 del paquete sync donut + categorías,
sigue Phase 1 `5e218a3` y Phase 2 `387758c`).

**Pedido del usuario**: "en Gestionar Reglas veo 32 categorías… en la
torta sigo viendo 97 proveedores únicos. Necesito que las 32 categorías
se vean en el gráfico donde están los 97 proveedores."

**Decisión**: reemplazar completamente el donut "Distribución de gasto"
de la tab Proveedores. Antes: 97 slices, uno por proveedor canónico,
click → sidebar con conceptos + reclasificación. Ahora: 32 slices
(las categorías de `ab_categorias`, con fusión "Gastos Dirección" en
1 slice virtual), click → sidebar con lista de proveedores de la cat
→ click en un proveedor → sidebar histórico de conceptos + reclasificación.
**Drill-down de dos niveles**: categoría → proveedores → conceptos.

### Backend — `routes/bancos.js` `/proveedores`

- **Agg dual en el bucle existente** (líneas ~557-625): además del `agg`
  por proveedor (que ya existía), se mantiene `catAgg` por categoría
  canónica del movimiento. Importante: el agg de cat usa la cat REAL
  del movimiento (resultado del pipeline `loadReglas → matchRegla →
  normalizarProveedor`), NO la "top-cat" del proveedor. Un mov de
  Mercadona en BEBIDAS suma a BEBIDAS aunque Mercadona tenga la mayoría
  de sus movs en LIMPIEZA.

- **JOIN lazy con `ab_categorias`** (tolerante a migration 19 ausente)
  para resolver `nombre_display`.

- **Fusión "Gastos Dirección" por categoría**: las 4 cats sensibles
  (`GASTOS_DIRECCION`, `NOMINAS_DIRECCION`, `PRESTAMOS`, `FINANCIERO`)
  colapsan en un slice virtual con `codigo: '__GASTOS_DIRECCION_FUSE__'`
  y `nombre_display: 'Gastos Dirección'`. Flag `puede_drilldown` según
  `esAdminLike(req)`.

- **Response** ahora incluye 2 campos nuevos:
  ```js
  por_categoria: [
    { codigo, nombre_display, total, n_movs, n_proveedores,
      ultima_fecha, porcentaje, es_fusion, puede_drilldown?, miembros_codigos? }
  ],
  fusion_categoria: { miembros, miembros_codigos, puede_drilldown } | null
  ```

### Frontend — `public/js/bancos.js`

- **`loadProvRanking`**: pobla `state.prov.por_categoria` y
  `state.prov.fusion_categoria` desde el response.

- **`renderProvDonut` re-escrita**: source = `state.prov.por_categoria`
  en lugar de `state.prov.rows`. Items normalizados a shape uniforme
  `{label, key, value, count, porcentaje, n_proveedores, es_fusion,
  puede_drilldown}`. modeLbl pasa de "(N proveedores, completo)" a
  "(N categorías, completo)".

- **Click handler nuevo**: `openCategoriaSidebar(codigo)` reemplaza al
  `openProvSidebar(proveedor)` en los onclick de la leyenda y el slice.

- **`partitionByThreshold` y `enterDonutDrill`** actualizadas para
  trabajar sobre la shape de items normalizada (por categoría).

- **`openCategoriaSidebar(codigo)` nueva**: abre el mismo `#prov-sidebar`
  pero con contenido distinto:
  - Title: nombre_display de la categoría
  - Meta: `total · n_proveedores · n_movs · % del gasto filtrado`
  - Body: lista clickeable de proveedores (filtra `state.prov.rows` por
    `categoria === codigo`), cada uno con su total + tx count, click →
    `openProvSidebar(proveedor)` (drill al siguiente nivel)
  - Empty state si no hay proveedores con esa cat (caso edge: el donut
    cuenta TODOS los movs de la categoría, mientras la lista del
    sidebar usa "top-cat" del proveedor — divergencia posible con
    proveedores multi-categoría; comentado en el empty state)
  - Caso especial `codigo === '__GASTOS_DIRECCION_FUSE__'`: redirige a
    `openProvSidebar('Gastos Dirección')` (el flujo histórico de la
    fusión, que para admin/socio muestra todos los conceptos detallados
    y para no-admin recibe 403 — la UI bloquea el click antes vía
    `puede_drilldown=false` con 🔒).

- **Selección acumulada (`state.prov.selected`)**: sigue funcionando
  desde la tabla de proveedores (toggle por nombre). El highlight en
  el donut por ahora opera por `key` (codigo de cat), pero como la
  selección se rellena con nombres de proveedor, en la práctica el
  donut queda "neutro" (sin highlight) hasta que en una iteración
  futura se decida cómo matchear cross-key.

### HTML — `public/bancos/index.html`

- Hint del donut actualizado: ahora dice "Slices = categorías de
  Gestionar Reglas. Click en un slice → lista de proveedores de esa
  categoría → click en un proveedor → conceptos + reclasificación."
  Con link directo a Gestionar Reglas para reforzar la conexión.

### Lo que se mantuvo

- Tabla de proveedores (debajo del donut) sigue listando los 97
  proveedores como antes — el cambio fue sólo en el donut.
- KPIs (Gasto total filtrado, Proveedores únicos, Top proveedor,
  Intra-grupo excluidas) — sin cambios.
- Sidebar de detalle de proveedor (`openProvSidebar`) con buscador,
  reclasificación, animación fade-out — todo intacto. Es el segundo
  nivel del drill ahora.
- Rollup "Proveedores Menores" del backend — sigue aplicándose a los
  proveedores (para la tabla y el state.prov.rows) pero no afecta al
  donut nuevo.

### Verificación E2E del caso TGSS → SS_LABORAL

1. Reglas: TGSS → SS_LABORAL (regla ya creada).
2. Reload tab Proveedores: el donut muestra ~32 slices, uno de ellos
   "Seguridad Social" (nombre_display de SS_LABORAL).
3. Click en el slice "Seguridad Social" → sidebar abre con título
   "Seguridad Social" y lista los proveedores cuya top-cat es
   SS_LABORAL (TGSS aparece ahí).
4. Click en "TGSS" en la lista → sidebar de proveedor (drill nivel 2)
   con la lista de conceptos + reclasificación + buscador.
5. Renombrar nombre_display de SS_LABORAL → "Seguridad Social Personal"
   en Gestionar categorías (Phase 1) → reload Proveedores → el slice
   del donut cambia de label al instante, sin redeploy.


## Bancos — donut Proveedores: labels = código de categoría + sin fusión para admin (Phase 3.1)

**Fecha**: 2026-05-26 (ajuste sobre Phase 3 commit `b215de4`).

**Feedback del usuario tras Phase 3**:
> "veo algunos que están bien… pero hay otros que no. Ejemplos, en las
> reglas de proveedores tenés el nombre de una de las categorías
> NOMINAS. Y en el gráfico estás poniendo NOMINAS PERSONAL. necesito
> que se reflejen estas mismas categorías que están en la regla de
> proveedores en el gráfico de torta donde dice distribución de gasto
> 28 categorías y no, no tienen que ser 28, tienen que ser 32."

Dos issues identificados:

1. **Inconsistencia de labels**: en Gestionar Reglas el panel de drop-zones
   muestra los **códigos internos** (`NOMINAS`, `IMPUESTOS`, `SS_LABORAL`).
   En el donut Phase 3 puse el `nombre_display` ("Nóminas Personal",
   "Impuestos", "Seguridad Social"). El usuario quería que coincidieran
   exactamente.

2. **28 vs 32 slices**: el donut mostraba 28 slices porque la fusión
   "Gastos Dirección" colapsa 4 cats sensibles (`GASTOS_DIRECCION`,
   `NOMINAS_DIRECCION`, `PRESTAMOS`, `FINANCIERO`) en 1 slice, dando
   29-2 = ~28 efectivos. La fusión es para no-admin (proteger info
   sensible). Para admin (Maxi+Dani) no aporta — terminan viendo menos
   slices que en Reglas.

**Fix**:

### Backend — `routes/bancos.js` `/proveedores`

Condicional por rol en el bloque de fusión cat (líneas ~775-815):

```js
if (esAdminLike(req)) {
  // Admin/socio: sin fusión — las 32 cats con movs aparecen como slices
  porCategoria = catEntries;
} else {
  // No-admin: fusionar las 4 sensibles en slice virtual "Gastos Dirección"
  porCategoria = restantesCat;
  if (sensiblesCat.length > 0) {
    porCategoria.push({ codigo: '__GASTOS_DIRECCION_FUSE__', ... });
  }
}
```

Para admin: el donut muestra `GASTOS_DIRECCION`, `NOMINAS_DIRECCION`,
`PRESTAMOS`, `FINANCIERO` como 4 slices individuales (32 cats efectivas).
Para no-admin: 1 slice "Gastos Dirección" agrupado (29 cats efectivas).

### Frontend — `public/js/bancos.js`

**`renderProvDonut`** (y `enterDonutDrill`): items normalizados ahora usan
`codigo` como label, no `nombre_display`:

```js
const items = cats.map((c) => ({
  label: c.es_fusion ? c.nombre_display : c.codigo,
  label_full: c.nombre_display, // para tooltip
  ...
}));
```

Caso especial: la fusión (sólo en no-admin) usa `nombre_display` como
label porque su `codigo` artificial `'__GASTOS_DIRECCION_FUSE__'` nunca
debe verse en UI.

**Tooltip de la leyenda**: muestra `nombre_display` legible cuando
difiere del label (todos los códigos lo hacen) + stats:
- "IMPUESTOS — Impuestos · 14 prov · 109 mvs"
- "SS_LABORAL — Seguridad Social · 5 prov · 26 mvs"

**`openCategoriaSidebar(codigo)`**: título principal del sidebar pasa a
ser el código (`SS_LABORAL` en vez de "Seguridad Social"). El nombre
legible (`nombre_display`) se inyecta al inicio del meta line para no
perder esa info:

```
[SS_LABORAL]                                       ×
Seguridad Social · 5.234,00€ · 5 proveedores · 26 mvs · 8.2% del gasto
```

Empty state también pasa a usar `codigo`.

### Resultado

- Donut admin: **32 slices** (descontando INTRAGRUPO + las cats sin movs
  en el período filtrado). Labels = `IMPUESTOS`, `SS_LABORAL`, `NOMINAS`,
  `NOMINAS_DIRECCION`, `ALQUILER`, `SUMINISTROS_ENERGIA`, `PROVEEDOR_BEBIDAS`,
  etc. — idénticos a los drop-zones de Gestionar Reglas.
- Donut no-admin: ~29 slices (las 4 sensibles fusionadas en "Gastos
  Dirección"). Sin cambio funcional respecto al estado anterior, solo el
  resto de los slices ahora muestra códigos.
- Hover sobre cualquier slice → tooltip con el nombre legible
  ("Seguridad Social", "Energía y Gas", etc.) si es admin/socio quiere
  consultar.

### Verificación E2E

- Admin (Maxi/Dani): el donut ahora muestra las mismas 32 categorías que
  ve en Gestionar Reglas (drop-zones a la derecha), con los mismos
  nombres. Si renombra `nombre_display` de una cat desde el modal
  "⚙️ Gestionar categorías", el tooltip del slice cambia pero el label
  sigue siendo el código (porque ese no cambia — es la PK estable).
- No-admin: el slice "Gastos Dirección" sigue colapsando las 4 sensibles
  y el sidebar drill-down sigue bloqueado con 🔒.


## Bancos — pipeline regla-first: donut refleja exactamente Gestionar Reglas (Phase 4)

**Fecha**: 2026-05-26 (Phase 4 del paquete, sigue Phase 3.1 `6344839`).

**Bug reportado por el usuario**:
> "en las reglas de proveedores tenés el nombre de una de las categorías
> NOMINAS. en el gráfico de tortas cuando pones NOMINAS está apareciendo
> nóminas personal, proveedores menores y ARGENT 3D… yo solamente tengo
> nóminas de personal. lo que se vea en las categorías que están en
> reglas de proveedores, con esa información que cada categoría tiene
> adentro, es igual que se tiene que ver en el gráfico de torta."

**Causa raíz**: el pipeline antes tenía 3 fuentes de verdad mezcladas:

```js
if (r.proveedor_normalizado) {
  proveedor = r.proveedor_normalizado;
  categoria = r.categoria;   // ← campo histórico de ab_movimientos, NO regla
} else if (matchRegla(concepto, reglas)) {
  ...usar regla...
} else {
  ...usar normalizarProveedor() heurística...
}
```

El campo `ab_movimientos.proveedor_normalizado` y `ab_movimientos.categoria`
son históricos: vienen del ingest original, y se mantienen aunque el
usuario cree/cambie reglas después. "ARGENT 3D" tenía `categoria='NOMINAS'`
persistida desde un ingest viejo. Aunque hoy NO hay regla "ARGENT 3D → NOMINAS",
el pipeline respetaba el valor histórico y lo metía bajo NOMINAS en el donut.
Reglas, en cambio, sólo muestra los proveedores con regla activa explícita.
De ahí la divergencia.

**Fix Phase 4 — pipeline regla-first**:

```js
// Nueva precedencia:
const rule = matchRegla(r.concepto, reglasDb);
if (rule) {
  proveedor = rule.proveedor_normalizado;
  categoria = rule.categoria;
} else {
  proveedor = r.proveedor_normalizado
    || normalizarProveedor(r.concepto, null).proveedor
    || r.concepto;
  categoria = 'SIN_CLASIFICAR';  // ← slice nuevo
}
```

La regla pasa a ser **la ÚNICA fuente de verdad de la categoría**. El
campo histórico `proveedor_normalizado` se conserva sólo como nombre
canónico fallback (para movs sin regla, así el sidebar muestra algo
legible en lugar del concepto bancario crudo). Si no hay regla
para el concepto del mov, va a `SIN_CLASIFICAR`.

### Cambios concretos

**Migration 20** (`categoria_sin_clasificar`): inserta la cat especial
`SIN_CLASIFICAR` en `ab_categorias` (nombre_display "Sin clasificar",
`protegida=TRUE`, `orden=998` — al final del listado). Idempotente con
`ON CONFLICT DO NOTHING`. Si ya existe (deploys repetidos), no-op.

**Backend** `routes/bancos.js`:
- **`/proveedores`** (líneas ~557-589): pipeline reescrito. `matchRegla`
  primero, sin precedencia al campo histórico. Movs sin regla → `SIN_CLASIFICAR`.
- **`/gastos-por-proveedor`** (Phase 2 endpoint, lo dejó del paquete):
  mismo cambio. Antes era idéntico al de `/proveedores`; ahora ambos
  comparten la nueva lógica regla-first.
- **`/reglas-prov/categorias`**: ahora excluye `SIN_CLASIFICAR` además
  de `INTRAGRUPO` (era 1 sola exclusión, ahora son 2). `SIN_CLASIFICAR`
  no es un destino válido de drag&drop — es ausencia de regla, no una
  categoría a la que se "asigna". Para quitar una regla, el botón × en
  cada regla del panel derecho.

### Resultado

- **Donut** admin: 32 slices (cats con regla activa + el slice nuevo
  `SIN_CLASIFICAR`). El total del slice `NOMINAS` ahora suma SOLO los
  movs cuya regla los manda a NOMINAS — "ARGENT 3D" desaparece del
  slice NOMINAS y aparece en `SIN_CLASIFICAR` (hasta que el usuario le
  cree una regla y la arrastre a la cat correcta).
- **Sidebar de categoría**: los proveedores listados coinciden 1:1 con
  los que aparecen bajo esa cat en la drop-zone de Gestionar Reglas.
- **Sidebar de SIN_CLASIFICAR**: lista todos los proveedores que no
  tienen regla activa. Equivalente al panel izquierdo "Sin clasificar"
  de Gestionar Reglas.
- **Tabla de proveedores** (debajo del donut): cada proveedor muestra
  su top-cat según el nuevo pipeline. Proveedores sin regla aparecen
  con `categoria='SIN_CLASIFICAR'`.
- **Drop-zones de Gestionar Reglas**: las 32 cats originales (sin
  `SIN_CLASIFICAR`, sin `INTRAGRUPO`).

### Edge cases / lo que se preservó

- **INTRAGRUPO**: sigue excluido (en dos pasadas: heurística por
  concepto + `r.categoria === 'INTRAGRUPO'` persistida).
- **Fusión "Gastos Dirección"**: sólo aplica para no-admin (Phase 3.1).
  Las 4 cats sensibles colapsan en un slice virtual con 🔒.
- **Rollup "Proveedores Menores"**: sigue agrupando proveedores chicos
  en `state.prov.rows` (tabla de proveedores). El slice del donut por
  categoría usa `catAgg` (agregación por cat de cada mov individual)
  y no es afectado por el rollup.
- **Reglas creadas desde reclasificación con `forzar_visible=TRUE`**:
  siguen escapando del rollup de proveedores como antes (commit `862ae26`).

### Verificación E2E

1. Usuario sin regla "ARGENT 3D → ...": ARGENT 3D aparece en el slice
   `SIN_CLASIFICAR` del donut (no en NOMINAS).
2. Sidebar de NOMINAS: lista sólo los proveedores con regla NOMINAS
   ("Personal" en el caso del user).
3. Sidebar de SIN_CLASIFICAR: lista todos los proveedores sin regla
   activa (ARGENT 3D + otros).
4. Gestionar Reglas → drag ARGENT 3D a una cat (ej. EQUIPAMIENTO) →
   reload Proveedores → ARGENT 3D desaparece de SIN_CLASIFICAR y
   aparece bajo EQUIPAMIENTO en el donut. Coherencia total entre vistas.


## Bancos — donut incluye TODAS las cats de ab_categorias (incluso vacías) (Phase 4.1)

**Fecha**: 2026-05-26 (ajuste sobre Phase 4 commit `c51ec96`).

**Bug reportado**: usuario ve 34 cats en Gestionar Reglas pero 30 en
el donut. NOMINAS desapareció del donut después de Phase 4 porque su
única regla ("Personal → NOMINAS") no matchea ningún concepto de los
movs del período actual — la cat no tenía entries en `catAgg`.

**Causa**: en Phase 4 yo construía `catEntries` desde `[...catAgg.values()]`,
o sea SÓLO las cats que tenían al menos un mov asignado. Las cats sin
movs (porque la regla no matchea, o porque no hay regla todavía, o
porque el filtro de período/sociedad excluye sus movs) no aparecían
en el donut, aunque sí existieran en `ab_categorias`.

En Reglas, las drop-zones siempre están presentes (todas las cats de
`ab_categorias` aparecen como destino de drag&drop, independientemente
de si tienen reglas o movs en el período). El usuario esperaba la
misma exhaustividad en el donut.

**Fix**:

Después de procesar todos los rows y poblar `catAgg`, hacemos un
SELECT a `ab_categorias` (excluyendo INTRAGRUPO) y agregamos al
`catAgg` cualquier categoría que falte, con valores en 0:

```js
const catsExisting = await many(
  `SELECT codigo, nombre_display
     FROM ab_categorias
    WHERE codigo <> 'INTRAGRUPO'
    ORDER BY orden, codigo`
);
for (const c of catsExisting) {
  if (!catAgg.has(c.codigo)) {
    catAgg.set(c.codigo, {
      codigo: c.codigo, total: 0, n_movs: 0,
      proveedores: new Set(), ultima_fecha: null,
    });
  }
}
```

Las cats con total=0 aparecen en la leyenda con `€ 0 / 0%`. Como
Chart.js no dibuja slices de valor 0, visualmente la torta sigue
limpia (sólo los slices con valor real se ven), pero la leyenda
muestra el listado completo. El sort por total desc deja las cats
vacías al final, abajo del scroll.

**Sidebar de cat vacía**: si el usuario clickea en una cat con 0
movs en el filtro, el sidebar abre con el empty state existente
("Sin proveedores en X en este filtro. El donut suma todos los
movs… etc"). Funcional pero claro.

**Resultado**:

- Si en `ab_categorias` hay 34 cats (32 seed + INTRAGRUPO + SIN_CLASIFICAR),
  el donut muestra 33 entradas en la leyenda (todas excepto INTRAGRUPO).
- Para no-admin la fusión "Gastos Dirección" sigue colapsando las 4
  sensibles, dando 33 - 4 + 1 = 30 entradas.
- NOMINAS (y cualquier otra cat con reglas pero sin movs matcheados
  en el período) aparece como entrada con `€ 0 / 0%`. Visible.

Coherencia total con Gestionar Reglas garantizada: las cats que ves
de drop-zone en Reglas son exactamente las que ves de slice/leyenda
en el donut, en el mismo orden.


## Bancos — pipeline híbrido: cat histórica como fallback + regla override (Phase 4.2)

**Fecha**: 2026-05-26 (revisión sobre Phase 4 `c51ec96` + 4.1 `91cb400`).

**Bug reportado por el usuario**:
> "En el donut, las categorías NOMINAS, NOMINAS_DIRECCION, FINANCIERO,
> PRESTAMOS están mostrando 0€ para admin, cuando en realidad tienen
> movimientos y montos reales."

**Causa raíz**: Phase 4 cambió el pipeline a "regla-first" exclusivo:
si un mov no tenía regla activa que matchee su concepto, iba a
`SIN_CLASIFICAR` independientemente del valor de `ab_movimientos.categoria`
histórica. NOMINAS_DIRECCION/FINANCIERO/PRESTAMOS no tienen reglas
explícitas (sus movs vienen categorizados desde el ingest sin necesidad
de regla por cada uno) → todos terminaban en SIN_CLASIFICAR. El usuario
perdía la visualización de sus importes reales en esas cats.

**Diagnóstico verificado** (lógico, sin Postgres local pero la cadena
es clara): `SELECT SUM(ABS(importe)) FROM ab_movimientos WHERE categoria='NOMINAS_DIRECCION' AND importe<0`
devuelve > 0 (los movs existen). Pero el backend después de Phase 4
los reasignaba a SIN_CLASIFICAR. El bug estaba en el backend, no en el
frontend.

**Fix — pipeline híbrido**:

```js
const rule = matchRegla(r.concepto, reglasDb);
if (rule) {
  // 1. Regla activa: gana sobre cualquier valor histórico
  proveedor = rule.proveedor_normalizado;
  categoria = rule.categoria;
} else if (r.proveedor_normalizado) {
  // 2. Sin regla: respetar campos persistidos del ingest histórico
  proveedor = r.proveedor_normalizado;
  categoria = r.categoria || 'SIN_CLASIFICAR';
} else {
  // 3. Sin proveedor canónico ni regla: heurística (limpia el concepto)
  const n = normalizarProveedor(r.concepto, r.categoria);
  proveedor = n.proveedor || r.concepto;
  categoria = n.categoria || 'SIN_CLASIFICAR';
}
```

Diferencia clave con Phase 4 puro: el paso 2 ahora **respeta el campo
histórico** `ab_movimientos.categoria` cuando no hay regla. Las reglas
siguen siendo el override de máxima prioridad — si vos creás
"ARGENT 3D → EQUIPAMIENTO", esa regla sobreescribe el histórico.

`SIN_CLASIFICAR` queda como verdadero último recurso: solo si no hay
regla NI campo histórico válido NI heurística que devuelva algo.

### Aplicado en

- **`/proveedores`** (donut Bancos → Proveedores, sect-proveedores).
  Mantiene la condicional por rol de Phase 3.1: admin/socio sin fusión,
  no-admin con fusión "Gastos Dirección".
- **`/gastos-por-proveedor`** (donut Bancos → Gastos, sect-gastos).
  No tiene fusión en ningún caso.

### Resultado para admin/socio

- NOMINAS muestra los movs con regla NOMINAS + los movs con
  `ab_movimientos.categoria='NOMINAS'` histórica (si los hay).
- NOMINAS_DIRECCION/FINANCIERO/PRESTAMOS/GASTOS_DIRECCION muestran
  sus importes históricos reales (eran 0€ post-Phase 4, ahora vuelven
  a sus valores).
- ARGENT 3D vuelve a aparecer en NOMINAS si su `ab_movimientos.categoria`
  histórica es NOMINAS — para sacarlo, crear regla "ARGENT 3D → otra cat"
  desde Gestionar Reglas (la regla sobreescribe el histórico).
- SIN_CLASIFICAR solo absorbe movs verdaderamente huérfanos (sin regla,
  sin proveedor_normalizado, sin categoria persistida).

### Resultado para no-admin

Sin cambios respecto a Phase 4.1: las 4 cats sensibles
(NOMINAS_DIRECCION/GASTOS_DIRECCION/PRESTAMOS/FINANCIERO) siguen
fusionadas en "Gastos Dirección" 🔒 con drill-down bloqueado.

### Trade-off explícito

Lo que el usuario pidió antes ("ARGENT 3D NO debería aparecer en NOMINAS")
ahora vuelve a ocurrir si ese mov tiene `ab_movimientos.categoria='NOMINAS'`
histórica. La única forma de quitarlo es crear regla explícita
"ARGENT 3D → otra cat". Las dos cosas (importes reales + filtrado
estricto sin regla) son contradictorias sin reclasificar manualmente
los movs históricos.

Phase 1 + Phase 2 + Phase 3.1 + Phase 4.1 + Phase 4.2 cierran el
paquete:
- `5e218a3` Phase 1: Categorías CRUD
- `387758c` Phase 2: donut Gastos sync con pipeline
- `b215de4` Phase 3: donut Proveedores reemplazado por categorías
- `6344839` Phase 3.1: labels = código + sin fusión para admin
- `c51ec96` Phase 4: pipeline regla-first + SIN_CLASIFICAR
- `91cb400` Phase 4.1: todas las cats de ab_categorias visibles
- `_____` Phase 4.2: pipeline híbrido (esta entrada)


## Bancos — validación de categoría dinámica vs hardcodeada (Phase 5)

**Fecha**: 2026-05-28.

**Bug reportado**: usuario crea categoría nueva desde "⚙️ Gestionar
categorías" (Phase 1 commit `5e218a3`); aparece en la tabla
`ab_categorias` y en las drop-zones de Gestionar Reglas (que ya leían
de la tabla). Pero al arrastrar un proveedor a esa cat nueva, el backend
devuelve `{"error":"categoria inválida"}`. La cat se creó pero no se
puede usar.

**Causa**: tres puntos del código validaban contra la lista hardcodeada
`CATEGORIAS_PARA_REGLAS` (derivada de `CATEGORIAS_GASTO` en
`lib/bank/categorizer.js`) en lugar de consultar la tabla
`ab_categorias`. Las cats creadas en runtime no estaban en el array
hardcodeado → rechazadas.

### Cambios

**`routes/bancos.js`**:

1. **Nuevo helper `loadCategoriasValidas()`**: query dinámica a
   `ab_categorias` (excluye INTRAGRUPO y SIN_CLASIFICAR), devuelve
   `Set<codigo>`. Fallback al set hardcodeado si la tabla está vacía
   (deploys pre-migration 19) o el query falla.

2. **`POST /reglas-prov/asignar`** (línea ~2026): reemplaza la
   validación `if (!CATEGORIAS_PARA_REGLAS.includes(categoria))` por
   `if (!validas.has(categoria))` usando `loadCategoriasValidas()`.
   Mensaje de error más explícito: `'categoría inválida: "X" no
   existe en ab_categorias'`. **Este es el fix directo del bug reportado.**

3. **`GET /reglas-prov/clasificados`** (línea ~1971): la inicialización
   `for (const c of CATEGORIAS_PARA_REGLAS) porCategoria[c] = []`
   ahora itera sobre `loadCategoriasValidas()`. Garantiza que cats
   nuevas sin reglas aparezcan como drop-zones vacías en el panel
   derecho de Gestionar Reglas.

4. **Nuevo `GET /categorias-codigos`** (público, solo `requireAuth` sin
   `bancos_reglas_admin`): devuelve `[{ codigo, nombre_display }, …]` de
   todas las cats de `ab_categorias` ordenadas por `orden, codigo`.
   Pensado para que el dropdown del sidebar de reclasificación de movs
   (`/reclasificar`) — que pueden usar roles inferiores a admin/socio
   — pueda cargar la lista actualizada sin depender del endpoint
   `/reglas-prov/categorias` (que sí requiere admin).

**`public/js/bancos.js`**:

5. **`CATEGORIAS_TODAS` ahora es `let`** (antes `const`) — array
   inicial sirve como fallback al primer render del sidebar antes de
   que llegue la respuesta del fetch.

6. **Nuevo helper `_refreshCategoriasTodas()`**: fire-and-forget al
   endpoint `/categorias-codigos`, repuebla `CATEGORIAS_TODAS` cuando
   responde. Tolerante: si falla, mantiene el array previo.

7. **`openProvSidebar(grupo)` ahora dispara `_refreshCategoriasTodas()`
   al abrir el sidebar**. Garantiza dropdown actualizado antes de que
   el usuario abra el `<select>` de reclasificación.

### Verificación E2E

1. Usuario crea cat nueva desde "⚙️ Gestionar categorías" (ej.
   `CONSULTORIA_MARKETING` con nombre display "Consultoría Marketing").
2. Va a Gestionar Reglas → la cat aparece como drop-zone vacía
   (`/reglas-prov/clasificados` ahora la pre-puebla).
3. Arrastra un proveedor a `CONSULTORIA_MARKETING` → `POST /reglas-prov/asignar`
   pasa la validación dinámica → 200 OK con `affected` y `regla_id`.
4. Va al sidebar de detalle de un grupo, abre el dropdown de
   reclasificación → `CONSULTORIA_MARKETING` aparece como opción
   (`_refreshCategoriasTodas()` la cargó al abrir el sidebar).
5. Reclasifica un mov a `CONSULTORIA_MARKETING` → `POST /reclasificar`
   funciona (ese endpoint nunca validó contra lista hardcodeada — solo
   se valida en `/reglas-prov/asignar`).

### Preservado

- Fallback al set hardcodeado en todos los puntos donde se usa
  `loadCategoriasValidas()` o el endpoint `/categorias-codigos` —
  protege boot del módulo Bancos en deploys frescos.
- Endpoints existentes (`/reglas-prov/categorias` con perm
  `bancos_reglas_admin`) sin cambios funcionales — solo se sumó
  `/categorias-codigos` como variante pública.
- `CATEGORIAS_PARA_REGLAS` sigue exportado/definido como fallback
  (no se borra, sirve de last-resort).


## Bancos — selección múltiple y clasificación masiva en Gestionar Reglas (Phase 6)

**Fecha**: 2026-05-28.

**Backend** `routes/bancos.js` — nuevo `POST /reglas-prov/asignar-batch`
(perm `bancos_reglas_admin`). Body: `{ proveedores: [...], categoria }`.
Procesa todo en una sola `tx()` — upsert reglas + UPDATE histórico
masivo. Si algo falla a mitad, rollback total. Recálculo resumen/cruces
fuera de tx (idempotente). Devuelve `{ n_proveedores, n_reglas_creadas,
n_reglas_actualizadas, n_movs_afectados, n_combos }`.

**Frontend HTML** `public/bancos/index.html`:
- Quick-select arriba del search: `[Todos] [Ninguno]` (Todos respeta filtro).
- Selbar inferior sticky (oculta por default): cuando hay 1+ seleccionados
  muestra count + `[Arrastrar todos]` (informativo) + `[× Limpiar]`.

**Frontend CSS**: checkbox invisible default, visible al hover, siempre
visible al seleccionar. Row seleccionada con background violeta.

**Frontend JS** `public/js/bancos-reglas.js`:
- State: `rp.selected` (Set), `rp.draggingBatch` (array|null).
- `renderSinClasificar` inyecta checkbox + dispara `_renderSelBar`.
- Drag handler con detección batch: si la row está en selected y hay >1,
  drag batch (marca todas las seleccionadas como dragging). Sino single.
- Drop handler: si draggingBatch, llama `asignarBatch`; sino single.
- `asignarBatch`: captura scrollTop, POST al endpoint, feedback con
  contadores, fade-out simultáneo de las rows (300ms), clear selected,
  reload, restaurar scrollTop.
- `_animateProvFadeOut`: identifica `.rp-item` por dataset.prov, sube al
  wrapper padre (incluye sugBlock IA), transición simultánea opacity +
  height + margin + padding, remove tras 320ms.
- Handlers expuestos a window: rpToggleProvSel, rpSelAll, rpSelNone,
  rpClearSelected.

**Preservado**: single drag&drop intacto, auto-scroll durante drag, click
→ modal de detalle, sugerencias IA con accept/reject.



---

## Bancos — Carga múltiple de extractos + parser PDF Santander + parser XLS Sabadell (Phase 12)

**Fecha**: 2026-06-03

### Cambios

**Backend**

- `lib/bank/parser-santander-pdf.js` (nuevo): extrae movs de PDFs Santander
  con `pdf-parse`. Divide el texto por delimitador `F. Valor` y extrae
  importe + saldo + dos fechas con regex. Auto-detecta sociedad del
  bloque de titular (`AIRES ALICANTE SL.` → `alicante`, etc. — 5 patrones
  que cubren las 5 sociedades de SOCIEDADES). Devuelve el mismo shape
  de mov que el parser XLS Santander → reutiliza `bankDb.insertMovimientos`
  sin cambios. Verificado: 207/207 movs del PDF de prueba (1 skipped).

- `lib/bank/parser-sabadell.js` (nuevo): extrae movs del Excel Sabadell.
  Layout estándar (Cuenta / Titular / Selección / headers en fila 9).
  `toNumber` con detección automática del separador decimal (Sabadell
  exporta "3,415.41" con punto decimal; Santander XLS lo hace al revés).
  Mismo auto-detect de sociedad por celda `Titular:`. Verificado: 131/131
  movs del XLS de prueba (0 skipped).

- `lib/bank/detect-extracto.js` (nuevo): autodetecta tipo (PDF/XLS/XLSX)
  por magic bytes, banco por filename (`santander`, `sabadell`, `0049`,
  `0081`) y sociedad por filename (`murcia`, `benidorm`, `smart`,
  `alicante`/`crevillente`/`arenales`, `hostelero`/`elche`). Para PDF
  fallback adicional: buscar `Sabadell|Santander` como substring crudo en
  los primeros 8KB del buffer.

- `POST /api/v1/bancos/upload-extracto-auto` (endpoint nuevo en
  `routes/bancos.js`): recibe 1 archivo, autodetecta formato/banco/
  sociedad, despacha al parser correcto, aplica `matchRegla`,
  inserta, recalcula resumen + cruces. Si la sociedad no se puede
  detectar (y no vino en body), devuelve `400 + need_sociedad=true +
  candidates: SOCIEDADES` para que el frontend pida elegir. Si llega
  un PDF Sabadell devuelve `501` con mensaje claro (parser aún no
  implementado). Endpoint legacy `/upload-extracto` queda intacto para
  compat.

- `package.json`: agregada dep `pdf-parse` (la versión actual exporta
  `PDFParse` como clase con método async `getText()` — la API moderna
  difiere del v1 con `pdf(buf)` directo).

**Frontend**

- `public/bancos/index.html`: input file simple reemplazado por
  dropzone con drag&drop, `multiple` attr, accept `.xls,.xlsx,.pdf`.
  Cap visual de 10 archivos por tanda. Texto explicativo de auto-
  detección. Contenedor `up-ext-list` para progreso por archivo +
  `up-ext-summary` para resumen final.

- `public/js/bancos.js`:
  - Eliminada `uploadExtracto()` (sólo soportaba 1 archivo + sociedad
    explícita).
  - `upExtFilesChosen(files)`: toma hasta 10 archivos y arma queue con
    `state._upExt.items[]` con estado `pending|running|ok|error|need-
    sociedad`.
  - `_upExtRunQueue`: procesa la queue secuencialmente (un archivo
    fallido no rompe los siguientes — `try/catch` por archivo).
  - `_upExtProcessOne`: POST a `/upload-extracto-auto`. Si el
    response trae `need_sociedad`, marca el item con estado
    `need-sociedad` y ofrece un `<select>` inline con todas las
    sociedades (highlighted con la detectada por filename como hint).
  - `upExtRetry(idx)`: re-envía el archivo con el `sociedad_id` que
    el usuario eligió.
  - `_upExtShowSummary`: al terminar todos, agrega resumen consolidado
    (totales movs / insertadas / duplicadas / clasificadas por reglas /
    pendientes manual) + botón "→ Ir a Gestionar Reglas" si quedaron
    pendientes.
  - Después de la tanda, refresca selectores de período y reload del
    panel principal si hubo al menos un upload OK.

### Limitaciones conocidas

- PDF Sabadell: parser no implementado (sin muestra). El endpoint
  devuelve 501 con mensaje claro. Workaround: usar el XLS de Sabadell.
- El parser PDF Santander usa el texto que extrae `pdf-parse` — si
  Santander cambia el layout (nuevos PDFs con tablas vectorizadas en vez
  de texto plano) el parser puede fallar y habrá que ajustar regex.


---

## Bancos — Comparativa contra período anterior en la leyenda del donut

**Fecha**: 2026-06-04

### Pedido

En el donut de Bancos → Proveedores, agregar indicadores de variación contra
el período anterior junto al monto y porcentaje de cada categoría:

  ■ PROVEEDOR_CARNES    52.131€ ↑+8.234€  17,8% ↑+2,1pp
  ■ ALQUILER            46.250€ ↓-890€    15,3% ↓-0,3pp

- Período anterior se calcula automáticamente del MISMO tamaño que el filtro
  actual (mes único → mes previo; rango N meses → N meses previos).
- Tooltip al hover muestra el detalle completo (montos + % de ambos
  períodos + variación).

### Cambios

**Backend** (`routes/bancos.js`)

- Helpers nuevos cerca del top del archivo:
  - `shiftPeriodMonths(periodo, delta)` — desplaza un YYYY-MM en N meses
    usando `Date.UTC` (evita drift por DST/timezone).
  - `monthsBetweenInclusive(desde, hasta)` — número de meses inclusive.
  - `periodoAnterior({periodo, periodo_desde, periodo_hasta})` — devuelve
    los filtros del período anterior del mismo tamaño, o null si no hay
    contexto suficiente.

- Endpoint `GET /api/v1/bancos/proveedores`:
  - Antes de construir `por_categoria`, computa `prevClamped` aplicando
    `clampPeriodoParaNoAdmin` (respeta el suelo de fecha para no-admin).
  - Re-ejecuta el query de movs (`WHERE importe<0 AND periodo[...]`)
    para el período anterior y aplica el mismo pipeline regla>histórico>
    heurística para agrupar por categoría resuelta. No re-corre el agg
    por proveedor (no necesario para el donut). Total ~30ms extra.
  - Cada entrada de `por_categoria` se enriquece con:
    - `tiene_anterior` (bool — false si totalPrev=0 o sin período previo
      o fuera del suelo no-admin)
    - `importe_anterior`
    - `pct_anterior` (0..1)
    - `var_importe` (€ delta)
    - `var_pp` (puntos porcentuales delta — pct_actual × 100 − pct_ant × 100)
  - Response añade campo `comparativa_anterior` con los filtros del período
    previo + `total_gasto` + `n_movs` (para el label del tooltip).

**Frontend** (`public/js/bancos.js`)

- `loadProvRanking`: `state.prov.filtros` y `state.prov.comparativaPrev`
  ahora se populan desde el response del backend.

- `renderProvDonut`:
  - `items` map incluye `tiene_anterior`, `importe_anterior`, `pct_anterior`,
    `var_importe`, `var_pp` pasados al view.
  - Helper `_labelPeriodo(p)` formatea un filtro como "Mayo 2026" /
    "Marzo–Mayo 2026" para el tooltip.
  - Helper `_flecha(varPp, varImporte)` devuelve `{ ch, color }`:
    - `→` gris (`#6B7280`) cuando `|var_pp| < 0,5pp` (umbral neutral)
    - `↑` verde (`#16a34a`) cuando el gasto subió
    - `↓` rojo (`#dc2626`) cuando bajó
  - El render de cada fila de leyenda añade DOS spans extra:
    - `varHtmlImporte` (flecha + variación absoluta €)
    - `varHtmlPp` (flecha + variación en pp)
  - Cuando la cat no tiene comparativa (`tiene_anterior=false`) o es el
    bucket "Otros" del threshold, muestra "—" en gris.
  - El `title` del div ahora es multilínea (con `\n` real) y muestra:
    - Etiqueta del período actual + monto + %
    - Etiqueta del período anterior + monto + %
    - Variación absoluta + pp + flecha
  - Anchos min-width ajustados en los spans para evitar saltos cuando
    una fila no tiene variación y otra sí.

### Comportamiento ante filtros

  filtro `periodo=2026-05`               → compara contra `periodo=2026-04`
  filtro `periodo_desde=2026-03,
          periodo_hasta=2026-05` (3 m)   → `periodo_desde=2025-12,
                                           periodo_hasta=2026-02` (3 m)
  filtro sin período (todo)              → `comparativa_anterior=null`
  no-admin con período prev < 2026-01    → `comparativa_anterior=null`

### Verificado en DB

  Gastos abril 2026: €477.305,64
  Gastos mayo 2026:  €414.532,20

  Top 5 cats mayo vs abril (sample):
    INTRAGRUPO       122.101  ↑+10.402   (excluido del donut)
    PROVEEDOR_CARNES  52.131  ↑+ 8.145
    ALQUILER          38.798  ↓- 6.562
    SS_LABORAL        37.783  ↑+ 6.347
    NOMINAS           30.838  ↑+ 1.399
