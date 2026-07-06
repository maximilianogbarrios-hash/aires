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
  if (state.prov?.loaded)      loadProvRanking();
  if (state.caja?.loaded)      loadCaja();
  if (state.flujo?.loaded)     loadFlujoAnual();
  if (state.flujoTotal?.loaded) loadFlujoTotal();
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
    _cajaUpToggleSection();
  }
  if (name === 'flujototal') {
    initFlujoTotalFiltros();
    if (!state.flujoTotal?.loaded) loadFlujoTotal();
  }
  if (name === 'simlocal') {
    if (!state.simLocal?.loaded) loadSimLocal();
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
    // Panel reconciliación: fetch independiente porque NO depende de los
    // filtros del tab (siempre compara TODA la historia vs el sistema
    // externo). Si falla, no rompe el resto del tab.
    loadReconciliacionCaja();
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

// ─── Reconciliación caja vs sistema externo ──────────────────────────
// Panel discreto plegable (<details>) en el tab Efectivo. Compara saldo
// calculado en Aires Solo contra el saldo_actual del CSV histórico del
// sistema externo "Control de Cajas". Tolerancia 0,01 €. Llamado desde
// loadCaja() en background — falla silenciosa para no romper el tab.
async function loadReconciliacionCaja() {
  try {
    const j = await api('/api/v1/caja/reconciliacion');
    if (!j || !Array.isArray(j.cajas)) return;
    state.caja.reconciliacion = j;
    renderReconciliacionCaja();
  } catch (e) {
    // No es crítico para el tab — solo loggear y dejar el panel en "—".
    console.warn('[caja.reconciliacion]', e.message);
    const body = $('caja-recon-body');
    if (body) body.innerHTML = `<tr><td colspan="6" style="padding:14px;text-align:center;color:#dc2626;font-size:11px">Error cargando reconciliación: ${e.message}</td></tr>`;
  }
}

function renderReconciliacionCaja() {
  const j = state.caja?.reconciliacion;
  if (!j) return;
  const cajas = j.cajas || [];
  const t = j.totals || {};

  // Badge resumen en el summary: "✓ 25/25 cuadran" o "⚠ 3 descuadres".
  const badge = $('caja-recon-badge');
  if (badge) {
    if (t.n_diferencia || t.n_solo_externo || t.n_solo_calculado) {
      const probs = (t.n_diferencia || 0) + (t.n_solo_externo || 0) + (t.n_solo_calculado || 0);
      badge.innerHTML = `<span style="color:#dc2626">⚠ ${probs} sin cuadrar</span> · ${t.n_ok}/${t.n_cajas} OK`;
    } else {
      badge.innerHTML = `<span style="color:#16a34a">✓ ${t.n_ok}/${t.n_cajas} cuadran</span>`;
    }
  }

  // Footer pequeño con fuente del CSV y fecha de import.
  const fuente = $('caja-recon-fuente');
  if (fuente && j.fuente_externa) {
    const fmtDate = j.importado_en
      ? new Date(j.importado_en).toLocaleDateString('es-ES', { day: '2-digit', month: 'short' })
      : '';
    fuente.textContent = `Fuente externa: ${j.fuente_externa}${fmtDate ? ' (importado ' + fmtDate + ')' : ''}.`;
  }

  const body = $('caja-recon-body');
  if (!body) return;
  if (!cajas.length) {
    body.innerHTML = '<tr><td colspan="6" style="padding:14px;text-align:center;color:var(--text-2)">Sin datos de reconciliación.</td></tr>';
    return;
  }

  // Orden: descuadres primero, luego solo_externo/solo_calculado, luego OK.
  const orden = { DIFERENCIA: 0, solo_externo: 1, solo_calculado: 2, OK: 3 };
  const sorted = [...cajas].sort((a, b) => {
    const oa = orden[a.estado] ?? 9;
    const ob = orden[b.estado] ?? 9;
    if (oa !== ob) return oa - ob;
    return (a.sucursal || '').localeCompare(b.sucursal || '');
  });

  body.innerHTML = sorted.map((c) => {
    const esOk = c.estado === 'OK';
    const soloUno = c.estado === 'solo_externo' || c.estado === 'solo_calculado';
    const estadoCell = esOk
      ? '<span style="color:#16a34a;font-weight:500">✓</span>'
      : soloUno
        ? `<span style="color:#BA7517;font-weight:500" title="${c.estado === 'solo_externo' ? 'En sistema externo, sin movs en Aires Solo' : 'Movs en Aires Solo, sin saldo en sistema externo'}">⚠</span>`
        : '<span style="color:#dc2626;font-weight:500">✗</span>';
    const rowBg = esOk ? '' : 'background:rgba(220,38,38,.04);';
    const fmtS = (v) => v == null ? '—' : eur(v);
    const fmtDiff = (v) => {
      if (v == null) return '—';
      if (Math.abs(v) < 0.005) return '0,00 €';
      const sign = v > 0 ? '+' : '−';
      return sign + eur(Math.abs(v));
    };
    const diffColor = c.diff == null
      ? 'var(--text-2)'
      : (Math.abs(c.diff) <= 0.01 ? 'var(--text-2)' : '#dc2626');
    return `<tr style="border-bottom:.5px solid var(--border-3);${rowBg}">
      <td style="padding:5px 6px;font-weight:500">${c.sucursal}</td>
      <td style="padding:5px 6px;text-align:right">${fmtS(c.saldo_calculado)}</td>
      <td style="padding:5px 6px;text-align:right">${fmtS(c.saldo_externo)}</td>
      <td style="padding:5px 6px;text-align:right;color:${diffColor}">${fmtDiff(c.diff)}</td>
      <td style="padding:5px 6px;text-align:right;color:var(--text-2);font-size:10px">${c.n_calc ?? '—'}${c.n_externo != null && c.n_externo !== c.n_calc ? ' / ' + c.n_externo : ''}</td>
      <td style="padding:5px 6px;text-align:center">${estadoCell}</td>
    </tr>`;
  }).join('');

  // Total row.
  const foot = $('caja-recon-foot');
  if (foot) {
    const diffTot = (t.saldo_total_calculado || 0) - (t.saldo_total_externo || 0);
    foot.innerHTML = `<tr style="border-top:1px solid var(--border-2);background:var(--bg-secondary);font-weight:500">
      <td style="padding:6px;font-size:11px">TOTAL (${t.n_cajas} cajas)</td>
      <td style="padding:6px;text-align:right">${eur(t.saldo_total_calculado || 0)}</td>
      <td style="padding:6px;text-align:right">${eur(t.saldo_total_externo || 0)}</td>
      <td style="padding:6px;text-align:right;color:${Math.abs(diffTot) <= 0.01 ? 'var(--text-2)' : '#dc2626'}">${Math.abs(diffTot) <= 0.01 ? '0,00 €' : (diffTot > 0 ? '+' : '−') + eur(Math.abs(diffTot))}</td>
      <td></td>
      <td style="padding:6px;text-align:center">${t.n_diferencia === 0 && t.n_solo_externo === 0 && t.n_solo_calculado === 0 ? '<span style="color:#16a34a">✓</span>' : '<span style="color:#dc2626">✗</span>'}</td>
    </tr>`;
  }
}

// ─── Flujo Total — banco + efectivo unidos ────────────────────────────
function initFlujoTotalFiltros() {
  if (state.flujoTotal?._init) return;
  state.flujoTotal = state.flujoTotal || {};
  state.flujoTotal._init = true;
  const sSoc = $('ft-sociedad');
  if (sSoc && sSoc.options.length === 0) {
    if (typeof _cloneSociedadOptions === 'function') _cloneSociedadOptions(sSoc);
    else {
      sSoc.innerHTML = '<option value="">Todas las sociedades</option>';
      for (const s of state.sociedades || []) {
        const o = document.createElement('option'); o.value = s.id; o.textContent = s.nombre;
        sSoc.appendChild(o);
      }
    }
  }
}

async function loadFlujoTotal() {
  state.flujoTotal = state.flujoTotal || {};
  const sociedad = $('ft-sociedad')?.value || '';
  const incE = $('ft-incluir-especiales')?.checked ? 'true' : 'false';
  const p = typeof getPeriodoActivo === 'function' ? getPeriodoActivo() : { modo:'unico', periodo:null };
  const params = new URLSearchParams();
  if (sociedad) params.set('sociedad_id', sociedad);
  params.set('incluir_especiales', incE);
  if (p.modo === 'rango') {
    if (p.desde) params.set('desde', p.desde + '-01');
    if (p.hasta) {
      const [yy, mm] = p.hasta.split('-').map(Number);
      params.set('hasta', p.hasta + '-' + String(new Date(yy, mm, 0).getDate()).padStart(2, '0'));
    }
  } else if (p.periodo) {
    const [yy, mm] = p.periodo.split('-').map(Number);
    params.set('desde', p.periodo + '-01');
    params.set('hasta', p.periodo + '-' + String(new Date(yy, mm, 0).getDate()).padStart(2, '0'));
  }
  // Título "— Mayo 2026 — Todas las sociedades"
  const titulo = $('ft-titulo-periodo');
  const lblP = (typeof labelPeriodoActivo === 'function') ? labelPeriodoActivo() : '';
  const SOC_NOMBRES = Object.fromEntries((state.sociedades || []).map((s) => [s.id, s.nombre]));
  const lblSoc = sociedad ? (SOC_NOMBRES[sociedad] || sociedad) : 'Todas las sociedades';
  if (titulo) titulo.textContent = '— ' + lblP + ' — ' + lblSoc;
  try {
    const j = await api('/api/v1/caja/flujo-total?' + params.toString());
    state.flujoTotal.data = j;
    state.flujoTotal.loaded = true;
    renderFlujoTotal();
  } catch (e) {
    console.error('[flujototal] error:', e);
    $('ft-ingresos-body').innerHTML = `<tr><td colspan="5" style="padding:18px;text-align:center;color:#dc2626">Error: ${e.message}</td></tr>`;
  }
}

function renderFlujoTotal() {
  const d = state.flujoTotal?.data;
  if (!d) return;
  // Toggle "Incluir extraordinarios": default = FALSE (mostrar OPERATIVO).
  state.flujoTotal.showExtra = state.flujoTotal.showExtra || false;
  const showExtra = !!state.flujoTotal.showExtra;
  // KPIs — respetan el toggle. Operativo (default) vs Total con extraordinarios.
  const ing = showExtra ? d.kpis.ingresos_total_conExtra : d.kpis.ingresos_operativo;
  const egr = showExtra ? d.kpis.egresos_total_conExtra  : d.kpis.egresos_operativo;
  const neto = showExtra ? d.kpis.neto_total_conExtra    : d.kpis.neto_operativo;
  $('ft-kpi-ing').textContent = eur2(ing);
  $('ft-kpi-egr').textContent = eur2(egr);
  const elN = $('ft-kpi-neto');
  elN.textContent = (neto >= 0 ? '+' : '') + eur2(neto);
  elN.style.color = neto >= 0 ? '#16a34a' : '#dc2626';
  $('ft-kpi-cob').textContent = d.kpis.cobertura_efectivo.toFixed(1) + '%';

  // Panel de extraordinarios + toggle.
  _renderFtExtraordinariosPanel(d);

  // Ingresos
  if (!d.ingresos_por_origen.length) {
    $('ft-ingresos-body').innerHTML = '<tr><td colspan="5" style="padding:18px;text-align:center;color:var(--text-2)">Sin ingresos en este filtro.</td></tr>';
  } else {
    const total = d.kpis.ingresos_total;
    const rows = d.ingresos_por_origen.map((r) => {
      // Click → drill-down: sidebar con TODOS los movimientos que suman este monto.
      const origenJs = String(r.origen).replace(/'/g, "\\'");
      const main = `<tr style="border-bottom:.5px solid var(--border-3);cursor:pointer" onclick="openFtIngresoDrill('${origenJs}')" onmouseover="this.style.background='var(--bg-secondary)'" onmouseout="this.style.background=''" title="Ver los movimientos que componen este monto">
        <td style="padding:7px 6px;font-weight:500">${r.origen} <span style="font-size:9px;color:var(--text-2)">▸</span></td>
        <td style="padding:7px 6px;text-align:right">${r.banco > 0 ? eur(r.banco) : '<span style="color:var(--text-2)">—</span>'}</td>
        <td style="padding:7px 6px;text-align:right">${r.efectivo > 0 ? eur(r.efectivo) : '<span style="color:var(--text-2)">—</span>'}</td>
        <td style="padding:7px 6px;text-align:right;font-weight:500;color:#16a34a">${eur(r.total)}</td>
        <td style="padding:7px 6px;text-align:right;color:var(--text-2)">${r.pct.toFixed(1)}%</td>
      </tr>`;
      const subs = (r.subitems_efectivo || []).map((s) => `<tr class="flujo-comp-cat">
        <td style="padding:4px 6px;padding-left:24px;color:var(--text-2);font-size:11px">└ ${s.label}</td>
        <td style="padding:4px 6px;text-align:right;color:var(--text-2)">—</td>
        <td style="padding:4px 6px;text-align:right;color:var(--text-2)">${eur(s.monto)}</td>
        <td colspan="2"></td>
      </tr>`).join('');
      return main + subs;
    }).join('');
    $('ft-ingresos-body').innerHTML = rows + `<tr style="border-top:2px solid var(--border-2);background:var(--bg-secondary)">
      <td style="padding:9px 6px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;font-size:11px">Total ingresos</td>
      <td style="padding:9px 6px;text-align:right;font-weight:600">${eur(d.kpis.banco_ingresos)}</td>
      <td style="padding:9px 6px;text-align:right;font-weight:600">${eur(d.kpis.caja_ingresos)}</td>
      <td style="padding:9px 6px;text-align:right;font-weight:700;color:#16a34a">${eur(total)}</td>
      <td style="padding:9px 6px;text-align:right">100%</td>
    </tr>`;
  }

  // Egresos
  if (!d.egresos_por_categoria.length) {
    $('ft-egresos-body').innerHTML = '<tr><td colspan="5" style="padding:18px;text-align:center;color:var(--text-2)">Sin egresos en este filtro.</td></tr>';
  } else {
    const total = d.kpis.egresos_total;
    const rows = d.egresos_por_categoria.map((r) => {
      // Candado junto a la cat si es GASTOS_DIRECCION/NOMINAS_DIRECCION
      // (🔒 no-admin, 🔓 admin/socio). El sanitizer ya vació top_banco/
      // top_caja para no-admin → no se renderiza sub-ítems debajo.
      const labelHtml = lockedLabel(r.nombre_display, r.categoria || r.codigo);
      const catCodigo = r.categoria || r.codigo || '';
      const isSensible = esCatSensibleFront(catCodigo);
      const drillAttrs = isSensible
        ? ''  // no drill si el rol no puede ver detalle sensible
        : ` style="border-bottom:.5px solid var(--border-3);cursor:pointer" onclick="openFtEgresoDrill('${catCodigo.replace(/'/g,"\\'")}')" onmouseover="this.style.background='var(--bg-secondary)'" onmouseout="this.style.background=''" title="Ver los movimientos que componen esta categoría"`;
      const arrow = isSensible ? '' : ' <span style="font-size:9px;color:var(--text-2)">▸</span>';
      const main = `<tr${drillAttrs || ' style="border-bottom:.5px solid var(--border-3)"'}>
        <td style="padding:7px 6px;font-weight:500">${labelHtml}${arrow}</td>
        <td style="padding:7px 6px;text-align:right">${r.banco > 0 ? eur(r.banco) : '<span style="color:var(--text-2)">—</span>'}</td>
        <td style="padding:7px 6px;text-align:right">${r.efectivo > 0 ? eur(r.efectivo) : '<span style="color:var(--text-2)">—</span>'}</td>
        <td style="padding:7px 6px;text-align:right;font-weight:500">${eur(r.total)}</td>
        <td style="padding:7px 6px;text-align:right;color:var(--text-2)">${r.pct.toFixed(1)}%</td>
      </tr>`;
      const subsBanco = (r.top_banco || []).map((s) => `<tr class="flujo-comp-cat">
        <td style="padding:4px 6px;padding-left:24px;color:var(--text-2);font-size:11px" title="${s.label.replace(/"/g,'&quot;')}">└ ${s.label.slice(0,50)}</td>
        <td style="padding:4px 6px;text-align:right;color:var(--text-2);font-size:11px">${eur(s.monto)}</td>
        <td style="padding:4px 6px;text-align:right;color:var(--text-2)">—</td>
        <td colspan="2"></td>
      </tr>`).join('');
      const subsCaja = (r.top_caja || []).map((s) => `<tr class="flujo-comp-cat">
        <td style="padding:4px 6px;padding-left:24px;color:var(--text-2);font-size:11px" title="${s.label.replace(/"/g,'&quot;')}">└ ${s.label.slice(0,50)} <span style="color:#A78BFA">(cash)</span></td>
        <td style="padding:4px 6px;text-align:right;color:var(--text-2)">—</td>
        <td style="padding:4px 6px;text-align:right;color:var(--text-2);font-size:11px">${eur(s.monto)}</td>
        <td colspan="2"></td>
      </tr>`).join('');
      return main + subsBanco + subsCaja;
    }).join('');
    // Línea "Sin categoría (efectivo)" como última fila antes del total.
    const sinCat = d.sin_categoria_efectivo || { total: 0, n: 0 };
    const filaSinCat = sinCat.total > 0
      ? `<tr style="border-bottom:.5px solid var(--border-3);background:rgba(167,139,250,.06)">
          <td style="padding:7px 6px;font-style:italic;color:#7E22CE">Sin categoría (efectivo) <span style="font-size:10px;color:var(--text-2)">← reclasificar</span></td>
          <td style="padding:7px 6px;text-align:right;color:var(--text-2)">—</td>
          <td style="padding:7px 6px;text-align:right;font-weight:500">${eur(sinCat.total)}</td>
          <td style="padding:7px 6px;text-align:right;font-weight:500">${eur(sinCat.total)}</td>
          <td style="padding:7px 6px;text-align:right;color:var(--text-2)">${(total>0?(sinCat.total/total*100):0).toFixed(1)}%</td>
        </tr>`
      : '';
    $('ft-egresos-body').innerHTML = rows + filaSinCat + `<tr style="border-top:2px solid var(--border-2);background:var(--bg-secondary)">
      <td style="padding:9px 6px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;font-size:11px">Total egresos</td>
      <td style="padding:9px 6px;text-align:right;font-weight:600">${eur(d.kpis.banco_egresos)}</td>
      <td style="padding:9px 6px;text-align:right;font-weight:600">${eur(d.kpis.caja_egresos)}</td>
      <td style="padding:9px 6px;text-align:right;font-weight:700;color:#dc2626">${eur(total)}</td>
      <td style="padding:9px 6px;text-align:right">100%</td>
    </tr>`;
  }

  // Sin categoría — pendientes (lista)
  const s = d.sin_categoria_efectivo || { total: 0, n: 0, movs: [] };
  $('ft-sincat-resumen').textContent = s.n === 0
    ? 'Todo el efectivo está categorizado ✓'
    : s.n + ' movimientos · €' + s.total.toFixed(2) + ' (top ' + Math.min(50, s.n) + ' mostrados).';
  if (!s.movs?.length) {
    $('ft-sincat-body').innerHTML = '';
  } else {
    $('ft-sincat-body').innerHTML = `<div style="max-height:320px;overflow-y:auto;border:.5px solid var(--border-3);border-radius:6px">
      <table style="width:100%;font-size:11px;border-collapse:collapse">
        <thead><tr style="background:var(--bg-secondary);color:var(--text-2);position:sticky;top:0">
          <th style="text-align:left;padding:5px 8px">Fecha</th>
          <th style="text-align:left;padding:5px 8px">Sucursal</th>
          <th style="text-align:left;padding:5px 8px">Subtipo</th>
          <th style="text-align:right;padding:5px 8px">Monto</th>
        </tr></thead>
        <tbody>
          ${s.movs.map((m) => `<tr style="border-top:.5px solid var(--border-4)">
            <td style="padding:4px 8px">${m.fecha}</td>
            <td style="padding:4px 8px">${m.sucursal}</td>
            <td style="padding:4px 8px;color:var(--text-2)" title="${(m.subtipo||'').replace(/"/g,'&quot;')}">${(m.subtipo||'(sin)').slice(0,80)}</td>
            <td style="padding:4px 8px;text-align:right;color:#dc2626;font-weight:500">${eur(m.monto)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  }
  // Editor de mapeos caja (admin/socio). Carga datos en paralelo al
  // donut combinado; oculta la sección si el rol no aplica.
  if (typeof loadMapeosCaja === 'function') loadMapeosCaja();
  if (typeof loadMapeoSociedades === 'function') loadMapeoSociedades();
  // Tras renderFlujoTotal cargar también el donut combinado de la sección
  // nueva. Reutiliza los mismos filtros (sociedad + incluir_especiales +
  // período del selector global).
  loadDonutCombinado();
}

// ─── Donut combinado (sección nueva dentro de Flujo Total) ────────────
const DC_COLORS = ['#185FA5','#7E22CE','#16a34a','#dc2626','#BA7517','#0891b2','#A78BFA','#facc15','#22c55e','#f87171','#06b6d4','#fb923c','#84cc16','#f43f5e','#8b5cf6','#10b981','#eab308','#ef4444','#3b82f6','#ec4899','#a3a3a3','#fbbf24','#34d399','#f472b6','#60a5fa','#c084fc','#fcd34d','#fda4af','#67e8f9','#bef264','#fdba74','#86efac','#fca5a5','#a5b4fc','#fde047','#5eead4','#94a3b8'];

let chDcDonut = null;

function setDcFuente(f) {
  state.dc = state.dc || {};
  state.dc.fuente = f;
  for (const k of ['todo','banco','efectivo']) {
    const b = $('dc-fuente-' + k);
    if (b) { b.style.background = (k===f) ? '#185FA5' : 'transparent'; b.style.color = (k===f) ? '#fff' : 'var(--text)'; b.style.fontWeight = (k===f) ? '500' : 'normal'; }
  }
  loadDonutCombinado();
}

async function loadDonutCombinado() {
  state.dc = state.dc || { fuente: 'todo' };
  const sociedad = $('ft-sociedad')?.value || '';
  const incE = $('ft-incluir-especiales')?.checked ? 'true' : 'false';
  const p = typeof getPeriodoActivo === 'function' ? getPeriodoActivo() : { modo:'unico', periodo:null };
  const params = new URLSearchParams();
  if (sociedad) params.set('sociedad_id', sociedad);
  params.set('incluir_especiales', incE);
  params.set('fuente', state.dc.fuente || 'todo');
  if (p.modo === 'rango') {
    if (p.desde) params.set('desde', p.desde + '-01');
    if (p.hasta) {
      const [yy, mm] = p.hasta.split('-').map(Number);
      params.set('hasta', p.hasta + '-' + String(new Date(yy, mm, 0).getDate()).padStart(2, '0'));
    }
  } else if (p.periodo) {
    const [yy, mm] = p.periodo.split('-').map(Number);
    params.set('desde', p.periodo + '-01');
    params.set('hasta', p.periodo + '-' + String(new Date(yy, mm, 0).getDate()).padStart(2, '0'));
  }
  try {
    const j = await api('/api/v1/caja/donut-categorias?' + params.toString());
    state.dc.data = j;
    renderDonutCombinado();
  } catch (e) {
    console.error('[dc] error:', e);
    $('dc-legend').innerHTML = `<p style="color:#dc2626;font-size:11px">Error: ${e.message}</p>`;
  }
}

function renderDonutCombinado() {
  const d = state.dc?.data;
  if (!d) return;
  // KPIs
  $('dc-kpi-gasto').textContent = eur2(d.kpis.gasto_total);
  $('dc-kpi-ingreso').textContent = eur2(d.kpis.ingreso_total);
  const elN = $('dc-kpi-neto');
  elN.textContent = (d.kpis.neto >= 0 ? '+' : '') + eur2(d.kpis.neto);
  elN.style.color = d.kpis.neto >= 0 ? '#16a34a' : '#dc2626';
  $('dc-kpi-gasto-split').textContent = `banco ${eur(d.kpis.gasto_banco)} · efectivo ${eur(d.kpis.gasto_caja)}`;
  $('dc-kpi-ingreso-split').textContent = `banco ${eur(d.kpis.ingreso_banco)} · efectivo ${eur(d.kpis.ingreso_caja)}`;
  const tInt = (d.kpis.traspasos_internos_banco || 0) + (d.kpis.traspasos_internos_caja || 0);
  $('dc-kpi-traspasos').textContent = tInt > 0 ? eur2(tInt) : '—';

  // Items con umbral.
  const umbralVal = $('dc-umbral')?.value || 'all';
  const umbral = (umbralVal === 'all') ? null : parseFloat(umbralVal);
  const cats = d.categorias || [];
  const totG = d.kpis.gasto_total || 0;
  let view = cats.slice();
  if (umbral != null) {
    const above = cats.filter((c) => totG > 0 && (c.total_egreso / totG) > umbral);
    const below = cats.filter((c) => totG > 0 && (c.total_egreso / totG) <= umbral);
    view = above.slice();
    if (below.length) {
      const tot = below.reduce((s, c) => s + c.total_egreso, 0);
      view.push({
        codigo: '__OTROS__', nombre_display: `Otros (${below.length})`,
        total_egreso: tot, banco_egreso: below.reduce((s,c)=>s+c.banco_egreso,0),
        efectivo_egreso: below.reduce((s,c)=>s+c.efectivo_egreso,0),
        n_movs: below.reduce((s,c)=>s+c.n_movs,0), n_proveedores: 0,
        pct_sobre_gasto: totG>0 ? Math.round(tot/totG*1000)/10 : 0,
        pct_sobre_ingreso: d.kpis.ingreso_total>0 ? Math.round(tot/d.kpis.ingreso_total*1000)/10 : 0,
        split_banco_pct: tot>0 ? Math.round(below.reduce((s,c)=>s+c.banco_egreso,0)/tot*1000)/10 : 0,
        split_efectivo_pct: tot>0 ? Math.round(below.reduce((s,c)=>s+c.efectivo_egreso,0)/tot*1000)/10 : 0,
        tiene_anterior: false,
      });
    }
  }

  // Donut
  const labels = view.map((v) => v.nombre_display.toUpperCase());
  const values = view.map((v) => v.total_egreso);
  const colors = view.map((_, i) => DC_COLORS[i % DC_COLORS.length]);
  const ctx = $('dc-donut');
  if (ctx && !chDcDonut && window.Chart) {
    chDcDonut = new Chart(ctx, {
      type: 'doughnut',
      data: { labels: [], datasets: [{ data: [], backgroundColor: [], borderWidth: 2, borderColor: 'var(--bg-primary)' }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => ` ${c.label}: ${eur2(c.raw)} (${(totG>0?c.raw/totG*100:0).toFixed(1)}%)` } },
        },
      },
    });
  }
  if (chDcDonut) {
    chDcDonut.data.labels = labels;
    chDcDonut.data.datasets[0].data = values;
    chDcDonut.data.datasets[0].backgroundColor = colors;
    chDcDonut.update();
  }

  // Leyenda con tarjetas (mismo estilo que Proveedores + split + % ingreso)
  $('dc-legend').innerHTML = view.map((c, i) => {
    const color = colors[i];
    const codigoEsc = (c.codigo || '').replace(/'/g, "\\'");
    const isOtros = c.codigo === '__OTROS__';
    const clickFn = isOtros ? '' : `onclick="openDcSidebar('${codigoEsc}')"`;
    const cursor = isOtros ? 'default' : 'pointer';
    // Deltas vs período anterior (sólo si tiene_anterior)
    let varHtml = '';
    if (c.tiene_anterior) {
      const colImp = c.var_importe >= 0 ? '#dc2626' : '#16a34a'; // subir gasto = malo
      const icoImp = Math.abs(c.var_importe) < 1 ? '→' : (c.var_importe > 0 ? '↑' : '↓');
      const colPp = c.var_pp >= 0 ? '#dc2626' : '#16a34a';
      const icoPp = Math.abs(c.var_pp) < 0.5 ? '→' : (c.var_pp > 0 ? '↑' : '↓');
      varHtml = `<span style="color:${colImp};font-size:10px">${icoImp}${c.var_importe>=0?'+':'−'}${eur(Math.abs(c.var_importe))}</span> · <span style="color:${colPp};font-size:10px">${icoPp}${c.var_pp>=0?'+':'−'}${Math.abs(c.var_pp).toFixed(1)}pp</span>`;
    }
    // Candado para cats sensibles (GD/ND) — visible para todos los roles
    // como confirmación visual de protección. 🔒 no-admin, 🔓 admin/socio.
    const labelHtml = lockedLabel(c.nombre_display.toUpperCase(), c.codigo);
    return `<div ${clickFn} style="display:grid;grid-template-columns:auto 1fr auto auto auto;gap:6px;align-items:center;padding:5px 7px;border-radius:6px;cursor:${cursor};border:.5px solid var(--border-3)" ${isOtros?'':'onmouseover="this.style.background=\'var(--bg-secondary)\'" onmouseout="this.style.background=\'transparent\'"'}>
      <span style="width:11px;height:11px;border-radius:2px;background:${color};flex-shrink:0"></span>
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${c.nombre_display.replace(/"/g,'&quot;')}">${labelHtml}</span>
      <span style="font-weight:500;min-width:78px;text-align:right">${eur(c.total_egreso)}</span>
      <span style="color:var(--text-2);font-size:10px;min-width:80px;text-align:right">B${c.split_banco_pct.toFixed(0)}% · E${c.split_efectivo_pct.toFixed(0)}%</span>
      <span style="color:var(--text-2);min-width:90px;text-align:right">${c.pct_sobre_gasto.toFixed(1)}% / ${c.pct_sobre_ingreso.toFixed(1)}%i ${varHtml ? '<br>'+varHtml : ''}</span>
    </div>`;
  }).join('');
}

// ─── Sidebar drill-down del donut combinado ──────────────────────────
async function openDcSidebar(codigo) {
  if (!codigo) return;
  const cat = (state.dc?.data?.categorias || []).find((c) => c.codigo === codigo);
  if (!cat) return;
  const tituloLegible = cat.nombre_display || cat.codigo || '';

  // Header con candado visible (🔓 admin, 🔒 no-admin) en cualquier
  // categoría sensible.
  $('prov-sb-title').innerHTML = lockedLabel((cat.codigo || '').toUpperCase(), cat.codigo);
  $('prov-sb-meta').textContent = `${eur2(cat.total_egreso)} · ${cat.n_movs} movs · banco ${eur(cat.banco_egreso)} · efectivo ${eur(cat.efectivo_egreso)}`;
  $('prov-sb-body').innerHTML = '<p style="font-size:11px;color:var(--text-2);padding:8px">Cargando…</p>';
  $('prov-sidebar-backdrop').style.display = '';
  $('prov-sidebar').style.display = '';

  // Candado cerrado: cat sensible + no-admin → panel limpio sin fetch.
  if (esCatSensibleFront(cat.codigo) && !esAdminLikeFront()) {
    $('prov-sb-meta').textContent = '';
    $('prov-sb-body').innerHTML = renderAccesoRestringidoHTML(tituloLegible);
    return;
  }

  try {
    const params = new URLSearchParams();
    params.set('categoria', codigo);
    params.set('fuente', state.dc?.fuente || 'todo');
    const soc = $('ft-sociedad')?.value || '';
    if (soc) params.set('sociedad_id', soc);
    params.set('incluir_especiales', $('ft-incluir-especiales')?.checked ? 'true' : 'false');
    const p = getPeriodoActivo();
    if (p.modo === 'rango') {
      if (p.desde) params.set('desde', p.desde + '-01');
      if (p.hasta) { const [y,m]=p.hasta.split('-').map(Number); params.set('hasta', p.hasta + '-' + String(new Date(y,m,0).getDate()).padStart(2,'0')); }
    } else if (p.periodo) {
      const [y,m]=p.periodo.split('-').map(Number);
      params.set('desde', p.periodo + '-01');
      params.set('hasta', p.periodo + '-' + String(new Date(y,m,0).getDate()).padStart(2,'0'));
    }
    const j = await api('/api/v1/caja/donut-proveedores?' + params.toString());
    const provs = j.proveedores || [];
    // Cache: el buscador (client-side) re-filtra esta lista sin refetch.
    state._dcProvs = { cat, provs, q: '' };
    if (!provs.length) {
      $('prov-sb-body').innerHTML = '<p style="font-size:12px;color:var(--text-2);padding:20px;text-align:center">Sin proveedores en este filtro.</p>';
      return;
    }
    // Render: search box arriba + contador + lista. La lista vive en
    // #dc-provs-list para re-renderizar solo eso al tipear (preserva
    // foco/cursor del input).
    $('prov-sb-body').innerHTML = `
      ${renderSearchBox({ id: 'dc-provs-search', placeholder: 'Buscar proveedor…', oninput: 'onDcProvsFilter' })}
      <p id="dc-provs-counter" style="font-size:11px;color:var(--text-2);margin-bottom:10px">${provs.length} proveedores. Click → movimientos individuales.${rolEsAdmin() ? ' Botón "Mover" reasigna el proveedor a otra categoría.' : ''}</p>
      <div id="dc-provs-list"></div>`;
    _renderDcProvsList();
  } catch (e) {
    // 403 → mismo panel limpio en vez de "Error: Forbidden..." crudo.
    const msg = String(e?.message || '');
    if (/forbidden|restringid/i.test(msg) || e?.code === 403) {
      $('prov-sb-meta').textContent = '';
      $('prov-sb-body').innerHTML = renderAccesoRestringidoHTML(tituloLegible);
      return;
    }
    $('prov-sb-body').innerHTML = `<p style="color:#dc2626;font-size:11px;padding:8px">Error: ${e.message}</p>`;
  }
}

// Handler del input de búsqueda nivel proveedores. Actualiza el query
// en state y re-renderiza SOLO #dc-provs-list (preserva foco/cursor).
function onDcProvsFilter(val) {
  if (!state._dcProvs) return;
  state._dcProvs.q = val || '';
  _renderDcProvsList();
}

// Render del listado filtrado. Llamado al cargar y en cada keystroke.
function _renderDcProvsList() {
  const ctx = state._dcProvs;
  if (!ctx) return;
  const list = $('dc-provs-list');
  if (!list) return;
  const q = normalizeForSearch(ctx.q);
  const all = ctx.provs;
  const view = q
    ? all.filter((p) => normalizeForSearch(p.proveedor).includes(q))
    : all;
  // Contador "X de N" + subtotal de los proveedores visibles. Las cifras
  // de p.total_egreso ya vienen en valor absoluto (egreso positivo) →
  // formateamos con signo negativo para reflejar que son gastos.
  const counter = $('dc-provs-counter');
  if (counter) {
    const sumaVisible = view.reduce((s, p) => s + (p.total_egreso || 0), 0);
    const subt = view.length ? ` · total −${eur(sumaVisible)}` : '';
    if (q) {
      counter.textContent = `${view.length} de ${all.length} proveedores${subt} · filtro "${ctx.q}"`;
    } else {
      counter.textContent = `${all.length} proveedores${subt}.${rolEsAdmin() ? ' Click → movimientos. Botón "Mover" reasigna a otra categoría.' : ' Click → movimientos.'}`;
    }
  }
  if (!view.length) {
    list.innerHTML = '<p style="font-size:11px;color:var(--text-2);padding:14px;text-align:center">Sin coincidencias para tu búsqueda.</p>';
    return;
  }
  const puedeMover = rolEsAdmin();
  const catJs = (ctx.cat?.codigo || '').replace(/'/g, "\\'");
  list.innerHTML = view.map((p) => {
    const provJs = (p.proveedor || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const badge = (p.banco_egreso > 0 && p.efectivo_egreso > 0)
      ? `<span style="font-size:9px;background:#185FA5;color:#fff;padding:1px 5px;border-radius:8px;margin-right:3px">B</span><span style="font-size:9px;background:#A78BFA;color:#fff;padding:1px 5px;border-radius:8px">E</span>`
      : (p.banco_egreso > 0
          ? `<span style="font-size:9px;background:#185FA5;color:#fff;padding:1px 5px;border-radius:8px">banco</span>`
          : `<span style="font-size:9px;background:#A78BFA;color:#fff;padding:1px 5px;border-radius:8px">efectivo</span>`);
    const btnMover = puedeMover
      ? `<button onclick="event.stopPropagation();openMoverProveedor('${provJs}','${catJs}')" title="Mover a otra categoría" style="background:transparent;border:.5px solid var(--border-3);color:var(--text-2);padding:3px 8px;font-size:10px;border-radius:5px;cursor:pointer;margin-right:6px" onmouseover="this.style.borderColor='#185FA5';this.style.color='#185FA5'" onmouseout="this.style.borderColor='var(--border-3)';this.style.color='var(--text-2)'">⇄ Mover</button>`
      : '';
    return `<div onclick="openDcMovs('${catJs}','${provJs}')" style="display:flex;align-items:center;gap:8px;padding:8px 10px;margin-bottom:6px;border:.5px solid var(--border-3);border-radius:8px;cursor:pointer;background:var(--bg-secondary)" onmouseover="this.style.borderColor='#185FA5'" onmouseout="this.style.borderColor='var(--border-3)'">
      <div style="flex:1;min-width:0">
        <p style="font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${p.proveedor} ${badge}</p>
        <p style="font-size:10px;color:var(--text-2);margin-top:2px">${p.n_movs} tx${p.banco_egreso>0?' · banco '+eur(p.banco_egreso):''}${p.efectivo_egreso>0?' · efectivo '+eur(p.efectivo_egreso):''}</p>
      </div>
      ${btnMover}<span style="font-size:13px;font-weight:500;color:#dc2626">${eur(p.total_egreso)}</span>
    </div>`;
  }).join('');
}

async function openDcMovs(codigo, proveedor) {
  $('prov-sb-title').textContent = `${codigo.toUpperCase()} · ${proveedor}`;
  $('prov-sb-meta').textContent = 'Cargando movimientos…';
  $('prov-sb-body').innerHTML = '<p style="padding:10px;color:var(--text-2);font-size:11px">Cargando…</p>';
  try {
    const params = new URLSearchParams();
    params.set('categoria', codigo);
    params.set('proveedor', proveedor);
    params.set('fuente', state.dc?.fuente || 'todo');
    const soc = $('ft-sociedad')?.value || '';
    if (soc) params.set('sociedad_id', soc);
    params.set('incluir_especiales', $('ft-incluir-especiales')?.checked ? 'true' : 'false');
    const p = getPeriodoActivo();
    if (p.modo === 'rango') {
      if (p.desde) params.set('desde', p.desde + '-01');
      if (p.hasta) { const [y,m]=p.hasta.split('-').map(Number); params.set('hasta', p.hasta + '-' + String(new Date(y,m,0).getDate()).padStart(2,'0')); }
    } else if (p.periodo) {
      const [y,m]=p.periodo.split('-').map(Number);
      params.set('desde', p.periodo + '-01');
      params.set('hasta', p.periodo + '-' + String(new Date(y,m,0).getDate()).padStart(2,'0'));
    }
    const j = await api('/api/v1/caja/donut-movimientos?' + params.toString());
    const movs = j.movimientos || [];
    $('prov-sb-meta').textContent = `${j.n} movs · banco/efectivo unificados`;
    state._dcMovs = { cat: codigo, prov: proveedor, movs, q: '' };
    if (!movs.length) { $('prov-sb-body').innerHTML = '<p style="padding:20px;text-align:center;color:var(--text-2);font-size:12px">Sin movimientos.</p>'; return; }
    $('prov-sb-body').innerHTML = `
      ${renderSearchBox({ id: 'dc-movs-search', placeholder: 'Buscar…', oninput: 'onDcMovsFilter' })}
      <p id="dc-movs-counter" style="font-size:11px;color:var(--text-2);margin-bottom:8px">${movs.length} movimientos.</p>
      <div id="dc-movs-list"></div>`;
    _renderDcMovsList();
  } catch (e) {
    $('prov-sb-body').innerHTML = `<p style="padding:10px;color:#dc2626;font-size:11px">Error: ${e.message}</p>`;
  }
}

function onDcMovsFilter(val) {
  if (!state._dcMovs) return;
  state._dcMovs.q = val || '';
  _renderDcMovsList();
}

function _renderDcMovsList() {
  const ctx = state._dcMovs;
  if (!ctx) return;
  const list = $('dc-movs-list');
  if (!list) return;
  const q = normalizeForSearch(ctx.q);
  const all = ctx.movs;
  // Filtra por descripcion / sucursal / sociedad_id / proveedor (cualquiera
  // que matchee el texto buscado).
  const view = q
    ? all.filter((m) => {
        const hay = normalizeForSearch(m.descripcion) + ' ' +
                    normalizeForSearch(m.sucursal) + ' ' +
                    normalizeForSearch(m.sociedad_id) + ' ' +
                    normalizeForSearch(ctx.prov);
        return hay.includes(q);
      })
    : all;
  // Subtotal vivo: suma los importes VISIBLES respetando signo
  // (egresos negativos, ingresos positivos → muestra el neto). Se
  // recalcula en cada keystroke. Sin filtro = total de los N originales.
  const counter = $('dc-movs-counter');
  if (counter) {
    const sumaNeta = view.reduce((s, m) => s + (m.importe || 0), 0);
    let subt = '';
    if (view.length) {
      const sign = sumaNeta >= 0 ? '+' : '−';
      const color = sumaNeta >= 0 ? '#16a34a' : '#dc2626';
      subt = ` · <span style="font-weight:500;color:${color}">${sign}${eur(Math.abs(sumaNeta))}</span>`;
    }
    counter.innerHTML = q
      ? `${view.length} de ${all.length} movimientos${subt} · filtro "${ctx.q}"`
      : `${all.length} movimientos${subt}.`;
  }
  if (!view.length) {
    list.innerHTML = '<p style="font-size:11px;color:var(--text-2);padding:14px;text-align:center">Sin coincidencias para tu búsqueda.</p>';
    return;
  }
  list.innerHTML = view.map((m) => {
    const badge = m.origen === 'banco'
      ? `<span style="font-size:9px;background:#185FA5;color:#fff;padding:1px 5px;border-radius:8px">banco</span>`
      : `<span style="font-size:9px;background:#A78BFA;color:#fff;padding:1px 5px;border-radius:8px">efectivo</span>`;
    const colImp = m.importe >= 0 ? '#16a34a' : '#dc2626';
    const ubic = m.sucursal ? ' · ' + m.sucursal : '';
    return `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;margin-bottom:4px;border:.5px solid var(--border-3);border-radius:6px;background:var(--bg-secondary)">
      <div style="flex:1;min-width:0">
        <p style="font-size:11px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${(m.descripcion||'').replace(/"/g,'&quot;')}">${badge} ${m.descripcion}</p>
        <p style="font-size:10px;color:var(--text-2);margin-top:2px">${m.fecha}${ubic} · ${m.sociedad_id || ''}</p>
      </div>
      <span style="font-size:12px;font-weight:500;color:${colImp}">${m.importe>=0?'+':''}${eur(m.importe)}</span>
    </div>`;
  }).join('');
}

function exportDonutCombinadoCsv() {
  const d = state.dc?.data;
  if (!d) return;
  const f = d.filtros;
  const rows = [['categoria','nombre','total_egreso','banco','efectivo','split_banco_pct','split_efectivo_pct','n_movs','n_proveedores','pct_sobre_gasto','pct_sobre_ingreso','var_importe','var_pp']];
  for (const c of d.categorias) {
    rows.push([c.codigo, '"' + c.nombre_display.replace(/"/g,'""') + '"', c.total_egreso, c.banco_egreso, c.efectivo_egreso, c.split_banco_pct, c.split_efectivo_pct, c.n_movs, c.n_proveedores, c.pct_sobre_gasto, c.pct_sobre_ingreso, c.var_importe || 0, c.var_pp || 0]);
  }
  const csv = '﻿' + rows.map((r) => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `donut_combinado_${f.fuente}_${f.desde||'desde'}_${f.hasta||'hasta'}.csv`;
  a.click();
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
// ─── Helpers de candado reutilizables ────────────────────────────────
// Un solo lugar de verdad para el ícono y el panel "Acceso restringido".
// Se llaman desde donut/leyenda/tablas/sidebar — cualquier superficie
// que liste GASTOS_DIRECCION o NOMINAS_DIRECCION.

// Códigos canónicos de las cats sensibles a nivel display. El backend
// expone `es_sensible: true` en agregados sensibles tras sanitize, pero
// el frontend también caza por código (defense in depth — si una cat
// sensible se pinta SIN pasar por el sanitizer, el ícono sigue saliendo).
const CATS_SENSIBLES_FRONT = new Set(['GASTOS_DIRECCION', 'NOMINAS_DIRECCION']);

// ¿El usuario actual es admin/socio? Lee state.user (poblado en boot).
function esAdminLikeFront() {
  const r = state?.user?.role;
  return r === 'admin' || r === 'socio';
}

// ¿La cat es sensible? Acepta el código o un objeto cat con .codigo.
function esCatSensibleFront(catOrCodigo) {
  const codigo = typeof catOrCodigo === 'string' ? catOrCodigo : (catOrCodigo?.codigo || catOrCodigo?.categoria);
  if (!codigo) return false;
  return CATS_SENSIBLES_FRONT.has(codigo);
}

// Ícono de candado a renderizar junto a la cat. Vacío si no es sensible.
//   🔒 — no-admin (cerrado)
//   🔓 — admin/socio (abierto, confirma visualmente que la protección está activa)
function lockIconForCat(catOrCodigo) {
  if (!esCatSensibleFront(catOrCodigo)) return '';
  return esAdminLikeFront() ? ' 🔓' : ' 🔒';
}

// HTML de label + candado, listo para inyectar.
function lockedLabel(label, catOrCodigo) {
  const icon = lockIconForCat(catOrCodigo);
  if (!icon) return label;
  const title = esAdminLikeFront()
    ? 'Detalle sensible — accesible a tu rol'
    : 'Detalle restringido — solo admin/socio';
  return `${label}<span title="${title}" style="margin-left:4px;font-size:0.9em;opacity:0.85" aria-label="${esAdminLikeFront() ? 'abierto' : 'cerrado'}">${icon.trim()}</span>`;
}

// Panel "Acceso restringido" (mismo HTML reutilizable). Lo usan
// openCategoriaSidebar y cualquier otra superficie que abra un detalle
// bloqueado. Recibe el título legible (ej. "Gastos Dirección").
function renderAccesoRestringidoHTML(titulo) {
  return `
    <div style="padding:40px 20px;text-align:center">
      <p style="font-size:42px;margin-bottom:10px;line-height:1">🔒</p>
      <p style="font-size:14px;font-weight:600;margin-bottom:6px">Acceso restringido</p>
      <p style="font-size:12px;color:var(--text-2);line-height:1.5;max-width:360px;margin:0 auto">
        El detalle de <strong>${titulo}</strong> solo está disponible para administradores.
        El total y el % se siguen mostrando en el donut.
      </p>
    </div>`;
}

// ─── Buscador reutilizable (drill-down sidebar) ──────────────────────
// Mismo patrón que renderProvSearchBar (con icono lupa + clear button)
// pero genérico — recibe id, placeholder y handler. Usado por openDcSidebar
// (nivel proveedores) y openDcMovs (nivel movimientos) para filtrar
// la lista client-side a medida que se tipea.
function renderSearchBox({ id, placeholder, oninput }) {
  return `
    <div style="position:relative;margin-bottom:10px">
      <span aria-hidden="true" style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--text-2);font-size:13px;pointer-events:none">🔍</span>
      <input type="text" id="${id}" placeholder="${placeholder}"
        autocomplete="off" spellcheck="false"
        oninput="${oninput}(this.value)"
        style="width:100%;padding:6px 32px 6px 30px;border:.5px solid var(--border-2);border-radius:6px;background:var(--bg-secondary);color:var(--text);font-size:12px">
    </div>`;
}

// Normalización para búsqueda: lowercase + sin diacríticos (NFD + strip
// combining marks). Hace que "Núñez" matchee "nunez", "Sueldos" matchee
// "sueldo", etc.
function normalizeForSearch(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

async function openCategoriaSidebar(codigo) {
  if (!codigo) return;
  const cat = (state.prov.por_categoria || []).find((c) => c.codigo === codigo);
  if (!cat) return;

  const nombreLegible = cat.nombre_display && cat.nombre_display.toUpperCase() !== (cat.codigo || '').toUpperCase()
    ? cat.nombre_display.toUpperCase() : null;
  const tituloLegible = cat.nombre_display || cat.codigo || '';

  $('prov-sb-title').innerHTML = lockedLabel((cat.codigo || '').toUpperCase(), cat);
  $('prov-sb-meta').textContent = `${nombreLegible ? nombreLegible + ' · ' : ''}Cargando movimientos…`;
  $('prov-sb-body').innerHTML = `<p style="font-size:11px;color:var(--text-2);padding:8px">Cargando…</p>`;
  $('prov-sidebar-backdrop').style.display = '';
  $('prov-sidebar').style.display = '';

  // Candado cerrado: NO fetch para cat sensible cuando el rol no es
  // admin. Detección por dos vías (defense in depth):
  //   1) cat.puede_drilldown === false  (lo setea el sanitizer)
  //   2) cat sensible + no esAdminLike  (fallback para casos donde el
  //      sanitizer no se aplicó, ej. donut pintado desde caché)
  const debeBloquearse = cat.puede_drilldown === false
                       || (esCatSensibleFront(cat) && !esAdminLikeFront());
  if (debeBloquearse) {
    $('prov-sb-meta').textContent = nombreLegible ? `${nombreLegible}` : '';
    $('prov-sb-body').innerHTML = renderAccesoRestringidoHTML(tituloLegible);
    return;
  }

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
    // Si el backend devolvió 403 (cat sensible bloqueada por rol),
    // mostrar el mismo panel "Acceso restringido" en vez del error
    // crudo "Error: Forbidden...". Cubre el caso donde el flag
    // puede_drilldown no llegó al frontend pero el backend sí filtró.
    const msg = String(e?.message || '');
    if (/forbidden|restringid/i.test(msg) || e?.code === 403) {
      $('prov-sb-meta').textContent = nombreLegible ? nombreLegible : '';
      $('prov-sb-body').innerHTML = renderAccesoRestringidoHTML(tituloLegible);
      return;
    }
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
  // Limpiar cache + query de los buscadores del drill-down (DC sidebar).
  // Evita que al reabrir con otra categoría persista el filtro anterior.
  state._dcProvs = null;
  state._dcMovs = null;
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

// ─── Editor de mapeo subtipo caja → categoría banco (admin/socio) ──────
// Lee/escribe ab_caja_mapeo_subtipos. El donut combinado consume esta
// tabla con cache (60s TTL, invalidada por el endpoint PUT). Reutiliza
// la estética del resto del módulo bancos — no toca "Gestionar reglas".
const mc = { reglas: [], pendientes: [], cats: [], dirty: new Map(), nextTempId: -1 };

// Llama después de loadFlujoTotal(). Si el usuario no es admin/socio,
// oculta la sección y sale. Carga reglas + pendientes en paralelo.
async function loadMapeosCaja() {
  const sec = document.getElementById('mc-section');
  if (!sec) return;
  if (!rolEsAdmin()) { sec.style.display = 'none'; return; }
  sec.style.display = '';
  try {
    const [reglasResp, pendResp, catsResp] = await Promise.all([
      fetch('/api/v1/caja/mapeos').then((r) => r.json()),
      fetch('/api/v1/caja/mapeos/pendientes?solo_sin_clasificar=true').then((r) => r.json()),
      fetch('/api/v1/caja/mapeos/categorias').then((r) => r.ok ? r.json() : { categorias: [] }).catch(() => ({ categorias: [] })),
    ]);
    mc.reglas = (reglasResp.reglas || []).map((r) => ({ ...r, _orig: { ...r } }));
    mc.pendientes = pendResp.subtipos || [];
    mc.cats = (catsResp.categorias || catsResp || []).map((c) => c.codigo || c).filter(Boolean).sort();
    if (mc.cats.length === 0) {
      mc.cats = [...new Set(mc.reglas.map((r) => r.categoria_destino))].sort();
    }
    if (!mc.cats.includes('SIN_CATEGORIA_CAJA')) mc.cats.push('SIN_CATEGORIA_CAJA');
    if (!mc.cats.includes('SIN_CLASIFICAR')) mc.cats.push('SIN_CLASIFICAR');
    mc.dirty = new Map();
    populateBulkCatSelect();
    renderMapeosPendientes(pendResp);
    renderMapeosTable();
    refreshDirtyCount();
    document.getElementById('mc-resumen').textContent =
      `${mc.reglas.length} reglas · ${mc.reglas.filter((r) => r.activa).length} activas`;
  } catch (e) {
    console.error('[mc] load', e);
    document.getElementById('mc-resumen').textContent = 'Error al cargar.';
  }
}

function populateBulkCatSelect() {
  const sel = document.getElementById('mc-bulk-cat');
  if (!sel) return;
  sel.innerHTML = '<option value="">— Categoría destino —</option>' +
    mc.cats.map((c) => `<option value="${c}">${c}</option>`).join('');
}

function renderMapeosPendientes(resp) {
  const body = document.getElementById('mc-pend-body');
  if (!body) return;
  const list = mc.pendientes;
  document.getElementById('mc-pend-resumen').textContent =
    `${resp.n_sin_clasif || list.length} subtipos · €${(resp.total_sin_clasif || 0).toFixed(2)} sin asignar`;
  if (!list.length) {
    body.innerHTML = '<tr><td colspan="6" style="padding:18px;text-align:center;color:var(--text-2)">✓ No hay subtipos sin clasificar.</td></tr>';
    return;
  }
  const opts = mc.cats.map((c) => `<option value="${c}">${c}</option>`).join('');
  body.innerHTML = list.map((p, i) => `
    <tr data-pend-i="${i}" style="border-bottom:.5px solid var(--border-3)">
      <td style="padding:6px"><input type="checkbox" class="mc-pend-chk" data-i="${i}"></td>
      <td style="padding:6px;font-family:monospace;font-size:11px">${escapeHtml(p.subtipo)}</td>
      <td style="padding:6px;text-align:right;color:#dc2626">€${p.total.toFixed(2)}</td>
      <td style="padding:6px;text-align:right;color:var(--text-2)">${p.n}</td>
      <td style="padding:6px;color:var(--text-2);font-size:10px">${p.ultimo_uso || '—'}</td>
      <td style="padding:6px">
        <select class="mc-pend-cat" data-i="${i}" style="padding:3px 6px;border:.5px solid var(--border-2);border-radius:4px;background:var(--bg-primary);color:var(--text);font-size:11px;width:100%">
          <option value="">— sin cambio —</option>${opts}
        </select>
      </td>
    </tr>`).join('');
  // Listener: al elegir categoría en un pendiente, queda como regla
  // nueva pendiente de guardar (exact match, prioridad alta).
  body.querySelectorAll('.mc-pend-cat').forEach((sel) => {
    sel.addEventListener('change', (ev) => {
      const i = +ev.target.dataset.i;
      const p = mc.pendientes[i];
      const cat = ev.target.value;
      if (!cat) { mc.dirty.delete('pend:' + i); refreshDirtyCount(); return; }
      mc.dirty.set('pend:' + i, {
        patron: p.subtipo,
        tipo_match: 'exact',
        prioridad: 950,
        categoria_destino: cat,
        notas: `Asignado desde panel (subtipo libre)`,
        activa: true,
      });
      refreshDirtyCount();
    });
  });
}

function mcPendSelAll(checked) {
  document.querySelectorAll('.mc-pend-chk').forEach((c) => { c.checked = checked; });
}

function applyBulkMapeo() {
  const cat = document.getElementById('mc-bulk-cat')?.value;
  if (!cat) { alert('Elegí una categoría destino primero.'); return; }
  const checks = document.querySelectorAll('.mc-pend-chk:checked');
  if (!checks.length) { alert('Marcá al menos un subtipo de la lista.'); return; }
  let n = 0;
  checks.forEach((chk) => {
    const i = +chk.dataset.i;
    const p = mc.pendientes[i];
    // Setear el select de esa fila y disparar el evento change para
    // reusar la lógica de dirty.
    const sel = document.querySelector(`.mc-pend-cat[data-i="${i}"]`);
    if (sel) { sel.value = cat; sel.dispatchEvent(new Event('change', { bubbles: true })); n++; }
  });
  if (n) showSavePill(`${n} asignados — falta Guardar.`);
}

function renderMapeosTable() {
  const body = document.getElementById('mc-reglas-body');
  if (!body) return;
  const filtro = (document.getElementById('mc-filter')?.value || '').toLowerCase();
  const list = mc.reglas.filter((r) =>
    !filtro || (r.patron || '').toLowerCase().includes(filtro) ||
    (r.categoria_destino || '').toLowerCase().includes(filtro) ||
    (r.notas || '').toLowerCase().includes(filtro));
  document.getElementById('mc-reglas-resumen').textContent =
    `Mostrando ${list.length} / ${mc.reglas.length}`;
  if (!list.length) {
    body.innerHTML = '<tr><td colspan="8" style="padding:18px;text-align:center;color:var(--text-2)">— sin resultados —</td></tr>';
    return;
  }
  const opts = mc.cats.map((c) => `<option value="${c}">${c}</option>`).join('');
  const tipos = ['regex', 'exact', 'prefix'];
  body.innerHTML = list.map((r) => {
    const idAttr = r.id != null ? r.id : ('tmp' + r._tempId);
    const dirty = mc.dirty.has('rule:' + idAttr);
    return `
      <tr data-rid="${idAttr}" style="border-bottom:.5px solid var(--border-3);${dirty ? 'background:rgba(24,95,165,.06)' : ''}">
        <td style="padding:5px">
          <input type="text" class="mc-rule-fld" data-fld="patron" value="${escapeHtml(r.patron || '')}" style="width:100%;min-width:200px;padding:3px 6px;border:.5px solid var(--border-2);border-radius:4px;background:var(--bg-primary);color:var(--text);font-size:11px;font-family:monospace">
        </td>
        <td style="padding:5px">
          <select class="mc-rule-fld" data-fld="tipo_match" style="padding:3px;border:.5px solid var(--border-2);border-radius:4px;background:var(--bg-primary);color:var(--text);font-size:11px">
            ${tipos.map((t) => `<option value="${t}" ${t === r.tipo_match ? 'selected' : ''}>${t}</option>`).join('')}
          </select>
        </td>
        <td style="padding:5px;text-align:right">
          <input type="number" class="mc-rule-fld" data-fld="prioridad" value="${r.prioridad}" style="width:64px;padding:3px 6px;border:.5px solid var(--border-2);border-radius:4px;background:var(--bg-primary);color:var(--text);font-size:11px;text-align:right">
        </td>
        <td style="padding:5px">
          <select class="mc-rule-fld" data-fld="categoria_destino" style="padding:3px 6px;border:.5px solid var(--border-2);border-radius:4px;background:var(--bg-primary);color:var(--text);font-size:11px">
            ${opts.replace(`value="${r.categoria_destino}"`, `value="${r.categoria_destino}" selected`)}
          </select>
        </td>
        <td style="padding:5px">
          <input type="text" class="mc-rule-fld" data-fld="notas" value="${escapeHtml(r.notas || '')}" style="width:100%;min-width:120px;padding:3px 6px;border:.5px solid var(--border-2);border-radius:4px;background:var(--bg-primary);color:var(--text);font-size:11px">
        </td>
        <td style="padding:5px;text-align:center">
          <input type="checkbox" class="mc-rule-fld" data-fld="activa" ${r.activa ? 'checked' : ''}>
        </td>
        <td style="padding:5px;color:var(--text-2);font-size:10px">${escapeHtml(r.autor || '—')}</td>
        <td style="padding:5px;text-align:center">
          <button onclick="mcDeleteRegla(${idAttr})" title="Eliminar regla" style="background:transparent;border:none;color:#dc2626;cursor:pointer;font-size:13px">⌫</button>
        </td>
      </tr>`;
  }).join('');
  // Bind change listeners
  body.querySelectorAll('.mc-rule-fld').forEach((el) => {
    el.addEventListener('change', onRuleFieldChange);
    if (el.tagName === 'INPUT' && el.type === 'text') el.addEventListener('input', onRuleFieldChange);
  });
}

function onRuleFieldChange(ev) {
  const row = ev.target.closest('tr[data-rid]');
  if (!row) return;
  const rid = row.dataset.rid;
  const rule = mc.reglas.find((r) =>
    String(r.id) === rid || ('tmp' + r._tempId) === rid);
  if (!rule) return;
  const fld = ev.target.dataset.fld;
  let val;
  if (ev.target.type === 'checkbox') val = ev.target.checked;
  else if (ev.target.type === 'number') val = +ev.target.value;
  else val = ev.target.value;
  rule[fld] = val;
  // Marcar dirty si cambia respecto al _orig (o si es nueva).
  const orig = rule._orig;
  const isDirty = !orig || ['patron', 'tipo_match', 'prioridad', 'categoria_destino', 'notas', 'activa']
    .some((k) => String(rule[k]) !== String(orig[k]));
  const key = 'rule:' + (rule.id != null ? rule.id : 'tmp' + rule._tempId);
  if (isDirty) mc.dirty.set(key, rule); else mc.dirty.delete(key);
  row.style.background = isDirty ? 'rgba(24,95,165,.06)' : '';
  refreshDirtyCount();
}

function mcNuevaRegla() {
  const tmpId = mc.nextTempId--;
  const nueva = {
    id: null, _tempId: tmpId, patron: '', tipo_match: 'regex',
    prioridad: 100, categoria_destino: mc.cats[0] || 'OTROS_GASTOS',
    notas: '', autor: '(nueva)', activa: true, _orig: null,
  };
  mc.reglas.unshift(nueva);
  mc.dirty.set('rule:tmp' + tmpId, nueva);
  renderMapeosTable();
  refreshDirtyCount();
}

window.mcDeleteRegla = function (rid) {
  if (!confirm('¿Eliminar esta regla? El cambio aplica al Guardar.')) return;
  const idx = mc.reglas.findIndex((r) =>
    String(r.id) === String(rid) || ('tmp' + r._tempId) === String(rid));
  if (idx < 0) return;
  const r = mc.reglas[idx];
  // Si tiene id real, marcar para delete; si es temp, simplemente quitar.
  if (r.id != null) {
    mc.dirty.set('del:' + r.id, { _delete: r.id });
    mc.reglas.splice(idx, 1);
  } else {
    mc.dirty.delete('rule:tmp' + r._tempId);
    mc.reglas.splice(idx, 1);
  }
  renderMapeosTable();
  refreshDirtyCount();
};

function refreshDirtyCount() {
  const n = mc.dirty.size;
  const btn = document.getElementById('mc-btn-guardar');
  if (btn) { btn.textContent = `Guardar cambios (${n})`; btn.disabled = n === 0; }
}

async function saveMapeosCaja() {
  const upserts = [];
  const deletes = [];
  for (const [k, v] of mc.dirty.entries()) {
    if (k.startsWith('del:')) { deletes.push(v._delete); continue; }
    if (k.startsWith('pend:') || k.startsWith('rule:')) {
      const payload = {
        patron: v.patron,
        tipo_match: v.tipo_match,
        prioridad: v.prioridad,
        categoria_destino: v.categoria_destino,
        notas: v.notas || null,
        activa: v.activa !== false,
      };
      if (v.id != null) payload.id = v.id;
      upserts.push(payload);
    }
  }
  const btn = document.getElementById('mc-btn-guardar');
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando…'; }
  try {
    const r = await fetch('/api/v1/caja/mapeos', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ upserts, deletes }),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || 'save failed');
    showSavePill(`✓ ${j.inserted} nuevas · ${j.updated} editadas · ${j.deleted} borradas${j.errors ? ` · ${j.errors} con error` : ''}`);
    // Recargar mapeos + donut combinado (la cache del backend ya fue
    // invalidada por el PUT) sin redeploy.
    await loadMapeosCaja();
    if (typeof loadDonutCombinado === 'function') await loadDonutCombinado();
    if (typeof loadFlujoTotal === 'function') await loadFlujoTotal();
  } catch (e) {
    console.error('[mc] save', e);
    alert('Error al guardar: ' + (e.message || e));
    if (btn) btn.disabled = false;
    refreshDirtyCount();
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function showSavePill(msg) {
  const p = document.getElementById('save-pill');
  if (!p) return;
  p.textContent = msg;
  p.style.display = 'block';
  clearTimeout(p._t);
  p._t = setTimeout(() => { p.style.display = 'none'; }, 3500);
}

// ─── Editor de mapeo caja externa → sociedad SL (admin/socio) ──────────
// Lee/escribe ab_caja_mapeo_sociedades. El backend re-corre el backfill
// tras cada PUT — actualiza ab_caja_movimientos.sociedad_id de un golpe.
const ms = { reglas: [], catalogo: [], dirty: new Map(), nextTempId: -1 };

async function loadMapeoSociedades() {
  const sec = document.getElementById('ms-section');
  if (!sec) return;
  if (!rolEsAdmin()) { sec.style.display = 'none'; return; }
  sec.style.display = '';
  try {
    const r = await fetch('/api/v1/caja/sociedades').then((x) => x.json());
    ms.reglas = (r.reglas || []).map((x) => ({ ...x, _orig: { ...x } }));
    ms.catalogo = r.catalogo_sociedades || [];
    ms.dirty = new Map();
    populateBulkSociedadSelect();
    renderMapeoSociedadesTable();
    refreshMsDirty();
    document.getElementById('ms-resumen').textContent =
      `${ms.reglas.length} cajas · ${ms.reglas.filter((x) => x.tipo === 'sociedad').length} en SL · ${ms.reglas.filter((x) => x.tipo === 'interno').length} internas`;
    const pend = ms.reglas.filter((x) => x.tipo === 'pendiente').length;
    const badge = document.getElementById('ms-pendientes-badge');
    if (pend > 0) {
      badge.style.display = '';
      badge.textContent = `⚠ ${pend} pendientes`;
    } else {
      badge.style.display = 'none';
    }
  } catch (e) {
    console.error('[ms] load', e);
    document.getElementById('ms-resumen').textContent = 'Error al cargar.';
  }
}

function populateBulkSociedadSelect() {
  const sel = document.getElementById('ms-bulk-sociedad');
  if (!sel) return;
  sel.innerHTML = '<option value="">— sociedad —</option>' +
    ms.catalogo.map((s) => `<option value="${s.sociedad_slug}|${s.sociedad_cif || ''}|${s.sociedad_nombre || ''}">${escapeHtml(s.sociedad_nombre)}</option>`).join('');
}

function renderMapeoSociedadesTable() {
  const body = document.getElementById('ms-body');
  if (!body) return;
  const filtro = (document.getElementById('ms-filter')?.value || '').toLowerCase();
  const list = ms.reglas.filter((r) =>
    !filtro || (r.caja_origen || '').toLowerCase().includes(filtro) ||
    (r.sociedad_nombre || '').toLowerCase().includes(filtro) ||
    (r.tipo || '').toLowerCase().includes(filtro) ||
    (r.nombre_canonico || '').toLowerCase().includes(filtro));
  if (!list.length) {
    body.innerHTML = '<tr><td colspan="9" style="padding:18px;text-align:center;color:var(--text-2)">— sin resultados —</td></tr>';
    return;
  }
  const tipos = ['sociedad', 'interno', 'pendiente', 'excluir'];
  const socOpts = ['<option value=""></option>']
    .concat(ms.catalogo.map((s) => `<option value="${s.sociedad_slug}">${escapeHtml(s.sociedad_nombre)}</option>`))
    .join('');
  body.innerHTML = list.map((r) => {
    const idAttr = r.id != null ? r.id : ('tmp' + r._tempId);
    const dirty = ms.dirty.has('ms:' + idAttr);
    const isPend = r.tipo === 'pendiente';
    const isHuerf = r._huerfana;
    const rowBg = dirty
      ? 'background:rgba(24,95,165,.06)'
      : (isPend || isHuerf ? 'background:rgba(250,204,21,.08)' : '');
    const saldo = r.saldo_neto != null ? r.saldo_neto : 0;
    const saldoCol = saldo < 0 ? '#dc2626' : (saldo > 0 ? '#16a34a' : 'var(--text-2)');
    return `
      <tr data-rid="${idAttr}" style="border-bottom:.5px solid var(--border-3);${rowBg}">
        <td style="padding:5px"><input type="checkbox" class="ms-chk"></td>
        <td style="padding:5px;font-family:monospace;font-size:11px">
          ${escapeHtml(r.caja_origen)}${isHuerf ? ' <span style="font-size:9px;color:#dc2626">(NUEVA)</span>' : ''}
        </td>
        <td style="padding:5px">
          <select class="ms-fld" data-fld="tipo" style="padding:3px 6px;border:.5px solid var(--border-2);border-radius:4px;background:var(--bg-primary);color:var(--text);font-size:11px">
            ${tipos.map((t) => `<option value="${t}" ${t === r.tipo ? 'selected' : ''}>${t}</option>`).join('')}
          </select>
        </td>
        <td style="padding:5px">
          <select class="ms-fld" data-fld="sociedad_slug" style="padding:3px 6px;border:.5px solid var(--border-2);border-radius:4px;background:var(--bg-primary);color:var(--text);font-size:11px;min-width:160px" ${r.tipo === 'sociedad' ? '' : 'disabled'}>
            ${socOpts.replace(`value="${r.sociedad_slug}"`, `value="${r.sociedad_slug}" selected`)}
          </select>
        </td>
        <td style="padding:5px">
          <input type="text" class="ms-fld" data-fld="nombre_canonico" value="${escapeHtml(r.nombre_canonico || '')}" placeholder="—" style="width:100%;min-width:120px;padding:3px 6px;border:.5px solid var(--border-2);border-radius:4px;background:var(--bg-primary);color:var(--text);font-size:11px">
        </td>
        <td style="padding:5px;text-align:right;color:var(--text-2)">${(r.n_movs || 0).toLocaleString()}</td>
        <td style="padding:5px;text-align:right;color:${saldoCol}">€${(saldo).toFixed(2)}</td>
        <td style="padding:5px">
          <input type="text" class="ms-fld" data-fld="notas" value="${escapeHtml(r.notas || '')}" style="width:100%;min-width:100px;padding:3px 6px;border:.5px solid var(--border-2);border-radius:4px;background:var(--bg-primary);color:var(--text);font-size:11px">
        </td>
        <td style="padding:5px;text-align:center">
          ${r.id != null ? `<button onclick="msDeleteRegla(${r.id})" title="Eliminar" style="background:transparent;border:none;color:#dc2626;cursor:pointer;font-size:13px">⌫</button>` : ''}
        </td>
      </tr>`;
  }).join('');
  body.querySelectorAll('.ms-fld').forEach((el) => {
    el.addEventListener('change', onMsFieldChange);
    if (el.tagName === 'INPUT' && el.type === 'text') el.addEventListener('input', onMsFieldChange);
  });
}

function onMsFieldChange(ev) {
  const row = ev.target.closest('tr[data-rid]');
  if (!row) return;
  const rid = row.dataset.rid;
  const r = ms.reglas.find((x) =>
    String(x.id) === rid || ('tmp' + x._tempId) === rid);
  if (!r) return;
  const fld = ev.target.dataset.fld;
  const val = ev.target.type === 'checkbox' ? ev.target.checked : ev.target.value;
  r[fld] = val;
  // Si cambia tipo, sincronizar campos derivados.
  if (fld === 'tipo') {
    if (val !== 'sociedad') {
      r.sociedad_slug = null; r.sociedad_cif = null; r.sociedad_nombre = null;
    }
    renderMapeoSociedadesTable(); // re-render para habilitar/deshabilitar select
  }
  if (fld === 'sociedad_slug') {
    const cat = ms.catalogo.find((c) => c.sociedad_slug === val);
    if (cat) {
      r.sociedad_cif = cat.sociedad_cif;
      r.sociedad_nombre = cat.sociedad_nombre;
    }
  }
  // Crear regla nueva si la fila era huérfana — pasa de huérfana a editable real.
  if (r._huerfana) {
    r._tempId = ms.nextTempId--;
    delete r._huerfana;
    r.id = null;
  }
  const orig = r._orig || {};
  const isDirty = ['caja_origen','tipo','sociedad_slug','sociedad_cif','sociedad_nombre','nombre_canonico','notas','activa']
    .some((k) => String(r[k] || '') !== String(orig[k] || ''));
  const key = 'ms:' + (r.id != null ? r.id : 'tmp' + r._tempId);
  if (isDirty) ms.dirty.set(key, r); else ms.dirty.delete(key);
  refreshMsDirty();
}

function msSelAll(checked) {
  document.querySelectorAll('.ms-chk').forEach((c) => { c.checked = checked; });
}

function applyBulkSociedad() {
  const tipo = document.getElementById('ms-bulk-tipo')?.value;
  const socVal = document.getElementById('ms-bulk-sociedad')?.value;
  if (!tipo) { alert('Elegí un tipo en el bulk.'); return; }
  if (tipo === 'sociedad' && !socVal) { alert('Si el tipo es "sociedad", elegí también la SL.'); return; }
  const checks = [...document.querySelectorAll('.ms-chk:checked')];
  if (!checks.length) { alert('Marcá al menos una caja.'); return; }
  const [slug, cif, nombre] = socVal ? socVal.split('|') : ['', '', ''];
  let n = 0;
  checks.forEach((chk) => {
    const row = chk.closest('tr[data-rid]');
    if (!row) return;
    const rid = row.dataset.rid;
    const r = ms.reglas.find((x) => String(x.id) === rid || ('tmp' + x._tempId) === rid);
    if (!r) return;
    r.tipo = tipo;
    if (tipo === 'sociedad') {
      r.sociedad_slug = slug; r.sociedad_cif = cif; r.sociedad_nombre = nombre;
    } else {
      r.sociedad_slug = null; r.sociedad_cif = null; r.sociedad_nombre = null;
    }
    if (r._huerfana) { r._tempId = ms.nextTempId--; delete r._huerfana; r.id = null; }
    const orig = r._orig || {};
    const isDirty = ['caja_origen','tipo','sociedad_slug','sociedad_cif','sociedad_nombre','nombre_canonico','notas','activa']
      .some((k) => String(r[k] || '') !== String(orig[k] || ''));
    const key = 'ms:' + (r.id != null ? r.id : 'tmp' + r._tempId);
    if (isDirty) ms.dirty.set(key, r); else ms.dirty.delete(key);
    n++;
  });
  renderMapeoSociedadesTable();
  refreshMsDirty();
  if (n) showSavePill(`${n} cajas actualizadas — falta Guardar.`);
}

window.msDeleteRegla = function (rid) {
  if (!confirm('¿Eliminar esta regla? El backfill recalculará sociedad_id al guardar.')) return;
  const idx = ms.reglas.findIndex((r) => String(r.id) === String(rid));
  if (idx < 0) return;
  ms.dirty.set('msdel:' + rid, { _delete: rid });
  ms.reglas.splice(idx, 1);
  renderMapeoSociedadesTable();
  refreshMsDirty();
};

function refreshMsDirty() {
  const n = ms.dirty.size;
  const btn = document.getElementById('ms-btn-guardar');
  if (btn) { btn.textContent = `Guardar cambios (${n})`; btn.disabled = n === 0; }
}

async function saveMapeoSociedades() {
  const upserts = [];
  const deletes = [];
  for (const [k, v] of ms.dirty.entries()) {
    if (k.startsWith('msdel:')) { deletes.push(v._delete); continue; }
    const payload = {
      caja_origen: v.caja_origen,
      tipo: v.tipo,
      sociedad_slug: v.sociedad_slug,
      sociedad_cif: v.sociedad_cif,
      sociedad_nombre: v.sociedad_nombre,
      nombre_canonico: v.nombre_canonico || null,
      notas: v.notas || null,
      activa: v.activa !== false,
    };
    if (v.id != null) payload.id = v.id;
    upserts.push(payload);
  }
  const btn = document.getElementById('ms-btn-guardar');
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando…'; }
  try {
    const r = await fetch('/api/v1/caja/sociedades', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ upserts, deletes }),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || 'save failed');
    const bf = j.backfill || {};
    showSavePill(`✓ ${j.inserted} nuevas · ${j.updated} editadas · ${j.deleted} borradas · backfill ${bf.reasignados || 0} mov reasignados, ${bf.nullificados || 0} → null`);
    await loadMapeoSociedades();
    if (typeof loadFlujoTotal === 'function') await loadFlujoTotal();
    if (typeof loadDonutCombinado === 'function') await loadDonutCombinado();
  } catch (e) {
    console.error('[ms] save', e);
    alert('Error al guardar: ' + (e.message || e));
    if (btn) btn.disabled = false;
    refreshMsDirty();
  }
}

// ─── Mover proveedor a otra categoría (admin/socio) ────────────────────
// Abre un modal con selector de categoría destino + preview live + botón
// confirmar. Llama a POST /api/v1/caja/mover-proveedor en dos pasos:
//   1) modo='preview' → muestra cuántos movs (banco + efectivo) afectaría
//   2) modo='confirmar' → ejecuta upsert en ambos motores y refresca todo
// El botón solo aparece para admin/socio (rolEsAdmin), y el endpoint
// además aplica gate 403 server-side.
async function openMoverProveedor(proveedor, catOrigen) {
  if (!rolEsAdmin()) { alert('Solo admin/socio puede mover categorías.'); return; }
  // Cerrar cualquier modal existente.
  const existing = document.getElementById('mover-modal');
  if (existing) existing.remove();
  // Cargar catálogo de categorías para el selector.
  let cats = [];
  try {
    const j = await fetch('/api/v1/caja/mapeos/categorias').then((r) => r.json());
    cats = (j.categorias || []).filter((c) => c.codigo !== catOrigen);
  } catch (e) {
    alert('No pude cargar el catálogo de categorías: ' + e.message);
    return;
  }
  const modal = document.createElement('div');
  modal.id = 'mover-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:200;display:flex;align-items:center;justify-content:center';
  modal.innerHTML = `
    <div style="background:var(--bg-primary);border-radius:10px;padding:1.25rem 1.5rem;width:min(520px,95vw);max-height:90vh;overflow-y:auto;border:.5px solid var(--border-2)">
      <p style="font-size:10px;color:var(--text-2);text-transform:uppercase;letter-spacing:1px;margin-bottom:.25rem">Mover proveedor</p>
      <h2 style="font-size:17px;font-weight:600;margin:0 0 .5rem">${escapeHtml(proveedor)}</h2>
      <p style="font-size:11px;color:var(--text-2);margin-bottom:1rem">Categoría actual: <code>${escapeHtml(catOrigen || '—')}</code>. Reasigna TODOS los movimientos del proveedor (banco + efectivo, todos los períodos y sociedades) a la nueva categoría.</p>
      <div style="display:flex;flex-direction:column;gap:.5rem;margin-bottom:1rem">
        <label style="font-size:11px;color:var(--text-2)">Categoría destino:
          <select id="mp-destino" onchange="previewMoverProveedor()" style="width:100%;margin-top:4px;padding:6px 8px;border:.5px solid var(--border-2);border-radius:6px;background:var(--bg-secondary);color:var(--text);font-size:12px">
            <option value="">— elegir —</option>
            ${cats.map((c) => `<option value="${c.codigo}">${escapeHtml(c.codigo)} — ${escapeHtml(c.nombre_display || '')}</option>`).join('')}
          </select>
        </label>
      </div>
      <div id="mp-preview" style="margin-bottom:1rem;padding:10px;border:.5px dashed var(--border-2);border-radius:6px;background:var(--bg-secondary);font-size:11px;color:var(--text-2);min-height:60px">Elegí una categoría destino para ver el preview.</div>
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button onclick="document.getElementById('mover-modal').remove()" style="padding:7px 14px;border:.5px solid var(--border-2);border-radius:6px;background:transparent;color:var(--text);cursor:pointer;font-size:12px">Cancelar</button>
        <button id="mp-confirm" onclick="confirmMoverProveedor()" disabled style="padding:7px 14px;border:none;border-radius:6px;background:#185FA5;color:#fff;cursor:pointer;font-size:12px;font-weight:500;opacity:.5">Confirmar movimiento</button>
      </div>
    </div>`;
  modal.dataset.proveedor = proveedor;
  modal.dataset.catOrigen = catOrigen || '';
  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
}

async function previewMoverProveedor() {
  const modal = document.getElementById('mover-modal');
  if (!modal) return;
  const destino = document.getElementById('mp-destino')?.value;
  const preview = document.getElementById('mp-preview');
  const btn = document.getElementById('mp-confirm');
  btn.disabled = true; btn.style.opacity = '.5';
  if (!destino) {
    preview.innerHTML = 'Elegí una categoría destino para ver el preview.';
    return;
  }
  preview.innerHTML = '<span style="color:var(--text-2)">Calculando…</span>';
  try {
    const r = await fetch('/api/v1/caja/mover-proveedor', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proveedor: modal.dataset.proveedor,
        categoria_origen: modal.dataset.catOrigen,
        categoria_destino: destino,
        modo: 'preview',
      }),
    });
    const j = await r.json();
    if (!r.ok) { preview.innerHTML = '<span style="color:#dc2626">Error: ' + escapeHtml(j.error || 'unknown') + '</span>'; return; }
    const n = j.n_total_movs;
    if (n === 0) {
      preview.innerHTML = '<span style="color:#dc2626">No hay movimientos que coincidan — ¿el proveedor ya no existe en ' + escapeHtml(modal.dataset.catOrigen) + '?</span>';
      return;
    }
    const subts = j.efectivo.subtipos.slice(0, 6).map((s) =>
      `<li><code>${escapeHtml(s.subtipo)}</code> · ${s.n} movs · ${eur(s.total)}</li>`).join('');
    const masSubts = j.efectivo.subtipos.length > 6 ? `<li>… y ${j.efectivo.subtipos.length - 6} más</li>` : '';
    preview.innerHTML = `
      <p style="margin-bottom:.5rem;color:var(--text);font-weight:500">Esto reclasificará <span style="color:#185FA5">${n} movimientos</span> de <code>${escapeHtml(modal.dataset.proveedor)}</code> a <code>${escapeHtml(destino)}</code>:</p>
      <ul style="margin:0 0 .5rem;padding-left:18px;font-size:11px">
        <li><strong>Banco:</strong> ${j.banco.n_movs} movs (${eur(j.banco.total)}) → regla en <code>ab_reglas_normalizacion</code></li>
        <li><strong>Efectivo:</strong> ${j.efectivo.n_movs} movs (${eur(j.efectivo.total)}) en ${j.efectivo.subtipos.length} subtipos → reglas en <code>ab_caja_mapeo_subtipos</code></li>
      </ul>
      ${j.efectivo.subtipos.length > 0 ? `<details style="margin-top:.5rem"><summary style="cursor:pointer;font-size:11px">Subtipos afectados</summary><ul style="margin:.25rem 0;padding-left:18px;font-size:10px;color:var(--text-2)">${subts}${masSubts}</ul></details>` : ''}
      <p style="margin-top:.5rem;font-size:10px;color:var(--text-2)">Aplica a TODOS los períodos y sociedades. Reversible — mover de vuelta = actualizar las mismas reglas.</p>`;
    btn.disabled = false; btn.style.opacity = '1';
  } catch (e) {
    preview.innerHTML = '<span style="color:#dc2626">Error: ' + escapeHtml(e.message || e) + '</span>';
  }
}

async function confirmMoverProveedor() {
  const modal = document.getElementById('mover-modal');
  if (!modal) return;
  const destino = document.getElementById('mp-destino')?.value;
  const btn = document.getElementById('mp-confirm');
  if (!destino) return;
  btn.disabled = true; btn.textContent = 'Aplicando…';
  try {
    const r = await fetch('/api/v1/caja/mover-proveedor', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proveedor: modal.dataset.proveedor,
        categoria_origen: modal.dataset.catOrigen,
        categoria_destino: destino,
        modo: 'confirmar',
      }),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || 'save failed');
    showSavePill(`✓ Reclasificado: ${j.banco.movs_afectados} banco + ${j.efectivo.movs_afectados} efectivo (${j.efectivo.reglas_upsert} subtipos)`);
    modal.remove();
    // Refresco completo: donut + KPIs + tablas + cierro sidebar para
    // forzar siguiente click a re-fetch.
    closeProvSidebar();
    if (typeof loadDonutCombinado === 'function') await loadDonutCombinado();
    if (typeof loadFlujoTotal === 'function') await loadFlujoTotal();
  } catch (e) {
    console.error('[mp] confirm', e);
    alert('Error al guardar: ' + (e.message || e));
    btn.disabled = false; btn.textContent = 'Confirmar movimiento';
  }
}

// ─── Upload de archivo de cajas (Control de Cajas) — admin/socio ──────
// Reusa el importer idempotente del backend. Acepta CSV y XLS/XLSX.
// Muestra reporte (nuevas/duplicadas/actualizadas) sin recargar la página
// y refresca KPIs/reconciliación al terminar.
function _cajaUpToggleSection() {
  const sec = document.getElementById('caja-upload-section');
  if (!sec) return;
  sec.style.display = rolEsAdmin() ? '' : 'none';
}

function cajaUploadDrop(e) {
  e.preventDefault();
  const dz = document.getElementById('caja-up-dropzone');
  if (dz) dz.style.background = 'transparent';
  const f = e.dataTransfer?.files?.[0];
  if (f) uploadCajaFile(f);
}

function cajaUploadChosen(e) {
  const f = e.target.files?.[0];
  if (f) uploadCajaFile(f);
  e.target.value = ''; // reset
}

async function uploadCajaFile(file) {
  const status = document.getElementById('caja-up-status');
  if (!status) return;
  const ext = (file.name || '').toLowerCase().split('.').pop();
  if (!['csv', 'xls', 'xlsx', 'txt'].includes(ext)) {
    status.innerHTML = `<p style="color:#dc2626;font-size:11px">Extensión .${escapeHtml(ext)} no aceptada. Use .csv / .xls / .xlsx.</p>`;
    return;
  }
  if (file.size > 20 * 1024 * 1024) {
    status.innerHTML = `<p style="color:#dc2626;font-size:11px">Archivo > 20 MB.</p>`;
    return;
  }
  status.innerHTML = `<p style="font-size:11px;color:var(--text-2)">📤 Subiendo "${escapeHtml(file.name)}" (${(file.size/1024).toFixed(1)} KB)…</p>`;
  try {
    const fd = new FormData();
    fd.append('file', file);
    const r = await fetch('/api/v1/caja/upload', { method: 'POST', body: fd });
    const j = await r.json();
    if (!r.ok || !j.ok) {
      status.innerHTML = `<p style="color:#dc2626;font-size:11px">Error: ${escapeHtml(j.error || 'unknown')}</p>`;
      return;
    }
    const sucsDesc = j.cajas.desconocidas_en_mapeo;
    const cajasWarn = sucsDesc.length
      ? `<p style="font-size:10px;color:#b45309;margin-top:.4rem">⚠ ${sucsDesc.length} cajas sin mapeo en ab_caja_mapeo_sociedades: ${sucsDesc.map(escapeHtml).join(', ')}. Asignalas en el editor (Flujo Total → Mapeo cajas → sociedad SL).</p>`
      : '';
    status.innerHTML = `
      <div style="border:.5px solid #16a34a;background:rgba(22,163,74,.06);border-radius:6px;padding:10px 12px">
        <p style="font-size:12px;font-weight:500;color:#16a34a;margin:0 0 .5rem">✓ Importado "${escapeHtml(j.fuente)}"</p>
        <ul style="margin:0;padding-left:18px;font-size:11px;line-height:1.5">
          <li>filas en archivo: <strong>${j.archivo.n_filas_procesadas}</strong> (rango ${j.archivo.rango_fechas.desde} → ${j.archivo.rango_fechas.hasta})</li>
          <li><strong style="color:#16a34a">${j.upsert.insertadas_nuevas}</strong> insertadas nuevas · <strong>${j.upsert.actualizadas}</strong> actualizadas · ${j.upsert.ya_presentes_sin_cambios} ya presentes sin cambios</li>
          <li>DB total: ${j.db.antes} → <strong>${j.db.despues}</strong> filas (Δ +${j.db.delta}) · rango actual ${j.db.rango_total.desde} → ${j.db.rango_total.hasta}</li>
          <li>resumen externo: ${j.resumen_externo.n_cajas} cajas actualizadas en ab_caja_saldos_externos</li>
        </ul>
        ${cajasWarn}
      </div>`;
    // Refrescar Efectivo + reconciliación + período sin recargar.
    try {
      if (typeof loadCaja === 'function') await loadCaja();
      if (typeof loadDonutCombinado === 'function') await loadDonutCombinado();
      if (typeof loadFlujoTotal === 'function') await loadFlujoTotal();
    } catch (e) { /* tolerante — el reporte ya se mostró */ }
  } catch (e) {
    status.innerHTML = `<p style="color:#dc2626;font-size:11px">Error: ${escapeHtml(e.message || e)}</p>`;
  }
}

// ─── Simulador de rentabilidad y cierre de local ────────────────────
// Estado: locales[] con params persistidos + facturación auto.
// Campos editables por fila: facturacion_override, personal_ss,
// alquiler, suministros, pct_mp, pct_personal_evitable. Cerrar = flag
// en memoria (no se persiste, es solo para simulación).
// Cálculo en vivo con recalcSimRow — corre en cada input change.

function _simSociedadOpts() {
  const sel = $('sim-sociedad');
  if (!sel || sel.options.length) return;
  _cloneSociedadOptions(sel);
  sel.value = 'sin_elche';
}

function _simMesDefault() {
  const el = $('sim-mes');
  if (!el || el.value) return;
  const d = new Date();
  el.value = d.toISOString().slice(0, 7);
}

async function loadSimLocal() {
  state.simLocal = state.simLocal || { closedSet: new Set(), rows: [] };
  _simSociedadOpts();
  _simMesDefault();
  const sociedad = $('sim-sociedad')?.value || '';
  const mes = $('sim-mes')?.value || '';
  const params = new URLSearchParams();
  if (sociedad) params.set('sociedad_id', sociedad);
  if (mes) {
    const [y, m] = mes.split('-').map(Number);
    params.set('desde', mes + '-01');
    params.set('hasta', mes + '-' + String(new Date(y, m, 0).getDate()).padStart(2, '0'));
  }
  try {
    const j = await api('/api/v1/bancos/simulador-local?' + params.toString());
    state.simLocal.rows = j.locales || [];
    state.simLocal.neto_operativo = j.neto_operativo || 0;
    state.simLocal.loaded = true;
    // Preservar closedSet del render anterior si los locales aún están.
    const validIds = new Set(state.simLocal.rows.map((l) => l.local_id));
    for (const id of state.simLocal.closedSet) if (!validIds.has(id)) state.simLocal.closedSet.delete(id);
    renderSimLocal();
  } catch (e) {
    $('sim-tbody').innerHTML = `<tr><td colspan="11" style="padding:20px;text-align:center;color:#dc2626">Error: ${e.message}</td></tr>`;
  }
}

// Calcula MP/evitable/aporte usando los VALORES EDITADOS EN VIVO
// (leídos del input directo). Esto permite recalcular sin refetch.
function _simComputeRow(row) {
  const inputVal = (id, fallback) => {
    const el = document.getElementById(id);
    if (!el) return fallback;
    const v = Number(el.value);
    return Number.isFinite(v) ? v : fallback;
  };
  const fid = 'sim-' + row.local_id;
  const fac = inputVal(fid + '-fac', row.facturacion_override != null ? row.facturacion_override : row.facturacion_auto);
  const pers = inputVal(fid + '-pers', row.personal_ss || 0);
  const alq = inputVal(fid + '-alq', row.alquiler || 0);
  const sum = inputVal(fid + '-sum', row.suministros || 0);
  const pctMp = inputVal(fid + '-pmp', row.pct_mp);
  const pctPersEv = inputVal(fid + '-ppe', row.pct_personal_evitable);
  const mp = fac * (pctMp / 100);
  const persEvit = pers * (pctPersEv / 100);
  const totalEvit = mp + persEvit + alq + sum;
  const aporte = fac - totalEvit;
  return { fac, pers, alq, sum, pctMp, pctPersEv, mp, persEvit, totalEvit, aporte };
}

function renderSimLocal() {
  const s = state.simLocal;
  if (!s?.rows) return;
  const tbody = $('sim-tbody');
  if (!s.rows.length) { tbody.innerHTML = '<tr><td colspan="11" style="padding:20px;text-align:center;color:var(--text-2)">Sin locales en este filtro.</td></tr>'; return; }
  const num = (v) => v == null ? '' : Number(v);
  tbody.innerHTML = s.rows.map((r) => {
    const fid = 'sim-' + r.local_id;
    const isClosed = s.closedSet.has(r.local_id);
    const facVal = r.facturacion_override != null ? r.facturacion_override : r.facturacion_auto;
    return `<tr data-lid="${r.local_id}" style="border-bottom:.5px solid var(--border-3);${isClosed ? 'background:rgba(220,38,38,.06)' : ''}">
      <td style="padding:5px 4px;text-align:center">
        <input type="checkbox" id="${fid}-close" ${isClosed ? 'checked' : ''} onchange="onSimToggleClose('${r.local_id}', this.checked)">
      </td>
      <td style="padding:5px 4px">
        <div style="font-weight:500">${r.nombre_display}</div>
        <div style="font-size:9px;color:var(--text-2)">${r.sociedad_id}${r.n_cierres_tpv ? ' · ' + r.n_cierres_tpv + ' cierres TPV' : ''}</div>
      </td>
      <td style="padding:5px 4px;text-align:right">
        <input type="number" id="${fid}-fac" step="1" value="${num(facVal)}" onchange="onSimEdit('${r.local_id}','facturacion_override', this.value)" oninput="_recalcSimRow('${r.local_id}')" style="width:90px;padding:3px 5px;border:.5px solid var(--border-3);border-radius:3px;background:var(--bg);color:var(--text);text-align:right;font-size:11px" title="Auto TPV: €${(r.facturacion_auto||0).toFixed(2)}">
        <div id="${fid}-fac-hint" style="font-size:9px;color:var(--text-2)">auto: €${(r.facturacion_auto||0).toFixed(0)}</div>
      </td>
      <td style="padding:5px 4px;text-align:right">
        <input type="number" id="${fid}-pers" step="1" value="${num(r.personal_ss)}" onchange="onSimEdit('${r.local_id}','personal_ss', this.value)" oninput="_recalcSimRow('${r.local_id}')" style="width:80px;padding:3px 5px;border:.5px solid var(--border-3);border-radius:3px;background:var(--bg);color:var(--text);text-align:right;font-size:11px" placeholder="—">
      </td>
      <td style="padding:5px 4px;text-align:right">
        <input type="number" id="${fid}-alq" step="1" value="${num(r.alquiler)}" onchange="onSimEdit('${r.local_id}','alquiler', this.value)" oninput="_recalcSimRow('${r.local_id}')" style="width:70px;padding:3px 5px;border:.5px solid var(--border-3);border-radius:3px;background:var(--bg);color:var(--text);text-align:right;font-size:11px" placeholder="—">
      </td>
      <td style="padding:5px 4px;text-align:right">
        <input type="number" id="${fid}-sum" step="1" value="${num(r.suministros)}" onchange="onSimEdit('${r.local_id}','suministros', this.value)" oninput="_recalcSimRow('${r.local_id}')" style="width:70px;padding:3px 5px;border:.5px solid var(--border-3);border-radius:3px;background:var(--bg);color:var(--text);text-align:right;font-size:11px" placeholder="—">
      </td>
      <td style="padding:5px 4px;text-align:right">
        <input type="number" id="${fid}-pmp" step="0.5" min="0" max="100" value="${r.pct_mp}" onchange="onSimEdit('${r.local_id}','pct_mp', this.value)" oninput="_recalcSimRow('${r.local_id}')" style="width:52px;padding:3px 5px;border:.5px solid var(--border-3);border-radius:3px;background:var(--bg);color:var(--text);text-align:right;font-size:11px">
      </td>
      <td style="padding:5px 4px;text-align:right">
        <input type="number" id="${fid}-ppe" step="5" min="0" max="100" value="${r.pct_personal_evitable}" onchange="onSimEdit('${r.local_id}','pct_personal_evitable', this.value)" oninput="_recalcSimRow('${r.local_id}')" style="width:52px;padding:3px 5px;border:.5px solid var(--border-3);border-radius:3px;background:var(--bg);color:var(--text);text-align:right;font-size:11px">
      </td>
      <td id="${fid}-mp" style="padding:5px 4px;text-align:right;color:var(--text-2)">—</td>
      <td id="${fid}-tot" style="padding:5px 4px;text-align:right;color:var(--text-2)">—</td>
      <td id="${fid}-aporte" style="padding:5px 4px;text-align:right;font-weight:600">—</td>
    </tr>`;
  }).join('');
  // Primer render de todos los cálculos.
  for (const r of s.rows) _recalcSimRow(r.local_id);
  _recalcSimTotales();
}

function _recalcSimRow(localId) {
  const s = state.simLocal;
  if (!s?.rows) return;
  const row = s.rows.find((x) => x.local_id === localId);
  if (!row) return;
  const c = _simComputeRow(row);
  const eur = (v) => '€' + (v || 0).toLocaleString('es-ES', { maximumFractionDigits: 0 });
  const fid = 'sim-' + localId;
  const el = (id) => document.getElementById(id);
  if (el(fid + '-mp'))     el(fid + '-mp').textContent = eur(c.mp);
  if (el(fid + '-tot'))    el(fid + '-tot').textContent = eur(c.totalEvit);
  const apEl = el(fid + '-aporte');
  if (apEl) {
    apEl.textContent = (c.aporte >= 0 ? '+' : '') + eur(c.aporte).replace('€', '') + ' €';
    apEl.style.color = c.aporte >= 0 ? '#16a34a' : '#dc2626';
  }
  _recalcSimTotales();
}

function _recalcSimTotales() {
  const s = state.simLocal;
  if (!s) return;
  const netoActual = s.neto_operativo || 0;
  let deltaCerrar = 0;
  let nCerrar = 0;
  for (const r of s.rows) {
    if (!s.closedSet.has(r.local_id)) continue;
    nCerrar++;
    const c = _simComputeRow(r);
    // Cerrar un local le suma su aporte al neto CON SIGNO INVERTIDO.
    // Si aporte=+X, cerrar quita X del neto (empeora). Si aporte=-X,
    // cerrar suma X al neto (mejora).
    deltaCerrar -= c.aporte;
  }
  const netoSim = netoActual + deltaCerrar;
  const eur2 = (v) => (v >= 0 ? '+' : '') + '€' + Math.abs(v).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const na = $('sim-neto-actual');
  if (na) {
    na.textContent = eur2(netoActual);
    na.style.color = netoActual >= 0 ? '#16a34a' : '#dc2626';
  }
  const nc = $('sim-n-cerrar'); if (nc) nc.textContent = nCerrar;
  const dl = $('sim-delta');
  if (dl) {
    dl.textContent = nCerrar === 0 ? '—' : eur2(deltaCerrar);
    dl.style.color = deltaCerrar > 0 ? '#16a34a' : deltaCerrar < 0 ? '#dc2626' : 'var(--text-2)';
  }
  const ns = $('sim-neto-simulado');
  if (ns) {
    ns.textContent = eur2(netoSim);
    ns.style.color = netoSim >= 0 ? '#16a34a' : '#dc2626';
  }
}

function onSimToggleClose(localId, isClosed) {
  state.simLocal = state.simLocal || { closedSet: new Set() };
  if (isClosed) state.simLocal.closedSet.add(localId);
  else state.simLocal.closedSet.delete(localId);
  // Sombrear la fila.
  const tr = document.querySelector('#sim-tbody tr[data-lid="' + localId + '"]');
  if (tr) tr.style.background = isClosed ? 'rgba(220,38,38,.06)' : '';
  _recalcSimTotales();
}

// Save debounced por local × campo — cada 800ms tras el último cambio.
const _simSaveTimers = new Map();
function onSimEdit(localId, field, value) {
  const key = localId + ':' + field;
  clearTimeout(_simSaveTimers.get(key));
  const t = setTimeout(async () => {
    try {
      const body = {};
      body[field] = value === '' ? null : Number(value);
      const r = await api(`/api/v1/bancos/simulador-local/${localId}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      if (r.ok && r.row) {
        // Actualizar el state local para reflejar el valor persistido.
        const row = state.simLocal?.rows.find((x) => x.local_id === localId);
        if (row) {
          const numFields = new Set(['facturacion_override','personal_ss','alquiler','suministros','pct_mp','pct_personal_evitable']);
          if (numFields.has(field)) {
            row[field] = r.row[field] != null ? Number(r.row[field]) : null;
          } else row[field] = r.row[field];
        }
        Api.pill && Api.pill('Guardado ' + localId, { ms: 900 });
      }
    } catch (e) {
      console.error('save simulador-local', e);
      Api.pill && Api.pill('Error al guardar: ' + e.message, { kind: 'error' });
    }
  }, 800);
  _simSaveTimers.set(key, t);
}

// ─── Panel de INGRESOS/EGRESOS EXTRAORDINARIOS ──────────────────────
// Muestra los movs marcados como extraordinarios en el período, con
// motivo. Toggle "Incluir extraordinarios en el neto" cambia el KPI
// de arriba (default OFF = resultado OPERATIVO real). Botón por mov
// para desmarcar.
function _renderFtExtraordinariosPanel(d) {
  const el = $('ft-extra-panel');
  if (!el) return;
  const extras = d?.extraordinarios;
  if (!extras || !extras.n) { el.style.display = 'none'; el.innerHTML = ''; return; }
  el.style.display = '';
  const isAdmin = esAdminLikeFront ? esAdminLikeFront() : true;
  const showExtra = !!state.flujoTotal?.showExtra;
  const totalIng = extras.total_ingresos || 0;
  const totalEgr = extras.total_egresos || 0;
  el.innerHTML = `
    <div class="card" style="border-left:3px solid #d97706">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:8px">
        <div>
          <p style="font-size:12px;font-weight:600;color:#d97706">⭐ Extraordinarios excluidos del operativo</p>
          <p style="font-size:11px;color:var(--text-2);margin-top:2px">
            ${extras.n} movimiento${extras.n === 1 ? '' : 's'}
            ${totalIng > 0 ? ` · Ingresos €${totalIng.toLocaleString('es-ES',{minimumFractionDigits:2})}` : ''}
            ${totalEgr > 0 ? ` · Egresos €${totalEgr.toLocaleString('es-ES',{minimumFractionDigits:2})}` : ''}
          </p>
        </div>
        <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text)">
          <input type="checkbox" ${showExtra ? 'checked' : ''} onchange="toggleFtShowExtra(this.checked)">
          Incluir extraordinarios en el neto
        </label>
      </div>
      <div style="border-top:.5px solid var(--border-3);padding-top:6px">
        ${extras.movs.slice(0, 20).map((m) => {
          const impColor = (m.importe||0) >= 0 ? '#16a34a' : '#dc2626';
          return `<div style="display:flex;align-items:center;gap:6px;padding:5px 4px;font-size:11px;border-bottom:.5px dashed var(--border-3)">
            <span style="color:var(--text-2);min-width:80px">${m.fecha}</span>
            <span style="color:var(--text-2);min-width:70px">${m.sociedad_id||''}</span>
            <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${(m.concepto||'').replace(/"/g,'&quot;')}">${(m.concepto||'').slice(0,90)}</span>
            <span style="font-weight:500;color:${impColor};min-width:90px;text-align:right">€${(m.importe||0).toLocaleString('es-ES',{minimumFractionDigits:2})}</span>
            ${isAdmin ? `<button onclick="unmarkExtraordinario(${m.id})" style="font-size:9px;padding:2px 6px;border:.5px solid var(--border-2);background:transparent;color:var(--text-2);border-radius:3px;cursor:pointer" title="Quitar la marca de extraordinario">✕</button>` : ''}
          </div>
          ${m.motivo ? `<p style="font-size:10px;color:var(--text-2);font-style:italic;padding:2px 4px 6px">→ ${(m.motivo||'').replace(/[<>]/g,'')}</p>` : ''}`;
        }).join('')}
      </div>
    </div>`;
}

function toggleFtShowExtra(on) {
  state.flujoTotal = state.flujoTotal || {};
  state.flujoTotal.showExtra = !!on;
  renderFlujoTotal();
}

async function markExtraordinario(movId, motivo) {
  if (!movId) return;
  try {
    const r = await api(`/api/v1/bancos/movimientos/${movId}/extraordinario`, {
      method: 'POST',
      body: JSON.stringify({ es_extraordinario: true, motivo: motivo || null }),
    });
    if (r.ok) {
      Api.pill && Api.pill('Marcado como extraordinario');
      loadFlujoTotal();
      // Refresh del sidebar si está abierto en el mismo origen.
      if (state._ftDrill?.kind === 'ingreso' && state._ftDrill.target) openFtIngresoDrill(state._ftDrill.target);
    }
  } catch (e) { alert('Error: ' + e.message); }
}

async function unmarkExtraordinario(movId) {
  if (!movId) return;
  if (!confirm('Quitar la marca de extraordinario? Este ingreso volverá al operativo.')) return;
  try {
    const r = await api(`/api/v1/bancos/movimientos/${movId}/extraordinario`, {
      method: 'POST',
      body: JSON.stringify({ es_extraordinario: false }),
    });
    if (r.ok) { Api.pill && Api.pill('Marca quitada'); loadFlujoTotal(); }
  } catch (e) { alert('Error: ' + e.message); }
}

// ─── Drill-down desde Flujo Total (filas clickeables) ───────────────
// Al hacer click en una fila de "Ingresos por origen" (ej. Glovo) o
// "Egresos por categoría", abre el sidebar existente con la lista de
// TODOS los movimientos individuales que sumaron ese monto. Aplica
// los mismos filtros que /flujo-total: sociedad + período + exclusión
// de INTRAGRUPO + traspasos internos.
function _ftPeriodoParams(params) {
  const soc = $('ft-sociedad')?.value || '';
  if (soc) params.set('sociedad_id', soc);
  const p = getPeriodoActivo();
  if (p.modo === 'rango') {
    if (p.desde) params.set('desde', p.desde + '-01');
    if (p.hasta) { const [y,m]=p.hasta.split('-').map(Number); params.set('hasta', p.hasta + '-' + String(new Date(y,m,0).getDate()).padStart(2,'0')); }
  } else if (p.periodo) {
    const [y,m]=p.periodo.split('-').map(Number);
    params.set('desde', p.periodo + '-01');
    params.set('hasta', p.periodo + '-' + String(new Date(y,m,0).getDate()).padStart(2,'0'));
  }
}

async function openFtIngresoDrill(origen) {
  $('prov-sb-title').textContent = 'Ingreso · ' + origen;
  $('prov-sb-meta').textContent = 'Cargando…';
  $('prov-sb-body').innerHTML = '<p style="padding:10px;color:var(--text-2);font-size:11px">Cargando…</p>';
  document.body.classList.add('sidebar-open');
  try {
    const params = new URLSearchParams();
    params.set('origen', origen);
    _ftPeriodoParams(params);
    const j = await api('/api/v1/caja/flujo-total/movs-origen?' + params.toString());
    const movs = j.movimientos || [];
    $('prov-sb-meta').textContent = `${j.n_banco} banco + ${j.n_caja} efectivo · Total €${(j.total||0).toLocaleString('es-ES',{minimumFractionDigits:2})}`;
    state._ftDrill = { kind: 'ingreso', target: origen, movs, total: j.total, q: '' };
    if (!movs.length) { $('prov-sb-body').innerHTML = '<p style="padding:20px;text-align:center;color:var(--text-2);font-size:12px">Sin movimientos.</p>'; return; }
    $('prov-sb-body').innerHTML = `
      ${renderSearchBox({ id: 'ft-drill-search', placeholder: 'Buscar concepto / sociedad / banco…', oninput: 'onFtDrillFilter' })}
      <p id="ft-drill-counter" style="font-size:11px;color:var(--text-2);margin-bottom:8px">${movs.length} movimientos.</p>
      <div id="ft-drill-list"></div>`;
    _renderFtDrillList();
  } catch (e) {
    $('prov-sb-body').innerHTML = `<p style="padding:10px;color:#dc2626;font-size:11px">Error: ${e.message}</p>`;
  }
}

async function openFtEgresoDrill(categoria) {
  $('prov-sb-title').textContent = 'Egreso · ' + categoria;
  $('prov-sb-meta').textContent = 'Cargando…';
  $('prov-sb-body').innerHTML = '<p style="padding:10px;color:var(--text-2);font-size:11px">Cargando…</p>';
  document.body.classList.add('sidebar-open');
  try {
    const params = new URLSearchParams();
    params.set('categoria', categoria);
    _ftPeriodoParams(params);
    const j = await api('/api/v1/caja/flujo-total/movs-categoria?' + params.toString());
    if (j.error === '2fa_required') { $('prov-sb-body').innerHTML = renderAccesoRestringidoHTML ? renderAccesoRestringidoHTML(j) : '<p style="padding:10px;color:#dc2626">Acceso restringido</p>'; return; }
    const movs = j.movimientos || [];
    $('prov-sb-meta').textContent = `${j.n_banco} banco + ${j.n_caja} efectivo · Total €${(j.total||0).toLocaleString('es-ES',{minimumFractionDigits:2})}`;
    state._ftDrill = { kind: 'egreso', target: categoria, movs, total: j.total, q: '' };
    if (!movs.length) { $('prov-sb-body').innerHTML = '<p style="padding:20px;text-align:center;color:var(--text-2);font-size:12px">Sin movimientos.</p>'; return; }
    $('prov-sb-body').innerHTML = `
      ${renderSearchBox({ id: 'ft-drill-search', placeholder: 'Buscar concepto / sociedad / banco…', oninput: 'onFtDrillFilter' })}
      <p id="ft-drill-counter" style="font-size:11px;color:var(--text-2);margin-bottom:8px">${movs.length} movimientos.</p>
      <div id="ft-drill-list"></div>`;
    _renderFtDrillList();
  } catch (e) {
    if (e.status === 403) { $('prov-sb-body').innerHTML = renderAccesoRestringidoHTML ? renderAccesoRestringidoHTML(e.json||{}) : '<p style="padding:10px;color:#dc2626">Acceso restringido</p>'; return; }
    $('prov-sb-body').innerHTML = `<p style="padding:10px;color:#dc2626;font-size:11px">Error: ${e.message}</p>`;
  }
}

function onFtDrillFilter(val) {
  if (!state._ftDrill) return;
  state._ftDrill.q = val || '';
  _renderFtDrillList();
}

function _renderFtDrillList() {
  const ctx = state._ftDrill;
  if (!ctx) return;
  const list = $('ft-drill-list');
  if (!list) return;
  const q = normalizeForSearch(ctx.q);
  const all = ctx.movs;
  const view = q
    ? all.filter((m) => {
        const hay = normalizeForSearch(m.concepto || m.subtipo || m.observaciones || '') + ' ' +
                    normalizeForSearch(m.sociedad_id || '') + ' ' +
                    normalizeForSearch(m.banco || m.sucursal || '');
        return hay.includes(q);
      })
    : all;
  const cnt = $('ft-drill-counter');
  if (cnt) {
    const subtotal = view.reduce((s, x) => s + Math.abs(x.importe || 0), 0);
    cnt.innerHTML = `${view.length}/${all.length} movs · <strong style="color:${ctx.kind === 'ingreso' ? '#16a34a' : '#dc2626'}">€${subtotal.toLocaleString('es-ES',{minimumFractionDigits:2})}</strong> visibles`;
  }
  if (!view.length) { list.innerHTML = '<p style="padding:14px;text-align:center;color:var(--text-2);font-size:11px">Sin coincidencias.</p>'; return; }
  const isAdmin = esAdminLikeFront ? esAdminLikeFront() : true;
  const kind = ctx.kind;
  list.innerHTML = view.map((m) => {
    const fuente = m.fuente === 'banco'
      ? `<span style="font-size:9px;padding:1px 5px;border-radius:6px;background:rgba(24,95,165,.15);color:#185FA5">banco</span>`
      : `<span style="font-size:9px;padding:1px 5px;border-radius:6px;background:rgba(167,139,250,.18);color:#7C3AED">efectivo</span>`;
    const label = m.fuente === 'banco'
      ? (m.concepto || '')
      : (m.subtipo || '') + (m.observaciones ? ' · ' + m.observaciones : '');
    const bancoLabel = m.fuente === 'banco' ? (m.banco || '') : (m.sucursal || '');
    const impColor = (m.importe || 0) >= 0 ? '#16a34a' : '#dc2626';
    // Botón "⭐" para marcar como extraordinario (solo ingresos de banco, admin only).
    // Si ya es extraordinario, mostrar badge en vez del botón.
    const canMark = isAdmin && m.fuente === 'banco' && kind === 'ingreso';
    const markCell = m.es_extraordinario
      ? `<span title="Extraordinario · ${(m.extraordinario_motivo||'').replace(/"/g,'&quot;')}" style="font-size:9px;padding:1px 5px;border-radius:6px;background:rgba(217,119,6,.18);color:#d97706;flex-shrink:0">⭐ extra</span>`
      : (canMark ? `<button onclick="_promptMarkExtra(${m.id})" title="Marcar este ingreso como extraordinario (se excluye del operativo)" style="flex-shrink:0;font-size:9px;padding:1px 5px;border-radius:4px;border:.5px solid var(--border-3);background:transparent;color:var(--text-2);cursor:pointer">⭐</button>` : '');
    return `<div style="display:flex;align-items:center;gap:6px;padding:6px 4px;border-bottom:.5px solid var(--border-3);font-size:11px">
      <div style="flex-shrink:0;color:var(--text-2);min-width:76px">${m.fecha || ''}</div>
      <div style="flex-shrink:0">${fuente}</div>
      <div style="flex-shrink:0;color:var(--text-2);min-width:82px">${(m.sociedad_id||'').padEnd(8)} · ${bancoLabel}</div>
      <div style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${(label||'').replace(/"/g,'&quot;')}">${label}</div>
      <div style="flex-shrink:0;font-weight:500;color:${impColor};min-width:88px;text-align:right">€${(m.importe||0).toLocaleString('es-ES',{minimumFractionDigits:2})}</div>
      ${markCell}
    </div>`;
  }).join('');
}

function _promptMarkExtra(movId) {
  const motivo = prompt('Motivo (opcional): ej. "Factura Glovo abril, cobrada atrasada" / "Venta de activo" / "Indemnización"');
  if (motivo === null) return;  // cancel
  markExtraordinario(movId, motivo.trim() || null);
}

Object.assign(window, {
  openFtIngresoDrill, openFtEgresoDrill, onFtDrillFilter,
  toggleFtShowExtra, markExtraordinario, unmarkExtraordinario, _promptMarkExtra,
  loadSimLocal, renderSimLocal, onSimToggleClose, onSimEdit, _recalcSimRow,
  reload, showTab, toggleUpload, uploadCierres, loadMovs, changePage, exportCsv, logout,
  // Selector global de período (Mes único / Rango)
  setFiltroModo,
  // Carga múltiple de extractos (Santander/Sabadell, XLS/PDF)
  upExtDragOver, upExtDragLeave, upExtDrop, upExtFilesChosen, upExtRetry,
  // Flujo Anual (admin/socio/gerente)
  loadFlujoAnual, renderFlujoComparativa, setFlujoVista,
  // Caja / Efectivo (admin/socio/gerente)
  loadCaja, setCajaVista,
  // Flujo Total — banco + efectivo unidos (admin/socio/gerente)
  loadFlujoTotal,
  // Donut combinado (sección dentro de Flujo Total)
  setDcFuente, renderDonutCombinado, openDcSidebar, openDcMovs, exportDonutCombinadoCsv, loadDonutCombinado,
  // Buscadores del drill-down DC (nivel proveedores + nivel movimientos)
  onDcProvsFilter, onDcMovsFilter,
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
  // Editor de mapeo subtipos caja → categoría banco (admin/socio)
  loadMapeosCaja, saveMapeosCaja, renderMapeosTable, mcPendSelAll,
  applyBulkMapeo, mcNuevaRegla,
  // Editor de mapeo cajas → sociedad SL (admin/socio)
  loadMapeoSociedades, saveMapeoSociedades, renderMapeoSociedadesTable,
  msSelAll, applyBulkSociedad,
  // Botón "Mover proveedor a otra categoría" en el drill-down del donut
  openMoverProveedor, previewMoverProveedor, confirmMoverProveedor,
  // Upload de archivo de cajas en el tab Efectivo
  cajaUploadDrop, cajaUploadChosen, uploadCajaFile,
});
boot();
