// Aires Solo — dashboard orchestrator.
// Carga bootstrap, mantiene `ctx`, gestiona UI y persiste cambios vía Api.

const UI = window.UICONST;
const E = window.Engine;

// ─── State ──────────────────────────────────────────────────────────────
const ctx = {
  config: {},
  locales: [],
  h25: {},            // { localId: [12 valores 2025] }
  presupuestoMap: {}, // { localId: { fac_presupuestada, fac_real } } para mes activo
  presupuestoAll: [], // raw filas para reconstruir map al cambiar de mes
  user: null,
};

const uiState = {
  sortCol: 'mgP',
  sortDir: -1,
  selLoc: new Set(['ELCHE','SANTO_DOMINGO','BENIDORM','ARENALES','ALICANTE']),
  mesNavIdx: 12, // 0-11 = meses 2025, 12 = "Mi Análisis"
  presYear: 2026,
  presMonth: 5,
};

// ─── Charts ────────────────────────────────────────────────────────────
let chRes=null, chRank=null, chEvTot=null, chEvLoc=null, chDonut=null, chIncid=null;

// ─── Helpers ───────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const eur = (v) => v == null ? '—' : new Intl.NumberFormat('es-ES', { style:'currency', currency:'EUR', maximumFractionDigits:0 }).format(Math.round(v));
const pct = (v) => v == null ? '—' : `${(v*100).toFixed(1).replace('.',',')}%`;
const n0 = (v) => Math.round(v).toLocaleString('es-ES');
const clrG = (v) => v > 0 ? 'var(--text-success)' : 'var(--text-danger)';

function locById(id) { return ctx.locales.find((l) => l.id === id); }

// ─── Boot ──────────────────────────────────────────────────────────────
async function boot() {
  try {
    const data = await Api.bootstrap();
    ctx.config = withDefaults(data.config || {});
    ctx.locales = data.locales || [];
    ctx.user = data.user || null;
    // Build h25 from historial
    ctx.h25 = {};
    (data.historial || []).filter((h) => h.fuente === '2025_real' && h.anio === 2025).forEach((h) => {
      if (!ctx.h25[h.local_id]) ctx.h25[h.local_id] = new Array(12).fill(0);
      ctx.h25[h.local_id][h.mes - 1] = h.facturacion;
    });
    ctx.presupuestoAll = data.presupuesto || [];
    rebuildPresMap();
    setUserUI();
    initCharts();
    bindParamSliders();
    buildSrvTable();
    buildFacInputs();
    buildLocFilter();
    update();
  } catch (e) {
    console.error('[boot]', e);
    Api.pill('Error cargando datos', true);
  }
}

function withDefaults(cfg) {
  return {
    pctMP: 38, pctPersonal: 28, pctImpuestos: 2, pctPublicidad: 1.5, euroHora: 12,
    incluirGlovo: true, modoSociedad: false,
    poolGroups: ['A'], poolProduccion: 17530, poolEspeciales: 16440,
    ...cfg,
  };
}

function setUserUI() {
  if (!ctx.user) return;
  $('tb-user').textContent = `${ctx.user.email} (${ctx.user.role})`;
  if (ctx.user.role === 'admin') $('tb-admin-link').style.display = '';
}

async function logout() {
  try { await Api.logout(); } finally { location.href = '/login'; }
}

// ─── Presupuesto map por (año, mes) ───────────────────────────────────
function rebuildPresMap() {
  const y = uiState.presYear, m = uiState.presMonth;
  ctx.presupuestoMap = {};
  ctx.presupuestoAll.filter((r) => r.anio === y && r.mes === m).forEach((r) => {
    ctx.presupuestoMap[r.local_id] = {
      fac_presupuestada: r.fac_presupuestada,
      fac_real: r.fac_real,
    };
  });
}

function patchPresMap(localId, patch) {
  // refleja cambio en presupuestoAll y presupuestoMap
  const y = uiState.presYear, m = uiState.presMonth;
  let row = ctx.presupuestoAll.find((r) => r.local_id === localId && r.anio === y && r.mes === m);
  if (!row) {
    row = { local_id: localId, anio: y, mes: m, fac_presupuestada: null, fac_real: null };
    ctx.presupuestoAll.push(row);
  }
  Object.assign(row, patch);
  ctx.presupuestoMap[localId] = { fac_presupuestada: row.fac_presupuestada, fac_real: row.fac_real };
}

// ─── Bind sliders/toggles ──────────────────────────────────────────────
function bindParamSliders() {
  const cfg = ctx.config;
  $('sMP').value = cfg.pctMP;
  $('sPers').value = cfg.pctPersonal;
  $('sImp').value = cfg.pctImpuestos;
  $('sPub').value = cfg.pctPublicidad;
  $('sHora').value = cfg.euroHora;
  syncSliderLabels();
  ['A','B','C','D'].forEach((g) => { $(`pg-${g}`).checked = (cfg.poolGroups || []).includes(g); });
  $('tg-gon').classList.toggle('on', cfg.incluirGlovo);
  $('tg-goff').classList.toggle('on', !cfg.incluirGlovo);
}

function syncSliderLabels() {
  $('vMP').textContent = (+$('sMP').value).toFixed(1).replace('.',',') + '%';
  $('vPers').textContent = (+$('sPers').value).toFixed(1).replace('.',',') + '%';
  $('vImp').textContent = (+$('sImp').value).toFixed(1).replace('.',',') + '%';
  $('vPub').textContent = (+$('sPub').value).toFixed(1).replace('.',',') + '%';
  $('vHora').textContent = (+$('sHora').value).toFixed(2).replace('.',',') + ' €';
}

function syncSlider() {
  ctx.config.pctMP = +$('sMP').value;
  ctx.config.pctPersonal = +$('sPers').value;
  ctx.config.pctImpuestos = +$('sImp').value;
  ctx.config.pctPublicidad = +$('sPub').value;
  ctx.config.euroHora = +$('sHora').value;
  syncSliderLabels();
  buildSrvTable();
  update();
  Api.debouncedSave('config', () => Api.saveConfig({
    pctMP: ctx.config.pctMP,
    pctPersonal: ctx.config.pctPersonal,
    pctImpuestos: ctx.config.pctImpuestos,
    pctPublicidad: ctx.config.pctPublicidad,
    euroHora: ctx.config.euroHora,
  }));
}

function syncPool() {
  const arr = ['A','B','C','D'].filter((g) => $(`pg-${g}`).checked);
  ctx.config.poolGroups = arr;
  update();
  Api.debouncedSave('config.poolGroups', () => Api.saveConfig({ poolGroups: arr }));
}

function togGlovo(v) {
  ctx.config.incluirGlovo = v;
  $('tg-gon').classList.toggle('on', v);
  $('tg-goff').classList.toggle('on', !v);
  update();
  Api.debouncedSave('config.glovo', () => Api.saveConfig({ incluirGlovo: v }));
}

function setSoc(v) {
  ctx.config.modoSociedad = v;
  $('tb-soc').className = 'tgl' + (v ? ' on soc-on' : '');
  $('tb-com').classList.toggle('on', !v);
  $('soc-notice').style.display = v ? 'block' : 'none';
  buildLocFilter();
  update();
  Api.debouncedSave('config.modoSociedad', () => Api.saveConfig({ modoSociedad: v }));
}

// ─── Build editables ───────────────────────────────────────────────────
function buildSrvTable() {
  const tb = $('srv-table'); if (!tb) return;
  tb.innerHTML = ctx.locales.map((l) => {
    const alq = +l.alquiler || 0, sum_ = +l.suministros || 0;
    const fac = +l.fac_mi_analisis || 0;
    const ratio = fac > 0 ? alq/fac : 0;
    const ratioClr = ratio > 0.1 ? '#dc2626' : ratio > 0.07 ? '#BA7517' : '#16a34a';
    const bdg = l.dani_only ? 'E' : l.grupo;
    const bdgLbl = l.dani_only ? 'Dani' : l.grupo;
    return `<tr>
      <td style="font-weight:500">${l.nombre_display}</td>
      <td><span class="bdg b${bdg}">${bdgLbl}</span></td>
      <td style="text-align:right"><input class="num-inp" type="number" value="${alq}" min="0" step="50" onchange="updLocalField('${l.id}','alquiler',this.value)"></td>
      <td style="text-align:right"><input class="num-inp" type="number" value="${sum_}" min="0" step="50" onchange="updLocalField('${l.id}','suministros',this.value)"></td>
      <td style="text-align:right;font-weight:500">${eur(alq + sum_)}</td>
      <td style="text-align:right">${eur(fac)}</td>
      <td style="text-align:right;font-weight:500;color:${ratioClr}">${pct(ratio)}</td>
    </tr>`;
  }).join('');
}

function buildFacInputs() {
  $('fac-inputs').innerHTML = ctx.locales.map((l) => {
    const bdg = l.dani_only ? 'E' : l.grupo;
    const bdgLbl = l.dani_only ? 'D' : l.grupo;
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:3px 0;border-bottom:.5px solid var(--border-3)">
      <span style="font-size:11px"><span class="bdg b${bdg}" style="font-size:9px;margin-right:3px">${bdgLbl}</span>${l.short_name}</span>
      <input class="num-inp" style="width:75px" type="number" value="${+l.fac_mi_analisis || 0}" min="0" step="500" onchange="updLocalField('${l.id}','fac_mi_analisis',this.value)">
    </div>`;
  }).join('');
}

function buildLocFilter() {
  const avail = ctx.locales.filter((l) => !(ctx.config.modoSociedad && l.dani_only));
  $('loc-filter').innerHTML = avail.filter((l) => l.grupo === 'A' || l.grupo === 'B').map((l) => `
    <button class="tgl${uiState.selLoc.has(l.id) ? ' on' : ''}" style="font-size:10px;padding:2px 6px" onclick="togLoc('${l.id}')">${l.short_name}</button>
  `).join('');
}

// ─── Update handlers ───────────────────────────────────────────────────
function updLocalField(id, field, val) {
  const l = locById(id); if (!l) return;
  const num = (val === '' || val == null) ? null : Math.max(0, +val || 0);
  l[field] = num;
  buildSrvTable();
  update();
  Api.debouncedSave(`local.${id}.${field}`, () => Api.saveLocal(id, { [field]: num }));
}

function updHoras(id, val) {
  const l = locById(id); if (!l) return;
  const num = (val === '' || val == null) ? null : Math.max(0, +val || 0);
  l.horas_sem_override = num;
  update();
  Api.debouncedSave(`local.${id}.horas`, () => Api.saveLocal(id, { horas_sem_override: num }));
}

function togLoc(id) {
  if (uiState.selLoc.has(id)) uiState.selLoc.delete(id);
  else uiState.selLoc.add(id);
  buildLocFilter();
  updLocChart();
}

// ─── Charts init ───────────────────────────────────────────────────────
function initCharts() {
  const dk = matchMedia('(prefers-color-scheme:dark)').matches;
  const tc = dk ? '#9CA3AF' : '#6B7280';
  const gc = dk ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.06)';
  const base = {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { color: gc }, ticks: { color: tc, font: { size: 11 } } },
      y: { grid: { color: gc }, ticks: { color: tc, font: { size: 11 } } },
    },
  };
  chRes = new Chart($('ch-res'), {
    type: 'bar',
    data: { labels: [], datasets: [
      { label: 'Facturación', data: [], backgroundColor: [] },
      { label: 'Gastos', data: [], backgroundColor: [], borderWidth: 1, borderColor: [] },
    ] },
    options: { ...base, scales: { x: base.scales.x, y: { ...base.scales.y, ticks: { ...base.scales.y.ticks, callback: (v) => `${Math.round(v/1000)}K€` } } } },
  });
  chRank = new Chart($('ch-rank'), {
    type: 'bar',
    data: { labels: [], datasets: UI.COST_CLRS.map((bg, i) => ({ label: UI.COST_LBLS[i], data: [], backgroundColor: bg })) },
    options: { ...base, indexAxis: 'y',
      scales: {
        x: { ...base.scales.x, stacked: true, ticks: { ...base.scales.x.ticks, callback: (v) => `${Math.round(v/1000)}K` } },
        y: { ...base.scales.y, stacked: true },
      } },
  });
  chEvTot = new Chart($('ch-ev-tot'), {
    type: 'line',
    data: {
      labels: UI.HTOT_MENSUAL.map((h) => h.m),
      datasets: [{
        label: 'Total',
        data: UI.HTOT_MENSUAL.map((h) => h.t),
        borderColor: '#185FA5',
        backgroundColor: 'rgba(24,95,165,.07)',
        fill: true, tension: .35,
        pointRadius: UI.HTOT_MENSUAL.map((h) => h.y === 26 ? 5 : 2.5),
        pointBackgroundColor: UI.HTOT_MENSUAL.map((h) => h.y === 26 ? '#BA7517' : h.y === 25 ? '#185FA5' : '#B5D4F4'),
        pointBorderColor: UI.HTOT_MENSUAL.map((h) => h.y === 26 ? '#BA7517' : h.y === 25 ? '#185FA5' : '#B5D4F4'),
      }],
    },
    options: { ...base, scales: {
      x: { ...base.scales.x, ticks: { ...base.scales.x.ticks, maxRotation: 50, autoSkip: true, maxTicksLimit: 14 } },
      y: { ...base.scales.y, ticks: { ...base.scales.y.ticks, callback: (v) => `${Math.round(v/1000)}K` } },
    } },
  });
  chEvLoc = new Chart($('ch-ev-loc'), {
    type: 'line',
    data: { labels: UI.MESES, datasets: [] },
    options: { ...base, scales: {
      x: base.scales.x,
      y: { ...base.scales.y, ticks: { ...base.scales.y.ticks, callback: (v) => `${Math.round(v/1000)}K` } },
    } },
  });
  chDonut = new Chart($('ch-donut'), {
    type: 'doughnut',
    data: { labels: UI.COST_LBLS, datasets: [{ data: new Array(9).fill(0), backgroundColor: UI.COST_CLRS, borderWidth: 2, borderColor: 'var(--bg-primary)' }] },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => {
        const tot = c.dataset.data.reduce((s, v) => s + v, 0);
        return ` ${UI.COST_LBLS[c.dataIndex]}: ${eur(c.raw)} (${tot > 0 ? ((c.raw/tot)*100).toFixed(1) : '0'}%)`;
      } } } } },
  });
  chIncid = new Chart($('ch-incid'), {
    type: 'doughnut',
    data: { labels: [], datasets: [{ data: [], backgroundColor: [], borderWidth: 2, borderColor: 'var(--bg-primary)' }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: '60%',
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => {
        const tot = c.dataset.data.reduce((s, v) => s + v, 0);
        return ` ${c.label}: ${eur(c.raw)} (${tot > 0 ? ((c.raw/tot)*100).toFixed(1) : '0'}%)`;
      } } } } },
  });
}

// ─── Render ────────────────────────────────────────────────────────────
function update() {
  const R = E.calcAll(ctx);
  rKPIs(R);
  rResumen(R);
  rRanking(R);
  updCostos();
  updPresupuesto();
  rTrsp(R);
  updIncid();
}

function rKPIs(R) {
  const Ract = R.filter((r) => r.g !== 'D');
  const tF = Ract.reduce((s, r) => s + r.fac, 0);
  const tM = Ract.reduce((s, r) => s + r.mg, 0);
  const mP = tF > 0 ? tM / tF : 0;
  const via = Ract.filter((r) => r.mgP > 0.15).length;
  const hT = Ract.reduce((s, r) => s + r.hS, 0);
  $('k-fac').textContent = eur(tF);
  $('k-mg').textContent = eur(tM); $('k-mg').style.color = clrG(tM);
  $('k-mgp').textContent = pct(mP);
  $('k-via').textContent = `${via} / ${Ract.length}`;
  $('k-horas').textContent = n0(hT);
  $('k-horas-s').textContent = `a ${ctx.config.euroHora.toFixed(2).replace('.',',')} €/h`;
  $('hdr-fac').textContent = eur(tF);
  $('hdr-mg').textContent = `Margen: ${eur(tM)} (${pct(mP)})`;
  $('hdr-mg').style.color = clrG(tM);
  const nD = R.filter((r) => r.g === 'D').length;
  $('hdr-sub').textContent = `Mi Análisis · ${Ract.length} locales activos${nD ? ' (+ '+nD+' en salida)' : ''}${ctx.config.modoSociedad ? ' · Vista Sociedad' : ''}`;
}

function rResumen(R) {
  const sA = E.grpSum(R, ['A']);
  const sB = E.grpSum(R, ['B']);
  const sAB = E.grpSum(R, ['A','B']);
  const sC = E.grpSum(R, ['C']);
  const sD = E.grpSum(R, ['D']);
  const gc = (lbl, color, s, note='') => `<div class="grp-card" style="border-left-color:${color}">
    <p style="font-size:11px;color:${color};font-weight:500;margin-bottom:4px">${lbl} (${s.n})</p>
    <div style="display:flex;gap:.75rem;flex-wrap:wrap;align-items:baseline">
      <div><p style="font-size:10px;color:var(--text-2)">Facturación</p><p style="font-size:16px;font-weight:500">${eur(s.f)}</p></div>
      <div><p style="font-size:10px;color:var(--text-2)">Margen €</p><p style="font-size:16px;font-weight:500;color:${clrG(s.mg)}">${eur(s.mg)}</p></div>
      <div><p style="font-size:10px;color:var(--text-2)">Margen %</p><p style="font-size:16px;font-weight:500">${pct(s.mgP)}</p></div>
      <div><p style="font-size:10px;color:var(--text-2)">Horas/sem</p><p style="font-size:15px;font-weight:500">${n0(s.hT)}</p></div>
    </div>${note ? `<p style="font-size:11px;color:var(--text-2);margin-top:3px">${note}</p>` : ''}
  </div>`;
  const grpsEl = $('res-groups');
  grpsEl.style.gridTemplateColumns = 'repeat(auto-fit,minmax(210px,1fr))';
  grpsEl.innerHTML = gc('A — MANTENER', '#639922', sA)
    + gc('B — ANALIZAR', '#BA7517', sB, 'Locales en evaluación')
    + `<div class="soc-card"><p style="font-size:11px;color:#7E22CE;font-weight:500;margin-bottom:4px">A + B — SOCIEDAD (${sAB.n})</p>
      <div style="display:flex;gap:.75rem;flex-wrap:wrap;align-items:baseline">
        <div><p style="font-size:10px;color:var(--text-2)">Facturación</p><p style="font-size:17px;font-weight:500">${eur(sAB.f)}</p></div>
        <div><p style="font-size:10px;color:var(--text-2)">Margen €</p><p style="font-size:17px;font-weight:500;color:${clrG(sAB.mg)}">${eur(sAB.mg)}</p></div>
        <div><p style="font-size:10px;color:var(--text-2)">Margen %</p><p style="font-size:17px;font-weight:500">${pct(sAB.mgP)}</p></div>
        <div><p style="font-size:10px;color:var(--text-2)">Horas/sem</p><p style="font-size:16px;font-weight:500">${n0(sAB.hT)}</p></div>
      </div></div>`
    + gc('C — ESPECIAL', '#185FA5', sC)
    + gc('D — SALIDA', '#A32D2D', sD, 'Locales a traspasar');
  if (chRes) {
    chRes.data.labels = R.map((r) => r.s);
    chRes.data.datasets[0].data = R.map((r) => r.fac);
    chRes.data.datasets[0].backgroundColor = R.map((r) => UI.GC[r.g] + '99');
    chRes.data.datasets[1].data = R.map((r) => r.tG);
    chRes.data.datasets[1].backgroundColor = R.map((r) => UI.GC[r.g] + '44');
    chRes.data.datasets[1].borderColor = R.map((r) => UI.GC[r.g]);
    chRes.update();
    $('leg-res').innerHTML = `<span class="lbl"><span class="lbl-sq" style="background:rgba(99,153,34,.6)"></span>Facturación</span><span class="lbl"><span class="lbl-sq" style="background:rgba(99,153,34,.25)"></span>Total Gastos</span>`;
  }
  const ecHTML = ctx.config.modoSociedad ? elcheCard(E.calcElche(ctx)) : '';
  [$('res-elche'), $('rank-elche')].forEach((el) => { if (el) el.innerHTML = ecHTML; });
}

function elcheCard(r) {
  if (!r) return '';
  return `<div class="elche-banner">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:.75rem">
      <div><p style="font-size:11px;font-weight:500;color:#854F0B;margin-bottom:2px">LOCAL EXTERNO — SOLO DANI</p><p style="font-size:15px;font-weight:500">ELCHE</p></div>
      <span class="bdg b${r.estado[0] === 'V' ? 'V' : r.estado[0] === 'A' ? 'J' : 'P'}">${r.estado}</span>
    </div>
    <div class="g4" style="font-size:12px">
      <div><p style="color:var(--text-2)">Facturación</p><p style="font-weight:500">${eur(r.fac)}</p></div>
      <div><p style="color:var(--text-2)">Margen €</p><p style="font-weight:500;color:${clrG(r.mg)}">${eur(r.mg)}</p></div>
      <div><p style="color:var(--text-2)">Margen %</p><p style="font-weight:500">${pct(r.mgP)}</p></div>
      <div><p style="color:var(--text-2)">Horas/sem</p><p style="font-weight:500">${r.hS.toFixed(1)} h</p></div>
    </div>
  </div>`;
}

function rRanking(R) {
  // Resumen por grupo
  const rg = $('rank-grp');
  if (rg) {
    const sA = E.grpSum(R, ['A']);
    const sB = E.grpSum(R, ['B']);
    const sAB = E.grpSum(R, ['A','B']);
    const mkR = (lbl, color, s) => `<div class="grp-card" style="border-left-color:${color}">
      <p style="font-size:11px;color:${color};font-weight:500;margin-bottom:3px">${lbl} (${s.n})</p>
      <div style="display:flex;gap:.65rem;flex-wrap:wrap">
        <div><p style="font-size:10px;color:var(--text-2)">Fac.</p><p style="font-size:14px;font-weight:500">${eur(s.f)}</p></div>
        <div><p style="font-size:10px;color:var(--text-2)">Gastos</p><p style="font-size:14px;font-weight:500">${eur(s.tG)}</p></div>
        <div><p style="font-size:10px;color:var(--text-2)">Margen €</p><p style="font-size:14px;font-weight:500;color:${clrG(s.mg)}">${eur(s.mg)}</p></div>
        <div><p style="font-size:10px;color:var(--text-2)">%</p><p style="font-size:14px;font-weight:500">${pct(s.mgP)}</p></div>
        <div><p style="font-size:10px;color:var(--text-2)">H/sem</p><p style="font-size:14px;font-weight:500">${n0(s.hT)}</p></div>
      </div></div>`;
    rg.innerHTML = `<p style="font-size:11px;font-weight:500;color:var(--text-2);text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px">Resumen por grupo</p>
      <div style="display:grid;gap:8px">
        ${mkR('A — MANTENER', '#639922', sA)}${mkR('B — ANALIZAR', '#BA7517', sB)}
        <div class="soc-card"><p style="font-size:11px;color:#7E22CE;font-weight:500;margin-bottom:3px">A + B — SOCIEDAD (${sAB.n})</p>
        <div style="display:flex;gap:.65rem;flex-wrap:wrap">
          <div><p style="font-size:10px;color:var(--text-2)">Fac.</p><p style="font-size:14px;font-weight:500">${eur(sAB.f)}</p></div>
          <div><p style="font-size:10px;color:var(--text-2)">Gastos</p><p style="font-size:14px;font-weight:500">${eur(sAB.tG)}</p></div>
          <div><p style="font-size:10px;color:var(--text-2)">Margen €</p><p style="font-size:14px;font-weight:500;color:${clrG(sAB.mg)}">${eur(sAB.mg)}</p></div>
          <div><p style="font-size:10px;color:var(--text-2)">%</p><p style="font-size:14px;font-weight:500">${pct(sAB.mgP)}</p></div>
          <div><p style="font-size:10px;color:var(--text-2)">H/sem</p><p style="font-size:14px;font-weight:500">${n0(sAB.hT)}</p></div>
        </div></div>
      </div>`;
  }

  // Tabla
  const SR = [...R].sort((a, b) => {
    const av = a[uiState.sortCol], bv = b[uiState.sortCol];
    if (av < bv) return uiState.sortDir;
    if (av > bv) return -uiState.sortDir;
    return 0;
  });
  const tb = $('tb-rank'); if (!tb) return;
  tb.innerHTML = SR.map((r, i) => {
    const mBar = Math.min(Math.abs(r.mgP) * 100 / 30 * 100, 100);
    const mClr = r.mgP > 0.15 ? '#639922' : r.mgP > 0 ? '#BA7517' : '#A32D2D';
    const ratioClr = r.ratioAlq > 0.1 ? '#dc2626' : r.ratioAlq > 0.07 ? '#BA7517' : '#16a34a';
    const localObj = locById(r.id);
    const isOvr = localObj && localObj.horas_sem_override != null;
    return `<tr>
      <td style="font-weight:500">${i+1}. ${r.n}</td>
      <td><span class="bdg b${r.g}">${r.g}</span></td>
      <td style="text-align:right">${eur(r.fac)}</td>
      <td style="text-align:right">${eur(r.tG)}</td>
      <td style="text-align:right;font-weight:500;color:${clrG(r.mg)}">${eur(r.mg)}</td>
      <td style="text-align:right">
        <div style="display:flex;align-items:center;gap:5px;justify-content:flex-end">
          <div class="bar" style="width:50px"><div class="bar-f" style="width:${mBar}%;background:${mClr}"></div></div>
          <span style="font-weight:500;min-width:38px">${pct(r.mgP)}</span>
        </div>
      </td>
      <td style="text-align:right;font-weight:500;color:${ratioClr}">${pct(r.ratioAlq)}</td>
      <td style="text-align:right">${n0(r.hM)} h</td>
      <td style="text-align:right">
        <input type="number" class="hrs-inp${isOvr ? '' : ' auto'}" value="${r.hS.toFixed(1)}" min="0" max="300" step="0.5" onchange="updHoras('${r.id}',this.value)" title="${isOvr ? 'Manual — click ✕ para limpiar' : 'Calculado automáticamente'}">
        ${isOvr ? `<button onclick="updHoras('${r.id}','')" style="font-size:10px;border:none;background:none;cursor:pointer;color:#A32D2D" title="Resetear">✕</button>` : ''}
      </td>
      <td style="text-align:center"><span class="bdg b${r.estado[0] === 'V' ? 'V' : r.estado[0] === 'A' ? 'J' : 'P'}">${r.estado}</span></td>
    </tr>`;
  }).join('');

  if (chRank) {
    const SRC = [...R].sort((a, b) => b.mgP - a.mgP);
    chRank.data.labels = SRC.map((r) => r.s);
    UI.COST_KEYS.forEach((k, i) => { chRank.data.datasets[i].data = SRC.map((r) => Math.round(r[k] || 0)); });
    chRank.update();
    $('leg-rank').innerHTML = chRank.data.datasets.map((d) => `<span class="lbl"><span class="lbl-sq" style="background:${d.backgroundColor}"></span>${d.label}</span>`).join('');
  }
}

function updCostos() {
  const R = E.calcAll(ctx);
  const ed = E.calcElche(ctx);
  const selGs = new Set(['A','B','C','D'].filter((g) => $(`cg-${g}`)?.checked));
  const inclE = $('cg-E')?.checked;
  let rows = R.filter((r) => selGs.has(r.g));
  if (inclE && ed) rows = [ed, ...rows];
  const tots = UI.COST_KEYS.map((k) => rows.reduce((s, r) => s + (r[k] || 0), 0));
  if (chDonut) {
    chDonut.data.datasets[0].data = tots.map((v) => Math.round(v));
    chDonut.update();
    const gT = tots.reduce((s, v) => s + v, 0);
    $('costos-legend').innerHTML = UI.COST_LBLS.map((lbl, i) => `<div style="display:flex;align-items:center;gap:6px;padding:3px 0"><span style="width:10px;height:10px;border-radius:2px;background:${UI.COST_CLRS[i]};flex-shrink:0;display:inline-block"></span><span style="font-size:12px;flex:1">${lbl}</span><span style="font-size:12px;font-weight:500">${eur(tots[i])}</span><span style="font-size:11px;color:var(--text-2);min-width:34px;text-align:right">${gT > 0 ? ((tots[i]/gT)*100).toFixed(1) : '0'}%</span></div>`).join('');
  }
  const grpColors = { E:'#7E22CE', A:'#639922', B:'#BA7517', C:'#185FA5', D:'#A32D2D' };
  const locsByGrp = {
    E: inclE && ed ? [ed] : [],
    A: rows.filter((r) => r.g === 'A' && !r.dani_only),
    B: rows.filter((r) => r.g === 'B'),
    C: rows.filter((r) => r.g === 'C'),
    D: rows.filter((r) => r.g === 'D'),
  };
  let html = '';
  ['E','A','B','C','D'].forEach((g) => {
    const rws = locsByGrp[g] || []; if (!rws.length) return;
    rws.forEach((r) => {
      html += `<tr><td style="font-weight:500">${r.n}</td><td><span class="bdg b${r.g}">${r.g}</span></td><td style="text-align:right">${eur(r.fac)}</td>${UI.COST_KEYS.map((k) => `<td style="text-align:right">${eur(r[k] || 0)}</td>`).join('')}<td style="text-align:right;font-weight:500">${eur(r.tG)}</td></tr>`;
    });
    const sf = rws.reduce((s, r) => s + r.fac, 0);
    const stG = rws.reduce((s, r) => s + r.tG, 0);
    const sK = UI.COST_KEYS.map((k) => rws.reduce((s, r) => s + (r[k] || 0), 0));
    html += `<tr class="tr-sub" style="color:${grpColors[g]}"><td colspan="2">▸ ${g === 'E' ? 'ELCHE' : g} (${rws.length})</td><td style="text-align:right">${eur(sf)}</td>${sK.map((v) => `<td style="text-align:right">${eur(v)}</td>`).join('')}<td style="text-align:right">${eur(stG)}</td></tr>`;
  });
  const gf = rows.reduce((s, r) => s + r.fac, 0);
  const gtG = rows.reduce((s, r) => s + r.tG, 0);
  const gK = UI.COST_KEYS.map((k) => rows.reduce((s, r) => s + (r[k] || 0), 0));
  html += `<tr class="tr-tot"><td colspan="2">TOTAL SELECCIÓN</td><td style="text-align:right">${eur(gf)}</td>${gK.map((v) => `<td style="text-align:right">${eur(v)}</td>`).join('')}<td style="text-align:right">${eur(gtG)}</td></tr>`;
  $('tb-costos').innerHTML = html;
}

// ─── Presupuesto ───────────────────────────────────────────────────────
function onPresMonthChange() {
  const v = $('pres-month').value;
  const [y, m] = v.split('-').map(Number);
  uiState.presYear = y;
  uiState.presMonth = m;
  rebuildPresMap();
  updPresupuesto();
}

function updPresupuesto() {
  const monthIdx = uiState.presMonth - 1;
  const R = E.calcBudget(ctx, monthIdx);
  const totalPF = R.reduce((s, r) => s + r.fac, 0);
  const totalMg = R.reduce((s, r) => s + r.mg, 0);
  const totalReal = R.reduce((s, r) => r.real != null ? s + r.real : s, 0);
  const hasReal = R.some((r) => r.real != null);
  const varEur = hasReal ? totalReal - totalPF : null;
  $('pk-fac').textContent = eur(totalPF);
  $('pk-mg').textContent = eur(totalMg); $('pk-mg').style.color = clrG(totalMg);
  $('pk-mgp').textContent = pct(totalPF > 0 ? totalMg / totalPF : 0);
  $('pk-real').textContent = hasReal ? eur(totalReal) : '—';
  $('pk-var').textContent = varEur != null ? `${varEur > 0 ? '+' : ''}${eur(varEur)}` : '—';
  $('pk-var').style.color = varEur != null ? clrG(varEur) : '';

  const grpColors = { A:'#639922', B:'#BA7517', C:'#185FA5', D:'#A32D2D' };
  const SR = [...R].sort((a, b) => a.g.localeCompare(b.g) || a.n.localeCompare(b.n));
  let html = ''; let curGrp = '';
  SR.forEach((r) => {
    if (r.g !== curGrp) {
      curGrp = r.g;
      html += `<tr><td colspan="17" style="background:${grpColors[r.g]}18;font-weight:500;color:${grpColors[r.g]};padding:5px 8px;font-size:11px">${r.g} — ${r.g === 'A' ? 'Mantener' : r.g === 'B' ? 'Analizar' : r.g === 'C' ? 'Especial' : 'Salida'}</td></tr>`;
    }
    const presVal = r.presBase;
    const realVal = r.real;
    const varRow = realVal != null ? realVal - presVal : null;
    const varPct = varRow != null && presVal > 0 ? varRow / presVal : null;
    html += `<tr>
      <td style="font-weight:500">${r.n}</td>
      <td><span class="bdg b${r.g}">${r.g}</span></td>
      <td style="text-align:right"><input class="num-inp" style="width:80px" type="number" value="${presVal}" min="0" step="500" onchange="updPresFac('${r.id}',this.value)"></td>
      <td style="text-align:right">${eur(r.mp)}</td>
      <td style="text-align:right">${eur(r.pers)}</td>
      <td style="text-align:right;font-weight:500">${r.hS.toFixed(1)} h</td>
      <td style="text-align:right">${eur(r.srvTotal)}</td>
      <td style="text-align:right">${eur(r.glv)}</td>
      <td style="text-align:right">${eur(r.pub)}</td>
      <td style="text-align:right">${eur(r.imp)}</td>
      <td style="text-align:right">${eur(r.prod)}</td>
      <td style="text-align:right">${eur(r.esp)}</td>
      <td style="text-align:right;font-weight:500">${eur(r.tG)}</td>
      <td style="text-align:right;font-weight:500;color:${clrG(r.mg)}">${eur(r.mg)}</td>
      <td style="text-align:right">${pct(r.mgP)}</td>
      <td style="text-align:right"><input type="number" class="real-inp" value="${realVal != null ? realVal : ''}" placeholder="—" min="0" step="500" onchange="updPresReal('${r.id}',this.value)"></td>
      <td style="text-align:right;font-weight:500;color:${varRow != null ? clrG(varRow) : ''}">${varRow != null ? (varRow > 0 ? '+' : '') + eur(varRow) + (varPct != null ? ' ('+pct(varPct)+')' : '') : '—'}</td>
    </tr>`;
  });
  ['A','B','C','D'].forEach((g) => {
    const sub = R.filter((r) => r.g === g); if (!sub.length) return;
    const sf = sub.reduce((s, r) => s + r.fac, 0);
    const stG = sub.reduce((s, r) => s + r.tG, 0);
    const smg = sub.reduce((s, r) => s + r.mg, 0);
    const sReal = sub.reduce((s, r) => r.real != null ? s + r.real : s, 0);
    const hasR = sub.some((r) => r.real != null);
    html += `<tr class="tr-sub" style="color:${grpColors[g]}"><td colspan="2">Subtotal ${g}</td><td style="text-align:right">${eur(sf)}</td><td colspan="9"></td><td style="text-align:right">${eur(stG)}</td><td style="text-align:right;color:${clrG(smg)}">${eur(smg)}</td><td style="text-align:right">${pct(sf > 0 ? smg/sf : 0)}</td><td style="text-align:right">${hasR ? eur(sReal) : '—'}</td><td></td></tr>`;
  });
  const totalTG = R.reduce((s, r) => s + r.tG, 0);
  html += `<tr class="tr-tot"><td colspan="2">TOTAL</td><td style="text-align:right">${eur(totalPF)}</td><td colspan="9"></td><td style="text-align:right">${eur(totalTG)}</td><td style="text-align:right;color:${clrG(totalMg)}">${eur(totalMg)}</td><td style="text-align:right">${pct(totalPF > 0 ? totalMg/totalPF : 0)}</td><td style="text-align:right;color:#1B5E20">${hasReal ? eur(totalReal) : '—'}</td><td style="text-align:right;color:${varEur != null ? clrG(varEur) : ''}">${varEur != null ? (varEur > 0 ? '+' : '') + eur(varEur) : '—'}</td></tr>`;
  $('tb-pres').innerHTML = html;
}

function updPresFac(id, val) {
  const num = (val === '' || val == null) ? null : Math.max(0, +val || 0);
  patchPresMap(id, { fac_presupuestada: num });
  updPresupuesto();
  Api.debouncedSave(`pres.${id}.fac`, () => Api.savePresupuesto({
    local_id: id, anio: uiState.presYear, mes: uiState.presMonth,
    fac_presupuestada: num,
  }));
}

function updPresReal(id, val) {
  const num = (val === '' || val == null) ? null : Math.max(0, +val || 0);
  patchPresMap(id, { fac_real: num });
  updPresupuesto();
  Api.debouncedSave(`pres.${id}.real`, () => Api.savePresupuesto({
    local_id: id, anio: uiState.presYear, mes: uiState.presMonth,
    fac_real: num,
  }));
}

// ─── Evolución ─────────────────────────────────────────────────────────
function updLocChart() {
  if (!chEvLoc) return;
  const sel = Array.from(uiState.selLoc).filter((id) => !ctx.config.modoSociedad || !locById(id)?.dani_only);
  chEvLoc.data.datasets = sel.map((id, i) => ({
    label: locById(id)?.nombre_display || id,
    data: (ctx.h25[id] || new Array(12).fill(null)).map((v) => v || null),
    borderColor: UI.LCOLORS[i % UI.LCOLORS.length],
    backgroundColor: 'transparent',
    tension: .3, pointRadius: 3,
  }));
  chEvLoc.update();
  $('leg-evloc').innerHTML = sel.map((id, i) => `<span class="lbl"><span class="lbl-sq" style="background:${UI.LCOLORS[i % UI.LCOLORS.length]}"></span>${locById(id)?.nombre_display || id}</span>`).join('');
}

function navMes(dir) {
  uiState.mesNavIdx = Math.max(0, Math.min(12, uiState.mesNavIdx + dir));
  updIncid();
}

function updIncid() {
  if (!chIncid) return;
  const activos = ctx.locales.filter((l) => l.grupo !== 'D');
  const mesIdx = uiState.mesNavIdx;
  const vals = activos.map((l) => {
    if (mesIdx === 12) return +l.fac_mi_analisis || 0;
    return ctx.h25[l.id]?.[mesIdx] || 0;
  });
  const total = vals.reduce((s, v) => s + v, 0);
  const colors = activos.map((l) => UI.GC[l.grupo] || '#888');
  chIncid.data.labels = activos.map((l) => l.short_name);
  chIncid.data.datasets[0].data = vals;
  chIncid.data.datasets[0].backgroundColor = colors;
  chIncid.update();
  const lbl = mesIdx === 12 ? 'Mi Análisis' : `${UI.MESES[mesIdx]} 2025`;
  $('donut-mes-lbl').textContent = lbl;
  $('incid-legend').innerHTML = activos.map((l, i) => {
    const v = vals[i]; const p = total > 0 ? ((v/total)*100).toFixed(1) : '0';
    return `<div style="display:flex;align-items:center;gap:6px;padding:3px 0">
      <span style="width:10px;height:10px;border-radius:2px;background:${colors[i]};flex-shrink:0;display:inline-block"></span>
      <span style="font-size:11px;flex:1">${l.short_name}</span>
      <span style="font-size:11px;font-weight:500">${eur(v)}</span>
      <span style="font-size:11px;color:var(--text-2);min-width:36px;text-align:right">${p}%</span>
    </div>`;
  }).join('');
  $('incid-total-lbl').textContent = `Facturación total ${lbl} (sin Chicken Thader y Chicken Uncles): ${eur(total)} · ${activos.length} locales activos`;
}

// ─── Traspasos ─────────────────────────────────────────────────────────
function rTrsp(R) {
  $('trsp-cards').innerHTML = R.filter((r) => r.g === 'D').map((r) => {
    const eA = r.mg * 12, v2 = eA * 2, v3 = eA * 3, v4 = eA * 4;
    return `<div class="card" style="margin-bottom:1rem;border-left:3px solid #A32D2D">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem">
        <div><p style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#A32D2D;font-weight:500;margin-bottom:2px">Grupo D — Salida</p><h2 style="font-size:17px;font-weight:500">${r.n}</h2></div>
        <span class="bdg b${r.estado[0] === 'V' ? 'V' : r.estado[0] === 'A' ? 'J' : 'P'}">${r.estado}</span>
      </div>
      <div class="g4" style="margin-bottom:1rem">
        <div class="surf"><p style="font-size:10px;color:var(--text-2)">Facturación</p><p style="font-size:14px;font-weight:500">${eur(r.fac)}</p></div>
        <div class="surf"><p style="font-size:10px;color:var(--text-2)">Margen mensual</p><p style="font-size:14px;font-weight:500;color:${clrG(r.mg)}">${eur(r.mg)}</p></div>
        <div class="surf"><p style="font-size:10px;color:var(--text-2)">Margen %</p><p style="font-size:14px;font-weight:500">${pct(r.mgP)}</p></div>
        <div class="surf"><p style="font-size:10px;color:var(--text-2)">EBITDA anual</p><p style="font-size:14px;font-weight:500;color:${clrG(eA)}">${eur(eA)}</p></div>
      </div>
      <p style="font-size:12px;font-weight:500;margin-bottom:8px">Valoración de traspaso</p>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:${r.mg < 0 ? '1rem' : '0'}">
        <div class="surf" style="text-align:center"><p style="font-size:10px;color:var(--text-2)">Conservador (2×)</p><p style="font-size:14px;font-weight:500">${eur(v2)}</p></div>
        <div style="text-align:center;border:2px solid #185FA5;border-radius:var(--r-md);padding:.75rem"><p style="font-size:10px;color:#185FA5">Objetivo (3×)</p><p style="font-size:14px;font-weight:500;color:#185FA5">${eur(v3)}</p></div>
        <div class="surf" style="text-align:center"><p style="font-size:10px;color:var(--text-2)">Máximo (4×)</p><p style="font-size:14px;font-weight:500">${eur(v4)}</p></div>
      </div>
      ${r.mg < 0 ? `<div style="padding:10px 12px;background:#fef2f2;border-radius:var(--r-md)"><p style="font-size:12px;font-weight:500;color:#dc2626">Costo mensual sin cierre: ${eur(Math.abs(r.mg))}/mes</p></div>` : ''}
    </div>`;
  }).join('');
}

// ─── Sort & tabs ────────────────────────────────────────────────────────
function srt(col) {
  document.querySelectorAll("[id^='ar-']").forEach((el) => { el.textContent = ' ⇕'; });
  if (uiState.sortCol === col) uiState.sortDir *= -1;
  else { uiState.sortCol = col; uiState.sortDir = -1; }
  const el = $(`ar-${col}`); if (el) el.textContent = uiState.sortDir === -1 ? ' ↓' : ' ↑';
  rRanking(E.calcAll(ctx));
}

function showTab(name, btn) {
  document.querySelectorAll('.sect').forEach((s) => s.classList.remove('on'));
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('on'));
  $(`sect-${name}`).classList.add('on');
  if (btn) btn.classList.add('on');
  if (name === 'evolucion') { updLocChart(); updIncid(); }
  if (name === 'presupuesto') updPresupuesto();
}

function togglePanel() {
  const bd = $('pbody'), cv = $('pchev');
  const open = bd.style.display === 'none';
  bd.style.display = open ? 'block' : 'none';
  cv.style.transform = open ? 'rotate(180deg)' : '';
}

// ─── Expose to HTML (onclick attrs) ────────────────────────────────────
Object.assign(window, {
  setSoc, togGlovo, syncSlider, syncPool, togglePanel,
  updLocalField, updHoras, togLoc,
  updPresFac, updPresReal, onPresMonthChange,
  navMes, srt, showTab, logout,
});

// ─── Go ────────────────────────────────────────────────────────────────
boot();
