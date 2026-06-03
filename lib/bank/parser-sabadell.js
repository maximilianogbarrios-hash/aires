// Parser de extractos XLS de Banco Sabadell.
//
// Layout esperado (1-indexed humanos, 0-indexed código):
//   row 1:   "Consulta de movimientos"
//   row 2:   timestamp DD/MM/YYYY HH:MM:SS
//   row 3:   ""
//   row 4:   ["Cuenta: ", "0081-XXXX-XX-XXXXXXXXXX", ...]
//   row 5:   ["Divisa: ", "EUR", ...]
//   row 6:   ["Titular:", "AIRES ALICANTE SL.", ...]
//   row 7:   ["Selección:", "Desde DD/MM/YYYY hasta DD/MM/YYYY.", ...]
//   row 8:   ""
//   row 9:   headers: F. Operativa | Concepto | F. Valor | Importe | Saldo | Referencia 1 | Referencia 2
//   row 10+: datos
//
// El parser detecta el bloque de headers buscando "concepto"+"importe"+"saldo"
// (mismo enfoque que el parser Santander XLS, tolerante a variantes).

const XLSX = require('xlsx');
const crypto = require('crypto');
const { categorizar, detectarLocal, extraerSubcategoria } = require('./categorizer');
const { findSociedad } = require('./sociedades');
const { TITULAR_PATRONES } = require('./parser-santander-pdf');

// Reutiliza el mapeo de TITULAR_PATRONES del parser PDF (es el mismo
// formato de razón social en el header del XLS).
function detectarSociedadDesdeRows(rows) {
  // Buscar en las primeras filas la celda "Titular:" y leer la siguiente.
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const r = rows[i] || [];
    for (let c = 0; c < r.length; c++) {
      const cell = String(r[c] || '').toLowerCase().trim();
      if (cell === 'titular:' || cell === 'titular') {
        const next = String(r[c + 1] || '').trim();
        for (const { rx, sociedad_id } of TITULAR_PATRONES) {
          if (rx.test(next)) return sociedad_id;
        }
      }
    }
  }
  return null;
}

function toIsoDate(cell) {
  if (cell == null || cell === '') return null;
  if (typeof cell === 'number') {
    const d = XLSX.SSF.parse_date_code(cell);
    if (!d) return null;
    return `${String(d.y).padStart(4, '0')}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  if (cell instanceof Date) {
    return `${cell.getFullYear()}-${String(cell.getMonth() + 1).padStart(2, '0')}-${String(cell.getDate()).padStart(2, '0')}`;
  }
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

// Sabadell exporta importes con punto decimal y coma de miles ("3,415.41",
// "-0.08"), al revés del formato europeo del Santander XLS. toNumber
// detecta automáticamente cuál es el separador decimal por su posición.
function toNumber(cell) {
  if (cell == null || cell === '') return null;
  if (typeof cell === 'number') return cell;
  let s = String(cell).trim().replace(/\s/g, '');
  // Heurística: si el último separador (. o ,) está a 1-2 chars del final,
  // es el decimal. Quitamos los otros (que son miles).
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot > lastComma && (s.length - lastDot) <= 3) {
    // decimal '.' → miles ','
    s = s.replace(/,/g, '');
  } else if (lastComma > lastDot && (s.length - lastComma) <= 3) {
    // decimal ',' → miles '.'
    s = s.replace(/\./g, '').replace(',', '.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const r = rows[i] || [];
    const txt = r.map((c) => String(c || '').toLowerCase()).join('|');
    if (txt.includes('concepto') && txt.includes('importe') && txt.includes('saldo')) return i;
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

function parseSabadellBuffer(buffer, { sociedad_id, banco = 'sabadell' } = {}) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: null });

  const sociedadDetectada = detectarSociedadDesdeRows(rows);
  const sociedadFinal = sociedad_id || sociedadDetectada;
  if (!sociedadFinal || !findSociedad(sociedadFinal)) {
    return {
      movimientos: [], skipped: 0, header_found: false,
      sociedad_detectada: sociedadDetectada,
      error: !sociedadFinal ? 'no se pudo detectar sociedad del titular'
        : `sociedad_id inválida: ${sociedadFinal}`,
    };
  }

  const headerIdx = findHeaderRow(rows);
  if (headerIdx < 0) {
    return {
      movimientos: [], skipped: 0, header_found: false,
      sociedad_detectada: sociedadDetectada,
    };
  }

  // Mapeo de columnas — Sabadell estándar:
  //   0: F. Operativa | 1: Concepto | 2: F. Valor | 3: Importe | 4: Saldo
  //   5: Referencia 1 | 6: Referencia 2
  // Detectamos los índices reales por nombre para tolerar variantes.
  const header = rows[headerIdx] || [];
  const idxOf = (name) => header.findIndex((c) => String(c || '').toLowerCase().includes(name));
  const cFOp = idxOf('operativa') >= 0 ? idxOf('operativa') : 0;
  const cConcepto = idxOf('concepto') >= 0 ? idxOf('concepto') : 1;
  const cFValor = idxOf('valor') >= 0 ? idxOf('valor') : 2;
  const cImporte = idxOf('importe') >= 0 ? idxOf('importe') : 3;
  const cRef1 = idxOf('referencia 1') >= 0 ? idxOf('referencia 1') : 5;
  const cRef2 = idxOf('referencia 2') >= 0 ? idxOf('referencia 2') : 6;

  const movimientos = [];
  let skipped = 0;
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const fecha = toIsoDate(r[cFOp]);
    const fechaValor = toIsoDate(r[cFValor]);
    const concepto = r[cConcepto] == null ? '' : String(r[cConcepto]).trim();
    const importe = toNumber(r[cImporte]);
    if (!fecha || !concepto || importe == null) { skipped++; continue; }

    // Sabadell usa "Referencia 1" para el código del local en líneas
    // ABONO TPV/COMISIONES (ej. 035424100201 → CREVILLENTE). Lo usamos
    // como num_documento para auditoría. La detección de local sigue
    // pasando por categorizer.detectarLocal() (que mira el concepto).
    const ref1 = r[cRef1] == null ? null : String(r[cRef1]).trim() || null;
    const ref2 = r[cRef2] == null ? null : String(r[cRef2]).trim() || null;
    const categoria = categorizar(concepto, importe);
    const subcategoria = extraerSubcategoria(concepto);
    const local_id = detectarLocal(concepto) || null;
    const periodo = periodoFromIso(fecha);

    const mov = {
      sociedad_id: sociedadFinal,
      banco,
      fecha,
      fecha_valor: fechaValor || fecha,
      concepto,
      importe,
      categoria,
      subcategoria,
      local_id,
      codigo_banco: ref1, // mismo slot que Santander XLS — usado por insertMovimientos como parte del hash
      num_documento: ref2,
      periodo,
    };
    mov.hash = hashRow({
      sociedad_id: sociedadFinal,
      fecha, concepto, importe,
      codigo_banco: ref1,
      num_documento: ref2,
    });
    movimientos.push(mov);
  }

  return {
    movimientos, skipped, header_found: true,
    source: 'sabadell-xls',
    sheet: sheetName,
    sociedad_detectada: sociedadDetectada,
    sociedad_final: sociedadFinal,
  };
}

module.exports = {
  parseSabadellBuffer,
  detectarSociedadDesdeRows,
  toNumber,
  toIsoDate,
};
