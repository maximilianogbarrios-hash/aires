// scripts/calcular-mix-inicial.js — pobla ab_proveedores_mix con datos
// reales de ab_movimientos (categorías PROVEEDOR_*) de los últimos N meses.
//
// Uso:
//   node scripts/calcular-mix-inicial.js                    → dry-run
//   node scripts/calcular-mix-inicial.js --apply           → upsert real
//   node scripts/calcular-mix-inicial.js --apply --reset   → vacía ab_proveedores_mix y reescribe
//
// El % se calcula sobre el TOTAL de gasto MP del local en el período (no
// dentro de cada categoría, alineado con cómo lo usa el módulo Pedidos).

require('dotenv').config();
const { pool, many, query, tx } = require('../lib/db');
const { normalizarProveedor } = require('../lib/bank/normalizers');
const { SOCIEDADES } = require('../lib/bank/sociedades');

const APPLY = process.argv.includes('--apply');
const RESET = process.argv.includes('--reset');
const MESES = (() => {
  const i = process.argv.indexOf('--meses');
  return i >= 0 && process.argv[i + 1] ? +process.argv[i + 1] : 6;
})();

// Mapeo de categoría_banco (PROVEEDOR_*) a categoría_mp del módulo Pedidos.
const CAT_BANCO_TO_MP = {
  PROVEEDOR_CARNES:    'Carnes',
  PROVEEDOR_PANADERIA: 'Otros MP',
  PROVEEDOR_FRITAS:    'Otros MP',
  PROVEEDOR_LACTEOS:   'Lácteos',
  PROVEEDOR_ACEITES:   'Otros MP',
  PROVEEDOR_BEBIDAS:   'Bebidas',
  PROVEEDOR_MAKRO:     'Otros MP',
  PROVEEDOR_LIMPIEZA:  'Limpieza',
  PROVEEDOR_PACKAGING: 'Packaging',
  PROVEEDOR_OTROS:     'Otros MP',
};

async function main() {
  console.log('[mix] modo:', APPLY ? (RESET ? 'APPLY + RESET' : 'APPLY (merge)') : 'DRY-RUN');
  console.log('[mix] ventana:', MESES, 'meses');

  // 1) Traer movimientos PROVEEDOR_* por sociedad. Los pagos a proveedores se
  //    hacen a nivel de sociedad (no de local), así que el mix de cada local
  //    arranca como el promedio de su sociedad. El usuario después afina por
  //    local desde la UI.
  const rows = await many(
    `SELECT id, concepto, importe::float8 AS importe, categoria, sociedad_id
       FROM ab_movimientos
      WHERE importe < 0
        AND categoria = ANY($1::text[])
        AND sociedad_id IS NOT NULL
        AND fecha >= (CURRENT_DATE - ($2::int || ' months')::interval)`,
    [Object.keys(CAT_BANCO_TO_MP), MESES]
  );
  console.log(`[mix] ${rows.length} movimientos PROVEEDOR_* con sociedad en los últimos ${MESES} meses`);

  // 2) agrupar por (sociedad, proveedor canónico, categoria_mp) y luego
  //    replicar a cada local de la sociedad.
  const aggSoc = new Map(); // 'soc|prov|cat_mp' -> {soc, prov, cat_mp, total}
  const totalPorSoc = new Map(); // soc -> total
  for (const r of rows) {
    const { proveedor } = normalizarProveedor(r.concepto, r.categoria);
    const catMp = CAT_BANCO_TO_MP[r.categoria] || 'Otros MP';
    const abs = Math.abs(+r.importe);
    const k = `${r.sociedad_id}|${proveedor}|${catMp}`;
    const cur = aggSoc.get(k) || { soc: r.sociedad_id, prov: proveedor, cat_mp: catMp, total: 0 };
    cur.total += abs;
    aggSoc.set(k, cur);
    totalPorSoc.set(r.sociedad_id, (totalPorSoc.get(r.sociedad_id) || 0) + abs);
  }

  // Expandir sociedad → locales.
  const localesPorSoc = Object.fromEntries(SOCIEDADES.map((s) => [s.id, s.locales]));
  const agg = new Map();
  const totalPorLocal = new Map();
  for (const { soc, prov, cat_mp, total } of aggSoc.values()) {
    const tot = totalPorSoc.get(soc) || 0;
    const pct = tot > 0 ? (total / tot) * 100 : 0;
    for (const local of (localesPorSoc[soc] || [])) {
      const k = `${local}|${prov}|${cat_mp}`;
      agg.set(k, { local, prov, cat_mp, total: pct, pct });
      totalPorLocal.set(local, (totalPorLocal.get(local) || 0) + pct);
    }
  }

  // 3) filtrar proveedores con < 0.5% (ruido).
  const filas = [];
  for (const { local, prov, cat_mp, pct } of agg.values()) {
    if (pct < 0.5) continue;
    filas.push({ local, prov, cat_mp, pct: Math.round(pct * 10) / 10, total: pct });
  }
  filas.sort((a, b) => a.local.localeCompare(b.local) || b.total - a.total);

  console.log(`[mix] filas candidatas: ${filas.length}`);
  // Vista previa: top 5 por local
  const porLoc = new Map();
  for (const f of filas) {
    if (!porLoc.has(f.local)) porLoc.set(f.local, []);
    porLoc.get(f.local).push(f);
  }
  console.log('--- preview por local (top 5) ---');
  for (const [loc, list] of porLoc.entries()) {
    const sum = list.reduce((s, f) => s + f.pct, 0);
    console.log(`  ${loc} (${list.length} provs, suma=${sum.toFixed(1)}%):`);
    for (const f of list.slice(0, 5)) {
      console.log(`    - ${f.pct.toString().padStart(5)}%  ${f.cat_mp.padEnd(10)} ${f.prov}`);
    }
  }

  if (!APPLY) {
    console.log('[mix] DRY-RUN — pasá --apply para insertar.');
    return;
  }

  // 4) escribir.
  let upserted = 0, deleted = 0;
  await tx(async (client) => {
    if (RESET) {
      const d = await client.query('DELETE FROM ab_proveedores_mix');
      deleted = d.rowCount;
    }
    for (const f of filas) {
      const r = await client.query(
        `INSERT INTO ab_proveedores_mix (local_id, proveedor, categoria, porcentaje, activo)
         VALUES ($1, $2, $3, $4, TRUE)
         ON CONFLICT (local_id, proveedor, categoria)
         DO UPDATE SET porcentaje = EXCLUDED.porcentaje, activo = TRUE, updated_at = NOW()`,
        [f.local, f.prov, f.cat_mp, f.pct]
      );
      upserted += r.rowCount;
    }
  });
  console.log(`[mix] upserted=${upserted} deleted=${deleted}`);
}

main()
  .then(() => pool.end())
  .catch((e) => { console.error('[mix] error:', e); pool.end().finally(() => process.exit(1)); });
