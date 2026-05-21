// Módulo /bancos — orquestador de las 4 sub-tabs.

const $ = (id) => document.getElementById(id);
const eur = (v) => v == null ? '—' : new Intl.NumberFormat('es-ES', { style:'currency', currency:'EUR', maximumFractionDigits:0 }).format(Math.round(v));
const eur2 = (v) => v == null ? '—' : new Intl.NumberFormat('es-ES', { style:'currency', currency:'EUR', maximumFractionDigits:2 }).format(v);
const pct = (v) => v == null ? '—' : `${(v*100).toFixed(3).replace('.',',')}%`;
const clrG = (v) => v >= 0 ? 'var(--text-success)' : 'var(--text-danger)';

const state = {
  sociedades: [], direcciones: {}, periodos: [],
  current_sociedad: null, current_periodo: null,
  resumen: [], cruces: [], proveedores: [],
  movs: { total: 0, rows: [] }, mov_offset: 0, mov_limit: 50,
  prov: {
    rows: [], total: 0, intra: 0, n_intra: 0, loaded: false, vista: null,
    sort: { col: 'total_importe', dir: -1 },     // -1 desc, +1 asc
    donutThreshold: 0.01,                          // % mínimo de participación: 0.10|0.05|0.01|0.005|null (Ver todos)
    donutDrillOpen: false,                         // drill-down "Otros" abierto
    donutDrillRows: null,                          // filas que cayeron bajo el umbral
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
  try {
    const me = await api('/api/v1/auth/me');
    state.user = me.user;
    $('tb-user').textContent = `${me.user.email} (${me.user.role})`;
    // Vista dual: admin/socio ven "Todos los gastos"; resto ven "Proveedores operativos".
    aplicarVistaSegunRol();
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
}

function buildSelectors() {
  // Filtro principal sociedad
  const sels = [$('f-sociedad'), $('up-ext-soc')];
  sels.forEach((sel) => {
    sel.innerHTML = '';
    if (sel === $('f-sociedad')) {
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
  [$('m-local'), $('up-tpv-local')].forEach((sel) => {
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

function buildPeriodSelector() {
  const sel = $('f-periodo');
  sel.innerHTML = '';
  if (!state.periodos.length) {
    const opt = document.createElement('option');
    opt.value = ''; opt.textContent = '(sin datos)';
    sel.appendChild(opt);
    return;
  }
  const all = document.createElement('option');
  all.value = ''; all.textContent = '(todos)';
  sel.appendChild(all);
  for (const p of [...state.periodos].reverse()) {
    const opt = document.createElement('option');
    opt.value = p; opt.textContent = PERIOD_LABELS(p);
    sel.appendChild(opt);
  }
  // Por default el más reciente
  sel.value = state.periodos[state.periodos.length - 1];
}

async function reload() {
  state.current_sociedad = $('f-sociedad').value || null;
  state.current_periodo  = $('f-periodo').value || null;
  await Promise.all([loadResumen(), loadCruces(), loadProveedores(), loadMovs()]);
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

  // Donut por categoría
  const byCat = {};
  state.proveedores.forEach((p) => { byCat[p.categoria] = (byCat[p.categoria] || 0) + Math.abs(+p.total); });
  const sortedCats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  chGastos.data.labels = sortedCats.map((c) => c[0]);
  chGastos.data.datasets[0].data = sortedCats.map((c) => c[1]);
  chGastos.data.datasets[0].backgroundColor = sortedCats.map((_, i) => COLORS_CAT[i % COLORS_CAT.length]);
  chGastos.update();
  const totG = sortedCats.reduce((s, c) => s + c[1], 0);
  $('gastos-legend').innerHTML = sortedCats.map((c, i) => {
    const pctV = totG > 0 ? (c[1] / totG * 100).toFixed(1) : '0';
    return `<div style="display:flex;align-items:center;gap:6px;padding:3px 0">
      <span style="width:10px;height:10px;border-radius:2px;background:${COLORS_CAT[i % COLORS_CAT.length]};display:inline-block"></span>
      <span style="font-size:11px;flex:1">${c[0]}</span>
      <span style="font-size:11px;font-weight:500">${eur(c[1])}</span>
      <span style="font-size:11px;color:var(--text-2);min-width:36px;text-align:right">${pctV}%</span>
    </div>`;
  }).join('');

  // Top 50 proveedores
  $('tb-prov').innerHTML = state.proveedores.map((p) => {
    const total = Math.abs(+p.total);
    const promedio = total / Math.max(p.apariciones, 1);
    return `<tr>
      <td style="font-weight:500;font-size:12px">${p.proveedor || '—'}</td>
      <td style="font-size:11px">${p.categoria}</td>
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
  for (const id of ['prov-periodo-desde', 'prov-periodo-hasta']) {
    const sel = $(id);
    if (sel.options.length === 0) {
      for (const p of state.periodos) {
        const o = document.createElement('option');
        o.value = p; o.textContent = PERIOD_LABELS(p);
        sel.appendChild(o);
      }
    }
  }
  // Default: mes más reciente (=hasta) y 2 meses antes (=desde).
  if (state.periodos.length > 0) {
    const last = state.periodos[state.periodos.length - 1];
    const first = state.periodos.length >= 3 ? state.periodos[state.periodos.length - 3] : state.periodos[0];
    if (!$('prov-periodo-desde').value) $('prov-periodo-desde').value = first;
    if (!$('prov-periodo-hasta').value) $('prov-periodo-hasta').value = last;
  }
}

function rolEsAdmin() {
  return state.user && ['admin', 'socio'].includes(state.user.role);
}

function aplicarVistaSegunRol() {
  // Etiqueta visible que indica qué vista está activa (sin selector editable).
  const badge = $('prov-vista-badge');
  if (badge) {
    const txt = rolEsAdmin() ? 'Vista: Todos los gastos' : 'Vista: Proveedores operativos';
    badge.textContent = txt;
    badge.style.background = rolEsAdmin() ? '#F3E8FF' : '#EAF3DE';
    badge.style.color      = rolEsAdmin() ? '#7E22CE' : '#3B6D11';
  }
}

async function loadProvRanking() {
  const params = new URLSearchParams();
  const soc = $('prov-sociedad').value;
  const desde = $('prov-periodo-desde').value;
  const hasta = $('prov-periodo-hasta').value;
  if (soc) params.set('sociedad_id', soc);
  if (desde && hasta && desde === hasta) {
    params.set('periodo', desde);
  } else {
    if (desde) params.set('periodo_desde', desde);
    if (hasta) params.set('periodo_hasta', hasta);
  }
  // El backend filtra por rol; el front no envía vista (la deja en backend).
  const j = await api('/api/v1/bancos/proveedores?' + params.toString());
  state.prov = {
    rows: j.proveedores || [],
    total: j.total_gasto || 0,
    intra: j.total_excluido_intra_grupo || 0,
    n_intra: j.n_excluido_intra_grupo || 0,
    loaded: true,
    vista: j.vista_efectiva || (rolEsAdmin() ? 'admin' : 'operativo'),
  };
  aplicarVistaSegunRol();
  renderProvKpis();
  renderProvDonut();
  renderProvTabla();
}

// Exposición pública del nombre que usa el HTML.
function loadProveedoresTab() { return loadProvRanking(); }

function renderProvKpis() {
  $('prov-kpi-total').textContent = eur2(state.prov.total);
  $('prov-kpi-n').textContent = state.prov.rows.length;
  const top = state.prov.rows[0];
  $('prov-kpi-top').textContent = top ? `${top.proveedor} · ${eur2(top.total_importe)}` : '—';
  $('prov-kpi-intra').textContent = state.prov.n_intra > 0
    ? `${eur2(state.prov.intra)} en ${state.prov.n_intra} tx`
    : 'ninguna en este filtro';
}

function fmtThresholdPct(t) {
  if (t == null) return '';
  return (t * 100).toFixed(t < 0.01 ? 1 : 0).replace('.', ',');
}

function partitionByThreshold(rows, threshold) {
  // porcentaje viene del backend como fracción 0..1 (a.total / totalGasto).
  const above = rows.filter((r) => (r.porcentaje || 0) > threshold);
  const below = rows.filter((r) => (r.porcentaje || 0) <= threshold);
  return { above, below };
}

function renderProvDonut() {
  if (!chProvDonut) return;
  const rows = state.prov.rows;
  const threshold = state.prov.donutThreshold;
  const drillOpen = !!state.prov.donutDrillOpen;
  let labels = [], values = [], counts = [];
  let modeLbl = '';

  if (drillOpen && state.prov.donutDrillRows) {
    const drill = state.prov.donutDrillRows;
    labels = drill.map((r) => r.proveedor);
    values = drill.map((r) => r.total_importe);
    counts = drill.map((r) => r.num_transacciones);
    modeLbl = `(drill: ${drill.length} proveedores agrupados como "Otros")`;
  } else if (threshold == null) {
    labels = rows.map((r) => r.proveedor);
    values = rows.map((r) => r.total_importe);
    counts = rows.map((r) => r.num_transacciones);
    modeLbl = `(${rows.length} proveedores, completo)`;
  } else {
    const { above, below } = partitionByThreshold(rows, threshold);
    const belowTotal = below.reduce((s, r) => s + r.total_importe, 0);
    const belowCount = below.reduce((s, r) => s + r.num_transacciones, 0);
    labels = above.map((r) => r.proveedor);
    values = above.map((r) => r.total_importe);
    counts = above.map((r) => r.num_transacciones);
    if (below.length > 0) {
      labels.push(`Otros (${below.length})`);
      values.push(belowTotal);
      counts.push(belowCount);
    }
    modeLbl = `(> ${fmtThresholdPct(threshold)}% · ${above.length} + Otros)`;
  }

  const colors = labels.map((_, i) => COLORS_CAT[i % COLORS_CAT.length]);
  chProvDonut.data.labels = labels;
  chProvDonut.data.datasets[0].data = values;
  chProvDonut.data.datasets[0].backgroundColor = colors;
  chProvDonut._ntx = counts;
  chProvDonut.update();

  $('prov-donut-mode').textContent = modeLbl;
  // El <select> de umbral se mantiene en su valor actual; sólo lo
  // sincronizamos cuando setDonutThreshold lo recibe.
  $('btn-donut-back').style.display = drillOpen ? '' : 'none';
  $('prov-donut-hint').textContent = drillOpen
    ? `Drill-down activo: estos son los ${state.prov.donutDrillRows?.length || 0} proveedores debajo del umbral.`
    : (threshold == null
        ? 'Mostrando todos los proveedores como slices individuales.'
        : 'Proveedores por debajo del umbral se agrupan en "Otros (N)". Click ahí para drill-down.');

  const tot = state.prov.total;
  $('prov-legend').innerHTML = labels.map((lab, i) => {
    const v = values[i];
    const p = tot > 0 ? (v / tot * 100).toFixed(1) : '0';
    const isOtros = !drillOpen && lab.startsWith('Otros (');
    const labEsc = lab.replace(/'/g, "\\'");
    // Click en "Otros (N)" → drill. Click en cualquier otro grupo → sidebar de detalle.
    const onClick = isOtros ? `enterDonutDrill()` : `openProvSidebar('${labEsc}')`;
    return `<div onclick="${onClick}" style="display:flex;align-items:center;gap:6px;padding:3px 6px;cursor:pointer;border-radius:6px" onmouseover="this.style.background='var(--bg-secondary)'" onmouseout="this.style.background='transparent'">
      <span style="width:10px;height:10px;border-radius:2px;background:${colors[i]};flex-shrink:0;display:inline-block"></span>
      <span style="font-size:11px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${lab}">${lab}${isOtros ? ' →' : ''}</span>
      <span style="font-size:11px;font-weight:500">${eur(v)}</span>
      <span style="font-size:11px;color:var(--text-2);min-width:40px;text-align:right">${p}%</span>
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
  const { below } = partitionByThreshold(state.prov.rows, threshold);
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
  const operativo = state.prov.vista === 'operativo';
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

  $('tb-proveedores').innerHTML = rows.map((p, i) => {
    const catTxt = p.categoria || '';
    const catChip = `<span class="cat-chip" onclick="filterByCategoria('${catTxt.replace(/'/g, "&#39;")}')" style="font-size:11px;color:var(--text-2);cursor:pointer;text-decoration:underline dotted" title="Filtrar por esta categoría">${(catTxt || '').replace('PROVEEDOR_', '')}</span>`;
    const base = `<td style="font-size:11px;color:var(--text-2)">${i + 1}</td>
      <td style="font-weight:500;font-size:12px">${p.proveedor}</td>
      <td>${catChip}</td>
      <td style="text-align:right;color:#dc2626">${eur2(p.total_importe)}</td>
      <td style="text-align:right">${(p.porcentaje * 100).toFixed(2)}%</td>
      <td style="text-align:right">${p.num_transacciones}</td>`;
    if (operativo) {
      const last = (p.ultimo_pedido || '').slice(0, 10);
      return `<tr>${base}
        <td style="text-align:right;font-size:11px;color:var(--text-2)">${p.num_pedidos || 0}${last ? ' · ' + last : ''}</td>
      </tr>`;
    }
    return `<tr>${base}<td></td></tr>`;
  }).join('');
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
  const desde = $('prov-periodo-desde').value || '';
  const hasta = $('prov-periodo-hasta').value || '';
  const rango = desde === hasta ? desde : `${desde}_a_${hasta}`;
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
  document.querySelectorAll('.sect').forEach((s) => s.classList.remove('on'));
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('on'));
  $(`sect-${name}`).classList.add('on');
  if (btn) btn.classList.add('on');
  if (name === 'proveedores') {
    initProvFiltros();
    if (!state.prov.loaded) loadProvRanking();
    if (!evState.cargados) initEvolucion();
  }
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

async function uploadExtracto() {
  const f = $('up-ext-file').files[0];
  const soc = $('up-ext-soc').value;
  const msg = $('up-ext-msg');
  msg.textContent = '';
  if (!f) { msg.textContent = 'Elegí un archivo'; msg.style.color = '#dc2626'; return; }
  if (!soc) { msg.textContent = 'Elegí la sociedad'; msg.style.color = '#dc2626'; return; }
  msg.textContent = 'Subiendo y procesando…'; msg.style.color = 'var(--text-2)';
  try {
    const fd = new FormData();
    fd.append('file', f); fd.append('sociedad_id', soc); fd.append('banco', 'santander');
    const r = await fetch('/api/v1/bancos/upload-extracto', { method: 'POST', credentials: 'same-origin', body: fd });
    const j = await r.json();
    if (!r.ok) { msg.textContent = j.error || 'Error'; msg.style.color = '#dc2626'; return; }
    msg.innerHTML = `<span style="color:#16a34a">✓ ${j.insertadas} insertadas, ${j.duplicadas} duplicadas, ${j.skipped} omitidas.</span> Períodos: ${j.periodos.join(', ')}`;
    // Refresh
    const per = await api('/api/v1/bancos/periodos'); state.periodos = per.periodos || []; buildPeriodSelector();
    await reload();
  } catch (e) {
    msg.textContent = e.message; msg.style.color = '#dc2626';
  }
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
const CATEGORIAS_TODAS = [
  'IMPUESTOS','SS_LABORAL','NOMINAS','ALQUILER',
  'SUMINISTROS_LUZ','SUMINISTROS_GAS','SUMINISTROS_AGUA','TELECOMUNICACIONES',
  'PROVEEDOR_CARNES','PROVEEDOR_PANADERIA','PROVEEDOR_FRITAS','PROVEEDOR_LACTEOS',
  'PROVEEDOR_ACEITES','PROVEEDOR_BEBIDAS','PROVEEDOR_MAKRO','PROVEEDOR_LIMPIEZA',
  'PROVEEDOR_PACKAGING','PROVEEDOR_OTROS',
  'MANTENIMIENTO','SEGUROS','FINANCIERO','INTRAGRUPO','OTROS',
  'PUBLICIDAD','SERVICIOS_PROF','DELIVERY',
];

function buildGrupoDetalleQuery() {
  const params = new URLSearchParams();
  const soc = $('prov-sociedad')?.value;
  const desde = $('prov-periodo-desde')?.value;
  const hasta = $('prov-periodo-hasta')?.value;
  if (soc) params.set('sociedad_id', soc);
  if (desde && hasta && desde === hasta) params.set('periodo', desde);
  else {
    if (desde) params.set('periodo_desde', desde);
    if (hasta) params.set('periodo_hasta', hasta);
  }
  return params;
}

async function openProvSidebar(grupo) {
  if (!grupo) return;
  $('prov-sb-title').textContent = grupo;
  $('prov-sb-meta').textContent = 'Cargando…';
  $('prov-sb-body').innerHTML = '';
  $('prov-sidebar-backdrop').style.display = '';
  $('prov-sidebar').style.display = '';
  try {
    const params = buildGrupoDetalleQuery();
    params.set('grupo', grupo);
    const j = await api('/api/v1/bancos/grupo-detalle?' + params.toString());
    state._sbData = j;
    const tot = j.total || 0;
    const totProvTab = state.prov.total || 1;
    $('prov-sb-meta').textContent = `${eur2(tot)} · ${j.num_conceptos} conceptos · ${((tot/totProvTab)*100).toFixed(1)}% del gasto filtrado`;
    renderProvSidebarRows(j.conceptos);
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

function renderProvSidebarRows(conceptos) {
  const body = $('prov-sb-body');
  body.innerHTML = conceptos.map((c, i) => {
    const conceptoEsc = (c.concepto || '').replace(/"/g, '&quot;');
    return `<div data-row="${i}" style="border:.5px solid var(--border-3);border-radius:8px;padding:8px 10px;margin-bottom:8px">
      <div style="display:flex;gap:8px;align-items:flex-start">
        <div style="flex:1;min-width:0">
          <p style="font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${conceptoEsc}">${c.concepto}</p>
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
          <input type="text" id="rc-name-${i}" value="${(state._sbData?.grupo || '').replace(/"/g, '&quot;')}" style="padding:5px 8px;border:.5px solid var(--border-2);border-radius:6px;background:var(--bg-secondary);color:var(--text);font-size:11px">
          <label style="grid-column:1/-1;display:flex;align-items:center;gap:6px;cursor:pointer">
            <input type="checkbox" id="rc-rule-${i}">
            <span>Aplicar a futuros extractos (guardar regla)</span>
          </label>
        </div>
        <div style="display:flex;gap:6px;margin-top:10px;justify-content:flex-end">
          <button onclick="toggleReclasificar(${i})" style="padding:5px 10px;border:.5px solid var(--border-2);border-radius:6px;background:transparent;color:var(--text);cursor:pointer;font-size:11px">Cancelar</button>
          <button onclick="confirmReclasificar(${i})" style="padding:5px 12px;border:none;border-radius:6px;background:#185FA5;color:#fff;cursor:pointer;font-size:11px;font-weight:500">Confirmar</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

function toggleReclasificar(i) {
  const form = $(`rc-form-${i}`);
  if (!form) return;
  const open = form.style.display !== 'none';
  form.style.display = open ? 'none' : '';
  const btn = $(`rc-btn-${i}`);
  if (btn) btn.textContent = open ? 'Reclasificar' : 'Cerrar';
}

async function confirmReclasificar(i) {
  const concepto = state._sbData?.conceptos?.[i]?.concepto;
  if (!concepto) return;
  const categoria_nueva = $(`rc-cat-${i}`)?.value;
  const proveedor_nuevo = $(`rc-name-${i}`)?.value?.trim();
  const guardar_regla = !!$(`rc-rule-${i}`)?.checked;
  if (!categoria_nueva || !proveedor_nuevo) {
    Api.pill('Categoría y nombre requeridos', true);
    return;
  }
  try {
    const j = await api('/api/v1/bancos/reclasificar', {
      method: 'POST',
      body: JSON.stringify({ concepto, categoria_nueva, proveedor_nuevo, guardar_regla }),
    });
    Api.pill(`Reclasificadas: ${j.affected}` + (j.regla_id ? ` · regla #${j.regla_id} creada` : ''));
    // Refresh donut + ranking, y el sidebar con el nuevo nombre si cambió.
    await loadProvRanking();
    if (proveedor_nuevo !== (state._sbData?.grupo || '')) {
      closeProvSidebar();
    } else {
      await openProvSidebar(proveedor_nuevo);
    }
  } catch (e) {
    Api.pill('Error: ' + e.message, true);
  }
}

Object.assign(window, {
  reload, showTab, toggleUpload, uploadExtracto, uploadCierres, loadMovs, changePage, exportCsv, logout,
  loadProvRanking, exportProveedoresCsv,
  // Pestaña Proveedores
  sortProvTabla, filterByCategoria, resetProvTablaFiltros, renderProvTabla,
  setDonutThreshold, enterDonutDrill, exitDonutDrill,
  // Sidebar de detalle / reclasificación
  openProvSidebar, closeProvSidebar, toggleReclasificar, confirmReclasificar,
  // Evolución temporal
  loadEvolucion, evRenderSugerencias, evSeleccionar, evQuitar, evAplicarTopMatch,
});
boot();
