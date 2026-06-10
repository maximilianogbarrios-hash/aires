// Cache server-side en ab_meta_cache. Multi-período + miniaturas.
// La key debe ser determinística — incluí en ella todos los params
// que afectan el resultado (ej. 'ig_dashboard:30d', 'thumb:{mediaId}').

const { query, one } = require('../db');

// Devuelve el payload cacheado si está fresco y no expiró; o null.
// kind: 'json' (default) o 'binary' (devuelve {content_type, buffer}).
async function get(cacheKey, kind = 'json') {
  if (!cacheKey) return null;
  const row = await one(
    `SELECT payload_json, payload_b64, content_type, expires_at, ts
       FROM ab_meta_cache
      WHERE cache_key = $1 AND expires_at > NOW()`,
    [cacheKey]
  );
  if (!row) return null;
  if (kind === 'binary') {
    return {
      buffer: row.payload_b64 ? Buffer.from(row.payload_b64, 'base64') : null,
      content_type: row.content_type || 'application/octet-stream',
      ts: row.ts,
      expires_at: row.expires_at,
    };
  }
  return { payload: row.payload_json, ts: row.ts, expires_at: row.expires_at };
}

async function putJson(cacheKey, payload, ttlSeconds) {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const str = JSON.stringify(payload);
  await query(
    `INSERT INTO ab_meta_cache (cache_key, payload_json, ts, expires_at, bytes)
     VALUES ($1, $2::jsonb, NOW(), $3, $4)
     ON CONFLICT (cache_key) DO UPDATE
       SET payload_json = EXCLUDED.payload_json,
           payload_b64 = NULL,
           content_type = NULL,
           ts = NOW(),
           expires_at = EXCLUDED.expires_at,
           bytes = EXCLUDED.bytes`,
    [cacheKey, str, expiresAt.toISOString(), Buffer.byteLength(str, 'utf8')]
  );
}

async function putBinary(cacheKey, buffer, contentType, ttlSeconds) {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const b64 = buffer.toString('base64');
  await query(
    `INSERT INTO ab_meta_cache (cache_key, payload_b64, content_type, ts, expires_at, bytes)
     VALUES ($1, $2, $3, NOW(), $4, $5)
     ON CONFLICT (cache_key) DO UPDATE
       SET payload_json = NULL,
           payload_b64 = EXCLUDED.payload_b64,
           content_type = EXCLUDED.content_type,
           ts = NOW(),
           expires_at = EXCLUDED.expires_at,
           bytes = EXCLUDED.bytes`,
    [cacheKey, b64, contentType, expiresAt.toISOString(), buffer.length]
  );
}

// DELETE de entradas expiradas. Llamar periódicamente desde un cron o
// al servir un endpoint heavy. Sin scheduler por ahora — el endpoint
// /dashboard/instagram lo invoca al cargar.
async function cleanupExpired() {
  const r = await query(`DELETE FROM ab_meta_cache WHERE expires_at <= NOW()`);
  return r.rowCount;
}

async function invalidate(prefix) {
  await query(`DELETE FROM ab_meta_cache WHERE cache_key LIKE $1`, [prefix + '%']);
}

module.exports = { get, putJson, putBinary, cleanupExpired, invalidate };
