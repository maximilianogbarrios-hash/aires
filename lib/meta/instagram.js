// Builder del dashboard de Instagram orgánico — versión PRO.
//
// Soporta períodos 30/60/90 días con since/until. Trae KPIs de cuenta,
// audiencia (follower_demographics) y ranking de posts/reels con score.
//
// CRÍTICO: usa SOLO IG_BUSINESS_ACCOUNT_ID / FACEBOOK_PAGE_ID de env vars
// de Aires. Sin defaults. Si una métrica no la devuelve la API, se
// reporta como null + warning — JAMÁS se inventan datos.

const { getInstagramConfig, resolveInstagramToken, graphGet } = require('./client');
const metaCache = require('./cache');

const VALID_PERIODS = new Set([30, 60, 90]);
const CACHE_TTL_SEC = 3 * 60 * 60; // 3h por defecto

// ─── Helpers ─────────────────────────────────────────────────────────
function _isoDays(daysAgo) {
  return new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
}
function _sinceUntil(periodDays) {
  const until = Math.floor(Date.now() / 1000);
  const since = until - periodDays * 86400;
  return { since: String(since), until: String(until) };
}

// Suma values[] de una métrica de IG insights.
function _sumDailyValues(json, metricName) {
  const data = json?.data || [];
  const m = data.find((x) => x?.name === metricName);
  if (!m) return null;
  if (m.total_value && typeof m.total_value.value === 'number') return m.total_value.value;
  if (Array.isArray(m.values)) {
    let s = 0; let ok = false;
    for (const v of m.values) {
      if (typeof v?.value === 'number') { s += v.value; ok = true; }
    }
    return ok ? s : null;
  }
  return null;
}

// Pide UNA métrica y devuelve el total para since..until.
// Fallback robusto: total_value → daily values → null (con record en warnings).
async function _fetchMetricAggregated(igId, metric, periodDays, token, warnings) {
  const { since, until } = _sinceUntil(periodDays);
  // Intento 1: metric_type=total_value (rápido)
  let r = await graphGet(`${igId}/insights`, { metric, since, until, period: 'day', metric_type: 'total_value' }, token);
  let val = _sumDailyValues(r.ok ? r.json : {}, metric);
  if (val != null) return val;
  // Intento 2: serie diaria sumada
  r = await graphGet(`${igId}/insights`, { metric, since, until, period: 'day' }, token);
  val = _sumDailyValues(r.ok ? r.json : {}, metric);
  if (val == null && warnings) {
    const err = r.json?.error?.message;
    warnings.push(`Métrica "${metric}" no disponible${err ? ' (' + err + ')' : ''}`);
  }
  return val;
}

// ─── Audiencia (follower_demographics) ───────────────────────────────
// La API de IG requiere >100 followers + cuenta Business/Creator + permiso
// instagram_manage_insights. Devuelve null + warning si falla.
async function buildAudience(igId, token) {
  const breakdowns = ['country', 'city', 'age', 'gender'];
  const audience = {};
  const warnings = [];
  for (const bd of breakdowns) {
    const r = await graphGet(`${igId}/insights`, {
      metric: 'follower_demographics',
      period: 'lifetime',
      timeframe: 'this_month',
      breakdown: bd,
      metric_type: 'total_value',
    }, token);
    if (!r.ok) {
      warnings.push(`Audiencia/${bd} no disponible: ${r.json?.error?.message || 'HTTP ' + r.status}`);
      audience[bd] = null;
      continue;
    }
    const tv = r.json?.data?.[0]?.total_value?.breakdowns?.[0]?.results || [];
    // results: [{dimension_values: ['ES'], value: 23456}, ...]
    audience[bd] = tv.map((x) => ({
      key: Array.isArray(x.dimension_values) ? x.dimension_values.join(' / ') : String(x.dimension_values || '—'),
      value: Number(x.value) || 0,
    })).sort((a, b) => b.value - a.value).slice(0, 15);
  }
  return { audience, warnings };
}

// ─── Score de rendimiento por publicación ────────────────────────────
// Combina alcance + interacciones, ponderando MUY fuerte guardados y
// compartidos (señal real de interés). Normalizado contra la media de
// la cuenta para que sea relativo (no umbrales fijos).
function _scoreItem(item, mediaSummary) {
  const reach = item.reach || 0;
  const likes = item.like_count || 0;
  const comments = item.comments_count || 0;
  const saved = item.saved || 0;
  const shares = item.shares || 0;
  // Interacciones ponderadas:
  //   saved×4 + shares×3 + comments×2 + likes×1
  const interactions = saved * 4 + shares * 3 + comments * 2 + likes * 1;
  const engagementRate = reach > 0 ? interactions / reach : 0;
  // Score normalizado vs medias de la cuenta. Rango ~0–2 (1=promedio).
  const reachVsAvg = mediaSummary.avgReach > 0 ? reach / mediaSummary.avgReach : 0;
  const intVsAvg = mediaSummary.avgInteractions > 0 ? interactions / mediaSummary.avgInteractions : 0;
  // Score final 50% reach + 50% interactions normalizadas.
  return {
    score: Math.round((reachVsAvg * 0.5 + intVsAvg * 0.5) * 100) / 100,
    interactions,
    engagement_rate: Math.round(engagementRate * 10000) / 10000,
  };
}

function _topBottom(items, topN = 5) {
  const sorted = [...items].sort((a, b) => (b.score || 0) - (a.score || 0));
  const top = sorted.slice(0, topN);
  // Bottom: los con score >0 más bajos. Si todos son 0, queda vacío.
  const withSignal = sorted.filter((x) => (x.score || 0) > 0);
  const bottom = withSignal.slice(-topN).reverse();
  return { top, bottom };
}

function _motivoTop(it, mediaSummary) {
  const r = it.reach || 0;
  const saved = it.saved || 0;
  const shares = it.shares || 0;
  const reachMul = mediaSummary.avgReach > 0 ? r / mediaSummary.avgReach : 0;
  if (reachMul >= 2 && saved >= mediaSummary.avgSaved * 2) {
    return `${reachMul.toFixed(1)}× más alcance que tu promedio (gracias a ${saved} guardados).`;
  }
  if (reachMul >= 2) return `${reachMul.toFixed(1)}× más alcance que tu promedio.`;
  if (saved >= mediaSummary.avgSaved * 2) return `${saved} guardados (${(saved / Math.max(mediaSummary.avgSaved, 1)).toFixed(1)}× tu promedio) — señal de interés real.`;
  if (shares >= mediaSummary.avgShares * 2) return `${shares} compartidos amplificaron el alcance.`;
  return 'Combinación equilibrada de alcance e interacciones.';
}
function _motivoBottom(it, mediaSummary) {
  const r = it.reach || 0;
  const reachMul = mediaSummary.avgReach > 0 ? r / mediaSummary.avgReach : 0;
  if (reachMul < 0.5) return `Alcance ${(reachMul * 100).toFixed(0)}% del promedio. Probá otro formato/horario.`;
  if ((it.saved || 0) === 0 && (it.shares || 0) === 0) {
    return 'Sin guardados ni compartidos — el contenido no enganchó.';
  }
  return 'Performance por debajo del promedio.';
}

// ─── Builder principal ───────────────────────────────────────────────
async function buildInstagramDashboard({ period = 30, refresh = false } = {}) {
  if (!VALID_PERIODS.has(period)) period = 30;

  const cfg = getInstagramConfig();
  if (cfg.missing.length > 0) {
    return { ok: false, status: 'not_configured', missing_env: cfg.missing,
      message: 'Configurá las credenciales de Meta en Railway: ' + cfg.missing.join(', ') };
  }
  const { IG_BUSINESS_ACCOUNT_ID } = cfg.values;
  const { token, source: tokenSource } = await resolveInstagramToken();
  if (!token) {
    return { ok: false, status: 'no_token',
      message: 'Sin access token. Cargá uno en Settings o seteá INSTAGRAM_ACCESS_TOKEN.' };
  }

  const cacheKey = `ig_dashboard:${IG_BUSINESS_ACCOUNT_ID}:${period}d`;
  if (!refresh) {
    const cached = await metaCache.get(cacheKey).catch(() => null);
    if (cached) {
      const ageSec = Math.floor((Date.now() - new Date(cached.ts).getTime()) / 1000);
      return { ...cached.payload, cached: true, cache_age_sec: ageSec };
    }
  }

  // 1) Profile
  const profile = await graphGet(IG_BUSINESS_ACCOUNT_ID, {
    fields: 'id,username,name,followers_count,follows_count,profile_picture_url,media_count,biography',
  }, token);
  if (!profile.ok) {
    return { ok: false, status: 'graph_error', stage: 'profile',
      error: profile.json?.error?.message || `HTTP ${profile.status}`,
      hint: 'Verificá token + permisos: instagram_basic, instagram_manage_insights, pages_read_engagement.' };
  }

  const warnings = [];

  // 2) Insights del período (current + previous para variación)
  const [
    viewsCur, reachCur, profileViewsCur, websiteClicksCur, interactionsCur,
  ] = await Promise.all([
    _fetchMetricAggregated(IG_BUSINESS_ACCOUNT_ID, 'views', period, token, warnings),
    _fetchMetricAggregated(IG_BUSINESS_ACCOUNT_ID, 'reach', period, token, warnings),
    _fetchMetricAggregated(IG_BUSINESS_ACCOUNT_ID, 'profile_views', period, token, warnings),
    _fetchMetricAggregated(IG_BUSINESS_ACCOUNT_ID, 'website_clicks', period, token, warnings),
    _fetchMetricAggregated(IG_BUSINESS_ACCOUNT_ID, 'total_interactions', period, token, warnings),
  ]);

  // Período anterior (mismo tamaño) para variación.
  const prevWarnings = [];
  const _prevSinceUntil = () => {
    const until = Math.floor(Date.now() / 1000) - period * 86400;
    const since = until - period * 86400;
    return { since: String(since), until: String(until) };
  };
  async function _fetchPrev(metric) {
    const { since, until } = _prevSinceUntil();
    const r = await graphGet(`${IG_BUSINESS_ACCOUNT_ID}/insights`, { metric, since, until, period: 'day' }, token);
    return _sumDailyValues(r.ok ? r.json : {}, metric);
  }
  const [viewsPrev, reachPrev, profileViewsPrev] = await Promise.all([
    _fetchPrev('views'),
    _fetchPrev('reach'),
    _fetchPrev('profile_views'),
  ]);

  function _variacion(cur, prev) {
    if (cur == null || prev == null) return null;
    if (prev === 0) return cur === 0 ? 0 : null; // evitar /0
    return Math.round(((cur - prev) / prev) * 1000) / 10; // 1 decimal en %
  }

  const insights = {
    views: viewsCur, views_prev: viewsPrev, views_var_pct: _variacion(viewsCur, viewsPrev),
    reach: reachCur, reach_prev: reachPrev, reach_var_pct: _variacion(reachCur, reachPrev),
    profile_views: profileViewsCur, profile_views_var_pct: _variacion(profileViewsCur, profileViewsPrev),
    website_clicks: websiteClicksCur,
    interactions: interactionsCur,
    warning: warnings.length > 0 ? warnings.slice(0, 3).join(' · ') : null,
  };

  // 3) Audiencia
  let audienceData = null;
  try {
    audienceData = await buildAudience(IG_BUSINESS_ACCOUNT_ID, token);
  } catch (e) {
    audienceData = { audience: null, warnings: ['Audiencia falló: ' + e.message] };
  }

  // 4) Media con métricas — pedimos más (hasta 100) para ranking robusto.
  // IG limita por permisos: si shares/saved no disponibles, devuelven null.
  const mediaFields = 'id,caption,media_type,media_product_type,media_url,permalink,thumbnail_url,timestamp,like_count,comments_count,insights.metric(views,reach,saved,shares,total_interactions)';
  const media = await graphGet(`${IG_BUSINESS_ACCOUNT_ID}/media`, { fields: mediaFields, limit: 100 }, token);
  const items = ((media.json?.data) || []).map((m) => {
    const ins = (m.insights?.data) || [];
    const getMetric = (name) => {
      const found = ins.find((x) => x.name === name);
      const v = found?.values?.[0]?.value;
      return typeof v === 'number' ? v : null;
    };
    return {
      id: m.id, caption: m.caption || '',
      media_type: m.media_type, media_product_type: m.media_product_type,
      media_url: m.media_url || null, thumbnail_url: m.thumbnail_url || null,
      permalink: m.permalink, timestamp: m.timestamp,
      like_count: typeof m.like_count === 'number' ? m.like_count : null,
      comments_count: typeof m.comments_count === 'number' ? m.comments_count : null,
      views: getMetric('views'),
      reach: getMetric('reach'),
      saved: getMetric('saved'),
      shares: getMetric('shares'),
      total_interactions: getMetric('total_interactions'),
    };
  });

  // Filtrar items dentro del período
  const cutoff = Date.now() - period * 86400000;
  const itemsInPeriod = items.filter((m) => {
    const t = m.timestamp ? new Date(m.timestamp).getTime() : 0;
    return t >= cutoff;
  });

  // Promedios para score (sobre items con datos en el período).
  const itemsForAvg = itemsInPeriod.filter((m) => m.reach != null);
  const n = itemsForAvg.length;
  const mediaSummary = {
    avgReach:        n > 0 ? itemsForAvg.reduce((s, m) => s + (m.reach || 0), 0) / n : 0,
    avgInteractions: n > 0 ? itemsForAvg.reduce((s, m) => s + ((m.saved || 0) * 4 + (m.shares || 0) * 3 + (m.comments_count || 0) * 2 + (m.like_count || 0)), 0) / n : 0,
    avgSaved:        n > 0 ? itemsForAvg.reduce((s, m) => s + (m.saved || 0), 0) / n : 0,
    avgShares:       n > 0 ? itemsForAvg.reduce((s, m) => s + (m.shares || 0), 0) / n : 0,
  };

  // Aplicar score a cada item.
  for (const m of itemsInPeriod) {
    if (m.reach == null) { m.score = 0; continue; }
    const s = _scoreItem(m, mediaSummary);
    m.score = s.score;
    m.interactions_weighted = s.interactions;
    m.engagement_rate = s.engagement_rate;
  }

  // Rankings separados reels / posts.
  const reels = itemsInPeriod.filter((m) => m.media_product_type === 'REELS');
  const posts = itemsInPeriod.filter((m) => m.media_product_type !== 'REELS');
  const reelsRanking = _topBottom(reels, 5);
  const postsRanking = _topBottom(posts, 5);
  for (const r of reelsRanking.top)    r.motivo = _motivoTop(r, mediaSummary);
  for (const r of reelsRanking.bottom) r.motivo = _motivoBottom(r, mediaSummary);
  for (const r of postsRanking.top)    r.motivo = _motivoTop(r, mediaSummary);
  for (const r of postsRanking.bottom) r.motivo = _motivoBottom(r, mediaSummary);

  const payload = {
    ok: true, status: 'active', token_source: tokenSource,
    profile: profile.json,
    period_days: period,
    insights,
    insights_28d: insights, // deprecated alias
    audience: audienceData?.audience || null,
    audience_warnings: audienceData?.warnings || [],
    media_summary: {
      n_in_period: itemsInPeriod.length,
      avg_reach: Math.round(mediaSummary.avgReach),
      avg_saved: Math.round(mediaSummary.avgSaved * 10) / 10,
      avg_shares: Math.round(mediaSummary.avgShares * 10) / 10,
    },
    posts: posts.sort((a, b) => (b.reach || 0) - (a.reach || 0)).slice(0, 20),
    reels: reels.sort((a, b) => (b.reach || 0) - (a.reach || 0)).slice(0, 20),
    posts_top: postsRanking.top,
    posts_bottom: postsRanking.bottom,
    reels_top: reelsRanking.top,
    reels_bottom: reelsRanking.bottom,
    media_count: items.length,
    fetched_at: new Date().toISOString(),
  };
  await metaCache.putJson(cacheKey, payload, CACHE_TTL_SEC).catch(() => {});
  return { ...payload, cached: false };
}

function invalidateCache() {
  metaCache.invalidate('ig_dashboard:').catch(() => {});
}

module.exports = { buildInstagramDashboard, invalidateCache };
