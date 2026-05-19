// Parser de extractos XLS de Santander.
//
// Layout esperado (1-indexed para humanos, 0-indexed en código):
//   row 1-7: metadata (titular, IBAN, rango, etc.)
//   row 8:   headers — Fecha Operación | Fecha Valor | Concepto | Importe |
//                       Divisa | Saldo | Divisa | Código | Nº Documento | …
//   row 9+:  datos
//
// El parser es tolerante: detecta la fila de headers buscando "concepto"+"importe"
// y comienza a leer desde la fila siguiente. Esto cubre variaciones de export.

const XLSX = require('xlsx');
const crypto = require('crypto');
const { categorizar, detectarLocal, extraerSubcategoria } = require('./categorizer');

// Normaliza una celda de fecha a YYYY-MM-DD.
function toIsoDate(cell) {
  if (cell == null || cell === '') return null;
  // Excel serial number (date) — se convierte a JS Date.
  if (typeof cell === 'number') {
    const d = XLSX.SSF.parse_date_code(cell);
    if (!d) return null;
    const yyyy = d.y.toString().padStart(4, '0');
    const mm = d.m.toString().padStart(2, '0');
    const dd = d.d.toString().padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
  if (cell instanceof Date) {
    const yyyy = cell.getFullYear().toString().padStart(4, '0');
    const mm = (cell.getMonth() + 1).toString().padStart(2, '0');
    const dd = cell.getDate().toString().padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
  // Strings tipo "12/06/2025" o "2025-06-12"
  const s = String(cell).trim();
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s);
  if (dmy) {
    let [, dd, mm, yyyy] = dmy;
    if (yyyy.length === 2) yyyy = '20' + yyyy;
    return `${yyyy.padStart(4, '0')}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }
  const ymd = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (ymd) return `${ymd[1]}-${ymd[2]}-${ymd[3]}`;
  return null;
}

function toNumber(cell) {
  if (cell == null || cell === '') return null;
  if (typeof cell === 'number') return cell;
  let s = String(cell).trim().replace(/\s/g, '');
  // Formato europeo "1.234,56" → 1234.56
  if (/,\d{1,2}$/.test(s)) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    s = s.replace(/,/g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const r = rows[i] || [];
    const txt = r.map((c) => String(c || '').toLowerCase()).join('|');
    if (txt.includes('concepto') && txt.includes('importe')) return i;
  }
  return -1;
}

function periodoFromIso(iso) {
  return iso ? iso.slice(0, 7) : null;
}

function hashRow({ sociedad_id, fecha, concepto, importe, codigo_banco, num_documento }) {
  const key = [sociedad_id, fecha, concepto, importe.toFixed(2), codigo_banco || '', num_documento || ''].join('|');
  return crypto.createHash('sha256').update(key).digest('hex');
}

function parseSantanderBuffer(buffer, { sociedad_id, banco = 'santander' }) {
  if (!sociedad_id) throw new Error('sociedad_id requerido');
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: null });

  const headerIdx = findHeaderRow(rows);
  if (headerIdx < 0) {
    return { movimientos: [], skipped: 0, header_found: false, sheet: sheetName };
  }

  const movimientos = [];
  let skipped = 0;
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const fechaRaw     = r[0];
    const fechaValorRaw= r[1];
    const conceptoRaw  = r[2];
    const importeRaw   = r[3];
    const codigoRaw    = r[7];
    const docRaw       = r[8];

    const fecha = toIsoDate(fechaRaw);
    const concepto = conceptoRaw == null ? '' : String(conceptoRaw).trim();
    const importe = toNumber(importeRaw);

    if (!fecha || !concepto || importe == null) { skipped++; continue; }

    const codigo_banco = codigoRaw == null ? null : String(codigoRaw).trim() || null;
    const num_documento = docRaw == null ? null : String(docRaw).trim() || null;
    const categoria = categorizar(concepto, importe);
    const subcategoria = extraerSubcategoria(concepto);
    const local_id = codigo_banco === '135' ? detectarLocal(concepto) : null;
    const periodo = periodoFromIso(fecha);
    const fecha_valor = toIsoDate(fechaValorRaw);

    const mov = {
      sociedad_id,
      banco,
      fecha,
      fecha_valor,
      concepto,
      importe,
      categoria,
      subcategoria,
      local_id,
      codigo_banco,
      num_documento,
      periodo,
    };
    mov.hash = hashRow({
      sociedad_id, fecha, concepto, importe,
      codigo_banco, num_documento,
    });
    movimientos.push(mov);
  }

  return { movimientos, skipped, header_found: true, sheet: sheetName, header_row: headerIdx + 1 };
}

module.exports = { parseSantanderBuffer, toIsoDate, toNumber, hashRow, findHeaderRow };
