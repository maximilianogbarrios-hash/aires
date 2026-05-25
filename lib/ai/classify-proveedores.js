// Cliente IA para clasificar proveedores → categoría.
//
// Transporte: OpenRouter (https://openrouter.ai), API compatible con
// OpenAI Chat Completions. Modelo: anthropic/claude-sonnet-4-6 (mismo
// modelo que usaríamos con Anthropic directo, pero servido vía
// OpenRouter — auth única, billing centralizado, sin SDK).
//
// NOTA: OpenRouter no soporta el prompt caching de Anthropic
// (cache_control: ephemeral). Los batches 2-N pagan precio completo
// del system prompt — no hay descuento por contexto repetido.
//
// API:
//   classifyProveedores({ proveedores, reglasEjemplo, categorias })
//     → { sugerencias, usage, model }
//   classifyProveedores.errors                 → tipos de error reconocidos
//
// Errores:
//   - { type: 'no_api_key' }       → falta OPENROUTER_API_KEY
//   - { type: 'http', status, body } → OpenRouter respondió !2xx
//   - { type: 'parse', raw }       → JSON inválido en la respuesta
//
// El caller (route handler) traduce esos tipos a HTTP status codes.

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'anthropic/claude-sonnet-4-6';

function buildSystemPrompt({ categorias, reglasEjemplo }) {
  const categoriasTxt = categorias.map((c) => `  - ${c}`).join('\n');
  const reglasTxt = (reglasEjemplo || [])
    .map((r) => `  - "${r.proveedor_normalizado}" → ${r.categoria}`)
    .join('\n');
  return `Eres un asistente de clasificación contable para Aires Burger, cadena de hamburgueserías en España.

Categorías disponibles (DEBES elegir una de éstas exactamente):
${categoriasTxt}

Ejemplos de reglas existentes para guiar tu criterio:
${reglasTxt}

Responderás SOLO en JSON válido, sin texto extra antes ni después, con este formato exacto:
[
  {
    "proveedor": "nombre exacto del input",
    "categoria": "NOMBRE_CATEGORIA",
    "confianza": "alta",
    "motivo": "una línea explicando por qué"
  }
]

Criterios de confianza:
- "alta": el nombre del proveedor es inequívocamente una categoría conocida (ej: una marca de energía → SUMINISTROS_ENERGIA, una distribuidora de carne → PROVEEDOR_CARNES).
- "media": hay una categoría probable pero el nombre podría caer en varias (ej: un nombre genérico tipo "Distribuciones X" sin contexto adicional).
- "baja": el nombre es ambiguo, parece una transferencia genérica, o no se identifica un giro claro.

Reglas:
- Si no podés identificar el rubro con razonabilidad, usá "OTROS_GASTOS" o "PROVEEDOR_OTROS" con confianza "baja".
- Para nóminas, sueldos o personal: NOMINAS o NOMINAS_DIRECCION (según contexto).
- Para impuestos / AEAT / hacienda: IMPUESTOS.
- Para Seguridad Social / TGSS: SS_LABORAL.
- Para Glovo, Uber Eats, Just Eat: DELIVERY.
- Para alquileres / arrendamientos: ALQUILER.`;
}

function buildUserPrompt(proveedores) {
  const lista = proveedores
    .map((p, i) => `${i + 1}. "${p.proveedor}"${p.n_movimientos ? ` (${p.n_movimientos} mov, ${Math.round(p.total_importe || 0)}€)` : ''}`)
    .join('\n');
  return `Clasificá estos ${proveedores.length} proveedores. Respondé SOLO con el array JSON, sin texto extra.

${lista}`;
}

async function classifyProveedores({ proveedores, reglasEjemplo, categorias }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    const err = new Error('OPENROUTER_API_KEY no configurada');
    err.type = 'no_api_key';
    throw err;
  }
  if (!Array.isArray(proveedores) || !proveedores.length) {
    return { sugerencias: [], usage: null, model: MODEL };
  }

  const systemPrompt = buildSystemPrompt({ categorias, reglasEjemplo });
  const userPrompt = buildUserPrompt(proveedores);

  // OpenRouter usa el shape de OpenAI Chat Completions: messages[] con
  // {role:'system'|'user'|'assistant', content:'...'}. No hay
  // cache_control ni system separado del messages array — quedó atrás
  // con el cliente Anthropic directo.
  const apiRes = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
      // Headers opcionales para que OpenRouter atribuya el tráfico a este
      // app en su leaderboard / analytics. No afectan billing ni latencia.
      'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'https://aires-solo.local',
      'X-Title': 'Aires Solo · Clasificación Proveedores',
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      max_tokens: 8000,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
    }),
  });

  if (!apiRes.ok) {
    const errTxt = await apiRes.text().catch(() => '');
    const err = new Error(`OpenRouter HTTP ${apiRes.status}`);
    err.type = 'http';
    err.status = apiRes.status;
    err.body = errTxt.slice(0, 500);
    throw err;
  }

  const data = await apiRes.json();
  // Shape OpenAI: choices[0].message.content (string).
  const raw = data?.choices?.[0]?.message?.content || '';

  let sugerencias;
  try {
    const cleaned = String(raw).trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();
    sugerencias = JSON.parse(cleaned);
    if (!Array.isArray(sugerencias)) throw new Error('respuesta no es array');
  } catch (e) {
    const err = new Error('respuesta del modelo no parseable como JSON');
    err.type = 'parse';
    err.raw = String(raw).slice(0, 500);
    throw err;
  }

  // Normalización + validación contra el set de categorías permitido.
  const catSet = new Set(categorias);
  const norm = sugerencias.map((s) => {
    const proveedor = String(s.proveedor || '').trim();
    let categoria = String(s.categoria || '').trim().toUpperCase();
    let confianza = String(s.confianza || 'baja').toLowerCase();
    if (!['alta', 'media', 'baja'].includes(confianza)) confianza = 'baja';
    if (!catSet.has(categoria)) { categoria = 'OTROS_GASTOS'; confianza = 'baja'; }
    return { proveedor, categoria, confianza, motivo: String(s.motivo || '').slice(0, 200) };
  }).filter((s) => s.proveedor);

  return {
    sugerencias: norm,
    usage: data.usage || null,
    model: data.model || MODEL,
  };
}

module.exports = { classifyProveedores };
