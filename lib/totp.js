// TOTP helpers (Google Authenticator / Authy / 1Password).
const { authenticator } = require('otplib');
const QRCode = require('qrcode');

const ISSUER = process.env.TOTP_ISSUER || 'AiresBurger';

// Toleramos ±1 step (30s) por jitter de reloj.
authenticator.options = { window: 1 };

function generateSecret() {
  return authenticator.generateSecret(); // base32, 32 chars
}

function buildOtpAuthUrl(email, secret) {
  return authenticator.keyuri(email, ISSUER, secret);
}

async function toQrDataUrl(otpauthUrl) {
  return QRCode.toDataURL(otpauthUrl, { errorCorrectionLevel: 'M', margin: 1, width: 240 });
}

function verifyCode(code, secret) {
  if (!code || !secret) return false;
  const clean = String(code).replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  try {
    return authenticator.check(clean, secret);
  } catch {
    return false;
  }
}

module.exports = { generateSecret, buildOtpAuthUrl, toQrDataUrl, verifyCode, ISSUER };
