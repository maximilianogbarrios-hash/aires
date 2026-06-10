// F2 — Meta Marketing API: builder de campañas/adsets/ads + acciones.
//
// Requiere META_AD_ACCOUNT_ID (formato 'act_xxx') y un User Access Token
// con scope ads_read (lectura) y ads_management (acciones).
//
// CRÍTICO: sin defaults SmartBuy — si falta config, devuelve
// {status:'not_configured', missing_env:[...]}.

const { getMarketingConfig, resolveMarketingToken, graphGet, graphPost } = require('./client');

const CACHE_TTL_MS = 15 * 60 * 1000;
let _cache = { ts: 0, payload: null, accId: null };

// Métricas estándar que pedimos a /insights por campaña/adset/ad.
const INSIGHTS_FIELDS = [
  'spend', 'impressions', 'clicks', 'reach', 'cpc', 'cpm', 'ctr',
  'actions', 'cost_per_action_type',
];

function _emptyInsights() {
  return { spend: 0, impressions: 0, clicks: 0, reach: 0, cpc: null, cpm: null, ctr: null, results: null };
}

function _parseInsights(insRow) {
  if (!insRow) return _emptyInsights();
  // Resultados principales: en Meta Ads "results" sale de `actions` con
  // el tipo configurado. Heurística: tomar el primer 'actions' con
  // un tipo conocido (link_click / lead / purchase / page_engagement).
  const actions = Array.isArray(insRow.actions) ? insRow.actions : [];
  const preferOrder = ['lead', 'purchase', 'link_click', 'post_engagement', 'page_engagement'];
  let results = null;
  for (const k of preferOrder) {
    const a = actions.find((x) => x.action_type === k);
    if (a) { results = { type: k, value: Number(a.value) || 0 }; break; }
  }
  return {
    spend: Number(insRow.spend || 0),
    impressions: Number(insRow.impressions || 0),
    clicks: Number(insRow.clicks || 0),
    reach: Number(insRow.reach || 0),
    cpc: insRow.cpc != null ? Number(insRow.cpc) : null,
    cpm: insRow.cpm != null ? Number(insRow.cpm) : null,
    ctr: insRow.ctr != null ? Number(insRow.ctr) : null,
    results,
  };
}

// Trae el snapshot completo del ad account: lista campañas, sus adsets
// y ads, todos con insights del último mes (date_preset=last_30d).
// Estructura el resultado en árbol jerárquico para que el frontend lo
// renderice agrupado.
async function buildAdsDashboard({ refresh = false } = {}) {
  const cfg = getMarketingConfig();
  if (cfg.missing.length > 0) {
    return {
      ok: false,
      status: 'not_configured',
      missing_env: cfg.missing,
      message: 'Configurá las credenciales de Meta Ads en Railway: ' + cfg.missing.join(', '),
    };
  }
  const accId = cfg.values.META_AD_ACCOUNT_ID;

  const { token, source: tokenSource } = await resolveMarketingToken();
  if (!token) {
    return {
      ok: false,
      status: 'no_token',
      message: 'Sin User Access Token. Cargá uno en /ads → Settings o seteá META_USER_TOKEN.',
      hint: 'El Page Token de Instagram NO sirve para Marketing API. Necesitás un User Token con scope ads_read / ads_management.',
    };
  }

  // Auto-invalidación del cache si cambió el ad_account_id.
  const now = Date.now();
  if (_cache.accId && _cache.accId !== accId) _cache = { ts: 0, payload: null, accId: null };
  if (!refresh && _cache.payload && now - _cache.ts < CACHE_TTL_MS) {
    return { ...(_cache.payload), cached: true, cache_age_sec: Math.floor((now - _cache.ts) / 1000) };
  }

  // 1) Info del account (nombre, currency).
  const accInfo = await graphGet(accId, { fields: 'id,name,account_status,currency,timezone_name,amount_spent' }, token);
  if (!accInfo.ok) {
    return {
      ok: false, status: 'graph_error', stage: 'account_info',
      error: accInfo.json?.error?.message || `HTTP ${accInfo.status}`,
      hint: 'Verificá META_USER_TOKEN (scope ads_read/ads_management) y que META_AD_ACCOUNT_ID corresponda al token.',
    };
  }

  // 2) Campañas con sus insights last_30d.
  const camps = await graphGet(`${accId}/campaigns`, {
    fields: 'id,name,objective,status,effective_status,daily_budget,lifetime_budget,start_time,stop_time,buying_type,insights.date_preset(last_30d){' + INSIGHTS_FIELDS.join(',') + '}',
    limit: 200,
  }, token);
  if (!camps.ok) {
    return {
      ok: false, status: 'graph_error', stage: 'campaigns',
      error: camps.json?.error?.message || `HTTP ${camps.status}`,
    };
  }

  // 3) Adsets de todas las campañas (un solo call al /adsets del account).
  const adsets = await graphGet(`${accId}/adsets`, {
    fields: 'id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,start_time,end_time,targeting,insights.date_preset(last_30d){' + INSIGHTS_FIELDS.join(',') + '}',
    limit: 500,
  }, token);

  // 4) Ads.
  const ads = await graphGet(`${accId}/ads`, {
    fields: 'id,name,adset_id,campaign_id,status,effective_status,creative{id,name,thumbnail_url},insights.date_preset(last_30d){' + INSIGHTS_FIELDS.join(',') + '}',
    limit: 1000,
  }, token);

  // Indexar adsets/ads por padre.
  const adsetsByCampaign = new Map();
  for (const a of (adsets.json?.data || [])) {
    if (!adsetsByCampaign.has(a.campaign_id)) adsetsByCampaign.set(a.campaign_id, []);
    adsetsByCampaign.get(a.campaign_id).push(a);
  }
  const adsByAdset = new Map();
  for (const a of (ads.json?.data || [])) {
    if (!adsByAdset.has(a.adset_id)) adsByAdset.set(a.adset_id, []);
    adsByAdset.get(a.adset_id).push(a);
  }

  function _extractIns(node) {
    const r = node?.insights?.data?.[0];
    return _parseInsights(r);
  }
  function _normBudget(node) {
    const d = Number(node.daily_budget || 0);
    const l = Number(node.lifetime_budget || 0);
    if (d > 0) return { kind: 'daily', cents: d, monto: d / 100 };
    if (l > 0) return { kind: 'lifetime', cents: l, monto: l / 100 };
    return { kind: null, cents: 0, monto: 0 };
  }

  // Armar árbol campaña → adsets → ads, con insights agregados.
  const campaigns = (camps.json?.data || []).map((c) => {
    const cIns = _extractIns(c);
    const cAdsets = (adsetsByCampaign.get(c.id) || []).map((s) => {
      const sIns = _extractIns(s);
      const sAds = (adsByAdset.get(s.id) || []).map((a) => ({
        id: a.id,
        name: a.name,
        status: a.status,
        effective_status: a.effective_status,
        creative: a.creative ? { id: a.creative.id, name: a.creative.name, thumbnail_url: a.creative.thumbnail_url } : null,
        insights: _extractIns(a),
      }));
      return {
        id: s.id, name: s.name,
        status: s.status, effective_status: s.effective_status,
        budget: _normBudget(s),
        start_time: s.start_time, end_time: s.end_time,
        ads: sAds,
        n_ads: sAds.length,
        insights: sIns,
      };
    });
    return {
      id: c.id, name: c.name,
      objective: c.objective,
      status: c.status, effective_status: c.effective_status,
      budget: _normBudget(c),
      buying_type: c.buying_type,
      start_time: c.start_time, stop_time: c.stop_time,
      adsets: cAdsets,
      n_adsets: cAdsets.length,
      n_ads: cAdsets.reduce((s, x) => s + x.n_ads, 0),
      insights: cIns,
    };
  });

  // Totales agregados.
  let totalSpend = 0, totalImp = 0, totalClicks = 0, totalReach = 0;
  for (const c of campaigns) {
    totalSpend += c.insights.spend;
    totalImp   += c.insights.impressions;
    totalClicks += c.insights.clicks;
    totalReach += c.insights.reach;
  }

  const payload = {
    ok: true,
    status: 'active',
    token_source: tokenSource,
    ad_account: {
      id: accInfo.json.id, name: accInfo.json.name,
      currency: accInfo.json.currency, timezone: accInfo.json.timezone_name,
      account_status: accInfo.json.account_status,
      amount_spent_total: Number(accInfo.json.amount_spent || 0) / 100,
    },
    totals_last_30d: {
      spend: totalSpend, impressions: totalImp, clicks: totalClicks, reach: totalReach,
      cpc: totalClicks > 0 ? totalSpend / totalClicks : null,
      cpm: totalImp > 0 ? totalSpend / totalImp * 1000 : null,
      ctr: totalImp > 0 ? totalClicks / totalImp : null,
    },
    n_campaigns: campaigns.length,
    n_adsets: campaigns.reduce((s, c) => s + c.n_adsets, 0),
    n_ads: campaigns.reduce((s, c) => s + c.n_ads, 0),
    campaigns,
    fetched_at: new Date().toISOString(),
  };
  _cache = { ts: Date.now(), payload, accId };
  return { ...payload, cached: false };
}

function invalidateAdsCache() { _cache = { ts: 0, payload: null, accId: null }; }

// ─── Acciones (status / budget) ──────────────────────────────────────
async function setEntityStatus(kind, id, status) {
  if (!['campaign', 'adset', 'ad'].includes(kind)) throw new Error('kind inválido');
  if (!['ACTIVE', 'PAUSED', 'ARCHIVED', 'DELETED'].includes(status)) throw new Error('status inválido');
  const { token } = await resolveMarketingToken();
  if (!token) return { ok: false, status: 'no_token' };
  const r = await graphPost(id, { status }, token);
  if (r.ok) invalidateAdsCache();
  return { ok: r.ok, response: r.json };
}

async function setEntityBudget(kind, id, { daily_budget, lifetime_budget }) {
  if (!['campaign', 'adset'].includes(kind)) throw new Error('budget solo aplica a campaign/adset');
  const body = {};
  if (daily_budget != null) body.daily_budget = Math.round(Number(daily_budget) * 100); // a centavos
  if (lifetime_budget != null) body.lifetime_budget = Math.round(Number(lifetime_budget) * 100);
  if (!body.daily_budget && !body.lifetime_budget) throw new Error('especificar daily_budget o lifetime_budget');
  const { token } = await resolveMarketingToken();
  if (!token) return { ok: false, status: 'no_token' };
  const r = await graphPost(id, body, token);
  if (r.ok) invalidateAdsCache();
  return { ok: r.ok, response: r.json };
}

// Detalle de UNA campaña con sus ads enriquecidos. Para vista zoom.
async function buildCampaignDetail(campaignId) {
  const { token } = await resolveMarketingToken();
  if (!token) return { ok: false, status: 'no_token' };
  const r = await graphGet(campaignId, {
    fields: 'id,name,objective,status,effective_status,daily_budget,lifetime_budget,start_time,stop_time,buying_type,insights.date_preset(last_30d){' + INSIGHTS_FIELDS.join(',') + '},adsets{id,name,status,effective_status,daily_budget,lifetime_budget,insights.date_preset(last_30d){' + INSIGHTS_FIELDS.join(',') + '},ads{id,name,status,effective_status,creative{id,name,thumbnail_url},insights.date_preset(last_30d){' + INSIGHTS_FIELDS.join(',') + '}}}',
  }, token);
  return r.ok ? { ok: true, campaign: r.json } : { ok: false, error: r.json?.error?.message };
}

module.exports = {
  buildAdsDashboard,
  buildCampaignDetail,
  setEntityStatus,
  setEntityBudget,
  invalidateAdsCache,
};
