// Cifrado AES-256-GCM para tokens persistidos en ab_meta_tokens.
// La clave maestra vive en META_TOKEN_KEY (env var). Se acepta:
//   · 64 chars hex (32 bytes) — formato recomendado, generado con
//     `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
//   · cualquier string ≥16 chars — se deriva a 32 bytes con SHA-256.
// Si la env var FALTA, los helpers tiran error claro — el caller
// debe atrapar y mostrar "Configurá META_TOKEN_KEY en Railway".

const crypto = require('crypto');

function _getKey() {
  const raw = process.env.META_TOKEN_KEY;
  if (!raw || raw.length < 16) {
    const err = new Error('META_TOKEN_KEY no configurada (o muy corta). Generá una con: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))" y seteala en Railway.');
    err.code = 'META_TOKEN_KEY_MISSING';
    throw err;
  }
  // hex 64 chars → 32 bytes directos; cualquier otro string → SHA-256.
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  return crypto.createHash('sha256').update(raw).digest();
}

function encrypt(plaintext) {
  const key = _getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    value_encrypted: enc.toString('base64'),
    iv: iv.toString('base64'),
    auth_tag: tag.toString('base64'),
  };
}

function decrypt({ value_encrypted, iv, auth_tag }) {
  const key = _getKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(auth_tag, 'base64'));
  const dec = Buffer.concat([decipher.update(Buffer.from(value_encrypted, 'base64')), decipher.final()]);
  return dec.toString('utf8');
}

// ¿Está la env var presente y válida? Sin tirar — para el endpoint
// /config-status que reporta qué falta.
function isKeyAvailable() {
  try { _getKey(); return true; } catch { return false; }
}

module.exports = { encrypt, decrypt, isKeyAvailable };
