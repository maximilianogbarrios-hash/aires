// Carga inicial de costos por producto a ab_ventas_costos.
// Idempotente: upsert por nombre de producto (ON CONFLICT UPDATE).
//
// Uso:
//   node scripts/import-costos-tpv.js
//
// Valores entregados por el equipo de operaciones (Mayo 2026). El
// costo_mp viene ya con la mano de obra descontada — se carga aparte
// y el costo_total es la suma de los 3 componentes.

require('dotenv').config();
const { query, one } = require('../lib/db');

const COSTOS = [
  { producto: 'Carlota',                  familia: 'Burgers',    costo_mp: 3.4724, mano_obra: 0.50, costo_fritura: 0, costo_total: 3.9724 },
  { producto: 'HDP Burger',               familia: 'Burgers',    costo_mp: 2.9687, mano_obra: 0.50, costo_fritura: 0, costo_total: 3.4687 },
  { producto: 'HDP One',                  familia: 'Burgers',    costo_mp: 1.8716, mano_obra: 0.50, costo_fritura: 0, costo_total: 2.3716 },
  { producto: 'Kraken Burger',            familia: 'Burgers',    costo_mp: 3.4809, mano_obra: 0.50, costo_fritura: 0, costo_total: 3.9809 },
  { producto: 'Wilson Burger',            familia: 'Burgers',    costo_mp: 3.1597, mano_obra: 0.65, costo_fritura: 0, costo_total: 3.8097 },
  { producto: 'Wilson One',               familia: 'Burgers',    costo_mp: 2.0415, mano_obra: 0.50, costo_fritura: 0, costo_total: 2.5415 },
  { producto: 'La Mari Burger',           familia: 'Burgers',    costo_mp: 3.6639, mano_obra: 0.65, costo_fritura: 0, costo_total: 4.3139 },
  { producto: 'La Pendeja Burger',        familia: 'Burgers',    costo_mp: 1.8418, mano_obra: 0.65, costo_fritura: 0, costo_total: 2.4918 },
  { producto: 'Santa Monica Burger',      familia: 'Burgers',    costo_mp: 3.2840, mano_obra: 0.50, costo_fritura: 0, costo_total: 3.7840 },
  { producto: '8 Deuan',                  familia: 'Burgers',    costo_mp: 1.9874, mano_obra: 0.65, costo_fritura: 0, costo_total: 2.6374 },
  { producto: 'Motz Burger',              familia: 'Burgers',    costo_mp: 3.1637, mano_obra: 0.65, costo_fritura: 0, costo_total: 3.8137 },
  { producto: 'Flex Burger',              familia: 'Burgers',    costo_mp: 2.8793, mano_obra: 0.65, costo_fritura: 0, costo_total: 3.5293 },
  { producto: '7 Pecados Burger',         familia: 'Burgers',    costo_mp: 3.3587, mano_obra: 0.65, costo_fritura: 0, costo_total: 4.0087 },
  { producto: 'Grilled Mustard Burger',   familia: 'Burgers',    costo_mp: 2.9578, mano_obra: 0.65, costo_fritura: 0, costo_total: 3.6078 },
  { producto: 'Gran HDP',                 familia: 'Burgers',    costo_mp: 6.6188, mano_obra: 0.65, costo_fritura: 0, costo_total: 7.2688 },
  { producto: 'La Tina',                  familia: 'Burgers',    costo_mp: 3.5391, mano_obra: 0.65, costo_fritura: 0, costo_total: 4.1891 },
  { producto: 'Cheese Burger',            familia: 'Burgers',    costo_mp: 2.9304, mano_obra: 0.65, costo_fritura: 0, costo_total: 3.5804 },
  { producto: 'Menu MedioDia',            familia: 'MENÚS',      costo_mp: 2.8480, mano_obra: 0.50, costo_fritura: 0, costo_total: 3.3480 },
  { producto: 'Alitas Emmy',              familia: 'ENTRANTES',  costo_mp: 2.0823, mano_obra: 0.65, costo_fritura: 0, costo_total: 2.7323 },
  { producto: 'Pork Potatos',             familia: 'ENTRANTES',  costo_mp: 2.1237, mano_obra: 0.65, costo_fritura: 0, costo_total: 2.7737 },
  { producto: 'Chicken Potatoes',         familia: 'ENTRANTES',  costo_mp: 2.2942, mano_obra: 0.65, costo_fritura: 0, costo_total: 2.9442 },
  { producto: 'Patatas Ch+B',             familia: 'ENTRANTES',  costo_mp: 1.2748, mano_obra: 0.65, costo_fritura: 0, costo_total: 1.9248 },
  { producto: 'Nachos Ch+Guac',           familia: 'ENTRANTES',  costo_mp: 1.7426, mano_obra: 0.65, costo_fritura: 0, costo_total: 2.3926 },
  { producto: 'Nachos Poronga',           familia: 'ENTRANTES',  costo_mp: 2.8642, mano_obra: 0.65, costo_fritura: 0, costo_total: 3.5142 },
  { producto: 'Nachos nuevos',            familia: 'ENTRANTES',  costo_mp: 2.7323, mano_obra: 0.65, costo_fritura: 0, costo_total: 3.3823 },
  { producto: 'Patatas Perrunas',         familia: 'ENTRANTES',  costo_mp: 2.1237, mano_obra: 0.65, costo_fritura: 0, costo_total: 2.7737 },
  { producto: 'Pat. Raising Canes',       familia: 'ENTRANTES',  costo_mp: 1.7513, mano_obra: 0.50, costo_fritura: 0, costo_total: 2.2513 },
  { producto: 'Pat. Napolitans',          familia: 'ENTRANTES',  costo_mp: 2.4457, mano_obra: 0.50, costo_fritura: 0, costo_total: 2.9457 },
  { producto: 'Vacion Buns',              familia: 'ENTRANTES',  costo_mp: 2.0377, mano_obra: 0.65, costo_fritura: 0, costo_total: 2.6877 },
  { producto: 'Empanada Argentina',       familia: 'EMPANADAS',  costo_mp: 0.4444, mano_obra: 0.65, costo_fritura: 0, costo_total: 1.0944 },
  { producto: 'Empanada Wilson',          familia: 'EMPANADAS',  costo_mp: 0.4304, mano_obra: 0.65, costo_fritura: 0, costo_total: 1.0804 },
  { producto: 'Empanada Pendeja',         familia: 'EMPANADAS',  costo_mp: 0.4304, mano_obra: 0.65, costo_fritura: 0, costo_total: 1.0804 },
  { producto: 'Empanada Caprese',         familia: 'EMPANADAS',  costo_mp: 0.1356, mano_obra: 0.65, costo_fritura: 0, costo_total: 0.7856 },
  { producto: 'Fingers',                  familia: 'ENTRANTES',  costo_mp: 0.7277, mano_obra: 0.65, costo_fritura: 0, costo_total: 1.3777 },
  { producto: 'Cono de Crispetas',        familia: 'ENTRANTES',  costo_mp: 1.3093, mano_obra: 0.65, costo_fritura: 0, costo_total: 1.9593 },
  { producto: 'Buffalo Wrap',             familia: 'ENTRANTES',  costo_mp: 1.8922, mano_obra: 0.65, costo_fritura: 0, costo_total: 2.5422 },
  { producto: 'Caesar Wrap',              familia: 'ENTRANTES',  costo_mp: 1.9367, mano_obra: 0.65, costo_fritura: 0, costo_total: 2.5867 },
  { producto: 'Chicken Nachos',           familia: 'ENTRANTES',  costo_mp: 2.5163, mano_obra: 0.65, costo_fritura: 0, costo_total: 3.1663 },
  { producto: 'Patatas Provenzal',        familia: 'ENTRANTES',  costo_mp: 1.4655, mano_obra: 0.65, costo_fritura: 0, costo_total: 2.1155 },
  { producto: 'Pop Corn',                 familia: 'ENTRANTES',  costo_mp: 1.7426, mano_obra: 0.65, costo_fritura: 0, costo_total: 2.3926 },
  { producto: 'Suprema Napo',             familia: 'ENTRANTES',  costo_mp: 1.5321, mano_obra: 0.65, costo_fritura: 0, costo_total: 2.1821 },
  { producto: 'Huevos Rotos',             familia: 'ENTRANTES',  costo_mp: 2.1633, mano_obra: 0.50, costo_fritura: 0, costo_total: 2.6633 },
  { producto: 'Cheese Triple',            familia: 'Burgers',    costo_mp: 2.5635, mano_obra: 0.65, costo_fritura: 0, costo_total: 3.2135 },
];

async function main() {
  let inserted = 0, updated = 0;
  for (const c of COSTOS) {
    const r = await one(
      `INSERT INTO ab_ventas_costos
        (producto, familia, costo_mp, mano_obra, costo_fritura, costo_total)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (producto) DO UPDATE
         SET familia       = EXCLUDED.familia,
             costo_mp      = EXCLUDED.costo_mp,
             mano_obra     = EXCLUDED.mano_obra,
             costo_fritura = EXCLUDED.costo_fritura,
             costo_total   = EXCLUDED.costo_total,
             updated_at    = NOW()
       RETURNING id, (xmax = 0) AS inserted`,
      [c.producto, c.familia, c.costo_mp, c.mano_obra, c.costo_fritura, c.costo_total]
    );
    if (r.inserted) inserted++; else updated++;
  }
  console.log(`[costos] ✓ ${COSTOS.length} productos procesados · ${inserted} insertados · ${updated} actualizados`);
  process.exit(0);
}

if (require.main === module) {
  main().catch((e) => { console.error('[costos] ERROR', e); process.exit(1); });
}

module.exports = { COSTOS };
