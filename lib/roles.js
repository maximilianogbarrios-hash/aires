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
  bancos:          ['admin','socio','gerente','administrativo','pedidos'],
  bancos_upload:   ['admin','socio','gerente','administrativo'],
  presupuesto_w:   ['admin','socio','gerente','administrativo'],
  locales_w:       ['admin','socio','gerente','administrativo'],
  config_w:        ['admin','socio','gerente'],
  users_manage:    ['admin'],
};

function hasPerm(role, perm) {
  const allowed = PERMS[perm];
  if (!allowed) return false;
  return allowed.includes(role);
}

module.exports = { ROLES, ROLE_LABELS, PERMS, hasPerm };
