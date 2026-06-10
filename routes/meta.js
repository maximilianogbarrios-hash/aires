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
  getInstagramConfig, resolveInstagramToken, probeToken,
} = require('../lib/meta/client');
const { getToken, putToken, clearToken, tokenStatus } = require('../lib/meta/tokens');
const { buildInstagramDashboard, invalidateCache } = require('../lib/meta/instagram');
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
    const ig = await tokenStatus('ig_access_token');
    res.json({
      ok: true,
      env_missing: cfg.missing,
      env_ok: cfg.missing.length === 0,
      crypto_key_available: isKeyAvailable(),
      tokens: {
        ig_access_token: ig,
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
    res.json({ ok: true, deleted: r.deleted });
  } catch (e) {
    console.error('[meta.token.delete]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
