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

