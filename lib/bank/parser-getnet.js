// Parser de informes de cierre TPV (Getnet / Santander).
//
// Layout esperado:
//   filas 1-8: metadata, incluyendo "Comercio: <NOMBRE>" en algún sitio
//   fila ~9: header con "Fecha de cierre", "Núm. Ventas", "Núm. Devoluc",
//            "Importe Neto", "Importe Bruto"
//   datos: fecha_cierre(col A/B), num_ventas(I), num_dev(J), importe_neto(M),
//          importe_bruto(O). Las columnas exactas varían, así que detectamos
//          dinámicamente por header.

const XLSX = require('xlsx');
const crypto = require('crypto');
const { toIsoDate, toNumber } = require('./parser-santander');
const { sociedadDeLocal } = require('./sociedades');
const { detectarLocal } = require('./categorizer');

function normLabel(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const r = rows[i] || [];
    const txt = r.map((c) => normLabel(c)).join('|');
    if (txt.includes('fecha') && (txt.includes('ventas') || txt.includes('bruto')) && txt.includes('neto')) {
      return { idx: i, cells: r };
    }
  }
  return null;
}

function columnMap(headerCells) {
  const map = { fecha: -1, ventas: -1, devol: -1, neto: -1, bruto: -1 };
  for (let i = 0; i < headerCells.length; i++) {
    const k = normLabel(headerCells[i]);
    if (!k) continue;
    if (map.fecha < 0 && /fecha.*cierre|cierre|fecha de cierre/.test(k)) map.fecha = i;
    if (map.fecha < 0 && k === 'fecha') map.fecha = i;
    if (map.ventas < 0 && /n[uú]m.*venta/.test(k)) map.ventas = i;
    if (map.devol < 0 && /n[uú]m.*devol/.test(k)) map.devol = i;
    if (map.neto < 0 && /importe.*neto|^neto$/.test(k)) map.neto = i;
    if (map.bruto < 0 && /importe.*bruto|^bruto$/.test(k)) map.bruto = i;
  }
  return map;
}

function buscarComercio(rows, maxRow = 20) {
  for (let i = 0; i < Math.min(rows.length, maxRow); i++) {
    const r = rows[i] || [];
    for (let j = 0; j < r.length; j++) {
      const k = normLabel(r[j]);
      if (k === 'comercio' || k.startsWith('comercio:')) {
        // Valor está en la celda siguiente o en el mismo string
        const sameCell = String(r[j] || '');
        const inline = /comercio\s*:\s*(.+)/i.exec(sameCell);
        if (inline) return inline[1].trim();
        const next = r[j + 1];
        if (next) return String(next).trim();
      }
    }
  }
  return null;
}

function hashCierre({ local_id, fechaIso, bruto, neto }) {
  const key = [local_id, fechaIso, bruto.toFixed(2), neto.toFixed(2)].join('|');
  return crypto.createHash('sha256').update(key).digest('hex');
}

function parseGetnetBuffer(buffer, { local_id_override = null } = {}) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: null });

  const header = findHeaderRow(rows);
  if (!header) {
    return { cierres: [], skipped: 0, header_found: false, sheet: sheetName };
  }
  const cols = columnMap(header.cells);
  if (cols.fecha < 0 || cols.neto < 0 || cols.bruto < 0) {
    return { cierres: [], skipped: 0, header_found: false, missing_cols: cols, sheet: sheetName };
  }

  const comercio = buscarComercio(rows, header.idx);
  const local_id = local_id_override || detectarLocal(comercio || '') || null;
  const sociedad_id = local_id ? sociedadDeLocal(local_id) : null;

  const cierres = [];
  let skipped = 0;
  for (let i = header.idx + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const fechaIso = toIsoDate(r[cols.fecha]);
    const neto = toNumber(r[cols.neto]);
    const bruto = toNumber(r[cols.bruto]);
    if (!fechaIso || neto == null || bruto == null) { skipped++; continue; }
    const num_ventas = cols.ventas >= 0 ? toNumber(r[cols.ventas]) : null;
    const num_dev = cols.devol >= 0 ? toNumber(r[cols.devol]) : null;
    const comision = bruto - neto;
    const tasa = bruto > 0 ? comision / bruto : null;
    const periodo = fechaIso.slice(0, 7);
    const cierre = {
      local_id,
      sociedad_id,
      fecha_cierre: fechaIso,
      num_ventas: num_ventas != null ? Math.round(num_ventas) : null,
      num_devoluciones: num_dev != null ? Math.round(num_dev) : 0,
      importe_bruto: bruto,
      importe_neto: neto,
      tasa_comision: tasa,
      periodo,
    };
    cierre.hash = hashCierre({ local_id: local_id || 'UNKNOWN', fechaIso, bruto, neto });
    cierres.push(cierre);
  }

  return {
    cierres, skipped, header_found: true, sheet: sheetName,
    header_row: header.idx + 1, comercio_detectado: comercio,
    local_id, sociedad_id,
  };
}

module.exports = { parseGetnetBuffer, findHeaderRow, columnMap, buscarComercio, hashCierre };
