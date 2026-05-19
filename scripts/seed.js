require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool, query, one } = require('../lib/db');
const { LOCALES, H25, HTOT_MENSUAL, DEFAULT_CONFIG } = require('../lib/seed-data');

async function seedUsers() {
  // ADMIN y SOCIO clásicos (compat con versión anterior)
  const base = [
    { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD, role: 'admin', label: 'ADMIN' },
    { email: process.env.SOCIO_EMAIL, password: process.env.SOCIO_PASSWORD, role: 'socio', label: 'SOCIO' },
  ];

  // USER1..USER10: USERn_EMAIL / USERn_PASSWORD / USERn_ROLE
  const { ROLES } = require('../lib/roles');
  const extras = [];
  for (let i = 1; i <= 10; i++) {
    const em = process.env[`USER${i}_EMAIL`];
    const pw = process.env[`USER${i}_PASSWORD`];
    const ro = (process.env[`USER${i}_ROLE`] || 'socio').toLowerCase();
    if (!em || !pw) continue;
    if (!ROLES.includes(ro)) {
      console.log(`[seed] USER${i}_ROLE inválido (${ro}), uso 'socio'`);
    }
    extras.push({ email: em, password: pw, role: ROLES.includes(ro) ? ro : 'socio', label: `USER${i}` });
  }

  const users = [...base, ...extras];
  for (const u of users) {
    if (!u.email || !u.password) {
      console.log(`[seed] skip ${u.label}: faltan vars ${u.label}_EMAIL/PASSWORD`);
      continue;
    }
    const exists = await one('SELECT id FROM ab_users WHERE email=$1', [u.email.toLowerCase()]);
    if (exists) {
      console.log(`[seed] user ${u.email} ya existe`);
      continue;
    }
    const hash = bcrypt.hashSync(u.password, 10);
    await query(
      'INSERT INTO ab_users (email, password_hash, role) VALUES ($1,$2,$3)',
      [u.email.toLowerCase(), hash, u.role]
    );
    console.log(`[seed] user ${u.email} (${u.role}) creado`);
  }
}

async function seedConfig() {
  for (const [k, v] of Object.entries(DEFAULT_CONFIG)) {
    const exists = await one('SELECT clave FROM ab_config WHERE clave=$1', [k]);
    if (exists) continue;
    await query(
      'INSERT INTO ab_config (clave, valor) VALUES ($1,$2)',
      [k, JSON.stringify(v)]
    );
    console.log(`[seed] config ${k} = ${JSON.stringify(v)}`);
  }
}

async function seedLocales() {
  for (const l of LOCALES) {
    const exists = await one('SELECT id FROM ab_locales WHERE id=$1', [l.id]);
    if (exists) continue;
    await query(
      `INSERT INTO ab_locales (id, nombre_display, short_name, grupo, dani_only, alquiler, suministros, fac_mi_analisis, orden)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [l.id, l.nombre_display, l.short, l.grupo, l.dani_only, l.alq, l.sum, l.mi, l.orden]
    );
    console.log(`[seed] local ${l.id}`);
  }
}

async function seedHistorial() {
  const r = await one('SELECT COUNT(*)::int AS c FROM ab_historial WHERE fuente=$1', ['2025_real']);
  if (r.c > 0) {
    console.log(`[seed] historial 2025: ya hay ${r.c} filas, skip`);
    return;
  }
  for (const [localId, arr] of Object.entries(H25)) {
    for (let i = 0; i < arr.length; i++) {
      await query(
        `INSERT INTO ab_historial (local_id, anio, mes, facturacion, fuente)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (local_id, anio, mes, fuente) DO NOTHING`,
        [localId, 2025, i + 1, arr[i], '2025_real']
      );
    }
  }
  console.log('[seed] historial 2025 cargado');

  // Totales agregados: guardamos como local_id 'TOTAL_AGREGADO' virtual (no es referencia FK)
  // Mejor: usar tabla aparte sería más limpio, pero por simplicidad guardamos vía historial sólo locales.
  // Los HTOT van a una tabla aparte. Lo dejamos para v2 si hace falta — el front igual los puede sumar.
}

(async () => {
  try {
    await seedUsers();
    await seedConfig();
    await seedLocales();
    await seedHistorial();
    console.log('[seed] done');
  } catch (e) {
    console.error('[seed] failed:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
