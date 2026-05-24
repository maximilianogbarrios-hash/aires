// Catálogo de roles + permisos básicos.
//
// admin         — acceso total (incluye /admin y gestión de usuarios)
// socio         — todo excepto /admin
// gerente       — operativo + bancos + presupuestos
// administrativo— mismo nivel que gerente por ahora (refinar después)
// pedidos       — sólo lectura del dashboard + bancos
// personal      — sólo lectura del dashboard (sin /bancos por defecto)

const ROLES = ['admin', 'socio', 'gerente', 'administrativo', 'pedidos', 'personal'];
const ROLE_LABELS = {
  admin:          'Admin',
  socio:          'Socio',
  gerente:        'Gerente',
  administrativo: 'Administrativo',
  pedidos:        'Pedidos',
  personal:       'Personal',
};

// Cada permiso es un string corto. requireRole acepta un rol o array.
//
// Matriz autoritativa por rol:
// ─────────────────────────────────────────────────────────────────────
//                  admin  socio  gerente  admvo  pedidos  personal
// dashboard          ✓      ✓      ✓       ✓       ✓        ✓
// bancos             ✓      ✓      ✓       ✓       ✗        ✗
// bancos_upload      ✗      ✗      ✗       ✗       ✗        ✗   (sólo admin via _admin)
// bancos_upload_admin ✓     ✗      ✗       ✗       ✗        ✗
// config_w           ✓      ✓      ✓       ✗       ✗        ✗   (gerente queda logueado)
// config_w_log_only ✗      ✗      ✓       ✗       ✗        ✗   (escribe en ab_parametros_historial)
// presupuesto_w      ✓      ✓      ✓       ✓       ✗        ✗
// locales_w          ✓      ✓      ✓       ✗       ✗        ✗   (admin/socio/gerente)
// dashboard_kpis     ✓      ✓      ✓       ✗       ✗        ✗
// vista_sociedad     ✓      ✓      ✗       ✗       ✗        ✗
// export_w           ✓      ✗      ✗       ✗       ✗        ✗
// print_w            ✓      ✓      ✗       ✗       ✗        ✗
// users_manage       ✓      ✗      ✗       ✗       ✗        ✗
// pedidos_view       ✓      ✓      ✓       ✓       ✓        ✓
// pedidos_w          ✓      ✓      ✓       ✓       ✓        ✓
// pedidos_mix_w      ✓      ✓      ✗       ✗       ✗        ✗
// pedidos_pagar_w    ✓      ✗      ✗       ✓       ✗        ✗
const PERMS = {
  dashboard:       ['admin','socio','gerente','administrativo','pedidos','personal'],
  // Bancos: 'pedidos' y 'personal' NO acceden (403 via URL directa).
  bancos:          ['admin','socio','gerente','administrativo'],
  bancos_upload:   [],            // deprecated → usar bancos_upload_admin
  bancos_upload_admin: ['admin'], // sólo admin sube extractos/cierres TPV
  presupuesto_w:   ['admin','socio','gerente','administrativo'],
  locales_w:       ['admin','socio','gerente'],
  // Edición de parámetros globales (% MP / Personal / etc.). Gerente puede,
  // pero cada cambio queda registrado en ab_parametros_historial (ver
  // config_w_log_only que dispara el INSERT).
  config_w:          ['admin','socio','gerente'],
  config_w_log_only: ['gerente'],
  users_manage:    ['admin'],
  // KPIs financieros globales (fact. total, margen, viables, horas)
  dashboard_kpis:  ['admin','socio','gerente'],
  // Toggle Sociedad/Completo
  vista_sociedad:  ['admin','socio'],
  // Export de datos descargables (CSV / Excel / PDF). Cualquier endpoint
  // de descarga DEBE protegerse con requirePerm('export_w').
  export_w:        ['admin'],
  // Botón Imprimir del browser.
  print_w:         ['admin','socio'],
  // Módulo Pedidos
  pedidos_view:    ['admin','socio','gerente','administrativo','pedidos','personal'],
  pedidos_w:       ['admin','socio','gerente','administrativo','pedidos','personal'],
  pedidos_mix_w:   ['admin','socio'],
  // Marcar pedido como pagado (cruza con ab_movimientos) — admin y administrativo.
  pedidos_pagar_w: ['admin','administrativo'],
  // ── Materia Prima v2 (módulo nuevo por volumen) ──────────────────────
  // Ver lista de pedidos y catálogo de precios (lectura).
  mp2_view:        ['admin','socio','gerente','pedidos'],
  // Crear pedidos, editar borradores propios, confirmar.
  mp2_w:           ['admin','socio','gerente','pedidos'],
  // Transiciones de estado más allá de "confirmado" (recibido/facturado/pagado)
  // y editar distribución por local. Reabrir pedidos confirmados.
  mp2_avanzado_w:  ['admin','socio','gerente'],
  // Conciliación con débitos bancarios (cruza ab_movimientos). Sensible:
  // sólo admin + Dani (rol socio). Otros socios futuros NO automáticamente
  // — el backend verifica además el email (ver puedeConciliarMp2 en
  // routes/pedidos-mp2.js). El frontend pinta el botón según el flag
  // que devuelve el endpoint /meta.
  mp2_conciliar_w: ['admin','socio'],
  // Editar catálogo de precios + ver historial completo.
  mp2_catalogo_w:  ['admin','socio','gerente'],
  // Eliminar pedidos.
  mp2_delete:      ['admin','socio'],
  // Módulo Ventas (dashboard TPV). Acceso a /api/v1/ventas/*.
  // Permiso amplio para roles que necesitan ver datos de venta agregados.
  // Acceso fino por sub-tab / columna se resuelve en el frontend (ej.
  // pedidos sólo ve productos sin €, personal sólo ve día y hora).
  ventas:          ['admin','socio','gerente','pedidos','personal'],
  // Sub-permiso: importar archivos TPV — sólo admin.
  ventas_upload:   ['admin'],
};

// Matriz de pestañas del dashboard por rol.
// Pestañas no permitidas no aparecen en la barra ni son accesibles via showTab().
// 'personal' es una PESTAÑA PRINCIPAL nueva (movida desde sub-tab de Pedidos).
// Orden visual: Resumen · Ranking · Costos · Presupuesto · Seguimiento · Personal · Pedidos · Ventas · Traspasos
// 'ventas' reemplaza a la antigua tab 'evolucion'. Sin redirect — no
// había URL pública, sólo data-tab interno; el rename es transparente
// salvo por el cambio de label visible.
const TABS_DASHBOARD = {
  resumen:     ['admin','socio','gerente'],
  ranking:     ['admin','socio','gerente'],
  costos:      ['admin','socio'],
  presupuesto: ['admin','socio','gerente'],
  seguimiento: ['admin','socio','gerente','administrativo','pedidos','personal'],
  personal:    ['admin','socio','gerente','pedidos','personal'],
  pedidos:     ['admin','socio','gerente','administrativo','pedidos','personal'],
  ventas:      ['admin','socio','gerente'],
  traspasos:   ['admin','socio'],
};

// Sub-pestañas DENTRO de Pedidos por rol — Personal ya no está acá.
//   mp   = Materia Prima
//   cmp  = Comparativa Bancos
//   hist = Historial
//   rk   = Ranking Eficiencia
//   mix  = % Proveedores
const SUB_TABS_PEDIDOS = {
  mp:       ['admin','socio','gerente','administrativo','pedidos','personal'],
  mp2:      ['admin','socio','gerente','pedidos'],  // nuevo módulo por volumen
  cmp:      ['admin','socio','administrativo'],
  hist:     ['admin','socio','gerente'],
  rk:       ['admin','socio','gerente'],
  mix:      ['admin','socio'],
};

// Sub-pestañas DENTRO de /bancos por rol.
//   resumen, movimientos, gastos, proveedores, cruce
const SUB_TABS_BANCOS = {
  resumen:     ['admin','socio','gerente','administrativo'],
  movimientos: ['admin','socio'],
  gastos:      ['admin','socio'],
  proveedores: ['admin','socio','gerente','administrativo'],
  cruce:       ['admin','socio'],
};

function tabsPermitidas(role) {
  return Object.keys(TABS_DASHBOARD).filter((t) => TABS_DASHBOARD[t].includes(role));
}

function subTabsPedidosPermitidas(role) {
  return Object.keys(SUB_TABS_PEDIDOS).filter((t) => SUB_TABS_PEDIDOS[t].includes(role));
}

function subTabsBancosPermitidas(role) {
  return Object.keys(SUB_TABS_BANCOS).filter((t) => SUB_TABS_BANCOS[t].includes(role));
}

function hasPerm(role, perm) {
  const allowed = PERMS[perm];
  if (!allowed) return false;
  return allowed.includes(role);
}

module.exports = {
  ROLES, ROLE_LABELS, PERMS,
  TABS_DASHBOARD, SUB_TABS_PEDIDOS, SUB_TABS_BANCOS,
  hasPerm, tabsPermitidas, subTabsPedidosPermitidas, subTabsBancosPermitidas,
};
