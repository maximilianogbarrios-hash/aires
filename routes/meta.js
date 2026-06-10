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
const { isKeyAvailable } = require('../lib/meta/crypto');

const router = express.Router();
router.use(requireAuth);
router.use(requirePerm('meta_ads_view'));

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
    const data = await buildInstagramDashboard({ refresh });
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
