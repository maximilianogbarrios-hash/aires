// Aires Solo — dashboard orchestrator.
// Carga bootstrap, mantiene `ctx`, gestiona UI y persiste cambios vía Api.

const UI = window.UICONST;
const E = window.Engine;

// ─── State ──────────────────────────────────────────────────────────────
// Expuesto a window.ctx porque public/js/pedidos.js lee window.ctx?.user?.role
// para resolver permisos (canWrite / canPagar). Sin esta exposición las celdas
// de Materia Prima renderizaban como sólo-lectura para todos los roles.
const ctx = window.ctx = {
  config: {},
  locales: [],
  h25: {},            // { localId: [12 valores 2025] }
  presupuestoMap: {}, // { localId: { fac_presupuestada, fac_real } } para mes activo
  presupuestoAll: [], // raw filas para reconstruir map al cambiar de mes
  presContext: {},    // { localId: { fac_mismo_mes_anio_anterior, fac_3meses_*, pesos_semanales, real_semanal_mes_actual, ... } }
  presContextMeta: null,
  user: null,
};

const uiState = {
  sortCol: 'mgP',
  sortDir: -1,
  selLoc: new Set(['ELCHE','SANTO_DOMINGO','BENIDORM','ARENALES','ALICANTE']),
  mesNavIdx: 12, // 0-11 = meses 2025, 12 = "Mi Análisis"
  presYear: 2026,
  presMonth: 5,
  presExpand: {},      // { localId: true } filas con desglose semanal abierto
  segYear: 2026,
  segMonth: 5,
  segLoaded: false,
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
    ctx.tabs = data.tabs || null;
    ctx.sub_tabs_pedidos = data.sub_tabs_pedidos || null;
    ctx.flags = data.flags || {};
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
    _captureParamsOriginal();
    buildSrvTable();
    buildFacInputs();
    buildLocFilter();
    update();
    fetchLastParamsMod();
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
  // Permisos via flags del backend (single source of truth, lib/roles.js).
  const flags = ctx.flags || {};
  // Panel de Parámetros visible para admin/socio/gerente (flag config_w).
  // Gerente puede editar pero cada cambio queda en ab_parametros_historial.
  const panel = $('params-panel');
  if (panel) panel.style.display = flags.config_w ? '' : 'none';
  // Botón Imprimir del topbar: admin y socio (flag print_w).
  const btnPrint = $('tb-imprimir');
  if (btnPrint) btnPrint.style.display = flags.print_w ? '' : 'none';
  // Aviso visual cuando gerente edita parámetros (queda registrado).
  if (panel && flags.config_w_log_only) {
    const avisoExistente = document.getElementById('params-audit-notice');
    if (!avisoExistente) {
      const div = document.createElement('div');
      div.id = 'params-audit-notice';
      div.style.cssText = 'margin:.5rem 0 0;padding:8px 12px;background:#FEF3C7;border-left:3px solid #D97706;border-radius:6px;font-size:11px;color:#78350F';
      div.textContent = 'Tus cambios al panel de parámetros quedan registrados en el historial de auditoría.';
      panel.appendChild(div);
    }
  }

  // Visibilidad granular (matriz dashboard).
  // KPIs financieros globales (g4 + hdr-fac/mg)
  if ($('kpis-top'))        $('kpis-top').style.display        = flags.dashboard_kpis ? '' : 'none';
  if ($('hdr-financiero'))  $('hdr-financiero').style.display  = flags.dashboard_kpis ? '' : 'none';
  // Toggle Sociedad/Completo
  if ($('soc-toggle-bar'))  $('soc-toggle-bar').style.display  = flags.vista_sociedad ? 'flex' : 'none';
  // Link Bancos en topbar
  if ($('tb-bancos-link'))  $('tb-bancos-link').style.display  = flags.bancos ? '' : 'none';
  // Pestañas: filtrar por matriz tabs[]
  const tabs = ctx.tabs || [];
  document.querySelectorAll('.tab[data-tab]').forEach((el) => {
    el.style.display = tabs.includes(el.dataset.tab) ? '' : 'none';
  });
  // Sub-pestañas DENTRO de Pedidos: filtrar por matriz sub_tabs_pedidos[].
  // Para rol 'pedidos' sólo queda visible "mp" (Materia Prima).
  const subTabsPed = ctx.sub_tabs_pedidos;
  if (Array.isArray(subTabsPed)) {
    document.querySelectorAll('.sub-tab[data-sub]').forEach((el) => {
      el.style.display = subTabsPed.includes(el.dataset.sub) ? '' : 'none';
    });
    // Asegurar que la sub-tab activa esté permitida; si no, marcar la primera visible.
    const activeSub = document.querySelector('.sub-tab.on[data-sub]');
    if (activeSub && activeSub.style.display === 'none') {
      const firstVisible = document.querySelector('.sub-tab[data-sub]:not([style*="none"])');
      if (firstVisible) {
        document.querySelectorAll('.sub-tab').forEach((t) => t.classList.remove('on'));
        firstVisible.classList.add('on');
      }
    }
  }
  // Si la pestaña activa (resumen) por defecto no está permitida, abrir la primera permitida.
  const visible = [...document.querySelectorAll('.tab[data-tab]')].filter((el) => el.style.display !== 'none');
  const visibleNames = visible.map((el) => el.dataset.tab);
  if (visibleNames.length && !visibleNames.includes('resumen')) {
    showTab(visibleNames[0], visible[0]);
  }
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

// Buffer de cambios pendientes a los parámetros (no auto-guarda, espera
// "Confirmar parámetros"). Estado original = snapshot al boot/last confirm.
let _paramsOriginal = null;
function _captureParamsOriginal() {
  _paramsOriginal = {
    pctMP: ctx.config.pctMP, pctPersonal: ctx.config.pctPersonal,
    pctImpuestos: ctx.config.pctImpuestos, pctPublicidad: ctx.config.pctPublicidad,
    euroHora: ctx.config.euroHora,
  };
}
function _paramsTienenCambios() {
  if (!_paramsOriginal) return false;
  return Object.keys(_paramsOriginal).some((k) => +ctx.config[k] !== +_paramsOriginal[k]);
}
function _showParamsConfirmBar() {
  const bar = $('params-confirm-bar');
  if (bar) bar.style.display = _paramsTienenCambios() ? 'flex' : 'none';
  // Highlight de cada slider con cambios.
  ['sMP','sPers','sImp','sPub','sHora'].forEach((id) => {
    const inp = $(id); if (!inp) return;
    const key = id === 'sMP' ? 'pctMP' : id === 'sPers' ? 'pctPersonal'
              : id === 'sImp' ? 'pctImpuestos' : id === 'sPub' ? 'pctPublicidad' : 'euroHora';
    const dirty = _paramsOriginal && (+ctx.config[key] !== +_paramsOriginal[key]);
    inp.classList.toggle('param-dirty', !!dirty);
  });
}

function syncSlider() {
  if (!_paramsOriginal) _captureParamsOriginal();
  ctx.config.pctMP = +$('sMP').value;
  ctx.config.pctPersonal = +$('sPers').value;
  ctx.config.pctImpuestos = +$('sImp').value;
  ctx.config.pctPublicidad = +$('sPub').value;
  ctx.config.euroHora = +$('sHora').value;
  syncSliderLabels();
  buildSrvTable();
  update();
  _showParamsConfirmBar();
  // NO auto-guarda — espera confirmar.
}

async function confirmParams() {
  try {
    await Api.saveConfig({
      pctMP: ctx.config.pctMP,
      pctPersonal: ctx.config.pctPersonal,
      pctImpuestos: ctx.config.pctImpuestos,
      pctPublicidad: ctx.config.pctPublicidad,
      euroHora: ctx.config.euroHora,
    });
    Api.pill('✓ Parámetros confirmados');
    _captureParamsOriginal();
    _showParamsConfirmBar();
    await fetchLastParamsMod();
    // Notificar a consumidores (Pedidos > MP, Personal) que %MP/%Pers/€h
    // cambiaron. La tabla MP debe recalcular Budget MP y los importes
    // sugeridos en tiempo real si la pestaña está visible.
    window.dispatchEvent(new CustomEvent('aires:config-changed', {
      detail: { source: 'params' },
    }));
  } catch (e) {
    Api.pill('Error: ' + e.message, true);
  }
}

function discardParams() {
  if (!_paramsOriginal) return;
  Object.assign(ctx.config, _paramsOriginal);
  $('sMP').value = ctx.config.pctMP;
  $('sPers').value = ctx.config.pctPersonal;
  $('sImp').value = ctx.config.pctImpuestos;
  $('sPub').value = ctx.config.pctPublicidad;
  $('sHora').value = ctx.config.euroHora;
  syncSliderLabels();
  buildSrvTable();
  update();
  _showParamsConfirmBar();
}

// "Última modificación: hoy 14:32 por luciano.todarello@..."
async function fetchLastParamsMod() {
  try {
    const j = await Api.lastParamsMod();
    const el = $('params-last-mod');
    if (!el) return;
    if (!j || !j.fecha) { el.textContent = 'Sin modificaciones registradas todavía.'; return; }
    const f = new Date(j.fecha);
    const fechaTxt = f.toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' });
    el.textContent = `Última modificación: ${fechaTxt} por ${j.usuario_email} (${j.campo}: ${j.valor_anterior} → ${j.valor_nuevo})`;
  } catch {}
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
    const dAlq = _srvDirty[l.id]?.alquiler;
    const dSum = _srvDirty[l.id]?.suministros;
    const dirtyA = dAlq && +dAlq.from !== +dAlq.to;
    const dirtyS = dSum && +dSum.from !== +dSum.to;
    return `<tr>
      <td style="font-weight:500">${l.nombre_display}</td>
      <td><span class="bdg b${bdg}">${bdgLbl}</span></td>
      <td style="text-align:right" class="${dirtyA ? 'srv-cell-dirty' : ''}">${dirtyA ? '<span style="color:#BA7517">✏️</span> ' : ''}<input class="num-inp" type="number" value="${alq}" min="0" step="50" onchange="updLocalField('${l.id}','alquiler',this.value)"></td>
      <td style="text-align:right" class="${dirtyS ? 'srv-cell-dirty' : ''}">${dirtyS ? '<span style="color:#BA7517">✏️</span> ' : ''}<input class="num-inp" type="number" value="${sum_}" min="0" step="50" onchange="updLocalField('${l.id}','suministros',this.value)"></td>
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
// Buffer de cambios pendientes para alquiler/suministros/fac_mi_analisis.
// La estructura: { localId: { field: { from, to } } }
const _srvDirty = {};
function _srvTieneCambios() {
  for (const lid of Object.keys(_srvDirty)) {
    for (const f of Object.keys(_srvDirty[lid])) {
      const d = _srvDirty[lid][f];
      if (d && +d.from !== +d.to) return true;
    }
  }
  return false;
}
function _srvCountDirty() {
  let n = 0;
  for (const lid of Object.keys(_srvDirty)) {
    for (const f of Object.keys(_srvDirty[lid])) {
      const d = _srvDirty[lid][f];
      if (d && +d.from !== +d.to) n++;
    }
  }
  return n;
}
function _showSrvConfirmBar() {
  const bar = $('srv-confirm-bar');
  const n = _srvCountDirty();
  if (bar) bar.style.display = n > 0 ? 'flex' : 'none';
  const txt = $('srv-confirm-text');
  if (txt) txt.textContent = `✏️ ${n} celda${n === 1 ? '' : 's'} sin guardar en alquiler/suministros`;
}

// Las celdas dirty se marcan con .srv-cell-dirty (estilo amarillo en CSS).
function updLocalField(id, field, val) {
  const l = locById(id); if (!l) return;
  const num = (val === '' || val == null) ? null : Math.max(0, +val || 0);
  // Capturar valor original la primera vez que se toca esta celda.
  _srvDirty[id] = _srvDirty[id] || {};
  if (!(field in _srvDirty[id])) {
    _srvDirty[id][field] = { from: l[field], to: num };
  } else {
    _srvDirty[id][field].to = num;
  }
  l[field] = num;
  buildSrvTable();
  update();
  _showSrvConfirmBar();
}

async function confirmSrv() {
  const dirty = [];
  for (const lid of Object.keys(_srvDirty)) {
    for (const f of Object.keys(_srvDirty[lid])) {
      const d = _srvDirty[lid][f];
      if (d && +d.from !== +d.to) dirty.push({ localId: lid, field: f, value: d.to });
    }
  }
  if (!dirty.length) return;
  try {
    // Guardar cada fila modificada.
    for (const d of dirty) {
      await Api.saveLocal(d.localId, { [d.field]: d.value });
    }
    // Reset buffer.
    for (const lid of Object.keys(_srvDirty)) delete _srvDirty[lid];
    _showSrvConfirmBar();
    buildSrvTable();
    Api.pill('✓ Cambios guardados');
  } catch (e) {
    Api.pill('Error: ' + e.message, true);
  }
}

function discardSrv() {
  for (const lid of Object.keys(_srvDirty)) {
    const l = locById(lid);
    if (!l) continue;
    for (const f of Object.keys(_srvDirty[lid])) {
      l[f] = _srvDirty[lid][f].from;
    }
    delete _srvDirty[lid];
  }
  _showSrvConfirmBar();
  buildSrvTable();
  update();
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
  // 3b — Etiqueta aclaratoria "Margen total red vs Margen vista actual".
  // Total red = todos los locales activos SIN excluir Elche (independiente
  // del modoSociedad). Vista actual = lo que se está calculando ahora
  // (que sí respeta filtros).
  const RAllRed = E.calcAllRed ? E.calcAllRed(ctx) : null;
  let elcheR = null;
  try { elcheR = E.calcElche ? E.calcElche(ctx) : null; } catch {}
  const tFred = (RAllRed?.filter ? RAllRed.filter((r) => r.g !== 'D').reduce((s, r) => s + r.fac, 0) : tF)
              + (ctx.config.modoSociedad && elcheR ? (elcheR.fac || 0) : 0);
  const tMred = (RAllRed?.filter ? RAllRed.filter((r) => r.g !== 'D').reduce((s, r) => s + r.mg, 0) : tM)
              + (ctx.config.modoSociedad && elcheR ? (elcheR.mg || 0) : 0);
  const mPred = tFred > 0 ? tMred / tFred : 0;
  const label = $('mg-comparativa');
  if (label) {
    label.textContent = ctx.config.modoSociedad
      ? `Margen total red: ${pct(mPred)} (incluye Elche) · Margen vista actual: ${pct(mP)} (sociedad — sin Elche)`
      : `Margen total red: ${pct(mPred)} · Margen vista actual: ${pct(mP)}`;
  }
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
  return `<div style="margin-top:1.5rem;padding-top:1rem;border-top:2px dashed #D8B4FE">
    <p style="font-size:11px;font-weight:500;color:#7E22CE;text-transform:uppercase;letter-spacing:1px;margin-bottom:.5rem">⌁ Grupo Hostelero Aires (separado del modo Sociedad)</p>
    <div class="elche-banner">
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
//
// Modelo nuevo:
//   - Tabla con columnas: año anterior · tendencia 3M · var. último mes ·
//     presup. (editable) · real (editable) · var. real/presup. · crec.
//     necesario para margen >15% · margen % · semáforo · expandir.
//   - KPIs arriba (totales + contadores semáforo).
//   - Expansión por local: pesos semanales históricos × presup → estimado
//     semanal vs real semanal del mes (del backend, ab_cierres_tpv).

function onPresMonthChange() {
  const v = $('pres-month').value;
  const [y, m] = v.split('-').map(Number);
  uiState.presYear = y;
  uiState.presMonth = m;
  rebuildPresMap();
  fetchPresContexto().then(() => updPresupuesto()).catch(() => updPresupuesto());
}

async function fetchPresContexto() {
  const periodo = `${uiState.presYear}-${String(uiState.presMonth).padStart(2,'0')}`;
  try {
    const res = await Api.presupuestoContexto(periodo);
    ctx.presContext = res.por_local || {};
    ctx.presContextMeta = { periodo, ult_mes: res.ult_mes };
  } catch (e) {
    console.error('[pres.contexto]', e);
    ctx.presContext = {};
    ctx.presContextMeta = { periodo, ult_mes: null };
  }
}

// Encuentra el mínimo crecimiento sobre `facBase` que lleva el margen del
// local >15% usando el engine real. Devuelve null si no se puede o falta
// la base.
function crecNecesarioPctMg15(local, facBase) {
  if (!facBase || facBase <= 0) return null;
  // Probar fac creciente. Si ya con la base se llega, devolvemos 0.
  const testFac = (fac) => {
    const fakeLoc = { ...local, fac_mi_analisis: fac };
    const fakeCtx = {
      ...ctx,
      locales: ctx.locales.map((l) => l.id === local.id ? fakeLoc : l),
    };
    const R = E.calcAll(fakeCtx);
    const r = R.find((x) => x.id === local.id);
    return r ? r.mgP : -1;
  };
  if (testFac(facBase) >= 0.15) return 0;
  // Bisección en [facBase, facBase × 5]. Si a 5× no llega, devolvemos null.
  let lo = facBase;
  let hi = facBase * 5;
  if (testFac(hi) < 0.15) return null;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (testFac(mid) >= 0.15) hi = mid; else lo = mid;
    if (hi - lo < 50) break;
  }
  return (hi - facBase) / facBase;
}

function semaforoColor(tend3m) {
  if (tend3m == null) return null;
  if (tend3m >  0.03) return '#22c55e';
  if (tend3m < -0.03) return '#dc2626';
  return '#eab308';
}

function pctSigned(v) {
  if (v == null) return '—';
  const s = (v * 100).toFixed(1).replace('.', ',');
  return `${v > 0 ? '+' : ''}${s}%`;
}

function arrowFor(v) {
  if (v == null) return '';
  if (v >  0.01) return '↑';
  if (v < -0.01) return '↓';
  return '→';
}

function updPresupuesto() {
  const monthIdx = uiState.presMonth - 1;
  const R = E.calcBudget(ctx, monthIdx);
  const RbyId = Object.fromEntries(R.map((r) => [r.id, r]));
  const ctxPres = ctx.presContext || {};

  // KPIs globales
  const totalPF = R.reduce((s, r) => s + r.fac, 0);
  const totalMg = R.reduce((s, r) => s + r.mg, 0);
  const totalReal = R.reduce((s, r) => r.real != null ? s + r.real : s, 0);
  const realPresupOnlyPF = R.reduce((s, r) => r.real != null ? s + r.fac : s, 0);
  const hasReal = R.some((r) => r.real != null);
  const realCount = R.filter((r) => r.real != null).length;
  const varEur = hasReal ? totalReal - realPresupOnlyPF : null;
  const varPctG = hasReal && realPresupOnlyPF > 0 ? varEur / realPresupOnlyPF : null;
  $('pk-fac').textContent = eur(totalPF);
  $('pk-real').textContent = hasReal ? eur(totalReal) : '—';
  $('pk-real-cobertura').textContent = hasReal ? `${realCount} de ${R.length} locales` : '';
  $('pk-var').textContent = varPctG != null ? pctSigned(varPctG) : '—';
  $('pk-var').style.color = varPctG != null ? clrG(varPctG) : '';
  $('pk-var-eur').textContent = varEur != null ? `${varEur >= 0 ? '+' : ''}${eur(varEur)}` : '';
  $('pk-mg').textContent = eur(totalMg);
  $('pk-mg').style.color = clrG(totalMg);
  $('pk-mgp').textContent = pct(totalPF > 0 ? totalMg / totalPF : 0);

  // Contadores semáforo
  const sem = { v: 0, a: 0, r: 0, x: 0 };
  R.forEach((row) => {
    const c = ctxPres[row.id] || {};
    const este = c.fac_3meses_este_anio;
    const prev = c.fac_3meses_anio_anterior;
    const tend3m = trend3mPct(este, prev);
    if (tend3m == null) sem.x++;
    else if (tend3m >  0.03) sem.v++;
    else if (tend3m < -0.03) sem.r++;
    else sem.a++;
  });
  $('pk-sem-v').textContent = sem.v;
  $('pk-sem-a').textContent = sem.a;
  $('pk-sem-r').textContent = sem.r;
  $('pk-sem-x').textContent = sem.x;

  // Tabla
  const grpColors = { A:'#639922', B:'#BA7517', C:'#185FA5', D:'#A32D2D' };
  const SR = [...R].sort((a, b) => a.g.localeCompare(b.g) || a.n.localeCompare(b.n));
  let html = ''; let curGrp = '';
  SR.forEach((r) => {
    if (r.g !== curGrp) {
      curGrp = r.g;
      html += `<tr><td colspan="12" style="background:${grpColors[r.g]}18;font-weight:500;color:${grpColors[r.g]};padding:5px 8px;font-size:11px">${r.g} — ${r.g === 'A' ? 'Mantener' : r.g === 'B' ? 'Analizar' : r.g === 'C' ? 'Especial' : 'Salida'}</td></tr>`;
    }
    const c = ctxPres[r.id] || {};
    const facAnt = c.fac_mismo_mes_anio_anterior;
    const tend3m = trend3mPct(c.fac_3meses_este_anio, c.fac_3meses_anio_anterior);
    const varUlt = pairPct(c.fac_ultimo_mes_este_anio, c.fac_ultimo_mes_anio_anterior);
    const tend3mFromPres = Array.isArray(c.fuente_3meses_este_anio) && c.fuente_3meses_este_anio.some((s) => s === 'presupuesto');
    const varUltFromPres = c.fuente_ultimo_mes_este_anio === 'presupuesto';
    const presBadge = '<span style="font-size:9px;background:#fef3c7;color:#92400e;padding:1px 4px;border-radius:3px;margin-left:4px;font-weight:500" title="basado en presupuesto">P</span>';
    const presVal = r.presBase;
    const realVal = r.real;
    const varRow = realVal != null && presVal > 0 ? (realVal - presVal) / presVal : null;
    const local = locById(r.id);
    const crec = local ? crecNecesarioPctMg15(local, facAnt) : null;
    const semColor = semaforoColor(tend3m);
    const expanded = !!(uiState.presExpand && uiState.presExpand[r.id]);

    html += `<tr data-pres-row="${r.id}">
      <td style="font-weight:500">${r.n}</td>
      <td><span class="bdg b${r.g}">${r.g}</span></td>
      <td style="text-align:right">${facAnt != null ? eur(facAnt) : '—'}</td>
      <td style="text-align:right;color:${tend3m != null ? clrG(tend3m) : ''}">${tend3m != null ? `${arrowFor(tend3m)} ${pctSigned(tend3m)}${tend3mFromPres ? presBadge : ''}` : '—'}</td>
      <td style="text-align:right;color:${varUlt != null ? clrG(varUlt) : ''}">${varUlt != null ? `${pctSigned(varUlt)}${varUltFromPres ? presBadge : ''}` : '—'}</td>
      <td style="text-align:right"><input class="num-inp" style="width:90px" type="number" value="${presVal}" min="0" step="500" onchange="updPresFac('${r.id}',this.value)"></td>
      <td style="text-align:right"><input type="number" class="real-inp" style="width:90px" value="${realVal != null ? realVal : ''}" placeholder="—" min="0" step="500" onchange="updPresReal('${r.id}',this.value)"></td>
      <td style="text-align:right;font-weight:500;color:${varRow != null ? clrG(varRow) : ''}">${varRow != null ? pctSigned(varRow) : '—'}</td>
      <td style="text-align:right">${crec != null ? pctSigned(crec) : '—'}</td>
      <td style="text-align:right">${pct(r.mgP)}</td>
      <td style="text-align:center">${semColor ? `<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${semColor}"></span>` : '<span style="color:var(--text-2)">—</span>'}</td>
      <td style="text-align:center"><button type="button" onclick="togglePresWeek('${r.id}')" style="background:transparent;border:none;cursor:pointer;font-size:14px;color:var(--text-2)">${expanded ? '▾' : '▸'}</button></td>
    </tr>`;
    if (expanded) {
      html += `<tr data-pres-week="${r.id}"><td colspan="12" style="padding:0;background:var(--bg-secondary)">${renderWeekRow(r, c)}</td></tr>`;
    }
  });

  // Subtotales por grupo
  ['A','B','C','D'].forEach((g) => {
    const sub = R.filter((r) => r.g === g); if (!sub.length) return;
    const sf = sub.reduce((s, r) => s + r.fac, 0);
    const sReal = sub.reduce((s, r) => r.real != null ? s + r.real : s, 0);
    const hasR = sub.some((r) => r.real != null);
    html += `<tr class="tr-sub" style="color:${grpColors[g]}"><td colspan="5">Subtotal ${g}</td><td style="text-align:right">${eur(sf)}</td><td style="text-align:right">${hasR ? eur(sReal) : '—'}</td><td colspan="5"></td></tr>`;
  });
  html += `<tr class="tr-tot"><td colspan="5">TOTAL</td><td style="text-align:right">${eur(totalPF)}</td><td style="text-align:right;color:#1B5E20">${hasReal ? eur(totalReal) : '—'}</td><td style="text-align:right;color:${varPctG != null ? clrG(varPctG) : ''}">${varPctG != null ? pctSigned(varPctG) : '—'}</td><td colspan="4"></td></tr>`;

  // Bloque 4 — Elche separado en modo Sociedad (siempre visible con todas las columnas).
  if (ctx.config.modoSociedad && E.calcBudgetElche) {
    const REch = E.calcBudgetElche(ctx, monthIdx);
    if (REch.length) {
      html += `<tr><td colspan="12" style="background:#FAF5FF;border-top:2px dashed #D8B4FE;color:#7E22CE;font-weight:500;padding:8px 8px;font-size:11px;text-transform:uppercase;letter-spacing:.8px">⌁ Grupo Hostelero Aires (separado del modo Sociedad)</td></tr>`;
      REch.forEach((r) => {
        const c = ctxPres[r.id] || {};
        const facAnt = c.fac_mismo_mes_anio_anterior;
        const tend3m = trend3mPct(c.fac_3meses_este_anio, c.fac_3meses_anio_anterior);
        const varUlt = pairPct(c.fac_ultimo_mes_este_anio, c.fac_ultimo_mes_anio_anterior);
        const local = locById(r.id);
        const crec = local ? crecNecesarioPctMg15(local, facAnt) : null;
        const semColor = semaforoColor(tend3m);
        const presVal = r.presBase;
        const realVal = r.real;
        const varRow = realVal != null && presVal > 0 ? (realVal - presVal) / presVal : null;
        const expanded = !!(uiState.presExpand && uiState.presExpand[r.id]);
        html += `<tr data-pres-row="${r.id}" style="background:#FEF9F0">
          <td style="font-weight:500">${r.n}</td>
          <td><span class="bdg bE">E</span></td>
          <td style="text-align:right">${facAnt != null ? eur(facAnt) : '—'}</td>
          <td style="text-align:right;color:${tend3m != null ? clrG(tend3m) : ''}">${tend3m != null ? `${arrowFor(tend3m)} ${pctSigned(tend3m)}` : '—'}</td>
          <td style="text-align:right;color:${varUlt != null ? clrG(varUlt) : ''}">${varUlt != null ? pctSigned(varUlt) : '—'}</td>
          <td style="text-align:right"><input class="num-inp" style="width:90px" type="number" value="${presVal}" min="0" step="500" onchange="updPresFac('${r.id}',this.value)"></td>
          <td style="text-align:right"><input type="number" class="real-inp" style="width:90px" value="${realVal != null ? realVal : ''}" placeholder="—" min="0" step="500" onchange="updPresReal('${r.id}',this.value)"></td>
          <td style="text-align:right;font-weight:500;color:${varRow != null ? clrG(varRow) : ''}">${varRow != null ? pctSigned(varRow) : '—'}</td>
          <td style="text-align:right">${crec != null ? pctSigned(crec) : '—'}</td>
          <td style="text-align:right">${pct(r.mgP)}</td>
          <td style="text-align:center">${semColor ? `<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${semColor}"></span>` : '<span style="color:var(--text-2)">—</span>'}</td>
          <td style="text-align:center"><button type="button" onclick="togglePresWeek('${r.id}')" style="background:transparent;border:none;cursor:pointer;font-size:14px;color:var(--text-2)">${expanded ? '▾' : '▸'}</button></td>
        </tr>`;
        if (expanded) {
          html += `<tr data-pres-week="${r.id}"><td colspan="12" style="padding:0;background:var(--bg-secondary)">${renderWeekRow(r, c)}</td></tr>`;
        }
      });
    }
  }

  $('tb-pres').innerHTML = html;
}

function trend3mPct(este, prev) {
  if (!Array.isArray(este) || !Array.isArray(prev)) return null;
  let sE = 0, sP = 0, n = 0;
  for (let i = 0; i < este.length; i++) {
    if (este[i] != null && prev[i] != null) {
      sE += este[i]; sP += prev[i]; n++;
    }
  }
  if (n === 0 || sP <= 0) return null;
  return (sE - sP) / sP;
}

function pairPct(actual, prev) {
  if (actual == null || prev == null || prev <= 0) return null;
  return (actual - prev) / prev;
}

function togglePresWeek(id) {
  if (!uiState.presExpand) uiState.presExpand = {};
  uiState.presExpand[id] = !uiState.presExpand[id];
  updPresupuesto();
}

function fmtFechaCorta(iso) {
  if (!iso) return '';
  const [, m, d] = /(\d{4})-(\d{2})-(\d{2})/.exec(iso) || [];
  return `${+d}/${+m}`;
}

function renderWeekRow(r, c) {
  const semanas = Array.isArray(c.semanas) ? c.semanas : [];
  if (!semanas.length) return '<div style="padding:.75rem 1rem;color:var(--text-2);font-size:11px">Sin desglose semanal disponible</div>';
  const presup = r.presBase || 0;
  let inner = `<div style="padding:.75rem 1rem"><p style="font-size:11px;color:var(--text-2);margin-bottom:.5rem">Desglose semanal · ${r.n} · semanas ISO (lun-dom), estimado prorrateado por días en mes · Enter o salir del campo guarda · semáforo: 🟢 ≤±5% · 🟡 ±5-12% · 🔴 >±12%</p>`;
  inner += '<table style="width:100%;font-size:11px"><thead><tr><th style="text-align:left;color:var(--text-2);padding:4px 6px">Semana</th><th style="text-align:left;color:var(--text-2);padding:4px 6px">Fechas</th><th style="text-align:right;color:var(--text-2);padding:4px 6px">Peso</th><th style="text-align:right;color:var(--text-2);padding:4px 6px">Estimado</th><th style="text-align:right;color:var(--text-2);padding:4px 6px">Real</th><th style="text-align:right;color:var(--text-2);padding:4px 6px">Var.</th><th style="text-align:center;color:var(--text-2);padding:4px 6px">●</th></tr></thead><tbody>';
  let tEst = 0, tReal = 0, hasReal = false;
  semanas.forEach((s, i) => {
    const est = presup * (s.peso || 0);
    const rv = s.real;
    tEst += est;
    if (rv != null) { tReal += rv; hasReal = true; }
    const v = (rv != null && est > 0) ? (rv - est) / est : null;
    const rango = `${fmtFechaCorta(s.fecha_lunes)}-${fmtFechaCorta(s.fecha_domingo)}`;
    const sem = semaforoVar(v);
    inner += `<tr>
      <td style="padding:4px 6px"><strong>S${i + 1}</strong> <span style="color:var(--text-2);font-size:10px">W${s.semana_iso}</span></td>
      <td style="padding:4px 6px;color:var(--text-2)">${rango}${s.dias_en_mes < 7 ? ` <span style="font-size:9px;color:#92400e">(${s.dias_en_mes}d en mes)</span>` : ''}</td>
      <td style="text-align:right;padding:4px 6px">${pct(s.peso || 0)}</td>
      <td style="text-align:right;padding:4px 6px">${eur(est)}</td>
      <td style="text-align:right;padding:4px 6px"><input type="number" class="num-inp" style="width:80px;text-align:right" min="0" step="100" value="${rv != null ? rv : ''}" placeholder="—" onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur();}" onchange="updFacSemanal('${r.id}', ${s.semana_iso}, '${s.fecha_lunes}', '${s.fecha_domingo}', this.value)"></td>
      <td style="text-align:right;padding:4px 6px;color:${v != null ? clrG(v) : ''}">${v != null ? pctSigned(v) : '—'}</td>
      <td style="text-align:center;padding:4px 6px"><span title="${sem.tooltip}" style="color:${sem.color};font-size:14px">${sem.label}</span></td>
    </tr>`;
  });
  const vTot = (hasReal && tEst > 0) ? (tReal - tEst) / tEst : null;
  const semTot = semaforoVar(vTot);
  inner += `<tr style="border-top:.5px solid var(--border-3);font-weight:500">
    <td style="padding:4px 6px" colspan="2">Total acumulado</td>
    <td style="text-align:right;padding:4px 6px">100%</td>
    <td style="text-align:right;padding:4px 6px">${eur(tEst)}</td>
    <td style="text-align:right;padding:4px 6px">${hasReal ? eur(tReal) : '—'}</td>
    <td style="text-align:right;padding:4px 6px;color:${vTot != null ? clrG(vTot) : ''}">${vTot != null ? pctSigned(vTot) : '—'}</td>
    <td style="text-align:center;padding:4px 6px"><span title="${semTot.tooltip}" style="color:${semTot.color};font-size:14px">${semTot.label}</span></td>
  </tr>`;
  inner += '</tbody></table></div>';
  return inner;
}

// ─── Seguimiento (todas las semanas de un mes, todos los locales) ────
function semaforoVar(varPct) {
  if (varPct == null) return { color: '#94a3b8', label: '—', tooltip: 'sin datos' };
  const ab = Math.abs(varPct);
  if (ab <= 0.05) return { color: '#22c55e', label: '●', tooltip: 'OK ≤±5%' };
  if (ab <= 0.12) return { color: '#eab308', label: '●', tooltip: 'alerta ±5-12%' };
  return { color: '#dc2626', label: '●', tooltip: 'crítico >±12%' };
}

async function loadSeguimiento() {
  const anio = +uiState.segYear;
  const mes = +uiState.segMonth;
  if (!anio || !mes) return;
  $('seg-status').textContent = 'Cargando…';
  try {
    const j = await Api.getFacturacionSemanal({ anio, mes });
    renderSeguimientoTabla(j);
    uiState.segLoaded = true;
  } catch (e) {
    $('seg-status').textContent = 'Error: ' + e.message;
  }
}

function renderSeguimientoTabla(j) {
  const tb = $('seg-tbody');
  if (!tb) return;
  // Conteos para KPIs
  const kpi = { v: 0, a: 0, r: 0, x: 0 };
  const filas = [];
  const localesOrden = ctx.locales.slice().sort((a, b) => (a.short_name || a.id).localeCompare(b.short_name || b.id));
  for (const loc of localesOrden) {
    const data = j.por_local[loc.id];
    if (!data) continue;
    for (const s of data.semanas) {
      const sem = semaforoVar(s.var_pct);
      if (s.real == null) kpi.x++;
      else if (Math.abs(s.var_pct) <= 0.05) kpi.v++;
      else if (Math.abs(s.var_pct) <= 0.12) kpi.a++;
      else kpi.r++;
      const rango = `${fmtFechaCorta(s.fecha_lunes)}-${fmtFechaCorta(s.fecha_domingo)}`;
      filas.push(`<tr>
        <td style="font-weight:500;font-size:12px">${loc.nombre_display}</td>
        <td>S${s.semana_iso}</td>
        <td style="color:var(--text-2)">${rango}${s.dias_en_mes < 7 ? ` <span style="font-size:9px;color:#92400e">(${s.dias_en_mes}d)</span>` : ''}</td>
        <td style="text-align:right">${eur(s.presupuesto_estimado || 0)}</td>
        <td style="text-align:right">${s.real != null ? eur(s.real) : '<span style="color:var(--text-2)">—</span>'}</td>
        <td style="text-align:right;color:${s.var_pct != null ? clrG(s.var_pct) : ''}">${s.var_pct != null ? pctSigned(s.var_pct) : '—'}</td>
        <td style="text-align:center"><span title="${sem.tooltip}" style="color:${sem.color};font-size:14px">${sem.label}</span></td>
      </tr>`);
    }
  }
  tb.innerHTML = filas.join('');
  $('seg-kpi-v').textContent = kpi.v;
  $('seg-kpi-a').textContent = kpi.a;
  $('seg-kpi-r').textContent = kpi.r;
  $('seg-kpi-x').textContent = kpi.x;
  $('seg-status').textContent = `${filas.length} filas · presupuesto mensual total: ${eur(Object.values(j.por_local).reduce((s, d) => s + (d.presupuesto_mes || 0), 0))}`;
}

function onSeguimientoFiltro() {
  uiState.segYear = +$('seg-year').value;
  uiState.segMonth = +$('seg-month').value;
  loadSeguimiento();
}

// Guarda real semanal y refresca el contexto (para que el desglose y los
// KPIs reaccionen). El propio POST aggrega a ab_historial si todas las
// semanas del mes ya están cargadas.
async function updFacSemanal(localId, semanaIso, fechaLunes, fechaDomingo, valor) {
  const importe = (valor === '' || valor == null) ? null : Math.max(0, +valor || 0);
  const anio = +uiState.presYear;
  if (importe == null) return;
  try {
    await Api.saveFacturacionSemanal({
      local_id: localId, anio,
      semana_iso: semanaIso,
      fecha_lunes: fechaLunes, fecha_domingo: fechaDomingo,
      importe,
    });
    Api.pill('Semana guardada');
    await fetchPresContexto();
    updPresupuesto();
  } catch (e) {
    Api.pill('Error: ' + e.message, true);
  }
}

function updPresFac(id, val) {
  const num = (val === '' || val == null) ? null : Math.max(0, +val || 0);
  patchPresMap(id, { fac_presupuestada: num });
  updPresupuesto();
  Api.debouncedSave(`pres.${id}.fac`, () => Api.savePresupuesto({
    local_id: id, anio: uiState.presYear, mes: uiState.presMonth,
    fac_presupuestada: num,
  }));
  // Notificar a consumidores (Pedidos > MP, Personal) que la facturación
  // presupuestada del local cambió. Ellos saben si deben refrescar.
  window.dispatchEvent(new CustomEvent('aires:budget-changed', {
    detail: { local_id: id, anio: uiState.presYear, mes: uiState.presMonth, field: 'fac_presupuestada' },
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
  window.dispatchEvent(new CustomEvent('aires:budget-changed', {
    detail: { local_id: id, anio: uiState.presYear, mes: uiState.presMonth, field: 'fac_real' },
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
  // Mejora 8: si el rol no tiene la pestaña habilitada, no hacer nada
  // (defense-in-depth aparte de ocultar el botón).
  const tabs = ctx.tabs || [];
  if (tabs.length && !tabs.includes(name)) return;
  document.querySelectorAll('.sect').forEach((s) => s.classList.remove('on'));
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('on'));
  $(`sect-${name}`).classList.add('on');
  if (btn) btn.classList.add('on');
  if (name === 'ventas' && typeof window.vtInit === 'function') window.vtInit();
  if (name === 'presupuesto') {
    fetchPresContexto().then(() => updPresupuesto()).catch(() => updPresupuesto());
  }
  if (name === 'seguimiento') {
    if (!uiState.segLoaded) loadSeguimiento();
  }
  // Personal es una pestaña principal nueva (extraída de sub-tab Pedidos).
  // Reusa la lógica de pedidos.js exponiendo window.pedEnterPersonal.
  if (name === 'personal' && typeof window.pedEnterPersonal === 'function') {
    window.pedEnterPersonal();
  }
}

function togglePanel() {
  const bd = $('pbody'), cv = $('pchev');
  const open = bd.style.display === 'none';
  bd.style.display = open ? 'block' : 'none';
  cv.style.transform = open ? 'rotate(180deg)' : '';
}

// ─── Expose to HTML (onclick attrs) ────────────────────────────────────
// Alerta beforeunload si hay cambios sin guardar (parámetros o servicios).
window.addEventListener('beforeunload', (ev) => {
  if (_paramsTienenCambios() || _srvTieneCambios()) {
    ev.preventDefault();
    ev.returnValue = 'Tenés cambios sin guardar en parámetros o alquiler/suministros.';
    return ev.returnValue;
  }
});

Object.assign(window, {
  confirmParams, discardParams, confirmSrv, discardSrv,
  setSoc, togGlovo, syncSlider, syncPool, togglePanel,
  updLocalField, updHoras, togLoc,
  updPresFac, updPresReal, onPresMonthChange, togglePresWeek, updFacSemanal,
  navMes, srt, showTab, logout,
  loadSeguimiento, onSeguimientoFiltro,
});

// ─── Go ────────────────────────────────────────────────────────────────
boot();
