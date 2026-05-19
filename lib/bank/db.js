// Capa de DB del módulo bancario.
// - Bulk insert de movimientos / cierres con ON CONFLICT DO NOTHING (hash UNIQUE).
// - Recalc de ab_resumen_mensual y ab_cruces por sociedad/periodo afectados.

const { query, one, many, tx } = require('../db');

async function insertMovimientos(movs) {
  if (!movs.length) return { inserted: 0, duplicated: 0 };
  let inserted = 0;
  await tx(async (client) => {
    for (const m of movs) {
      const r = await client.query(
        `INSERT INTO ab_movimientos
           (sociedad_id, banco, fecha, fecha_valor, concepto, importe, categoria,
            subcategoria, local_id, codigo_banco, num_documento, periodo, hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (hash) DO NOTHING
         RETURNING id`,
        [
          m.sociedad_id, m.banco, m.fecha, m.fecha_valor, m.concepto, m.importe,
          m.categoria, m.subcategoria, m.local_id, m.codigo_banco, m.num_documento,
          m.periodo, m.hash,
        ]
      );
      if (r.rowCount > 0) inserted++;
    }
  });
  return { inserted, duplicated: movs.length - inserted };
}

async function insertCierres(cierres) {
  if (!cierres.length) return { inserted: 0, duplicated: 0 };
  let inserted = 0;
  await tx(async (client) => {
    for (const c of cierres) {
      const r = await client.query(
        `INSERT INTO ab_cierres_tpv
           (local_id, sociedad_id, fecha_cierre, num_ventas, num_devoluciones,
            importe_bruto, importe_neto, tasa_comision, periodo, hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (hash) DO NOTHING
         RETURNING id`,
        [
          c.local_id, c.sociedad_id, c.fecha_cierre, c.num_ventas, c.num_devoluciones,
          c.importe_bruto, c.importe_neto, c.tasa_comision, c.periodo, c.hash,
        ]
      );
      if (r.rowCount > 0) inserted++;
    }
  });
  return { inserted, duplicated: cierres.length - inserted };
}

async function recalcResumenMensual(sociedad_id, periodo) {
  const movs = await many(
    `SELECT categoria, importe::float8 AS importe
     FROM ab_movimientos
     WHERE sociedad_id=$1 AND periodo=$2`,
    [sociedad_id, periodo]
  );
  let ingresos = 0, gastos = 0;
  const detalle = {};
  for (const m of movs) {
    if (m.importe > 0) ingresos += m.importe; else gastos += m.importe;
    const k = m.categoria || (m.importe > 0 ? 'INGRESO_OTROS' : 'GASTO_OTROS');
    detalle[k] = (detalle[k] || 0) + m.importe;
  }
  await query(
    `INSERT INTO ab_resumen_mensual
       (sociedad_id, periodo, total_ingresos, total_gastos, neto, detalle_categorias, n_movimientos, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, NOW())
     ON CONFLICT (sociedad_id, periodo) DO UPDATE
       SET total_ingresos=EXCLUDED.total_ingresos,
           total_gastos=EXCLUDED.total_gastos,
           neto=EXCLUDED.neto,
           detalle_categorias=EXCLUDED.detalle_categorias,
           n_movimientos=EXCLUDED.n_movimientos,
           updated_at=NOW()`,
    [sociedad_id, periodo, ingresos, gastos, ingresos + gastos, JSON.stringify(detalle), movs.length]
  );
}

async function recalcCruce(sociedad_id, periodo, local_id = null) {
  // TPV: sumar cierres del local (o de toda la sociedad si local_id=null)
  let tpvQ = `SELECT COALESCE(SUM(importe_bruto),0)::float8 AS bruto,
                     COALESCE(SUM(importe_neto),0)::float8  AS neto
              FROM ab_cierres_tpv
              WHERE sociedad_id=$1 AND periodo=$2`;
  const tpvP = [sociedad_id, periodo];
  if (local_id) { tpvQ += ' AND local_id=$3'; tpvP.push(local_id); }
  const tpv = await one(tpvQ, tpvP);

  // Banco: suma de codigo_banco=135 (liquidación TPV) del periodo
  let bancoQ = `SELECT COALESCE(SUM(importe),0)::float8 AS total
                FROM ab_movimientos
                WHERE sociedad_id=$1 AND periodo=$2 AND codigo_banco='135'`;
  const bancoP = [sociedad_id, periodo];
  if (local_id) { bancoQ += ' AND local_id=$3'; bancoP.push(local_id); }
  const banco = await one(bancoQ, bancoP);

  const bruto = +tpv.bruto || 0;
  const neto = +tpv.neto || 0;
  const total_banco = +banco.total || 0;
  const comision = bruto - neto;
  const tasa_efectiva = bruto > 0 ? comision / bruto : null;
  const diferencia = total_banco - neto;
  const abs = Math.abs(diferencia);
  let estado = 'PENDIENTE';
  if (bruto === 0 && total_banco === 0) estado = 'PENDIENTE';
  else if (abs < 10) estado = 'OK';
  else if (abs <= 100) estado = 'DIFERENCIA_MENOR';
  else estado = 'DIFERENCIA';

  await query(
    `INSERT INTO ab_cruces
       (sociedad_id, local_id, periodo, total_bruto_tpv, total_neto_tpv,
        total_comision_tpv, total_banco, diferencia, tasa_efectiva, estado, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW())
     ON CONFLICT (sociedad_id, COALESCE(local_id, ''), periodo) DO UPDATE
       SET total_bruto_tpv=EXCLUDED.total_bruto_tpv,
           total_neto_tpv=EXCLUDED.total_neto_tpv,
           total_comision_tpv=EXCLUDED.total_comision_tpv,
           total_banco=EXCLUDED.total_banco,
           diferencia=EXCLUDED.diferencia,
           tasa_efectiva=EXCLUDED.tasa_efectiva,
           estado=EXCLUDED.estado,
           updated_at=NOW()`,
    [sociedad_id, local_id, periodo, bruto, neto, comision, total_banco, diferencia, tasa_efectiva, estado]
  );
}

// Re-procesa todos los locales (incluyendo NULL=total sociedad) para periodos afectados.
async function recalcCrucesParaSociedadPeriodo(sociedad_id, periodo) {
  const locals = await many(
    `SELECT DISTINCT local_id FROM ab_cierres_tpv WHERE sociedad_id=$1 AND periodo=$2 AND local_id IS NOT NULL`,
    [sociedad_id, periodo]
  );
  for (const r of locals) {
    await recalcCruce(sociedad_id, periodo, r.local_id);
  }
  // total sociedad
  await recalcCruce(sociedad_id, periodo, null);
}

module.exports = {
  insertMovimientos,
  insertCierres,
  recalcResumenMensual,
  recalcCruce,
  recalcCrucesParaSociedadPeriodo,
};
