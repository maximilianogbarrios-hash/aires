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
  {
    id: 9,
    name: 'reglas_normalizacion',
    up: `
      CREATE TABLE IF NOT EXISTS ab_reglas_normalizacion (
        id                     SERIAL PRIMARY KEY,
        patron                 VARCHAR(500) NOT NULL,
        tipo_match             VARCHAR(20)  NOT NULL DEFAULT 'ilike',
        categoria              VARCHAR(50)  NOT NULL,
        proveedor_normalizado  VARCHAR(200) NOT NULL,
        prioridad              INTEGER      NOT NULL DEFAULT 50,
        activo                 BOOLEAN      NOT NULL DEFAULT TRUE,
        creado_en              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        CONSTRAINT ab_reglas_norm_tipo_chk CHECK (tipo_match IN ('ilike','regex','exacto'))
      );
      CREATE INDEX IF NOT EXISTS ab_reglas_norm_activo_idx ON ab_reglas_normalizacion(activo, prioridad DESC);

      -- Columna para guardar el nombre canónico del proveedor por movimiento.
      -- Si está NULL, el endpoint /proveedores deriva el nombre con normalizarProveedor().
      ALTER TABLE ab_movimientos ADD COLUMN IF NOT EXISTS proveedor_normalizado VARCHAR(200) NULL;
      CREATE INDEX IF NOT EXISTS ab_movimientos_proveedor_norm_idx ON ab_movimientos(proveedor_normalizado);
    `,
  },
  {
    id: 10,
    name: 'gastos_direccion_overrides',
    up: `
      -- Overrides admin-managed sobre la membresía del slice "Gastos Dirección".
      -- Por default, los proveedores caen en el slice fusionado si su categoria
      -- está en CATEGORIAS_DIRECCION_FUSE. Esta tabla permite a admin/socio
      -- mover proveedores específicos:
      --   accion='include' → entra al grupo fusionado aunque su categoria no esté en el set
      --   accion='exclude' → sale del grupo aunque su categoria esté en el set
      CREATE TABLE IF NOT EXISTS ab_gastos_direccion_overrides (
        proveedor_normalizado VARCHAR(200) PRIMARY KEY,
        accion                VARCHAR(20)  NOT NULL,
        creado_en             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        creado_por            TEXT         NULL,
        CONSTRAINT ab_gd_overrides_accion_chk CHECK (accion IN ('include','exclude'))
      );
    `,
  },
  {
    // Auditoría de cambios al panel de Parámetros (% MP / Personal / Impuestos /
    // Publicidad / €/hora). Disparado por config_w cuando el rol es 'gerente'
    // (admin y socio editan sin log). Permite rastrear quién bajó márgenes
    // o subió costos.
    id: 11,
    name: 'parametros_historial',
    up: `
      CREATE TABLE IF NOT EXISTS ab_parametros_historial (
        id              SERIAL        PRIMARY KEY,
        usuario_email   VARCHAR(120)  NOT NULL,
        campo           VARCHAR(60)   NOT NULL,
        valor_anterior  NUMERIC(12,3) NULL,
        valor_nuevo     NUMERIC(12,3) NULL,
        fecha           TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS ab_parametros_historial_fecha_idx
        ON ab_parametros_historial(fecha DESC);
      CREATE INDEX IF NOT EXISTS ab_parametros_historial_usuario_idx
        ON ab_parametros_historial(usuario_email);
    `,
  },
  {
    // Marca a las reglas creadas manualmente desde el sidebar de
    // reclasificación para que el slice de ese proveedor nunca sea
    // absorbido por "Proveedores Menores" ni por el cap top-N de
    // /proveedores. Pensado para que la reclasificación del usuario
    // se materialice inmediatamente en el donut, aunque el importe
    // sea pequeño.
    id: 12,
    name: 'reglas_forzar_visible',
    up: `
      ALTER TABLE ab_reglas_normalizacion
        ADD COLUMN IF NOT EXISTS forzar_visible BOOLEAN NOT NULL DEFAULT FALSE;
      CREATE INDEX IF NOT EXISTS ab_reglas_norm_forzar_visible_idx
        ON ab_reglas_normalizacion(forzar_visible)
        WHERE forzar_visible = TRUE;
    `,
  },
  {
    // Módulo Materia Prima v2 — pedidos por volumen con distribución
    // automática a locales. Convive con ab_pedidos_semana (pestaña MP
    // original) sin reemplazarla. Diseño:
    //   - Pedido = cabecera (sociedad, proveedor, semana) + N líneas
    //     (producto × cantidad × precio).
    //   - Al confirmar, el sistema reparte el importe entre los locales
    //     de la sociedad según fac_presupuestada del mes (tabla
    //     ab_presupuesto). Distribución read-only para Fabricio.
    //   - Catálogo de precios por (proveedor, producto). Cambios
    //     auditados en histórico.
    //   - Conciliación 1:N con ab_movimientos via movimiento_banco_id
    //     en cabecera (1 débito puede cubrir N pedidos).
    id: 14,
    name: 'mp_v2_pedidos_volumen',
    up: `
      CREATE TABLE IF NOT EXISTS ab_mp_catalogo_precios (
        id                     SERIAL        PRIMARY KEY,
        proveedor_normalizado  VARCHAR(200)  NOT NULL,
        producto               VARCHAR(200)  NOT NULL,
        unidad                 VARCHAR(20)   NOT NULL,
        precio_ref             NUMERIC(10,4) NOT NULL,
        vigente_desde          DATE          NOT NULL DEFAULT CURRENT_DATE,
        actualizado_por        INT           NULL REFERENCES ab_users(id) ON DELETE SET NULL,
        notas_temporada        TEXT          NULL,
        activo                 BOOLEAN       NOT NULL DEFAULT TRUE,
        UNIQUE (proveedor_normalizado, producto)
      );
      CREATE INDEX IF NOT EXISTS ab_mp_cat_prov_idx
        ON ab_mp_catalogo_precios(proveedor_normalizado) WHERE activo = TRUE;

      CREATE TABLE IF NOT EXISTS ab_mp_pedidos_cabecera (
        id                       SERIAL         PRIMARY KEY,
        semana                   INT            NOT NULL CHECK (semana BETWEEN 1 AND 53),
        anio                     INT            NOT NULL,
        sociedad_id              VARCHAR(50)    NOT NULL,
        proveedor_normalizado    VARCHAR(200)   NOT NULL,
        estado                   VARCHAR(20)    NOT NULL DEFAULT 'borrador',
        importe_estimado         NUMERIC(12,2)  NULL,
        importe_real             NUMERIC(12,2)  NULL,
        fecha_creacion           TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
        fecha_confirmacion       TIMESTAMPTZ    NULL,
        fecha_pago               TIMESTAMPTZ    NULL,
        usuario_creacion         INT            NULL REFERENCES ab_users(id) ON DELETE SET NULL,
        notas                    TEXT           NULL,
        movimiento_banco_id      INT            NULL REFERENCES ab_movimientos(id) ON DELETE SET NULL,
        diferencia_conciliacion  NUMERIC(12,2)  NULL,
        nota_conciliacion        TEXT           NULL,
        CONSTRAINT ab_mp_ped_estado_chk CHECK (estado IN ('borrador','confirmado','recibido','facturado','pagado'))
      );
      CREATE INDEX IF NOT EXISTS ab_mp_ped_semana_idx
        ON ab_mp_pedidos_cabecera(anio, semana, sociedad_id);
      CREATE INDEX IF NOT EXISTS ab_mp_ped_estado_idx
        ON ab_mp_pedidos_cabecera(estado);
      CREATE INDEX IF NOT EXISTS ab_mp_ped_proveedor_idx
        ON ab_mp_pedidos_cabecera(proveedor_normalizado);
      CREATE INDEX IF NOT EXISTS ab_mp_ped_movimiento_idx
        ON ab_mp_pedidos_cabecera(movimiento_banco_id)
        WHERE movimiento_banco_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS ab_mp_pedidos_lineas (
        id                SERIAL         PRIMARY KEY,
        pedido_id         INT            NOT NULL REFERENCES ab_mp_pedidos_cabecera(id) ON DELETE CASCADE,
        producto          VARCHAR(200)   NOT NULL,
        cantidad          NUMERIC(10,3)  NOT NULL,
        unidad            VARCHAR(20)    NOT NULL,
        precio_estimado   NUMERIC(10,4)  NULL,
        precio_real       NUMERIC(10,4)  NULL,
        importe_estimado  NUMERIC(12,2)  NULL,
        importe_real      NUMERIC(12,2)  NULL,
        orden             INT            NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS ab_mp_lineas_pedido_idx
        ON ab_mp_pedidos_lineas(pedido_id);

      CREATE TABLE IF NOT EXISTS ab_mp_pedidos_distribucion (
        id                 SERIAL         PRIMARY KEY,
        pedido_id          INT            NOT NULL REFERENCES ab_mp_pedidos_cabecera(id) ON DELETE CASCADE,
        local_id           VARCHAR(50)    NOT NULL,
        pct_distribucion   NUMERIC(7,6)   NOT NULL,
        importe_estimado   NUMERIC(12,2)  NULL,
        importe_real       NUMERIC(12,2)  NULL,
        UNIQUE (pedido_id, local_id)
      );
      CREATE INDEX IF NOT EXISTS ab_mp_distr_pedido_idx
        ON ab_mp_pedidos_distribucion(pedido_id);
      CREATE INDEX IF NOT EXISTS ab_mp_distr_local_idx
        ON ab_mp_pedidos_distribucion(local_id);

      CREATE TABLE IF NOT EXISTS ab_mp_precios_historico (
        id                     SERIAL         PRIMARY KEY,
        proveedor_normalizado  VARCHAR(200)   NOT NULL,
        producto               VARCHAR(200)   NOT NULL,
        precio_anterior        NUMERIC(10,4)  NULL,
        precio_nuevo           NUMERIC(10,4)  NOT NULL,
        fecha                  TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
        usuario_id             INT            NULL REFERENCES ab_users(id) ON DELETE SET NULL,
        motivo                 VARCHAR(200)   NULL
      );
      CREATE INDEX IF NOT EXISTS ab_mp_precios_hist_prov_idx
        ON ab_mp_precios_historico(proveedor_normalizado, producto, fecha DESC);

      -- Seed: 4 productos para que la primera entrada al catálogo no
      -- aparezca vacía. Idempotente — ON CONFLICT DO NOTHING por la
      -- constraint UNIQUE(proveedor, producto).
      INSERT INTO ab_mp_catalogo_precios
        (proveedor_normalizado, producto, unidad, precio_ref, notas_temporada)
      VALUES
        ('Carnicas Mulas SL',    'Ternera picada 80/20',         'kg', 8.20, 'precio referencia 2026-Q2'),
        ('Carnicas Mulas SL',    'Pechuga de pollo fileteada',    'kg', 5.40, NULL),
        ('Carnicas Mulas SL',    'Costillas de cerdo',            'kg', 6.80, NULL),
        ('Don Hamgus SL',        'Pan brioche burguer',           'ud', 0.32, 'temporada estable')
      ON CONFLICT (proveedor_normalizado, producto) DO NOTHING;
    `,
  },
  {
    // Regla seed permanente para Raba Buildings → GASTOS_DIRECCION.
    // Cualquier movimiento (cualquier banco, sociedad, período) cuyo
    // concepto contenga "Raba" se clasifica como gasto de dirección.
    // No puede ser editada ni borrada (columna protegida=TRUE).
    // Aplicada en ingesta antes de cualquier otra regla (prioridad=999)
    // y con override sobre INTRAGRUPO (ver upload-extracto handler).
    // La migración también hace backfill de los movimientos históricos.
    id: 13,
    name: 'regla_seed_raba_protegida',
    up: `
      ALTER TABLE ab_reglas_normalizacion
        ADD COLUMN IF NOT EXISTS protegida BOOLEAN NOT NULL DEFAULT FALSE;

      -- Regla idempotente: insertar sólo si no existe ya una protegida
      -- apuntando a "Raba Buildings".
      INSERT INTO ab_reglas_normalizacion
        (patron, tipo_match, categoria, proveedor_normalizado, prioridad, activo, forzar_visible, protegida)
      SELECT 'raba', 'ilike', 'GASTOS_DIRECCION', 'Raba Buildings', 999, TRUE, TRUE, TRUE
      WHERE NOT EXISTS (
        SELECT 1 FROM ab_reglas_normalizacion
         WHERE protegida = TRUE AND proveedor_normalizado = 'Raba Buildings'
      );

      -- Backfill histórico: cualquier movimiento que contenga "raba" en
      -- concepto o proveedor_normalizado pasa a GASTOS_DIRECCION + 'Raba Buildings'.
      UPDATE ab_movimientos
         SET categoria = 'GASTOS_DIRECCION',
             proveedor_normalizado = 'Raba Buildings'
       WHERE (concepto ILIKE '%raba%' OR proveedor_normalizado ILIKE '%raba%')
         AND (categoria <> 'GASTOS_DIRECCION' OR proveedor_normalizado IS DISTINCT FROM 'Raba Buildings');
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
