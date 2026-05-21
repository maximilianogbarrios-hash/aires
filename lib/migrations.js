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
  {
    id: 4,
    name: 'expand_user_roles',
    up: `
      ALTER TABLE ab_users DROP CONSTRAINT IF EXISTS ab_users_role_check;
      ALTER TABLE ab_users ADD CONSTRAINT ab_users_role_check
        CHECK (role IN ('admin','socio','gerente','administrativo','pedidos','personal'));
    `,
  },
  {
    id: 3,
    name: 'bank_module',
    up: `
      CREATE TABLE IF NOT EXISTS ab_movimientos (
        id            SERIAL PRIMARY KEY,
        sociedad_id   VARCHAR(20)   NOT NULL,
        banco         VARCHAR(20)   NOT NULL,
        fecha         DATE          NOT NULL,
        fecha_valor   DATE          NULL,
        concepto      TEXT          NOT NULL,
        importe       NUMERIC(14,2) NOT NULL,
        categoria     VARCHAR(50)   NULL,
        subcategoria  VARCHAR(120)  NULL,
        local_id      VARCHAR(30)   NULL,
        codigo_banco  VARCHAR(10)   NULL,
        num_documento VARCHAR(60)   NULL,
        periodo       VARCHAR(7)    NOT NULL,
        hash          VARCHAR(64)   NOT NULL UNIQUE,
        created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS ab_movimientos_sociedad_periodo_idx ON ab_movimientos(sociedad_id, periodo);
      CREATE INDEX IF NOT EXISTS ab_movimientos_categoria_idx        ON ab_movimientos(categoria);
      CREATE INDEX IF NOT EXISTS ab_movimientos_local_idx            ON ab_movimientos(local_id);
      CREATE INDEX IF NOT EXISTS ab_movimientos_fecha_idx            ON ab_movimientos(fecha);

      CREATE TABLE IF NOT EXISTS ab_cierres_tpv (
        id               SERIAL PRIMARY KEY,
        local_id         VARCHAR(30)   NOT NULL,
        sociedad_id      VARCHAR(20)   NOT NULL,
        fecha_cierre     TIMESTAMPTZ   NOT NULL,
        num_ventas       INTEGER       NULL,
        num_devoluciones INTEGER       NOT NULL DEFAULT 0,
        importe_bruto    NUMERIC(14,2) NOT NULL,
        importe_neto     NUMERIC(14,2) NOT NULL,
        comision         NUMERIC(14,2) GENERATED ALWAYS AS (importe_bruto - importe_neto) STORED,
        tasa_comision    NUMERIC(8,6)  NULL,
        periodo          VARCHAR(7)    NOT NULL,
        hash             VARCHAR(64)   NOT NULL UNIQUE,
        created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS ab_cierres_tpv_local_periodo_idx ON ab_cierres_tpv(local_id, periodo);
      CREATE INDEX IF NOT EXISTS ab_cierres_tpv_sociedad_periodo_idx ON ab_cierres_tpv(sociedad_id, periodo);

      CREATE TABLE IF NOT EXISTS ab_cruces (
        id                  SERIAL PRIMARY KEY,
        sociedad_id         VARCHAR(20)   NOT NULL,
        local_id            VARCHAR(30)   NULL,
        periodo             VARCHAR(7)    NOT NULL,
        total_bruto_tpv     NUMERIC(14,2) NULL,
        total_neto_tpv      NUMERIC(14,2) NULL,
        total_comision_tpv  NUMERIC(14,2) NULL,
        total_banco         NUMERIC(14,2) NULL,
        diferencia          NUMERIC(14,2) NULL,
        tasa_efectiva       NUMERIC(8,6)  NULL,
        estado              VARCHAR(20)   NULL,
        updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ab_cruces_unique_key
        ON ab_cruces(sociedad_id, COALESCE(local_id, ''), periodo);

      CREATE TABLE IF NOT EXISTS ab_resumen_mensual (
        id                 SERIAL PRIMARY KEY,
        sociedad_id        VARCHAR(20)   NOT NULL,
        periodo            VARCHAR(7)    NOT NULL,
        total_ingresos     NUMERIC(14,2) NOT NULL DEFAULT 0,
        total_gastos       NUMERIC(14,2) NOT NULL DEFAULT 0,
        neto               NUMERIC(14,2) NOT NULL DEFAULT 0,
        detalle_categorias JSONB         NOT NULL DEFAULT '{}'::jsonb,
        n_movimientos      INTEGER       NOT NULL DEFAULT 0,
        updated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        UNIQUE (sociedad_id, periodo)
      );
    `,
  },
  {
    id: 5,
    name: 'facturacion_semanal',
    up: `
      CREATE TABLE IF NOT EXISTS ab_facturacion_semanal (
        local_id      VARCHAR(30)   NOT NULL,
        anio          INTEGER       NOT NULL,
        semana_iso    INTEGER       NOT NULL,
        fecha_lunes   DATE          NOT NULL,
        fecha_domingo DATE          NOT NULL,
        importe       NUMERIC(14,2) NOT NULL,
        fuente        VARCHAR(20)   NOT NULL DEFAULT 'manual',
        creado_en     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        PRIMARY KEY (local_id, anio, semana_iso)
      );
      CREATE INDEX IF NOT EXISTS ab_facturacion_semanal_local_idx ON ab_facturacion_semanal(local_id);
      CREATE INDEX IF NOT EXISTS ab_facturacion_semanal_fecha_idx ON ab_facturacion_semanal(fecha_lunes);
    `,
  },
  {
    id: 6,
    name: 'pedidos_proveedores_mix',
    up: `
      CREATE TABLE IF NOT EXISTS ab_proveedores_mix (
        local_id    VARCHAR(30)   NOT NULL,
        proveedor   VARCHAR(120)  NOT NULL,
        categoria   VARCHAR(40)   NOT NULL,
        porcentaje  NUMERIC(6,3)  NOT NULL DEFAULT 0,
        activo      BOOLEAN       NOT NULL DEFAULT TRUE,
        updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        PRIMARY KEY (local_id, proveedor, categoria)
      );
      CREATE INDEX IF NOT EXISTS ab_prov_mix_local_idx     ON ab_proveedores_mix(local_id);
      CREATE INDEX IF NOT EXISTS ab_prov_mix_proveedor_idx ON ab_proveedores_mix(proveedor);
      CREATE INDEX IF NOT EXISTS ab_prov_mix_categoria_idx ON ab_proveedores_mix(categoria);
    `,
  },
  {
    id: 7,
    name: 'pedidos_semana',
    up: `
      CREATE TABLE IF NOT EXISTS ab_pedidos_semana (
        local_id          VARCHAR(30)   NOT NULL,
        anio              INTEGER       NOT NULL,
        semana_iso        INTEGER       NOT NULL,
        proveedor         VARCHAR(120)  NOT NULL,
        categoria         VARCHAR(40)   NOT NULL DEFAULT 'materia_prima',
        importe_sugerido  NUMERIC(12,2) NOT NULL DEFAULT 0,
        importe_real      NUMERIC(12,2) NULL,
        estado            VARCHAR(15)   NOT NULL DEFAULT 'pendiente'
                          CHECK (estado IN ('pendiente','enviado','recibido')),
        notas             TEXT          NULL,
        created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        confirmado_en     TIMESTAMPTZ   NULL,
        confirmado_por    INTEGER       NULL,
        PRIMARY KEY (local_id, anio, semana_iso, proveedor)
      );
      CREATE INDEX IF NOT EXISTS ab_pedidos_sem_local_idx    ON ab_pedidos_semana(local_id);
      CREATE INDEX IF NOT EXISTS ab_pedidos_sem_periodo_idx  ON ab_pedidos_semana(anio, semana_iso);
      CREATE INDEX IF NOT EXISTS ab_pedidos_sem_estado_idx   ON ab_pedidos_semana(estado);
      CREATE INDEX IF NOT EXISTS ab_pedidos_sem_proveedor_idx ON ab_pedidos_semana(proveedor);
    `,
  },
  {
    // Persistencia de horas cargadas en la sub-pestaña Personal del módulo Pedidos.
    // Decisión: reutilizar la tabla ab_facturacion_semanal (mismo grano semanal
    // por local) en lugar de crear una tabla nueva. Una fila puede tener
    // facturación, horas, o ambos. Se hace importe NULLABLE y se agregan dos
    // columnas: horas (NUMERIC) y fuente_horas (string).
    // La agregación a ab_historial via maybeAggregateToHistorial se mantiene:
    // sigue filtrando filas con importe IS NOT NULL.
    id: 8,
    name: 'facturacion_semanal_horas',
    up: `
      ALTER TABLE ab_facturacion_semanal ALTER COLUMN importe DROP NOT NULL;
      ALTER TABLE ab_facturacion_semanal ADD COLUMN IF NOT EXISTS horas        NUMERIC(8,2) NULL;
      ALTER TABLE ab_facturacion_semanal ADD COLUMN IF NOT EXISTS fuente_horas VARCHAR(20)  NULL;
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
