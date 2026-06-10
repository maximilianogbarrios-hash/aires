// /ads — F1 + F2 + F3.
// F1: Instagram orgánico + manejo de token IG.
// F2: Meta Ads (Marketing API) — lista campañas + acciones status/budget.
// F3: AI analysis + backups versionados + token User para Ads.

const $ = (id) => document.getElementById(id);
const eur0 = (v) => v == null ? '—' : new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 }).format(Math.round(v));
const eurFmt = (v) => v == null ? '—' : '€' + eur0(v);
const fmtDate = (iso) => { if (!iso) return ''; try { return new Date(iso).toLocaleDateString('es-ES', { day:'2-digit', month:'short', year:'numeric' }); } catch { return iso; } };
const fmtDateTime = (iso) => { if (!iso) return ''; try { return new Date(iso).toLocaleString('es-ES', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }); } catch { return iso; } };

const state = {
  config: null,
  dashboard: null,         // F1
  ads: null,               // F2
  backups: null,           // F3
  currentTab: 'reels',     // sub-tab dentro de IG
  mainTab: 'ig',           // tab principal (ig | ads | backup)
  tokKind: 'ig_access_token',
};

async function api(path, opts) {
  const r = await fetch(path, { credentials: 'same-origin', headers: { 'content-type': 'application/json' }, ...(opts || {}) });
  if (r.status === 401) { location.href = '/login'; return null; }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || j.message || `HTTP ${r.status}`); e.status = r.status; e.json = j; throw e; }
  return j;
}

async function boot() {
  try {
    const me = await api('/api/v1/auth/me');
    if (me?.user) $('tb-user').textContent = `${me.user.email} (${me.user.role})`;
  } catch {}
  await loadConfigStatus();
  await loadHealth();
}

async function loadConfigStatus() {
  try {
    const cfg = await api('/api/v1/meta/config-status');
    state.config = cfg;
    renderEnvStatus(cfg);
    if (cfg.env_missing.length > 0) {
      $('config-warning').style.display = '';
      $('main-tabs').style.display = 'none';
      $('dashboard-wrap').style.display = 'none';
      const ul = $('env-missing-list');
      ul.innerHTML = cfg.env_missing.map((k) => `<li>· ${k}</li>`).join('');
      return;
    }
    $('config-warning').style.display = 'none';
    $('main-tabs').style.display = '';
    setMainTab(state.mainTab);
  } catch (e) {
    console.error('config-status', e);
    $('config-warning').style.display = '';
    $('env-missing-list').innerHTML = `<li>Error: ${e.message}</li>`;
  }
}

function renderEnvStatus(cfg) {
  const items = [
    { k: 'IG_BUSINESS_ACCOUNT_ID', set: cfg.env_set.IG_BUSINESS_ACCOUNT_ID, req: 'F1' },
    { k: 'FACEBOOK_PAGE_ID',       set: cfg.env_set.FACEBOOK_PAGE_ID,       req: 'F1' },
    { k: 'META_TOKEN_KEY',         set: cfg.env_set.META_TOKEN_KEY,         req: 'F1 (clave AES)' },
    { k: 'INSTAGRAM_ACCESS_TOKEN', set: cfg.env_set.INSTAGRAM_ACCESS_TOKEN, req: 'F1 opcional · alternativa a cargar via UI' },
    { k: 'META_AD_ACCOUNT_ID',     set: cfg.env_set.META_AD_ACCOUNT_ID,     req: 'F2/F3 (formato act_xxx)' },
    { k: 'META_USER_TOKEN',        set: cfg.env_set.META_USER_TOKEN,        req: 'F2/F3 opcional · alternativa a cargar via UI' },
    { k: 'ANTHROPIC_API_KEY',      set: cfg.env_set.ANTHROPIC_API_KEY,      req: 'F3 IA' },
  ];
  $('env-status').innerHTML = items.map((it) => {
    const dot = it.set ? '<span style="color:#16a34a">●</span>' : '<span style="color:#d97706">○</span>';
    return `<li style="margin:3px 0">${dot} <strong>${it.k}</strong> <span style="color:var(--text-2);margin-left:8px">${it.req}</span></li>`;
  }).join('');
}

async function loadHealth() {
  try {
    const h = await api('/api/v1/meta/health');
    const el = $('health-status');
    if (h.ok) {
      el.innerHTML = `<span class="badge-warn badge-ok" style="background:rgba(99,153,34,.15);color:#16a34a">✓ Activo</span>
        <span style="font-size:11px;color:var(--text-2);margin-left:8px">fuente: ${h.source || '—'} · ${h.me?.name || ''}</span>`;
    } else {
      el.innerHTML = `<span class="badge-warn badge-err" style="background:rgba(220,38,38,.15);color:#dc2626">${h.status === 'missing' ? '○ Sin token IG' : '✗ ' + h.status}</span>
        <span style="font-size:11px;color:var(--text-2);margin-left:8px">${h.message || h.error || ''}</span>`;
    }
  } catch (e) {
    $('health-status').innerHTML = `<span class="badge-warn badge-err" style="background:rgba(220,38,38,.15);color:#dc2626">✗ Error</span> <span style="font-size:11px;color:var(--text-2);margin-left:8px">${e.message}</span>`;
  }
}

// ─── Tabs principales ────────────────────────────────────────────────
function setMainTab(name) {
  state.mainTab = name;
  ['ig', 'ads', 'backup'].forEach((t) => {
    const btn = $('tab-' + t);
    if (btn) btn.classList.toggle('on', t === name);
  });
  document.querySelectorAll('.main-section').forEach((el) => {
    el.style.display = el.dataset.section === name ? '' : 'none';
  });
  if (name === 'ig' && !state.dashboard) loadDashboardIg();
  else if (name === 'ig' && state.dashboard) $('dashboard-wrap').style.display = '';
  if (name === 'ads') loadAds();
  if (name === 'backup') loadBackups();
}

// ─── F1: Instagram orgánico ──────────────────────────────────────────
async function loadDashboardIg(refresh) {
  try {
    const data = await api('/api/v1/meta/dashboard/instagram' + (refresh ? '?refresh=1' : ''));
    state.dashboard = data;
    if (!data.ok && (data.status === 'no_token' || data.status === 'not_configured')) {
      $('dashboard-wrap').style.display = 'none';
      $('settings-details').open = true;
      return;
    }
    if (!data.ok) {
      $('dashboard-wrap').innerHTML = `<p style="padding:20px;color:#dc2626">Error: ${data.error || 'desconocido'}</p>`;
      $('dashboard-wrap').style.display = '';
      return;
    }
    $('dashboard-wrap').style.display = '';
    renderDashboardIg(data);
  } catch (e) {
    console.error('dashboard ig', e);
  }
}

function renderDashboardIg(d) {
  const p = d.profile || {};
  $('ig-name').textContent = p.name || p.username || '—';
  $('ig-username').textContent = p.username ? '@' + p.username : '—';
  if (p.profile_picture_url) $('ig-avatar').src = p.profile_picture_url;
  $('kpi-followers').textContent = eur0(p.followers_count);
  $('kpi-media').textContent = eur0(d.media_count);
  $('kpi-views').textContent = eur0(d.insights_28d?.views);
  $('kpi-reach').textContent = eur0(d.insights_28d?.reach);
  if (d.insights_28d?.warning) {
    $('ig-warning').style.display = '';
    $('ig-warning-text').textContent = d.insights_28d.warning;
  } else $('ig-warning').style.display = 'none';
  renderMediaGrid(state.currentTab);
  $('cache-info').textContent = d.cached
    ? `cached · age=${d.cache_age_sec}s · fuente token: ${d.token_source}`
    : `fresh · fetched=${fmtDate(d.fetched_at)} · fuente token: ${d.token_source}`;
}

function setMediaTab(name) {
  state.currentTab = name;
  $('tab-reels').classList.toggle('on', name === 'reels');
  $('tab-posts').classList.toggle('on', name === 'posts');
  renderMediaGrid(name);
}

function renderMediaGrid(tab) {
  const d = state.dashboard; if (!d) return;
  const items = tab === 'reels' ? (d.reels || []) : (d.posts || []);
  const g = $('media-grid');
  if (!items.length) { g.innerHTML = `<p style="grid-column:1/-1;text-align:center;color:var(--text-2);padding:2rem">Sin ${tab}.</p>`; return; }
  g.innerHTML = items.map((m) => {
    const caption = (m.caption || '').slice(0, 90).replace(/[<>&"]/g, '');
    const thumb = m.media_url || '';
    return `<div class="media-card">
      ${thumb ? `<a href="${m.permalink}" target="_blank" rel="noopener"><img class="media-thumb" src="${thumb}" loading="lazy" alt=""></a>` : `<div class="media-thumb"></div>`}
      <div class="media-body">
        <p style="font-size:10px;color:var(--text-2);margin-bottom:3px">${fmtDate(m.timestamp)}</p>
        <p style="font-size:11px;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${caption}">${caption || '(sin caption)'}</p>
        <div class="media-metrics">
          ${m.views != null ? `<span>👁 ${eur0(m.views)}</span>` : ''}
          ${m.reach != null ? `<span>📊 ${eur0(m.reach)}</span>` : ''}
          ${m.like_count != null ? `<span>♥ ${eur0(m.like_count)}</span>` : ''}
          ${m.comments_count != null ? `<span>💬 ${eur0(m.comments_count)}</span>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');
}

// ─── F2: Meta Ads ────────────────────────────────────────────────────
async function loadAds(refresh) {
  try {
    const data = await api('/api/v1/meta/ads' + (refresh ? '?refresh=1' : ''));
    state.ads = data;
    if (!data.ok) {
      $('ads-dash').style.display = 'none';
      $('ads-config-warning').style.display = '';
      const ul = $('ads-env-missing-list');
      if (data.status === 'not_configured') {
        ul.innerHTML = (data.missing_env || []).map((k) => `<li>· ${k}</li>`).join('');
      } else if (data.status === 'no_token') {
        ul.innerHTML = `<li>Sin User Access Token. Cargá uno en Settings → "User Token Ads" o seteá META_USER_TOKEN en Railway.</li><li style="margin-top:8px;color:var(--text-2)">${data.hint || ''}</li>`;
      } else {
        ul.innerHTML = `<li>Error Meta Ads: ${data.error || 'desconocido'}</li><li style="margin-top:8px;color:var(--text-2)">${data.hint || ''}</li>`;
      }
      return;
    }
    $('ads-config-warning').style.display = 'none';
    $('ads-dash').style.display = '';
    renderAds(data);
  } catch (e) {
    console.error('ads', e);
  }
}

function renderAds(d) {
  const acc = d.ad_account || {};
  $('ads-acc-name').textContent = acc.name || acc.id || '—';
  $('ads-acc-id').textContent = `${acc.id || ''} · ${acc.currency || ''} · status=${acc.account_status || '—'}`;
  const t = d.totals_last_30d || {};
  $('ads-kpi-spend').textContent = eurFmt(t.spend);
  $('ads-kpi-imp').textContent   = eur0(t.impressions);
  $('ads-kpi-clicks').textContent = eur0(t.clicks);
  $('ads-kpi-cpc').textContent   = t.cpc != null ? '€' + t.cpc.toFixed(2) : '—';

  $('ads-camp-counter').textContent = `${d.n_campaigns} campañas · ${d.n_adsets} adsets · ${d.n_ads} ads`;
  const list = $('ads-camp-list');
  if (!d.campaigns?.length) { list.innerHTML = '<p style="color:var(--text-2);padding:1rem">Sin campañas.</p>'; return; }
  list.innerHTML = d.campaigns.map((c) => {
    const statusBg = c.effective_status === 'ACTIVE' ? 'rgba(99,153,34,.18)'
                   : c.effective_status === 'PAUSED' ? 'rgba(217,119,6,.18)' : 'rgba(150,150,150,.18)';
    const statusColor = c.effective_status === 'ACTIVE' ? '#16a34a' : c.effective_status === 'PAUSED' ? '#d97706' : '#888';
    const i = c.insights || {};
    return `<details style="border:.5px solid var(--border-3);border-radius:var(--r-md);padding:.5rem .75rem;margin-bottom:6px;background:var(--bg-secondary)">
      <summary style="cursor:pointer;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span style="padding:2px 8px;border-radius:10px;font-size:10px;background:${statusBg};color:${statusColor};font-weight:500">${c.effective_status}</span>
        <strong style="font-size:13px">${c.name}</strong>
        <span style="color:var(--text-2);font-size:11px">${c.objective} · ${c.n_adsets} adsets · ${c.n_ads} ads</span>
        <span style="margin-left:auto;font-size:12px;color:#dc2626">${eurFmt(i.spend)}</span>
        <span style="font-size:10px;color:var(--text-2)">${eur0(i.impressions)} imp · ${eur0(i.clicks)} clics${i.cpc != null ? ' · CPC €'+i.cpc.toFixed(2) : ''}</span>
      </summary>
      <div style="margin-top:8px;padding-top:8px;border-top:.5px dashed var(--border-3)">
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">
          <button onclick="campToggle('${c.id}','${c.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE'}')" style="padding:3px 10px;font-size:10px;border-radius:4px;cursor:pointer;border:.5px solid var(--border-2);background:transparent;color:var(--text)">${c.status === 'ACTIVE' ? '⏸ Pausar' : '▶ Activar'} campaña</button>
          <button onclick="campBudget('${c.id}','${c.budget?.kind || ''}',${c.budget?.monto || 0})" style="padding:3px 10px;font-size:10px;border-radius:4px;cursor:pointer;border:.5px solid var(--border-2);background:transparent;color:var(--text)">💰 Presupuesto (${c.budget?.kind ? `${c.budget.kind}=€${c.budget.monto}` : 'sin'})</button>
        </div>
        ${c.adsets.map((s) => {
          const si = s.insights || {};
          return `<div style="margin-left:1rem;padding:6px 8px;border-left:2px solid var(--border-3);margin-bottom:4px">
            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
              <span style="padding:1px 6px;border-radius:8px;font-size:9px;background:${s.effective_status === 'ACTIVE' ? 'rgba(99,153,34,.15)' : 'rgba(150,150,150,.15)'};color:${s.effective_status === 'ACTIVE' ? '#16a34a' : '#888'}">${s.effective_status}</span>
              <span style="font-size:12px;font-weight:500">${s.name}</span>
              <span style="color:var(--text-2);font-size:10px">${s.n_ads} ads · ${s.budget?.kind ? `${s.budget.kind}=€${s.budget.monto}` : 'sin presupuesto'}</span>
              <span style="margin-left:auto;font-size:11px">${eurFmt(si.spend)} · ${eur0(si.impressions)} imp</span>
              <button onclick="adsetToggle('${s.id}','${s.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE'}')" style="padding:2px 8px;font-size:10px;border-radius:4px;cursor:pointer;border:.5px solid var(--border-2);background:transparent;color:var(--text)">${s.status === 'ACTIVE' ? '⏸' : '▶'}</button>
            </div>
            ${s.ads.length ? `<div style="margin-left:1.2rem;margin-top:4px;font-size:10px;color:var(--text-2)">${s.ads.length} ads: ${s.ads.slice(0, 3).map((a) => `${a.name}${a.effective_status !== 'ACTIVE' ? ' ('+a.effective_status+')' : ''}`).join(' · ')}${s.ads.length > 3 ? ' …' : ''}</div>` : ''}
          </div>`;
        }).join('')}
      </div>
    </details>`;
  }).join('');
}

async function _toggleEntity(kind, id, status) {
  try {
    await api(`/api/v1/meta/${kind}/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) });
    await loadAds(true);
  } catch (e) { alert('Error: ' + e.message); }
}
function campToggle(id, status)  { _toggleEntity('campaign', id, status); }
function adsetToggle(id, status) { _toggleEntity('adset', id, status); }
function adToggle(id, status)    { _toggleEntity('ad', id, status); }

async function campBudget(id, kind, current) {
  const nuevo = prompt(`Nuevo presupuesto en € (${kind || 'daily o lifetime'}). Actual: €${current}`, current);
  if (nuevo == null) return;
  const monto = Number(nuevo);
  if (!Number.isFinite(monto) || monto <= 0) { alert('Monto inválido'); return; }
  const body = kind === 'lifetime' ? { lifetime_budget: monto } : { daily_budget: monto };
  try {
    await api(`/api/v1/meta/campaign/${id}/budget`, { method: 'POST', body: JSON.stringify(body) });
    await loadAds(true);
  } catch (e) { alert('Error: ' + e.message); }
}

// ─── F3: AI analysis ─────────────────────────────────────────────────
async function runAi() {
  const btn = $('ai-btn'); const out = $('ai-output');
  if (state.config && !state.config.ai_enabled) {
    out.textContent = 'Configurá ANTHROPIC_API_KEY en Railway para habilitar el análisis IA.';
    btn.disabled = true; btn.textContent = 'IA deshabilitada';
    return;
  }
  btn.disabled = true; btn.textContent = 'Generando…';
  out.textContent = 'Pensando…';
  try {
    const r = await api('/api/v1/meta/ai-analysis');
    if (r.ok) {
      out.textContent = r.analysis + `\n\n— ${r.model} · ${r.input_tokens}→${r.output_tokens} tokens${r.cached ? ' (cache)' : ''}`;
    } else {
      out.textContent = '✗ ' + (r.message || r.error || 'sin datos para analizar');
    }
  } catch (e) {
    out.textContent = '✗ ' + e.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Generar análisis';
  }
}

// ─── F3: Backups ─────────────────────────────────────────────────────
async function loadBackups() {
  try {
    const r = await api('/api/v1/meta/backup/list');
    state.backups = r.backups || [];
    renderBackups();
  } catch (e) {
    $('backup-list').innerHTML = `<p style="color:#dc2626">Error: ${e.message}</p>`;
  }
}
function renderBackups() {
  const list = $('backup-list');
  if (!state.backups?.length) { list.innerHTML = '<p style="color:var(--text-2)">Sin backups todavía. Creá el primero con el botón ↑</p>'; return; }
  list.innerHTML = state.backups.map((b) => `
    <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:.5px solid var(--border-3);border-radius:var(--r-md);margin-bottom:4px;background:var(--bg-secondary)">
      <div style="flex:1">
        <p style="font-size:12px;font-weight:500">${fmtDateTime(b.ts)}</p>
        <p style="font-size:10px;color:var(--text-2)">${b.ad_account_name || b.ad_account_id} · ${b.campaigns_count} camp · ${b.adsets_count} adsets · ${b.ads_count} ads · ${Math.round(b.bytes/1024)}KB · ${b.trigger_kind}${b.triggered_by ? ' · '+b.triggered_by : ''}</p>
      </div>
      <a href="/api/v1/meta/backup/${b.id}/json" target="_blank" style="font-size:10px;padding:3px 8px;border:.5px solid var(--border-2);border-radius:4px;color:var(--text);text-decoration:none">JSON</a>
      <a href="/api/v1/meta/backup/${b.id}/csv" download style="font-size:10px;padding:3px 8px;border:.5px solid var(--border-2);border-radius:4px;color:var(--text);text-decoration:none">CSV</a>
    </div>
  `).join('');
}
async function createBackup() {
  const btn = $('backup-create-btn');
  btn.disabled = true; btn.textContent = 'Creando…';
  try {
    const r = await api('/api/v1/meta/backup/create', { method: 'POST' });
    if (r.ok) await loadBackups();
    else alert('Error: ' + (r.error || 'desconocido'));
  } catch (e) { alert('Error: ' + e.message); }
  finally { btn.disabled = false; btn.textContent = '+ Crear backup ahora'; }
}

async function refresh() {
  const btn = $('btn-refresh');
  btn.disabled = true; btn.textContent = '↻ Refrescando…';
  try {
    await loadHealth();
    if (state.mainTab === 'ig')      await loadDashboardIg(true);
    else if (state.mainTab === 'ads') await loadAds(true);
    else if (state.mainTab === 'backup') await loadBackups();
  } finally { btn.disabled = false; btn.textContent = '↻ Refrescar'; }
}

// ─── Token UI ────────────────────────────────────────────────────────
function setTokKind(kind) {
  state.tokKind = kind;
  $('tok-kind-ig').classList.toggle('on', kind === 'ig_access_token');
  $('tok-kind-user').classList.toggle('on', kind === 'meta_user_token');
  $('tok-input').placeholder = kind === 'meta_user_token'
    ? 'Pegá el User Access Token (Marketing API). Permisos: ads_read, ads_management, business_management.'
    : 'Pegá el Page Access Token (IG). Permisos: instagram_basic, instagram_manage_insights, pages_read_engagement, pages_show_list.';
  $('tok-result').textContent = '';
}

async function probeTok() {
  const tok = $('tok-input').value.trim();
  if (!tok) { $('tok-result').textContent = 'Pegá un token primero.'; return; }
  $('tok-result').textContent = 'Probando…';
  try {
    const r = await api('/api/v1/meta/token', { method: 'POST', body: JSON.stringify({ token: tok, dry_run: true, kind: state.tokKind }) });
    $('tok-result').textContent = `✓ Token válido — ${r.me?.name || r.me?.id || ''} (no fue guardado)`;
  } catch (e) { $('tok-result').textContent = '✗ ' + e.message; }
}

async function saveTok() {
  const tok = $('tok-input').value.trim();
  if (!tok) { $('tok-result').textContent = 'Pegá un token primero.'; return; }
  $('tok-result').textContent = 'Guardando…';
  try {
    const r = await api('/api/v1/meta/token', { method: 'POST', body: JSON.stringify({ token: tok, kind: state.tokKind }) });
    $('tok-result').textContent = `✓ Token "${state.tokKind}" guardado @ ${fmtDate(r.saved_at)} — ${r.me?.name || ''}`;
    $('tok-input').value = '';
    await loadHealth();
    if (state.mainTab === 'ig') await loadDashboardIg(true);
    if (state.mainTab === 'ads') await loadAds(true);
  } catch (e) { $('tok-result').textContent = '✗ ' + e.message + (e.json?.code === 'META_TOKEN_KEY_MISSING' ? ' (revisá Settings → env vars)' : ''); }
}

async function clearTok() {
  if (!confirm(`Borrar el token "${state.tokKind}" guardado en DB? Si tenés env var equivalente, vuelve a usar esa.`)) return;
  try {
    await api(`/api/v1/meta/token?kind=${state.tokKind}`, { method: 'DELETE' });
    $('tok-result').textContent = `✓ Token "${state.tokKind}" borrado de DB.`;
    await loadHealth();
    if (state.mainTab === 'ig') await loadDashboardIg(true);
    if (state.mainTab === 'ads') await loadAds(true);
  } catch (e) { $('tok-result').textContent = '✗ ' + e.message; }
}

window.refresh = refresh;
window.setMediaTab = setMediaTab;
window.setMainTab = setMainTab;
window.probeTok = probeTok;
window.saveTok = saveTok;
window.clearTok = clearTok;
window.setTokKind = setTokKind;
window.campToggle = campToggle;
window.adsetToggle = adsetToggle;
window.adToggle = adToggle;
window.campBudget = campBudget;
window.runAi = runAi;
window.createBackup = createBackup;
window.loadBackups = loadBackups;

boot();
