// Simulador de rentabilidad por local — helpers puros.
//
// La lógica de cálculo del "aporte" del local está en el frontend
// (recalculo en vivo). Este módulo solo trae:
//   1. Los parámetros persistidos por local (ab_simulador_local).
//   2. La facturación auto por local en el período (SUM importe_neto
//      de ab_cierres_tpv, mapeando local_id → TPV local_id).
//   3. El neto OPERATIVO del período (mismo cálculo que /flujo-total,
//      sin extraordinarios ni intragrupo).

const { many, one, query } = require('../db');
const { SOCIEDADES, LOCAL_TO_SOCIEDAD, DIRECCIONES } = require('./sociedades');
const { esIntraGrupo } = require('./normalizers');
const { esTraspasoInternoBanco, esTraspasoInternoCaja } = require('../caja/proveedor-caja');

// Etiqueta legible para el UI.
function nombreLocal(localId) {
  if (!localId) return '';
  // Convertir MURCIA_MERCED → "Murcia Merced", CHICKEN_THADER → "Chicken Thader"
  return String(localId).split('_').map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
}

function listAllLocales() {
  const out = [];
  for (const s of SOCIEDADES) {
    for (const l of s.locales) {
      out.push({
        local_id: l, sociedad_id: s.id,
        sociedad_nombre: s.nombre,
        nombre_display: nombreLocal(l),
        direccion: DIRECCIONES[l] || null,
      });
    }
  }
  return out;
}

// GET parámetros del simulador. Devuelve una fila por local (aunque
// no exista en ab_simulador_local — con defaults).
async function fetchSimuladorParams() {
  const rows = await many('SELECT * FROM ab_simulador_local');
  const byId = new Map();
  for (const r of rows) byId.set(r.local_id, r);
  const all = listAllLocales();
  return all.map((l) => {
    const r = byId.get(l.local_id) || {};
    return {
      ...l,
      personal_ss: r.personal_ss != null ? Number(r.personal_ss) : null,
      alquiler: r.alquiler != null ? Number(r.alquiler) : null,
      suministros: r.suministros != null ? Number(r.suministros) : null,
      facturacion_override: r.facturacion_override != null ? Number(r.facturacion_override) : null,
      pct_mp: r.pct_mp != null ? Number(r.pct_mp) : 38,
      pct_personal_evitable: r.pct_personal_evitable != null ? Number(r.pct_personal_evitable) : 100,
      notas: r.notas || null,
      updated_at: r.updated_at || null,
      updated_by_email: r.updated_by_email || null,
    };
  });
}

async function upsertParams(localId, patch, email) {
  // Whitelist estricta de campos editables — nadie tira SQL raro.
  const FIELDS = ['personal_ss', 'alquiler', 'suministros', 'facturacion_override',
                  'pct_mp', 'pct_personal_evitable', 'notas'];
  const cols = ['local_id'];
  const vals = [localId];
  const updates = [];
  const numericFields = new Set(['personal_ss', 'alquiler', 'suministros', 'facturacion_override', 'pct_mp', 'pct_personal_evitable']);
  for (const f of FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(patch, f)) continue;
    let v = patch[f];
    if (v === '' || v === undefined) v = null;
    if (numericFields.has(f) && v != null) {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`campo ${f} no es número`);
      v = n;
    }
    cols.push(f);
    vals.push(v);
    updates.push(`${f} = EXCLUDED.${f}`);
  }
  cols.push('updated_at', 'updated_by_email');
  vals.push(new Date().toISOString(), email || null);
  updates.push('updated_at = EXCLUDED.updated_at', 'updated_by_email = EXCLUDED.updated_by_email');
  const placeholders = vals.map((_, i) => `$${i + 1}`).join(',');
  await query(
    `INSERT INTO ab_simulador_local (${cols.join(',')})
     VALUES (${placeholders})
     ON CONFLICT (local_id) DO UPDATE SET ${updates.join(', ')}`,
    vals
  );
  return one('SELECT * FROM ab_simulador_local WHERE local_id = $1', [localId]);
}

// Facturación por local en el período (SUM importe_neto TPV).
// El módulo TPV persiste UN registro por cierre diario — sumar en el
// rango da la facturación TPV real. NO incluye Glovo / delivery ni
// efectivo directo por ahora (roadmap futuro).
async function fetchFacturacionAuto({ desde, hasta } = {}) {
  const conds = ['importe_neto IS NOT NULL', 'local_id IS NOT NULL'];
  const vals = [];
  if (desde) { conds.push(`fecha_cierre >= $${vals.length + 1}`); vals.push(desde); }
  if (hasta) { conds.push(`fecha_cierre <= $${vals.length + 1}::timestamp + INTERVAL '1 day'`); vals.push(hasta); }
  const rows = await many(
    `SELECT local_id, SUM(importe_neto)::float8 AS facturacion, COUNT(*)::int AS n_cierres
       FROM ab_cierres_tpv
      WHERE ${conds.join(' AND ')}
      GROUP BY local_id`,
    vals
  );
  const map = new Map();
  for (const r of rows) map.set(r.local_id, { facturacion: r.facturacion || 0, n_cierres: r.n_cierres || 0 });
  return map;
}

// Neto OPERATIVO del período (mismo cálculo que /flujo-total).
async function fetchNetoOperativo({ sociedad_id, desde, hasta }) {
  // Banco: excluir INTRAGRUPO (categoría o esIntraGrupo), traspasos internos
  // y extraordinarios.
  const condsB = [`categoria <> 'INTRAGRUPO'`];
  const valsB = [];
  if (sociedad_id === 'sin_elche')       { condsB.push(`sociedad_id <> $${valsB.length + 1}`); valsB.push('hostelero'); }
  else if (sociedad_id === 'solo_elche') { condsB.push(`sociedad_id  = $${valsB.length + 1}`); valsB.push('hostelero'); }
  else if (sociedad_id && sociedad_id !== 'todas') {
    condsB.push(`sociedad_id = $${valsB.length + 1}`); valsB.push(sociedad_id);
  }
  if (desde) { condsB.push(`fecha >= $${valsB.length + 1}`); valsB.push(desde); }
  if (hasta) { condsB.push(`fecha <= $${valsB.length + 1}`); valsB.push(hasta); }
  const bancoRows = await many(
    `SELECT concepto, categoria, importe::float8 AS importe,
            COALESCE(es_extraordinario, FALSE) AS es_extraordinario
       FROM ab_movimientos WHERE ${condsB.join(' AND ')}`,
    valsB
  );
  let ingB = 0, gasB = 0;
  for (const r of bancoRows) {
    if (esTraspasoInternoBanco(r.concepto)) continue;
    if (esIntraGrupo(r.concepto)) continue;
    if (r.es_extraordinario) continue;
    if (r.importe > 0) ingB += r.importe;
    else gasB += Math.abs(r.importe);
  }
  // Caja.
  const condsC = ['1=1'];
  const valsC = [];
  if (sociedad_id === 'sin_elche')       { condsC.push(`(sociedad_id IS NULL OR sociedad_id <> $${valsC.length + 1})`); valsC.push('hostelero'); }
  else if (sociedad_id === 'solo_elche') { condsC.push(`sociedad_id  = $${valsC.length + 1}`); valsC.push('hostelero'); }
  else if (sociedad_id && sociedad_id !== 'todas') {
    condsC.push(`sociedad_id = $${valsC.length + 1}`); valsC.push(sociedad_id);
  }
  if (desde) { condsC.push(`fecha >= $${valsC.length + 1}`); valsC.push(desde); }
  if (hasta) { condsC.push(`fecha <= $${valsC.length + 1}`); valsC.push(hasta); }
  const cajaRows = await many(
    `SELECT tipo, subtipo, observaciones, monto::float8 AS monto
       FROM ab_caja_movimientos WHERE ${condsC.join(' AND ')}`,
    valsC
  );
  let ingC = 0, gasC = 0;
  for (const r of cajaRows) {
    if (esTraspasoInternoCaja(r.subtipo, r.observaciones)) continue;
    const t = (r.tipo || '').toLowerCase();
    if (t === 'ingreso') ingC += r.monto;
    else if (t === 'egreso') gasC += r.monto;
  }
  return {
    ingresos_operativo: Math.round((ingB + ingC) * 100) / 100,
    egresos_operativo:  Math.round((gasB + gasC) * 100) / 100,
    neto_operativo:     Math.round((ingB + ingC - gasB - gasC) * 100) / 100,
  };
}

module.exports = {
  listAllLocales, nombreLocal,
  fetchSimuladorParams, upsertParams,
  fetchFacturacionAuto, fetchNetoOperativo,
};
