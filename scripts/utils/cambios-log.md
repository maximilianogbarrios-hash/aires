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

