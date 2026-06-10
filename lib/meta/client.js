// Cliente de Meta Graph API (Instagram Business / Facebook Page).
//
// CRÍTICO: cero defaults hardcoded. Las credenciales de Aires se leen
// SOLO de env vars. Si falta cualquiera, los helpers reportan "no
// configurado" en vez de pegarle a una cuenta cualquiera.
//
// Env vars (deben setearse en Railway):
//   META_TOKEN_KEY              — clave AES para encriptar tokens en DB
//   IG_BUSINESS_ACCOUNT_ID      — IG Business Account de Aires
//   FACEBOOK_PAGE_ID            — Page de FB de Aires
//   META_AD_ACCOUNT_ID          — Ad Account (formato 'act_XXXXX', solo F2/F3)
//   INSTAGRAM_ACCESS_TOKEN      — opcional: Page Token via env (fallback)
//   META_USER_TOKEN             — opcional: User Token via env (solo F2/F3)
//
// El access token se prefiere de ab_meta_tokens (cargado vía UI) y solo
// hace fallback a env var si no hay nada en DB.

const { getToken } = require('./tokens');
const { isKeyAvailable } = require('./crypto');

const GRAPH_BASE = 'https://graph.facebook.com/v25.0';

// Lee env vars NECESARIAS para el panel IG (F1). Devuelve { missing[],
// values }. Sin defaults — si la env no existe, va a missing y el caller
// debe mostrar "Configurá credenciales".
function getInstagramConfig() {
  const required = ['IG_BUSINESS_ACCOUNT_ID', 'FACEBOOK_PAGE_ID', 'META_TOKEN_KEY'];
  const missing = [];
  const values = {};
  for (const k of required) {
    const v = process.env[k];
    if (!v) missing.push(k);
    else values[k] = v;
  }
  return { missing, values, crypto_key_available: isKeyAvailable() };
}

// Resuelve el Page Token para Instagram insights. Prefiere DB → env.
// Devuelve { token, source: 'db'|'env'|null }.
async function resolveInstagramToken() {
  const dbToken = await getToken('ig_access_token').catch(() => null);
  if (dbToken) return { token: dbToken, source: 'db' };
  const envToken = process.env.INSTAGRAM_ACCESS_TOKEN || '';
  if (envToken) return { token: envToken, source: 'env' };
  return { token: null, source: null };
}

// Wrapper fetch a Graph API. Devuelve { ok, status, json }. NO tira —
// errores se propagan en el envelope para que el caller decida.
async function graphGet(relPath, query = {}, accessToken) {
  if (!accessToken) {
    return { ok: false, status: 0, json: { error: { message: 'Falta access token de Meta. Configuralo en /ads → Settings o en env INSTAGRAM_ACCESS_TOKEN.' } } };
  }
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v == null) continue;
    if (Array.isArray(v)) usp.set(k, v.join(','));
    else usp.set(k, String(v));
  }
  usp.set('access_token', accessToken);
  const url = `${GRAPH_BASE}/${relPath}?${usp.toString()}`;
  try {
    const r = await fetch(url);
    const json = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, json };
  } catch (e) {
    return { ok: false, status: 0, json: { error: { message: 'Error de red: ' + e.message } } };
  }
}

// Config Marketing API (F2/F3). Devuelve { missing[], values }.
// Sin defaults — si la env no existe, va a missing y el caller debe
// mostrar "Configurá las credenciales de Meta Ads".
function getMarketingConfig() {
  const required = ['META_AD_ACCOUNT_ID', 'META_TOKEN_KEY'];
  const missing = [];
  const values = {};
  for (const k of required) {
    const v = process.env[k];
    if (!v) missing.push(k);
    else values[k] = v;
  }
  // Validar formato: META_AD_ACCOUNT_ID debe arrancar con 'act_'.
  if (values.META_AD_ACCOUNT_ID && !/^act_/.test(values.META_AD_ACCOUNT_ID)) {
    values.META_AD_ACCOUNT_ID = 'act_' + values.META_AD_ACCOUNT_ID;
  }
  return { missing, values, crypto_key_available: isKeyAvailable() };
}

// Resolver del User Token para Marketing API. Prefiere DB → env var.
// Marketing API requiere User Access Token con scope ads_read / ads_management
// — el Page Token de Instagram NO sirve aquí.
async function resolveMarketingToken() {
  const dbToken = await getToken('meta_user_token').catch(() => null);
  if (dbToken) return { token: dbToken, source: 'db' };
  const envToken = process.env.META_USER_TOKEN || '';
  if (envToken) return { token: envToken, source: 'env' };
  return { token: null, source: null };
}

// POST wrapper a Graph API (para acciones: status, budget, ad/create).
async function graphPost(relPath, body = {}, accessToken) {
  if (!accessToken) {
    return { ok: false, status: 0, json: { error: { message: 'Falta access token de Meta Ads. Cargá META_USER_TOKEN.' } } };
  }
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (v == null) continue;
    if (typeof v === 'object') usp.set(k, JSON.stringify(v));
    else usp.set(k, String(v));
  }
  usp.set('access_token', accessToken);
  const url = `${GRAPH_BASE}/${relPath}`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: usp.toString(),
    });
    const json = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, json };
  } catch (e) {
    return { ok: false, status: 0, json: { error: { message: 'Error de red: ' + e.message } } };
  }
}

// Probe del token: pega a /me. Útil para "Probar token" en Settings.
async function probeToken(accessToken) {
  if (!accessToken) return { ok: false, error: 'sin token' };
  const r = await graphGet('me', { fields: 'id,name' }, accessToken);
  if (!r.ok) {
    return { ok: false, error: r.json?.error?.message || `HTTP ${r.status}` };
  }
  return { ok: true, me: r.json };
}

module.exports = {
  GRAPH_BASE,
  getInstagramConfig,
  getMarketingConfig,
  resolveInstagramToken,
  resolveMarketingToken,
  graphGet,
  graphPost,
  probeToken,
};
