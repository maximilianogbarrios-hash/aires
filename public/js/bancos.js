// Módulo /bancos — orquestador de las 4 sub-tabs.

const $ = (id) => document.getElementById(id);
const eur = (v) => v == null ? '—' : new Intl.NumberFormat('es-ES', { style:'currency', currency:'EUR', maximumFractionDigits:0 }).format(Math.round(v));
const eur2 = (v) => v == null ? '—' : new Intl.NumberFormat('es-ES', { style:'currency', currency:'EUR', maximumFractionDigits:2 }).format(v);
const pct = (v) => v == null ? '—' : `${(v*100).toFixed(3).replace('.',',')}%`;
const clrG = (v) => v >= 0 ? 'var(--text-success)' : 'var(--text-danger)';

// Helper para atenuar un color hex (#RRGGBB) aplicando alpha → rgba.
// Usado por renderProvDonut() cuando hay selección parcial: los slices
// NO seleccionados se ven con menos opacidad para destacar los marcados.
function _hexFade(hex, alpha) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${alpha})`;
}

const state = {
  sociedades: [], direcciones: {}, periodos: [],
  current_sociedad: null, current_periodo: null,
  resumen: [], cruces: [], proveedores: [],
  movs: { total: 0, rows: [] }, mov_offset: 0, mov_limit: 50,
  prov: {
    rows: [], total: 0, intra: 0, n_intra: 0, loaded: false, vista: null,
    sort: { col: 'total_importe', dir: -1 },     // -1 desc, +1 asc
    donutThreshold: null,                          // % mínimo de participación: 0.10|0.05|0.01|0.005|null (Ver todos). Default: Ver todos.
    donutDrillOpen: false,                         // drill-down "Otros" abierto
    donutDrillRows: null,                          // filas que cayeron bajo el umbral
    selected: new Set(),                           // set de proveedor seleccionados para el contador acumulado
  },
  user: null,
};

const PERIOD_LABELS = (p) => {
  if (!p) return '';
  const [y, m] = p.split('-').map(Number);
  const meses = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  return `${meses[m-1]} ${y}`;
};

const SOCIEDAD_ABBR = {
  hostelero: 'GHA',
  alicante:  'AAL',
  smart:     'SMA',
  murcia:    'MUR',
  benidorm:  'BEN',
};

const COLORS_CAT = [
  '#185FA5','#639922','#BA7517','#A32D2D','#7C3AED','#DB2777','#0891B2','#D97706',
  '#059669','#DC2626','#0F766E','#9333EA','#B45309','#1E40AF','#15803D','#9F1239',
];

let chMensual = null, chGastos = null, chProvDonut = null, chEvolucion = null;

// Estado para el módulo Evolución temporal de proveedores
const evState = {
  proveedores_lista: [],        // [{proveedor, categoria}]
  categorias_lista: [],         // ['PROVEEDOR_CARNES', ...]
  seleccionados_prov: [],
  seleccionados_cat: [],
  cargados: false,
};

async function api(url, opts = {}) {
  const r = await fetch(url, {
    ...opts,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  if (r.status === 401) return location.href = '/login';
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

async function boot() {
  let initialTab = null;
  try {
    const me = await api('/api/v1/auth/me');
    state.user = me.user;
    state.subTabsBancos = me.sub_tabs_bancos || null;
    state.flags = me.flags || {};
    $('tb-user').textContent = `${me.user.email} (${me.user.role})`;
    // Vista dual: admin/socio ven "Todos los gastos"; resto ven "Proveedores operativos".
    aplicarVistaSegunRol();
    // Flags servidor (single source of truth en lib/roles.js):
    const f = state.flags;
    const btnUpload = $('btn-upload-toggle');
    if (btnUpload) btnUpload.style.display = f.bancos_upload_admin ? '' : 'none';
    const btnExpM = $('m-btn-export');
    if (btnExpM) btnExpM.style.display = f.export_w ? '' : 'none';
    const btnExpP = $('prov-btn-export');
    if (btnExpP) btnExpP.style.display = f.export_w ? '' : 'none';
    // Filtrar las sub-pestañas /bancos según matriz del backend
    // (lib/roles.js SUB_TABS_BANCOS). Por ejemplo gerente y administrativo
    // sólo ven Resumen + Proveedores; pierden Movimientos / Análisis gastos /
    // Cruce TPV vs Banco.
    // Pestaña inicial visible para este rol. Si Resumen no está
    // permitida (gerente/administrativo), abrimos la primera visible.
    // No la activamos todavía — requiere state.periodos (cargado más
    // abajo) para que initProvFiltros pueda armar los selectores.
    if (Array.isArray(state.subTabsBancos)) {
      document.querySelectorAll('.tab[data-tab]').forEach((el) => {
        el.style.display = state.subTabsBancos.includes(el.dataset.tab) ? '' : 'none';
      });
      const active = document.querySelector('.tab.on[data-tab]');
      if (active && active.style.display === 'none') {
        initialTab = [...document.querySelectorAll('.tab[data-tab]')]
          .find((el) => el.style.display !== 'none');
      }
    }
  } catch {}
  const meta = await api('/api/v1/bancos/meta');
  state.sociedades = meta.sociedades || [];
  state.direcciones = meta.direcciones || {};
  buildSelectors();
  const per = await api('/api/v1/bancos/periodos');
  state.periodos = per.periodos || [];
  buildPeriodSelector();
  initCharts();
  await reload();
  // Activar pestaña inicial (gerente/administrativo arrancan en
  // Proveedores). Esto debe ir DESPUÉS de cargar state.periodos,
  // sino initProvFiltros encuentra los selectores vacíos.
  if (initialTab) showTab(initialTab.dataset.tab, initialTab);
}

function buildSelectors() {
  // Filtro principal sociedad. `up-ext-soc` se eliminó en Phase 12
  // (el upload pasó a auto-detección + multi-file dropzone) — el
  // .filter(Boolean) cubre eso y cualquier otro select opcional
  // que dejemos de renderizar a futuro sin tener que tocar este lugar.
  const fSoc = $('f-sociedad');
  const sels = [fSoc, $('up-ext-soc')].filter(Boolean);
  sels.forEach((sel) => {
    sel.innerHTML = '';
    if (sel === fSoc) {
      const all = document.createElement('option');
      all.value = ''; all.textContent = '(todas las sociedades)';
      sel.appendChild(all);
    }
    for (const s of state.sociedades) {
      const opt = document.createElement('option');
      opt.value = s.id; opt.textContent = `${s.nombre} (${s.cif})`;
      sel.appendChild(opt);
    }
  });

  // Filtro local
  const allLocs = state.sociedades.flatMap((s) => s.locales);
  [$('m-local'), $('up-tpv-local')].filter(Boolean).forEach((sel) => {
    [...sel.querySelectorAll('option:not([value=""])')].forEach((o) => o.remove());
    for (const l of allLocs) {
      const opt = document.createElement('option');
      opt.value = l; opt.textContent = l;
      sel.appendChild(opt);
    }
  });

  // Categorías (taxonomía v2)
  const cats = [
    'INGRESO_GLOVO','INGRESO_JUST_EAT','INGRESO_BIZUM','INGRESO_STRIPE','INGRESO_TRANSFERENCIA','INGRESO_OTROS',
    'IMPUESTOS','SS_LABORAL','NOMINAS','ALQUILER',
    'SUMINISTROS_LUZ','SUMINISTROS_GAS','SUMINISTROS_AGUA','TELECOMUNICACIONES',
    'PROVEEDOR_CARNES','PROVEEDOR_PANADERIA','PROVEEDOR_FRITAS','PROVEEDOR_LACTEOS',
    'PROVEEDOR_ACEITES','PROVEEDOR_BEBIDAS','PROVEEDOR_MAKRO','PROVEEDOR_LIMPIEZA',
    'PROVEEDOR_PACKAGING','PROVEEDOR_OTROS',
    'MANTENIMIENTO','SEGUROS','FINANCIERO','INTRAGRUPO','OTROS',
  ];
  const sel = $('m-cat');
  for (const c of cats) {
    const opt = document.createElement('option');
    opt.value = c; opt.textContent = c;
    sel.appendChild(opt);
  }
}

// Suelo de período aplicado en frontend para no-admin. Espejo del backend
// PERIODO_FLOOR_NO_ADMIN — ambos deben coincidir o el dropdown ofrecerá
// meses que el backend va a rechazar. Si llega a divergir, cambiar acá
// (frontend) y en routes/bancos.js (backend) juntos.
const PERIODO_FLOOR_NO_ADMIN = '2026-01';
function periodosPermitidosParaRol() {
  if (rolEsAdmin()) return state.periodos;
  return state.periodos.filter((p) => p >= PERIODO_FLOOR_NO_ADMIN);
}

function buildPeriodSelector() {
  // Popula los TRES selectores globales con la lista de períodos:
  //   f-periodo (modo Mes único) → único select con default "más reciente"
  //   f-desde / f-hasta (modo Rango) → lista ascendente / descendente
  // Para no-admin (gerente / administrativo) sólo se ofrecen meses
  // >= PERIODO_FLOOR_NO_ADMIN — los meses anteriores no aparecen en
  // ningún dropdown.
  const periodos = periodosPermitidosParaRol();
  if (!periodos.length) {
    for (const id of ['f-periodo', 'f-desde', 'f-hasta']) {
      const sel = $(id);
      if (sel) { sel.innerHTML = ''; const opt = document.createElement('option'); opt.value=''; opt.textContent='(sin datos)'; sel.appendChild(opt); }
    }
    return;
  }
  const ultimo = periodos[periodos.length - 1];
  // f-periodo (Mes único): no incluye opción "(todos)" porque el modo es
  // de un mes; quien quiera rango usa el otro modo.
  const selU = $('f-periodo');
  if (selU) {
    selU.innerHTML = '';
    for (const p of [...periodos].reverse()) {
      const opt = document.createElement('option');
      opt.value = p; opt.textContent = PERIOD_LABELS(p);
      selU.appendChild(opt);
    }
    selU.value = ultimo;
  }
  // f-desde / f-hasta (Rango): orden descendente para consistencia con
  // el modo único.
  for (const id of ['f-desde', 'f-hasta']) {
    const sel = $(id);
    if (!sel) continue;
    sel.innerHTML = '';
    for (const p of [...periodos].reverse()) {
      const opt = document.createElement('option');
      opt.value = p; opt.textContent = PERIOD_LABELS(p);
      sel.appendChild(opt);
    }
  }
  // Default rango = último mes (Desde = Hasta = último mes).
  $('f-desde').value = ultimo;
  $('f-hasta').value = ultimo;
  // Estado inicial del modo si no se setea antes.
  if (!state.filtroPeriodo) state.filtroPeriodo = { modo: 'unico' };
  // Listener del modo único — debounce 300ms para autocarga.
  if (selU && !selU._listenerOk) {
    let _t;
    selU.addEventListener('change', () => {
      clearTimeout(_t);
      _t = setTimeout(() => reload(), 300);
    });
    selU._listenerOk = true;
  }
}

// Toggle entre modo "Mes único" y "Rango". El modo se guarda en
// state.filtroPeriodo.modo y persiste durante la sesión.
function setFiltroModo(modo) {
  if (modo !== 'unico' && modo !== 'rango') return;
  state.filtroPeriodo = state.filtroPeriodo || {};
  state.filtroPeriodo.modo = modo;
  const elU = $('filtro-modo-unico');
  const elR = $('filtro-modo-rango');
  if (elU) elU.style.display = modo === 'unico' ? 'flex' : 'none';
  if (elR) elR.style.display = modo === 'rango' ? 'flex' : 'none';
  if (modo === 'unico') {
    // Al volver a único, recargar inmediato con el mes actual del dropdown.
    reload();
  }
  // Si se cambió a 'rango' no recargamos: esperamos al Aplicar.
}

// Fuente única de verdad del período activo. Devuelve la shape que los
// endpoints esperan en query params:
//   modo único → { periodo, desde:null, hasta:null }
//   modo rango → { periodo:null, desde, hasta }
function getPeriodoActivo() {
  const modo = state.filtroPeriodo?.modo || 'unico';
  if (modo === 'rango') {
    const desde = $('f-desde')?.value || null;
    const hasta = $('f-hasta')?.value || null;
    return { modo, periodo: null, desde, hasta };
  }
  return { modo, periodo: $('f-periodo')?.value || null, desde: null, hasta: null };
}

// Label corto del período activo para el resumen "Período: Mayo 2026"
// que aparece en el header de Proveedores.
function labelPeriodoActivo() {
  const p = getPeriodoActivo();
  if (p.modo === 'rango') {
    if (!p.desde && !p.hasta) return '—';
    if (p.desde === p.hasta) return PERIOD_LABELS(p.desde);
    return `${PERIOD_LABELS(p.desde)} – ${PERIOD_LABELS(p.hasta)}`;
  }
  return p.periodo ? PERIOD_LABELS(p.periodo) : '(todos)';
}

async function reload() {
  state.current_sociedad = $('f-sociedad').value || null;
  const p = getPeriodoActivo();
  // Compat con código existente: el modo único expone `current_periodo`
  // como string YYYY-MM (o null = todos). El modo rango lo expone como
  // null y los handlers usan getPeriodoActivo() directamente.
  state.current_periodo = p.modo === 'unico' ? p.periodo : null;
  state.current_desde   = p.modo === 'rango' ? p.desde   : null;
  state.current_hasta   = p.modo === 'rango' ? p.hasta   : null;
  // Refrescar el label en el header de Proveedores (si está visible).
  const lblProv = $('prov-periodo-resumen');
  if (lblProv) lblProv.querySelector('strong').textContent = labelPeriodoActivo();
  await Promise.all([loadResumen(), loadCruces(), loadProveedores(), loadMovs()]);
  // Tabs que se cargan on-demand: si ya estaban abiertas, refrescarlas
  // con el nuevo período. Todas leen `getPeriodoActivo()` internamente.
  if (state.prov?.loaded)  loadProvRanking();
  if (state.caja?.loaded)  loadCaja();
  if (state.flujo?.loaded) loadFlujoAnual();
}

async function loadResumen() {
  const q = state.current_sociedad ? `?sociedad_id=${state.current_sociedad}` : '';
  const j = await api('/api/v1/bancos/resumen' + q);
  state.resumen = j.resumen || [];

  // KPIs del período
  const periodo = state.current_periodo;
  const subset = state.current_sociedad
    ? state.resumen.filter((r) => r.sociedad_id === state.current_sociedad)
    : state.resumen;
  const period = periodo ? subset.filter((r) => r.periodo === periodo) : subset;
  const ing = period.reduce((s, r) => s + (+r.total_ingresos || 0), 0);
  const gas = period.reduce((s, r) => s + (+r.total_gastos || 0), 0);
  const neto = ing + gas;
  $('r-ing').textContent = eur(ing);
  $('r-gas').textContent = eur(gas);
  $('r-neto').textContent = eur(neto); $('r-neto').style.color = clrG(neto);

  // Acumulado año
  if (periodo) {
    const year = periodo.slice(0, 4);
    const yearRows = subset.filter((r) => r.periodo.startsWith(year));
    const netoYear = yearRows.reduce((s, r) => s + (+r.neto || 0), 0);
    $('r-ac').textContent = eur(netoYear);
    $('r-ac').style.color = clrG(netoYear);
  } else {
    $('r-ac').textContent = '—';
  }

  // Chart mensual: agrupar por periodo
  const groupByMonth = {};
  subset.forEach((r) => {
    if (!groupByMonth[r.periodo]) groupByMonth[r.periodo] = { ing: 0, gas: 0 };
    groupByMonth[r.periodo].ing += +r.total_ingresos || 0;
    groupByMonth[r.periodo].gas += +r.total_gastos || 0;
  });
  const sortedPeriods = Object.keys(groupByMonth).sort().slice(-12);
  chMensual.data.labels = sortedPeriods.map(PERIOD_LABELS);
  chMensual.data.datasets[0].data = sortedPeriods.map((p) => groupByMonth[p].ing);
  chMensual.data.datasets[1].data = sortedPeriods.map((p) => Math.abs(groupByMonth[p].gas));
  chMensual.update();

  // Comparativa
  const periodForRow = periodo;
  const compRows = state.sociedades.map((s) => {
    const rows = state.resumen.filter((r) => r.sociedad_id === s.id && (!periodForRow || r.periodo === periodForRow));
    const ing = rows.reduce((s2, r) => s2 + (+r.total_ingresos || 0), 0);
    const gas = rows.reduce((s2, r) => s2 + (+r.total_gastos || 0), 0);
    const nMov = rows.reduce((s2, r) => s2 + (+r.n_movimientos || 0), 0);
    return { ...s, ing, gas, neto: ing + gas, n_movimientos: nMov };
  });
  $('tb-comp').innerHTML = compRows.map((r) => `<tr>
    <td style="font-weight:500">${r.nombre}</td>
    <td style="font-size:11px;color:var(--text-2)">${r.cif}</td>
    <td style="text-align:right;color:#16a34a">${eur(r.ing)}</td>
    <td style="text-align:right;color:#dc2626">${eur(r.gas)}</td>
    <td style="text-align:right;font-weight:500;color:${clrG(r.neto)}">${eur(r.neto)}</td>
    <td style="text-align:right">${r.n_movimientos}</td>
  </tr>`).join('');
}

async function loadCruces() {
  const params = new URLSearchParams();
  if (state.current_sociedad) params.set('sociedad_id', state.current_sociedad);
  if (state.current_periodo) params.set('periodo', state.current_periodo);
  const j = await api('/api/v1/bancos/cruces?' + params.toString());
  state.cruces = j.cruces || [];
  $('tb-cruce').innerHTML = state.cruces.map((c) => {
    const socName = state.sociedades.find((s) => s.id === c.sociedad_id)?.nombre || c.sociedad_id;
    const diffClr = Math.abs(c.diferencia) < 10 ? '#16a34a' : Math.abs(c.diferencia) <= 100 ? '#BA7517' : '#dc2626';
    return `<tr>
      <td style="font-size:11px">${socName}</td>
      <td>${c.local_id || '<em style="color:var(--text-2)">(total)</em>'}</td>
      <td>${PERIOD_LABELS(c.periodo)}</td>
      <td style="text-align:right">${eur(c.bruto)}</td>
      <td style="text-align:right;color:#dc2626">${eur(c.comision)}</td>
      <td style="text-align:right;font-weight:500">${eur(c.neto)}</td>
      <td style="text-align:right">${eur(c.banco)}</td>
      <td style="text-align:right;font-weight:500;color:${diffClr}">${eur2(c.diferencia)}</td>
      <td style="text-align:right;font-size:11px">${pct(c.tasa)}</td>
      <td><span class="pill-est pill-${c.estado}">${c.estado || '—'}</span></td>
    </tr>`;
  }).join('');
}

async function loadProveedores() {
  const params = new URLSearchParams();
  if (state.current_sociedad) params.set('sociedad_id', state.current_sociedad);
  if (state.current_periodo) params.set('periodo', state.current_periodo);
  const j = await api('/api/v1/bancos/gastos-por-proveedor?' + params.toString());
  state.proveedores = j.proveedores || [];

  // Donut: usa j.por_categoria que ya viene del pipeline canónico del backend
  // (loadReglas → matchRegla → normalizarProveedor) con nombre_display de
  // ab_categorias resuelto. Categorías sin movs en el período NO aparecen
  // (el backend sólo incluye las que tienen movimientos).
  const porCat = j.por_categoria || [];
  chGastos.data.labels = porCat.map((c) => c.nombre_display);
  chGastos.data.datasets[0].data = porCat.map((c) => c.total);
  chGastos.data.datasets[0].backgroundColor = porCat.map((_, i) => COLORS_CAT[i % COLORS_CAT.length]);
  chGastos.update();
  const totG = porCat.reduce((s, c) => s + c.total, 0);
  $('gastos-legend').innerHTML = porCat.map((c, i) => {
    const pctV = totG > 0 ? (c.total / totG * 100).toFixed(1) : '0';
    return `<div style="display:flex;align-items:center;gap:6px;padding:3px 0" title="${c.codigo} · ${c.n_movs} mvs">
      <span style="width:10px;height:10px;border-radius:2px;background:${COLORS_CAT[i % COLORS_CAT.length]};display:inline-block"></span>
      <span style="font-size:11px;flex:1">${c.nombre_display}</span>
      <span style="font-size:11px;font-weight:500">${eur(c.total)}</span>
      <span style="font-size:11px;color:var(--text-2);min-width:36px;text-align:right">${pctV}%</span>
    </div>`;
  }).join('');

  // Top 50 proveedores: la columna "Categoría" muestra el nombre_display
  // canónico (ej. "Seguridad Social") en vez del código interno (SS_LABORAL).
  // p.proveedor también viene del pipeline → TGSS aparece como "TGSS" canónico,
  // no como el concepto bancario crudo.
  $('tb-prov').innerHTML = state.proveedores.map((p) => {
    const total = Math.abs(+p.total);
    const promedio = total / Math.max(p.apariciones, 1);
    const catLabel = p.categoria_display || p.categoria || '—';
    return `<tr>
      <td style="font-weight:500;font-size:12px">${p.proveedor || '—'}</td>
      <td style="font-size:11px" title="${p.categoria || ''}">${catLabel}</td>
      <td style="text-align:right;color:#dc2626">${eur(total)}</td>
      <td style="text-align:right">${p.apariciones}</td>
      <td style="text-align:right;font-size:11px">${eur(promedio)}</td>
      <td style="font-size:11px;color:var(--text-2)">${p.desde || ''}</td>
      <td style="font-size:11px;color:var(--text-2)">${p.hasta || ''}</td>
    </tr>`;
  }).join('');
}

// ─── Proveedores (sub-tab dedicado) ───────────────────────────────────
function initProvFiltros() {
  const sSel = $('prov-sociedad');
  if (sSel.options.length <= 1) {
    for (const s of state.sociedades) {
      const o = document.createElement('option');
      o.value = s.id; o.textContent = `${s.nombre} (${SOCIEDAD_ABBR[s.id] || s.id})`;
      sSel.appendChild(o);
    }
  }
  // Suelo de fecha para roles no-admin/socio: solo ven datos desde
  // enero 2026 en adelante. Las opciones anteriores quedan ocultas
  // en ambos selectores (Desde y Hasta). El backend también clampea
  // (defense in depth) en /proveedores, /grupo-detalle y
  // /proveedor-evolucion.
  // Nota del suelo de fecha: visible sólo para rol 'admin' (no socio
  // ni el resto). Es un texto interno/diagnóstico que no aporta a la
  // experiencia de los demás roles.
  const note = $('prov-period-floor-note');
  if (note) note.style.display = state.user?.role === 'admin' ? '' : 'none';

  // Defaults aplicados sólo la PRIMERA vez que el usuario entra a la
  // pestaña. Después se respeta lo que el usuario haya elegido. El
  // período ya NO se setea acá — vive en el selector global (f-periodo
  // o f-desde/f-hasta). Acá sólo seteamos sociedad y umbral del donut.
  if (!state.prov.defaultsAplicados) {
    if (sSel) sSel.value = 'sin_elche';
    setDonutThreshold('all');
    state.prov.defaultsAplicados = true;
  }
  // Refrescar el label "Período: Mayo 2026" del header de Proveedores.
  const lblProv = $('prov-periodo-resumen');
  if (lblProv) lblProv.querySelector('strong').textContent = labelPeriodoActivo();
}

function rolEsAdmin() {
  return state.user && ['admin', 'socio'].includes(state.user.role);
}

function aplicarVistaSegunRol() {
  // Vista unificada para todos los roles: mismos slices, mismos totales,
  // mismos %. Diferencia: admin/socio puede expandir el slice fusionado
  // "Gastos Dirección" (drill-down), el resto ve 🔒.
  // Badge + texto de ayuda del selector: visibles SÓLO para rol 'admin'
  // (no socio ni el resto). Son textos internos/diagnóstico.
  const esAdminEstricto = state.user?.role === 'admin';
  const badge = $('prov-vista-badge');
  if (badge) {
    if (esAdminEstricto) {
      badge.textContent = 'Vista unificada · drill-down completo';
      badge.style.background = '#F3E8FF';
      badge.style.color = '#7E22CE';
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  }
  const help = $('prov-selector-help');
  if (help) help.style.display = esAdminEstricto ? '' : 'none';
  // Botón ⚙ Gastos Dirección sólo visible para admin/socio.
  const btnGd = $('prov-btn-gd-manage');
  if (btnGd) btnGd.style.display = rolEsAdmin() ? '' : 'none';
  // Botón ⚙️ Gestionar reglas (drag & drop) sólo admin/socio.
  const btnRp = $('prov-btn-reglas');
  if (btnRp) btnRp.style.display = rolEsAdmin() ? '' : 'none';
  // Botón "+ Proveedor" (alta manual) sólo admin/socio.
  // El spec original pedía rolEsAdmin() || rolEsSocio() pero esta
  // segunda función no existe — rolEsAdmin() ya cubre {admin, socio}.
  const btnAddProv = $('prov-btn-add-prov');
  if (btnAddProv) btnAddProv.style.display = rolEsAdmin() ? '' : 'none';
}

async function loadProvRanking() {
  const params = new URLSearchParams();
  const soc = $('prov-sociedad').value;
  if (soc) params.set('sociedad_id', soc);
  // Período viene del selector GLOBAL (modo único o rango).
  const p = getPeriodoActivo();
  if (p.modo === 'rango') {
    if (p.desde && p.hasta && p.desde === p.hasta) params.set('periodo', p.desde);
    else {
      if (p.desde) params.set('periodo_desde', p.desde);
      if (p.hasta) params.set('periodo_hasta', p.hasta);
    }
  } else if (p.periodo) {
    params.set('periodo', p.periodo);
  }
  // Refrescar el label visible del header de Proveedores cada vez.
  const lblProv = $('prov-periodo-resumen');
  if (lblProv) lblProv.querySelector('strong').textContent = labelPeriodoActivo();
  // El backend filtra por rol; el front no envía vista (la deja en backend).
  const j = await api('/api/v1/bancos/proveedores?' + params.toString());
  // BUG fix — `state.prov = {...}` perdía propiedades del estado original
  // (sort, donutThreshold, donutDrillOpen, donutDrillRows) y rompía a
  // renderProvTabla con "Cannot destructure 'col' of state.prov.sort as it
  // is undefined" al re-render tras una reclasificación. Object.assign
  // preserva esas claves.
  Object.assign(state.prov, {
    rows: j.proveedores || [],
    total: j.total_gasto || 0,
    // total_ingresos puede ser null cuando el rol no tiene permiso para
    // verlo (backend devuelve null para no-admin). renderProvKpis usa el
    // null como señal para ocultar las cards "Total ingresos" y "Resultado
    // neto".
    total_ingresos: (j.total_ingresos == null) ? null : (+j.total_ingresos || 0),
    intra: j.total_excluido_intra_grupo || 0,
    n_intra: j.n_excluido_intra_grupo || 0,
    loaded: true,
    vista: j.vista_efectiva || (rolEsAdmin() ? 'admin' : 'operativo'),
    // Backend devuelve { proveedor, miembros } cuando el rol no es
    // admin/socio y hay categorías sensibles fusionadas en un único
    // slice. Lo usamos en renderProvDonut para desactivar el click.
    fusion_direccion: j.fusion_direccion || null,
    // 32 categorías para el donut nuevo (con nombre_display de
    // ab_categorias y fusión Gastos Dirección como slice virtual
    // '__GASTOS_DIRECCION_FUSE__'). El donut consume esto en lugar
    // de state.prov.rows. La tabla de proveedores sigue usando rows.
    por_categoria: j.por_categoria || [],
    fusion_categoria: j.fusion_categoria || null,
    // Filtros activos + período anterior contra el que se compara
    // (usados por renderProvDonut para etiquetar el tooltip de variación).
    filtros: j.filtros || null,
    comparativaPrev: j.comparativa_anterior || null,
  });
  // Defensa adicional: si por cualquier ruta el sort se hubiera perdido,
  // re-inicializarlo a su default.
  if (!state.prov.sort) state.prov.sort = { col: 'total_importe', dir: -1 };
  // Reset de la selección acumulada al cambiar filtros del backend
  // (sociedad, período): los % cambian, así que cualquier selección
  // previa pasaría a representar % distintos sin que el usuario lo
  // note. Más limpio resetear y empezar de cero.
  if (!state.prov.selected) state.prov.selected = new Set();
  state.prov.selected.clear();
  aplicarVistaSegunRol();
  renderProvKpis();
  renderProvDonut();
  renderProvTabla();
  renderProvSelBar();
}

// Exposición pública del nombre que usa el HTML.
function loadProveedoresTab() { return loadProvRanking(); }

function renderProvKpis() {
  $('prov-kpi-total').textContent = eur2(state.prov.total);
  $('prov-kpi-n').textContent = state.prov.rows.length;
  $('prov-kpi-intra').textContent = state.prov.n_intra > 0
    ? `${eur2(state.prov.intra)} en ${state.prov.n_intra} tx`
    : 'ninguna en este filtro';

  // Cards admin/socio: Total ingresos + Resultado neto. Visibilidad
  // condicionada por `state.prov.total_ingresos != null` (el backend
  // devuelve null para roles sin permiso → cards ocultas). El neto
  // toma color verde si positivo, rojo si negativo.
  const cardIng = $('prov-kpi-ingresos-card');
  const cardNeto = $('prov-kpi-neto-card');
  if (state.prov.total_ingresos == null) {
    cardIng.style.display = 'none';
    cardNeto.style.display = 'none';
  } else {
    cardIng.style.display = '';
    cardNeto.style.display = '';
    $('prov-kpi-ingresos').textContent = eur2(state.prov.total_ingresos);
    const neto = state.prov.total_ingresos - state.prov.total;
    const elNeto = $('prov-kpi-neto');
    elNeto.textContent = (neto >= 0 ? '+' : '') + eur2(neto);
    elNeto.style.color = neto >= 0 ? '#16a34a' : '#dc2626';
  }
}

function fmtThresholdPct(t) {
  if (t == null) return '';
  return (t * 100).toFixed(t < 0.01 ? 1 : 0).replace('.', ',');
}

function partitionByThreshold(items, threshold) {
  // porcentaje viene del backend como fracción 0..1.
  const above = items.filter((r) => (r.porcentaje || 0) > threshold);
  const below = items.filter((r) => (r.porcentaje || 0) <= threshold);
  return { above, below };
}

// Donut ahora muestra las 32 CATEGORÍAS (state.prov.por_categoria) como
// slices, en lugar de los 97 proveedores. Sincronizado con Gestionar
// Reglas: cada slice es una categoría de ab_categorias con nombre_display
// resuelto. La fusión "Gastos Dirección" colapsa las 4 cats sensibles
// (GASTOS_DIRECCION, NOMINAS_DIRECCION, PRESTAMOS, FINANCIERO) en un
// único slice virtual con codigo '__GASTOS_DIRECCION_FUSE__'.
//
// Click en un slice → openCategoriaSidebar(codigo) → sidebar con los
// proveedores de esa categoría → click en un proveedor → openProvSidebar
// (sidebar actual con conceptos + reclasificación).
function renderProvDonut() {
  if (!chProvDonut) return;
  // Adaptamos por_categoria a una shape uniforme {label, key, value, count,
  // porcentaje, n_proveedores, es_fusion, puede_drilldown}. label = codigo
  // para que el donut muestre exactamente los mismos nombres que aparecen
  // en las drop-zones de Gestionar Reglas (IMPUESTOS, SS_LABORAL, NOMINAS,
  // etc). El nombre_display se preserva como tooltip / hover.
  // Caso especial: la fusión "Gastos Dirección" (para no-admin) usa el
  // nombre_display como label (porque su codigo '__GASTOS_DIRECCION_FUSE__'
  // es artificial y no se ve nunca en Reglas).
  const cats = state.prov.por_categoria || [];
  const items = cats.map((c) => ({
    label: c.es_fusion ? c.nombre_display : c.codigo,
    label_full: c.nombre_display, // tooltip extendido
    key: c.codigo,
    value: c.total,
    count: c.n_movs,
    porcentaje: c.porcentaje,
    n_proveedores: c.n_proveedores,
    es_fusion: !!c.es_fusion,
    puede_drilldown: c.puede_drilldown !== false, // default permitido
    // Comparativa contra período anterior (mismo tamaño que el filtro).
    // tiene_anterior=false desactiva la flecha/variación en la leyenda y
    // muestra "—" en su lugar.
    tiene_anterior: !!c.tiene_anterior,
    importe_anterior: +c.importe_anterior || 0,
    pct_anterior: +c.pct_anterior || 0,
    var_importe: +c.var_importe || 0,
    var_pp: +c.var_pp || 0,
  }));

  const threshold = state.prov.donutThreshold;
  const drillOpen = !!state.prov.donutDrillOpen;
  let view = [];
  let modeLbl = '';

  if (drillOpen && state.prov.donutDrillRows) {
    view = state.prov.donutDrillRows;
    modeLbl = `(drill: ${view.length} categorías agrupadas como "Otros")`;
  } else if (threshold == null) {
    view = items;
    modeLbl = `(${items.length} categorías, completo)`;
  } else {
    const { above, below } = partitionByThreshold(items, threshold);
    view = above.slice();
    if (below.length > 0) {
      const totalBelow = below.reduce((s, c) => s + c.value, 0);
      const countBelow = below.reduce((s, c) => s + c.count, 0);
      view.push({
        label: `Otros (${below.length})`, key: '__OTROS__',
        value: totalBelow, count: countBelow,
        isOtros: true,
      });
    }
    modeLbl = `(> ${fmtThresholdPct(threshold)}% · ${above.length} + Otros)`;
  }

  const labels = view.map((v) => v.label);
  const values = view.map((v) => v.value);
  const counts = view.map((v) => v.count);

  const colors = labels.map((_, i) => COLORS_CAT[i % COLORS_CAT.length]);
  // Selección acumulada: ahora opera por código de categoría (la barra
  // superior se setea cuando el usuario marca filas en la tabla de
  // proveedores; el highlight del donut por categoría es opcional —
  // por ahora no matcheamos cross-key, dejamos el donut "neutro").
  const sel = state.prov.selected || new Set();
  const ACCENT = '#A78BFA';
  const borderColors = view.map((v) => sel.has(v.key) ? ACCENT : 'rgba(0,0,0,0)');
  const borderWidths = view.map((v) => sel.has(v.key) ? 4 : 2);
  const bg = sel.size === 0
    ? colors
    : colors.map((c, i) => sel.has(view[i].key) ? c : _hexFade(c, 0.35));
  chProvDonut.data.labels = labels;
  chProvDonut.data.datasets[0].data = values;
  chProvDonut.data.datasets[0].backgroundColor = bg;
  chProvDonut.data.datasets[0].borderColor = borderColors;
  chProvDonut.data.datasets[0].borderWidth = borderWidths;
  chProvDonut._ntx = counts;
  chProvDonut.update();

  $('prov-donut-mode').textContent = modeLbl;
  $('btn-donut-back').style.display = drillOpen ? '' : 'none';
  $('prov-donut-hint').textContent = drillOpen
    ? `Drill-down activo: estas son las ${state.prov.donutDrillRows?.length || 0} categorías debajo del umbral.`
    : (threshold == null
        ? 'Mostrando todas las categorías como slices. Click → lista de proveedores de la categoría.'
        : 'Categorías por debajo del umbral se agrupan en "Otros (N)". Click ahí para drill-down.');

  const tot = state.prov.total;
  // Categorías sensibles (intra-grupo / dirección). Sólo admin/socio pueden
  // ver los proveedores detrás del slice. Los demás roles ven el slice con
  // su monto correcto pero el click está bloqueado y aparece 🔒.
  // El flag autoritativo es `v.puede_drilldown` (lo decide el backend según
  // rol). CATS_SENSIBLES_DONUT acá sólo sirve para decidir cuándo dibujar 🔓
  // (admin viendo una cat sensible — confirma acceso pleno).
  // FINANCIERO se sacó del set (rev. 2026-06-03 bis) — son comisiones
  // operativas, no info sensible.
  const CATS_SENSIBLES_DONUT = new Set(['GASTOS_DIRECCION', 'NOMINAS_DIRECCION', 'PRESTAMOS']);

  // Labels del donut en MAYÚSCULAS para consistencia visual independientemente
  // de cómo se haya guardado el nombre_display en ab_categorias.
  const labelUpper = (s) => (s || '').toUpperCase();

  // Actualizar también las labels del dataset de Chart.js para que el tooltip
  // del slice (hover) muestre el nombre en mayúsculas, consistente con la leyenda.
  chProvDonut.data.labels = labels.map(labelUpper);
  chProvDonut.update('none');

  // Etiqueta legible del período (actual y anterior) para el tooltip de la
  // comparativa: "Mayo 2026" si es un mes único, "Marzo–Mayo 2026" si es
  // un rango. Usa state.prov.filtros (current) y state.prov.comparativaPrev.
  const MESES_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  function _labelPeriodo(p) {
    if (!p) return '';
    if (p.periodo) {
      const [y, m] = p.periodo.split('-').map(Number);
      return `${MESES_ES[m-1]} ${y}`;
    }
    if (p.periodo_desde && p.periodo_hasta) {
      const [yd, md] = p.periodo_desde.split('-').map(Number);
      const [yh, mh] = p.periodo_hasta.split('-').map(Number);
      if (p.periodo_desde === p.periodo_hasta) return `${MESES_ES[md-1]} ${yd}`;
      return yd === yh
        ? `${MESES_ES[md-1]}–${MESES_ES[mh-1]} ${yh}`
        : `${MESES_ES[md-1]} ${yd}–${MESES_ES[mh-1]} ${yh}`;
    }
    return '';
  }
  const labelActual = _labelPeriodo(state.prov.filtros);
  const labelPrev = _labelPeriodo(state.prov.comparativaPrev);

  // Indicador de variación: flecha + color según el cambio de participación
  // (pp). Umbral neutral 0,5pp. Verde = subió (gasto creció), rojo = bajó,
  // gris = sin cambio relevante.
  function _flecha(varPp, varImporte) {
    if (Math.abs(varPp) < 0.5) return { ch: '→', color: '#6B7280' };
    if (varImporte > 0)        return { ch: '↑', color: '#16a34a' };
    return { ch: '↓', color: '#dc2626' };
  }
  const _fmtEurSigned = (n) => (n >= 0 ? '+' : '') + eur(Math.abs(n)) * (n < 0 ? -1 : 1); // Math hack: eur() devuelve string
  function _fmtVarImporte(n) {
    const sign = n >= 0 ? '+' : '−';
    return sign + eur(Math.abs(n));
  }
  function _fmtVarPp(n) {
    const sign = n >= 0 ? '+' : '−';
    return sign + Math.abs(n).toFixed(1) + 'pp';
  }

  $('prov-legend').innerHTML = view.map((v, i) => {
    const pctV = tot > 0 ? (v.value / tot * 100).toFixed(1) : '0';
    const isOtros = !!v.isOtros;
    const esSensible = CATS_SENSIBLES_DONUT.has(v.key);
    const drillBloqueado = esSensible && v.puede_drilldown === false;
    const keyEsc = (v.key || '').replace(/'/g, "\\'");
    const onClick = drillBloqueado
      ? ''
      : (isOtros ? `enterDonutDrill()` : `openCategoriaSidebar('${keyEsc}')`);
    const cursor = drillBloqueado ? 'not-allowed' : 'pointer';
    const hover = drillBloqueado ? '' : ' onmouseover="this.style.background=\'var(--bg-secondary)\'" onmouseout="this.style.background=\'transparent\'"';
    // Candado: 🔒 cuando el rol no puede drillear una cat sensible (Luciano
    // viendo GASTOS_DIRECCION), 🔓 cuando sí puede (admin/socio).
    let lockIcon = '';
    if (drillBloqueado) lockIcon = ' 🔒';
    else if (esSensible) lockIcon = ' 🔓';
    const sufijo = isOtros ? ' →' : lockIcon;
    const labelDisplay = labelUpper(v.label);
    const displayDiff = v.label_full && v.label_full.toUpperCase() !== labelDisplay;

    // Comparativa contra período anterior. Si la cat es "Otros" (bucket
    // virtual del threshold) no mostramos comparativa porque sus miembros
    // varían según el threshold. Si v.tiene_anterior=false → muestra "—".
    let varHtmlImporte = '<span style="color:var(--text-2);font-size:10px">—</span>';
    let varHtmlPp = '<span style="color:var(--text-2);font-size:10px">—</span>';
    let tooltipVar = '';
    if (!isOtros && v.tiene_anterior) {
      const fl = _flecha(v.var_pp, v.var_importe);
      varHtmlImporte = `<span style="color:${fl.color};font-size:10px;font-weight:500">${fl.ch}${_fmtVarImporte(v.var_importe)}</span>`;
      varHtmlPp = `<span style="color:${fl.color};font-size:10px">${fl.ch}${_fmtVarPp(v.var_pp)}</span>`;
      const pctActualS = (v.porcentaje * 100).toFixed(1);
      const pctAntS = (v.pct_anterior * 100).toFixed(1);
      tooltipVar = `\n${labelActual}: ${eur(v.value)}  (${pctActualS}%)\n${labelPrev}: ${eur(v.importe_anterior)}  (${pctAntS}%)\nVariación: ${_fmtVarImporte(v.var_importe)} (${_fmtVarPp(v.var_pp)}) ${fl.ch}`;
    } else if (!isOtros && labelPrev) {
      tooltipVar = `\n${labelActual}: ${eur(v.value)}  (${(v.porcentaje*100).toFixed(1)}%)\n${labelPrev}: sin datos`;
    }

    const tooltipParts = [];
    if (displayDiff) tooltipParts.push(v.label_full);
    if (!isOtros) tooltipParts.push(`${v.n_proveedores || 0} prov · ${v.count} mvs`);
    if (drillBloqueado) tooltipParts.push('sin acceso al detalle por proveedor');
    const tooltipText = tooltipParts.join(' · ');
    const tooltipFull = `${labelDisplay}${tooltipText ? ' — ' + tooltipText : ''}${tooltipVar}`;

    return `<div onclick="${onClick}" style="display:flex;align-items:center;gap:6px;padding:3px 6px;cursor:${cursor};border-radius:6px"${hover} title="${tooltipFull.replace(/"/g,'&quot;')}">
      <span style="width:10px;height:10px;border-radius:2px;background:${colors[i]};flex-shrink:0;display:inline-block"></span>
      <span style="font-size:11px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${labelDisplay}${sufijo}</span>
      <span style="font-size:11px;font-weight:500;min-width:70px;text-align:right">${eur(v.value)}</span>
      <span style="min-width:80px;text-align:right">${varHtmlImporte}</span>
      <span style="font-size:11px;color:var(--text-2);min-width:50px;text-align:right">${pctV}%</span>
      <span style="min-width:65px;text-align:right">${varHtmlPp}</span>
    </div>`;
  }).join('');
}

function setDonutThreshold(val) {
  const t = (val === 'all' || val === '' || val == null) ? null : parseFloat(val);
  state.prov.donutThreshold = (Number.isFinite(t) && t > 0) ? t : null;
  state.prov.donutDrillOpen = false;
  state.prov.donutDrillRows = null;
  // Sincronizar el <select> (cuando se llama desde código sin pasar por el onchange)
  const sel = $('prov-donut-threshold');
  if (sel) sel.value = state.prov.donutThreshold == null ? 'all' : String(state.prov.donutThreshold);
  renderProvDonut();
}

function enterDonutDrill() {
  const threshold = state.prov.donutThreshold;
  if (threshold == null) return;  // en "Ver todos" no hay Otros
  // Filtramos categorías debajo del umbral (no proveedores). Misma shape
  // que renderProvDonut: label = codigo (consistente con Gestionar Reglas).
  const cats = state.prov.por_categoria || [];
  const items = cats.map((c) => ({
    label: c.es_fusion ? c.nombre_display : c.codigo,
    label_full: c.nombre_display,
    key: c.codigo,
    value: c.total, count: c.n_movs,
    porcentaje: c.porcentaje,
    n_proveedores: c.n_proveedores,
    es_fusion: !!c.es_fusion,
    puede_drilldown: c.puede_drilldown !== false,
  }));
  const { below } = partitionByThreshold(items, threshold);
  if (!below.length) return;
  state.prov.donutDrillOpen = true;
  state.prov.donutDrillRows = below;
  renderProvDonut();
}

function exitDonutDrill() {
  state.prov.donutDrillOpen = false;
  state.prov.donutDrillRows = null;
  renderProvDonut();
}

function refreshProvCatSelect() {
  // Poblar el selector de categorías con las únicas presentes en las filas.
  const sel = $('prov-tabla-cat');
  if (!sel) return;
  const cats = [...new Set(state.prov.rows.map((r) => r.categoria).filter(Boolean))].sort();
  const cur = sel.value;
  sel.innerHTML = '<option value="">— Todas las categorías —</option>'
    + cats.map((c) => `<option value="${c}" ${c === cur ? 'selected' : ''}>${c}</option>`).join('');
}

function sortProvTabla(col) {
  const s = state.prov.sort;
  if (s.col === col) s.dir = -s.dir;
  else {
    s.col = col;
    // Por defecto: texto asc, numérico desc.
    s.dir = (col === 'proveedor' || col === 'categoria') ? 1 : -1;
  }
  renderProvTabla();
}

function applyProvFiltros(rows) {
  const q = ($('prov-tabla-q')?.value || '').trim().toLowerCase();
  const cat = $('prov-tabla-cat')?.value || '';
  let out = rows;
  if (q)   out = out.filter((r) => (r.proveedor || '').toLowerCase().includes(q));
  if (cat) out = out.filter((r) => r.categoria === cat);
  return out;
}

function renderProvTabla() {
  refreshProvCatSelect();
  // Vista unificada (backend devuelve 'unificado'): la columna de
  // pedidos del usuario ahora se muestra siempre — los datos vienen
  // anexados para todos los proveedores con pedidos cargados.
  const operativo = true;
  const allRows = state.prov.rows;
  let rows = applyProvFiltros(allRows);

  // Sort
  const { col, dir } = state.prov.sort;
  rows = [...rows].sort((a, b) => {
    const av = a[col], bv = b[col];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'string') return dir * av.localeCompare(bv);
    return dir * (av < bv ? 1 : av > bv ? -1 : 0) * -1;
  });

  // Indicadores ↑↓ en headers
  ['proveedor','categoria','total_importe','porcentaje','num_transacciones'].forEach((c) => {
    const el = document.getElementById('srt-prov-' + c);
    if (el) el.textContent = c === col ? (dir === -1 ? ' ↓' : ' ↑') : ' ⇕';
  });

  // Contador / botón reset
  const counter = $('prov-tabla-counter');
  if (counter) {
    counter.textContent = rows.length === allRows.length
      ? `· ${rows.length} proveedores`
      : `· ${rows.length} de ${allRows.length} proveedores (filtrado)`;
  }
  const hasFilter = (rows.length !== allRows.length);
  const btn = $('btn-prov-reset'); if (btn) btn.style.display = hasFilter ? '' : 'none';

  // Header extra para vista operativa
  const thExtra = $('th-prov-extra');
  if (thExtra) {
    thExtra.textContent = operativo ? 'Nº pedidos / Último' : '';
    thExtra.style.display = operativo ? '' : 'none';
  }

  const sel = state.prov.selected || new Set();
  $('tb-proveedores').innerHTML = rows.map((p, i) => {
    const catTxt = p.categoria || '';
    const catChip = `<span class="cat-chip" onclick="filterByCategoria('${catTxt.replace(/'/g, "&#39;")}')" style="font-size:11px;color:var(--text-2);cursor:pointer;text-decoration:underline dotted" title="Filtrar por esta categoría">${(catTxt || '').replace('PROVEEDOR_', '')}</span>`;
    const provEsc = p.proveedor.replace(/"/g, '&quot;');
    const checked = sel.has(p.proveedor) ? ' checked' : '';
    const rowBg = sel.has(p.proveedor) ? ' style="background:rgba(124,58,237,.08)"' : '';
    const check = `<td style="text-align:center"><input type="checkbox" data-prov="${provEsc}"${checked} onchange="toggleProvSelection(this.dataset.prov, this.checked)" onclick="event.stopPropagation()" title="Sumar al contador acumulado" style="cursor:pointer"></td>`;
    const base = `${check}
      <td style="font-size:11px;color:var(--text-2)">${i + 1}</td>
      <td style="font-weight:500;font-size:12px">${p.proveedor}</td>
      <td>${catChip}</td>
      <td style="text-align:right;color:#dc2626">${eur2(p.total_importe)}</td>
      <td style="text-align:right">${(p.porcentaje * 100).toFixed(2)}%</td>
      <td style="text-align:right">${p.num_transacciones}</td>`;
    if (operativo) {
      const last = (p.ultimo_pedido || '').slice(0, 10);
      return `<tr${rowBg}>${base}
        <td style="text-align:right;font-size:11px;color:var(--text-2)">${p.num_pedidos || 0}${last ? ' · ' + last : ''}</td>
      </tr>`;
    }
    return `<tr${rowBg}>${base}<td></td></tr>`;
  }).join('');
}

// ─── Selección acumulada de % en la tabla ─────────────────────────────
// El usuario marca filas con la checkbox al inicio; el bar arriba del
// donut muestra suma de % + €. Los slices del donut con label match
// se resaltan con un borde brillante. Se resetea al cambiar filtros
// del backend (sociedad/periodo) — ver loadProvRanking.
function toggleProvSelection(proveedor, checked) {
  if (!proveedor) return;
  if (!state.prov.selected) state.prov.selected = new Set();
  if (checked) state.prov.selected.add(proveedor);
  else state.prov.selected.delete(proveedor);
  renderProvSelBar();
  renderProvDonut();
  // Toggle del background de la fila sin re-renderizar toda la tabla
  // (más fluido al hacer clicks rápidos).
  const tr = document.querySelector(`#tb-proveedores input[data-prov="${proveedor.replace(/"/g, '&quot;')}"]`)?.closest('tr');
  if (tr) tr.style.background = checked ? 'rgba(124,58,237,.08)' : '';
}

function clearProvSelection() {
  if (!state.prov.selected || !state.prov.selected.size) return;
  state.prov.selected.clear();
  renderProvSelBar();
  renderProvDonut();
  // Desmarcar todos los checkboxes + quitar background sin re-render.
  document.querySelectorAll('#tb-proveedores input[type=checkbox]').forEach((cb) => { cb.checked = false; });
  document.querySelectorAll('#tb-proveedores tr').forEach((tr) => { tr.style.background = ''; });
}

function renderProvSelBar() {
  const bar = $('prov-sel-bar');
  if (!bar) return;
  const sel = state.prov.selected || new Set();
  if (!sel.size) {
    bar.style.display = 'none';
    return;
  }
  // Sumamos % y € desde state.prov.rows (que ya respeta el filtro
  // del backend activo — sociedad/período).
  let sumaPct = 0, sumaEur = 0;
  for (const r of state.prov.rows) {
    if (sel.has(r.proveedor)) {
      sumaPct += (r.porcentaje || 0);
      sumaEur += (r.total_importe || 0);
    }
  }
  bar.style.display = 'flex';
  $('prov-sel-count').textContent = sel.size;
  $('prov-sel-plural').textContent = sel.size === 1 ? '' : 's';
  $('prov-sel-pct').textContent = (sumaPct * 100).toFixed(2).replace('.', ',') + '%';
  $('prov-sel-eur').textContent = eur2(sumaEur);
}

function filterByCategoria(cat) {
  if (!cat) return;
  $('prov-tabla-cat').value = cat;
  renderProvTabla();
  document.querySelector('#sect-proveedores .card:last-child')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function resetProvTablaFiltros() {
  if ($('prov-tabla-q'))   $('prov-tabla-q').value = '';
  if ($('prov-tabla-cat')) $('prov-tabla-cat').value = '';
  renderProvTabla();
}

function exportProveedoresCsv() {
  const rows = state.prov.rows;
  if (!rows.length) return;
  const header = ['#', 'Proveedor', 'Categoria', 'Total_EUR', 'Porcentaje', 'Num_transacciones'];
  const csvRows = [header.join(',')];
  rows.forEach((p, i) => {
    csvRows.push([
      i + 1,
      `"${(p.proveedor || '').replace(/"/g, '""')}"`,
      p.categoria || '',
      p.total_importe.toFixed(2),
      (p.porcentaje * 100).toFixed(2) + '%',
      p.num_transacciones,
    ].join(','));
  });
  const csv = '﻿' + csvRows.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const soc = $('prov-sociedad').value || 'todas';
  const p = getPeriodoActivo();
  let rango;
  if (p.modo === 'rango') {
    const d = p.desde || '', h = p.hasta || '';
    rango = d === h ? d : `${d}_a_${h}`;
  } else {
    rango = p.periodo || 'todos';
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `proveedores_${soc}_${rango}.csv`;
  a.click();
}

async function loadMovs() {
  const params = new URLSearchParams();
  if (state.current_sociedad) params.set('sociedad_id', state.current_sociedad);
  if (state.current_periodo) params.set('periodo', state.current_periodo);
  if ($('m-cat').value) params.set('categoria', $('m-cat').value);
  if ($('m-local').value) params.set('local_id', $('m-local').value);
  if ($('m-q').value) params.set('q', $('m-q').value);
  if ($('m-cod').value) params.set('banco', $('m-cod').value);
  params.set('limit', state.mov_limit);
  params.set('offset', state.mov_offset);
  const j = await api('/api/v1/bancos/movimientos?' + params.toString());
  state.movs = j;
  $('m-count').textContent = `${j.total.toLocaleString('es-ES')} movimientos · mostrando ${j.rows.length}`;
  const totalImp = +j.total_importe || 0;
  const totalEl = $('m-total');
  totalEl.textContent = `Total filtrado: ${eur2(totalImp)}`;
  totalEl.style.color = totalImp >= 0 ? '#16a34a' : '#dc2626';
  $('tb-mov').innerHTML = j.rows.map((m) => {
    const socAbbr = SOCIEDAD_ABBR[m.sociedad_id] || (m.sociedad_id || '').slice(0,3).toUpperCase();
    const socName = state.sociedades.find((s) => s.id === m.sociedad_id)?.nombre || m.sociedad_id || '';
    return `<tr>
      <td style="font-size:11px">${m.fecha}</td>
      <td style="font-size:12px">${m.concepto}</td>
      <td style="text-align:right;font-weight:500;color:${m.importe >= 0 ? '#16a34a' : '#dc2626'}">${eur2(m.importe)}</td>
      <td style="font-size:11px">${m.categoria || ''}</td>
      <td style="font-size:11px" title="${socName}">${socAbbr}</td>
      <td style="font-size:11px">${m.local_id || ''}</td>
      <td style="font-size:11px">${m.codigo_banco || ''}</td>
    </tr>`;
  }).join('');
  $('pg-info').textContent = `Página ${Math.floor(j.offset / j.limit) + 1} / ${Math.ceil(j.total / j.limit) || 1}`;
  $('pg-prev').disabled = j.offset === 0;
  $('pg-next').disabled = j.offset + j.rows.length >= j.total;
}

function changePage(dir) {
  state.mov_offset = Math.max(0, state.mov_offset + dir * state.mov_limit);
  loadMovs();
}

function exportCsv() {
  const rows = state.movs.rows;
  if (!rows.length) return;
  const header = ['fecha','concepto','importe','categoria','local_id','codigo_banco','periodo','sociedad_id','banco'];
  const csv = [header.join(',')].concat(rows.map((r) => header.map((k) => {
    let v = r[k]; if (v == null) v = '';
    v = String(v).replace(/"/g, '""');
    return /[",\n]/.test(v) ? `"${v}"` : v;
  }).join(','))).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `movimientos_${state.current_sociedad || 'todas'}_${state.current_periodo || 'all'}.csv`;
  a.click();
}

// ─── Charts ────────────────────────────────────────────────────────────
function initCharts() {
  const dk = matchMedia('(prefers-color-scheme:dark)').matches;
  const tc = dk ? '#9CA3AF' : '#6B7280';
  const gc = dk ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.06)';
  chMensual = new Chart($('ch-mensual'), {
    type: 'bar',
    data: { labels: [], datasets: [
      { label: 'Ingresos', data: [], backgroundColor: 'rgba(99,153,34,.7)' },
      { label: 'Gastos',  data: [], backgroundColor: 'rgba(163,45,45,.7)' },
    ] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: tc } } },
      scales: {
        x: { grid: { color: gc }, ticks: { color: tc, font: { size: 11 } } },
        y: { grid: { color: gc }, ticks: { color: tc, font: { size: 11 }, callback: (v) => `${Math.round(v/1000)}K` } },
      },
    },
  });
  chGastos = new Chart($('ch-gastos'), {
    type: 'doughnut',
    data: { labels: [], datasets: [{ data: [], backgroundColor: [], borderWidth: 2, borderColor: 'var(--bg-primary)' }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => {
        const tot = ctx.dataset.data.reduce((s, v) => s + v, 0);
        return ` ${ctx.label}: ${eur(ctx.raw)} (${tot > 0 ? (ctx.raw/tot*100).toFixed(1) : '0'}%)`;
      } } } },
    },
  });
  chProvDonut = new Chart($('prov-donut'), {
    type: 'doughnut',
    data: { labels: [], datasets: [{ data: [], backgroundColor: [], borderWidth: 2, borderColor: 'var(--bg-primary)' }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => {
          const tot = ctx.dataset.data.reduce((s, v) => s + v, 0);
          const pctV = tot > 0 ? (ctx.raw / tot * 100).toFixed(1) : '0';
          const ntx = (chProvDonut._ntx || [])[ctx.dataIndex];
          const txStr = ntx != null ? ` · ${ntx} tx` : '';
          return ` ${ctx.label}: ${eur2(ctx.raw)} (${pctV}%)${txStr}`;
        } } },
      },
    },
  });
}

// ─── Tabs ──────────────────────────────────────────────────────────────
function showTab(name, btn) {
  // Defense in depth: si el rol no tiene esa sub-pestaña permitida, no
  // hacer nada. El bootstrap ya oculta el botón, pero esto evita
  // navegación por consola o llamadas programáticas.
  if (Array.isArray(state.subTabsBancos) && !state.subTabsBancos.includes(name)) return;
  document.querySelectorAll('.sect').forEach((s) => s.classList.remove('on'));
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('on'));
  $(`sect-${name}`).classList.add('on');
  if (btn) btn.classList.add('on');
  if (name === 'proveedores') {
    initProvFiltros();
    if (!state.prov.loaded) loadProvRanking();
    if (!evState.cargados) initEvolucion();
  }
  if (name === 'flujo') {
    initFlujoFiltros();
    if (!state.flujo?.loaded) loadFlujoAnual();
  }
  if (name === 'efectivo') {
    initCajaFiltros();
    if (!state.caja?.loaded) loadCaja();
  }
}

// ─── Caja / Efectivo ──────────────────────────────────────────────────
function initCajaFiltros() {
  if (state.caja?._init) return;
  state.caja = state.caja || {};
  state.caja._init = true;
  state.caja.vista = 'local';
  // Sociedad: reusar las opciones globales (clonadas).
  const sSoc = $('caja-sociedad');
  if (sSoc && sSoc.options.length === 0) {
    if (typeof _cloneSociedadOptions === 'function') {
      _cloneSociedadOptions(sSoc);
    } else {
      // Fallback: armar manualmente desde state.sociedades.
      sSoc.innerHTML = '<option value="">Todas las sociedades</option>';
      for (const s of state.sociedades || []) {
        const o = document.createElement('option');
        o.value = s.id; o.textContent = s.nombre;
        sSoc.appendChild(o);
      }
    }
  }
  // Sucursal: lista de keys del mapeo (operativas) + opción especial.
  const sSuc = $('caja-sucursal');
  if (sSuc && sSuc.options.length <= 1) {
    const sucursales = [
      'ALICANTE','ARENALES','BENIDORM','CHICKEN ELCHE','CHICKEN THADER',
      'CHICKEN UNCLES','CREVILLENTE','ELCHE','MURCIA MERCED','ORIHUELA',
      'SAN VICENTE','SANTA POLA','SANTO DOMINGO','THADER','TORREVIEJA',
    ];
    for (const s of sucursales) {
      const o = document.createElement('option');
      o.value = s; o.textContent = s;
      sSuc.appendChild(o);
    }
  }
}

function setCajaVista(v) {
  state.caja = state.caja || {};
  state.caja.vista = v;
  $('caja-vista-local').style.background    = v === 'local'    ? '#185FA5' : 'transparent';
  $('caja-vista-local').style.color         = v === 'local'    ? '#fff' : 'var(--text)';
  $('caja-vista-local').style.fontWeight    = v === 'local'    ? '500' : 'normal';
  $('caja-vista-sociedad').style.background = v === 'sociedad' ? '#185FA5' : 'transparent';
  $('caja-vista-sociedad').style.color      = v === 'sociedad' ? '#fff' : 'var(--text)';
  $('caja-vista-sociedad').style.fontWeight = v === 'sociedad' ? '500' : 'normal';
  $('caja-tabla-titulo').textContent = v === 'local' ? 'Por Local' : 'Por Sociedad';
  $('caja-tabla-col1').textContent   = v === 'local' ? 'Sucursal' : 'Sociedad';
  renderCajaTabla();
}

async function loadCaja() {
  state.caja = state.caja || {};
  const tipo = $('caja-tipo')?.value || 'ambos';
  const sociedad = $('caja-sociedad')?.value || '';
  const sucursal = $('caja-sucursal')?.value || '';
  const incE = $('caja-incluir-especiales')?.checked ? 'true' : 'false';
  // Período del selector global.
  const p = typeof getPeriodoActivo === 'function' ? getPeriodoActivo() : { modo:'unico', periodo:null };
  const params = new URLSearchParams();
  if (tipo !== 'ambos') params.set('tipo', tipo);
  if (sociedad) params.set('sociedad_id', sociedad);
  if (sucursal) params.set('sucursal', sucursal);
  params.set('incluir_especiales', incE);
  if (p.modo === 'rango') {
    if (p.desde) params.set('desde', p.desde + '-01');
    if (p.hasta) {
      const [yy, mm] = p.hasta.split('-').map(Number);
      const ult = new Date(yy, mm, 0).getDate();
      params.set('hasta', p.hasta + '-' + String(ult).padStart(2, '0'));
    }
  } else if (p.periodo) {
    params.set('desde', p.periodo + '-01');
    const [yy, mm] = p.periodo.split('-').map(Number);
    const ult = new Date(yy, mm, 0).getDate();
    params.set('hasta', p.periodo + '-' + String(ult).padStart(2, '0'));
  }
  const qs = params.toString();
  try {
    const [resumen, porSuc, porSoc, cats, mensual] = await Promise.all([
      api('/api/v1/caja/resumen?' + qs),
      api('/api/v1/caja/por-sucursal?' + qs),
      api('/api/v1/caja/por-sociedad?' + qs),
      api('/api/v1/caja/categorias?' + qs),
      api('/api/v1/caja/flujo-mensual?' + qs),
    ]);
    state.caja.resumen = resumen;
    state.caja.por_sucursal = porSuc.sucursales || [];
    state.caja.por_sociedad = porSoc.sociedades || [];
    state.caja.categorias = cats.categorias || [];
    state.caja.mensual = mensual.meses || [];
    state.caja.loaded = true;
    renderCajaKpis();
    renderCajaTabla();
    renderCajaCategorias();
    renderCajaMensual();
  } catch (e) {
    console.error('[caja] error:', e);
    $('caja-tabla-body').innerHTML = `<tr><td colspan="7" style="padding:18px;text-align:center;color:#dc2626">Error: ${e.message}</td></tr>`;
  }
}

function renderCajaKpis() {
  const r = state.caja?.resumen;
  if (!r) return;
  $('caja-kpi-ingresos').textContent = eur2(r.ingresos);
  $('caja-kpi-egresos').textContent  = eur2(r.egresos);
  const elNeto = $('caja-kpi-neto');
  elNeto.textContent = (r.neto >= 0 ? '+' : '') + eur2(r.neto);
  elNeto.style.color = r.neto >= 0 ? '#16a34a' : '#dc2626';
  $('caja-kpi-n').textContent = r.n_movs.toLocaleString('es-ES');
  // Rango disponible: viene del response como `rango_total` (respeta el
  // floor por rol, ignora filtros activos). Formato corto "Jul 2025 → Jun 2026".
  const rt = r.rango_total;
  const span = $('caja-rango-disponible')?.querySelector('span');
  if (span) {
    if (rt?.fecha_min && rt?.fecha_max) {
      const fmt = (iso) => {
        const [y, m] = iso.split('-').map(Number);
        return _mesLabel(`${y}-${String(m).padStart(2,'0')}`);
      };
      span.textContent = `${fmt(rt.fecha_min)} → ${fmt(rt.fecha_max)}`;
    } else {
      span.textContent = '—';
    }
  }
}

function renderCajaTabla() {
  const vista = state.caja?.vista || 'local';
  const rows = vista === 'local' ? state.caja?.por_sucursal : state.caja?.por_sociedad;
  if (!rows?.length) {
    $('caja-tabla-body').innerHTML = '<tr><td colspan="7" style="padding:18px;text-align:center;color:var(--text-2)">Sin movimientos en este filtro.</td></tr>';
    return;
  }
  const SOC_NOMBRES = Object.fromEntries((state.sociedades || []).map((s) => [s.id, s.nombre]));
  $('caja-tabla-body').innerHTML = rows.map((r) => {
    const sem = _semaforoFlujo(r.pct_neto);
    const netoClass = r.neto >= 0 ? 'flujo-neto-pos' : 'flujo-neto-neg';
    if (vista === 'local') {
      const socNombre = r.sociedad_id ? (SOC_NOMBRES[r.sociedad_id] || r.sociedad_id) : '(especial)';
      return `<tr style="border-bottom:.5px solid var(--border-3)">
        <td style="padding:7px 6px;font-weight:500">${r.sucursal}</td>
        <td style="padding:7px 6px;color:var(--text-2);font-size:11px">${socNombre}</td>
        <td style="padding:7px 6px;text-align:right">${eur(r.ingresos)}</td>
        <td style="padding:7px 6px;text-align:right">${eur(r.egresos)}</td>
        <td class="${netoClass}" style="padding:7px 6px;text-align:right">${(r.neto>=0?'+':'')+eur(r.neto)}</td>
        <td class="${sem.cssPct}" style="padding:7px 6px;text-align:right">${r.pct_neto.toFixed(1)}%</td>
        <td class="flujo-estado" style="padding:7px 6px" title="${sem.texto}"><span class="flujo-chip ${sem.cssChip}"></span>${sem.icon}</td>
      </tr>`;
    }
    // Vista por sociedad
    const socNombre = r.sociedad_id ? (SOC_NOMBRES[r.sociedad_id] || r.sociedad_id) : '(sin sociedad)';
    return `<tr style="border-bottom:.5px solid var(--border-3)">
      <td style="padding:7px 6px;font-weight:500">${socNombre}</td>
      <td style="padding:7px 6px;color:var(--text-2);font-size:11px">${r.n_movs} movs</td>
      <td style="padding:7px 6px;text-align:right">${eur(r.ingresos)}</td>
      <td style="padding:7px 6px;text-align:right">${eur(r.egresos)}</td>
      <td class="${netoClass}" style="padding:7px 6px;text-align:right">${(r.neto>=0?'+':'')+eur(r.neto)}</td>
      <td class="${sem.cssPct}" style="padding:7px 6px;text-align:right">${r.pct_neto.toFixed(1)}%</td>
      <td class="flujo-estado" style="padding:7px 6px" title="${sem.texto}"><span class="flujo-chip ${sem.cssChip}"></span>${sem.icon}</td>
    </tr>`;
  }).join('');
}

function renderCajaCategorias() {
  const cats = state.caja?.categorias || [];
  if (!cats.length) { $('caja-categorias-body').innerHTML = '<p style="color:var(--text-2)">Sin datos.</p>'; return; }
  $('caja-categorias-body').innerHTML = cats.map((c) => {
    const colorTipo = (c.tipo||'').toLowerCase() === 'ingreso' ? '#16a34a' : '#dc2626';
    return `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:.5px solid var(--border-3)">
      <span style="width:9px;height:9px;border-radius:2px;background:${colorTipo};flex-shrink:0"></span>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${(c.subtipo||'').replace(/"/g,'&quot;')}">${c.subtipo || '(sin subtipo)'}</span>
      <span style="color:var(--text-2);font-size:10px">${c.n_movs}</span>
      <span style="font-weight:500;color:${colorTipo};min-width:90px;text-align:right">${eur(c.total)}</span>
    </div>`;
  }).join('');
}

function renderCajaMensual() {
  const meses = state.caja?.mensual || [];
  if (!meses.length) { $('caja-mensual-body').innerHTML = '<tr><td colspan="5" style="padding:14px;text-align:center;color:var(--text-2)">Sin datos.</td></tr>'; return; }
  const _mesLab = typeof _mesLabel === 'function' ? _mesLabel : (m) => m;
  $('caja-mensual-body').innerHTML = meses.map((m) => {
    const sem = _semaforoFlujo(m.pct_neto);
    const netoClass = m.neto >= 0 ? 'flujo-neto-pos' : 'flujo-neto-neg';
    return `<tr style="border-bottom:.5px solid var(--border-3)">
      <td style="padding:6px;font-weight:500">${_mesLab(m.mes)}</td>
      <td style="padding:6px;text-align:right">${eur(m.ingresos)}</td>
      <td style="padding:6px;text-align:right">${eur(m.egresos)}</td>
      <td class="${netoClass}" style="padding:6px;text-align:right">${(m.neto>=0?'+':'')+eur(m.neto)}</td>
      <td class="flujo-estado" style="padding:6px"><span class="flujo-chip ${sem.cssChip}"></span>${sem.icon}</td>
    </tr>`;
  }).join('');
}

// ─── Flujo Anual: tabla mensual + comparador ─────────────────────────
// Fuente de verdad de las opciones de sociedad: el <select id="prov-sociedad">
// en public/bancos/index.html. _cloneSociedadOptions clona ese listado a
// cualquier otro <select> del módulo para evitar mantener 2 copias.
// Agregar/quitar sociedades: editar SOLO el HTML del #prov-sociedad.
function _cloneSociedadOptions(targetSel) {
  if (!targetSel) return false;
  const src = $('prov-sociedad');
  if (!src || !src.options.length) return false;
  targetSel.innerHTML = src.innerHTML;
  return true;
}

function initFlujoFiltros() {
  const sel = $('flujo-sociedad');
  if (!sel || sel.options.length > 0) return;
  _cloneSociedadOptions(sel);
}

// Vista del flujo: 'banco' (default), 'efectivo', 'combinado'.
// Se persiste en state.flujo.vista durante la sesión.
function setFlujoVista(v) {
  state.flujo = state.flujo || {};
  state.flujo.vista = v;
  for (const k of ['banco','efectivo','combinado']) {
    const b = $('flujo-vista-' + k);
    if (b) {
      b.style.background = (k === v) ? '#185FA5' : 'transparent';
      b.style.color      = (k === v) ? '#fff'    : 'var(--text)';
      b.style.fontWeight = (k === v) ? '500'     : 'normal';
    }
  }
  // Re-cargar con la nueva vista.
  loadFlujoAnual();
}

async function loadFlujoAnual() {
  state.flujo = state.flujo || {};
  const vista = state.flujo.vista || 'banco';
  const sociedad = $('flujo-sociedad')?.value || '';
  const params = new URLSearchParams();
  if (sociedad) params.set('sociedad_id', sociedad);
  try {
    // Según vista pegamos a un endpoint distinto. El payload se normaliza
    // al shape estándar { meses: [{mes, ingresos, gastos, neto, pct_neto, ...}] }
    let meses = [];
    let avisoRol = false;
    if (vista === 'banco') {
      const j = await api('/api/v1/bancos/flujo-mensual?' + params.toString());
      meses = (j.meses || []).map((m) => ({ ...m, ingresos: m.ingresos, gastos: m.gastos }));
      avisoRol = !!j.desglose_filtrado_por_rol;
    } else if (vista === 'efectivo') {
      const j = await api('/api/v1/caja/flujo-mensual?' + params.toString());
      meses = (j.meses || []).map((m) => ({
        mes: m.mes,
        ingresos: m.ingresos,
        gastos: m.egresos,   // alias para reusar render
        neto: m.neto,
        pct_neto: m.pct_neto,
        n_movs: m.n_movs,
        categorias: [],
      }));
    } else { // combinado
      const j = await api('/api/v1/caja/combinado?' + params.toString());
      meses = (j.meses || []).map((m) => ({
        mes: m.mes,
        ingresos: m.total_ingresos,
        gastos: m.total_gastos,
        neto: m.total_neto,
        pct_neto: m.pct_neto,
        pct_efectivo: m.pct_efectivo,
        n_movs: 0,
        categorias: [],
        // extras para tooltip
        _banco_ing: m.banco_ingresos, _banco_gas: m.banco_gastos,
        _caja_ing:  m.caja_ingresos,  _caja_gas:  m.caja_gastos,
      }));
    }
    state.flujo.meses = meses;
    state.flujo.desglose_filtrado_por_rol = avisoRol;
    state.flujo.loaded = true;
    $('flujo-aviso-rol').style.display = avisoRol ? '' : 'none';
    renderFlujoTabla();
    populateMesDropdowns();
    renderFlujoComparativa();
  } catch (e) {
    $('flujo-tbody').innerHTML = `<tr><td colspan="6" style="padding:18px;text-align:center;color:#dc2626">Error: ${e.message}</td></tr>`;
  }
}

const MESES_FLUJO_ES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
function _mesLabel(yyyymm) {
  const [y, m] = (yyyymm || '').split('-').map(Number);
  return `${MESES_FLUJO_ES[m-1]} ${y}`;
}
function _semaforoFlujo(pct) {
  // Devuelve emoji + clases CSS para chip + color del % Neto.
  // Las clases viven en public/css/styles.css con !important — los
  // emojis solos no son confiables (algunos navegadores los renderizan
  // en monocromo); el chip cuadrado va al lado para garantizar
  // visibilidad siempre.
  if (pct > 20) return { icon: '🟢🟢', cssChip: 'flujo-chip-exc',  cssPct: 'flujo-pct-exc',  texto: 'Excelente' };
  if (pct > 10) return { icon: '🟢',   cssChip: 'flujo-chip-bien', cssPct: 'flujo-pct-bien', texto: 'Bien' };
  if (pct > 0)  return { icon: '🟡',   cssChip: 'flujo-chip-ajus', cssPct: 'flujo-pct-ajus', texto: 'Ajustado' };
  return            { icon: '🔴',   cssChip: 'flujo-chip-neg',  cssPct: 'flujo-pct-neg',  texto: 'Negativo' };
}
function _eurSigned(n) {
  const s = n >= 0 ? '+' : '−';
  return s + eur(Math.abs(n));
}

function renderFlujoTabla() {
  const meses = state.flujo?.meses || [];
  if (!meses.length) {
    $('flujo-tbody').innerHTML = '<tr><td colspan="6" style="padding:18px;text-align:center;color:var(--text-2)">Sin datos para este filtro.</td></tr>';
    return;
  }
  $('flujo-tbody').innerHTML = meses.map((m) => {
    const sem = _semaforoFlujo(m.pct_neto);
    const netoClass = m.neto >= 0 ? 'flujo-neto-pos' : 'flujo-neto-neg';
    return `<tr style="border-bottom:.5px solid var(--border-3)">
      <td style="padding:8px 6px;font-weight:500">${_mesLabel(m.mes)}</td>
      <td style="padding:8px 6px;text-align:right">${eur(m.ingresos)}</td>
      <td style="padding:8px 6px;text-align:right">${eur(m.gastos)}</td>
      <td class="${netoClass}" style="padding:8px 6px;text-align:right">${_eurSigned(m.neto)}</td>
      <td class="${sem.cssPct}" style="padding:8px 6px;text-align:right">${m.pct_neto.toFixed(1)}%</td>
      <td class="flujo-estado" style="padding:8px 6px" title="${sem.texto}"><span class="flujo-chip ${sem.cssChip}"></span>${sem.icon}</td>
    </tr>`;
  }).join('');
}

function populateMesDropdowns() {
  const meses = state.flujo?.meses || [];
  if (!meses.length) return;
  const selA = $('flujo-mes-a'); const selB = $('flujo-mes-b');
  if (!selA || !selB) return;
  // Default: A = último, B = mismo mes año anterior si existe, sino primer mes
  const lastIdx = meses.length - 1;
  let defaultBIdx = 0;
  if (meses.length >= 13) defaultBIdx = lastIdx - 12;
  const opts = meses.map((m) => `<option value="${m.mes}">${_mesLabel(m.mes)}</option>`).join('');
  selA.innerHTML = opts; selB.innerHTML = opts;
  selA.value = meses[lastIdx].mes;
  selB.value = meses[defaultBIdx].mes;
}

// Categorías de gasto "fijas" (no recortables a corto plazo) — usadas
// por el análisis automático para decidir si el gap del neto se puede
// cerrar tocando solo gastos variables o si requiere apretar fijos.
const FLUJO_CATS_FIJAS = new Set([
  'ALQUILER', 'NOMINAS', 'NOMINAS_DIRECCION', 'SS_LABORAL',
  'PRESTAMOS', 'FINANCIERO', 'SUMINISTROS_ENERGIA', 'SUMINISTROS_AGUA',
  'SUMINISTROS_LUZ', 'SEGUROS', 'IMPUESTOS', 'TELECOMUNICACIONES',
]);

function renderFlujoComparativa() {
  const meses = state.flujo?.meses || [];
  if (!meses.length) { $('flujo-comp-table').innerHTML = ''; $('flujo-comp-analisis').innerHTML = ''; return; }
  const codA = $('flujo-mes-a')?.value;
  const codB = $('flujo-mes-b')?.value;
  const A = meses.find((m) => m.mes === codA);
  const B = meses.find((m) => m.mes === codB);
  if (!A || !B) { $('flujo-comp-table').innerHTML = ''; return; }

  // Construir comparativa por categoría — cats con |dif| > €300.
  // El umbral va al input del análisis automático (las cats agregadas en
  // el bloque "ANÁLISIS" pueden ser un poco más conservadoras).
  const catsMap = new Map(); // codigo → { display, a, b }
  for (const c of A.categorias) catsMap.set(c.codigo, { display: c.nombre_display, a: c.total, b: 0 });
  for (const c of B.categorias) {
    const cur = catsMap.get(c.codigo) || { display: c.nombre_display, a: 0, b: 0 };
    cur.b = c.total;
    if (!catsMap.has(c.codigo)) catsMap.set(c.codigo, cur);
  }
  const catsDif = [...catsMap.entries()]
    .map(([codigo, v]) => ({ codigo, display: v.display, a: v.a, b: v.b, dif: v.a - v.b }))
    .filter((x) => Math.abs(x.dif) > 300)
    .sort((a, b) => Math.abs(b.dif) - Math.abs(a.dif));

  // Convención de signos del diff:
  //   A vs B: dif > 0  →  el valor en A es mayor que en B
  //                       (gasto subió respecto a B / ingreso subió respecto a B)
  //   dif < 0 → bajó.
  // Para los iconos de "buen/mal" cambio:
  //   en INGRESOS:  subir = bueno (verde) / bajar = malo (rojo)
  //   en GASTOS:    subir = malo (rojo)  / bajar = bueno (verde)
  const difIng = A.ingresos - B.ingresos;
  const difGas = A.gastos - B.gastos;
  const difNeto = A.neto - B.neto;
  const difPctNeto = A.pct_neto - B.pct_neto;

  function _signoIcono(dif, gastoes) {
    if (Math.abs(dif) < 300) return { ico: '→', cssTxt: '', cssChip: 'flujo-chip-neu' };
    const subio = dif > 0;
    const malo = (gastoes && subio) || (!gastoes && !subio);
    return malo
      ? { ico: '🔴', cssTxt: 'flujo-pct-neg',  cssChip: 'flujo-chip-neg' }
      : { ico: '🟢', cssTxt: 'flujo-pct-bien', cssChip: 'flujo-chip-bien' };
  }
  const lblA = _mesLabel(A.mes); const lblB = _mesLabel(B.mes);

  function rowTotal(label, valA, valB, dif, gastoes) {
    const sg = _signoIcono(dif, gastoes);
    return `<tr class="flujo-comp-total">
      <td style="padding:8px 6px">${label}</td>
      <td style="padding:8px 6px;text-align:right">${eur(valA)}</td>
      <td style="padding:8px 6px;text-align:right">${eur(valB)}</td>
      <td class="${sg.cssTxt}" style="padding:8px 6px;text-align:right"><span class="flujo-chip ${sg.cssChip}"></span>${_eurSigned(dif)} ${sg.ico}</td>
    </tr>`;
  }
  function rowCat(c) {
    const sg = _signoIcono(c.dif, true);
    return `<tr class="flujo-comp-cat">
      <td style="padding:5px 6px">└ ${c.display}</td>
      <td style="padding:5px 6px;text-align:right">${eur(c.a)}</td>
      <td style="padding:5px 6px;text-align:right;color:var(--text-2)">${eur(c.b)}</td>
      <td class="${sg.cssTxt}" style="padding:5px 6px;text-align:right"><span class="flujo-chip ${sg.cssChip}"></span>${_eurSigned(c.dif)} ${sg.ico}</td>
    </tr>`;
  }
  function rowNetoBloque() {
    const clsA = A.neto >= 0 ? 'flujo-neto-pos' : 'flujo-neto-neg';
    const clsB = B.neto >= 0 ? 'flujo-neto-pos' : 'flujo-neto-neg';
    const sgN = _signoIcono(difNeto, false);
    const sgP = _signoIcono(difPctNeto * 1000, false); // amplifico para que el umbral 300 aplique a pp
    return `<tr class="flujo-comp-neto">
      <td style="padding:10px 6px">Neto</td>
      <td class="${clsA}" style="padding:10px 6px;text-align:right">${_eurSigned(A.neto)}</td>
      <td class="${clsB}" style="padding:10px 6px;text-align:right">${_eurSigned(B.neto)}</td>
      <td class="${sgN.cssTxt}" style="padding:10px 6px;text-align:right"><span class="flujo-chip ${sgN.cssChip}"></span>${_eurSigned(difNeto)} ${sgN.ico}</td>
    </tr>
    <tr class="flujo-comp-neto">
      <td style="padding:6px">% Neto</td>
      <td style="padding:6px;text-align:right">${A.pct_neto.toFixed(1)}%</td>
      <td style="padding:6px;text-align:right;color:var(--text-2)">${B.pct_neto.toFixed(1)}%</td>
      <td class="${sgP.cssTxt}" style="padding:6px;text-align:right">${(difPctNeto>=0?'+':'')}${difPctNeto.toFixed(1)}pp</td>
    </tr>`;
  }

  $('flujo-comp-table').innerHTML = `<table style="width:100%;font-size:13px;border-collapse:collapse">
    <thead>
      <tr style="border-bottom:1.5px solid var(--border-2)">
        <th style="text-align:left;padding:8px 6px;font-size:11px;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px">Categoría</th>
        <th style="text-align:right;padding:8px 6px;font-size:12px">${lblA}</th>
        <th style="text-align:right;padding:8px 6px;font-size:12px;color:var(--text-2)">${lblB}</th>
        <th style="text-align:right;padding:8px 6px;font-size:11px;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px">Diferencia</th>
      </tr>
    </thead>
    <tbody>
      ${rowTotal('Ingresos total', A.ingresos, B.ingresos, difIng, false)}
      ${rowTotal('Gastos total', A.gastos, B.gastos, difGas, true)}
      ${catsDif.map(rowCat).join('')}
      ${rowNetoBloque()}
    </tbody>
  </table>`;

  // ─── Análisis automático enriquecido ───────────
  const lineas = [];
  // (1) Causa principal del deterioro/mejora
  const pctIng = B.ingresos > 0 ? (difIng / B.ingresos * 100) : 0;
  const pctGas = B.gastos > 0 ? (difGas / B.gastos * 100) : 0;
  if (Math.abs(difIng) >= Math.abs(difGas) * 1.3 && Math.abs(difIng) >= 1000) {
    const verbo = difIng > 0 ? 'subieron' : 'bajaron';
    const icoCausa = difIng > 0 ? '🟢' : '🔴';
    const cls = difIng > 0 ? 'flujo-chip-bien' : 'flujo-chip-neg';
    const sufijo = difIng > 0 ? '— motor del resultado' : '— causa principal del deterioro';
    lineas.push(`<span class="flujo-chip ${cls}"></span><span><strong>Ingresos ${verbo} ${_eurSigned(difIng)}</strong> (${pctIng>=0?'+':''}${pctIng.toFixed(1)}%) ${sufijo}</span>`);
  } else if (Math.abs(difGas) >= Math.abs(difIng) * 1.3 && Math.abs(difGas) >= 1000) {
    const verbo = difGas > 0 ? 'subieron' : 'bajaron';
    const icoCausa = difGas > 0 ? '🔴' : '🟢';
    const cls = difGas > 0 ? 'flujo-chip-neg' : 'flujo-chip-bien';
    const sufijo = difGas > 0 ? '— causa principal del deterioro' : '— mejora estructural';
    lineas.push(`<span class="flujo-chip ${cls}"></span><span><strong>Gastos ${verbo} ${_eurSigned(difGas)}</strong> (${pctGas>=0?'+':''}${pctGas.toFixed(1)}%) ${sufijo}</span>`);
  } else {
    lineas.push(`<span class="flujo-chip flujo-chip-neu"></span><span>La diferencia se reparte entre ingresos (${_eurSigned(difIng)}) y gastos (${_eurSigned(difGas)})</span>`);
  }

  // (2) Top 3 categorías de gasto que MÁS SUBIERON (dif > 0)
  const subieron = catsDif.filter((c) => c.dif > 0).slice(0, 3);
  for (const c of subieron) {
    lineas.push(`<span class="flujo-chip flujo-chip-neg"></span><span><strong>${c.display}</strong> subió ${_eurSigned(c.dif)} <span style="color:var(--text-2);font-size:11px">(${eur(c.b)} → ${eur(c.a)})</span></span>`);
  }
  // (3) Top 2 categorías de gasto que BAJARON (dif < 0) — eso es positivo
  const bajaron = catsDif.filter((c) => c.dif < 0).slice(0, 2);
  for (const c of bajaron) {
    lineas.push(`<span class="flujo-chip flujo-chip-bien"></span><span><strong>${c.display}</strong> bajó ${_eurSigned(c.dif)} <span style="color:var(--text-2);font-size:11px">(${eur(c.b)} → ${eur(c.a)})</span> — positivo</span>`);
  }

  // ─── Sugerencias para cerrar el gap del Neto ───────────
  // Solo aplican si Mes A (típicamente el "actual") tiene neto peor que B.
  let sugHtml = '';
  if (difNeto < -500) {
    const gap = -difNeto; // cuánto falta para igualar B
    // Camino 1: solo ingresos. ¿Cuánto debería crecer la facturación
    // de A para cerrar el gap?
    const factPctNec = A.ingresos > 0 ? (gap / A.ingresos * 100) : 0;
    // Camino 2: solo gastos. ¿Cuánto deberíamos recortar?
    // Calculamos cuánto está disponible en cats VARIABLES (no fijas) y
    // dejamos nota si necesita tocar fijas.
    const gastosVariablesA = (A.categorias || [])
      .filter((c) => !FLUJO_CATS_FIJAS.has(c.codigo))
      .reduce((s, c) => s + c.total, 0);
    const recorteSoloEnVariables = Math.min(gap, gastosVariablesA);
    const necesitaTocarFijos = gap > gastosVariablesA;
    // Camino 3: combinación 50/50 (ingresos + recorte de variables)
    const mitad = gap / 2;
    const factPctMitad = A.ingresos > 0 ? (mitad / A.ingresos * 100) : 0;
    const recorteMitad = Math.min(mitad, gastosVariablesA);

    const items = [];
    items.push(`<li><strong>${_eurSigned(gap)} más de ingresos</strong> (facturación +${factPctNec.toFixed(1)}%)</li>`);
    if (necesitaTocarFijos) {
      items.push(`<li><strong>${_eurSigned(-gap)} menos de gastos</strong> — gastos variables disponibles ${eur(gastosVariablesA)} &lt; ${eur(gap)}, requiere tocar nóminas/alquiler/SS/etc.</li>`);
    } else {
      items.push(`<li><strong>${_eurSigned(-gap)} menos de gastos variables</strong> (proveedores, mantenimiento, publicidad, etc. — sin tocar fijos)</li>`);
    }
    items.push(`<li>Combinación: <strong>+${eur(mitad)} ingresos</strong> y <strong>-${eur(recorteMitad)} gastos variables</strong></li>`);

    sugHtml = `<div class="flujo-sugerencias">
      <div class="titulo">💡 Para que ${lblA} cerrara como ${lblB} necesitabas:</div>
      <ul>${items.join('')}</ul>
    </div>`;
  } else if (difNeto > 500) {
    // A está mejor que B — mostrar mensaje positivo en lugar de sugerencias.
    sugHtml = `<div class="flujo-sugerencias" style="background:#F0FDF4;border-color:#86EFAC">
      <div class="titulo" style="color:#15803d">✅ ${lblA} cerró mejor que ${lblB} por ${_eurSigned(difNeto)}</div>
      <ul><li>Mantener el patrón de gastos actual y replicar el mix de ingresos.</li></ul>
    </div>`;
  }

  $('flujo-comp-analisis').innerHTML = `<div class="flujo-analisis-titulo">📊 Análisis comparativo — ${lblA} vs ${lblB}</div>`
    + lineas.map((l) => `<div class="flujo-analisis-linea">${l}</div>`).join('')
    + sugHtml;
}

// ─── Evolución temporal por proveedor / categoría ─────────────────────
async function initEvolucion() {
  // Cargar lista de proveedores y construir selectores.
  try {
    const j = await api('/api/v1/bancos/proveedores-lista');
    evState.proveedores_lista = j.proveedores || [];
    evState.categorias_lista = [...new Set(evState.proveedores_lista.map((p) => p.categoria).filter(Boolean))].sort();
  } catch (e) { console.warn('[ev] no se pudo cargar lista:', e); }

  // Sociedades + período desde/hasta
  const socSel = $('ev-soc');
  if (socSel && socSel.options.length <= 1) {
    for (const s of state.sociedades) {
      const o = document.createElement('option');
      o.value = s.id; o.textContent = s.nombre;
      socSel.appendChild(o);
    }
  }
  for (const id of ['ev-desde', 'ev-hasta']) {
    const sel = $(id);
    if (sel && sel.options.length === 0) {
      for (const p of state.periodos) {
        const o = document.createElement('option');
        o.value = p; o.textContent = PERIOD_LABELS(p);
        sel.appendChild(o);
      }
    }
  }
  // Default: 6 meses
  if (state.periodos.length > 0) {
    const last = state.periodos[state.periodos.length - 1];
    const first = state.periodos.length >= 6
      ? state.periodos[state.periodos.length - 6]
      : state.periodos[0];
    if (!$('ev-desde').value) $('ev-desde').value = first;
    if (!$('ev-hasta').value) $('ev-hasta').value = last;
  }

  // Inicializar gráfico
  if (!chEvolucion) {
    chEvolucion = new Chart($('ev-chart'), {
      type: 'line',
      data: { labels: [], datasets: [] },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: true, position: 'bottom', labels: { boxWidth: 14, font: { size: 11 } } },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const v = ctx.parsed.y;
                const i = ctx.dataIndex;
                const ds = ctx.dataset;
                const prev = i > 0 ? ds.data[i - 1] : null;
                let varTxt = '';
                if (prev != null && prev > 0) {
                  const dv = (v - prev) / prev * 100;
                  varTxt = ` (${dv >= 0 ? '+' : ''}${dv.toFixed(1)}% vs mes ant.)`;
                }
                return ` ${ds.label}: ${eur(v)}${varTxt}`;
              },
            },
          },
        },
        scales: {
          x: { grid: { color: 'rgba(0,0,0,.05)' }, ticks: { font: { size: 11 } } },
          y: { grid: { color: 'rgba(0,0,0,.05)' }, ticks: { font: { size: 11 }, callback: (v) => `${Math.round(v/1000)}K` } },
        },
      },
    });
  }

  evState.cargados = true;
  evRenderChips();
  loadEvolucion();
}

function evRenderSugerencias() {
  const q = $('ev-q').value.trim().toLowerCase();
  const box = $('ev-sugerencias');
  if (!q) { box.style.display = 'none'; return; }
  const provs = evState.proveedores_lista.filter((p) =>
    p.proveedor.toLowerCase().includes(q)
  ).slice(0, 15);
  const cats = evState.categorias_lista.filter((c) =>
    c.toLowerCase().includes(q.toUpperCase().replace(/ /g, '_'))
  ).slice(0, 8);
  if (!provs.length && !cats.length) { box.style.display = 'none'; return; }
  box.style.display = '';
  box.innerHTML = [
    ...cats.map((c) => `<div class="ev-sug-item" data-type="cat" data-val="${c}" onmousedown="evSeleccionar('cat','${c.replace(/'/g,"&#39;")}')" style="padding:6px 9px;cursor:pointer;font-size:12px;border-bottom:.5px solid var(--border-3)"><span style="background:#E6F1FB;color:#185FA5;padding:1px 6px;border-radius:4px;font-size:10px;margin-right:6px">cat</span>${c}</div>`),
    ...provs.map((p) => `<div class="ev-sug-item" data-type="prov" data-val="${p.proveedor}" onmousedown="evSeleccionar('prov','${p.proveedor.replace(/'/g,"&#39;")}')" style="padding:6px 9px;cursor:pointer;font-size:12px;border-bottom:.5px solid var(--border-3)"><span style="background:#EAF3DE;color:#3B6D11;padding:1px 6px;border-radius:4px;font-size:10px;margin-right:6px">prov</span>${p.proveedor}<span style="float:right;font-size:10px;color:var(--text-2)">${(p.categoria || '').replace('PROVEEDOR_','')}</span></div>`),
  ].join('');
}

function evAplicarTopMatch() {
  const first = $('ev-sugerencias').querySelector('.ev-sug-item');
  if (!first) return;
  evSeleccionar(first.dataset.type, first.dataset.val);
}

function evSeleccionar(tipo, valor) {
  if (tipo === 'cat') {
    if (!evState.seleccionados_cat.includes(valor)) evState.seleccionados_cat.push(valor);
  } else {
    if (!evState.seleccionados_prov.includes(valor)) evState.seleccionados_prov.push(valor);
  }
  $('ev-q').value = '';
  $('ev-sugerencias').style.display = 'none';
  evRenderChips();
  loadEvolucion();
}

function evQuitar(tipo, valor) {
  if (tipo === 'cat') evState.seleccionados_cat = evState.seleccionados_cat.filter((v) => v !== valor);
  else evState.seleccionados_prov = evState.seleccionados_prov.filter((v) => v !== valor);
  evRenderChips();
  loadEvolucion();
}

function evRenderChips() {
  const c = $('ev-chips');
  const chips = [
    ...evState.seleccionados_cat.map((v) => ({ tipo: 'cat', valor: v, color: '#185FA5', bg: '#E6F1FB' })),
    ...evState.seleccionados_prov.map((v) => ({ tipo: 'prov', valor: v, color: '#3B6D11', bg: '#EAF3DE' })),
  ];
  if (!chips.length) {
    c.innerHTML = '<p style="font-size:11px;color:var(--text-2);padding:4px 6px">Sin selección — usá el buscador.</p>';
    return;
  }
  c.innerHTML = chips.map((ch) => `<span style="display:inline-flex;align-items:center;gap:4px;padding:3px 8px;font-size:11px;background:${ch.bg};color:${ch.color};border-radius:12px">
    <span>${ch.valor.replace('PROVEEDOR_', '')}</span>
    <span style="cursor:pointer;font-weight:700" onclick="evQuitar('${ch.tipo}','${ch.valor.replace(/'/g, "&#39;")}')">×</span>
  </span>`).join('');
}

async function loadEvolucion() {
  if (!chEvolucion) return;
  const params = new URLSearchParams();
  if ($('ev-soc').value) params.set('sociedad_id', $('ev-soc').value);
  params.set('desde', $('ev-desde').value);
  params.set('hasta', $('ev-hasta').value);
  if (evState.seleccionados_prov.length) params.set('proveedores', evState.seleccionados_prov.join(','));
  if (evState.seleccionados_cat.length)  params.set('categorias',  evState.seleccionados_cat.join(','));
  if ($('ev-yoy').checked) params.set('yoy', '1');

  if (!evState.seleccionados_prov.length && !evState.seleccionados_cat.length) {
    chEvolucion.data.labels = [];
    chEvolucion.data.datasets = [];
    chEvolucion.update();
    return;
  }
  try {
    const j = await api('/api/v1/bancos/proveedor-evolucion?' + params.toString());
    const meses = j.meses || [];
    const labels = meses.map(PERIOD_LABELS);
    const isSingleMonth = meses.length === 1;

    let colorIdx = 0;
    const ds = [];
    function mkDataset(label, data, opts = {}) {
      const color = COLORS_CAT[colorIdx++ % COLORS_CAT.length];
      return {
        label, data,
        borderColor: color,
        backgroundColor: isSingleMonth ? color : color + '33',
        tension: 0.3, fill: false,
        borderDash: opts.dashed ? [4, 4] : [],
        pointRadius: 3,
      };
    }
    (j.categorias || []).forEach((s) => ds.push(mkDataset((s.key || '').replace('PROVEEDOR_', ''), s.data)));
    (j.proveedores || []).forEach((s) => ds.push(mkDataset(s.key, s.data)));
    // YoY: replicar con dash
    if (j.yoy) {
      (j.yoy.categorias || []).forEach((s) => ds.push(mkDataset((s.key || '').replace('PROVEEDOR_', '') + ' (año ant.)', s.data, { dashed: true })));
      (j.yoy.proveedores || []).forEach((s) => ds.push(mkDataset(s.key + ' (año ant.)', s.data, { dashed: true })));
    }

    chEvolucion.config.type = isSingleMonth ? 'bar' : 'line';
    chEvolucion.data.labels = labels;
    chEvolucion.data.datasets = ds;
    chEvolucion.update();
  } catch (e) {
    console.warn('[ev] error:', e);
    Api && Api.pill ? Api.pill('Error al cargar evolución', true) : 0;
  }
}

function toggleUpload() {
  const p = $('upload-panel');
  p.style.display = p.style.display === 'none' ? '' : 'none';
}

// ─── Carga múltiple de extractos (Santander/Sabadell, XLS/PDF) ─────────
// El usuario arrastra o selecciona N archivos. Cada archivo se procesa
// secuencialmente contra /upload-extracto-auto que autodetecta banco y
// sociedad. Si la sociedad no se detecta, se pide en línea para ese
// archivo (select inline + reintento). Al terminar todos se muestra un
// resumen consolidado.

const UP_EXT_MAX = 10;
let upExtRunning = false;

function upExtDragOver(e) {
  e.preventDefault();
  $('up-ext-dropzone').style.background = 'rgba(24,95,165,.10)';
  $('up-ext-dropzone').style.borderColor = '#185FA5';
  return false;
}
function upExtDragLeave(e) {
  $('up-ext-dropzone').style.background = 'var(--bg-secondary)';
  $('up-ext-dropzone').style.borderColor = 'var(--border-2)';
}
function upExtDrop(e) {
  e.preventDefault();
  upExtDragLeave();
  const files = (e.dataTransfer && e.dataTransfer.files) ? e.dataTransfer.files : [];
  upExtFilesChosen(files);
  return false;
}

function upExtFilesChosen(fileList) {
  if (upExtRunning) {
    alert('Ya hay una tanda procesándose. Esperá a que termine.');
    return;
  }
  const files = Array.from(fileList || []).slice(0, UP_EXT_MAX);
  if (!files.length) return;
  // Estado por archivo: pending | running | ok | error | need-sociedad
  const items = files.map((f) => ({
    file: f,
    name: f.name,
    sizeKb: Math.round(f.size / 1024),
    estado: 'pending',
    sociedad_id: null,
    resultado: null,
    error: null,
  }));
  state._upExt = { items, startedAt: Date.now() };
  $('up-ext-summary').style.display = 'none';
  $('up-ext-summary').innerHTML = '';
  _upExtRenderList();
  $('up-ext-list').style.display = '';
  _upExtRunQueue();
}

function _upExtRenderList() {
  const items = state._upExt?.items || [];
  $('up-ext-list').innerHTML = items.map((it, i) => {
    const icono = ({
      pending: '⏳', running: '⚙️', ok: '✅', error: '❌', 'need-sociedad': '⚠️',
    })[it.estado] || '·';
    let derecha = '';
    if (it.estado === 'pending') derecha = `<span style="font-size:10px;color:var(--text-2)">en cola</span>`;
    else if (it.estado === 'running') derecha = `<span style="font-size:10px;color:#185FA5">procesando…</span>`;
    else if (it.estado === 'ok') {
      const r = it.resultado;
      derecha = `<span style="font-size:10px;color:#16a34a">${r.insertadas} insertadas · ${r.duplicadas} dup · ${r.reglas_db_aplicadas} reglas · ${r.banco_detectado}/${r.sociedad_id}</span>`;
    } else if (it.estado === 'error') {
      derecha = `<span style="font-size:10px;color:#dc2626">${it.error || 'error'}</span>`;
    } else if (it.estado === 'need-sociedad') {
      const cands = it.candidatos || [];
      const hint = it.sociedadHint ? ` (hint: ${it.sociedadHint})` : '';
      derecha = `<select id="up-ext-soc-${i}" style="padding:3px 5px;font-size:10px;border:.5px solid var(--border-2);border-radius:4px;background:var(--bg-secondary);color:var(--text)">
          <option value="">— elegir sociedad${hint} —</option>
          ${cands.map((s) => `<option value="${s.id}" ${s.id===it.sociedadHint?'selected':''}>${s.nombre}</option>`).join('')}
        </select>
        <button onclick="upExtRetry(${i})" style="margin-left:6px;padding:3px 8px;font-size:10px;border:none;border-radius:4px;background:#185FA5;color:#fff;cursor:pointer">Reintentar</button>`;
    }
    return `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;margin-bottom:4px;border:.5px solid var(--border-3);border-radius:6px;background:var(--bg-secondary)">
      <span style="font-size:13px;width:18px;text-align:center">${icono}</span>
      <span style="flex:1;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${it.name}">${it.name} <span style="color:var(--text-2)">· ${it.sizeKb} KB</span></span>
      ${derecha}
    </div>`;
  }).join('');
}

async function _upExtRunQueue() {
  upExtRunning = true;
  const items = state._upExt.items;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.estado !== 'pending') continue;
    await _upExtProcessOne(i);
  }
  upExtRunning = false;
  _upExtShowSummary();
  // Refrescar selectores / data si hubo al menos un OK
  if (items.some((it) => it.estado === 'ok')) {
    try {
      const per = await api('/api/v1/bancos/periodos');
      state.periodos = per.periodos || [];
      buildPeriodSelector();
      await reload();
    } catch (e) { console.warn('[up-ext] refresh failed:', e); }
  }
}

async function _upExtProcessOne(idx) {
  const it = state._upExt.items[idx];
  it.estado = 'running';
  _upExtRenderList();
  try {
    const fd = new FormData();
    fd.append('file', it.file);
    if (it.sociedad_id) fd.append('sociedad_id', it.sociedad_id);
    const r = await fetch('/api/v1/bancos/upload-extracto-auto', { method: 'POST', credentials: 'same-origin', body: fd });
    const j = await r.json();
    if (!r.ok) {
      if (j.need_sociedad) {
        it.estado = 'need-sociedad';
        it.candidatos = j.candidates || [];
        it.sociedadHint = j.sociedad_detectada_por_filename || null;
        it.error = j.error || 'falta sociedad';
      } else {
        it.estado = 'error';
        it.error = j.error || 'error';
      }
    } else {
      it.estado = 'ok';
      it.resultado = j;
    }
  } catch (e) {
    it.estado = 'error';
    it.error = e.message || 'red caída';
  }
  _upExtRenderList();
}

async function upExtRetry(idx) {
  const it = state._upExt.items[idx];
  if (!it || it.estado !== 'need-sociedad') return;
  const sel = $(`up-ext-soc-${idx}`);
  const soc = sel?.value;
  if (!soc) { alert('Elegí una sociedad'); return; }
  it.sociedad_id = soc;
  it.estado = 'pending';
  it.candidatos = null;
  await _upExtProcessOne(idx);
  // Si quedan más pending después de éste, _upExtRunQueue ya terminó —
  // levanto un mini-runner solo para este si hace falta. En la práctica
  // como cada Retry se gatilla con click, no hay otros pending.
}

function _upExtShowSummary() {
  const items = state._upExt?.items || [];
  const ok = items.filter((i) => i.estado === 'ok');
  const error = items.filter((i) => i.estado === 'error');
  const need = items.filter((i) => i.estado === 'need-sociedad');
  if (!items.length) return;
  let totalMovs = 0, totalInsertadas = 0, totalDup = 0, totalReglas = 0, totalSkipped = 0;
  for (const i of ok) {
    const r = i.resultado;
    totalMovs += r.total_filas || 0;
    totalInsertadas += r.insertadas || 0;
    totalDup += r.duplicadas || 0;
    totalReglas += r.reglas_db_aplicadas || 0;
    totalSkipped += r.skipped || 0;
  }
  const auto = totalMovs > 0 ? Math.round(100 * totalReglas / totalMovs) : 0;
  const pendientes = Math.max(0, totalMovs - totalReglas);
  const periodos = [...new Set(ok.flatMap((i) => i.resultado.periodos || []))].sort();
  const lines = [];
  lines.push(`<p style="font-size:12px;font-weight:500;margin-bottom:6px">✅ ${ok.length} ${ok.length===1?'archivo procesado':'archivos procesados'}${error.length||need.length?` · ${error.length} con error · ${need.length} pendientes de sociedad`:''}</p>`);
  if (ok.length) {
    lines.push(`<p style="font-size:11px;color:var(--text-2);margin-bottom:4px">${totalMovs.toLocaleString('es-ES')} movimientos parseados · ${totalInsertadas.toLocaleString('es-ES')} insertadas · ${totalDup.toLocaleString('es-ES')} duplicadas · ${totalSkipped} omitidas</p>`);
    lines.push(`<p style="font-size:11px;color:var(--text-2);margin-bottom:4px">${totalReglas.toLocaleString('es-ES')} clasificadas por reglas (${auto}%) · ${pendientes.toLocaleString('es-ES')} pendientes de clasificación manual</p>`);
    if (periodos.length) lines.push(`<p style="font-size:11px;color:var(--text-2);margin-bottom:8px">Períodos: ${periodos.join(', ')}</p>`);
    if (pendientes > 0) {
      lines.push(`<button onclick="window.location.href='/bancos-reglas'" style="padding:6px 12px;font-size:11px;border:none;border-radius:6px;background:#185FA5;color:#fff;cursor:pointer;font-weight:500">→ Ir a Gestionar Reglas</button>`);
    }
  }
  $('up-ext-summary').innerHTML = lines.join('');
  $('up-ext-summary').style.display = '';
}

async function uploadCierres() {
  const f = $('up-tpv-file').files[0];
  const local = $('up-tpv-local').value;
  const msg = $('up-tpv-msg');
  msg.textContent = '';
  if (!f) { msg.textContent = 'Elegí un archivo'; msg.style.color = '#dc2626'; return; }
  msg.textContent = 'Subiendo y procesando…'; msg.style.color = 'var(--text-2)';
  try {
    const fd = new FormData();
    fd.append('file', f);
    if (local) fd.append('local_id', local);
    const r = await fetch('/api/v1/bancos/upload-cierres-tpv', { method: 'POST', credentials: 'same-origin', body: fd });
    const j = await r.json();
    if (!r.ok) { msg.textContent = j.error || 'Error'; msg.style.color = '#dc2626'; return; }
    msg.innerHTML = `<span style="color:#16a34a">✓ ${j.insertados} cierres (${j.duplicados} dup, ${j.skipped} omit).</span> Local: ${j.local_id} (${j.sociedad_id}). Períodos: ${j.periodos.join(', ')}`;
    const per = await api('/api/v1/bancos/periodos'); state.periodos = per.periodos || []; buildPeriodSelector();
    await reload();
  } catch (e) {
    msg.textContent = e.message; msg.style.color = '#dc2626';
  }
}

async function logout() {
  await fetch('/api/v1/auth/logout', { method: 'POST', credentials: 'same-origin' });
  location.href = '/login';
}

// ─── Sidebar de detalle de grupo + reclasificación (Mejora A) ────────
// Lista de categorías para el dropdown de reclasificación de movs.
// Se carga dinámicamente desde /api/v1/bancos/categorias-codigos al abrir
// el sidebar — así las cats nuevas creadas desde "⚙️ Gestionar categorías"
// aparecen automáticamente sin tocar código. El array de abajo es el
// fallback inicial (si el endpoint todavía no respondió, ej. al primer
// click). _refreshCategoriasTodas() repuebla cuando llega la respuesta.
let CATEGORIAS_TODAS = [
  'IMPUESTOS','SS_LABORAL','NOMINAS','ALQUILER',
  'SUMINISTROS_LUZ','SUMINISTROS_GAS','SUMINISTROS_AGUA','TELECOMUNICACIONES',
  'PROVEEDOR_CARNES','PROVEEDOR_PANADERIA','PROVEEDOR_FRITAS','PROVEEDOR_LACTEOS',
  'PROVEEDOR_ACEITES','PROVEEDOR_BEBIDAS','PROVEEDOR_MAKRO','PROVEEDOR_LIMPIEZA',
  'PROVEEDOR_PACKAGING','PROVEEDOR_OTROS',
  'MANTENIMIENTO','SEGUROS','FINANCIERO','INTRAGRUPO','OTROS',
  'PUBLICIDAD','SERVICIOS_PROF','DELIVERY',
];

// Refresca el array CATEGORIAS_TODAS desde ab_categorias. Fire-and-forget
// (no bloquea el render del sidebar). Se llama cada vez que se abre el
// sidebar de detalle del grupo para garantizar dropdown actualizado tras
// crear/editar cats en "⚙️ Gestionar categorías".
async function _refreshCategoriasTodas() {
  try {
    const j = await api('/api/v1/bancos/categorias-codigos');
    const cats = (j.categorias || [])
      .map((c) => (typeof c === 'string' ? c : c.codigo))
      .filter(Boolean);
    if (cats.length > 0) CATEGORIAS_TODAS = cats;
  } catch (e) {
    console.warn('[bancos] no se pudo refrescar CATEGORIAS_TODAS:', e.message);
    // mantiene el array previo (último válido o el fallback inicial)
  }
}

function buildGrupoDetalleQuery() {
  const params = new URLSearchParams();
  const soc = $('prov-sociedad')?.value;
  if (soc) params.set('sociedad_id', soc);
  // Período del selector GLOBAL (modo único o rango).
  const p = getPeriodoActivo();
  if (p.modo === 'rango') {
    if (p.desde && p.hasta && p.desde === p.hasta) params.set('periodo', p.desde);
    else {
      if (p.desde) params.set('periodo_desde', p.desde);
      if (p.hasta) params.set('periodo_hasta', p.hasta);
    }
  } else if (p.periodo) {
    params.set('periodo', p.periodo);
  }
  return params;
}

// Sidebar de detalle de CATEGORÍA — drill-down de DOS niveles dentro del
// mismo sidebar:
//
//   Nivel 1 (lista de proveedores): al abrir el sidebar desde un slice del
//     donut. Cada proveedor de la categoría aparece como fila clickeable
//     con su total€ y # de movs. Default — vista siempre que se entra.
//
//   Nivel 2 (movimientos de un proveedor): al click en una fila de Nivel 1.
//     Lista los movs individuales de ese proveedor dentro de la categoría.
//     Botón "← Volver" regresa a Nivel 1 SIN cerrar el sidebar.
//
// Reemplaza la vista anterior que mostraba todos los movs planos sin
// agrupar — para categorías con muchos proveedores había que scrollear
// mezclando todos los conceptos. La agrupación por proveedor + drill
// inline corresponde 1:1 al modelo mental "categoría → proveedor → movs".
//
// Datos: el endpoint /categoria-movimientos devuelve movs[] con
// proveedor_resuelto ya aplicado al pipeline (matchRegla → normalizar).
// Agrupamos en frontend para evitar un round-trip extra y para reusar
// la misma lista de movs en Nivel 2 sin refetch al hacer drill.
//
// Caso especial: codigo === '__GASTOS_DIRECCION_FUSE__' redirige a
// openProvSidebar('Gastos Dirección') que ya maneja la fusión (lista
// conceptos detallados con admin/socio puede_drilldown; el resto recibe
// 403 — no debería llegar acá porque la UI bloquea el click).
async function openCategoriaSidebar(codigo) {
  if (!codigo) return;
  const cat = (state.prov.por_categoria || []).find((c) => c.codigo === codigo);
  if (!cat) return;

  const nombreLegible = cat.nombre_display && cat.nombre_display.toUpperCase() !== (cat.codigo || '').toUpperCase()
    ? cat.nombre_display.toUpperCase() : null;

  $('prov-sb-title').textContent = (cat.codigo || '').toUpperCase();
  $('prov-sb-meta').textContent = `${nombreLegible ? nombreLegible + ' · ' : ''}Cargando movimientos…`;
  $('prov-sb-body').innerHTML = `<p style="font-size:11px;color:var(--text-2);padding:8px">Cargando…</p>`;
  $('prov-sidebar-backdrop').style.display = '';
  $('prov-sidebar').style.display = '';

  try {
    const params = buildGrupoDetalleQuery();
    params.set('codigo', codigo);
    const j = await api('/api/v1/bancos/categoria-movimientos?' + params.toString());
    const movs = j.movimientos || [];
    const totBackend = j.total || 0;

    // Agrupar por proveedor_resuelto (Nivel 1). Orden por total€ desc.
    // Fuente del bug histórico "muestra Sin proveedores / solo uno": la
    // vista anterior listaba todos los movs y el proveedor solo aparecía
    // como texto repetido por fila. Cuando todos los movs eran del mismo
    // prov se "veía" como uno solo; cuando eran muchos se mezclaban sin
    // estructura. El Nivel 1 agrupado lo deja explícito.
    const porProv = new Map();
    for (const m of movs) {
      const p = m.proveedor_resuelto || '—';
      if (!porProv.has(p)) porProv.set(p, { nombre: p, total: 0, n: 0 });
      const x = porProv.get(p);
      x.total += Math.abs(m.importe);
      x.n += 1;
    }
    const proveedores = [...porProv.values()].sort((a, b) => b.total - a.total);

    // Cache: catSidebarVerProveedor / catSidebarVolver alternan entre
    // Nivel 1 y Nivel 2 sin refetch.
    state._cat = { codigo, nombreLegible, movs, totBackend, proveedores, vista: 'proveedores', proveedor: null };
    _renderCatNivel1();
  } catch (e) {
    $('prov-sb-meta').textContent = `${nombreLegible ? nombreLegible + ' · ' : ''}Error`;
    $('prov-sb-body').innerHTML = `<p style="font-size:11px;color:#dc2626;padding:8px">Error cargando movimientos: ${e.message}</p>`;
  }
}

// Nivel 1 — lista de proveedores de la categoría, agrupados con totales.
function _renderCatNivel1() {
  const c = state._cat;
  if (!c) return;
  const pct = state.prov.total > 0 ? (c.totBackend / state.prov.total * 100).toFixed(1) : '0';
  const nProvs = c.proveedores.length;
  const nMovs = c.movs.length;
  $('prov-sb-title').textContent = (c.codigo || '').toUpperCase();
  $('prov-sb-meta').textContent = `${c.nombreLegible ? c.nombreLegible + ' · ' : ''}${eur2(c.totBackend)} · ${nProvs} proveedor${nProvs === 1 ? '' : 'es'} · ${nMovs} mvs · ${pct}% del gasto filtrado`;

  if (!nProvs) {
    $('prov-sb-body').innerHTML = `
      <div style="padding:30px 12px;text-align:center;color:var(--text-2);font-size:12px">
        <p style="font-size:24px;margin-bottom:6px">📭</p>
        <p>Sin movimientos en "<strong>${c.codigo}</strong>" en este filtro.</p>
      </div>`;
    return;
  }
  $('prov-sb-body').innerHTML = `
    <p style="font-size:11px;color:var(--text-2);margin-bottom:10px">Click en un proveedor para ver sus movimientos individuales.</p>
    ${c.proveedores.map((p) => {
      const provEsc = p.nombre.replace(/"/g, '&quot;');
      const provJs = p.nombre.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      return `<div onclick="catSidebarVerProveedor('${provJs}')" style="display:flex;align-items:center;gap:10px;padding:10px 12px;margin-bottom:6px;border:.5px solid var(--border-3);border-radius:8px;background:var(--bg-secondary);cursor:pointer" onmouseover="this.style.background='var(--bg-tertiary,#1a1a1a)'" onmouseout="this.style.background='var(--bg-secondary)'">
        <div style="flex:1;min-width:0">
          <p style="font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${provEsc}">${p.nombre}</p>
          <p style="font-size:10px;color:var(--text-2);margin-top:2px">${p.n} movimiento${p.n === 1 ? '' : 's'}</p>
        </div>
        <p style="font-size:13px;font-weight:500;color:#dc2626;text-align:right;white-space:nowrap;margin:0">${eur(p.total)}</p>
        <span style="color:var(--text-2);font-size:14px" aria-hidden="true">→</span>
      </div>`;
    }).join('')}
  `;
}

// Switch a Nivel 2 — movs individuales del proveedor seleccionado.
function catSidebarVerProveedor(proveedor) {
  const c = state._cat;
  if (!c) return;
  c.vista = 'movimientos';
  c.proveedor = proveedor;
  _renderCatNivel2();
}

function _renderCatNivel2() {
  const c = state._cat;
  if (!c || !c.proveedor) return;
  const prov = c.proveedor;
  const movsProv = c.movs.filter((m) => (m.proveedor_resuelto || '—') === prov);
  const totProv = movsProv.reduce((s, m) => s + Math.abs(m.importe), 0);
  const provJs = prov.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  $('prov-sb-title').textContent = prov;
  $('prov-sb-meta').textContent = `${eur2(totProv)} · ${movsProv.length} movimiento${movsProv.length === 1 ? '' : 's'}`;

  $('prov-sb-body').innerHTML = `
    <div style="margin-bottom:14px">
      <button onclick="catSidebarVolver()" style="background:transparent;border:.5px solid var(--border-2);color:var(--text);padding:5px 10px;font-size:11px;border-radius:6px;cursor:pointer">← Volver a ${(c.codigo || '').toUpperCase()}</button>
    </div>
    ${movsProv.map((m) => {
      const conceptoEsc = (m.concepto || '').replace(/"/g, '&quot;');
      const sociedadLabel = m.sociedad_id || '';
      const viaReglaBadge = m.via_regla ? `<span style="font-size:9px;color:var(--text-2);background:var(--bg-tertiary,#1a1a1a);padding:1px 5px;border-radius:8px" title="Asignado por regla #${m.regla_id}">regla</span>` : '';
      return `<div style="padding:8px 10px;margin-bottom:6px;border:.5px solid var(--border-3);border-radius:8px;background:var(--bg-secondary)">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <div style="flex:1;min-width:0">
            <p style="font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${conceptoEsc}">${m.concepto}</p>
            <p style="font-size:10px;color:var(--text-2);margin-top:2px">${m.fecha} · ${sociedadLabel} ${viaReglaBadge}</p>
          </div>
          <span style="font-size:13px;font-weight:500;color:#dc2626;white-space:nowrap">${eur(Math.abs(m.importe))}</span>
        </div>
        <button onclick="openProvSidebar('${provJs}')" style="background:transparent;border:.5px solid var(--border-3);color:var(--text-2);padding:3px 8px;font-size:10px;border-radius:5px;cursor:pointer">✏️ Reclasificar</button>
      </div>`;
    }).join('')}
  `;
}

// Botón "← Volver" — regresa a Nivel 1 SIN cerrar el sidebar.
function catSidebarVolver() {
  if (!state._cat) return;
  state._cat.vista = 'proveedores';
  state._cat.proveedor = null;
  _renderCatNivel1();
}

async function openProvSidebar(grupo) {
  if (!grupo) return;
  $('prov-sb-title').textContent = grupo;
  $('prov-sb-meta').textContent = 'Cargando…';
  $('prov-sb-body').innerHTML = '';
  $('prov-sidebar-backdrop').style.display = '';
  $('prov-sidebar').style.display = '';
  state._sbFilterQ = '';
  // Refrescar cats del dropdown de reclasif en background (fire-and-forget).
  // Garantiza que cats creadas/renombradas desde "⚙️ Gestionar categorías"
  // aparezcan en el <select> antes de que el usuario lo abra.
  _refreshCategoriasTodas();
  try {
    const params = buildGrupoDetalleQuery();
    params.set('grupo', grupo);
    const j = await api('/api/v1/bancos/grupo-detalle?' + params.toString());
    state._sbData = j;
    const tot = j.total || 0;
    const totProvTab = state.prov.total || 1;
    $('prov-sb-meta').textContent = `${eur2(tot)} · ${j.num_conceptos} conceptos · ${((tot/totProvTab)*100).toFixed(1)}% del gasto filtrado`;
    // Layout: search bar (persistente) + summary banner (toggle) + rows.
    // El input se renderiza UNA sola vez aquí; oninput sólo muta rows + banner
    // para no perder foco / posición del cursor al tipear.
    $('prov-sb-body').innerHTML = `
      ${renderProvSearchBar()}
      <div id="prov-sb-filter-summary"></div>
      <div id="prov-sb-rows"></div>
    `;
    renderProvSidebarRows();
  } catch (e) {
    $('prov-sb-meta').textContent = 'Error: ' + e.message;
  }
}

function closeProvSidebar() {
  $('prov-sidebar').style.display = 'none';
  $('prov-sidebar-backdrop').style.display = 'none';
}

// Color de fondo / texto del badge 🏢 por sociedad. Tonos pastel suaves
// para no competir con el resto del sidebar.
const SOCIEDAD_BADGE = {
  hostelero: { bg: '#FEF3C7', fg: '#92400E' }, // ámbar — Grupo Hostelero
  alicante:  { bg: '#DBEAFE', fg: '#1E40AF' }, // azul — Aires Alicante
  smart:     { bg: '#E0E7FF', fg: '#4338CA' }, // índigo — Smart Aires
  murcia:    { bg: '#FCE7F3', fg: '#9D174D' }, // rosa — Aires Murcia
  benidorm:  { bg: '#DCFCE7', fg: '#166534' }, // verde — Aires Benidorm
};

function renderSociedadesBadges(sociedades) {
  if (!sociedades || !sociedades.length) return '';
  return '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px">'
    + sociedades.map((s) => {
        const abbr = SOCIEDAD_ABBR[s.id] || (s.id || '').slice(0, 3).toUpperCase();
        const col = SOCIEDAD_BADGE[s.id] || { bg: 'var(--bg-secondary)', fg: 'var(--text-2)' };
        const totalCorto = eur(s.importe);
        const titulo = `${s.id} · ${eur2(s.importe)}`;
        return `<span title="${titulo}" style="display:inline-flex;align-items:center;gap:3px;background:${col.bg};color:${col.fg};border-radius:10px;padding:1px 7px;font-size:9px;font-weight:600;line-height:1.5">🏢 ${abbr}${sociedades.length > 1 ? ' ' + totalCorto : ''}</span>`;
      }).join('')
    + '</div>';
}

// Buscador del Detalle del Grupo — input persistente arriba del listado.
// Se renderiza UNA vez por apertura del sidebar; el filtrado en vivo sólo
// muta #prov-sb-filter-summary y #prov-sb-rows para preservar foco/cursor.
function renderProvSearchBar() {
  return `
    <div id="prov-sb-search-wrap" style="position:relative;margin-bottom:10px">
      <span aria-hidden="true" style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--text-2);font-size:13px;pointer-events:none">🔍</span>
      <input type="text" id="prov-sb-search"
        placeholder="Buscar por nombre o concepto…"
        autocomplete="off" spellcheck="false"
        oninput="onProvFilterInput(this.value)"
        style="width:100%;padding:6px 32px 6px 30px;border:.5px solid var(--border-2);border-radius:6px;background:var(--bg-secondary);color:var(--text);font-size:12px">
      <button id="prov-sb-search-clear" onclick="clearProvFilter()"
        title="Limpiar búsqueda" aria-label="Limpiar búsqueda"
        style="position:absolute;right:6px;top:50%;transform:translateY(-50%);background:transparent;border:none;color:var(--text-2);cursor:pointer;font-size:16px;line-height:1;padding:2px 6px;display:none">×</button>
    </div>
  `;
}

// Aplica el filtro actual a state._sbData.conceptos. Devuelve las entradas
// con su índice ORIGINAL preservado — los onclick="confirmReclasificar(i)"
// dependen de que `i` mapee al slot exacto en state._sbData.conceptos[i].
// Saltea tombstones (null) que dejan las reclasificaciones previas.
function _filterConceptoEntries() {
  const all = state._sbData?.conceptos || [];
  const q = (state._sbFilterQ || '').trim().toLowerCase();
  const out = [];
  let sum = 0;
  for (let i = 0; i < all.length; i++) {
    const c = all[i];
    if (!c) continue;
    if (q) {
      const nombre = (c.proveedor_canonico || '').toLowerCase();
      const concepto = (c.concepto || '').toLowerCase();
      if (!nombre.includes(q) && !concepto.includes(q)) continue;
    }
    out.push({ c, i });
    sum += +c.total_importe || 0;
  }
  return { entries: out, q, sum };
}

function _escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Actualiza sólo el banner de resumen (sin tocar las filas). Llamado al
// tipear, al limpiar, y después de cada reclasificación para que el conteo
// y la suma queden frescos sin re-renderizar el listado (que cerraría forms
// de reclasif que el usuario pudiera tener abiertos en otras filas).
function renderFilterSummary() {
  const summary = $('prov-sb-filter-summary');
  if (!summary) return;
  const { entries, q, sum } = _filterConceptoEntries();
  if (!q) { summary.innerHTML = ''; return; }
  summary.innerHTML = `
    <div style="background:var(--bg-secondary);border:.5px solid var(--border-3);border-radius:6px;padding:6px 10px;margin-bottom:10px;font-size:11px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
      <span><strong>${entries.length}</strong> ${entries.length === 1 ? 'resultado' : 'resultados'} · <strong>${eur2(sum)}</strong></span>
      <span style="color:var(--text-2);font-size:10px">filtrando por "${_escHtml(q)}"</span>
    </div>
  `;
}

function renderProvSidebarRows() {
  const rows = $('prov-sb-rows');
  if (!rows) return;
  const esBucketMenores = !!state._sbData?.es_bucket_menores;
  const { entries, q } = _filterConceptoEntries();

  // Toggle del botón × del input según haya o no búsqueda activa.
  const clearBtn = $('prov-sb-search-clear');
  if (clearBtn) clearBtn.style.display = q ? '' : 'none';

  renderFilterSummary();

  // Empty state cuando hay búsqueda pero ningún match.
  if (q && entries.length === 0) {
    rows.innerHTML = `
      <div style="padding:30px 12px;text-align:center;color:var(--text-2);font-size:12px">
        <p style="font-size:24px;margin-bottom:6px">🔍</p>
        <p style="margin-bottom:4px">Sin resultados para "<strong>${_escHtml(q)}</strong>"</p>
        <p style="font-size:10px">Probá con otra parte del nombre o concepto, o limpiá la búsqueda.</p>
      </div>
    `;
    return;
  }

  rows.innerHTML = entries.map(({ c, i }) => {
    const conceptoEsc = (c.concepto || '').replace(/"/g, '&quot;');
    // En "Proveedores Menores" cada fila pertenece a un proveedor distinto;
    // mostramos su nombre canónico como pista visual para que el usuario
    // sepa a qué proveedor agrupado pertenece sin tener que adivinar.
    const provChip = (esBucketMenores && c.proveedor_canonico && c.proveedor_canonico !== state._sbData.grupo)
      ? `<span style="display:inline-block;background:#EEF2FF;color:#3730A3;border-radius:10px;padding:1px 7px;font-size:9px;font-weight:600;margin-left:4px">${c.proveedor_canonico}</span>`
      : '';
    return `<div data-row="${i}" style="border:.5px solid var(--border-3);border-radius:8px;padding:8px 10px;margin-bottom:8px">
      <div style="display:flex;gap:8px;align-items:flex-start">
        <div style="flex:1;min-width:0">
          <p style="font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${conceptoEsc}">${c.concepto}${provChip}</p>
          <p style="font-size:10px;color:var(--text-2);margin-top:2px">
            <strong style="color:#dc2626">${eur2(c.total_importe)}</strong> · ${c.num_transacciones} tx · cat. <code>${c.categoria_actual || '—'}</code>${c.ultima_fecha ? ' · últ. ' + c.ultima_fecha : ''}
          </p>
          ${renderSociedadesBadges(c.sociedades)}
        </div>
        <button onclick="toggleReclasificar(${i})" id="rc-btn-${i}" style="padding:5px 10px;border:.5px solid var(--border-2);border-radius:6px;background:transparent;color:var(--text);cursor:pointer;font-size:11px;flex-shrink:0">Reclasificar</button>
      </div>
      <div id="rc-form-${i}" style="display:none;margin-top:10px;padding-top:10px;border-top:.5px dashed var(--border-3)">
        <div style="display:grid;grid-template-columns:140px 1fr;gap:6px 10px;align-items:center;font-size:11px">
          <label>Categoría</label>
          <select id="rc-cat-${i}" style="padding:5px 8px;border:.5px solid var(--border-2);border-radius:6px;background:var(--bg-secondary);color:var(--text);font-size:11px">
            ${CATEGORIAS_TODAS.map((cat) => `<option value="${cat}" ${cat === c.categoria_actual ? 'selected' : ''}>${cat}</option>`).join('')}
          </select>
          <label>Nombre normalizado</label>
          <div class="rc-combo" style="position:relative">
            <input type="text" id="rc-name-${i}" autocomplete="off"
              value="${(state._sbData?.grupo || '').replace(/"/g, '&quot;')}"
              placeholder="Click para ver lista o escribí para filtrar / crear"
              onfocus="rcOpenList(${i})"
              oninput="rcFilterList(${i})"
              onkeydown="rcListKey(event, ${i})"
              onblur="setTimeout(() => rcCloseList(${i}), 180)"
              style="width:100%;padding:5px 28px 5px 8px;border:.5px solid var(--border-2);border-radius:6px;background:var(--bg-secondary);color:var(--text);font-size:11px">
            <span style="position:absolute;right:8px;top:50%;transform:translateY(-50%);pointer-events:none;color:var(--text-2);font-size:10px">▾</span>
            <div id="rc-list-${i}" class="rc-list" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:50;max-height:220px;overflow-y:auto;background:var(--bg-primary);border:.5px solid var(--border-2);border-radius:6px;box-shadow:0 6px 16px rgba(0,0,0,.18);margin-top:2px"></div>
            <p id="rc-name-hint-${i}" style="font-size:9px;color:var(--text-2);margin-top:2px">Todos los grupos existentes (cualquier categoría) · si el nombre que escribís no está, se crea como slice nuevo en el donut</p>
          </div>
          <label style="grid-column:1/-1;display:flex;align-items:center;gap:6px;cursor:pointer">
            <input type="checkbox" id="rc-rule-${i}" checked>
            <span>Aplicar a futuros extractos (guardar regla)</span>
          </label>
        </div>
        <div id="rc-feedback-${i}" style="display:none;margin-top:8px;font-size:11px;padding:6px 10px;border-radius:6px"></div>
        <div style="display:flex;gap:6px;margin-top:10px;justify-content:flex-end">
          <button onclick="toggleReclasificar(${i})" style="padding:5px 10px;border:.5px solid var(--border-2);border-radius:6px;background:transparent;color:var(--text);cursor:pointer;font-size:11px">Cancelar</button>
          <button onclick="confirmReclasificar(${i})" style="padding:5px 12px;border:none;border-radius:6px;background:#185FA5;color:#fff;cursor:pointer;font-size:11px;font-weight:500">Confirmar</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

function onProvFilterInput(val) {
  state._sbFilterQ = val;
  renderProvSidebarRows();
}

function clearProvFilter() {
  state._sbFilterQ = '';
  const input = $('prov-sb-search');
  if (input) { input.value = ''; input.focus(); }
  renderProvSidebarRows();
}

function toggleReclasificar(i) {
  const form = $(`rc-form-${i}`);
  if (!form) return;
  const open = form.style.display !== 'none';
  form.style.display = open ? 'none' : '';
  const btn = $(`rc-btn-${i}`);
  if (btn) btn.textContent = open ? 'Reclasificar' : 'Cerrar';
  // Al abrir: poblar el datalist con TODOS los nombres normalizados
  // existentes (cualquier categoría) ordenados alfabéticamente.
  if (!open) rcRefreshNombres(i);
}

// Cache de la lista de nombres normalizados — keyed por los filtros
// activos del donut (sociedad + período). Si el usuario cambia el filtro
// y vuelve a abrir el sidebar, se refetch automáticamente porque la key
// cambia. Se invalida al confirmar una reclasificación.
let _rcNombresAllCache = null;
let _rcNombresCacheKey = null;

function _rcFiltrosActivos() {
  // Refleja los filtros activos del donut /proveedores (mismos selectores
  // que usa loadProvRanking). Si el usuario está mirando "Sin Elche /
  // Abr 2026", el dropdown sólo debe ofrecer grupos que aparecen en ese
  // corte — no la lista global de ~500.
  const soc = $('prov-sociedad')?.value || '';
  const p = getPeriodoActivo();
  const params = new URLSearchParams();
  if (soc) params.set('sociedad_id', soc);
  let keyPeriodo;
  if (p.modo === 'rango') {
    const d = p.desde || '', h = p.hasta || '';
    if (d && h && d === h) params.set('periodo', d);
    else {
      if (d) params.set('periodo_desde', d);
      if (h) params.set('periodo_hasta', h);
    }
    keyPeriodo = `${d}|${h}`;
  } else {
    if (p.periodo) params.set('periodo', p.periodo);
    keyPeriodo = `u:${p.periodo || ''}`;
  }
  params.set('limit', '500');
  return { qs: params.toString(), key: `${soc}|${keyPeriodo}` };
}

async function rcRefreshNombres(i) {
  const hint = $(`rc-name-hint-${i}`);
  const { qs, key } = _rcFiltrosActivos();
  if (!_rcNombresAllCache || _rcNombresCacheKey !== key) {
    try {
      const j = await api('/api/v1/bancos/proveedores-normalizados?' + qs);
      _rcNombresAllCache = j.proveedores || [];
      _rcNombresCacheKey = key;
    } catch (e) {
      _rcNombresAllCache = [];
      _rcNombresCacheKey = key;
    }
  }
  if (hint) {
    hint.textContent = _rcNombresAllCache.length
      ? `${_rcNombresAllCache.length} grupos en el filtro activo · escribí para filtrar; si no está, se crea como slice nuevo`
      : 'Sin grupos en este filtro · escribí uno nuevo';
  }
  // Pre-popular la lista visible (cerrada hasta el focus)
  _rcRenderList(i, '');
}

// Render del dropdown custom: lista filtrada + opción "+ Crear nuevo".
function _rcRenderList(i, q) {
  const list = $(`rc-list-${i}`);
  if (!list) return;
  const all = _rcNombresAllCache || [];
  const qNorm = (q || '').trim().toLowerCase();
  const matches = qNorm
    ? all.filter((r) => (r.nombre || '').toLowerCase().includes(qNorm))
    : [...all];
  // Orden: si hay query, los que arrancan con la query primero; luego alfabético.
  matches.sort((a, b) => {
    if (qNorm) {
      const ax = (a.nombre || '').toLowerCase().startsWith(qNorm) ? 0 : 1;
      const bx = (b.nombre || '').toLowerCase().startsWith(qNorm) ? 0 : 1;
      if (ax !== bx) return ax - bx;
    }
    return (a.nombre || '').localeCompare(b.nombre || '');
  });
  const cap = matches.slice(0, 80);
  const exacto = qNorm && all.some((r) => (r.nombre || '').toLowerCase() === qNorm);
  const rows = cap.map((r) => {
    const nombreEsc = (r.nombre || '').replace(/"/g, '&quot;');
    const esFusion = !!r._es_grupo_fusion;
    // No mostramos montos en el dropdown — el rol gerente no debe ver
    // cuánto se gastó con cada proveedor desde aquí. Esa info está en
    // el donut/tabla principal. Sólo dejamos el badge "slice fusionado"
    // para distinguir Gastos Dirección del resto.
    const badge = esFusion
      ? '<span style="font-size:9px;font-weight:500;color:#7E22CE;background:#F3E8FF;padding:1px 6px;border-radius:999px;flex-shrink:0">slice fusionado</span>'
      : '';
    const bg = esFusion ? 'background:#FBF8FF;' : '';
    return `<div class="rc-list-item" data-val="${nombreEsc}"
        onmousedown="event.preventDefault()" onclick="rcPickList(${i}, this.dataset.val)"
        style="${bg}padding:6px 10px;cursor:pointer;font-size:11px;border-bottom:.5px solid var(--border-3);display:flex;justify-content:space-between;align-items:center;gap:8px">
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap${esFusion ? ';font-weight:500;color:#7E22CE' : ''}">${r.nombre}</span>
      ${badge}
    </div>`;
  }).join('');
  let createBlock = '';
  if (qNorm && !exacto) {
    const valEsc = q.replace(/"/g, '&quot;');
    createBlock = `<div class="rc-list-item rc-list-create" data-val="${valEsc}"
        onmousedown="event.preventDefault()" onclick="rcPickList(${i}, this.dataset.val)"
        style="padding:7px 10px;cursor:pointer;font-size:11px;color:#185FA5;font-weight:500;background:var(--bg-secondary);border-top:.5px solid var(--border-2)">
      + Crear nuevo: <span style="text-decoration:underline">${q}</span>
    </div>`;
  }
  const empty = (!cap.length && !createBlock)
    ? '<div style="padding:8px 10px;font-size:11px;color:var(--text-2);text-align:center">Sin grupos</div>' : '';
  list.innerHTML = rows + empty + createBlock;
  // Truncated indicator
  if (matches.length > cap.length) {
    list.insertAdjacentHTML('beforeend',
      `<div style="padding:5px 10px;font-size:9px;color:var(--text-2);text-align:center;border-top:.5px dashed var(--border-3)">+${matches.length - cap.length} más · refiná la búsqueda</div>`);
  }
}

window.rcOpenList = function (i) {
  // Si todavía no cargamos los nombres, los traemos.
  if (!_rcNombresAllCache) rcRefreshNombres(i);
  else _rcRenderList(i, $(`rc-name-${i}`)?.value || '');
  const list = $(`rc-list-${i}`);
  if (list) list.style.display = '';
};

window.rcCloseList = function (i) {
  const list = $(`rc-list-${i}`);
  if (list) list.style.display = 'none';
};

window.rcFilterList = function (i) {
  const q = $(`rc-name-${i}`)?.value || '';
  _rcRenderList(i, q);
  const list = $(`rc-list-${i}`);
  if (list) list.style.display = '';
};

window.rcPickList = function (i, val) {
  const inp = $(`rc-name-${i}`);
  if (inp) inp.value = val;
  // Si el usuario eligió el slice fusionado "Gastos Dirección", forzamos
  // la categoría a GASTOS_DIRECCION en el <select> para que el feedback
  // sea coherente con lo que va a guardar el backend (que también lo
  // fuerza por su cuenta como defense in depth).
  if (val === 'Gastos Dirección') {
    const cat = $(`rc-cat-${i}`);
    if (cat) {
      const opt = [...cat.options].find((o) => o.value === 'GASTOS_DIRECCION');
      if (opt) cat.value = 'GASTOS_DIRECCION';
    }
  }
  rcCloseList(i);
  if (inp) inp.focus();
};

window.rcListKey = function (ev, i) {
  if (ev.key === 'Escape') { rcCloseList(i); ev.target.blur(); }
  else if (ev.key === 'Enter') {
    // Si hay un único match → pickearlo
    const list = $(`rc-list-${i}`);
    if (!list || list.style.display === 'none') return;
    const items = list.querySelectorAll('.rc-list-item');
    if (items.length === 1) {
      ev.preventDefault();
      rcPickList(i, items[0].dataset.val);
    }
  }
};

function _setRcFeedback(i, ok, html) {
  const el = $(`rc-feedback-${i}`);
  if (!el) return;
  el.style.display = '';
  el.style.background = ok ? '#DCFCE7' : '#FCE7E7';
  el.style.color = ok ? '#166534' : '#991B1B';
  el.innerHTML = html;
}

// Anima fade-out + collapse de una fila del sidebar para que las siguientes
// suban suavemente sin saltar. 300ms simultáneos sobre opacity y dimensiones.
function _animateRowOut(row, onDone) {
  if (!row) { onDone && onDone(); return; }
  // Lock current height para que la transición a 0 funcione (height:auto no anima).
  const h = row.offsetHeight;
  row.style.overflow = 'hidden';
  row.style.height = h + 'px';
  // Forzar reflow antes de aplicar la transición — sino el browser
  // colapsa start/end en el mismo frame y no hay animación visible.
  // eslint-disable-next-line no-unused-expressions
  row.offsetHeight;
  row.style.transition = 'opacity 300ms ease, height 300ms ease, margin 300ms ease, padding 300ms ease, border-width 300ms ease';
  row.style.opacity = '0';
  row.style.height = '0';
  row.style.marginTop = '0';
  row.style.marginBottom = '0';
  row.style.paddingTop = '0';
  row.style.paddingBottom = '0';
  row.style.borderWidth = '0';
  setTimeout(() => {
    row.remove();
    onDone && onDone();
  }, 320);
}

async function confirmReclasificar(i) {
  const conceptoEntry = state._sbData?.conceptos?.[i];
  const concepto = conceptoEntry?.concepto;
  if (!concepto) return;
  const categoria_nueva = $(`rc-cat-${i}`)?.value;
  const proveedor_nuevo = $(`rc-name-${i}`)?.value?.trim();
  const guardar_regla = !!$(`rc-rule-${i}`)?.checked;
  if (!categoria_nueva || !proveedor_nuevo) {
    _setRcFeedback(i, false, 'Categoría y nombre son requeridos.');
    return;
  }
  const grupoOriginal = state._sbData?.grupo || '';
  try {
    const j = await api('/api/v1/bancos/reclasificar', {
      method: 'POST',
      body: JSON.stringify({ concepto, categoria_nueva, proveedor_nuevo, guardar_regla }),
    });
    Api.pill(`Reclasificadas: ${j.affected}` + (j.regla_id ? ' · regla creada' : ''));
    // Invalidar cache porque el set de nombres normalizados cambió.
    _rcNombresAllCache = null;
    _rcNombresCacheKey = null;

    // Refresh donut + ranking en background (no await). El sidebar NO se
    // re-renderiza para preservar scroll, posición y filtros: sólo se ajusta
    // la fila reclasificada in-place (fade-out si el ítem cambió de grupo,
    // update de categoría si se quedó en el mismo).
    loadProvRanking().catch((err) => console.warn('[reclasif] donut refresh', err));

    const itemMovedOut = (proveedor_nuevo !== grupoOriginal);
    const row = document.querySelector(`#prov-sb-body [data-row="${i}"]`);

    if (itemMovedOut) {
      // El concepto salió del grupo actual: fade-out + collapse y remover
      // del DOM. Los demás suben para ocupar el espacio sin saltar.
      const importeRemovido = +conceptoEntry.total_importe || 0;
      // Tombstone: ponemos null en el slot sin splice para preservar los
      // índices de los demás conceptos (los onclick siguen apuntando bien).
      state._sbData.conceptos[i] = null;
      state._sbData.total = (state._sbData.total || 0) - importeRemovido;
      state._sbData.num_conceptos = Math.max(0, (state._sbData.num_conceptos || 1) - 1);
      // Actualizar meta line del sidebar con los nuevos totales.
      const totProvTab = state.prov.total || 1;
      const meta = $('prov-sb-meta');
      if (meta) {
        const pct = ((state._sbData.total / totProvTab) * 100).toFixed(1);
        meta.textContent = `${eur2(state._sbData.total)} · ${state._sbData.num_conceptos} conceptos · ${pct}% del gasto filtrado`;
      }
      // Tras la animación, refrescar el banner de búsqueda (si hay filtro
      // activo, el count/sum debe restar el ítem que acaba de salir).
      _animateRowOut(row, renderFilterSummary);
    } else {
      // El concepto se queda en el grupo (cambió sólo la categoría):
      // refrescar in-place el chip de categoría y cerrar el form, sin
      // re-renderizar nada más.
      conceptoEntry.categoria_actual = categoria_nueva;
      if (row) {
        const codeEl = row.querySelector('code');
        if (codeEl) codeEl.textContent = categoria_nueva;
      }
      const nPer = (j.periodos_afectados || []).length;
      const periodosTxt = nPer > 0
        ? `${j.affected} movimiento${j.affected === 1 ? '' : 's'} actualizado${j.affected === 1 ? '' : 's'} en ${nPer === 1 ? 'el período ' + j.periodos_afectados[0] : `${nPer} períodos (${j.periodos_afectados[0]} … ${j.periodos_afectados[nPer - 1]})`}`
        : `${j.affected} movimiento${j.affected === 1 ? '' : 's'} actualizado${j.affected === 1 ? '' : 's'}`;
      const reglaMsg = (guardar_regla && j.regla_id) ? ' Regla guardada para futuros extractos.' : '';
      _setRcFeedback(i, true, `✓ Categoría actualizada a <code>${categoria_nueva}</code>. ${periodosTxt}.${reglaMsg}`);
      // Cerrar form de reclasificación tras un breve momento para que el
      // usuario vea el feedback verde.
      setTimeout(() => {
        const form = $(`rc-form-${i}`);
        if (form && form.style.display !== 'none') toggleReclasificar(i);
      }, 1200);
    }
  } catch (e) {
    _setRcFeedback(i, false, '✗ Error: ' + e.message);
    Api.pill('Error: ' + e.message, true);
  }
}

// ─── Gestión "Gastos Dirección" (admin/socio) ─────────────────────────
// Reusa el sidebar prov-sidebar pero con contenido propio: lista de
// proveedores en cada categoría sensible, con botones Quitar/Agregar.

async function openGdManage() {
  if (!rolEsAdmin()) return;
  $('prov-sb-title').textContent = '⚙ Gestionar Gastos Dirección';
  $('prov-sb-meta').textContent = 'Cargando…';
  $('prov-sb-body').innerHTML = '';
  $('prov-sidebar-backdrop').style.display = '';
  $('prov-sidebar').style.display = '';
  await reloadGdManage();
}

async function reloadGdManage() {
  try {
    const j = await api('/api/v1/bancos/gastos-direccion/composicion');
    state._gdData = j;
    const tot = j.total_fusionado || 0;
    $('prov-sb-meta').textContent = `${eur2(tot)} · ${j.n_proveedores} proveedores fusionados · categorías default: ${j.categorias_default.join(', ')}`;
    renderGdManageBody(j);
  } catch (e) {
    $('prov-sb-meta').textContent = 'Error: ' + e.message;
  }
}

function renderGdManageBody(j) {
  const body = $('prov-sb-body');
  let html = '';

  // Sección por categoría (default)
  for (const cat of j.categorias_default) {
    const provs = j.por_categoria[cat] || [];
    html += `<div style="margin-bottom:14px">
      <p style="font-size:12px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">${cat} <span style="color:var(--text-2);font-weight:400;text-transform:none;letter-spacing:0">(${provs.length})</span></p>`;
    if (!provs.length) {
      html += `<p style="font-size:11px;color:var(--text-2);padding-left:8px">Sin proveedores en esta categoría.</p>`;
    } else {
      html += provs.map((p) => _renderGdRow(p, true)).join('');
    }
    html += `</div>`;
  }

  // Sección incluidos vía override (categoría no-default)
  const extras = j.por_categoria.__INCLUIDOS_EXTRA__ || [];
  if (extras.length) {
    html += `<div style="margin-bottom:14px;padding:8px 10px;background:#EEF2FF;border-radius:8px;border:.5px solid #C7D2FE">
      <p style="font-size:12px;font-weight:600;color:#3730A3;margin-bottom:6px">+ Incluidos vía override (${extras.length})</p>`;
    html += extras.map((p) => _renderGdRow(p, true)).join('');
    html += `</div>`;
  }

  // Sección excluidos vía override
  const exc = j.excluidos_via_override || [];
  if (exc.length) {
    html += `<div style="margin-bottom:14px;padding:8px 10px;background:#FEF2F2;border-radius:8px;border:.5px solid #FECACA">
      <p style="font-size:12px;font-weight:600;color:#991B1B;margin-bottom:6px">− Excluidos vía override (${exc.length})</p>
      <p style="font-size:10px;color:var(--text-2);margin-bottom:6px">Estos proveedores normalmente serían parte del slice (categoría sensible) pero fueron excluidos por un override.</p>`;
    html += exc.map((p) => _renderGdRow(p, false)).join('');
    html += `</div>`;
  }

  // Sección agregar proveedor
  html += `<div style="margin-top:18px;padding-top:14px;border-top:.5px dashed var(--border-3)">
    <p style="font-size:12px;font-weight:600;margin-bottom:6px">Agregar proveedor a Gastos Dirección</p>
    <p style="font-size:10px;color:var(--text-2);margin-bottom:8px">Movés un proveedor de OTRA categoría al grupo protegido. Quedará oculto para roles no-admin.</p>
    <div style="display:flex;gap:6px;align-items:center">
      <input type="text" id="gd-add-input" autocomplete="off" list="gd-add-list" placeholder="Empezá a escribir el nombre canónico…" style="flex:1;padding:6px 10px;border:.5px solid var(--border-2);border-radius:6px;background:var(--bg-secondary);color:var(--text);font-size:11px">
      <datalist id="gd-add-list"></datalist>
      <button onclick="gdAddProveedor()" style="padding:6px 12px;border:none;border-radius:6px;background:#185FA5;color:#fff;cursor:pointer;font-size:11px;font-weight:500">Incluir</button>
    </div>
    <p id="gd-add-hint" style="font-size:9px;color:var(--text-2);margin-top:4px">—</p>
  </div>`;

  body.innerHTML = html;
  _populateGdAddDatalist();
}

function _renderGdRow(p, esActivo) {
  const ovChip = p.override
    ? `<span style="font-size:9px;padding:1px 6px;border-radius:8px;background:${p.override === 'include' ? '#DBEAFE' : '#FEE2E2'};color:${p.override === 'include' ? '#1E40AF' : '#991B1B'};margin-left:4px">${p.override}</span>`
    : '';
  const nameEsc = (p.proveedor || '').replace(/'/g, "\\'");
  const fechaTxt = p.ultima_fecha ? ` · últ. ${p.ultima_fecha}` : '';
  let actionBtn = '';
  if (esActivo) {
    // El proveedor está en el grupo (default o include). El botón Quitar
    // crea/actualiza un override 'exclude' (si está por default) o borra
    // el override 'include' (si fue agregado manualmente).
    if (p.override === 'include') {
      actionBtn = `<button onclick="gdRemoveOverride('${nameEsc}')" style="padding:3px 8px;border:.5px solid var(--border-2);border-radius:6px;background:transparent;color:var(--text);cursor:pointer;font-size:10px">Quitar</button>`;
    } else {
      actionBtn = `<button onclick="gdSetOverride('${nameEsc}', 'exclude')" style="padding:3px 8px;border:.5px solid var(--border-2);border-radius:6px;background:transparent;color:var(--text);cursor:pointer;font-size:10px">Quitar</button>`;
    }
  } else {
    // Está excluido. El botón "Restaurar" borra el override 'exclude'.
    actionBtn = `<button onclick="gdRemoveOverride('${nameEsc}')" style="padding:3px 8px;border:.5px solid var(--border-2);border-radius:6px;background:transparent;color:var(--text);cursor:pointer;font-size:10px">Restaurar</button>`;
  }
  return `<div style="display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;border:.5px solid var(--border-3);margin-bottom:4px">
    <div style="flex:1;min-width:0">
      <p style="font-size:11px;font-weight:500">${p.proveedor}${ovChip}</p>
      <p style="font-size:10px;color:var(--text-2);margin-top:1px">${eur2(p.total_importe)} · ${p.num_transacciones} tx${fechaTxt}</p>
    </div>
    ${actionBtn}
  </div>`;
}

let _gdAllProveedoresCache = null;
async function _populateGdAddDatalist() {
  if (!_gdAllProveedoresCache) {
    try {
      const r = await api('/api/v1/bancos/proveedores-normalizados?limit=500');
      _gdAllProveedoresCache = r.proveedores || [];
    } catch (e) {
      _gdAllProveedoresCache = [];
    }
  }
  // Filtrar candidatos: NO mostrar los que ya están en el grupo (sin override
  // o con include); SÍ mostrar excluidos (para volver a incluirlos).
  const enGrupo = new Set();
  const data = state._gdData || {};
  for (const cat of data.categorias_default || []) {
    for (const p of (data.por_categoria[cat] || [])) {
      if (p.override !== 'exclude') enGrupo.add(p.proveedor);
    }
  }
  for (const p of (data.por_categoria.__INCLUIDOS_EXTRA__ || [])) enGrupo.add(p.proveedor);

  const candidatos = _gdAllProveedoresCache.filter((p) => !enGrupo.has(p.nombre));
  const dl = $('gd-add-list');
  if (!dl) return;
  dl.innerHTML = candidatos
    .sort((a, b) => a.nombre.localeCompare(b.nombre))
    .map((p) => {
      const esc = (p.nombre || '').replace(/"/g, '&quot;');
      return `<option value="${esc}" label="${esc} · ${eur(p.total_importe)}">${esc} · ${eur(p.total_importe)}</option>`;
    }).join('');
  const hint = $('gd-add-hint');
  if (hint) hint.textContent = `${candidatos.length} proveedores disponibles para agregar al grupo`;
}

async function gdSetOverride(proveedor, accion) {
  try {
    await api('/api/v1/bancos/gastos-direccion/override', {
      method: 'POST',
      body: JSON.stringify({ proveedor, accion }),
    });
    Api.pill(`${proveedor}: override ${accion}`);
    _gdAllProveedoresCache = null;
    await reloadGdManage();
    await loadProvRanking(); // refresca donut/leyenda
  } catch (e) {
    Api.pill('Error: ' + e.message, true);
  }
}

async function gdRemoveOverride(proveedor) {
  try {
    await api('/api/v1/bancos/gastos-direccion/override/' + encodeURIComponent(proveedor), { method: 'DELETE' });
    Api.pill(`${proveedor}: override removido`);
    _gdAllProveedoresCache = null;
    await reloadGdManage();
    await loadProvRanking();
  } catch (e) {
    Api.pill('Error: ' + e.message, true);
  }
}

async function gdAddProveedor() {
  const input = $('gd-add-input');
  const nombre = (input?.value || '').trim();
  if (!nombre) return;
  await gdSetOverride(nombre, 'include');
  if (input) input.value = '';
}

// ─── Modal "+ Proveedor" (alta manual al donut) ───────────────────────
// Inyecta un slice nuevo en state.prov.rows con flag _manual=true.
// No persiste en DB — es una entrada visual local hasta que el user
// la materialice creando una regla desde "Gestionar reglas" o desde
// el sidebar de reclasificación de un mov real.
function openAddProvModal() {
  const existing = document.getElementById('add-prov-modal');
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.id = 'add-prov-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center';
  modal.innerHTML = `
    <div style="background:var(--bg-primary);border:0.5px solid var(--border-2);border-radius:12px;padding:24px;width:420px;max-width:90vw">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <span style="font-size:15px;font-weight:500">Agregar proveedor</span>
        <button onclick="document.getElementById('add-prov-modal').remove()" style="background:none;border:none;cursor:pointer;font-size:18px;color:var(--text-2)">×</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:12px">
        <div>
          <label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Nombre del proveedor *</label>
          <input id="add-prov-nombre" type="text" placeholder="Ej: Makro, Coca-Cola Iberian Partners..." style="width:100%;padding:8px 10px;border:.5px solid var(--border-2);border-radius:6px;background:var(--bg-secondary);color:var(--text);font-size:13px;box-sizing:border-box">
        </div>
        <div>
          <label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Categoría</label>
          <select id="add-prov-categoria" style="width:100%;padding:8px 10px;border:.5px solid var(--border-2);border-radius:6px;background:var(--bg-secondary);color:var(--text);font-size:13px;box-sizing:border-box">
            <option value="">— Sin categoría —</option>
          </select>
        </div>
        <div>
          <label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Importe inicial (€)</label>
          <input id="add-prov-importe" type="number" min="0" step="0.01" placeholder="0.00" style="width:100%;padding:8px 10px;border:.5px solid var(--border-2);border-radius:6px;background:var(--bg-secondary);color:var(--text);font-size:13px;box-sizing:border-box">
        </div>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:20px">
        <button onclick="document.getElementById('add-prov-modal').remove()" style="padding:7px 16px;border:.5px solid var(--border-2);border-radius:6px;background:transparent;color:var(--text);cursor:pointer;font-size:13px">Cancelar</button>
        <button onclick="submitAddProv()" style="padding:7px 16px;border:none;border-radius:6px;background:#7C3AED;color:#fff;cursor:pointer;font-size:13px;font-weight:500">Agregar</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  // Llenar el select de categorías con las que ya existen en state.prov.rows.
  // Spec pedía r.categoria_top pero el campo real en /proveedores es r.categoria.
  const cats = [...new Set(state.prov.rows.map((r) => r.categoria).filter(Boolean))].sort();
  const sel = document.getElementById('add-prov-categoria');
  cats.forEach((c) => { const o = document.createElement('option'); o.value = c; o.textContent = c; sel.appendChild(o); });
  setTimeout(() => document.getElementById('add-prov-nombre')?.focus(), 50);
}

async function submitAddProv() {
  const nombre = document.getElementById('add-prov-nombre')?.value.trim();
  const categoria = document.getElementById('add-prov-categoria')?.value;
  const importe = parseFloat(document.getElementById('add-prov-importe')?.value) || 0;
  if (!nombre) { alert('El nombre del proveedor es obligatorio.'); return; }
  // Inyectar en state.prov.rows como entrada manual y re-renderizar.
  // Campo `categoria` (no `categoria_top`) para mantener la consistencia
  // con el resto de la lógica de la tabla / donut.
  state.prov.rows.push({
    proveedor: nombre,
    total_importe: importe,
    num_transacciones: 0,
    porcentaje: 0,
    categoria: categoria || null,
    _manual: true,
  });
  document.getElementById('add-prov-modal').remove();
  renderProvDonut();
  renderProvTabla();
}

Object.assign(window, {
  reload, showTab, toggleUpload, uploadCierres, loadMovs, changePage, exportCsv, logout,
  // Selector global de período (Mes único / Rango)
  setFiltroModo,
  // Carga múltiple de extractos (Santander/Sabadell, XLS/PDF)
  upExtDragOver, upExtDragLeave, upExtDrop, upExtFilesChosen, upExtRetry,
  // Flujo Anual (admin/socio/gerente)
  loadFlujoAnual, renderFlujoComparativa, setFlujoVista,
  // Caja / Efectivo (admin/socio/gerente)
  loadCaja, setCajaVista,
  loadProvRanking, exportProveedoresCsv,
  // Pestaña Proveedores
  sortProvTabla, filterByCategoria, resetProvTablaFiltros, renderProvTabla,
  setDonutThreshold, enterDonutDrill, exitDonutDrill,
  toggleProvSelection, clearProvSelection,
  // Sidebar de detalle / reclasificación
  openProvSidebar, closeProvSidebar, toggleReclasificar, confirmReclasificar, rcRefreshNombres,
  onProvFilterInput, clearProvFilter,
  // Drill desde el donut por categoría: openCategoriaSidebar abre Nivel 1
  // (lista de proveedores). catSidebarVerProveedor entra a Nivel 2 (movs
  // del proveedor). catSidebarVolver vuelve a Nivel 1 sin cerrar el sidebar.
  openCategoriaSidebar, catSidebarVerProveedor, catSidebarVolver,
  // Panel de gestión Gastos Dirección (admin/socio)
  openGdManage, gdSetOverride, gdRemoveOverride, gdAddProveedor,
  // Modal alta manual de proveedor en el donut
  openAddProvModal, submitAddProv,
  // Evolución temporal
  loadEvolucion, evRenderSugerencias, evSeleccionar, evQuitar, evAplicarTopMatch,
});
boot();
