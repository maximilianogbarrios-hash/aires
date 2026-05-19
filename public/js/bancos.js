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
};

const PERIOD_LABELS = (p) => {
  if (!p) return '';
  const [y, m] = p.split('-').map(Number);
  const meses = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  return `${meses[m-1]} ${y}`;
};

const COLORS_CAT = [
  '#185FA5','#639922','#BA7517','#A32D2D','#7C3AED','#DB2777','#0891B2','#D97706',
  '#059669','#DC2626','#0F766E','#9333EA','#B45309','#1E40AF','#15803D','#9F1239',
];

let chMensual = null, chGastos = null;

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
    $('tb-user').textContent = `${me.user.email} (${me.user.role})`;
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

  // Categorías
  const cats = [
    'INGRESO_GLOVO','INGRESO_JUST_EAT','INGRESO_BIZUM','INGRESO_STRIPE','INGRESO_TRANSFERENCIA','INGRESO_OTROS',
    'GASTO_CARNICAS','GASTO_MAKRO','GASTO_DISTRIBUCIONES_BATOY','GASTO_COCA_COLA','GASTO_HANGUS',
    'GASTO_EUROFRITS','GASTO_ACEITES','GASTO_ELAN_FOODS','GASTO_KAUAPACK','GASTO_ENTREPINARES',
    'GASTO_LUZ','GASTO_AGUA','GASTO_INTERNET','GASTO_ALQUILER',
    'GASTO_SS_TGSS','GASTO_NOMINAS','GASTO_HACIENDA','GASTO_PUBLICIDAD','GASTO_SEGUROS','GASTO_SGAE',
    'GASTO_PRESTAMO_INTERGRUPO','GASTO_OTROS',
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
  $('tb-mov').innerHTML = j.rows.map((m) => `<tr>
    <td style="font-size:11px">${m.fecha}</td>
    <td style="font-size:12px">${m.concepto}</td>
    <td style="text-align:right;font-weight:500;color:${m.importe >= 0 ? '#16a34a' : '#dc2626'}">${eur2(m.importe)}</td>
    <td style="font-size:11px">${m.categoria || ''}</td>
    <td style="font-size:11px">${m.local_id || ''}</td>
    <td style="font-size:11px">${m.codigo_banco || ''}</td>
  </tr>`).join('');
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
}

// ─── Tabs ──────────────────────────────────────────────────────────────
function showTab(name, btn) {
  document.querySelectorAll('.sect').forEach((s) => s.classList.remove('on'));
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('on'));
  $(`sect-${name}`).classList.add('on');
  if (btn) btn.classList.add('on');
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

Object.assign(window, { reload, showTab, toggleUpload, uploadExtracto, uploadCierres, loadMovs, changePage, exportCsv, logout });
boot();
