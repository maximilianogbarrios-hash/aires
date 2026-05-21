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
const PERMS = {
  dashboard:       ['admin','socio','gerente','administrativo','pedidos','personal'],
  // Bancos: 'pedidos' NO accede (mejora 8). 'personal' tampoco.
  bancos:          ['admin','socio','gerente','administrativo'],
  bancos_upload:   ['admin','socio','gerente','administrativo'],
  presupuesto_w:   ['admin','socio','gerente','administrativo'],
  locales_w:       ['admin','socio','gerente','administrativo'],
  config_w:        ['admin','socio','gerente'],
  users_manage:    ['admin'],
  // KPIs financieros globales y toggle Sociedad/Completo
  dashboard_kpis:  ['admin','socio','gerente'],
  vista_sociedad:  ['admin','socio'],
  // Módulo Pedidos
  pedidos_view:    ['admin','socio','gerente','administrativo','pedidos'],
  pedidos_w:       ['admin','socio','gerente','administrativo','pedidos'],
  pedidos_mix_w:   ['admin','socio'],
  // Marcar pedido como pagado (cruza con ab_movimientos) — sólo admin y administrativo.
  pedidos_pagar_w: ['admin','administrativo'],
};

// Matriz de pestañas del dashboard por rol (mejora 8).
// Pestañas no permitidas no aparecen en la barra ni son accesibles vía showTab().
// El rol 'pedidos' SÓLO ve la pestaña Pedidos (entra directo a la sub-tab MP).
const TABS_DASHBOARD = {
  resumen:     ['admin','socio','gerente','administrativo','personal'],
  ranking:     ['admin','socio','gerente','administrativo'],
  costos:      ['admin','socio','gerente'],
  presupuesto: ['admin','socio','gerente'],
  seguimiento: ['admin','socio','gerente','administrativo'],
  pedidos:     ['admin','socio','gerente','administrativo','pedidos'],
  evolucion:   ['admin','socio','gerente'],
  traspasos:   ['admin','socio','gerente'],
};

// Matriz de sub-pestañas DENTRO de Pedidos por rol.
// El rol 'pedidos' SÓLO ve "Materia Prima" (mp). Los demás roles ven todo.
const SUB_TABS_PEDIDOS = {
  mp:       ['admin','socio','gerente','administrativo','pedidos'],
  personal: ['admin','socio','gerente','administrativo'],
  mix:      ['admin','socio'],
  cmp:      ['admin','socio','gerente','administrativo'],
  hist:     ['admin','socio','gerente','administrativo'],
  rk:       ['admin','socio','gerente','administrativo'],
};

function tabsPermitidas(role) {
  return Object.keys(TABS_DASHBOARD).filter((t) => TABS_DASHBOARD[t].includes(role));
}

function subTabsPedidosPermitidas(role) {
  return Object.keys(SUB_TABS_PEDIDOS).filter((t) => SUB_TABS_PEDIDOS[t].includes(role));
}

function hasPerm(role, perm) {
  const allowed = PERMS[perm];
  if (!allowed) return false;
  return allowed.includes(role);
}

module.exports = { ROLES, ROLE_LABELS, PERMS, TABS_DASHBOARD, SUB_TABS_PEDIDOS, hasPerm, tabsPermitidas, subTabsPedidosPermitidas };
