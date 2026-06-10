// F3 — Análisis IA de campañas Meta con Claude (Anthropic).
//
// Si ANTHROPIC_API_KEY no está seteada, isEnabled() devuelve false y el
// frontend debe deshabilitar el botón. No hay defaults ni mocks.

const AI_CACHE_TTL_MS = 30 * 60 * 1000;
let _aiCache = { ts: 0, payload: null, hash: null };

function isEnabled() { return !!process.env.ANTHROPIC_API_KEY; }

function _hashSnapshot(snapshot) {
  // Hash simple del snapshot para invalidar cache cuando cambian
  // los datos. Usa los totales + n_campaigns como heurística rápida —
  // si los números cambiaron, regeneramos.
  const t = snapshot?.totals_last_30d || {};
  return [snapshot?.n_campaigns || 0, Math.round(t.spend || 0), Math.round(t.impressions || 0), Math.round(t.clicks || 0)].join('|');
}

function _resumenCampañasParaPrompt(snapshot) {
  const camps = (snapshot?.campaigns || []).slice(0, 30); // limit por tokens
  return camps.map((c) => ({
    nombre: c.name,
    objetivo: c.objective,
    estado: c.effective_status,
    presupuesto: c.budget?.monto > 0 ? `${c.budget.kind}=${c.budget.monto}` : 'sin presupuesto',
    gasto_30d: Math.round(c.insights.spend || 0),
    impresiones_30d: c.insights.impressions || 0,
    clicks_30d: c.insights.clicks || 0,
    reach_30d: c.insights.reach || 0,
    cpc: c.insights.cpc != null ? +c.insights.cpc.toFixed(2) : null,
    ctr: c.insights.ctr != null ? +(c.insights.ctr * 100).toFixed(2) + '%' : null,
    n_adsets: c.n_adsets,
    n_ads: c.n_ads,
  }));
}

async function analyzeAdsSnapshot(snapshot, { refresh = false } = {}) {
  if (!isEnabled()) {
    return { ok: false, status: 'disabled', message: 'Configurá ANTHROPIC_API_KEY en Railway para habilitar el análisis IA.' };
  }
  const hash = _hashSnapshot(snapshot);
  const now = Date.now();
  if (!refresh && _aiCache.payload && _aiCache.hash === hash && now - _aiCache.ts < AI_CACHE_TTL_MS) {
    return { ...(_aiCache.payload), cached: true, cache_age_sec: Math.floor((now - _aiCache.ts) / 1000) };
  }
  const totals = snapshot?.totals_last_30d || {};
  const camps = _resumenCampañasParaPrompt(snapshot);
  const prompt = `Sos un analista de Meta Ads para una cadena de hamburgueserías (Aires Burger en España).
Analizá este snapshot de ${snapshot?.n_campaigns || 0} campañas (últimos 30 días, currency=${snapshot?.ad_account?.currency || 'EUR'}):

TOTALES 30d:
  · Gasto: €${Math.round(totals.spend || 0)}
  · Impresiones: ${totals.impressions || 0}
  · Clicks: ${totals.clicks || 0}
  · Reach: ${totals.reach || 0}
  · CTR promedio: ${totals.ctr != null ? +(totals.ctr * 100).toFixed(2) + '%' : 'n/d'}
  · CPC promedio: ${totals.cpc != null ? '€' + totals.cpc.toFixed(2) : 'n/d'}

CAMPAÑAS (top ${camps.length}):
${JSON.stringify(camps, null, 2)}

Devolvé un análisis CORTO (max 400 palabras) con:
1. Resumen ejecutivo (2-3 líneas): ¿la performance es buena, regular o mala?
2. Top 3 campañas con mejor performance (con justificación).
3. Top 3 campañas con peor performance (con justificación y recomendación: pausar / bajar presupuesto / cambiar creative).
4. Sugerencia general (1-2 líneas): ¿hacia dónde mover el presupuesto?

Hablá en español. Sin disclaimers. Sé concreto con números.`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { ok: false, status: 'api_error', error: j.error?.message || `HTTP ${r.status}` };
    }
    const text = j.content?.[0]?.text || '';
    const payload = {
      ok: true,
      status: 'active',
      analysis: text,
      model: j.model,
      input_tokens: j.usage?.input_tokens,
      output_tokens: j.usage?.output_tokens,
      generated_at: new Date().toISOString(),
    };
    _aiCache = { ts: now, payload, hash };
    return { ...payload, cached: false };
  } catch (e) {
    return { ok: false, status: 'network_error', error: e.message };
  }
}

function invalidateAiCache() { _aiCache = { ts: 0, payload: null, hash: null }; }

module.exports = { isEnabled, analyzeAdsSnapshot, invalidateAiCache };
