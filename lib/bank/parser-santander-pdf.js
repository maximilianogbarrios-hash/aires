// Parser de extractos PDF de Santander.
//
// Layout esperado del PDF (texto extraído con pdf-parse):
//
//   Titular
//   Saldo disponible
//   AIRES ALICANTE SL.                 ← nombre del titular (para auto-detección)
//   Cuenta
//   ES47 0049 ...                       ← IBAN
//   ...
//   Movimientos desde el DD-MM-YYYY hasta el DD-MM-YYYY ...
//   Fecha Concepto Importe Saldo        ← marca el inicio de la tabla
//   F. Valor [concepto multilínea] X,XX EUR Y,YY EUR
//   DD/MM/YYYY                          ← fecha operación
//   DD/MM/YYYY                          ← fecha valor
//   F. Valor ...                         ← siguiente movimiento
//
// El parser divide la tabla por el delimitador "F. Valor" y dentro de cada
// bloque extrae importe + saldo (último par "X,XX EUR Y,YY EUR" del bloque),
// las dos fechas (las dos primeras DD/MM/YYYY que aparecen después del par
// importe/saldo) y el resto del texto es el concepto.

const { PDFParse } = require('pdf-parse');
const { categorizar, detectarLocal, extraerSubcategoria } = require('./categorizer');
const { findSociedad, SOCIEDADES } = require('../bank/sociedades');
const { hashMovimiento } = require('./hash-mov');

// Mapeo de tokens del titular → sociedad_id. El header del PDF dice cosas
// como "AIRES ALICANTE SL." / "AIRES BURGER BAR MURCIA SL" / "SMART AIRES SL"
// — detectamos por substring case-insensitive en orden de especificidad
// (las más específicas primero para evitar falsos positivos).
const TITULAR_PATRONES = [
  { rx: /aires\s+burger\s+bar\s+murcia/i,    sociedad_id: 'murcia' },
  { rx: /aires\s+burger\s+bar\s+benidorm/i,  sociedad_id: 'benidorm' },
  { rx: /smart\s+aires/i,                     sociedad_id: 'smart' },
  { rx: /aires\s+alicante/i,                  sociedad_id: 'alicante' },
  { rx: /grupo\s+hostelero\s+aires/i,         sociedad_id: 'hostelero' },
];

function detectarSociedadDesdeTexto(text) {
  // Buscamos en los primeros ~800 chars del PDF (cubre el bloque de header
  // titular/cuenta/saldo sin riesgo de matchear nombres dentro de conceptos
  // de movimientos como "TRANSFERENCIA A Aires Alicante SL.").
  const head = (text || '').slice(0, 800);
  for (const { rx, sociedad_id } of TITULAR_PATRONES) {
    if (rx.test(head)) return sociedad_id;
  }
  return null;
}

// "1.234,56" → 1234.56 ; "-52,56" → -52.56
function parseImporteEs(s) {
  if (s == null) return null;
  const cleaned = String(s).replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// "29/05/2026" → "2026-05-29"
function parseFechaDmy(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s || '').trim());
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function periodoFromIso(iso) {
  return iso ? iso.slice(0, 7) : null;
}

// Hash compartido (lib/bank/hash-mov.js) — estable cross-format.

// Regex que matchea el par "importe EUR saldo EUR" final de un bloque.
// El importe puede ser negativo. Formato europeo (1.234,56). Se elige la
// ÚLTIMA ocurrencia del bloque por seguridad (los conceptos pueden incluir
// cifras EUR — ej. "Periodo: 04/2026" — aunque sin "EUR" pegado).
const RE_IMPORTE_SALDO = /(-?\d{1,3}(?:\.\d{3})*,\d{2})\s+EUR\s+(-?\d{1,3}(?:\.\d{3})*,\d{2})\s+EUR/g;
const RE_FECHA = /(\d{2}\/\d{2}\/\d{4})/g;

function parseBloque(raw) {
  const txt = raw.trim();
  if (!txt) return null;

  // Tomamos la ÚLTIMA aparición de "importe EUR saldo EUR" — robustece
  // contra conceptos que contienen otros importes en EUR.
  let lastMatch = null;
  let m;
  RE_IMPORTE_SALDO.lastIndex = 0;
  while ((m = RE_IMPORTE_SALDO.exec(txt)) !== null) {
    lastMatch = { idx: m.index, len: m[0].length, importe: m[1], saldo: m[2] };
  }
  if (!lastMatch) return null;

  const importe = parseImporteEs(lastMatch.importe);
  if (importe == null) return null;

  // Concepto = texto del bloque hasta el inicio del par importe/saldo.
  let concepto = txt.slice(0, lastMatch.idx).trim();
  // El primer bloque del split conserva el prefix "F. Valor" porque no se
  // lo come el split del primer movimiento. Lo limpiamos siempre.
  concepto = concepto.replace(/^F\.\s*Valor\s*/i, '').trim();
  // Compactar whitespace + saltos de línea — los PDFs rompen el concepto
  // arbitrariamente.
  concepto = concepto.replace(/\s+/g, ' ').trim();
  if (!concepto) return null;

  // Las 2 fechas (operación + valor) están DESPUÉS del par importe/saldo
  // en su propia línea cada una.
  const cola = txt.slice(lastMatch.idx + lastMatch.len);
  const fechas = [...cola.matchAll(RE_FECHA)].map((mm) => mm[1]);
  const fechaOp = fechas[0] ? parseFechaDmy(fechas[0]) : null;
  const fechaValor = fechas[1] ? parseFechaDmy(fechas[1]) : fechaOp;
  if (!fechaOp) return null;

  return { fecha: fechaOp, fecha_valor: fechaValor, concepto, importe };
}

async function parseSantanderPdfBuffer(buffer, { sociedad_id, banco = 'santander' } = {}) {
  const parser = new PDFParse({ data: buffer });
  const { text } = await parser.getText();

  // Auto-detección de sociedad desde el header del PDF.
  const sociedadDetectada = detectarSociedadDesdeTexto(text);
  const sociedadFinal = sociedad_id || sociedadDetectada;
  if (!sociedadFinal || !findSociedad(sociedadFinal)) {
    return {
      movimientos: [], skipped: 0, header_found: false,
      sociedad_detectada: sociedadDetectada,
      error: !sociedadFinal ? 'no se pudo detectar sociedad del titular'
        : `sociedad_id inválida: ${sociedadFinal}`,
    };
  }

  const startMarker = /Fecha\s+Concepto\s+Importe\s+Saldo/i;
  const startMatch = startMarker.exec(text);
  if (!startMatch) {
    return {
      movimientos: [], skipped: 0, header_found: false,
      sociedad_detectada: sociedadDetectada,
      error: 'no se encontró la cabecera "Fecha Concepto Importe Saldo"',
    };
  }
  const body = text.slice(startMatch.index + startMatch[0].length);

  // Split por "F. Valor" como delimitador. El primer bloque arranca con la
  // primera ocurrencia (que retiene el prefix por el split asimétrico), los
  // siguientes vienen "limpios". parseBloque() normaliza ambos casos.
  const bloques = body.split(/\nF\.\s*Valor/);
  const movimientos = [];
  let skipped = 0;

  for (const raw of bloques) {
    const parsed = parseBloque(raw);
    if (!parsed) { skipped++; continue; }

    const categoria = categorizar(parsed.concepto, parsed.importe);
    const subcategoria = extraerSubcategoria(parsed.concepto);
    // El PDF no trae "código banco" como columna separada (a diferencia
    // del XLS). El local solo se detecta por concepto cuando es relevante
    // (TPV liquidaciones con nombre del local en el texto).
    const local_id = detectarLocal(parsed.concepto) || null;
    const periodo = periodoFromIso(parsed.fecha);

    const mov = {
      sociedad_id: sociedadFinal,
      banco,
      fecha: parsed.fecha,
      fecha_valor: parsed.fecha_valor,
      concepto: parsed.concepto,
      importe: parsed.importe,
      categoria,
      subcategoria,
      local_id,
      codigo_banco: null,
      num_documento: null,
      periodo,
    };
    mov.hash = hashMovimiento({
      sociedad_id: sociedadFinal,
      fecha: parsed.fecha,
      fecha_valor: parsed.fecha_valor,
      concepto: parsed.concepto,
      importe: parsed.importe,
    });
    movimientos.push(mov);
  }

  return {
    movimientos,
    skipped,
    header_found: true,
    source: 'santander-pdf',
    sociedad_detectada: sociedadDetectada,
    sociedad_final: sociedadFinal,
  };
}

module.exports = {
  parseSantanderPdfBuffer,
  detectarSociedadDesdeTexto,
  parseBloque,
  TITULAR_PATRONES,
};
