// Parte 2 — Targeting de adsets, en lenguaje claro.
//
// Trae el `targeting` completo del adset + lo normaliza para que el
// frontend pueda renderizar SIN inventar nada. Si la API no devuelve
// algo (intereses, placements), se muestra tal cual ("Todos" o "—").
//
// Cache 6h en ab_meta_cache (la segmentación cambia rara vez).

const { getMarketingConfig, resolveMarketingToken, graphGet, graphPost } = require('./client');
const metaCache = require('./cache');

const TARGETING_FIELDS =
  'name,optimization_goal,billing_event,bid_strategy,' +
  'targeting{geo_locations{countries,regions,cities,custom_locations,location_types,zips,geo_markets},'
    + 'excluded_geo_locations{countries,regions,cities},'
    + 'age_min,age_max,genders,'
    + 'flexible_spec,exclusions,'
    + 'publisher_platforms,facebook_positions,instagram_positions,messenger_positions,audience_network_positions,'
    + 'device_platforms,user_os,user_device,'
    + 'locales,'
    + 'targeting_relaxation_types}';

// Traducciones a español de placements.
const PLATFORM_LABEL = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  audience_network: 'Audience Network',
  messenger: 'Messenger',
  threads: 'Threads',
};
const POSITION_LABEL_FB = {
  feed: 'Feed', right_hand_column: 'Columna derecha', marketplace: 'Marketplace',
  video_feeds: 'Feeds de video', story: 'Stories', search: 'Búsqueda',
  instream_video: 'Video in-stream', facebook_reels: 'Reels',
  facebook_reels_overlay: 'Reels (overlay)',
};
const POSITION_LABEL_IG = {
  stream: 'Feed', story: 'Stories', explore: 'Explorar', explore_home: 'Explorar (inicio)',
  reels: 'Reels', shop: 'Tienda', profile_feed: 'Feed del perfil',
  ig_search: 'Búsqueda', profile_reels: 'Reels del perfil',
};
const POSITION_LABEL_MSG = { story: 'Stories', messenger_home: 'Mensajes' };
const POSITION_LABEL_AN  = { classic: 'Display', rewarded_video: 'Video recompensado' };

function _genderLabel(genders) {
  if (!genders || !Array.isArray(genders) || genders.length === 0) return 'Todos';
  const s = new Set(genders.map(String));
  if (s.has('1') && s.has('2')) return 'Todos';
  if (s.has('1')) return 'Hombres';
  if (s.has('2')) return 'Mujeres';
  return 'Todos';
}

function _placements(t) {
  if (!t) return null;
  const pp = t.publisher_platforms || [];
  if (!pp.length) return { all: true, list: [] };
  const out = [];
  for (const p of pp) {
    const label = PLATFORM_LABEL[p] || p;
    let positions = null;
    if (p === 'facebook' && t.facebook_positions) {
      positions = t.facebook_positions.map((x) => POSITION_LABEL_FB[x] || x);
    } else if (p === 'instagram' && t.instagram_positions) {
      positions = t.instagram_positions.map((x) => POSITION_LABEL_IG[x] || x);
    } else if (p === 'messenger' && t.messenger_positions) {
      positions = t.messenger_positions.map((x) => POSITION_LABEL_MSG[x] || x);
    } else if (p === 'audience_network' && t.audience_network_positions) {
      positions = t.audience_network_positions.map((x) => POSITION_LABEL_AN[x] || x);
    }
    out.push({ platform: p, label, positions });
  }
  return { all: false, list: out };
}

function _radius(loc) {
  if (!loc) return null;
  // custom_locations: [{ latitude, longitude, radius, distance_unit, name? }]
  if (Array.isArray(loc.custom_locations) && loc.custom_locations.length) {
    return loc.custom_locations.map((x) => ({
      lat: x.latitude, lng: x.longitude,
      radius: x.radius, unit: x.distance_unit || 'kilometer',
      name: x.name || (`${Number(x.latitude).toFixed(3)}, ${Number(x.longitude).toFixed(3)}`),
    }));
  }
  return null;
}

function _flexSpec(arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  // Cada item: { interests: [{id,name}], behaviors: [...], demographics: [...]}
  return arr.map((spec) => {
    const buckets = {};
    for (const k of ['interests', 'behaviors', 'demographics', 'work_positions', 'work_employers']) {
      if (Array.isArray(spec[k]) && spec[k].length) {
        buckets[k] = spec[k].map((x) => x.name || x.id);
      }
    }
    return buckets;
  });
}

// Resumen normalizado para el frontend (no inventa nada).
function normalizeTargeting(raw) {
  const t = raw?.targeting || {};
  const g = t.geo_locations || {};
  const ex = t.excluded_geo_locations || {};
  const placements = _placements(t);
  return {
    optimization_goal: raw?.optimization_goal || null,
    billing_event: raw?.billing_event || null,
    bid_strategy: raw?.bid_strategy || null,
    age_min: t.age_min || null,
    age_max: t.age_max || null,
    gender_label: _genderLabel(t.genders),
    genders_raw: t.genders || [],
    location: {
      countries: g.countries || [],
      regions: (g.regions || []).map((r) => r.name || r.key),
      cities:   (g.cities || []).map((c) => ({ name: c.name, key: c.key, region: c.region, distance_unit: c.distance_unit, radius: c.radius })),
      custom_locations: _radius(g),
      zips: (g.zips || []).map((z) => z.name || z.key),
      location_types: g.location_types || null,
    },
    excluded_location: {
      countries: ex.countries || [],
      regions: (ex.regions || []).map((r) => r.name || r.key),
      cities:  (ex.cities || []).map((c) => c.name || c.key),
    },
    interests_specs: _flexSpec(t.flexible_spec),
    exclusions_specs: _flexSpec(t.exclusions ? [t.exclusions] : null),
    placements,
    locales: t.locales || null,
    device_platforms: t.device_platforms || null,
    targeting_relaxation: t.targeting_relaxation_types || null,
  };
}

async function fetchAdsetTargeting(adsetId) {
  const cfg = getMarketingConfig();
  if (cfg.missing.length > 0) return { ok: false, status: 'not_configured', missing_env: cfg.missing };
  const { token } = await resolveMarketingToken();
  if (!token) return { ok: false, status: 'no_token' };
  const cacheKey = `targeting:adset:${adsetId}`;
  const cached = await metaCache.get(cacheKey).catch(() => null);
  if (cached?.payload) return { ...cached.payload, cached: true };
  const r = await graphGet(adsetId, { fields: TARGETING_FIELDS }, token);
  if (!r.ok) return { ok: false, error: r.json?.error?.message || `HTTP ${r.status}` };
  const payload = {
    ok: true,
    adset_id: adsetId,
    name: r.json?.name || null,
    summary: normalizeTargeting(r.json),
    raw: r.json?.targeting || null, // por si el frontend quiere debug
    fetched_at: new Date().toISOString(),
  };
  await metaCache.putJson(cacheKey, payload, 6 * 3600).catch(() => {});
  return payload;
}

// Glosario para tooltips (objetivo + billing event + términos).
function getGlossary() {
  return {
    optimization_goal: {
      LINK_CLICKS: 'Optimiza para conseguir clics al sitio.',
      REACH: 'Optimiza para mostrar a la mayor cantidad de personas distintas.',
      IMPRESSIONS: 'Optimiza para mostrar lo más posible (sin distinguir personas únicas).',
      POST_ENGAGEMENT: 'Optimiza para likes/comentarios/reacciones.',
      OFFSITE_CONVERSIONS: 'Optimiza para conversiones en tu sitio.',
      LANDING_PAGE_VIEWS: 'Optimiza para que la página efectivamente cargue.',
      THRUPLAY: 'Optimiza para reproducciones largas (videos).',
      VALUE: 'Optimiza por valor de compra (e-commerce).',
      QUALITY_LEAD: 'Optimiza por leads de calidad.',
      MESSAGES: 'Optimiza para conversaciones por DM.',
    },
    radio: 'Distancia (en km) alrededor de un punto. Útil para negocios físicos. Mientras menor, más enfocado; mientras mayor, más alcance pero menos relevancia.',
    placements: 'Dónde se muestra el anuncio (Feed de IG, Stories, Reels, etc.). Si Meta lo elige automáticamente, dice "Automático" — suele ser lo más barato porque el algoritmo distribuye donde rinde mejor.',
    aprendizaje: 'Tras crear o cambiar mucho un anuncio, Meta entra en "fase de aprendizaje" — los primeros días los resultados son inestables hasta que junta datos.',
  };
}

// ─── Parte 3: rendimiento por región/provincia ──────────────────────
// Meta SOLO expone breakdowns por país y región (provincia). NO por
// ciudad puntual dentro de un radio. Si el adset apunta a un radio
// con varias ciudades, el corte más fino disponible es region.
// El frontend debe mostrar este disclaimer.
async function fetchInsightsByRegion(entityId, { days = 30, level = 'adset', dim = 'region' } = {}) {
  const cfg = getMarketingConfig();
  if (cfg.missing.length > 0) return { ok: false, status: 'not_configured', missing_env: cfg.missing };
  const { token } = await resolveMarketingToken();
  if (!token) return { ok: false, status: 'no_token' };
  if (!['region', 'country', 'dma'].includes(dim)) dim = 'region';
  const cacheKey = `region_perf:${level}:${entityId}:${dim}:${days}d`;
  const cached = await metaCache.get(cacheKey).catch(() => null);
  if (cached?.payload) return { ...cached.payload, cached: true };

  const datePreset = days === 7 ? 'last_7d' : (days === 60 ? 'last_60d' : (days === 90 ? 'last_90d' : 'last_30d'));
  const r = await graphGet(`${entityId}/insights`, {
    fields: 'spend,impressions,clicks,reach,ctr,cpc,actions',
    breakdowns: dim,
    date_preset: datePreset,
  }, token);
  if (!r.ok) {
    return {
      ok: false,
      error: r.json?.error?.message || `HTTP ${r.status}`,
      hint: 'Verificá que el adset tenga delivery en el período pedido. Meta solo expone breakdowns por región — NO por ciudad puntual dentro de un radio.',
    };
  }
  const rows = (r.json?.data || []).map((d) => {
    const actions = Array.isArray(d.actions) ? d.actions : [];
    const order = ['lead', 'purchase', 'omni_purchase', 'link_click', 'post_engagement'];
    let results = 0, resultType = null;
    for (const k of order) {
      const a = actions.find((x) => x.action_type === k);
      if (a) { results = Number(a.value) || 0; resultType = k; break; }
    }
    return {
      region: d[dim] || '—',
      spend: Number(d.spend || 0),
      impressions: Number(d.impressions || 0),
      clicks: Number(d.clicks || 0),
      reach: Number(d.reach || 0),
      ctr: d.ctr != null ? Number(d.ctr) / 100 : null,
      cpc: d.cpc != null ? Number(d.cpc) : null,
      results, result_type: resultType,
    };
  }).sort((a, b) => b.spend - a.spend);

  // Calcular promedios para colorear mejor/peor (relativo al adset, no a la cuenta).
  const withSpend = rows.filter((r) => r.spend > 0);
  const avgCtr = withSpend.length ? withSpend.reduce((s, r) => s + (r.ctr || 0), 0) / withSpend.length : 0;
  const avgCpc = withSpend.length && withSpend.some((r) => r.cpc != null) ? withSpend.reduce((s, r) => s + (r.cpc || 0), 0) / withSpend.filter((r) => r.cpc != null).length : 0;

  const payload = {
    ok: true,
    entity_id: entityId,
    level,
    breakdown: dim,
    days,
    rows,
    averages: { ctr: avgCtr, cpc: avgCpc },
    n_regions: rows.length,
    total_spend: rows.reduce((s, r) => s + r.spend, 0),
    disclaimer: 'Meta solo expone desglose por región/provincia. Si el adset apunta a un radio con varias ciudades, ESTE es el corte más fino disponible — no hay datos por ciudad puntual.',
    fetched_at: new Date().toISOString(),
  };
  await metaCache.putJson(cacheKey, payload, 3600).catch(() => {});
  return payload;
}

module.exports = { fetchAdsetTargeting, normalizeTargeting, fetchInsightsByRegion, getGlossary, TARGETING_FIELDS };
