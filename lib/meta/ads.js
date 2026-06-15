// F2 — Meta Marketing API: builder de campañas/adsets/ads + acciones.
//
// Requiere META_AD_ACCOUNT_ID (formato 'act_xxx') y un User Access Token
// con scope ads_read (lectura) y ads_management (acciones).
//
// CRÍTICO: sin defaults SmartBuy — si falta config, devuelve
// {status:'not_configured', missing_env:[...]}.

const { getMarketingConfig, resolveMarketingToken, graphGet, graphPost } = require('./client');
const metaCache = require('./cache');

// Métricas que pedimos a /insights — declaradas ARRIBA porque ADS_FIELDS
// (más abajo) las referencia al evaluar el template string. Mover esto
// debajo de su uso causa TDZ (ReferenceError al cargar el módulo).
const INSIGHTS_FIELDS = [
  'spend', 'impressions', 'clicks', 'reach', 'frequency',
  'cpc', 'cpm', 'ctr',
  'actions', 'cost_per_action_type', 'purchase_roas',
];

const CACHE_TTL_SEC = 15 * 60;
let _cacheMem = { ts: 0, payload: null, accId: null, cacheKey: null }; // cache L1 en memoria

// Helper: paginar UNA edge de Graph API hasta agotar.
// `paging.next` ya viene con access_token embebido — fetch directo.
// Hard cap por seguridad (10 páginas × 500 = 5000 items).
// Política: si una página intermedia falla, devolvemos lo que TENEMOS
// + el error en el resultado. Nunca devolver [] por error parcial.
async function _paginate(graphPath, params, token, { maxPages = 10, pageSize = 500 } = {}) {
  const all = [];
  const errors = [];
  let r = await graphGet(graphPath, { ...params, limit: pageSize }, token);
  if (!r.ok) {
    errors.push({ page: 1, status: r.status, message: r.json?.error?.message || `HTTP ${r.status}` });
    return { ok: false, data: [], errors, pages: 0 };
  }
  if (Array.isArray(r.json?.data)) all.push(...r.json.data);
  let nextUrl = r.json?.paging?.next || null;
  let pages = 1;
  while (nextUrl && pages < maxPages) {
    try {
      const nr = await fetch(nextUrl);
      if (!nr.ok) { errors.push({ page: pages + 1, status: nr.status, message: 'HTTP ' + nr.status }); break; }
      const nj = await nr.json();
      if (nj?.error) { errors.push({ page: pages + 1, status: nr.status, message: nj.error.message }); break; }
      if (Array.isArray(nj?.data)) all.push(...nj.data);
      nextUrl = nj?.paging?.next || null;
      pages++;
    } catch (e) { errors.push({ page: pages + 1, message: e.message }); break; }
  }
  return { ok: true, data: all, errors, pages, truncated: !!nextUrl };
}

// FIELDS LIVIANOS — los EXACTAMENTE confirmados en Graph Explorer y
// en /_debug/ads (que SÍ trae 504 ads). Sin insights, sin
// object_story_spec ultra-anidado: con esos subselects Meta truncaba
// o rechazaba la query → response data:[] → 0 ads por campaña → BUG.
// Esta es la ÚNICA fuente de verdad para los ads en el panel.
const ADS_FIELDS_LIGHT =
  'id,name,status,effective_status,campaign_id,adset_id,' +
  'creative{id,thumbnail_url,image_url,body,title,call_to_action_type,' +
    'effective_object_story_id,effective_instagram_media_id,instagram_permalink_url}';

// Normaliza referencias anidadas → planas (defensa por si Meta los devuelve
// como `adset{id}` en lugar de `adset_id` plano según el expand).
function _normalizeAdRefs(a) {
  if (!a) return a;
  if (!a.adset_id && a.adset?.id)       a.adset_id    = a.adset.id;
  if (!a.campaign_id && a.campaign?.id) a.campaign_id = a.campaign.id;
  return a;
}

// ÚNICA función de fetch de ads para join — usada por buildAdsDashboard
// Y por /_debug/ads. Cero divergencia entre el panel real y el debug.
async function fetchAdsForJoin(accId, token) {
  // pageSize 200 (probado en debug, más conservador que 500 con fields completos).
  // 20 páginas × 200 = 4000 ads max. La cuenta real tiene ~504.
  const res = await _paginate(`${accId}/ads`, { fields: ADS_FIELDS_LIGHT }, token, { maxPages: 20, pageSize: 200 });
  if (Array.isArray(res.data)) res.data.forEach(_normalizeAdRefs);
  return res;
}

// Alias deprecado — código antiguo puede importarlo, lo redirigimos.
async function fetchAllAds(accId, token) {
  return fetchAdsForJoin(accId, token);
}

// Caption + miniatura del post de IG promocionado (boosted).
// Cuando el creative no trae body/thumbnail, traemos el media via Graph
// API. Cache 24h porque el caption no cambia y la URL del thumbnail
// es estable. Cache key bump: ig_media: (antes ig_caption).
async function _fetchIgMedia(igMediaId, token) {
  if (!igMediaId || !token) return null;
  const cacheKey = `ig_media:${igMediaId}`;
  const cached = await metaCache.get(cacheKey).catch(() => null);
  if (cached?.payload) return cached.payload;
  const r = await graphGet(igMediaId, {
    fields: 'caption,permalink,media_type,media_url,thumbnail_url',
  }, token);
  if (!r.ok) return null;
  const payload = {
    caption: r.json?.caption || null,
    permalink: r.json?.permalink || null,
    // Para REELS, thumbnail_url es el frame de portada; media_url es el video.
    // Para IMAGEs, media_url es la imagen.
    thumbnail: r.json?.thumbnail_url || (r.json?.media_type === 'IMAGE' ? r.json?.media_url : null),
  };
  await metaCache.putJson(cacheKey, payload, 24 * 3600).catch(() => {});
  return payload;
}

// displayName legible para campaña/ad. Prioridad:
//   1. Sufijo después de "Publicación de Instagram:" (caso boosted con nombre custom)
//   2. Primera línea no vacía del caption del IG media asociado
//   3. Body del creative (si fue diseñado)
//   4. Nombre crudo como último recurso (incluso "Publicación de Instagram" suelto)
function _computeDisplayName(rawName, igCaption, creativeBody) {
  // Caso boosted: "Publicación de Instagram: Mi sucursal nueva" → "Mi sucursal nueva"
  if (rawName) {
    const m = rawName.match(/^Publicaci[oó]n de Instagram\s*[:\-—]\s*(.+)$/i);
    if (m && m[1] && m[1].trim()) return m[1].trim();
  }
  // Si el caption tiene texto, primera línea (max 100 chars).
  if (igCaption) {
    const first = igCaption.split('\n').map((s) => s.trim()).find(Boolean);
    if (first) return first.slice(0, 100);
  }
  // Body del creative diseñado (no captions de IG).
  if (creativeBody) {
    const first = creativeBody.split('\n').map((s) => s.trim()).find(Boolean);
    if (first) return first.slice(0, 100);
  }
  return rawName || '(sin nombre)';
}

// URL al manager de Meta Ads para la campaña — escape-hatch para que
// el dueño nunca quede atrapado en el panel.
function _buildAdsManagerUrl(accId, campaignId) {
  if (!accId || !campaignId) return null;
  const accNum = String(accId).replace(/^act_/, '');
  return `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${accNum}&selected_campaign_ids=${campaignId}`;
}

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
  // VERSION BUMP cuando cambie el shape: v6 cambia el fetch de ads
  // a fields livianos (sin insights/object_story_spec anidado) — esto
  // arregla el bug donde Meta truncaba la respuesta y c.ads quedaba
  // [] en todas las campañas. Ad-level insights ya no se traen
  // (preservan métricas a nivel campaña/adset que sí están en su query).
  const cacheKey = `ads_dashboard:v6:${accId}`;
  // INVALIDAR _cacheMem si la versión cambió. ANTES solo chequeaba
  // accId — si el server estaba caliente con v4 y bumpeamos a v5,
  // seguía sirviendo v4 hasta que pasaran 15 min de TTL.
  if (_cacheMem.cacheKey && _cacheMem.cacheKey !== cacheKey) {
    _cacheMem = { ts: 0, payload: null, accId: null, cacheKey: null };
  }
  if (_cacheMem.accId && _cacheMem.accId !== accId) _cacheMem = { ts: 0, payload: null, accId: null, cacheKey: null };
  const now = Date.now();
  if (!refresh && _cacheMem.payload && now - _cacheMem.ts < CACHE_TTL_SEC * 1000) {
    return { ...(_cacheMem.payload), cached: true, cache_source: 'memory', cache_age_sec: Math.floor((now - _cacheMem.ts) / 1000) };
  }
  if (!refresh) {
    const dbCached = await metaCache.get(cacheKey).catch(() => null);
    if (dbCached) {
      _cacheMem = { ts: new Date(dbCached.ts).getTime(), payload: dbCached.payload, accId, cacheKey };
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

  // 2) Campañas, adsets, ads — TODOS paginados.
  // ANTES: /campaigns con limit:200 y /adsets con limit:500 sin paginar
  // se perdían entidades cuando la cuenta crecía. Con esos faltantes,
  // los ads cuyo adset_id/campaign_id ya no estaba quedaban huérfanos
  // → "0 ads" en el panel aunque /ads sí los trajo.
  const campsRes = await _paginate(`${accId}/campaigns`, {
    fields: 'id,name,objective,status,effective_status,daily_budget,lifetime_budget,start_time,stop_time,buying_type,'
      + 'insights.date_preset(last_30d){' + INSIGHTS_FIELDS.join(',') + '}',
  }, token);
  if (!campsRes.ok && campsRes.data.length === 0) {
    return {
      ok: false, status: 'graph_error', stage: 'campaigns',
      error: campsRes.errors[0]?.message || 'campañas no se pudieron traer',
    };
  }
  const adsetsRes = await _paginate(`${accId}/adsets`, {
    fields: 'id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,start_time,end_time,targeting,'
      + 'insights.date_preset(last_30d){' + INSIGHTS_FIELDS.join(',') + '}',
  }, token);
  // CRÍTICO — usar EXACTAMENTE el mismo fetch que /_debug/ads (probado
  // que trae los 504 ads). El antiguo ADS_FIELDS con insights+object_story_spec
  // anidado hacía que Meta truncara la respuesta → data:[] → 0 ads en
  // 176 campañas. La métricas de campaña vienen del fetch de /campaigns
  // (que sí tiene insights por campaña agregados); el ad-level insights
  // queda pendiente para una iteración futura si hace falta.
  const adsRes = await fetchAdsForJoin(accId, token);

  if (adsetsRes.errors.length) console.warn('[meta.ads] adsets paginate errors:', adsetsRes.errors);
  if (adsRes.errors.length)    console.warn('[meta.ads] ads paginate errors:',    adsRes.errors);
  console.log('[meta.ads] fetched: campaigns=', campsRes.data.length, '(p=' + campsRes.pages + ')',
              'adsets=', adsetsRes.data.length, '(p=' + adsetsRes.pages + ')',
              'ads=', adsRes.data.length, '(p=' + adsRes.pages + ')');

  // Indexar — TODOS los IDs normalizados a String() para evitar el bug
  // clásico de Meta API: a veces devuelve numéricos, a veces strings, y
  // Map.get(123) !== Map.get("123"). Defensa universal: stringify
  // en set/get.
  const sid = (v) => v == null ? null : String(v);
  const campsById  = new Map();
  for (const c of campsRes.data) campsById.set(sid(c.id), c);
  const adsetsById = new Map();
  for (const s of adsetsRes.data) adsetsById.set(sid(s.id), s);

  const adsetsByCampaign = new Map();
  for (const s of adsetsRes.data) {
    const k = sid(s.campaign_id);
    if (!adsetsByCampaign.has(k)) adsetsByCampaign.set(k, []);
    adsetsByCampaign.get(k).push(s);
  }
  const adsByAdset = new Map();
  const adsByCampaign = new Map();
  let ghostAdsetCount = 0, ghostCampaignCount = 0;
  for (const a of adsRes.data) {
    const adsetIdStr = sid(a.adset_id);
    const campIdStr  = sid(a.campaign_id);
    // Ghost adset si el ad referencia un adset no traído.
    if (adsetIdStr && !adsetsById.has(adsetIdStr)) {
      const ghostAdset = {
        id: adsetIdStr, name: '(adset ' + adsetIdStr.slice(-6) + ')',
        campaign_id: campIdStr, status: 'UNKNOWN', effective_status: 'UNKNOWN',
        daily_budget: 0, lifetime_budget: 0,
        _ghost: true,
      };
      adsetsById.set(adsetIdStr, ghostAdset);
      if (!adsetsByCampaign.has(campIdStr)) adsetsByCampaign.set(campIdStr, []);
      adsetsByCampaign.get(campIdStr).push(ghostAdset);
      ghostAdsetCount++;
    }
    if (campIdStr && !campsById.has(campIdStr)) {
      const ghostCamp = {
        id: campIdStr, name: '(campaña ' + campIdStr.slice(-6) + ')',
        objective: null, status: 'UNKNOWN', effective_status: 'UNKNOWN',
        _ghost: true,
      };
      campsById.set(campIdStr, ghostCamp);
      ghostCampaignCount++;
    }
    if (adsetIdStr) {
      if (!adsByAdset.has(adsetIdStr)) adsByAdset.set(adsetIdStr, []);
      adsByAdset.get(adsetIdStr).push(a);
    }
    if (campIdStr) {
      if (!adsByCampaign.has(campIdStr)) adsByCampaign.set(campIdStr, []);
      adsByCampaign.get(campIdStr).push(a);
    }
  }
  if (ghostAdsetCount || ghostCampaignCount) {
    console.warn('[meta.ads] ghost entities — adsets:', ghostAdsetCount, 'campaigns:', ghostCampaignCount);
  }
  console.log('[meta.ads] indexed: campsById=', campsById.size,
              'adsetsById=', adsetsById.size,
              'adsByCampaign=', adsByCampaign.size, 'total ads=', adsRes.data.length);

  // El array final de campañas a recorrer = todas las conocidas + ghosts.
  const allCampaignsList = Array.from(campsById.values());
  // Compat con el resto del builder.
  const camps = { ok: true, json: { data: allCampaignsList } };
  const ads = { ok: true, json: { data: adsRes.data } };

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
  // CRÍTICO: TODOS los lookups usan sid() (String) para evitar el bug
  // de type mismatch (números vs strings de Meta).
  const campaigns = (camps.json?.data || []).map((c) => {
    const cIdStr = sid(c.id);
    const cIns = _extractIns(c);
    const cAdsets = (adsetsByCampaign.get(cIdStr) || []).map((s) => {
      const sIdStr = sid(s.id);
      const sIns = _extractIns(s);
      const sAds = (adsByAdset.get(sIdStr) || []).map((a) => ({
        id: sid(a.id),
        name: a.name,
        status: a.status,
        effective_status: a.effective_status,
        adset_id: sid(a.adset_id),
        campaign_id: sid(a.campaign_id),
        creative: _normCreative(a.creative),
        insights: _extractIns(a),
      }));
      return {
        id: sIdStr, name: s.name,
        status: s.status, effective_status: s.effective_status,
        campaign_id: sid(s.campaign_id),
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
    // FLAT ads de la campaña (los crudos, no los pasados por _normCreative)
    // — fuente única de verdad para el conteo y la búsqueda de thumbnail.
    // Si por algún motivo el agrupamiento por adset perdió uno, este flat
    // lo recupera (lookup por campaign_id directo).
    const adsCampRaw = adsByCampaign.get(cIdStr) || [];
    // Construir array flat normalizado para el frontend.
    const adsFlat = adsCampRaw.map((a) => ({
      id: sid(a.id),
      name: a.name,
      status: a.status,
      effective_status: a.effective_status,
      adset_id: sid(a.adset_id),
      campaign_id: sid(a.campaign_id),
      creative: _normCreative(a.creative),
      insights: _extractIns(a),
    }));
    // Thumbnail del primer ad con creative que tenga imagen.
    let primaryThumbnail = null;
    for (const a of adsFlat) {
      const cr = a.creative;
      if (cr?.thumbnail_url || cr?.image_url) {
        primaryThumbnail = cr.thumbnail_url || cr.image_url;
        break;
      }
    }
    return {
      id: cIdStr, name: c.name,
      objective: c.objective,
      status: c.status, effective_status: c.effective_status,
      budget: campBudget,
      effective_budget: effectiveBudget,
      primary_thumbnail: primaryThumbnail,
      buying_type: c.buying_type,
      start_time: c.start_time, stop_time: c.stop_time,
      adsets: cAdsets,
      ads: adsFlat,                       // ← flat de TODOS los ads de la campaña
      n_adsets: cAdsets.length,
      n_ads: adsFlat.length,              // ← cuenta REAL del flat, no del agrupamiento por adset
      insights: cIns,
    };
  });

  // Enriquecer ads con caption + miniatura del post de IG. Necesario
  // tanto si falta body como si falta thumbnail — la imagen fbcdn del
  // creative a veces da 403 (token expirado del CDN) pero la del IG
  // media siempre funciona si tenemos permisos.
  const missingMediaIds = new Set();
  for (const c of campaigns) {
    for (const a of c.ads || []) {
      if (a.creative?.ig_media_id) {
        const needsBody = !a.creative.body;
        const needsThumb = !a.creative.thumbnail_url && !a.creative.image_url;
        if (needsBody || needsThumb) missingMediaIds.add(a.creative.ig_media_id);
      }
    }
  }
  const mediaMap = new Map();
  if (missingMediaIds.size > 0) {
    const ids = Array.from(missingMediaIds);
    for (let i = 0; i < ids.length; i += 5) {
      const chunk = ids.slice(i, i + 5);
      const results = await Promise.all(chunk.map((id) => _fetchIgMedia(id, token).then((r) => [id, r])));
      for (const [id, r] of results) if (r) mediaMap.set(id, r);
    }
    // Aplicar a cada ad (flat) Y a los del árbol por adset (creatives
    // pueden ser el mismo objeto pero por defensa recorremos ambos).
    const applyMedia = (a) => {
      if (!a.creative?.ig_media_id) return;
      const m = mediaMap.get(a.creative.ig_media_id);
      if (!m) return;
      if (!a.creative.body && m.caption) a.creative.ig_caption = m.caption;
      if (!a.creative.post_permalink && m.permalink) a.creative.post_permalink = m.permalink;
      if (m.thumbnail) a.creative.ig_thumbnail = m.thumbnail; // fallback de imagen
    };
    for (const c of campaigns) {
      for (const a of c.ads || []) applyMedia(a);
      for (const s of c.adsets) for (const a of s.ads) applyMedia(a);
    }
  }

  // Computar display_name + ads_manager_url + primary_thumbnail con
  // escalera (fbcdn → ig media) a nivel CAMPAÑA. La escalera frontend
  // termina de cubrir con "↗ Ver en Instagram" si todo falla.
  for (const c of campaigns) {
    // Tomar el primer ad con creative — fuente de identidad de la campaña.
    const firstAd = (c.ads || []).find((a) => a.creative) || null;
    const cr = firstAd?.creative || null;
    const igCaption = cr?.ig_caption || null;
    const body = cr?.body || null;
    c.display_name = _computeDisplayName(c.name, igCaption, body);
    c.ads_manager_url = _buildAdsManagerUrl(accId, c.id);
    // primary_thumbnail con escalera (la del frontend pasa por proxy).
    if (cr) {
      c.primary_thumbnail = cr.thumbnail_url || cr.image_url || cr.ig_thumbnail || null;
    }
    c.primary_permalink = cr?.post_permalink || null;
    // Repetir el cálculo para cada ad flat (frontend lo usa en drill-down + modal).
    for (const a of c.ads || []) {
      if (a.creative) {
        a.display_name = _computeDisplayName(a.name, a.creative.ig_caption, a.creative.body);
        a.thumbnail_resolved = a.creative.thumbnail_url || a.creative.image_url || a.creative.ig_thumbnail || null;
      } else {
        a.display_name = a.name;
        a.thumbnail_resolved = null;
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

  // Clasificación REAL de Activas — la fuente de verdad NO es solo
  // effective_status (que incluye status del adset/cuenta heredado),
  // sino DELIVERY real: ¿está entregando ahora?
  //   is_delivering = effective_status === 'ACTIVE' AND status === 'ACTIVE'
  //                   AND insights con tráfico reciente (impressions>0 o spend>0 en 30d)
  // Una campaña ACTIVE pero sin un solo impression en 30d NO está
  // entregando — Meta la marca activa pero el delivery falla
  // (sin presupuesto, audiencia vacía, etc).
  for (const c of campaigns) {
    const ins = c.insights || {};
    const hasRecentDelivery = (ins.impressions || 0) > 0 || (ins.spend || 0) > 0;
    c.is_delivering = c.effective_status === 'ACTIVE'
                   && c.status === 'ACTIVE'
                   && hasRecentDelivery;
  }
  function _groupByDelivery(camps) {
    const groups = { delivering: [], paused: [], otros: [] };
    for (const c of camps) {
      if (c.is_delivering) groups.delivering.push(c);
      else if (c.effective_status === 'PAUSED' || c.status === 'PAUSED') groups.paused.push(c);
      else groups.otros.push(c);  // ACTIVE sin delivery, ARCHIVED, etc.
    }
    for (const k of Object.keys(groups)) groups[k].sort((a, b) => b.insights.spend - a.insights.spend);
    return groups;
  }
  const groups = _groupByDelivery(campaigns);

  // Top mejores / peores SOLO entre las que ENTREGAN. No tiene sentido
  // recomendar escalar una pausada o una sin delivery — el dueño quedó
  // claro con eso.
  const deliveringWithSpend = groups.delivering.filter((c) => c.insights.spend > 0);
  const top = deliveringWithSpend.filter((c) => c.verdict.kind === 'escalar').slice(0, 5);
  const bottom = deliveringWithSpend.filter((c) => c.verdict.kind === 'pausar' || c.verdict.kind === 'optimizar')
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
      // 'active' = entregando (effective+status ACTIVE + delivery real).
      // Mantengo el nombre `active` para compat con frontend, pero el
      // count ahora coincide con Meta Ads Manager.
      active:  { count: groups.delivering.length, spend: groups.delivering.reduce((s, c) => s + c.insights.spend, 0), campaigns: groups.delivering },
      paused:  { count: groups.paused.length,     spend: groups.paused.reduce((s, c) => s + c.insights.spend, 0),     campaigns: groups.paused },
      otros:   { count: groups.otros.length,      spend: groups.otros.reduce((s, c) => s + c.insights.spend, 0),      campaigns: groups.otros },
    },
    campaigns,          // mantengo flat para compat con frontend viejo
    recommendations: { top, bottom },
    fetched_at: new Date().toISOString(),
  };
  _cacheMem = { ts: Date.now(), payload, accId, cacheKey };
  await metaCache.putJson(cacheKey, payload, CACHE_TTL_SEC).catch(() => {});
  return { ...payload, cached: false };
}

function invalidateAdsCache() {
  _cacheMem = { ts: 0, payload: null, accId: null, cacheKey: null };
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

// Gasto por día (time_increment=1). Devuelve serie [{date, spend,
// impressions, clicks}] del rango pedido. Cache 1h por (id, días) —
// los días pasados no cambian y el día actual se refresca al expirar.
async function buildDailySpend(entityId, { days = 30, level = 'campaign' } = {}) {
  if (!['campaign', 'adset', 'ad'].includes(level)) level = 'campaign';
  const cfg = getMarketingConfig();
  if (cfg.missing.length > 0) return { ok: false, status: 'not_configured', missing_env: cfg.missing };
  const { token } = await resolveMarketingToken();
  if (!token) return { ok: false, status: 'no_token' };
  const cacheKey = `daily_spend:${level}:${entityId}:${days}d`;
  const cached = await metaCache.get(cacheKey).catch(() => null);
  if (cached?.payload) return { ...cached.payload, cached: true };
  const r = await graphGet(`${entityId}/insights`, {
    fields: 'date_start,date_stop,spend,impressions,clicks,reach',
    time_increment: 1,
    date_preset: days === 7 ? 'last_7d' : (days === 60 ? 'last_60d' : (days === 90 ? 'last_90d' : 'last_30d')),
  }, token);
  if (!r.ok) {
    return { ok: false, error: r.json?.error?.message || `HTTP ${r.status}` };
  }
  const rows = (r.json?.data || []).map((d) => ({
    date: d.date_start,
    spend: Number(d.spend || 0),
    impressions: Number(d.impressions || 0),
    clicks: Number(d.clicks || 0),
    reach: Number(d.reach || 0),
  })).sort((a, b) => a.date.localeCompare(b.date));
  const totalSpend = rows.reduce((s, x) => s + x.spend, 0);
  const daysWithSpend = rows.filter((x) => x.spend > 0).length;
  const daysZero = rows.filter((x) => x.spend === 0).length;
  const payload = {
    ok: true,
    entity_id: entityId,
    level,
    days,
    rows,
    total_spend: totalSpend,
    days_with_spend: daysWithSpend,
    days_zero: daysZero,
    fetched_at: new Date().toISOString(),
  };
  await metaCache.putJson(cacheKey, payload, 3600).catch(() => {});
  return payload;
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
  buildDailySpend,
  setEntityStatus,
  setEntityBudget,
  invalidateAdsCache,
  fetchAdsForJoin,  // expuesto para /_debug/ads (única fuente de verdad)
};
