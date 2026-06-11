// F2 — Meta Marketing API: builder de campañas/adsets/ads + acciones.
//
// Requiere META_AD_ACCOUNT_ID (formato 'act_xxx') y un User Access Token
// con scope ads_read (lectura) y ads_management (acciones).
//
// CRÍTICO: sin defaults SmartBuy — si falta config, devuelve
// {status:'not_configured', missing_env:[...]}.

const { getMarketingConfig, resolveMarketingToken, graphGet, graphPost } = require('./client');
const metaCache = require('./cache');

// Helper: paginar /{accId}/ads (o cualquier edge) hasta agotar.
// Graph API tope = 1000 items por página; en prod la cuenta tiene ~176
// campañas que generan más ads. Hard cap de 5 páginas (5000 items) por
// si algo se va de mambo — evita loops infinitos.
async function _paginate(graphPath, params, token, maxPages = 5) {
  const all = [];
  let r = await graphGet(graphPath, params, token);
  if (!r.ok) return { ok: false, data: [], error: r.json?.error?.message || `HTTP ${r.status}` };
  if (Array.isArray(r.json?.data)) all.push(...r.json.data);
  let nextUrl = r.json?.paging?.next;
  let pages = 1;
  while (nextUrl && pages < maxPages) {
    try {
      const nr = await fetch(nextUrl);
      if (!nr.ok) break;
      const nj = await nr.json();
      if (Array.isArray(nj?.data)) all.push(...nj.data);
      nextUrl = nj?.paging?.next || null;
      pages++;
    } catch { break; }
  }
  return { ok: true, data: all, pages };
}

// FIX 5 — Caption real del post de IG promocionado (boosted).
// Cuando el creative no trae `body` (típico en ads que promocionan un
// post de IG existente), traemos el caption del media via Graph API.
// Cache 24h porque captions no cambian.
async function _fetchIgCaption(igMediaId, token) {
  if (!igMediaId || !token) return null;
  const cacheKey = `ig_caption:${igMediaId}`;
  const cached = await metaCache.get(cacheKey).catch(() => null);
  if (cached?.payload) return cached.payload;
  const r = await graphGet(igMediaId, { fields: 'caption,permalink' }, token);
  if (!r.ok) return null;
  const payload = { caption: r.json?.caption || null, permalink: r.json?.permalink || null };
  await metaCache.putJson(cacheKey, payload, 24 * 3600).catch(() => {});
  return payload;
}

const CACHE_TTL_SEC = 15 * 60;
let _cacheMem = { ts: 0, payload: null, accId: null }; // mantengo cache en memoria como L1

// Métricas que pedimos a /insights — ampliadas con frequency,
// cost_per_action_type y purchase_roas para ROAS.
const INSIGHTS_FIELDS = [
  'spend', 'impressions', 'clicks', 'reach', 'frequency',
  'cpc', 'cpm', 'ctr',
  'actions', 'cost_per_action_type', 'purchase_roas',
];

function _emptyInsights() {
  return {
    spend: 0, impressions: 0, clicks: 0, reach: 0,
    frequency: null, cpc: null, cpm: null, ctr: null,
    results: null, cost_per_result: null, roas: null,
  };
}

function _parseInsights(insRow) {
  if (!insRow) return _emptyInsights();
  const actions = Array.isArray(insRow.actions) ? insRow.actions : [];
  const cpaList = Array.isArray(insRow.cost_per_action_type) ? insRow.cost_per_action_type : [];
  // Resultados principales: tomar la action_type que más se parece al
  // objetivo de la campaña (lead, purchase, omni_purchase, messaging_
  // conversation_started_7d, link_click, post_engagement).
  const preferOrder = ['lead', 'purchase', 'omni_purchase', 'onsite_conversion.messaging_conversation_started_7d',
                       'link_click', 'video_view', 'post_engagement', 'page_engagement'];
  let results = null;
  let resultType = null;
  for (const k of preferOrder) {
    const a = actions.find((x) => x.action_type === k);
    if (a) { results = Number(a.value) || 0; resultType = k; break; }
  }
  let cpa = null;
  if (resultType) {
    const c = cpaList.find((x) => x.action_type === resultType);
    if (c) cpa = Number(c.value) || null;
  }
  // ROAS: purchase_roas viene como [{value: '1.85', action_type: 'omni_purchase'}]
  let roas = null;
  if (Array.isArray(insRow.purchase_roas) && insRow.purchase_roas.length > 0) {
    roas = Number(insRow.purchase_roas[0].value) || null;
  }
  return {
    spend: Number(insRow.spend || 0),
    impressions: Number(insRow.impressions || 0),
    clicks: Number(insRow.clicks || 0),
    reach: Number(insRow.reach || 0),
    frequency: insRow.frequency != null ? Number(insRow.frequency) : null,
    cpc: insRow.cpc != null ? Number(insRow.cpc) : null,
    cpm: insRow.cpm != null ? Number(insRow.cpm) : null,
    ctr: insRow.ctr != null ? Number(insRow.ctr) / 100 : null, // Meta lo da en % (string)
    results,
    result_type: resultType,
    cost_per_result: cpa,
    roas,
  };
}

// ─── Motor de veredicto (Escalar/Mantener/Optimizar/Pausar) ──────────
// Comparativo contra el PROMEDIO DE LA CUENTA, no umbrales fijos.
// Solo recomienda — el usuario decide.
function _veredicto(ins, averages) {
  const status = { kind: null, label: null, color: null, reason: '' };
  if (!ins || ins.spend == null) {
    status.kind = 'sin_datos'; status.label = 'Sin datos'; status.color = '#9ca3af';
    return status;
  }
  // Reglas (en orden de prioridad):
  // 1. Sin resultados con gasto significativo + CPC alto → PAUSAR
  // 2. CTR muy alto y CPC bajo → ESCALAR
  // 3. Frecuencia >3.5 → OPTIMIZAR (rotar creative)
  // 4. CTR bajo o CPC alto vs promedio → OPTIMIZAR
  // 5. Cerca del promedio → MANTENER
  const avgCpc = averages.cpc || 0;
  const avgCtr = averages.ctr || 0;
  const minSpendForJudgement = Math.max(averages.spendP25 || 0, 20); // €20 mínimo
  const cpc = ins.cpc != null ? ins.cpc : null;
  const ctr = ins.ctr != null ? ins.ctr : null;
  const freq = ins.frequency != null ? ins.frequency : null;
  const results = ins.results || 0;

  if (ins.spend >= minSpendForJudgement && results === 0 && cpc != null && avgCpc > 0 && cpc > avgCpc * 1.5) {
    status.kind = 'pausar'; status.label = '🔴 PAUSAR / REVISAR'; status.color = '#dc2626';
    status.reason = `Gasto €${Math.round(ins.spend)} sin resultados y CPC ${(cpc / avgCpc).toFixed(1)}× más caro que tu promedio. Candidata a pausar.`;
    return status;
  }
  if (cpc != null && ctr != null && avgCtr > 0 && avgCpc > 0 &&
      ctr >= avgCtr * 1.3 && cpc <= avgCpc * 0.8 && results > 0) {
    status.kind = 'escalar'; status.label = '🟢 ESCALAR'; status.color = '#16a34a';
    status.reason = `CTR ${((ctr / avgCtr - 1) * 100).toFixed(0)}% sobre tu promedio y CPC ${((1 - cpc / avgCpc) * 100).toFixed(0)}% más barato. Subí el presupuesto.`;
    return status;
  }
  if (freq != null && freq > 3.5) {
    status.kind = 'optimizar'; status.label = '🟠 OPTIMIZAR'; status.color = '#d97706';
    status.reason = `Frecuencia ${freq.toFixed(1)} — la gente se satura. Rotá la creative o ampliá audiencia.`;
    return status;
  }
  if (ctr != null && avgCtr > 0 && ctr < avgCtr * 0.5 && ins.spend >= minSpendForJudgement) {
    status.kind = 'optimizar'; status.label = '🟠 OPTIMIZAR'; status.color = '#d97706';
    status.reason = `CTR ${(ctr * 100).toFixed(2)}% es ${(ctr / avgCtr).toFixed(2)}× tu promedio. El gancho no funciona — revisá copy/imagen.`;
    return status;
  }
  if (cpc != null && avgCpc > 0 && cpc > avgCpc * 1.5) {
    status.kind = 'optimizar'; status.label = '🟠 OPTIMIZAR'; status.color = '#d97706';
    status.reason = `CPC €${cpc.toFixed(2)} (${(cpc / avgCpc).toFixed(1)}× tu promedio). Probá otra segmentación.`;
    return status;
  }
  status.kind = 'mantener'; status.label = '🔵 MANTENER'; status.color = '#185FA5';
  status.reason = 'Rendimiento cerca del promedio de tu cuenta.';
  return status;
}

function _calcularPromedios(items) {
  const validos = items.filter((it) => it.insights?.spend > 0 && it.insights?.impressions > 0);
  if (!validos.length) return { cpc: 0, ctr: 0, cpm: 0, cpa: 0, spendP25: 0 };
  const n = validos.length;
  const avg = (key) => {
    const valores = validos.map((it) => it.insights[key]).filter((v) => v != null && Number.isFinite(v));
    return valores.length ? valores.reduce((s, v) => s + v, 0) / valores.length : 0;
  };
  const spends = validos.map((it) => it.insights.spend).sort((a, b) => a - b);
  const spendP25 = spends[Math.floor(spends.length * 0.25)] || 0;
  return {
    cpc: avg('cpc'),
    ctr: avg('ctr'),
    cpm: avg('cpm'),
    cpa: avg('cost_per_result'),
    spendP25,
    n,
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

  // L1 cache (memory) + L2 cache (DB).
  const cacheKey = `ads_dashboard:${accId}`;
  if (_cacheMem.accId && _cacheMem.accId !== accId) _cacheMem = { ts: 0, payload: null, accId: null };
  const now = Date.now();
  if (!refresh && _cacheMem.payload && now - _cacheMem.ts < CACHE_TTL_SEC * 1000) {
    return { ...(_cacheMem.payload), cached: true, cache_source: 'memory', cache_age_sec: Math.floor((now - _cacheMem.ts) / 1000) };
  }
  if (!refresh) {
    const dbCached = await metaCache.get(cacheKey).catch(() => null);
    if (dbCached) {
      _cacheMem = { ts: new Date(dbCached.ts).getTime(), payload: dbCached.payload, accId };
      const ageSec = Math.floor((Date.now() - new Date(dbCached.ts).getTime()) / 1000);
      return { ...dbCached.payload, cached: true, cache_source: 'db', cache_age_sec: ageSec };
    }
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

  // 4) Ads — query a nivel cuenta con PAGINACIÓN. Antes con limit:1000
  // suelto se perdían ads cuando la cuenta tenía más. Ahora seguimos
  // paging.next hasta agotar (cap 5 páginas = 5000 ads). El creative
  // viene ampliado: thumbnail/image/body/title/CTA + effective IDs
  // para construir el permalink al post real.
  const adsResult = await _paginate(`${accId}/ads`, {
    fields: 'id,name,adset_id,campaign_id,status,effective_status,'
      + 'creative{id,name,thumbnail_url,image_url,body,title,call_to_action_type,'
        + 'effective_object_story_id,effective_instagram_media_id,instagram_permalink_url,'
        + 'object_story_spec{instagram_actor_id,page_id,link_data{message,name,description,link,picture,image_hash,call_to_action{type,value{link}}},video_data{title,message,call_to_action{type,value{link}}}}},'
      + 'insights.date_preset(last_30d){' + INSIGHTS_FIELDS.join(',') + '}',
    limit: 500,
  }, token);
  // Compat con el resto del builder (usa `ads.json.data` más abajo).
  const ads = { ok: adsResult.ok, json: { data: adsResult.data, _pages_fetched: adsResult.pages } };
  if (!adsResult.ok) console.warn('[meta.ads] paginate /ads failed:', adsResult.error);

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
  // Normaliza el creative de un ad — extrae lo mostrable al usuario:
  // miniatura, copy real (body), titular, CTA, link al post real.
  //
  // FIX 5: `title` en posts boosted de IG llega como "instagram.com"
  // (el dominio del enlace), engañoso si se muestra como copy. Por eso
  // NUNCA usamos title como fallback de body. Si body falta, queda null
  // y el builder fetcha caption del IG media (`ig_caption`) en un pass
  // separado.
  function _normCreative(cr) {
    if (!cr) return null;
    const linkData = cr.object_story_spec?.link_data || null;
    const videoData = cr.object_story_spec?.video_data || null;
    // Body real: solo el copy escrito, NUNCA title (que viene "instagram.com").
    const body = cr.body || linkData?.message || videoData?.message || null;
    // Title: solo cuando NO es un dominio engañoso.
    const rawTitle = cr.title || linkData?.name || videoData?.title || null;
    const isDomainTitle = rawTitle && /^(instagram\.com|fb\.com|facebook\.com|www\.[a-z0-9.-]+)$/i.test(rawTitle);
    const title = isDomainTitle ? null : rawTitle;
    const description = linkData?.description || null;
    let cta = cr.call_to_action_type || linkData?.call_to_action?.type || videoData?.call_to_action?.type || null;
    const linkUrl = linkData?.link || linkData?.call_to_action?.value?.link || videoData?.call_to_action?.value?.link || null;
    // Permalink al post real: PRIORIDAD a instagram_permalink_url (link
    // real de IG); fallback a FB story_id solo si no hay IG.
    let postPermalink = cr.instagram_permalink_url || null;
    if (!postPermalink && cr.effective_object_story_id) {
      postPermalink = `https://www.facebook.com/${cr.effective_object_story_id}`;
    }
    return {
      id: cr.id,
      name: cr.name || null,
      thumbnail_url: cr.thumbnail_url || cr.image_url || linkData?.picture || null,
      image_url: cr.image_url || null,
      body,           // copy real escrito (puede ser null)
      ig_caption: null, // se llena después si body es null + hay ig_media_id
      title,          // null si era "instagram.com"/"fb.com"
      description, cta,
      link_url: linkUrl,
      post_permalink: postPermalink,
      ig_media_id: cr.effective_instagram_media_id || null,
      story_id: cr.effective_object_story_id || null,
    };
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
        creative: _normCreative(a.creative),
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
    // Presupuesto efectivo: CBO = budget en la campaña; ABO = suma de
    // los adsets. El frontend usa effective_budget para mostrar siempre
    // un valor visible aunque sea ABO.
    const campBudget = _normBudget(c);
    let effectiveBudget;
    if (campBudget.kind) {
      effectiveBudget = { ...campBudget, level: 'campaign', source: 'CBO' };
    } else {
      let dailySum = 0, lifetimeSum = 0;
      for (const s of cAdsets) {
        if (s.budget.kind === 'daily')    dailySum += s.budget.monto;
        if (s.budget.kind === 'lifetime') lifetimeSum += s.budget.monto;
      }
      if (dailySum > 0 && lifetimeSum === 0) {
        effectiveBudget = { kind: 'daily', monto: dailySum, cents: dailySum * 100, level: 'adset', source: 'ABO' };
      } else if (lifetimeSum > 0 && dailySum === 0) {
        effectiveBudget = { kind: 'lifetime', monto: lifetimeSum, cents: lifetimeSum * 100, level: 'adset', source: 'ABO' };
      } else if (dailySum > 0 && lifetimeSum > 0) {
        effectiveBudget = { kind: 'mixed', monto: dailySum + lifetimeSum, daily: dailySum, lifetime: lifetimeSum, level: 'adset', source: 'ABO' };
      } else {
        effectiveBudget = { kind: null, monto: 0, level: null, source: null };
      }
    }
    // Thumbnail del primer ad con creative — para mostrar de un vistazo
    // qué se está promocionando, sin abrir el drill-down.
    let primaryThumbnail = null;
    for (const s of cAdsets) {
      for (const a of s.ads) {
        if (a.creative?.thumbnail_url) { primaryThumbnail = a.creative.thumbnail_url; break; }
      }
      if (primaryThumbnail) break;
    }
    return {
      id: c.id, name: c.name,
      objective: c.objective,
      status: c.status, effective_status: c.effective_status,
      budget: campBudget,
      effective_budget: effectiveBudget,
      primary_thumbnail: primaryThumbnail,
      buying_type: c.buying_type,
      start_time: c.start_time, stop_time: c.stop_time,
      adsets: cAdsets,
      n_adsets: cAdsets.length,
      n_ads: cAdsets.reduce((s, x) => s + x.n_ads, 0),
      insights: cIns,
    };
  });

  // FIX 5 — Enriquecer creatives sin body con caption del post de IG
  // boosted. Recolecto los media_ids únicos a buscar; con cache la
  // primera vuelta es lenta y las siguientes instantáneas.
  const missingBodyMediaIds = new Set();
  for (const c of campaigns) {
    for (const s of c.adsets) for (const a of s.ads) {
      if (a.creative && !a.creative.body && a.creative.ig_media_id) {
        missingBodyMediaIds.add(a.creative.ig_media_id);
      }
    }
  }
  if (missingBodyMediaIds.size > 0) {
    const ids = Array.from(missingBodyMediaIds);
    // Concurrencia limitada (5 a la vez) para no triggerear rate limit.
    const captionsMap = new Map();
    for (let i = 0; i < ids.length; i += 5) {
      const chunk = ids.slice(i, i + 5);
      const results = await Promise.all(chunk.map((id) => _fetchIgCaption(id, token).then((r) => [id, r])));
      for (const [id, r] of results) if (r) captionsMap.set(id, r);
    }
    // Aplicar a cada ad: rellenar creative.ig_caption + ig_permalink (si no había permalink).
    for (const c of campaigns) {
      for (const s of c.adsets) for (const a of s.ads) {
        if (a.creative && !a.creative.body && a.creative.ig_media_id) {
          const cap = captionsMap.get(a.creative.ig_media_id);
          if (cap) {
            a.creative.ig_caption = cap.caption;
            if (!a.creative.post_permalink && cap.permalink) a.creative.post_permalink = cap.permalink;
          }
        }
      }
    }
  }

  // Totales agregados (sumas + recálculo de ratios).
  let totalSpend = 0, totalImp = 0, totalClicks = 0, totalReach = 0, totalResults = 0;
  for (const c of campaigns) {
    totalSpend += c.insights.spend;
    totalImp   += c.insights.impressions;
    totalClicks += c.insights.clicks;
    totalReach += c.insights.reach;
    totalResults += c.insights.results || 0;
  }

  // Promedios de la cuenta — base para el veredicto.
  const averages = _calcularPromedios(campaigns);

  // Aplicar veredicto a cada campaña + score relativo (relativo a su mejor par).
  for (const c of campaigns) c.verdict = _veredicto(c.insights, averages);
  for (const c of campaigns) {
    for (const s of c.adsets) {
      s.verdict = _veredicto(s.insights, averages);
      for (const a of s.ads) a.verdict = _veredicto(a.insights, averages);
    }
  }

  // Agrupar por effective_status. ACTIVE primero (lo más importante).
  function _groupByStatus(camps) {
    const groups = { ACTIVE: [], PAUSED: [], otros: [] };
    for (const c of camps) {
      const s = c.effective_status || c.status || 'UNKNOWN';
      if (s === 'ACTIVE') groups.ACTIVE.push(c);
      else if (s === 'PAUSED') groups.PAUSED.push(c);
      else groups.otros.push(c);
    }
    // Ordenar dentro de cada grupo por gasto desc (lo más impactante primero).
    for (const k of Object.keys(groups)) groups[k].sort((a, b) => b.insights.spend - a.insights.spend);
    return groups;
  }
  const groups = _groupByStatus(campaigns);

  // Top mejores y peores entre ACTIVAS (lo accionable).
  const activeCamp = groups.ACTIVE.filter((c) => c.insights.spend > 0);
  const top = activeCamp.filter((c) => c.verdict.kind === 'escalar').slice(0, 5);
  const bottom = activeCamp.filter((c) => c.verdict.kind === 'pausar' || c.verdict.kind === 'optimizar')
    .slice(0, 5);

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
      spend: totalSpend, impressions: totalImp, clicks: totalClicks, reach: totalReach, results: totalResults,
      frequency: totalReach > 0 ? totalImp / totalReach : null,
      cpc: totalClicks > 0 ? totalSpend / totalClicks : null,
      cpm: totalImp > 0 ? totalSpend / totalImp * 1000 : null,
      ctr: totalImp > 0 ? totalClicks / totalImp : null,
      cpa: totalResults > 0 ? totalSpend / totalResults : null,
    },
    averages,           // base para colorear KPIs por campaña
    n_campaigns: campaigns.length,
    n_adsets: campaigns.reduce((s, c) => s + c.n_adsets, 0),
    n_ads: campaigns.reduce((s, c) => s + c.n_ads, 0),
    groups: {
      active:  { count: groups.ACTIVE.length,  spend: groups.ACTIVE.reduce((s, c) => s + c.insights.spend, 0), campaigns: groups.ACTIVE },
      paused:  { count: groups.PAUSED.length,  spend: groups.PAUSED.reduce((s, c) => s + c.insights.spend, 0), campaigns: groups.PAUSED },
      otros:   { count: groups.otros.length,   spend: groups.otros.reduce((s, c) => s + c.insights.spend, 0),  campaigns: groups.otros },
    },
    campaigns,          // mantengo flat para compat con frontend viejo
    recommendations: { top, bottom },
    fetched_at: new Date().toISOString(),
  };
  _cacheMem = { ts: Date.now(), payload, accId };
  await metaCache.putJson(cacheKey, payload, CACHE_TTL_SEC).catch(() => {});
  return { ...payload, cached: false };
}

function invalidateAdsCache() {
  _cacheMem = { ts: 0, payload: null, accId: null };
  metaCache.invalidate('ads_dashboard:').catch(() => {});
}

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
  if (daily_budget != null) {
    if (!Number.isFinite(+daily_budget) || +daily_budget <= 0) throw new Error('daily_budget inválido');
    body.daily_budget = Math.round(Number(daily_budget) * 100);
  }
  if (lifetime_budget != null) {
    if (!Number.isFinite(+lifetime_budget) || +lifetime_budget <= 0) throw new Error('lifetime_budget inválido');
    body.lifetime_budget = Math.round(Number(lifetime_budget) * 100);
  }
  if (!body.daily_budget && !body.lifetime_budget) throw new Error('especificar daily_budget o lifetime_budget');
  const { token } = await resolveMarketingToken();
  if (!token) return { ok: false, status: 'no_token' };
  // Validación lifetime: nuevo valor debe ser > gasto actual (Meta lo
  // rechaza igual, pero damos error claro antes).
  if (body.lifetime_budget) {
    const info = await graphGet(id, { fields: 'lifetime_budget,insights{spend}' }, token);
    const spendEur = info.json?.insights?.data?.[0]?.spend ? Number(info.json.insights.data[0].spend) : 0;
    if (spendEur > 0 && (body.lifetime_budget / 100) <= spendEur) {
      return { ok: false, error: `El presupuesto total (€${(body.lifetime_budget / 100).toFixed(2)}) debe ser mayor al gasto ya realizado (€${spendEur.toFixed(2)}).` };
    }
  }
  const r = await graphPost(id, body, token);
  if (r.ok) invalidateAdsCache();
  if (!r.ok) {
    return { ok: false, error: r.json?.error?.error_user_msg || r.json?.error?.message || 'Meta rechazó el cambio.' };
  }
  return { ok: true, response: r.json };
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
