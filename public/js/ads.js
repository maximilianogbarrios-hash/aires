// /ads — Meta Ads · Instagram (F1).
// Carga config-status primero; según resultado muestra dashboard o panel "Configurá".
// Settings (token UI) siempre visible para que el user pueda cargar el token.

const $ = (id) => document.getElementById(id);
const eur0 = (v) => v == null ? '—' : new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 }).format(Math.round(v));
const fmtDate = (iso) => { if (!iso) return ''; try { return new Date(iso).toLocaleDateString('es-ES', { day:'2-digit', month:'short', year:'numeric' }); } catch { return iso; } };

const state = { config: null, dashboard: null, currentTab: 'reels' };

async function api(path, opts) {
  const r = await fetch(path, { credentials: 'same-origin', headers: { 'content-type': 'application/json' }, ...(opts || {}) });
  if (r.status === 401) { location.href = '/login'; return null; }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || j.message || `HTTP ${r.status}`); e.status = r.status; e.json = j; throw e; }
  return j;
}

async function boot() {
  // Usuario para el topbar (best-effort).
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
      // Faltan env vars críticas → muestra aviso, NO conecta a nada.
      $('config-warning').style.display = '';
      $('dashboard-wrap').style.display = 'none';
      const ul = $('env-missing-list');
      ul.innerHTML = cfg.env_missing.map((k) => `<li>· ${k}</li>`).join('');
      return;
    }
    // Config OK → cargar dashboard.
    $('config-warning').style.display = 'none';
    await loadDashboard();
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
    { k: 'META_TOKEN_KEY',         set: cfg.env_set.META_TOKEN_KEY,         req: 'F1' },
    { k: 'INSTAGRAM_ACCESS_TOKEN', set: cfg.env_set.INSTAGRAM_ACCESS_TOKEN, req: 'F1 opcional · alternativa a cargar token vía UI' },
    { k: 'META_AD_ACCOUNT_ID',     set: cfg.env_set.META_AD_ACCOUNT_ID,     req: 'F2/F3' },
    { k: 'META_USER_TOKEN',        set: cfg.env_set.META_USER_TOKEN,        req: 'F2/F3' },
    { k: 'ANTHROPIC_API_KEY',      set: cfg.env_set.ANTHROPIC_API_KEY,      req: 'F3 (IA)' },
  ];
  $('env-status').innerHTML = items.map((it) => {
    const dot = it.set ? '<span class="badge-ok badge-warn" style="background:rgba(99,153,34,.15);color:#16a34a">●</span>'
                       : '<span class="badge-warn">○</span>';
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
      el.innerHTML = `<span class="badge-warn badge-err" style="background:rgba(220,38,38,.15);color:#dc2626">${h.status === 'missing' ? '○ Sin token' : '✗ ' + h.status}</span>
        <span style="font-size:11px;color:var(--text-2);margin-left:8px">${h.message || h.error || ''}</span>`;
    }
  } catch (e) {
    $('health-status').innerHTML = `<span class="badge-warn badge-err" style="background:rgba(220,38,38,.15);color:#dc2626">✗ Error</span> <span style="font-size:11px;color:var(--text-2);margin-left:8px">${e.message}</span>`;
  }
}

async function loadDashboard(refresh) {
  try {
    const data = await api('/api/v1/meta/dashboard/instagram' + (refresh ? '?refresh=1' : ''));
    state.dashboard = data;
    if (data.status === 'not_configured') {
      $('config-warning').style.display = '';
      $('env-missing-list').innerHTML = (data.missing_env || []).map((k) => `<li>· ${k}</li>`).join('');
      return;
    }
    if (data.status === 'no_token') {
      $('config-warning').style.display = '';
      $('env-missing-list').innerHTML = `<li>Sin token de Instagram cargado. Pegalo en Settings ↓</li>`;
      // Abrir el settings card automáticamente.
      $('settings-details').open = true;
      return;
    }
    if (!data.ok) {
      $('config-warning').style.display = '';
      $('env-missing-list').innerHTML = `<li>Error Meta: ${data.error || 'desconocido'}</li><li style="margin-top:6px;color:var(--text-2);font-size:11px">${data.hint || ''}</li>`;
      return;
    }
    $('config-warning').style.display = 'none';
    $('dashboard-wrap').style.display = '';
    renderDashboard(data);
  } catch (e) {
    console.error('dashboard', e);
    $('config-warning').style.display = '';
    $('env-missing-list').innerHTML = `<li>Error: ${e.message}</li>`;
  }
}

function renderDashboard(d) {
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
  } else {
    $('ig-warning').style.display = 'none';
  }
  renderMediaGrid(state.currentTab);
  const cInfo = d.cached
    ? `cached · age=${d.cache_age_sec}s · fuente token: ${d.token_source}`
    : `fresh · fetched=${fmtDate(d.fetched_at)} · fuente token: ${d.token_source}`;
  $('cache-info').textContent = cInfo;
}

function setMediaTab(name) {
  state.currentTab = name;
  $('tab-reels').classList.toggle('on', name === 'reels');
  $('tab-posts').classList.toggle('on', name === 'posts');
  renderMediaGrid(name);
}

function renderMediaGrid(tab) {
  const d = state.dashboard;
  if (!d) return;
  const items = tab === 'reels' ? (d.reels || []) : (d.posts || []);
  const g = $('media-grid');
  if (!items.length) {
    g.innerHTML = `<p style="grid-column:1/-1;text-align:center;color:var(--text-2);padding:2rem">Sin ${tab}.</p>`;
    return;
  }
  g.innerHTML = items.map((m) => {
    const caption = (m.caption || '').slice(0, 90).replace(/[<>&"]/g, '');
    const dt = fmtDate(m.timestamp);
    const thumb = m.media_url || '';
    return `<div class="media-card">
      ${thumb ? `<a href="${m.permalink}" target="_blank" rel="noopener"><img class="media-thumb" src="${thumb}" loading="lazy" alt=""></a>` : `<div class="media-thumb"></div>`}
      <div class="media-body">
        <p style="font-size:10px;color:var(--text-2);margin-bottom:3px">${dt}</p>
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

async function refresh() {
  const btn = $('btn-refresh');
  btn.disabled = true; btn.textContent = '↻ Refrescando…';
  try {
    await loadHealth();
    await loadDashboard(true);
  } finally {
    btn.disabled = false; btn.textContent = '↻ Refrescar';
  }
}

// ─── Token UI ────────────────────────────────────────────────────────
async function probeTok() {
  const tok = $('tok-input').value.trim();
  if (!tok) { $('tok-result').textContent = 'Pegá un token primero.'; return; }
  $('tok-result').textContent = 'Probando…';
  try {
    const r = await api('/api/v1/meta/token', { method: 'POST', body: JSON.stringify({ token: tok, dry_run: true }) });
    $('tok-result').textContent = `✓ Token válido — ${r.me?.name || r.me?.id || ''} (no fue guardado)`;
  } catch (e) {
    $('tok-result').textContent = '✗ ' + e.message;
  }
}

async function saveTok() {
  const tok = $('tok-input').value.trim();
  if (!tok) { $('tok-result').textContent = 'Pegá un token primero.'; return; }
  $('tok-result').textContent = 'Guardando…';
  try {
    const r = await api('/api/v1/meta/token', { method: 'POST', body: JSON.stringify({ token: tok }) });
    $('tok-result').textContent = `✓ Token guardado @ ${fmtDate(r.saved_at)} — ${r.me?.name || ''}`;
    $('tok-input').value = '';
    await loadHealth();
    await loadDashboard(true);
  } catch (e) {
    $('tok-result').textContent = '✗ ' + e.message + (e.json?.code === 'META_TOKEN_KEY_MISSING' ? ' (revisá Settings → env vars)' : '');
  }
}

async function clearTok() {
  if (!confirm('Borrar el token guardado en DB? Si tenés env var INSTAGRAM_ACCESS_TOKEN, vuelve a usar esa.')) return;
  try {
    await api('/api/v1/meta/token?kind=ig_access_token', { method: 'DELETE' });
    $('tok-result').textContent = '✓ Token borrado de DB.';
    await loadHealth();
    await loadDashboard(true);
  } catch (e) {
    $('tok-result').textContent = '✗ ' + e.message;
  }
}

window.refresh = refresh;
window.setMediaTab = setMediaTab;
window.probeTok = probeTok;
window.saveTok = saveTok;
window.clearTok = clearTok;

boot();
