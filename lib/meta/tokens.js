// Persistencia de tokens de Meta en ab_meta_tokens (Postgres).
// Encripta con AES-256-GCM (lib/meta/crypto.js). Cache in-memory de 30s
// para no descifrar en cada request.
//
// kinds soportados:
//   'ig_access_token'   — Page Token para Instagram Business + Page insights
//   'meta_user_token'   — User Access Token para Marketing API (F2/F3)

const { query, one } = require('../db');
const { encrypt, decrypt, isKeyAvailable } = require('./crypto');

const VALID_KINDS = new Set(['ig_access_token', 'meta_user_token']);
const CACHE_TTL_MS = 30 * 1000;
const cache = new Map(); // kind → { value, ts }

async function getToken(kind) {
  if (!VALID_KINDS.has(kind)) throw new Error('kind inválido: ' + kind);
  const cached = cache.get(kind);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.value;

  const row = await one(
    'SELECT value_encrypted, iv, auth_tag, saved_at FROM ab_meta_tokens WHERE kind = $1',
    [kind]
  );
  if (!row) {
    cache.set(kind, { value: null, ts: Date.now() });
    return null;
  }
  try {
    const value = decrypt({ value_encrypted: row.value_encrypted, iv: row.iv, auth_tag: row.auth_tag });
    cache.set(kind, { value, ts: Date.now() });
    return value;
  } catch (e) {
    console.error('[meta.tokens] decrypt failed for kind=' + kind + ':', e.message);
    return null;
  }
}

async function putToken(kind, plaintext, savedByEmail) {
  if (!VALID_KINDS.has(kind)) throw new Error('kind inválido: ' + kind);
  if (!plaintext || typeof plaintext !== 'string' || plaintext.length < 20) {
    throw new Error('token vacío o muy corto');
  }
  const enc = encrypt(plaintext); // tira META_TOKEN_KEY_MISSING si no hay env
  await query(
    `INSERT INTO ab_meta_tokens (kind, value_encrypted, iv, auth_tag, saved_at, saved_by_email)
     VALUES ($1, $2, $3, $4, NOW(), $5)
     ON CONFLICT (kind) DO UPDATE SET
       value_encrypted = EXCLUDED.value_encrypted,
       iv              = EXCLUDED.iv,
       auth_tag        = EXCLUDED.auth_tag,
       saved_at        = NOW(),
       saved_by_email  = EXCLUDED.saved_by_email`,
    [kind, enc.value_encrypted, enc.iv, enc.auth_tag, savedByEmail || null]
  );
  cache.delete(kind);
  return { ok: true, saved_at: new Date().toISOString() };
}

async function clearToken(kind) {
  if (!VALID_KINDS.has(kind)) throw new Error('kind inválido: ' + kind);
  const r = await query('DELETE FROM ab_meta_tokens WHERE kind = $1', [kind]);
  cache.delete(kind);
  return { ok: true, deleted: r.rowCount };
}

// Status de UN token: sin descifrar valor, solo presencia y saved_at.
async function tokenStatus(kind) {
  if (!VALID_KINDS.has(kind)) throw new Error('kind inválido: ' + kind);
  const row = await one('SELECT saved_at, saved_by_email FROM ab_meta_tokens WHERE kind = $1', [kind]);
  return {
    kind,
    present: !!row,
    saved_at: row?.saved_at || null,
    saved_by_email: row?.saved_by_email || null,
    crypto_key_available: isKeyAvailable(),
  };
}

module.exports = { getToken, putToken, clearToken, tokenStatus, VALID_KINDS };
