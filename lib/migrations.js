const { pool } = require('./db');

const MIGRATIONS = [
  {
    id: 1,
    name: 'init_schema',
    up: `
      CREATE TABLE IF NOT EXISTS ab_users (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin','socio')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS ab_config (
        clave TEXT PRIMARY KEY,
        valor JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS ab_locales (
        id TEXT PRIMARY KEY,
        nombre_display TEXT NOT NULL,
        short_name TEXT NOT NULL,
        grupo TEXT NOT NULL CHECK (grupo IN ('A','B','C','D')),
        dani_only BOOLEAN NOT NULL DEFAULT FALSE,
        alquiler NUMERIC(12,2) NOT NULL DEFAULT 0,
        suministros NUMERIC(12,2) NOT NULL DEFAULT 0,
        fac_mi_analisis NUMERIC(12,2) NOT NULL DEFAULT 0,
        horas_sem_override NUMERIC(8,2) NULL,
        orden INT NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS ab_presupuesto (
        id SERIAL PRIMARY KEY,
        local_id TEXT NOT NULL REFERENCES ab_locales(id) ON DELETE CASCADE,
        anio INT NOT NULL,
        mes INT NOT NULL CHECK (mes BETWEEN 1 AND 12),
        fac_presupuestada NUMERIC(12,2) NULL,
        fac_real NUMERIC(12,2) NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (local_id, anio, mes)
      );

      CREATE TABLE IF NOT EXISTS ab_historial (
        id SERIAL PRIMARY KEY,
        local_id TEXT NOT NULL REFERENCES ab_locales(id) ON DELETE CASCADE,
        anio INT NOT NULL,
        mes INT NOT NULL CHECK (mes BETWEEN 1 AND 12),
        facturacion NUMERIC(12,2) NOT NULL DEFAULT 0,
        fuente TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (local_id, anio, mes, fuente)
      );

      CREATE TABLE IF NOT EXISTS ab_session (
        sid TEXT PRIMARY KEY,
        sess JSON NOT NULL,
        expire TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ab_session_expire_idx ON ab_session(expire);

      CREATE TABLE IF NOT EXISTS ab_migrations (
        id INT PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `,
  },
  {
    id: 2,
    name: 'add_2fa_to_users',
    up: `
      ALTER TABLE ab_users ADD COLUMN IF NOT EXISTS totp_secret TEXT NULL;
      ALTER TABLE ab_users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT FALSE;
    `,
  },
];

async function runMigrations() {
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS ab_migrations (
      id INT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const { rows } = await client.query('SELECT id FROM ab_migrations');
    const done = new Set(rows.map((r) => r.id));
    const ordered = [...MIGRATIONS].sort((a, b) => a.id - b.id);
    for (const m of ordered) {
      if (done.has(m.id)) {
        console.log(`[migrate] skip ${m.id} ${m.name}`);
        continue;
      }
      console.log(`[migrate] apply ${m.id} ${m.name}`);
      await client.query('BEGIN');
      try {
        await client.query(m.up);
        await client.query('INSERT INTO ab_migrations (id, name) VALUES ($1, $2)', [m.id, m.name]);
        await client.query('COMMIT');
        console.log(`[migrate] ok ${m.id}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    client.release();
  }
}

module.exports = { runMigrations };
