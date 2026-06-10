// F3 — Backups versionados del estado de Meta Ads.
//
// Cada backup es un snapshot JSON del payload de buildAdsDashboard()
// guardado en ab_ads_backups. Permite reconstruir si la agencia
// borra/cambia algo en el panel de Meta. trigger_kind = 'manual' (botón)
// o 'auto' (scheduler futuro).

const { query, one, many } = require('../db');
const { buildAdsDashboard } = require('./ads');

async function createBackup({ triggeredBy, notes } = {}) {
  // Forzamos refresh para garantizar snapshot fresco.
  const snap = await buildAdsDashboard({ refresh: true });
  if (!snap.ok) {
    return { ok: false, error: snap.message || snap.error || 'no se pudo construir snapshot', status: snap.status };
  }
  const accId = snap.ad_account?.id || '';
  const accName = snap.ad_account?.name || null;
  const nCamp = snap.n_campaigns || 0;
  const nAdsets = snap.n_adsets || 0;
  const nAds = snap.n_ads || 0;
  const payloadStr = JSON.stringify(snap);
  const bytes = Buffer.byteLength(payloadStr, 'utf8');
  const r = await query(
    `INSERT INTO ab_ads_backups
       (ts, ad_account_id, ad_account_name, payload, campaigns_count, adsets_count, ads_count, bytes, trigger_kind, triggered_by, notes)
     VALUES (NOW(), $1, $2, $3::jsonb, $4, $5, $6, $7, 'manual', $8, $9)
     RETURNING id, ts`,
    [accId, accName, payloadStr, nCamp, nAdsets, nAds, bytes, triggeredBy || null, notes || null]
  );
  return {
    ok: true,
    id: r.rows[0].id, ts: r.rows[0].ts,
    ad_account_id: accId, ad_account_name: accName,
    campaigns_count: nCamp, adsets_count: nAdsets, ads_count: nAds,
    bytes,
  };
}

async function listBackups({ limit = 50 } = {}) {
  const rows = await many(
    `SELECT id, ts, ad_account_id, ad_account_name, campaigns_count, adsets_count, ads_count, bytes, trigger_kind, triggered_by, notes
       FROM ab_ads_backups
       ORDER BY ts DESC
       LIMIT $1`,
    [limit]
  );
  return rows;
}

async function getBackup(id) {
  const r = await one('SELECT * FROM ab_ads_backups WHERE id = $1', [id]);
  return r;
}

function backupToCsv(backupRow) {
  if (!backupRow) return '';
  const payload = backupRow.payload;
  const rows = [['kind', 'id', 'name', 'parent_id', 'status', 'effective_status', 'budget_kind', 'budget_eur', 'spend', 'impressions', 'clicks', 'reach', 'cpc', 'ctr']];
  for (const c of (payload.campaigns || [])) {
    rows.push(['campaign', c.id, c.name, '', c.status, c.effective_status, c.budget?.kind || '', c.budget?.monto || 0,
               c.insights?.spend || 0, c.insights?.impressions || 0, c.insights?.clicks || 0, c.insights?.reach || 0,
               c.insights?.cpc != null ? c.insights.cpc : '', c.insights?.ctr != null ? c.insights.ctr : '']);
    for (const s of (c.adsets || [])) {
      rows.push(['adset', s.id, s.name, c.id, s.status, s.effective_status, s.budget?.kind || '', s.budget?.monto || 0,
                 s.insights?.spend || 0, s.insights?.impressions || 0, s.insights?.clicks || 0, s.insights?.reach || 0,
                 s.insights?.cpc != null ? s.insights.cpc : '', s.insights?.ctr != null ? s.insights.ctr : '']);
      for (const a of (s.ads || [])) {
        rows.push(['ad', a.id, a.name, s.id, a.status, a.effective_status, '', '',
                   a.insights?.spend || 0, a.insights?.impressions || 0, a.insights?.clicks || 0, a.insights?.reach || 0,
                   a.insights?.cpc != null ? a.insights.cpc : '', a.insights?.ctr != null ? a.insights.ctr : '']);
      }
    }
  }
  return rows.map((r) => r.map((v) => {
    const s = String(v == null ? '' : v);
    return /[,"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\n');
}

module.exports = { createBackup, listBackups, getBackup, backupToCsv };
