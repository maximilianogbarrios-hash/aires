// Builder del dashboard de Instagram orgánico (F1).
// Trae: profile, followers, insights 28d (views + reach), posts/reels
// recientes con métricas. Cache server-side 15 min.
//
// CRÍTICO: usa SOLO IG_BUSINESS_ACCOUNT_ID / FACEBOOK_PAGE_ID de env vars
// de Aires. Sin defaults — si falta, devuelve estado "no configurado".

const { getInstagramConfig, resolveInstagramToken, graphGet } = require('./client');

const CACHE_TTL_MS = 15 * 60 * 1000;
let _cache = { ts: 0, payload: null };

function _extractMetricValue(json, metricName) {
  const data = json?.data || [];
  const m = data.find((x) => x?.name === metricName);
  if (!m) return null;
  // total_value
  if (m.total_value && typeof m.total_value.value === 'number') return m.total_value.value;
  // values[]: serie diaria — sumamos
  if (Array.isArray(m.values)) {
    let s = 0; let ok = false;
    for (const v of m.values) {
      if (typeof v?.value === 'number') { s += v.value; ok = true; }
    }
    return ok ? s : null;
  }
  return null;
}

async function buildInstagramDashboard({ refresh = false } = {}) {
  const cfg = getInstagramConfig();
  if (cfg.missing.length > 0) {
    return {
      ok: false,
      status: 'not_configured',
      missing_env: cfg.missing,
      message: 'Configurá las credenciales de Meta en Railway: ' + cfg.missing.join(', '),
    };
  }
  const { IG_BUSINESS_ACCOUNT_ID, FACEBOOK_PAGE_ID } = cfg.values;

  const { token, source: tokenSource } = await resolveInstagramToken();
  if (!token) {
    return {
      ok: false,
      status: 'no_token',
      message: 'Sin access token. Cargá uno en Settings o seteá INSTAGRAM_ACCESS_TOKEN en Railway.',
    };
  }

  const now = Date.now();
  if (!refresh && _cache.payload && now - _cache.ts < CACHE_TTL_MS) {
    return { ...(_cache.payload), cached: true, cache_age_sec: Math.floor((now - _cache.ts) / 1000) };
  }

  // 1) Profile
  const profile = await graphGet(IG_BUSINESS_ACCOUNT_ID, {
    fields: 'id,username,name,followers_count,profile_picture_url,media_count',
  }, token);
  if (!profile.ok) {
    return {
      ok: false,
      status: 'graph_error',
      stage: 'profile',
      error: profile.json?.error?.message || `HTTP ${profile.status}`,
      hint: 'Verificá el token y los permisos: instagram_basic, instagram_manage_insights, pages_read_engagement.',
    };
  }

  // 2) Insights 28d — views + reach
  const ins28 = await graphGet(`${IG_BUSINESS_ACCOUNT_ID}/insights`, {
    metric: 'views,reach', period: 'days_28', metric_type: 'total_value',
  }, token);
  let viewsSum = _extractMetricValue(ins28.json, 'views');
  let reachSum = _extractMetricValue(ins28.json, 'reach');
  // Fallback: si views no devolvió (cuenta legacy), probar `impressions`
  if (viewsSum == null) {
    const insLegacy = await graphGet(`${IG_BUSINESS_ACCOUNT_ID}/insights`, {
      metric: 'impressions', period: 'days_28', metric_type: 'total_value',
    }, token);
    if (insLegacy.ok) viewsSum = _extractMetricValue(insLegacy.json, 'impressions');
  }

  // 3) Media (posts + reels) con métricas
  const mediaFields = 'id,caption,media_type,media_product_type,media_url,permalink,thumbnail_url,timestamp,like_count,comments_count,insights.metric(views,reach,saved,shares)';
  const media = await graphGet(`${IG_BUSINESS_ACCOUNT_ID}/media`, {
    fields: mediaFields, limit: 50,
  }, token);

  const items = ((media.json?.data) || []).map((m) => {
    const ins = (m.insights?.data) || [];
    const getMetric = (name) => {
      const found = ins.find((x) => x.name === name);
      const v = found?.values?.[0]?.value;
      return typeof v === 'number' ? v : null;
    };
    return {
      id: m.id,
      caption: m.caption || '',
      media_type: m.media_type,
      media_product_type: m.media_product_type,
      media_url: m.media_url || m.thumbnail_url || null,
      permalink: m.permalink,
      timestamp: m.timestamp,
      like_count: typeof m.like_count === 'number' ? m.like_count : null,
      comments_count: typeof m.comments_count === 'number' ? m.comments_count : null,
      views: getMetric('views'),
      reach: getMetric('reach'),
      saved: getMetric('saved'),
      shares: getMetric('shares'),
    };
  });

  // Top posts/reels por reach.
  const reels = items.filter((m) => m.media_product_type === 'REELS').sort((a, b) => (b.reach || 0) - (a.reach || 0));
  const posts = items.filter((m) => m.media_product_type !== 'REELS').sort((a, b) => (b.reach || 0) - (a.reach || 0));

  const insights = {
    views: viewsSum,
    reach: reachSum,
    warning: (viewsSum == null || reachSum == null)
      ? 'Algunas métricas no disponibles para esta cuenta (depende del tipo IG Business / permisos del token).'
      : null,
  };
  const payload = {
    ok: true,
    status: 'active',
    token_source: tokenSource,
    profile: profile.json,
    period_days: 28,
    insights,
    insights_28d: insights, // deprecated alias, removed in commit 2
    posts: posts.slice(0, 12),
    reels: reels.slice(0, 12),
    media_count: items.length,
    fetched_at: new Date().toISOString(),
    facebook_page_id: FACEBOOK_PAGE_ID,
    ig_business_account_id: IG_BUSINESS_ACCOUNT_ID,
  };
  _cache = { ts: Date.now(), payload };
  return { ...payload, cached: false };
}

function invalidateCache() { _cache = { ts: 0, payload: null }; }

module.exports = { buildInstagramDashboard, invalidateCache };
