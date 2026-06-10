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
  const averages = snapshot?.averages || {};
  const camps = _resumenCampañasParaPrompt(snapshot);
  const activas = (snapshot?.groups?.active?.campaigns || []).slice(0, 20).map((c) => ({
    nombre: c.name, objetivo: c.objective, presupuesto: c.budget?.kind ? `${c.budget.kind}=€${c.budget.monto}` : 'sin presupuesto',
    gasto: Math.round(c.insights.spend || 0),
    impresiones: c.insights.impressions || 0,
    clicks: c.insights.clicks || 0,
    reach: c.insights.reach || 0,
    frecuencia: c.insights.frequency != null ? +c.insights.frequency.toFixed(2) : null,
    ctr: c.insights.ctr != null ? +(c.insights.ctr * 100).toFixed(2) + '%' : null,
    cpc: c.insights.cpc != null ? +c.insights.cpc.toFixed(2) : null,
    cpm: c.insights.cpm != null ? +c.insights.cpm.toFixed(2) : null,
    resultados: c.insights.results || 0,
    cpa: c.insights.cost_per_result != null ? +c.insights.cost_per_result.toFixed(2) : null,
    veredicto: c.verdict?.kind || null,
  }));
  const prompt = `Sos un media buyer senior especializado en Meta Ads (Instagram + Facebook) para una cadena de hamburgueserías en España (Aires Burger).

TU TRABAJO: dar 5 minutos de claridad ejecutiva al dueño sobre qué hacer ESTA SEMANA con las campañas de Aires.

DATOS DE LA CUENTA (últimos 30 días, currency=${snapshot?.ad_account?.currency || 'EUR'}):
  · Gasto total: €${Math.round(totals.spend || 0)} en ${snapshot?.n_campaigns || 0} campañas (${snapshot?.groups?.active?.count || 0} activas)
  · Alcance: ${totals.reach || 0} · Impresiones: ${totals.impressions || 0} · Frecuencia: ${totals.frequency != null ? totals.frequency.toFixed(2) : 'n/d'}
  · Clics: ${totals.clicks || 0} · CTR promedio: ${totals.ctr != null ? +(totals.ctr * 100).toFixed(2) + '%' : 'n/d'} · CPC promedio: ${totals.cpc != null ? '€' + totals.cpc.toFixed(2) : 'n/d'} · CPM: ${totals.cpm != null ? '€' + totals.cpm.toFixed(2) : 'n/d'}
  · Resultados totales: ${totals.results || 0} · CPA promedio cuenta: ${averages.cpa ? '€' + averages.cpa.toFixed(2) : 'n/d'}

CAMPAÑAS ACTIVAS (top ${activas.length} por gasto):
${JSON.stringify(activas, null, 2)}

Devolvé en ESPAÑOL CRIOLLO (sin disclaimers, sin "como modelo de IA", sin "espero que esto te ayude") un análisis con esta estructura EXACTA, usando markdown simple:

## Resumen ejecutivo
2-3 líneas: ¿la cuenta está rindiendo bien, regular o mal? ¿Cuál es el problema o la oportunidad principal?

## 🟢 Qué está funcionando (escalar)
Por cada campaña con buena performance: nombre, por qué funciona (números concretos vs promedio), cuánto subir el presupuesto (% sugerido) y por qué.

## 🔴 Qué pausar ya
Por cada campaña que gasta sin resultados o con CPC muy alto: nombre, los números que la condenan, recomendación clara (pausar o bajar X%).

## 🟠 Qué optimizar
Por cada campaña que renta pero podría mejorar: el problema concreto (frecuencia alta, CTR bajo, etc.) y qué probar (rotar creative, ampliar audiencia, cambiar copy).

## 💰 Reasignación sugerida de presupuesto
"Sacale €X a [campaña Y] y mandalos a [campaña Z]". Sé específico con €.

## ✅ 3 acciones para esta semana
1. ...
2. ...
3. ...

REGLAS:
- Sé CONCRETO con números y nombres reales. Nada de generalidades.
- Si hay frecuencia >3.5, mencionalo como problema fuerte ("la gente ya vio el mismo anuncio X veces").
- Si saved/shares son altos en orgánico (no en datos acá), no hay info — quedate en lo que sí ves.
- No inventes resultados que no estén en los datos.
- Total máximo 500 palabras. Cero relleno.`;

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
