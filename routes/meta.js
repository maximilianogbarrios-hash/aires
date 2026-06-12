// /api/v1/meta/* — Módulo Meta Ads (F1: Instagram orgánico + tokens).
//
// Role gating: meta_ads_view para lectura, meta_ads_admin para mutaciones
// (cargar/borrar token). Ambos = admin + socio (Maxi + Dani).
//
// Sin defaults SmartBuy. Todas las credenciales se leen de env vars
// de Aires; si faltan, /config-status reporta qué configurar y los
// demás endpoints devuelven status 'not_configured'.

const express = require('express');
const { requireAuth, requirePerm } = require('../lib/auth');
const {
  getInstagramConfig, getMarketingConfig,
  resolveInstagramToken, resolveMarketingToken,
  graphPost, probeToken,
} = require('../lib/meta/client');
const { getToken, putToken, clearToken, tokenStatus } = require('../lib/meta/tokens');
const { buildInstagramDashboard, invalidateCache } = require('../lib/meta/instagram');
const {
  buildAdsDashboard, buildCampaignDetail, setEntityStatus, setEntityBudget,
  invalidateAdsCache,
} = require('../lib/meta/ads');
const aiMod = require('../lib/meta/ai');
const backupMod = require('../lib/meta/backup');
const glossary = require('../lib/meta/glossary');
const metaCache = require('../lib/meta/cache');
const { isKeyAvailable } = require('../lib/meta/crypto');

const router = express.Router();
router.use(requireAuth);
router.use(requirePerm('meta_ads_view'));

// ─── Glosario de métricas ─────────────────────────────────────────────
// Diccionario único reusable. Frontend lo carga 1 vez al boot y muestra
// tooltips por cada métrica. Centralizado para editar redacción sin
// tocar el HTML.
router.get('/glossary', (req, res) => {
  res.json({ ok: true, ...glossary.all() });
});

// ─── Proxy de miniaturas de Instagram / Facebook Ads ─────────────────
// scontent.cdninstagram.com / *.fbcdn.net bloquean hotlink desde otros
// dominios. El browser nunca puede cargar media_url/thumbnail_url
// directo. Este proxy hace el fetch server-side y stream-ea con cache 1h.
//
// Whitelist por sufijo de hostname (NO regex laxa — evita SSRF):
//   - cdninstagram.com (IG orgánico)
//   - fbcdn.net (creativos de ads + Facebook CDN, incluye
//     scontent-*.xx.fbcdn.net y external-*.xx.fbcdn.net)
// Sin token aquí — las URLs ya vienen firmadas por Meta. Solo el rol
// (meta_ads_view) gatea el acceso.
const _THUMB_ALLOWED_SUFFIXES = ['.cdninstagram.com', '.fbcdn.net', '.facebook.com'];
function _isAllowedThumbHost(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return _THUMB_ALLOWED_SUFFIXES.some((s) => host === s.slice(1) || host.endsWith(s));
  } catch { return false; }
}
// Placeholder SVG 1×1 gris para fallback silencioso (mejor que broken image).
const _PLACEHOLDER_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" fill="#e7e5e4"/><text x="50%" y="55%" text-anchor="middle" font-family="sans-serif" font-size="9" fill="#a8a29e">sin img</text></svg>',
  'utf8'
);
function _servePlaceholder(res, reason) {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=300');
  if (reason) res.setHeader('X-Proxy-Fallback', reason);
  res.end(_PLACEHOLDER_SVG);
}

router.get('/media-thumb', async (req, res) => {
  try {
    const url = String(req.query.url || '').trim();
    if (!url) return _servePlaceholder(res, 'no-url');
    if (!_isAllowedThumbHost(url)) {
      console.warn('[meta.media-thumb] host bloqueado:', url.slice(0, 120));
      return _servePlaceholder(res, 'host-not-allowed');
    }
    const cacheKey = 'thumb:' + Buffer.from(url).toString('base64').slice(0, 200);
    const cached = await metaCache.get(cacheKey, 'binary').catch(() => null);
    if (cached?.buffer) {
      res.setHeader('Content-Type', cached.content_type);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.setHeader('X-Proxy-Cache', 'HIT');
      return res.end(cached.buffer);
    }
    let r;
    try {
      r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; AiresAdsProxy/1.0)' } });
    } catch (e) {
      console.warn('[meta.media-thumb] fetch fail:', e.message, 'url=', url.slice(0, 120));
      return _servePlaceholder(res, 'fetch-error');
    }
    if (!r.ok) {
      console.warn('[meta.media-thumb] upstream', r.status, 'url=', url.slice(0, 120));
      return _servePlaceholder(res, 'upstream-' + r.status);
    }
    const contentType = r.headers.get('content-type') || 'image/jpeg';
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length === 0) return _servePlaceholder(res, 'empty-body');
    await metaCache.putBinary(cacheKey, buf, contentType, 3600).catch(() => {});
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('X-Proxy-Cache', 'MISS');
    res.end(buf);
  } catch (e) {
    console.error('[meta.media-thumb] internal:', e.message);
    _servePlaceholder(res, 'internal');
  }
});

// ─── DEBUG: traer los ads crudos para diagnosticar 0-ads bug ─────────
// Llama la query EXACTA confirmada en Graph Explorer y reporta qué
// vuelve del server (token usado, count, sample, errores). NO es un
// endpoint normal — solo para diagnosticar. Role-gated igual que el
// resto del módulo.
router.get('/_debug/ads', async (req, res) => {
  try {
    const cfg = require('../lib/meta/client').getMarketingConfig();
    if (cfg.missing.length > 0) {
      return res.json({ ok: false, stage: 'env', missing: cfg.missing });
    }
    const accId = cfg.values.META_AD_ACCOUNT_ID;
    const { resolveMarketingToken, graphGet } = require('../lib/meta/client');
    const { token, source: tokenSource } = await resolveMarketingToken();
    if (!token) {
      return res.json({ ok: false, stage: 'token', message: 'sin token' });
    }
    // Query EXACTA del prompt — la confirmada en Graph Explorer.
    // Primera página con limit:50 + sample.
    const fields = 'name,effective_status,adset_id,campaign_id,creative{thumbnail_url,image_url,body,title,effective_instagram_media_id,instagram_permalink_url,id}';
    const r = await graphGet(`${accId}/ads`, { fields, limit: 100 }, token);
    const errors = [];
    if (!r.ok) errors.push({ stage: 'first_page', status: r.status, message: r.json?.error?.message || `HTTP ${r.status}` });
    let all = Array.isArray(r.json?.data) ? r.json.data : [];
    let nextUrl = r.json?.paging?.next || null;
    let pages = r.ok ? 1 : 0;
    const maxPages = 20; // 20 × 100 = 2000 ads max en el debug
    while (nextUrl && pages < maxPages) {
      try {
        const nr = await fetch(nextUrl);
        if (!nr.ok) { errors.push({ stage: 'pagination', page: pages + 1, status: nr.status }); break; }
        const nj = await nr.json();
        if (nj?.error) { errors.push({ stage: 'pagination', page: pages + 1, message: nj.error.message }); break; }
        if (Array.isArray(nj?.data)) all.push(...nj.data);
        nextUrl = nj?.paging?.next || null;
        pages++;
      } catch (e) { errors.push({ stage: 'pagination', page: pages + 1, message: e.message }); break; }
    }
    const truncated = !!nextUrl;
    const sample = all.slice(0, 5).map((a) => {
      const cr = a.creative || null;
      const thumb = cr?.thumbnail_url || cr?.image_url || null;
      return {
        id: a.id, name: a.name, effective_status: a.effective_status,
        adset_id: a.adset_id, campaign_id: a.campaign_id,
        creative: cr ? {
          id: cr.id,
          thumbnail_url: cr.thumbnail_url,
          image_url: cr.image_url,
          body: cr.body,
          title: cr.title,
          effective_instagram_media_id: cr.effective_instagram_media_id,
          instagram_permalink_url: cr.instagram_permalink_url,
        } : null,
        // URL proxyada para que el user pueda abrirla y ver si la imagen carga.
        thumbnail_proxied: thumb ? '/api/v1/meta/media-thumb?url=' + encodeURIComponent(thumb) : null,
        thumbnail_raw: thumb,
      };
    });
    const countByStatus = all.reduce((m, a) => { m[a.effective_status || 'UNKNOWN'] = (m[a.effective_status || 'UNKNOWN'] || 0) + 1; return m; }, {});
    const adsByAdset = all.reduce((m, a) => { m[a.adset_id || 'NO_ADSET_ID'] = (m[a.adset_id || 'NO_ADSET_ID'] || 0) + 1; return m; }, {});
    const adsByCamp  = all.reduce((m, a) => { m[a.campaign_id || 'NO_CAMP_ID'] = (m[a.campaign_id || 'NO_CAMP_ID'] || 0) + 1; return m; }, {});
    console.log('[meta._debug/ads] count=' + all.length + ' pages=' + pages + ' token=' + tokenSource);

    // sample_ad_keys: las keys reales del primer ad — confirma si
    // adset_id/campaign_id llegan planos o anidados. Sin esto adivinamos.
    const sampleAdKeys = all.length > 0 ? Object.keys(all[0]).sort() : [];
    const firstAdRaw = all.length > 0 ? all[0] : null;

    // GROUPING CHECK — ejecuta el agrupado REAL del panel y verifica
    // contra los IDs determinísticos del prompt.
    const TARGET_CAMP = '6988700632040';
    const TARGET_ADSET = '6988700632072';
    const TARGET_AD = '6988700711672';
    let groupingCheck;
    try {
      const { buildAdsDashboard } = require('../lib/meta/ads');
      const dash = await buildAdsDashboard({ refresh: true });
      if (!dash.ok) {
        groupingCheck = { ok: false, status: dash.status, error: dash.error || dash.message };
      } else {
        const camp = (dash.campaigns || []).find((c) => String(c.id) === TARGET_CAMP);
        if (!camp) {
          groupingCheck = {
            ok: false,
            cache_version: 'ads_dashboard:v3',
            target_campaign: TARGET_CAMP,
            found: false,
            total_campaigns_in_dashboard: (dash.campaigns || []).length,
            campaign_ids_sample: (dash.campaigns || []).slice(0, 5).map((c) => c.id),
          };
        } else {
          groupingCheck = {
            ok: true,
            cache_version: 'ads_dashboard:v3',
            campaign_6988700632040: {
              found: true,
              n_ads: camp.n_ads,
              n_adsets: camp.n_adsets,
              primary_thumbnail: camp.primary_thumbnail,
              ads: (camp.ads || []).map((a) => ({
                id: a.id,
                name: a.name,
                effective_status: a.effective_status,
                adset_id: a.adset_id,
                has_thumbnail: !!(a.creative?.thumbnail_url || a.creative?.image_url),
                permalink: a.creative?.post_permalink || null,
              })),
              adsets: (camp.adsets || []).map((s) => ({
                id: s.id, name: s.name, n_ads: s.n_ads,
                effective_status: s.effective_status,
                is_ghost: !!s._ghost,
              })),
            },
            asserts: {
              campaign_has_at_least_1_ad: camp.n_ads >= 1,
              contains_target_ad: (camp.ads || []).some((a) => a.id === TARGET_AD),
              target_ad_has_thumbnail: (camp.ads || []).some((a) => a.id === TARGET_AD && !!(a.creative?.thumbnail_url || a.creative?.image_url)),
              target_adset_present_with_ads: (camp.adsets || []).some((s) => s.id === TARGET_ADSET && s.n_ads >= 1),
            },
          };
        }
      }
    } catch (e) {
      groupingCheck = { ok: false, exception: e.message };
    }

    res.json({
      ok: true,
      account_id: accId,
      token_source: tokenSource,
      token_last6: token.slice(-6),
      pages_fetched: pages,
      truncated,
      count: all.length,
      count_by_effective_status: countByStatus,
      distinct_adsets_referenced: Object.keys(adsByAdset).length,
      distinct_campaigns_referenced: Object.keys(adsByCamp).length,
      sample_ad_keys: sampleAdKeys,
      first_ad_adset_id_value: firstAdRaw?.adset_id ?? null,
      first_ad_campaign_id_value: firstAdRaw?.campaign_id ?? null,
      first_ad_has_nested_adset: !!firstAdRaw?.adset,
      first_ad_has_nested_campaign: !!firstAdRaw?.campaign,
      sample,
      grouping_check: groupingCheck,
      errors,
    });
  } catch (e) {
    console.error('[meta._debug/ads]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Estado de configuración ──────────────────────────────────────────
// Devuelve qué env vars faltan + estado del token. El frontend lo usa
// para decidir entre mostrar el dashboard o un panel "Configurá las
// credenciales de Meta en Railway".
router.get('/config-status', async (req, res) => {
  try {
    const cfg = getInstagramConfig();
    const cfgMkt = getMarketingConfig();
    const ig = await tokenStatus('ig_access_token');
    const mu = await tokenStatus('meta_user_token');
    res.json({
      ok: true,
      env_missing: cfg.missing,          // críticas F1
      env_ok: cfg.missing.length === 0,
      env_missing_marketing: cfgMkt.missing,  // críticas F2/F3
      env_ok_marketing: cfgMkt.missing.length === 0,
      ai_enabled: aiMod.isEnabled(),
      crypto_key_available: isKeyAvailable(),
      tokens: {
        ig_access_token: ig,
        meta_user_token: mu,
      },
      // Estos IDs (sin valores) solo confirman al frontend cuáles env
      // están seteadas — NO devolvemos el valor sensible.
      env_set: {
        IG_BUSINESS_ACCOUNT_ID: !!process.env.IG_BUSINESS_ACCOUNT_ID,
        FACEBOOK_PAGE_ID: !!process.env.FACEBOOK_PAGE_ID,
        META_TOKEN_KEY: isKeyAvailable(),
        INSTAGRAM_ACCESS_TOKEN: !!process.env.INSTAGRAM_ACCESS_TOKEN,
        META_AD_ACCOUNT_ID: !!process.env.META_AD_ACCOUNT_ID,  // F2/F3
        META_USER_TOKEN: !!process.env.META_USER_TOKEN,        // F2/F3
        ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,    // F3
      },
    });
  } catch (e) {
    console.error('[meta.config-status]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Health del token ─────────────────────────────────────────────────
router.get('/health', async (req, res) => {
  try {
    const { token, source } = await resolveInstagramToken();
    if (!token) {
      return res.json({ ok: false, status: 'missing', source: null,
        message: 'No hay token cargado. Cargalo en Settings o seteá INSTAGRAM_ACCESS_TOKEN.' });
    }
    const probe = await probeToken(token);
    if (!probe.ok) {
      const expired = /session has expired|access token|OAuthException|expired/i.test(String(probe.error || ''));
      return res.json({ ok: false, status: expired ? 'expired' : 'invalid', source,
        error: probe.error, message: 'El token no es válido. Generá uno nuevo y cargalo en Settings.' });
    }
    res.json({ ok: true, status: 'active', source, me: probe.me });
  } catch (e) {
    console.error('[meta.health]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Dashboard IG (KPIs + posts + reels) ──────────────────────────────
router.get('/dashboard/instagram', async (req, res) => {
  try {
    const refresh = String(req.query.refresh || '') === '1';
    const period = parseInt(req.query.period, 10) || 30;
    const data = await buildInstagramDashboard({ refresh, period });
    res.json(data);
  } catch (e) {
    console.error('[meta.dashboard.instagram]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Token management (admin/socio) ───────────────────────────────────
// Cargar token: body { token, dry_run?: bool }. Si dry_run=true, solo
// valida contra /me sin persistir.
router.post('/token', express.json({ limit: '8kb' }), requirePerm('meta_ads_admin'), async (req, res) => {
  try {
    const raw = String(req.body?.token || '').trim();
    const kind = String(req.body?.kind || 'ig_access_token');
    const dryRun = !!req.body?.dry_run;
    if (raw.length < 20) return res.status(400).json({ ok: false, error: 'token vacío o muy corto' });

    const probe = await probeToken(raw);
    if (!probe.ok) {
      return res.status(400).json({ ok: false, status: 'invalid', error: probe.error,
        message: 'Meta rechazó el token. Verificá permisos y vigencia.' });
    }
    if (dryRun) return res.json({ ok: true, dry_run: true, me: probe.me, message: 'Token válido — no fue guardado.' });

    const r = await putToken(kind, raw, req.session?.user?.email);
    invalidateCache(); // forzar refetch al próximo /dashboard
    res.json({ ok: true, status: 'saved', saved_at: r.saved_at, me: probe.me });
  } catch (e) {
    console.error('[meta.token.put]', e);
    if (e.code === 'META_TOKEN_KEY_MISSING') {
      return res.status(503).json({ ok: false, error: e.message, code: 'META_TOKEN_KEY_MISSING' });
    }
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.delete('/token', requirePerm('meta_ads_admin'), async (req, res) => {
  try {
    const kind = String(req.query.kind || 'ig_access_token');
    const r = await clearToken(kind);
    invalidateCache();
    invalidateAdsCache();
    res.json({ ok: true, deleted: r.deleted });
  } catch (e) {
    console.error('[meta.token.delete]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════
// F2 — Marketing API (lectura + acciones de status/budget)
// ════════════════════════════════════════════════════════════════════

// Lista de campañas/adsets/ads con insights last_30d. Sin defaults
// SmartBuy — si falta META_AD_ACCOUNT_ID o META_USER_TOKEN, status
// 'not_configured' / 'no_token'.
router.get('/ads', async (req, res) => {
  try {
    const refresh = String(req.query.refresh || '') === '1';
    const data = await buildAdsDashboard({ refresh });
    res.json(data);
  } catch (e) {
    console.error('[meta.ads]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/campaign/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!/^[0-9_a-zA-Z]+$/.test(id)) return res.status(400).json({ ok: false, error: 'id inválido' });
    const r = await buildCampaignDetail(id);
    res.json(r);
  } catch (e) {
    console.error('[meta.campaign]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Status: pausar/activar campaign | adset | ad.
// Body: { kind: 'campaign'|'adset'|'ad', status: 'ACTIVE'|'PAUSED'|'ARCHIVED' }
function _makeStatusEndpoint(kind) {
  return async (req, res) => {
    try {
      const id = String(req.params.id || '').trim();
      const status = String(req.body?.status || '').trim().toUpperCase();
      if (!id) return res.status(400).json({ ok: false, error: 'id requerido' });
      const r = await setEntityStatus(kind, id, status);
      if (!r.ok) return res.status(r.status === 'no_token' ? 503 : 400).json(r);
      res.json(r);
    } catch (e) {
      console.error('[meta.' + kind + '.status]', e);
      res.status(400).json({ ok: false, error: e.message });
    }
  };
}
router.post('/campaign/:id/status', express.json(), requirePerm('meta_ads_admin'), _makeStatusEndpoint('campaign'));
router.post('/adset/:id/status',    express.json(), requirePerm('meta_ads_admin'), _makeStatusEndpoint('adset'));
router.post('/ad/:id/status',       express.json(), requirePerm('meta_ads_admin'), _makeStatusEndpoint('ad'));

// Budget: cambiar daily_budget o lifetime_budget de campaign | adset.
// Body: { kind, daily_budget?: number_in_eur, lifetime_budget?: number_in_eur }
function _makeBudgetEndpoint(kind) {
  return async (req, res) => {
    try {
      const id = String(req.params.id || '').trim();
      const { daily_budget, lifetime_budget } = req.body || {};
      if (!id) return res.status(400).json({ ok: false, error: 'id requerido' });
      const r = await setEntityBudget(kind, id, { daily_budget, lifetime_budget });
      if (!r.ok) return res.status(r.status === 'no_token' ? 503 : 400).json(r);
      res.json(r);
    } catch (e) {
      console.error('[meta.' + kind + '.budget]', e);
      res.status(400).json({ ok: false, error: e.message });
    }
  };
}
router.post('/campaign/:id/budget', express.json(), requirePerm('meta_ads_admin'), _makeBudgetEndpoint('campaign'));
router.post('/adset/:id/budget',    express.json(), requirePerm('meta_ads_admin'), _makeBudgetEndpoint('adset'));

// ════════════════════════════════════════════════════════════════════
// F3 — Avanzado: upload media, crear ad, análisis IA, backups
// ════════════════════════════════════════════════════════════════════

// /admedia: sube una imagen al ad account. Body: { image_url } (URL pública)
// o multipart. Por simplicidad usamos image_url — el caller ya tiene la
// imagen hosteada en algún lado (S3, Imgur, etc.). Para upload de blob
// hace falta multer + form-data, lo dejo como mejora futura.
router.post('/admedia', express.json(), requirePerm('meta_ads_admin'), async (req, res) => {
  try {
    const { image_url } = req.body || {};
    if (!image_url) return res.status(400).json({ ok: false, error: 'image_url requerido' });
    const cfg = getMarketingConfig();
    if (cfg.missing.length > 0) return res.status(503).json({ ok: false, status: 'not_configured', missing_env: cfg.missing });
    const { token } = await resolveMarketingToken();
    if (!token) return res.status(503).json({ ok: false, status: 'no_token' });
    const r = await graphPost(`${cfg.values.META_AD_ACCOUNT_ID}/adimages`, { url: image_url }, token);
    if (!r.ok) return res.status(400).json({ ok: false, error: r.json?.error?.message || 'graph error' });
    res.json({ ok: true, result: r.json });
  } catch (e) {
    console.error('[meta.admedia]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// /adcreative: crea un creative.
// Body: { name, page_id, image_hash, message, link, call_to_action_type? }
router.post('/adcreative', express.json(), requirePerm('meta_ads_admin'), async (req, res) => {
  try {
    const { name, page_id, image_hash, message, link, call_to_action_type } = req.body || {};
    if (!name || !page_id || !image_hash || !message || !link) {
      return res.status(400).json({ ok: false, error: 'name, page_id, image_hash, message, link requeridos' });
    }
    const cfg = getMarketingConfig();
    if (cfg.missing.length > 0) return res.status(503).json({ ok: false, status: 'not_configured', missing_env: cfg.missing });
    const { token } = await resolveMarketingToken();
    if (!token) return res.status(503).json({ ok: false, status: 'no_token' });
    const object_story_spec = {
      page_id,
      link_data: {
        message, link, image_hash,
        ...(call_to_action_type ? { call_to_action: { type: call_to_action_type, value: { link } } } : {}),
      },
    };
    const r = await graphPost(`${cfg.values.META_AD_ACCOUNT_ID}/adcreatives`, {
      name, object_story_spec,
    }, token);
    if (!r.ok) return res.status(400).json({ ok: false, error: r.json?.error?.message || 'graph error' });
    res.json({ ok: true, result: r.json });
  } catch (e) {
    console.error('[meta.adcreative]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// /ad/create: crea un ad asociado a adset + creative existentes.
// Body: { name, adset_id, creative_id, status? }
router.post('/ad/create', express.json(), requirePerm('meta_ads_admin'), async (req, res) => {
  try {
    const { name, adset_id, creative_id, status } = req.body || {};
    if (!name || !adset_id || !creative_id) {
      return res.status(400).json({ ok: false, error: 'name, adset_id, creative_id requeridos' });
    }
    const cfg = getMarketingConfig();
    if (cfg.missing.length > 0) return res.status(503).json({ ok: false, status: 'not_configured', missing_env: cfg.missing });
    const { token } = await resolveMarketingToken();
    if (!token) return res.status(503).json({ ok: false, status: 'no_token' });
    const r = await graphPost(`${cfg.values.META_AD_ACCOUNT_ID}/ads`, {
      name, adset_id, creative: { creative_id },
      status: status || 'PAUSED',  // default PAUSED por seguridad
    }, token);
    if (!r.ok) return res.status(400).json({ ok: false, error: r.json?.error?.message || 'graph error' });
    invalidateAdsCache();
    res.json({ ok: true, result: r.json });
  } catch (e) {
    console.error('[meta.ad.create]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// /ai-analysis: análisis IA del estado actual de las campañas.
// ?force=1 fuerza regenerar.
router.get('/ai-analysis', async (req, res) => {
  try {
    if (!aiMod.isEnabled()) {
      return res.json({ ok: false, status: 'disabled',
        message: 'Configurá ANTHROPIC_API_KEY en Railway para habilitar el análisis IA.' });
    }
    const snap = await buildAdsDashboard({ refresh: false });
    if (!snap.ok) return res.json({ ok: false, status: snap.status, message: snap.message || 'sin datos para analizar' });
    const refresh = String(req.query.force || '') === '1';
    const r = await aiMod.analyzeAdsSnapshot(snap, { refresh });
    res.json(r);
  } catch (e) {
    console.error('[meta.ai-analysis]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Backups versionados (admin-like).
router.post('/backup/create', requirePerm('meta_ads_admin'), async (req, res) => {
  try {
    const r = await backupMod.createBackup({ triggeredBy: req.session?.user?.email });
    res.json(r);
  } catch (e) {
    console.error('[meta.backup.create]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});
router.get('/backup/list', async (req, res) => {
  try {
    const rows = await backupMod.listBackups({ limit: Math.min(+req.query.limit || 50, 200) });
    res.json({ ok: true, backups: rows });
  } catch (e) {
    console.error('[meta.backup.list]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});
router.get('/backup/:id/json', async (req, res) => {
  try {
    const r = await backupMod.getBackup(parseInt(req.params.id, 10));
    if (!r) return res.status(404).json({ ok: false, error: 'no encontrado' });
    res.json(r);
  } catch (e) {
    console.error('[meta.backup.json]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});
router.get('/backup/:id/csv', async (req, res) => {
  try {
    const r = await backupMod.getBackup(parseInt(req.params.id, 10));
    if (!r) return res.status(404).json({ ok: false, error: 'no encontrado' });
    const csv = backupMod.backupToCsv(r);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ads-backup-${r.id}.csv"`);
    res.send(csv);
  } catch (e) {
    console.error('[meta.backup.csv]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
