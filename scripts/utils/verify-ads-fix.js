#!/usr/bin/env node
// Verificación determinística del fix "0 ads".
// Llama a las MISMAS funciones del endpoint /api/v1/meta/ads (no _debug),
// con el token real de env, y afirma 4 asserts contra IDs conocidos.
//
// Uso:
//   node scripts/utils/verify-ads-fix.js
//
// Requiere que el .env tenga: META_AD_ACCOUNT_ID, META_TOKEN_KEY,
// y que ab_meta_tokens tenga el meta_user_token cargado.

require('dotenv').config();

const TARGET_CAMP  = '6988700632040';
const TARGET_ADSET = '6988700632072';
const TARGET_AD    = '6988700711672';

(async () => {
  const { buildAdsDashboard, invalidateAdsCache } = require('../../lib/meta/ads');
  // Forzar refresh para que NO sirva cache.
  invalidateAdsCache();
  const dash = await buildAdsDashboard({ refresh: true });

  if (!dash.ok) {
    console.error('❌ buildAdsDashboard falló:', dash);
    process.exit(1);
  }
  console.log(`📊 dashboard: ${dash.n_campaigns} campañas, ${dash.n_adsets} adsets, ${dash.n_ads} ads`);

  const camp = (dash.campaigns || []).find((c) => String(c.id) === TARGET_CAMP);
  if (!camp) {
    console.error('❌ campaña', TARGET_CAMP, 'NO encontrada en el dashboard');
    console.error('   campaign_ids muestra:', (dash.campaigns || []).slice(0, 5).map((c) => c.id));
    process.exit(1);
  }
  console.log(`✓ campaña ${TARGET_CAMP} encontrada: "${camp.name}"`);
  console.log(`  n_ads=${camp.n_ads}, n_adsets=${camp.n_adsets}, primary_thumbnail=${camp.primary_thumbnail ? 'SÍ' : 'NO'}`);

  const asserts = [
    ['campaign_has_at_least_1_ad', camp.n_ads >= 1],
    ['contains_target_ad', (camp.ads || []).some((a) => a.id === TARGET_AD)],
    ['target_ad_has_thumbnail', (camp.ads || []).some((a) => a.id === TARGET_AD && !!(a.creative?.thumbnail_url || a.creative?.image_url))],
    ['target_adset_present_with_ads', (camp.adsets || []).some((s) => s.id === TARGET_ADSET && s.n_ads >= 1)],
  ];

  let pass = 0;
  for (const [name, ok] of asserts) {
    if (ok) { console.log('✓', name); pass++; }
    else    console.error('❌', name);
  }

  // Si alguno falla, dumpear el shape para diagnóstico.
  if (pass < asserts.length) {
    console.error('\n--- DIAGNÓSTICO ---');
    console.error('camp.ads (first 3):', JSON.stringify((camp.ads || []).slice(0, 3).map((a) => ({
      id: a.id, name: a.name, adset_id: a.adset_id, has_creative: !!a.creative,
      thumb: a.creative?.thumbnail_url || a.creative?.image_url || null,
    })), null, 2));
    console.error('camp.adsets:', JSON.stringify((camp.adsets || []).map((s) => ({
      id: s.id, name: s.name, n_ads: s.n_ads, is_ghost: !!s._ghost,
    })), null, 2));
    process.exit(1);
  }

  console.log(`\n✅ ${pass}/${asserts.length} asserts pasaron — fix OK`);
  process.exit(0);
})().catch((e) => { console.error('💥', e); process.exit(1); });
