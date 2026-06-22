// /ads — F1 + F2 + F3.
// F1: Instagram orgánico + manejo de token IG.
// F2: Meta Ads (Marketing API) — lista campañas + acciones status/budget.
// F3: AI analysis + backups versionados + token User para Ads.

const $ = (id) => document.getElementById(id);
const eur0 = (v) => v == null ? '—' : new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 }).format(Math.round(v));
const eurFmt = (v) => v == null ? '—' : '€' + eur0(v);
const fmtDate = (iso) => { if (!iso) return ''; try { return new Date(iso).toLocaleDateString('es-ES', { day:'2-digit', month:'short', year:'numeric' }); } catch { return iso; } };
const fmtDateTime = (iso) => { if (!iso) return ''; try { return new Date(iso).toLocaleString('es-ES', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }); } catch { return iso; } };
// "hace 5 min", "hace 2h", "hace 3d" — antigüedad humanizada del cache.
function ago(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '';
  if (seconds < 60) return `hace ${Math.round(seconds)}s`;
  if (seconds < 3600) return `hace ${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `hace ${Math.round(seconds / 3600)}h`;
  return `hace ${Math.round(seconds / 86400)}d`;
}

// ─── Toast + loading helpers ─────────────────────────────────────────
// toast(msg, 'ok'|'err'|'info') — esquina inferior derecha, 3.5s.
function toast(msg, kind = 'info', durationMs = 3500) {
  const stack = $('toast-stack'); if (!stack) { console.log('[toast]', msg); return; }
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  stack.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 280);
  }, durationMs);
}
// Marca un botón como cargando (spinner + disable). Restaurar pasando isLoading=false.
function setBtnLoading(btn, isLoading, loadingLabel) {
  if (!btn) return;
  if (isLoading) {
    if (!btn.dataset._origText) btn.dataset._origText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span>' + (loadingLabel || 'Procesando…');
  } else {
    btn.disabled = false;
    if (btn.dataset._origText) { btn.innerHTML = btn.dataset._origText; delete btn.dataset._origText; }
  }
}

// ─── Objetivo de campaña en español ──────────────────────────────────
// Traducción de los `objective` que devuelve Marketing API a lenguaje
// claro (badge + tooltip). Si aparece uno no listado, devuelve el
// original tal cual para que el user vea algo y no mienta.
const OBJECTIVE_DICT = {
  LINK_CLICKS:         { label: 'Tráfico',                  hint: 'Conseguir clics al sitio o al perfil.' },
  OUTCOME_TRAFFIC:     { label: 'Tráfico',                  hint: 'Conseguir clics al sitio o al perfil.' },
  OUTCOME_AWARENESS:   { label: 'Reconocimiento',           hint: 'Que la marca se vea — alcance + impresiones.' },
  BRAND_AWARENESS:     { label: 'Reconocimiento',           hint: 'Que la marca se vea — alcance + impresiones.' },
  REACH:               { label: 'Alcance',                  hint: 'Llegar a la mayor cantidad de personas distintas.' },
  OUTCOME_ENGAGEMENT:  { label: 'Interacción',              hint: 'Likes, comentarios, mensajes, guardados.' },
  POST_ENGAGEMENT:     { label: 'Interacción',              hint: 'Likes, comentarios, mensajes, guardados.' },
  OUTCOME_SALES:       { label: 'Ventas / Conversiones',    hint: 'Acciones de compra o conversión en el sitio.' },
  CONVERSIONS:         { label: 'Ventas / Conversiones',    hint: 'Acciones de compra o conversión en el sitio.' },
  OUTCOME_LEADS:       { label: 'Clientes potenciales',     hint: 'Captar datos de gente interesada (formulario).' },
  LEAD_GENERATION:     { label: 'Clientes potenciales',     hint: 'Captar datos de gente interesada (formulario).' },
  VIDEO_VIEWS:         { label: 'Vistas de video',          hint: 'Que el video se reproduzca lo más posible.' },
  MESSAGES:            { label: 'Mensajes',                 hint: 'Iniciar conversaciones por DM/WhatsApp.' },
};
function objectiveLabel(obj) {
  if (!obj) return { label: '—', hint: '' };
  const d = OBJECTIVE_DICT[obj];
  if (d) return d;
  return { label: obj, hint: 'Objetivo personalizado/menos común — sin traducción definida.' };
}

// ─── Helpers de presupuesto ──────────────────────────────────────────
function formatBudget(b) {
  if (!b || !b.kind) return null;
  if (b.kind === 'mixed') return { text: `€${eur0(b.daily || 0)}/día + €${eur0(b.lifetime || 0)} total`, kind: 'mixed' };
  const sufijo = b.kind === 'daily' ? '/día' : ' total';
  return { text: `€${eur0(b.monto)}${sufijo}`, kind: b.kind };
}

// ─── CTA traducido (call_to_action_type) ─────────────────────────────
const CTA_DICT = {
  LEARN_MORE: 'Más información', SHOP_NOW: 'Comprar', SIGN_UP: 'Registrate',
  BOOK_TRAVEL: 'Reservar', DOWNLOAD: 'Descargar', GET_QUOTE: 'Cotizar',
  CONTACT_US: 'Contactanos', SEND_MESSAGE: 'Mandanos un mensaje',
  SUBSCRIBE: 'Suscribirse', WATCH_MORE: 'Mirá más', ORDER_NOW: 'Pedí ahora',
  APPLY_NOW: 'Aplicar', GET_OFFER: 'Ver oferta', WHATSAPP_MESSAGE: 'Chat por WhatsApp',
  CALL_NOW: 'Llamar ahora', GET_DIRECTIONS: 'Cómo llegar',
};
function ctaLabel(t) { return t ? (CTA_DICT[t] || t.replace(/_/g, ' ').toLowerCase()) : null; }

const state = {
  config: null,
  dashboard: null,
  ads: null,
  backups: null,
  currentTab: 'reels',
  mainTab: 'ig',
  tokKind: 'ig_access_token',
  glossary: null,
  igPeriod: 30,            // 30 | 60 | 90
  igSort: 'reach',         // reach|views|interactions|saved|shares|timestamp
};

// ─── Glosario / tooltips ─────────────────────────────────────────────
// Inyecta un ⓘ junto a la métrica. Hover/tap muestra: qué es, qué valor
// es bueno/malo, qué hacer. Componente único reutilizable.
function infoIcon(kind, metric) {
  if (!state.glossary) return '';
  const def = state.glossary[kind]?.[metric];
  if (!def) return '';
  const tip = [
    def.what || '',
    def.good_bad || '',
    def.action || '',
  ].filter(Boolean).join('\n\n');
  const esc = tip.replace(/"/g, '&quot;');
  return `<span class="tip-icon" title="${esc}" aria-label="info" style="display:inline-block;margin-left:4px;font-size:10px;color:var(--text-2);cursor:help;border:.5px solid var(--border-2);border-radius:50%;width:13px;height:13px;line-height:11px;text-align:center;vertical-align:middle">i</span>`;
}
// HTML "Label ⓘ" para usar en headers de KPI/tabla.
function labelWithInfo(kind, metric, fallbackLabel) {
  const def = state.glossary?.[kind]?.[metric];
  const lab = def?.label || fallbackLabel || metric;
  return `${lab}${infoIcon(kind, metric)}`;
}
// URL de proxy para miniaturas (evita CDN bloqueado por hotlink).
function thumbProxy(url) {
  if (!url) return '';
  return '/api/v1/meta/media-thumb?url=' + encodeURIComponent(url);
}
// Escalera de imagen para una campaña: thumbnail directo del creative
// (primary_thumbnail ya resuelve fbcdn → ig_thumbnail en el backend),
// si no hay nada → string vacío (el render muestra placeholder con
// link a Instagram).
function campThumb(c) {
  return c.primary_thumbnail ? thumbProxy(c.primary_thumbnail) : '';
}
function adThumb(a) {
  return a.thumbnail_resolved ? thumbProxy(a.thumbnail_resolved) : '';
}
// Renderizador de markdown ligero (headings + bold + listas + saltos)
// usado para el análisis IA. Escapa HTML primero.
function renderMarkdownLight(md) {
  if (!md) return '';
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  let out = esc(md);
  out = out.replace(/^## (.+)$/gm, '<h3 style="font-size:13px;font-weight:600;margin:.75rem 0 .25rem">$1</h3>');
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  out = out.replace(/(<li>.*<\/li>\n?)+/gs, (m) => '<ol style="margin:.25rem 0 .25rem 1.2rem;padding:0">' + m + '</ol>');
  out = out.replace(/^- (.+)$/gm, '<li>$1</li>');
  out = out.split('\n\n').map((p) => p.trim() ? (p.startsWith('<') ? p : '<p style="margin:.4rem 0">' + p.replace(/\n/g, '<br>') + '</p>') : '').join('');
  return out;
}

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
  // Glosario primero — el resto del render lo usa para tooltips.
  try {
    const g = await api('/api/v1/meta/glossary');
    state.glossary = { ads: g.ads, ig: g.ig };
  } catch (e) { console.warn('glossary:', e.message); }
  await loadConfigStatus();
  await loadHealth();
  initSpendChartsObserver();
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

// ─── Instagram orgánico (Parte A) ───────────────────────────────────
async function loadDashboardIg(refresh) {
  try {
    const qs = new URLSearchParams();
    qs.set('period', state.igPeriod);
    if (refresh) qs.set('refresh', '1');
    const data = await api('/api/v1/meta/dashboard/instagram?' + qs.toString());
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
  if (p.profile_picture_url) $('ig-avatar').src = thumbProxy(p.profile_picture_url);
  const periodLbl = (d.period_days || 30) + 'd';
  const ins = d.insights || {};
  // Tarjeta KPI con variación vs período anterior.
  const kpi = (key, label, value, varPct, isPct) => {
    const valStr = value == null ? '—' : (isPct ? (value * 100).toFixed(2) + '%' : eur0(value));
    let varHtml = '';
    if (varPct != null && Number.isFinite(varPct)) {
      const arrow = varPct > 0.5 ? '↑' : varPct < -0.5 ? '↓' : '→';
      const color = varPct > 0.5 ? '#16a34a' : varPct < -0.5 ? '#dc2626' : 'var(--text-2)';
      varHtml = `<span style="font-size:10px;color:${color};margin-left:4px">${arrow} ${varPct > 0 ? '+' : ''}${varPct.toFixed(1)}%</span>`;
    }
    return `<div class="surf">
      <p style="font-size:11px;color:var(--text-2)">${labelWithInfo('ig', key, label)}</p>
      <p style="font-size:19px;font-weight:500">${valStr}${varHtml}</p>
    </div>`;
  };
  $('ig-kpis').innerHTML =
    kpi('followers',     'Seguidores',          p.followers_count,    null, false) +
    kpi('reach',         `Alcance ${periodLbl}`, ins.reach,            ins.reach_var_pct, false) +
    kpi('views',         `Visualizaciones ${periodLbl}`, ins.views,    ins.views_var_pct, false) +
    kpi('profile_views', `Visitas perfil ${periodLbl}`, ins.profile_views, ins.profile_views_var_pct, false);

  if (ins.warning) {
    $('ig-warning').style.display = '';
    $('ig-warning-text').textContent = ins.warning;
  } else $('ig-warning').style.display = 'none';

  renderIgRanking(d);
  renderIgAudience(d);
  renderMediaGrid(state.currentTab);
  $('cache-info').textContent = d.cached
    ? `Actualizado ${ago(d.cache_age_sec)} · fuente token: ${d.token_source}`
    : `Recién actualizado · fuente token: ${d.token_source}`;
}

function setIgPeriod(p) {
  if (![30, 60, 90].includes(p)) return;
  state.igPeriod = p;
  ['30','60','90'].forEach((k) => {
    const el = $('igp-' + k); if (!el) return;
    const on = +k === p;
    el.style.background = on ? '#185FA5' : 'transparent';
    el.style.color = on ? '#fff' : 'var(--text)';
    el.style.fontWeight = on ? '500' : '400';
  });
  loadDashboardIg(false);
}

function setIgSort(v) { state.igSort = v; renderMediaGrid(state.currentTab); }

function renderIgRanking(d) {
  const tab = state.currentTab; // reels | posts
  const top = tab === 'reels' ? d.reels_top : d.posts_top;
  const bot = tab === 'reels' ? d.reels_bottom : d.posts_bottom;
  const renderItem = (m) => {
    const thumb = m.thumbnail_url || m.media_url || '';
    const proxied = thumbProxy(thumb);
    const caption = (m.caption || '').slice(0, 60).replace(/[<>"]/g, '');
    return `<div style="display:flex;gap:8px;align-items:flex-start;padding:6px 0;border-bottom:.5px dashed var(--border-3)">
      ${thumb ? `<a href="${m.permalink}" target="_blank" rel="noopener" style="flex-shrink:0"><img src="${proxied}" style="width:48px;height:48px;border-radius:4px;object-fit:cover;background:var(--bg-secondary)" loading="lazy" alt="" onerror="this.style.display='none'"></a>` : ''}
      <div style="flex:1;min-width:0">
        <p style="font-size:11px;line-height:1.3;margin-bottom:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${caption.replace(/"/g,'&quot;')}">${caption || '(sin caption)'}</p>
        <p style="font-size:10px;color:var(--text-2);margin-bottom:2px">
          ${m.reach != null ? `📊 ${eur0(m.reach)}` : ''}
          ${m.saved != null ? ` · ★ ${eur0(m.saved)}` : ''}
          ${m.shares != null ? ` · ↗ ${eur0(m.shares)}` : ''}
          ${m.score ? ` · score ${m.score.toFixed(2)}` : ''}
        </p>
        <p style="font-size:10px;color:var(--text-2);font-style:italic">${m.motivo || ''}</p>
      </div>
    </div>`;
  };
  $('ig-top-list').innerHTML = top?.length ? top.map(renderItem).join('') : `<p style="font-size:11px;color:var(--text-2);padding:1rem">Sin ${tab} en el período.</p>`;
  $('ig-bottom-list').innerHTML = bot?.length ? bot.map(renderItem).join('') : `<p style="font-size:11px;color:var(--text-2);padding:1rem">Sin datos suficientes para detectar los peores.</p>`;
}

function renderIgAudience(d) {
  const aud = d.audience;
  const el = $('ig-audience');
  if (!aud) {
    const warns = (d.audience_warnings || []).join(' · ') || 'Audiencia no disponible para esta cuenta.';
    el.innerHTML = `<p style="grid-column:1/-1;font-size:11px;color:var(--text-2)">${warns}</p>`;
    return;
  }
  const block = (titulo, key, formatKey) => {
    const items = aud[key];
    if (!items?.length) return `<div><p style="font-size:11px;color:var(--text-2)">${titulo}: sin datos</p></div>`;
    const max = Math.max(...items.map((x) => x.value));
    const rows = items.slice(0, 8).map((x) => {
      const pct = max > 0 ? (x.value / max * 100).toFixed(0) : 0;
      return `<div style="display:flex;align-items:center;gap:6px;font-size:11px;margin:3px 0">
        <span style="width:42%;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${formatKey ? formatKey(x.key) : x.key}</span>
        <div style="flex:1;background:var(--bg-secondary);height:6px;border-radius:3px;overflow:hidden"><div style="height:100%;width:${pct}%;background:#185FA5"></div></div>
        <span style="width:48px;text-align:right">${eur0(x.value)}</span>
      </div>`;
    }).join('');
    return `<div>
      <p style="font-size:12px;font-weight:500;margin-bottom:6px">${titulo}</p>
      ${rows}
    </div>`;
  };
  el.innerHTML =
    block('🌍 Top países', 'country') +
    block('🏙 Top ciudades', 'city') +
    block('🎂 Edad', 'age') +
    block('⚧ Género', 'gender', (k) => ({ M: '♂ Hombres', F: '♀ Mujeres', U: 'Sin especificar' }[k] || k));
}

function setMediaTab(name) {
  state.currentTab = name;
  $('tab-reels').classList.toggle('on', name === 'reels');
  $('tab-posts').classList.toggle('on', name === 'posts');
  renderMediaGrid(name);
  if (state.dashboard) renderIgRanking(state.dashboard);
}

function renderMediaGrid(tab) {
  const d = state.dashboard; if (!d) return;
  const itemsBase = tab === 'reels' ? (d.reels || []) : (d.posts || []);
  // Aplicar sort según state.igSort
  const sortKey = state.igSort || 'reach';
  const items = [...itemsBase].sort((a, b) => {
    if (sortKey === 'timestamp') return new Date(b.timestamp || 0) - new Date(a.timestamp || 0);
    if (sortKey === 'interactions') return (b.interactions_weighted || 0) - (a.interactions_weighted || 0);
    return (b[sortKey] || 0) - (a[sortKey] || 0);
  });
  const g = $('media-grid');
  if (!items.length) { g.innerHTML = `<p style="grid-column:1/-1;text-align:center;color:var(--text-2);padding:2rem">Sin ${tab}.</p>`; return; }
  g.innerHTML = items.map((m) => {
    const caption = (m.caption || '').slice(0, 90).replace(/[<>&"]/g, '');
    const thumb = m.thumbnail_url || m.media_url || '';
    const proxied = thumbProxy(thumb);
    return `<div class="media-card">
      ${thumb ? `<a href="${m.permalink}" target="_blank" rel="noopener"><img class="media-thumb" src="${proxied}" loading="lazy" alt="" onerror="this.style.display='none'"></a>` : `<div class="media-thumb"></div>`}
      <div class="media-body">
        <p style="font-size:10px;color:var(--text-2);margin-bottom:3px">${fmtDate(m.timestamp)}${m.score ? ` · score ${m.score.toFixed(2)}` : ''}</p>
        <p style="font-size:11px;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${caption}">${caption || '(sin caption)'}</p>
        <div class="media-metrics">
          ${m.reach != null ? `<span title="Alcance">📊 ${eur0(m.reach)}</span>` : ''}
          ${m.views != null ? `<span title="Visualizaciones">👁 ${eur0(m.views)}</span>` : ''}
          ${m.like_count != null ? `<span title="Likes">♥ ${eur0(m.like_count)}</span>` : ''}
          ${m.comments_count != null ? `<span title="Comentarios">💬 ${eur0(m.comments_count)}</span>` : ''}
          ${m.saved != null ? `<span title="Guardados (señal MUY fuerte de interés)">★ ${eur0(m.saved)}</span>` : ''}
          ${m.shares != null ? `<span title="Compartidos">↗ ${eur0(m.shares)}</span>` : ''}
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
  $('ads-kpis-container').innerHTML = `
    <div class="kpi-mini"><p class="lbl">${labelWithInfo('ads','spend','Gasto')} (30d)</p><p class="val">${eurFmt(t.spend)}</p></div>
    <div class="kpi-mini"><p class="lbl">${labelWithInfo('ads','reach','Alcance')}</p><p class="val">${eur0(t.reach)}</p></div>
    <div class="kpi-mini"><p class="lbl">${labelWithInfo('ads','impressions','Impresiones')}</p><p class="val">${eur0(t.impressions)}</p></div>
    <div class="kpi-mini"><p class="lbl">${labelWithInfo('ads','clicks','Clics')}</p><p class="val">${eur0(t.clicks)}</p></div>
    <div class="kpi-mini"><p class="lbl">${labelWithInfo('ads','ctr','CTR')}</p><p class="val">${t.ctr != null ? (t.ctr*100).toFixed(2)+'%' : '—'}</p></div>
    <div class="kpi-mini"><p class="lbl">${labelWithInfo('ads','cpc','CPC')}</p><p class="val">${t.cpc != null ? '€'+t.cpc.toFixed(2) : '—'}</p></div>
    <div class="kpi-mini"><p class="lbl">${labelWithInfo('ads','cpm','CPM')}</p><p class="val">${t.cpm != null ? '€'+t.cpm.toFixed(2) : '—'}</p></div>
  `;

  // Contadores por estado.
  $('ads-st-active-n').textContent = `(${d.groups?.active?.count || 0})`;
  $('ads-st-paused-n').textContent = `(${d.groups?.paused?.count || 0})`;
  $('ads-st-otros-n').textContent  = `(${d.groups?.otros?.count || 0})`;

  // Recomendaciones (top mejores y peores entre activas).
  renderAdsRecommendations(d);
  // Lista de la pestaña actual.
  if (!state.adsStatusTab) state.adsStatusTab = 'active';
  renderAdsList(d, state.adsStatusTab);
  // Antigüedad del dato.
  const ci = $('ads-cache-info');
  if (ci) ci.textContent = d.cached
    ? `Actualizado ${ago(d.cache_age_sec)} (cache ${d.cache_source || 'mem'}) · token: ${d.token_source}`
    : `Recién actualizado · token: ${d.token_source}`;
}

// Comparativo color contra promedio cuenta. low_is_good=true para CPC, CPA, frecuencia.
function _colorVsAvg(val, avg, lowIsGood = false) {
  if (val == null || !avg) return 'var(--text-2)';
  const ratio = val / avg;
  if (lowIsGood) {
    if (ratio < 0.8) return '#16a34a';
    if (ratio > 1.3) return '#dc2626';
    return 'var(--text-2)';
  }
  if (ratio > 1.3) return '#16a34a';
  if (ratio < 0.5) return '#dc2626';
  return 'var(--text-2)';
}

function renderAdsRecommendations(d) {
  const top = d.recommendations?.top || [];
  const bot = d.recommendations?.bottom || [];
  // Cada recomendación: miniatura + displayName (no truncar) + presupuesto
  // + gastado + motivo. Click → scroll a la campaña + abre el details.
  const renderRow = (c) => {
    const i = c.insights || {};
    const v = c.verdict || {};
    const eb = c.effective_budget;
    const fb = formatBudget(eb);
    const t = campThumb(c);
    const thumbHtml = t
      ? `<img src="${t}" alt="" loading="lazy" style="width:48px;height:48px;border-radius:4px;object-fit:cover;background:var(--bg);flex-shrink:0" onerror="this.style.display='none'">`
      : (c.primary_permalink
          ? `<a href="${c.primary_permalink}" target="_blank" rel="noopener" style="width:48px;height:48px;border-radius:4px;background:var(--bg);flex-shrink:0;display:flex;align-items:center;justify-content:center;color:#185FA5;font-size:9px;text-decoration:none" title="Ver en Instagram" onclick="event.stopPropagation()">↗ IG</a>`
          : `<div style="width:48px;height:48px;border-radius:4px;background:var(--bg);flex-shrink:0;display:flex;align-items:center;justify-content:center;color:var(--text-2);font-size:9px">sin img</div>`);
    const displayName = (c.display_name || c.name || '').replace(/[<>]/g, '');
    // Indicador delivery real (entregando vs solo "marcada activa").
    const deliveryBadge = c.is_delivering
      ? `<span title="Gasto últimos 3d: €${(c.recent_spend_3d||0).toFixed(2)}" style="padding:1px 6px;border-radius:6px;font-size:9px;background:rgba(99,153,34,.15);color:#16a34a;font-weight:500">entregando</span>`
      : `<span title="${(c.not_delivering_reason||'No entrega').replace(/"/g,'&quot;')}" style="padding:1px 6px;border-radius:6px;font-size:9px;background:rgba(217,119,6,.15);color:#d97706;font-weight:500">no entrega</span>`;
    const shortId = String(c.id).slice(-6);
    return `<div onclick="scrollToCampaign('${c.id}')" style="display:flex;gap:8px;padding:8px 0;border-bottom:.5px dashed var(--border-3);cursor:pointer;align-items:flex-start" title="Click para abrir esta campaña en la lista">
      ${thumbHtml}
      <div style="flex:1;min-width:0">
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          ${deliveryBadge}
          <span style="font-family:monospace;font-size:10px;color:var(--text-2)" title="ID completo: ${c.id}">#${shortId}</span>
        </div>
        <p style="font-size:12px;font-weight:500;line-height:1.3;word-break:break-word;margin-top:2px">${displayName}</p>
        <p style="font-size:10px;color:var(--text-2);margin:2px 0">${fb ? 'Presup. <strong style="color:var(--text)">'+fb.text+'</strong> · ' : ''}${eurFmt(i.spend)} gastados · CTR ${i.ctr != null ? (i.ctr*100).toFixed(2)+'%' : '—'}${i.cpc != null ? ' · CPC €'+i.cpc.toFixed(2) : ''}</p>
        <p style="font-size:11px;color:${v.color || 'var(--text-2)'};font-style:italic;line-height:1.3">${v.reason || ''}</p>
        ${c.ads_manager_url ? `<a href="${c.ads_manager_url}" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="font-size:10px;color:#185FA5;text-decoration:none;display:inline-block;margin-top:3px">↗ Abrir esta campaña en Ads Manager</a>` : ''}
      </div>
    </div>`;
  };
  $('ads-top-list').innerHTML = top.length ? top.map(renderRow).join('') : `<p style="font-size:11px;color:var(--text-2);padding:1rem">Sin campañas para escalar todavía. ${d.groups?.active?.count ? 'Las activas están cerca del promedio.' : 'Activá alguna primero.'}</p>`;
  $('ads-bottom-list').innerHTML = bot.length ? bot.map(renderRow).join('') : `<p style="font-size:11px;color:var(--text-2);padding:1rem">Sin campañas para pausar/optimizar entre las activas. 👍</p>`;
}

// ─── Parte 1: gasto por día (mini chart) ─────────────────────────────
// Loadea al expandirse el <details>; el listener está en initSpendChartsObserver().
async function loadDailySpend(campaignId, days, force) {
  const wrap = document.getElementById('spend-chart-' + campaignId);
  if (!wrap) return;
  if (!force && wrap.dataset.loadedDays === String(days)) return;
  wrap.innerHTML = '<p style="color:var(--text-2);font-size:10px;font-style:italic">Cargando…</p>';
  try {
    const r = await api(`/api/v1/meta/campaign/${campaignId}/daily-spend?days=${days || 30}`);
    if (!r.ok) {
      wrap.innerHTML = `<p style="color:var(--text-2);font-size:10px">No se pudo: ${r.error || r.status || 'sin datos'}</p>`;
      return;
    }
    wrap.dataset.loadedDays = String(days || 30);
    renderSpendChart(wrap, r);
  } catch (e) {
    wrap.innerHTML = `<p style="color:#dc2626;font-size:10px">Error: ${e.message}</p>`;
  }
}

function renderSpendChart(wrap, data) {
  const rows = data.rows || [];
  if (!rows.length) {
    wrap.innerHTML = `<p style="color:var(--text-2);font-size:10px;font-style:italic">Sin gasto en los últimos ${data.days}d.</p>`;
    return;
  }
  const max = Math.max(...rows.map((r) => r.spend), 0.01);
  const W = 360, H = 50, barW = Math.max(2, (W - 4) / rows.length - 1);
  // Bars: verde si spend>0, gris si día sin entrega.
  const bars = rows.map((r, i) => {
    const x = 2 + i * (barW + 1);
    const h = r.spend > 0 ? Math.max(1.5, (r.spend / max) * (H - 12)) : 1.5;
    const y = H - h - 2;
    const fill = r.spend > 0 ? '#16a34a' : '#d4d4d4';
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${fill}"><title>${r.date}: €${r.spend.toFixed(2)} · ${r.impressions} imp · ${r.clicks} clics</title></rect>`;
  }).join('');
  const firstDate = rows[0].date;
  const lastDate = rows[rows.length - 1].date;
  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:50px;display:block">${bars}</svg>
    <p style="color:var(--text-2);font-size:9px;display:flex;justify-content:space-between;margin-top:2px">
      <span>${firstDate}</span>
      <span>Total ${data.days}d: <strong style="color:var(--text)">€${data.total_spend.toFixed(2)}</strong> · ${data.days_with_spend}/${rows.length} días con entrega${data.days_zero > 0 ? ' · '+data.days_zero+' sin gasto' : ''}</span>
      <span>${lastDate}</span>
    </p>`;
}

// Observer: cuando el user expande <details> de campaña, carga el chart.
function initSpendChartsObserver() {
  document.addEventListener('toggle', (ev) => {
    const det = ev.target;
    if (!det || det.tagName !== 'DETAILS') return;
    if (!det.open) return;
    const id = det.id && det.id.startsWith('camp-') ? det.id.slice(5) : null;
    if (!id) return;
    loadDailySpend(id, 30);
  }, true);
}

// Click en una recomendación → scrollea + abre el <details> de la campaña.
function scrollToCampaign(id) {
  // Asegurar que estamos en la sub-pestaña que contiene la campaña.
  // Si no la encontramos en la pestaña actual, cambiar a 'active' que es
  // donde están las recomendaciones (todas activas).
  let el = document.getElementById('camp-' + id);
  if (!el && state.adsStatusTab !== 'active') {
    setAdsStatusTab('active');
    setTimeout(() => scrollToCampaign(id), 50);
    return;
  }
  if (!el) return;
  el.open = true;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  // Flash para guiar la atención.
  el.style.transition = 'background-color .25s';
  const orig = el.style.background;
  el.style.background = 'rgba(24,95,165,.18)';
  setTimeout(() => { el.style.background = orig || 'var(--bg-secondary)'; }, 1000);
}

function setAdsStatusTab(name) {
  state.adsStatusTab = name;
  ['active', 'paused', 'otros'].forEach((k) => {
    const el = $('ads-st-' + k); if (!el) return;
    el.classList.toggle('on', k === name);
  });
  if (state.ads) renderAdsList(state.ads, name);
}

function renderAdsList(d, group) {
  const camps = d.groups?.[group]?.campaigns || [];
  $('ads-camp-counter').textContent = `${camps.length} campañas — ordenadas por gasto desc`;
  const list = $('ads-camp-list');
  if (!camps.length) { list.innerHTML = '<p style="color:var(--text-2);padding:1rem">Sin campañas en este grupo.</p>'; return; }
  const avg = d.averages || {};
  list.innerHTML = camps.map((c) => renderCampaignCard(c, avg)).join('');
}

function renderCampaignCard(c, avg) {
  const statusBg = c.effective_status === 'ACTIVE' ? 'rgba(99,153,34,.18)'
                 : c.effective_status === 'PAUSED' ? 'rgba(217,119,6,.18)' : 'rgba(150,150,150,.18)';
  const statusColor = c.effective_status === 'ACTIVE' ? '#16a34a' : c.effective_status === 'PAUSED' ? '#d97706' : '#888';
  const i = c.insights || {};
  const v = c.verdict || {};
  const obj = objectiveLabel(c.objective);
  const eb = c.effective_budget;
  const fb = formatBudget(eb);
  const ctrColor = _colorVsAvg(i.ctr, avg.ctr);
  const cpcColor = _colorVsAvg(i.cpc, avg.cpc, true);
  const cpaColor = _colorVsAvg(i.cost_per_result, avg.cpa, true);

  // Barra de progreso para lifetime: gastado / presupuesto.
  let progressHtml = '';
  if (eb?.kind === 'lifetime' && eb.monto > 0 && i.spend > 0) {
    const pct = Math.min(100, (i.spend / eb.monto) * 100);
    progressHtml = `<div class="bar" style="width:120px;display:inline-block;vertical-align:middle;margin-left:6px" title="${i.spend.toFixed(2)} de €${eb.monto.toFixed(2)} (${pct.toFixed(0)}%)"><div style="width:${pct}%"></div></div>`;
  }

  // Identidad robusta de la campaña (computada por backend):
  //   display_name = "Publicación de Instagram: X" → "X", o primera línea
  //                  del caption del IG asociado, o body del creative.
  //   primary_thumbnail = thumb fbcdn → ig_thumbnail (escalera backend).
  //   primary_permalink = link al post real de IG.
  //   ads_manager_url   = escape-hatch al panel de Meta.
  const primaryThumb = campThumb(c);
  const displayName = c.display_name || c.name || '(sin nombre)';
  const firstAdCreative = (() => {
    for (const a of c.ads || []) {
      if (a.creative?.body || a.creative?.ig_caption) return a.creative;
    }
    return null;
  })();
  const previewCopy = firstAdCreative?.body || firstAdCreative?.ig_caption || '';

  // Tooltip presupuesto.
  const budgetTip = 'Presupuesto diario = lo máximo que Meta puede gastar por día. Presupuesto total (lifetime) = lo máximo total para toda la campaña.';

  // Placeholder con link directo a IG si la miniatura no resolvió por
  // ninguna vía — el dueño nunca queda sin identificar la campaña.
  const thumbHtml = primaryThumb
    ? `<img src="${primaryThumb}" class="creative-thumb" alt="" loading="lazy" onerror="this.style.display='none'">`
    : (c.primary_permalink
        ? `<a href="${c.primary_permalink}" target="_blank" rel="noopener" class="creative-thumb" style="display:flex;align-items:center;justify-content:center;color:#185FA5;font-size:9px;text-decoration:none;text-align:center" title="Ver post en Instagram">↗ IG</a>`
        : `<div class="creative-thumb" style="display:flex;align-items:center;justify-content:center;color:var(--text-2);font-size:9px">sin img</div>`);

  // Identidad anchor ID para click-to-scroll desde recomendaciones.
  const anchorId = 'camp-' + c.id;

  return `<details id="${anchorId}" style="border:.5px solid var(--border-3);border-radius:var(--r-md);padding:.5rem .75rem;margin-bottom:6px;background:var(--bg-secondary)">
    <summary style="cursor:pointer;display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap">
      ${thumbHtml}
      <div style="flex:1;min-width:200px">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:3px">
          ${c.is_delivering
            ? `<span title="Gasto últimos 3d: €${(c.recent_spend_3d||0).toFixed(2)}" style="padding:2px 8px;border-radius:10px;font-size:10px;background:rgba(99,153,34,.18);color:#16a34a;font-weight:600">▶ ENTREGANDO</span>`
            : `<span title="${(c.not_delivering_reason||'No entrega').replace(/"/g,'&quot;')}" style="padding:2px 8px;border-radius:10px;font-size:10px;background:rgba(217,119,6,.18);color:#d97706;font-weight:500">○ NO ENTREGA</span>`}
          <span style="padding:2px 8px;border-radius:10px;font-size:10px;background:${v.color || '#9ca3af'}33;color:${v.color || '#9ca3af'};font-weight:600">${v.label || '—'}</span>
          <span title="${obj.hint.replace(/"/g,'&quot;')}" style="padding:2px 8px;border-radius:10px;font-size:10px;background:rgba(24,95,165,.12);color:#185FA5;font-weight:500;cursor:help">${obj.label}</span>
          <span style="font-size:10px;color:var(--text-2)">${c.n_ads || 0} ${(c.n_ads === 1) ? 'anuncio' : 'anuncios'}</span>
        </div>
        <!-- displayName SIN truncar (wrap libre) — el dueño necesita identificar la campaña. -->
        <strong style="font-size:13px;display:block;line-height:1.3;word-break:break-word">${(displayName||'').replace(/[<>]/g,'')}</strong>
        ${!c.is_delivering && c.not_delivering_reason ? `<p style="font-size:10px;color:#d97706;font-style:italic;margin-top:2px">${c.not_delivering_reason.replace(/[<>]/g,'')}</p>` : ''}
        ${previewCopy ? `<p style="font-size:11px;color:var(--text-2);margin-top:2px;line-height:1.3" title="${(previewCopy||'').replace(/"/g,'&quot;')}">${(previewCopy||'').replace(/[<>]/g,'').slice(0,140)}${previewCopy.length>140?'…':''}</p>` : ''}
        <!-- Escape-hatch SIEMPRE visibles: el dueño nunca queda atrapado. -->
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px;font-size:10px">
          ${c.primary_permalink ? `<a href="${c.primary_permalink}" target="_blank" rel="noopener" style="color:#185FA5;text-decoration:none" title="Ver el post en Instagram">↗ Ver en Instagram</a>` : ''}
          ${c.ads_manager_url ? `<a href="${c.ads_manager_url}" target="_blank" rel="noopener" style="color:#185FA5;text-decoration:none" title="Abrir esta campaña en Meta Ads Manager">↗ Meta Ads Manager</a>` : ''}
        </div>
      </div>
      <div style="text-align:right;min-width:170px">
        <p style="font-size:11px;color:var(--text-2)" title="${budgetTip}">Presupuesto: ${fb ? `<strong style="color:var(--text)">${fb.text}</strong>` : '—'}${eb?.source === 'ABO' ? ' <span style="font-size:9px;color:var(--text-2)">(ABO)</span>' : ''}</p>
        <p style="font-size:12px;color:#dc2626">Gastado: ${eurFmt(i.spend)}${progressHtml}</p>
      </div>
    </summary>
    <div style="margin-top:8px;padding-top:8px;border-top:.5px dashed var(--border-3)">
      <p style="font-size:11px;color:${v.color || 'var(--text-2)'};font-style:italic;margin-bottom:8px">${v.reason || ''}</p>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:6px;margin-bottom:8px;font-size:11px">
        <div><span style="color:var(--text-2)">Alcance:</span> ${eur0(i.reach)}</div>
        <div><span style="color:var(--text-2)">Imp:</span> ${eur0(i.impressions)}</div>
        <div><span style="color:var(--text-2)">Frec:</span> ${i.frequency != null ? i.frequency.toFixed(2) : '—'}</div>
        <div><span style="color:var(--text-2)">Clics:</span> ${eur0(i.clicks)}</div>
        <div style="color:${ctrColor}"><span style="color:var(--text-2)">CTR:</span> ${i.ctr != null ? (i.ctr*100).toFixed(2)+'%' : '—'}</div>
        <div style="color:${cpcColor}"><span style="color:var(--text-2)">CPC:</span> ${i.cpc != null ? '€'+i.cpc.toFixed(2) : '—'}</div>
        <div><span style="color:var(--text-2)">CPM:</span> ${i.cpm != null ? '€'+i.cpm.toFixed(2) : '—'}</div>
        <div><span style="color:var(--text-2)">Resultados:</span> ${i.results || 0}</div>
        <div style="color:${cpaColor}"><span style="color:var(--text-2)">CPA:</span> ${i.cost_per_result != null ? '€'+i.cost_per_result.toFixed(2) : '—'}</div>
        ${i.roas != null ? `<div><span style="color:var(--text-2)">ROAS:</span> ${i.roas.toFixed(2)}×</div>` : ''}
      </div>
      <!-- Agenda + mini gráfico de gasto por día (Parte 1) -->
      <div style="display:grid;grid-template-columns:auto 1fr;gap:12px;align-items:start;padding:8px 10px;background:rgba(0,0,0,.02);border-radius:var(--r-md);margin-bottom:10px;font-size:11px">
        <div style="min-width:130px">
          <p style="color:var(--text-2);margin-bottom:2px">📅 Agenda</p>
          <p><span style="color:var(--text-2)">Inicio:</span> ${c.start_time ? fmtDate(c.start_time) : '—'}</p>
          <p><span style="color:var(--text-2)">Fin:</span> ${c.stop_time ? fmtDate(c.stop_time) : '<em style="color:var(--text-2)">en curso</em>'}</p>
          <p><span style="color:var(--text-2)">Tipo:</span> ${eb?.kind === 'daily' ? 'Diario' : eb?.kind === 'lifetime' ? 'Total (lifetime)' : (eb?.kind === 'mixed' ? 'Mixto' : '—')}</p>
        </div>
        <div data-spend-chart="${c.id}">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
            <p style="color:var(--text-2)">📈 Gasto por día</p>
            <select onchange="loadDailySpend('${c.id}', this.value)" style="font-size:10px;padding:1px 4px;background:transparent;color:var(--text);border:.5px solid var(--border-3);border-radius:3px">
              <option value="14">Últimos 14d</option>
              <option value="30" selected>Últimos 30d</option>
              <option value="60">Últimos 60d</option>
              <option value="90">Últimos 90d</option>
            </select>
          </div>
          <div id="spend-chart-${c.id}" style="min-height:50px"><p style="color:var(--text-2);font-size:10px;font-style:italic">Cargando…</p></div>
        </div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">
        <button data-act="toggle-camp" data-id="${c.id}" data-newstatus="${c.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE'}" onclick="onActionClick(event)" style="padding:4px 12px;font-size:11px;border-radius:4px;cursor:pointer;border:.5px solid var(--border-2);background:transparent;color:var(--text)">${c.status === 'ACTIVE' ? '⏸ Pausar' : '▶ Activar'} campaña</button>
        ${eb?.level === 'campaign' ? `<button onclick="openBudgetModal('campaign','${c.id}','${eb.kind}',${eb.monto},${i.spend||0},'${(c.name||'').replace(/'/g,'')}')" style="padding:4px 12px;font-size:11px;border-radius:4px;cursor:pointer;border:.5px solid #185FA5;background:rgba(24,95,165,.10);color:#185FA5;font-weight:500">💰 ${v.kind === 'escalar' ? 'Subir presupuesto' : 'Cambiar presupuesto'}</button>`
          : eb?.level === 'adset' ? `<span style="padding:4px 12px;font-size:11px;color:var(--text-2)">Presupuesto se gestiona por adset ↓</span>`
          : '' }
      </div>
      ${c.adsets.map((s) => renderAdsetBlock(s)).join('')}
      ${(() => {
        // Si el árbol de adsets no expone ningún ad pero la campaña SÍ tiene
        // ads (los ghost adsets fallan, o todos los adsets fueron archivados),
        // renderizamos los ads del flat directamente para que NUNCA queden
        // invisibles.
        const adsInTree = (c.adsets || []).reduce((n, s) => n + (s.ads?.length || 0), 0);
        const flat = c.ads || [];
        if (adsInTree === 0 && flat.length > 0) {
          return `<div style="margin-top:8px;padding:8px;border:.5px dashed var(--border-3);border-radius:var(--r-md);background:rgba(0,0,0,.02)">
            <p style="font-size:11px;color:var(--text-2);margin-bottom:6px">Anuncios de esta campaña (agrupados en flat — los adsets pueden estar archivados):</p>
            ${flat.map(renderAdRow).join('')}
          </div>`;
        }
        return '';
      })()}
    </div>
  </details>`;
}

// ─── Parte 2: targeting read-only ───────────────────────────────────
function _renderTargetingSummary(t) {
  if (!t) return '<p style="color:var(--text-2);font-size:11px">Sin datos.</p>';
  const loc = t.location || {};
  const cities = (loc.cities || []).map((c) => c.name + (c.region ? ' (' + c.region + ')' : '') + (c.radius ? ' · ' + c.radius + ' ' + (c.distance_unit === 'mile' ? 'mi' : 'km') : ''));
  const customs = (loc.custom_locations || []).map((c) => `Radio de ${c.radius} ${c.unit === 'mile' ? 'mi' : 'km'} alrededor de ${c.name}`);
  const interests = (t.interests_specs || []).flatMap((b) => Object.entries(b).flatMap(([k, vals]) => vals.map((v) => v + (k !== 'interests' ? ' (' + k + ')' : ''))));
  const placements = t.placements?.all ? 'Automático' : (t.placements?.list || []).map((p) => p.label + (p.positions ? ': ' + p.positions.join(', ') : '')).join(' · ');
  return `
    <div style="font-size:11px;line-height:1.5">
      <p><strong style="color:var(--text)">📍 Ubicación</strong></p>
      ${loc.countries?.length ? `<p>Países: ${loc.countries.join(', ')}</p>` : ''}
      ${loc.regions?.length ? `<p>Regiones/provincias: ${loc.regions.join(', ')}</p>` : ''}
      ${cities.length ? `<p>Ciudades: ${cities.join(' · ')}</p>` : ''}
      ${customs.length ? `<p>${customs.join(' · ')}</p>` : ''}
      ${loc.zips?.length ? `<p>ZIPs: ${loc.zips.join(', ')}</p>` : ''}
      ${(!loc.countries?.length && !loc.regions?.length && !cities.length && !customs.length) ? '<p style="color:var(--text-2)">Sin restricción geográfica explícita.</p>' : ''}

      <p style="margin-top:8px"><strong style="color:var(--text)">👥 Demografía</strong></p>
      <p>Edad: ${t.age_min || '—'}${t.age_max ? '–' + t.age_max : (t.age_min ? '+' : '')} · Género: ${t.gender_label}</p>

      ${interests.length ? `<p style="margin-top:8px"><strong style="color:var(--text)">🎯 Intereses</strong></p><p>${interests.slice(0, 12).join(', ')}${interests.length > 12 ? '…' : ''}</p>` : ''}

      <p style="margin-top:8px"><strong style="color:var(--text)">📱 Dónde se muestra</strong></p>
      <p>${placements || 'Automático'}</p>

      <p style="margin-top:8px;color:var(--text-2);font-size:10px">
        Optimización: ${t.optimization_goal || '—'}${t.billing_event ? ' · Cobro: ' + t.billing_event : ''}
      </p>
    </div>`;
}

async function loadAdsetTargeting(adsetId) {
  const wrap = document.getElementById('targ-' + adsetId);
  if (!wrap || wrap.dataset.loaded === '1') return;
  wrap.innerHTML = '<p style="color:var(--text-2);font-size:11px;font-style:italic">Cargando segmentación…</p>';
  try {
    const r = await api(`/api/v1/meta/adset/${adsetId}/targeting`);
    if (!r.ok) {
      wrap.innerHTML = `<p style="color:var(--text-2);font-size:11px">No se pudo: ${r.error || r.status || 'sin datos'}</p>`;
      return;
    }
    wrap.dataset.loaded = '1';
    const aiEnabled = state.config?.ai_enabled;
    const adminLike = !!state.config?.env_set?.META_USER_TOKEN || !!state.config?.tokens?.meta_user_token?.present;
    const editBtn = adminLike
      ? `<button onclick="openTargetingEditor('${adsetId}')" style="padding:3px 10px;font-size:10px;border-radius:4px;cursor:pointer;border:.5px solid #185FA5;background:rgba(24,95,165,.08);color:#185FA5;margin-left:auto">✏ Editar segmentación</button>`
      : '';
    wrap.innerHTML = `<div style="display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:6px">
        <span style="font-size:11px;color:var(--text-2)">Adset: ${(r.name || adsetId).replace(/[<>]/g,'')}</span>
        ${editBtn}
      </div>` + _renderTargetingSummary(r.summary) +
      `<div style="margin-top:10px;padding-top:8px;border-top:.5px dashed var(--border-3)">
        <details onclick="if(this.open) loadRegionPerf('${adsetId}')">
          <summary style="cursor:pointer;font-size:11px;font-weight:500;color:#185FA5;list-style:none">📊 Rendimiento por región/provincia</summary>
          <div id="rgn-${adsetId}" style="margin-top:6px"><p style="font-size:11px;color:var(--text-2)">Click para cargar</p></div>
        </details>
      </div>
      <div style="margin-top:10px;padding-top:8px;border-top:.5px dashed var(--border-3)">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
          <p style="font-size:11px;font-weight:500">🤖 Análisis IA de segmentación</p>
          <button onclick="loadSegAi('${adsetId}', this)" ${!aiEnabled ? 'disabled title="Falta ANTHROPIC_API_KEY"' : ''} style="padding:3px 10px;font-size:10px;border-radius:4px;cursor:${aiEnabled ? 'pointer' : 'not-allowed'};border:.5px solid ${aiEnabled ? '#185FA5' : 'var(--border-3)'};background:${aiEnabled ? 'rgba(24,95,165,.08)' : 'transparent'};color:${aiEnabled ? '#185FA5' : 'var(--text-2)'}">${aiEnabled ? 'Generar análisis' : 'Sin ANTHROPIC_API_KEY'}</button>
        </div>
        <div id="segai-${adsetId}" style="margin-top:6px"></div>
      </div>`;
  } catch (e) {
    wrap.innerHTML = `<p style="color:#dc2626;font-size:11px">Error: ${e.message}</p>`;
  }
}

// ─── Parte 5: editor acotado de targeting ───────────────────────────
async function openTargetingEditor(adsetId) {
  // Refetch targeting fresco para el preview "antes".
  let t;
  try {
    t = await api(`/api/v1/meta/adset/${adsetId}/targeting`);
  } catch (e) { toast('Error: ' + e.message, 'err'); return; }
  if (!t.ok) { toast('No se pudo cargar el targeting actual: ' + (t.error || t.status), 'err'); return; }
  const s = t.summary || {};
  const customs = s.location?.custom_locations || [];
  const cities = s.location?.cities || [];
  const regions = s.location?.regions || [];
  const wrap = document.createElement('div');
  wrap.className = 'modal-bg';
  wrap.id = '_targ-modal';
  wrap.onclick = () => closeTargModal();
  wrap.innerHTML = `
    <div class="modal" onclick="event.stopPropagation()" style="max-width:560px">
      <h3>✏ Editar segmentación del adset</h3>
      <p style="font-size:11px;color:var(--text-2);margin-bottom:8px">${(t.name || adsetId).replace(/[<>]/g,'')}</p>
      <div class="learning-warn">
        ⚠️ <strong>Cambiar la segmentación reinicia la fase de aprendizaje</strong> del adset. Hacé cambios significativos de a uno y dale unos días para juntar datos. Para cambios grandes (varias ciudades, intereses), preferí editar directo en Meta Ads Manager.
      </div>
      <div style="display:flex;gap:4px;flex-wrap:wrap;margin:8px 0;border-bottom:.5px solid var(--border-3);padding-bottom:4px">
        <button class="targ-tab on" data-tab="radius" onclick="_setTargTab('radius')">Radio</button>
        <button class="targ-tab" data-tab="age" onclick="_setTargTab('age')">Edad</button>
        <button class="targ-tab" data-tab="gender" onclick="_setTargTab('gender')">Género</button>
        <button class="targ-tab" data-tab="cities" onclick="_setTargTab('cities')">Ciudades</button>
        <button class="targ-tab" data-tab="regions" onclick="_setTargTab('regions')">Regiones</button>
      </div>
      <div id="_targ-panel">${_targEditorPanels(adsetId, s, customs, cities, regions, 'radius')}</div>
      <p id="_targ-result" style="font-size:11px;min-height:14px;margin-top:8px;color:var(--text-2)"></p>
      <div style="display:flex;justify-content:flex-end;margin-top:.5rem">
        <button class="btn-secondary" onclick="closeTargModal()" style="padding:6px 14px;font-size:12px;border-radius:var(--r-md);cursor:pointer">Cerrar</button>
        <a href="https://adsmanager.facebook.com/adsmanager/manage/adsets/edit?adset_ids=${adsetId}" target="_blank" rel="noopener" style="margin-left:8px;padding:6px 14px;font-size:12px;border-radius:var(--r-md);background:transparent;color:#185FA5;text-decoration:none;border:.5px solid #185FA5">↗ Abrir en Ads Manager</a>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  // Estilo de tabs
  document.querySelectorAll('.targ-tab').forEach((b) => {
    b.style.cssText = 'padding:4px 10px;font-size:11px;border:.5px solid var(--border-2);border-radius:4px;background:transparent;color:var(--text);cursor:pointer';
    if (b.classList.contains('on')) { b.style.background = '#185FA5'; b.style.color = '#fff'; }
  });
  state._targEditor = { adsetId, summary: s };
}
function closeTargModal() {
  const el = document.getElementById('_targ-modal');
  if (el) el.remove();
  state._targEditor = null;
}
function _setTargTab(tab) {
  document.querySelectorAll('.targ-tab').forEach((b) => {
    const on = b.dataset.tab === tab;
    b.style.background = on ? '#185FA5' : 'transparent';
    b.style.color = on ? '#fff' : 'var(--text)';
  });
  const m = state._targEditor;
  if (!m) return;
  const s = m.summary;
  document.getElementById('_targ-panel').innerHTML = _targEditorPanels(m.adsetId, s, s.location?.custom_locations || [], s.location?.cities || [], s.location?.regions || [], tab);
}
function _targEditorPanels(adsetId, s, customs, cities, regions, active) {
  const fmtNum = (v) => v == null ? '' : String(v);
  if (active === 'radius') {
    if (!customs.length) return '<p style="font-size:11px;color:var(--text-2);padding:1rem 0">El adset no tiene radios custom (no apunta a un punto + km). Las ciudades pueden tener su propio radio — editalas en la tab Ciudades.</p>';
    return customs.map((c, i) => `
      <div style="margin-bottom:10px;padding:8px;background:var(--bg-secondary);border-radius:6px">
        <p style="font-size:11px;color:var(--text-2)">Punto: ${(c.name||'').replace(/[<>]/g,'')}</p>
        <p style="font-size:11px;margin:4px 0">Radio actual: <strong>${c.radius} ${c.unit === 'mile' ? 'mi' : 'km'}</strong></p>
        <div style="display:flex;gap:4px;align-items:center">
          <label style="font-size:10px">Nuevo radio (km, 1-80):</label>
          <input type="number" id="_targ-radius-${i}" value="${c.radius}" min="1" max="80" step="1" style="width:60px;padding:3px 5px;border:.5px solid var(--border-2);border-radius:3px;background:var(--bg);color:var(--text);font-size:11px">
          <button onclick="_applyTargetingOp('radius', ${i})" style="padding:3px 10px;font-size:10px;border-radius:4px;cursor:pointer;border:none;background:#185FA5;color:#fff">Aplicar</button>
        </div>
      </div>`).join('');
  }
  if (active === 'age') {
    return `<div style="padding:8px;background:var(--bg-secondary);border-radius:6px">
      <p style="font-size:11px;margin-bottom:6px">Actual: <strong>${fmtNum(s.age_min) || '—'}–${fmtNum(s.age_max) || '—'}</strong></p>
      <div style="display:flex;gap:6px;align-items:center">
        <label style="font-size:10px">Edad mín (13-65):</label>
        <input type="number" id="_targ-age-min" value="${fmtNum(s.age_min) || 18}" min="13" max="65" style="width:55px;padding:3px 5px;border:.5px solid var(--border-2);border-radius:3px;background:var(--bg);color:var(--text);font-size:11px">
        <label style="font-size:10px">máx:</label>
        <input type="number" id="_targ-age-max" value="${fmtNum(s.age_max) || 65}" min="13" max="65" style="width:55px;padding:3px 5px;border:.5px solid var(--border-2);border-radius:3px;background:var(--bg);color:var(--text);font-size:11px">
        <button onclick="_applyTargetingOp('age')" style="padding:3px 10px;font-size:10px;border-radius:4px;cursor:pointer;border:none;background:#185FA5;color:#fff;margin-left:auto">Aplicar</button>
      </div>
    </div>`;
  }
  if (active === 'gender') {
    return `<div style="padding:8px;background:var(--bg-secondary);border-radius:6px">
      <p style="font-size:11px;margin-bottom:6px">Actual: <strong>${s.gender_label}</strong></p>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button onclick="_applyTargetingOp('gender','all')" style="padding:3px 10px;font-size:10px;border-radius:4px;cursor:pointer;border:.5px solid var(--border-2);background:transparent;color:var(--text)">Todos</button>
        <button onclick="_applyTargetingOp('gender','male')" style="padding:3px 10px;font-size:10px;border-radius:4px;cursor:pointer;border:.5px solid var(--border-2);background:transparent;color:var(--text)">Hombres</button>
        <button onclick="_applyTargetingOp('gender','female')" style="padding:3px 10px;font-size:10px;border-radius:4px;cursor:pointer;border:.5px solid var(--border-2);background:transparent;color:var(--text)">Mujeres</button>
      </div>
    </div>`;
  }
  if (active === 'cities') {
    return `
      <p style="font-size:11px;color:var(--text-2);margin-bottom:6px">${cities.length} ciudad${cities.length === 1 ? '' : 'es'} actuales:</p>
      ${cities.map((c) => `<div style="display:flex;gap:6px;align-items:center;padding:4px 0;border-bottom:.5px dashed var(--border-3);font-size:11px">
        <span style="flex:1">${(c.name||'').replace(/[<>]/g,'')}${c.region ? ' <span style="color:var(--text-2)">('+c.region+')</span>' : ''}${c.radius ? ' · ' + c.radius + ' ' + (c.distance_unit === 'mile' ? 'mi' : 'km') : ''}</span>
        <button onclick="_applyTargetingOp('city-remove','${c.key}')" style="padding:2px 6px;font-size:10px;color:#dc2626;background:transparent;border:.5px solid #dc2626;border-radius:3px;cursor:pointer">Quitar</button>
      </div>`).join('') || '<p style="font-size:11px;color:var(--text-2)">No hay ciudades específicas en el targeting.</p>'}
      <div style="margin-top:10px;padding:8px;background:var(--bg-secondary);border-radius:6px">
        <p style="font-size:11px;font-weight:500;margin-bottom:4px">Agregar ciudad</p>
        <input type="text" id="_targ-city-search" placeholder="Empezá a escribir (ej. Madrid)…" oninput="_searchGeo(this.value, 'city', '_targ-city-results')" style="width:100%;padding:5px;border:.5px solid var(--border-2);border-radius:3px;background:var(--bg);color:var(--text);font-size:11px">
        <div id="_targ-city-results" style="max-height:140px;overflow:auto;margin-top:4px"></div>
      </div>`;
  }
  if (active === 'regions') {
    return `
      <p style="font-size:11px;color:var(--text-2);margin-bottom:6px">${regions.length} región/es actuales:</p>
      ${regions.map((r, i) => `<div style="display:flex;gap:6px;align-items:center;padding:4px 0;border-bottom:.5px dashed var(--border-3);font-size:11px">
        <span style="flex:1">${(r||'').replace(/[<>]/g,'')}</span>
        <button onclick="_applyTargetingOp('region-remove-by-name', ${i})" style="padding:2px 6px;font-size:10px;color:#dc2626;background:transparent;border:.5px solid #dc2626;border-radius:3px;cursor:pointer">Quitar</button>
      </div>`).join('') || '<p style="font-size:11px;color:var(--text-2)">No hay regiones específicas.</p>'}
      <div style="margin-top:10px;padding:8px;background:var(--bg-secondary);border-radius:6px">
        <p style="font-size:11px;font-weight:500;margin-bottom:4px">Agregar región</p>
        <input type="text" id="_targ-region-search" placeholder="Empezá a escribir (ej. Cataluña)…" oninput="_searchGeo(this.value, 'region', '_targ-region-results')" style="width:100%;padding:5px;border:.5px solid var(--border-2);border-radius:3px;background:var(--bg);color:var(--text);font-size:11px">
        <div id="_targ-region-results" style="max-height:140px;overflow:auto;margin-top:4px"></div>
      </div>`;
  }
  return '';
}

let _geoSearchTimer = null;
async function _searchGeo(q, type, containerId) {
  clearTimeout(_geoSearchTimer);
  if (!q || q.length < 2) { document.getElementById(containerId).innerHTML = ''; return; }
  _geoSearchTimer = setTimeout(async () => {
    try {
      const r = await api(`/api/v1/meta/geo-search?q=${encodeURIComponent(q)}&type=${type}`);
      if (!r.ok) { document.getElementById(containerId).innerHTML = `<p style="font-size:11px;color:#dc2626">${r.error || 'sin resultados'}</p>`; return; }
      const list = (r.results || []).slice(0, 8);
      document.getElementById(containerId).innerHTML = list.length ? list.map((x) => {
        const label = (x.name || '') + (x.region ? ' (' + x.region + ')' : '') + (x.country_code ? ' · ' + x.country_code : '');
        const op = type === 'city' ? 'city-add' : 'region-add';
        return `<button onclick="_applyTargetingOp('${op}', '${x.key}', '${(x.name||'').replace(/'/g,'')}', '${(x.region||'').replace(/'/g,'')}', '${x.country_code||'ES'}')" style="display:block;width:100%;text-align:left;padding:4px 8px;font-size:11px;border:.5px solid var(--border-3);background:transparent;color:var(--text);border-radius:3px;margin-bottom:2px;cursor:pointer">${label}</button>`;
      }).join('') : '<p style="font-size:11px;color:var(--text-2)">Sin resultados.</p>';
    } catch (e) { document.getElementById(containerId).innerHTML = `<p style="font-size:11px;color:#dc2626">Error: ${e.message}</p>`; }
  }, 280);
}

async function _applyTargetingOp(op, ...args) {
  const m = state._targEditor;
  if (!m) return;
  const adsetId = m.adsetId;
  const resEl = document.getElementById('_targ-result');
  let url, body, preview;
  if (op === 'radius') {
    const idx = args[0];
    const newKm = Number(document.getElementById('_targ-radius-' + idx).value);
    preview = `Cambiar radio del punto #${idx + 1} a ${newKm} km`;
    url = `/api/v1/meta/adset/${adsetId}/targeting/radius`;
    body = { index: idx, radius_km: newKm };
  } else if (op === 'age') {
    const ageMin = Number(document.getElementById('_targ-age-min').value);
    const ageMax = Number(document.getElementById('_targ-age-max').value);
    preview = `Cambiar edad a ${ageMin}–${ageMax}`;
    url = `/api/v1/meta/adset/${adsetId}/targeting/age`;
    body = { age_min: ageMin, age_max: ageMax };
  } else if (op === 'gender') {
    const kind = args[0];
    preview = `Cambiar género a ${{ all: 'Todos', male: 'Hombres', female: 'Mujeres' }[kind]}`;
    url = `/api/v1/meta/adset/${adsetId}/targeting/genders`;
    body = { kind };
  } else if (op === 'city-add') {
    const [key, name, region, country] = args;
    preview = `Agregar ciudad: ${name} (${region}, ${country})`;
    url = `/api/v1/meta/adset/${adsetId}/targeting/city/add`;
    body = { key, name, region, country };
  } else if (op === 'city-remove') {
    const key = args[0];
    const city = (m.summary.location?.cities || []).find((c) => String(c.key) === String(key));
    preview = `Quitar ciudad: ${city?.name || key}`;
    url = `/api/v1/meta/adset/${adsetId}/targeting/city/remove`;
    body = { key };
  } else if (op === 'region-add') {
    const [key, name, , country] = args;
    preview = `Agregar región: ${name} (${country})`;
    url = `/api/v1/meta/adset/${adsetId}/targeting/region/add`;
    body = { key, name, country };
  } else if (op === 'region-remove-by-name') {
    resEl.textContent = 'Para quitar una región por nombre necesitamos su `key`. Editá esta acción en Meta Ads Manager.';
    return;
  } else {
    return;
  }
  if (!confirm(`Confirmar: ${preview}.\n\n⚠ Esto reinicia la fase de aprendizaje del adset.`)) return;
  resEl.textContent = 'Aplicando…';
  try {
    const r = await api(url, { method: 'POST', body: JSON.stringify(body) });
    if (!r.ok) { resEl.textContent = '✗ ' + (r.error || r.message || 'Falló'); resEl.style.color = '#dc2626'; return; }
    resEl.textContent = '✓ Aplicado. Recargá el adset para ver el cambio.';
    resEl.style.color = '#16a34a';
    toast(preview + ' ✓', 'ok');
    // Invalidar dataset.loaded del bloque targeting para refrescar al cerrar.
    const t = document.getElementById('targ-' + adsetId);
    if (t) { t.dataset.loaded = ''; t.innerHTML = '<p style="font-size:11px;color:var(--text-2)">Refrescando…</p>'; loadAdsetTargeting(adsetId); }
  } catch (e) {
    resEl.textContent = '✗ ' + e.message; resEl.style.color = '#dc2626';
  }
}

// Parte 4: IA segmentación
async function loadSegAi(adsetId, btn) {
  if (state.config && !state.config.ai_enabled) {
    toast('Activá ANTHROPIC_API_KEY en Railway para el análisis IA.', 'err', 6000);
    return;
  }
  const wrap = document.getElementById('segai-' + adsetId);
  if (!wrap) return;
  setBtnLoading(btn, true, 'Generando…');
  wrap.innerHTML = '<p style="color:var(--text-2);font-size:11px;font-style:italic">La IA está pensando…</p>';
  try {
    const r = await api(`/api/v1/meta/adset/${adsetId}/ai-segmentation`);
    if (!r.ok) {
      wrap.innerHTML = `<p style="color:var(--text-2);font-size:11px">${r.message || r.error || 'No se pudo.'}</p>`;
      return;
    }
    wrap.innerHTML = `<div style="font-size:12px;line-height:1.55;color:var(--text)">${renderMarkdownLight(r.analysis || '')}</div>
      <p style="font-size:9px;color:var(--text-2);margin-top:6px">— ${r.model} · ${r.input_tokens}→${r.output_tokens} tokens${r.cached ? ' (cache)' : ''}</p>`;
  } catch (e) {
    wrap.innerHTML = `<p style="color:#dc2626;font-size:11px">Error: ${e.message}</p>`;
  } finally {
    setBtnLoading(btn, false);
  }
}

// Parte 3: rendimiento por región
async function loadRegionPerf(adsetId, days) {
  const wrap = document.getElementById('rgn-' + adsetId);
  if (!wrap) return;
  if (wrap.dataset.loadedDays === String(days || 30)) return;
  wrap.innerHTML = '<p style="color:var(--text-2);font-size:11px;font-style:italic">Cargando…</p>';
  try {
    const r = await api(`/api/v1/meta/adset/${adsetId}/region-perf?days=${days || 30}`);
    if (!r.ok) {
      wrap.innerHTML = `<p style="color:var(--text-2);font-size:11px">No se pudo: ${r.error || r.status || 'sin datos'}</p>`;
      return;
    }
    wrap.dataset.loadedDays = String(days || 30);
    if (!r.rows?.length) {
      wrap.innerHTML = `<p style="color:var(--text-2);font-size:11px">Sin datos por región en los últimos ${r.days}d (el adset no entregó o Meta no expone el desglose).</p>
        <p style="font-size:10px;color:var(--text-2);font-style:italic;margin-top:4px">${r.disclaimer}</p>`;
      return;
    }
    const avgCtr = r.averages?.ctr || 0;
    const avgCpc = r.averages?.cpc || 0;
    const colorCtr = (v) => v == null ? 'var(--text-2)' : (v > avgCtr * 1.3 ? '#16a34a' : v < avgCtr * 0.5 ? '#dc2626' : 'var(--text)');
    const colorCpc = (v) => v == null ? 'var(--text-2)' : (avgCpc > 0 && v < avgCpc * 0.8 ? '#16a34a' : avgCpc > 0 && v > avgCpc * 1.3 ? '#dc2626' : 'var(--text)');
    const head = `<tr style="font-size:10px;color:var(--text-2);text-transform:uppercase;border-bottom:.5px solid var(--border-3)">
      <th style="text-align:left;padding:4px">Región</th>
      <th style="text-align:right;padding:4px">Gasto</th>
      <th style="text-align:right;padding:4px">CTR</th>
      <th style="text-align:right;padding:4px">CPC</th>
      <th style="text-align:right;padding:4px">Resultados</th>
    </tr>`;
    const rows = r.rows.map((x) => `<tr style="font-size:11px;border-bottom:.5px dashed var(--border-3)">
      <td style="padding:4px">${(x.region||'—').replace(/[<>]/g,'')}</td>
      <td style="padding:4px;text-align:right">${eurFmt(x.spend)}</td>
      <td style="padding:4px;text-align:right;color:${colorCtr(x.ctr)}">${x.ctr != null ? (x.ctr*100).toFixed(2)+'%' : '—'}</td>
      <td style="padding:4px;text-align:right;color:${colorCpc(x.cpc)}">${x.cpc != null ? '€'+x.cpc.toFixed(2) : '—'}</td>
      <td style="padding:4px;text-align:right">${x.results || 0}${x.result_type ? ' <span style="color:var(--text-2);font-size:9px">'+x.result_type+'</span>' : ''}</td>
    </tr>`).join('');
    wrap.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <span style="font-size:10px;color:var(--text-2)">${r.n_regions} regiones · total €${r.total_spend.toFixed(2)}</span>
        <select onchange="loadRegionPerf('${adsetId}', this.value)" style="font-size:10px;padding:1px 4px;background:transparent;color:var(--text);border:.5px solid var(--border-3);border-radius:3px">
          <option value="14">14d</option>
          <option value="30" selected>30d</option>
          <option value="60">60d</option>
          <option value="90">90d</option>
        </select>
      </div>
      <table style="width:100%;border-collapse:collapse"><thead>${head}</thead><tbody>${rows}</tbody></table>
      <p style="font-size:10px;color:#d97706;font-style:italic;margin-top:6px;line-height:1.4">⚠ ${r.disclaimer}</p>`;
  } catch (e) {
    wrap.innerHTML = `<p style="color:#dc2626;font-size:11px">Error: ${e.message}</p>`;
  }
}

function renderAdsetBlock(s) {
  const si = s.insights || {};
  const sv = s.verdict || {};
  const sb = formatBudget(s.budget);
  let sProg = '';
  if (s.budget?.kind === 'lifetime' && s.budget.monto > 0 && si.spend > 0) {
    const pct = Math.min(100, (si.spend / s.budget.monto) * 100);
    sProg = `<div class="bar" style="width:90px;display:inline-block;vertical-align:middle;margin-left:4px"><div style="width:${pct}%"></div></div>`;
  }
  return `<div style="margin-left:1rem;padding:8px 10px;border-left:2px solid var(--border-3);margin-bottom:6px;background:rgba(0,0,0,.02);border-radius:4px">
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:6px">
      <span style="padding:1px 6px;border-radius:8px;font-size:9px;background:${s.effective_status === 'ACTIVE' ? 'rgba(99,153,34,.15)' : 'rgba(150,150,150,.15)'};color:${s.effective_status === 'ACTIVE' ? '#16a34a' : '#888'}">${s.effective_status}</span>
      <span style="font-size:12px;font-weight:500">${s.name}</span>
      ${sv.label ? `<span style="padding:1px 6px;border-radius:8px;font-size:9px;background:${sv.color || '#9ca3af'}22;color:${sv.color || '#9ca3af'}">${sv.label.replace(/[🟢🔵🟠🔴]\s*/, '')}</span>` : ''}
      <span style="color:var(--text-2);font-size:10px">${s.n_ads} ads${sb ? ' · ' + sb.text : ''}${sProg}</span>
      <span style="margin-left:auto;font-size:11px">${eurFmt(si.spend)} · CTR ${si.ctr != null ? (si.ctr*100).toFixed(2)+'%' : '—'}</span>
      <button data-act="toggle-adset" data-id="${s.id}" data-newstatus="${s.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE'}" onclick="onActionClick(event)" style="padding:2px 8px;font-size:10px;border-radius:4px;cursor:pointer;border:.5px solid var(--border-2);background:transparent;color:var(--text)" title="${s.status === 'ACTIVE' ? 'Pausar' : 'Activar'} adset">${s.status === 'ACTIVE' ? '⏸' : '▶'}</button>
      ${s.budget?.kind ? `<button onclick="openBudgetModal('adset','${s.id}','${s.budget.kind}',${s.budget.monto},${si.spend||0},'${(s.name||'').replace(/'/g,'')}')" style="padding:2px 8px;font-size:10px;border-radius:4px;cursor:pointer;border:.5px solid #185FA5;background:transparent;color:#185FA5" title="Cambiar presupuesto del adset">💰</button>` : ''}
    </div>
    <!-- Parte 2: bloque colapsable de Segmentación (lazy-load). -->
    <details onclick="if(this.open) loadAdsetTargeting('${s.id}')" style="margin-left:1.2rem;margin-bottom:4px;border:.5px dashed var(--border-3);border-radius:4px;padding:4px 8px;background:rgba(24,95,165,.04)">
      <summary style="cursor:pointer;font-size:11px;font-weight:500;color:#185FA5;list-style:none">🎯 Ver segmentación de este adset</summary>
      <div id="targ-${s.id}" style="margin-top:6px"><p style="color:var(--text-2);font-size:11px">Click para cargar</p></div>
    </details>
    ${s.ads.length ? `<div style="margin-left:1.2rem">${s.ads.map(renderAdRow).join('')}</div>` : ''}
  </div>`;
}

function renderAdRow(a) {
  const av = a.verdict || {};
  const cr = a.creative || {};
  // Thumbnail con escalera: backend resolvió thumbnail_resolved
  // (creative.thumbnail_url || image_url || ig_thumbnail).
  const thumb = adThumb(a);
  const cta = ctaLabel(cr.cta);
  // Copy real: body (creative diseñado) o ig_caption (post boosted).
  // NUNCA usar title — viene "instagram.com" en boosted.
  const copy = cr.body || cr.ig_caption || '';
  const showCopy = (copy || '').slice(0, 220);
  const adName = a.display_name || a.name || '';
  // Placeholder con link IG si no hay thumbnail.
  const thumbHtml = thumb
    ? `<img src="${thumb}" alt="" loading="lazy" style="width:54px;height:54px;border-radius:4px;object-fit:cover;background:var(--bg);flex-shrink:0" onerror="this.style.display='none'">`
    : (cr.post_permalink
        ? `<a href="${cr.post_permalink}" target="_blank" rel="noopener" style="width:54px;height:54px;border-radius:4px;background:var(--bg);flex-shrink:0;display:flex;align-items:center;justify-content:center;color:#185FA5;font-size:10px;text-decoration:none" title="Ver post en Instagram">↗ IG</a>`
        : `<div style="width:54px;height:54px;border-radius:4px;background:var(--bg);flex-shrink:0"></div>`);
  return `<div style="display:flex;gap:8px;padding:6px 0;border-bottom:.5px dashed var(--border-3)">
    ${thumbHtml}
    <div style="flex:1;min-width:0">
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:2px">
        ${av.label ? `<span style="padding:1px 5px;border-radius:6px;font-size:9px;background:${av.color || '#9ca3af'}22;color:${av.color || '#9ca3af'}">${av.label.replace(/[🟢🔵🟠🔴]\s*/, '')}</span>` : ''}
        <span style="font-size:11px;font-weight:500;word-break:break-word">${(adName||'').replace(/[<>]/g,'')}</span>
        <span style="font-size:10px;color:var(--text-2)">${eurFmt(a.insights?.spend)} · CTR ${a.insights?.ctr != null ? (a.insights.ctr*100).toFixed(2)+'%' : '—'}${a.insights?.results ? ' · ' + a.insights.results + ' resultados' : ''}</span>
        ${cr.post_permalink ? `<a href="${cr.post_permalink}" target="_blank" rel="noopener" style="font-size:10px;color:#185FA5;text-decoration:none;margin-left:auto" title="Abrir publicación real en Instagram/Meta">↗ Ver publicación</a>` : ''}
        <button data-act="toggle-ad" data-id="${a.id}" data-newstatus="${a.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE'}" onclick="onActionClick(event)" style="padding:1px 6px;font-size:9px;border-radius:3px;cursor:pointer;border:.5px solid var(--border-3);background:transparent;color:var(--text-2)" title="${a.status === 'ACTIVE' ? 'Pausar' : 'Activar'} ad">${a.status === 'ACTIVE' ? '⏸' : '▶'}</button>
      </div>
      ${showCopy ? `<p style="font-size:11px;color:var(--text-2);line-height:1.35;margin:2px 0;word-break:break-word">${showCopy.replace(/[<>]/g, '')}${copy.length > 220 ? '…' : ''}</p>` : ''}
      ${cta ? `<p style="font-size:10px;color:var(--text-2);margin-top:2px"><span style="padding:1px 6px;border-radius:4px;background:var(--bg-secondary)">CTA: ${cta}</span></p>` : ''}
    </div>
  </div>`;
}

// Handler centralizado para botones de acción — captura el elemento
// del DOM y muestra spinner + toast.
async function onActionClick(ev) {
  const btn = ev.currentTarget;
  const act = btn.dataset.act;
  const id = btn.dataset.id;
  const newStatus = btn.dataset.newstatus;
  if (!act || !id) return;
  const kindMap = { 'toggle-camp': 'campaign', 'toggle-adset': 'adset', 'toggle-ad': 'ad' };
  const kind = kindMap[act];
  if (!kind) return;
  const verb = newStatus === 'PAUSED' ? 'Pausando' : 'Activando';
  if (!confirm(`${verb} ${kind === 'campaign' ? 'la campaña' : kind === 'adset' ? 'el adset' : 'el ad'}. ¿Confirmás?`)) return;
  setBtnLoading(btn, true, verb + '…');
  try {
    const r = await api(`/api/v1/meta/${kind}/${id}/status`, { method: 'POST', body: JSON.stringify({ status: newStatus }) });
    if (r.ok) {
      toast(`${kind === 'campaign' ? 'Campaña' : kind === 'adset' ? 'Adset' : 'Ad'} ${newStatus === 'PAUSED' ? 'pausad' : 'activad'}${kind === 'adset' || kind === 'ad' ? 'o' : 'a'} ✓`, 'ok');
      await loadAds(true);
    } else {
      toast('No se pudo: ' + (r.error || r.message || 'error desconocido'), 'err', 6000);
    }
  } catch (e) {
    toast('Error: ' + e.message, 'err', 6000);
  } finally {
    setBtnLoading(btn, false);
  }
}

// ─── Modal "Subir presupuesto" ───────────────────────────────────────
function openBudgetModal(kind, id, budgetKind, currentMonto, spent, name) {
  if (state.config && !state.config.env_set?.META_USER_TOKEN && !state.config.tokens?.meta_user_token?.present) {
    toast('Falta token de Marketing API. Cargalo en Settings.', 'err', 6000);
    return;
  }
  const current = Number(currentMonto) || 0;
  const sugerido = Math.max(1, Math.round(current * 1.25));
  const minLifetime = budgetKind === 'lifetime' && spent > 0 ? Math.ceil(spent + 1) : null;
  // Resolver displayName + miniatura para que el dueño confirme sobre QUÉ actúa.
  // Si es campaign, buscar en state.ads.campaigns. Si es adset, buscar dentro
  // de su campaña.
  let displayName = name || id;
  let modalThumb = '';
  let permalink = null;
  const camps = state.ads?.campaigns || [];
  if (kind === 'campaign') {
    const c = camps.find((x) => String(x.id) === String(id));
    if (c) { displayName = c.display_name || c.name || id; modalThumb = campThumb(c); permalink = c.primary_permalink; }
  } else {
    for (const c of camps) {
      const s = (c.adsets || []).find((x) => String(x.id) === String(id));
      if (s) {
        displayName = (c.display_name || c.name || '') + ' › ' + (s.name || id);
        modalThumb = campThumb(c); permalink = c.primary_permalink;
        break;
      }
    }
  }
  const thumbBlock = modalThumb
    ? `<img src="${modalThumb}" alt="" style="width:48px;height:48px;border-radius:4px;object-fit:cover;background:var(--bg);flex-shrink:0">`
    : (permalink ? `<a href="${permalink}" target="_blank" rel="noopener" style="width:48px;height:48px;border-radius:4px;background:var(--bg);display:flex;align-items:center;justify-content:center;color:#185FA5;font-size:10px;text-decoration:none">↗ IG</a>` : '');
  // Construir modal
  const wrap = document.createElement('div');
  wrap.className = 'modal-bg';
  wrap.id = '_budget-modal';
  wrap.innerHTML = `
    <div class="modal" onclick="event.stopPropagation()">
      <h3>💰 ${current === 0 ? 'Configurar' : 'Subir'} presupuesto ${budgetKind === 'lifetime' ? 'total' : 'diario'}</h3>
      <div style="display:flex;gap:10px;align-items:flex-start;padding:8px;background:var(--bg-secondary);border-radius:var(--r-md);margin-bottom:.75rem">
        ${thumbBlock}
        <div style="flex:1;min-width:0">
          <p style="font-size:10px;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px">${kind === 'campaign' ? 'Campaña' : 'Adset'}</p>
          <p style="font-size:13px;font-weight:500;line-height:1.3;word-break:break-word">${(displayName||'').replace(/[<>]/g,'')}</p>
          ${permalink ? `<a href="${permalink}" target="_blank" rel="noopener" style="font-size:10px;color:#185FA5;text-decoration:none">↗ Ver en Instagram</a>` : ''}
        </div>
      </div>
      <p style="font-size:11px;color:var(--text-2);margin-bottom:.5rem">Actual: <strong style="color:var(--text)">€${current.toFixed(2)}</strong>${spent > 0 ? ` · gastado: €${spent.toFixed(2)}` : ''}</p>
      <div class="learning-warn">
        ⚠️ <strong>Consejo del media buyer:</strong> Subí de a poco (20-30%). Duplicar el presupuesto de golpe puede resetear la <em>fase de aprendizaje</em> del anuncio y empeorar el rendimiento.
      </div>
      <p style="font-size:11px;color:var(--text-2);margin:8px 0 4px">Sugerencias rápidas (vs actual €${current.toFixed(2)}):</p>
      <div class="preset-row">
        <button class="preset-btn"    onclick="_budgetPreset(20)">+20% (€${(current*1.2).toFixed(2)})</button>
        <button class="preset-btn on" onclick="_budgetPreset(25)">+25% (€${(current*1.25).toFixed(2)})</button>
        <button class="preset-btn"    onclick="_budgetPreset(30)">+30% (€${(current*1.3).toFixed(2)})</button>
        <button class="preset-btn"    onclick="_budgetPreset(50)">+50% (€${(current*1.5).toFixed(2)})</button>
      </div>
      <p style="font-size:11px;color:var(--text-2);margin:8px 0 4px">O escribí un monto manual (€):</p>
      <input type="number" id="_budget-input" value="${sugerido.toFixed(2)}" step="0.01" min="${minLifetime || 1}" style="width:100%;padding:8px;font-size:13px;border:.5px solid var(--border-2);border-radius:var(--r-md);background:var(--bg-secondary);color:var(--text)">
      ${minLifetime ? `<p style="font-size:10px;color:#d97706;margin-top:4px">Mínimo €${minLifetime} (debe ser mayor al gasto ya realizado).</p>` : ''}
      <p id="_budget-err" style="font-size:11px;color:#dc2626;min-height:14px;margin-top:6px"></p>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:.75rem">
        <button class="btn-secondary" onclick="closeBudgetModal()" style="padding:6px 14px;font-size:12px;border-radius:var(--r-md);cursor:pointer">Cancelar</button>
        <button id="_budget-save" class="btn-primary" onclick="saveBudgetModal('${kind}','${id}','${budgetKind}')" style="padding:6px 14px;font-size:12px;border-radius:var(--r-md);cursor:pointer">Aplicar</button>
      </div>
    </div>`;
  wrap.onclick = closeBudgetModal;
  document.body.appendChild(wrap);
  state._budgetModal = { kind, id, budgetKind, current, spent };
}
function _budgetPreset(pct) {
  const m = state._budgetModal;
  if (!m) return;
  const v = (m.current * (1 + pct / 100)).toFixed(2);
  $('_budget-input').value = v;
  document.querySelectorAll('#_budget-modal .preset-btn').forEach((b) => b.classList.remove('on'));
  // marcar el que matchea
  document.querySelectorAll('#_budget-modal .preset-btn').forEach((b) => {
    if (b.textContent.includes(`+${pct}%`)) b.classList.add('on');
  });
}
function closeBudgetModal() {
  const el = $('_budget-modal'); if (el) el.remove();
  state._budgetModal = null;
}
async function saveBudgetModal(kind, id, budgetKind) {
  const input = $('_budget-input');
  const errEl = $('_budget-err');
  const btn = $('_budget-save');
  const m = state._budgetModal;
  const monto = Number(input.value);
  errEl.textContent = '';
  if (!Number.isFinite(monto) || monto <= 0) { errEl.textContent = 'Monto inválido.'; return; }
  if (budgetKind === 'lifetime' && m.spent > 0 && monto <= m.spent) {
    errEl.textContent = `El presupuesto total (€${monto.toFixed(2)}) debe ser mayor al gasto ya realizado (€${m.spent.toFixed(2)}).`;
    return;
  }
  const body = budgetKind === 'lifetime' ? { lifetime_budget: monto } : { daily_budget: monto };
  setBtnLoading(btn, true, 'Aplicando…');
  try {
    const r = await api(`/api/v1/meta/${kind}/${id}/budget`, { method: 'POST', body: JSON.stringify(body) });
    if (r.ok) {
      closeBudgetModal();
      toast(`Presupuesto actualizado a €${monto.toFixed(2)} ✓`, 'ok');
      await loadAds(true);
    } else {
      errEl.textContent = r.error || r.message || 'No se pudo actualizar.';
    }
  } catch (e) {
    errEl.textContent = e.message;
  } finally {
    setBtnLoading(btn, false);
  }
}

// Aliases legacy para compat con cualquier handler suelto.
function campToggle(id, status)  { /* deprecado — usar onActionClick */ }
function adsetToggle(id, status) { /* idem */ }
function adToggle(id, status)    { /* idem */ }
function campBudget()            { /* idem — reemplazado por openBudgetModal */ }

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
      // Render markdown light: ## headings, **bold**, listas.
      out.innerHTML = renderMarkdownLight(r.analysis) +
        `<p style="font-size:10px;color:var(--text-2);margin-top:.75rem">— ${r.model} · ${r.input_tokens}→${r.output_tokens} tokens${r.cached ? ' (cache)' : ''}</p>`;
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
window.setIgPeriod = setIgPeriod;
window.setIgSort = setIgSort;
window.setAdsStatusTab = setAdsStatusTab;
window.scrollToCampaign = scrollToCampaign;
window.loadDailySpend = loadDailySpend;
window.loadAdsetTargeting = loadAdsetTargeting;
window.loadRegionPerf = loadRegionPerf;
window.loadSegAi = loadSegAi;
window.openTargetingEditor = openTargetingEditor;
window.closeTargModal = closeTargModal;
window._setTargTab = _setTargTab;
window._applyTargetingOp = _applyTargetingOp;
window._searchGeo = _searchGeo;
window.onActionClick = onActionClick;
window.openBudgetModal = openBudgetModal;
window.closeBudgetModal = closeBudgetModal;
window.saveBudgetModal = saveBudgetModal;
window._budgetPreset = _budgetPreset;
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
