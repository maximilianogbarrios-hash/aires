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
  {
    // Módulo Ventas — datos del TPV importados desde Excel mensual.
    // ab_ventas_uploads guarda metadata de cada archivo subido (períodos,
    // locales detectados, quién lo subió). ab_ventas_tpv tiene una fila
    // por línea de producto del TPV, con FK al upload para borrar/reimportar
    // en bloque. Idempotencia: el script de importación borra el upload
    // anterior con mismo (nombre_archivo, fecha_desde, fecha_hasta) antes
    // de reimportar — la FK con ON DELETE CASCADE limpia las líneas.
    id: 15,
    name: 'ventas_tpv',
    up: `
      CREATE TABLE IF NOT EXISTS ab_ventas_uploads (
        id                   SERIAL        PRIMARY KEY,
        nombre_archivo       VARCHAR(300)  NOT NULL,
        periodo_descripcion  VARCHAR(100)  NULL,
        fecha_desde          DATE          NULL,
        fecha_hasta          DATE          NULL,
        total_lineas         INTEGER       NULL,
        locales_detectados   JSONB         NULL,
        estado               VARCHAR(20)   NOT NULL DEFAULT 'pendiente'
                              CHECK (estado IN ('pendiente','procesando','ok','error')),
        error_detalle        TEXT          NULL,
        subido_por           INTEGER       NULL REFERENCES ab_users(id),
        created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS ab_ventas_uploads_fechas_idx
        ON ab_ventas_uploads(fecha_desde, fecha_hasta);

      CREATE TABLE IF NOT EXISTS ab_ventas_tpv (
        id              SERIAL         PRIMARY KEY,
        -- Temporalidad
        fecha           DATE           NOT NULL,
        anio            INTEGER        NOT NULL,
        mes             INTEGER        NOT NULL CHECK (mes BETWEEN 1 AND 12),
        semana          INTEGER        NOT NULL,
        -- dia: numeración ISO 1=Lunes ... 7=Domingo (formato que usa el TPV).
        dia             INTEGER        NOT NULL CHECK (dia BETWEEN 1 AND 7),
        -- Producto
        familia         VARCHAR(100)   NULL,
        categorias      TEXT           NULL,
        producto        VARCHAR(200)   NOT NULL,
        -- Cantidades y montos
        cantidad        NUMERIC(10,3)  NOT NULL,
        base            NUMERIC(10,2)  NULL,
        total           NUMERIC(10,2)  NULL,
        coste           NUMERIC(10,2)  NULL,
        margen          NUMERIC(10,2)  NULL,
        -- Ubicación y canal
        local           VARCHAR(100)   NOT NULL,
        tpv             VARCHAR(100)   NULL,
        centro_venta    VARCHAR(100)   NULL,
        es_glovo        BOOLEAN        GENERATED ALWAYS AS (
                          UPPER(COALESCE(centro_venta, '')) LIKE '%GLOVO%'
                        ) STORED,
        -- Operador
        perfil          VARCHAR(100)   NULL,
        usuario         VARCHAR(100)   NULL,
        -- Comercial
        descuento       VARCHAR(100)   NULL,
        promocion       VARCHAR(200)   NULL,
        periodo         VARCHAR(20)    NULL,
        -- Control de carga
        upload_id       INTEGER        NOT NULL REFERENCES ab_ventas_uploads(id) ON DELETE CASCADE,
        created_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_ventas_fecha       ON ab_ventas_tpv(fecha);
      CREATE INDEX IF NOT EXISTS idx_ventas_local_mes   ON ab_ventas_tpv(local, mes, anio);
      CREATE INDEX IF NOT EXISTS idx_ventas_producto    ON ab_ventas_tpv(producto);
      CREATE INDEX IF NOT EXISTS idx_ventas_upload      ON ab_ventas_tpv(upload_id);
      CREATE INDEX IF NOT EXISTS idx_ventas_anio_semana ON ab_ventas_tpv(anio, semana);
      CREATE INDEX IF NOT EXISTS idx_ventas_glovo       ON ab_ventas_tpv(es_glovo);
    `,
  },
  {
    // Fix: el TPV usa numeración ISO 1=Lunes…7=Domingo, no 0-6.
    // La migration 15 original tenía CHECK (dia BETWEEN 0 AND 6) que
    // hacía fallar el INSERT con valores reales.  Cualquier instalación
    // creada antes de este fix necesita el ALTER; las fresh ya nacen
    // con la constraint correcta (migration 15 fue actualizada también).
    id: 16,
    name: 'ventas_tpv_dia_iso',
    up: `
      ALTER TABLE ab_ventas_tpv DROP CONSTRAINT IF EXISTS ab_ventas_tpv_dia_check;
      ALTER TABLE ab_ventas_tpv ADD  CONSTRAINT ab_ventas_tpv_dia_check
        CHECK (dia BETWEEN 1 AND 7);
    `,
  },
  {
    // Lista blanca de proveedores visibles en Materia Prima (v1 y v2).
    // Cualquier proveedor que no aparezca aquí queda oculto en los
    // selectores/autocompletes de MP (tanto el grid v1 como el modal v2).
    // La tabla se versiona en la DB para que mañana un panel de admin
    // pueda activar/desactivar proveedores sin tocar código.
    id: 17,
    name: 'mp_proveedores_activos',
    up: `
      CREATE TABLE IF NOT EXISTS ab_mp_proveedores_activos (
        proveedor    VARCHAR(200)  PRIMARY KEY,
        activo       BOOLEAN       NOT NULL DEFAULT TRUE,
        orden        INT           NOT NULL DEFAULT 0,
        updated_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS ab_mp_prov_act_idx
        ON ab_mp_proveedores_activos(activo) WHERE activo = TRUE;

      INSERT INTO ab_mp_proveedores_activos (proveedor, orden) VALUES
        ('Don Hamgus SL', 1),
        ('Makro', 2),
        ('Carnicas Mulas SL', 3),
        ('Campoluz', 4),
        ('Coca-Cola Europacific Partners Iberia', 5),
        ('Europastry SA', 6),
        ('Distribuciones Batoy', 7),
        ('Avimed', 8),
        ('Dialque SAU', 9),
        ('Eurofrits SA', 10),
        ('Aceites Millas', 11),
        ('Entrepinares', 12),
        ('Kauapack', 13),
        ('Ovens Time Pan Ingles S.L', 14),
        ('TGT', 15),
        ('Jap Alacant', 16),
        ('BSSG', 17),
        ('Qgourmet', 18),
        ('Herederos de Sanchez Ruiz', 19)
      ON CONFLICT (proveedor) DO NOTHING;
    `,
  },
  {
    // Costos por producto del TPV + receta (ingredientes opcionales).
    // El costo se guarda 1 fila por producto (unique por nombre);
    // cualquier match contra ab_ventas_tpv.producto se hace
    // case-insensitive + trim en runtime. La receta es opcional —
    // un producto puede tener costo_total cargado sin desglose.
    id: 18,
    name: 'ventas_costos',
    up: `
      CREATE TABLE IF NOT EXISTS ab_ventas_costos (
        id              SERIAL          PRIMARY KEY,
        producto        VARCHAR(200)    NOT NULL UNIQUE,
        familia         VARCHAR(100)    NULL,
        costo_mp        NUMERIC(10,4)   NULL,
        mano_obra       NUMERIC(10,4)   NOT NULL DEFAULT 0.65,
        costo_fritura   NUMERIC(10,4)   NOT NULL DEFAULT 0,
        costo_total     NUMERIC(10,4)   NULL,
        notas           TEXT            NULL,
        actualizado_por INTEGER         NULL REFERENCES ab_users(id) ON DELETE SET NULL,
        updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
        created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_costos_producto ON ab_ventas_costos(LOWER(producto));

      CREATE TABLE IF NOT EXISTS ab_ventas_recetas (
        id                SERIAL         PRIMARY KEY,
        costo_id          INTEGER        NOT NULL REFERENCES ab_ventas_costos(id) ON DELETE CASCADE,
        ingrediente       VARCHAR(200)   NOT NULL,
        costo_unitario    NUMERIC(10,4)  NULL,
        formato           NUMERIC(10,3)  NULL,
        rendimiento       NUMERIC(5,4)   NULL,
        costo_por_gr      NUMERIC(10,6)  NULL,
        cantidad_receta   NUMERIC(10,3)  NULL,
        subtotal          NUMERIC(10,4)  NULL,
        orden             INTEGER        NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_recetas_costo ON ab_ventas_recetas(costo_id);
    `,
  },
  {
    // Categorías administrables desde la UI. Migra las 32 categorías
    // hardcodeadas en lib/bank/categorizer.js#CATEGORIAS_GASTO a una tabla
    // editable, con nombre display separado del código interno.
    //
    // Las referencias en ab_reglas_normalizacion.categoria y
    // ab_movimientos.categoria siguen usando el código interno (PK aquí) —
    // sólo el nombre que se muestra en UI cambia desde esta tabla.
    //
    // protegida=TRUE: no se puede eliminar desde UI (system uses for fusion
    // de Gastos Dirección o flujos especiales).
    id: 19,
    name: 'categorias',
    up: `
      CREATE TABLE IF NOT EXISTS ab_categorias (
        codigo          VARCHAR(50)   PRIMARY KEY,
        nombre_display  VARCHAR(100)  NOT NULL,
        protegida       BOOLEAN       NOT NULL DEFAULT FALSE,
        orden           INTEGER       NOT NULL DEFAULT 0,
        created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS ab_categorias_orden_idx
        ON ab_categorias(orden, codigo);

      -- Seed: las 32 categorías existentes con nombre display sensato.
      -- protegida=TRUE para las sensibles (fusión Gastos Dirección + INTRAGRUPO).
      INSERT INTO ab_categorias (codigo, nombre_display, protegida, orden) VALUES
        ('IMPUESTOS',            'Impuestos',                FALSE,  10),
        ('SS_LABORAL',           'Seguridad Social',         TRUE,   20),
        ('NOMINAS',              'Nóminas Personal',         TRUE,   30),
        ('NOMINAS_DIRECCION',    'Nóminas Dirección',        TRUE,   40),
        ('ALQUILER',             'Alquiler',                 FALSE,  50),
        ('SUMINISTROS_ENERGIA',  'Energía y Gas',            FALSE,  60),
        ('SUMINISTROS_LUZ',      'Luz',                      FALSE,  61),
        ('SUMINISTROS_GAS',      'Gas',                      FALSE,  62),
        ('SUMINISTROS_AGUA',     'Agua',                     FALSE,  63),
        ('TELECOMUNICACIONES',   'Telecomunicaciones',       FALSE,  70),
        ('PROVEEDOR_CARNES',     'Proveedor Carnes',         FALSE, 100),
        ('PROVEEDOR_PANADERIA',  'Proveedor Panadería',      FALSE, 110),
        ('PROVEEDOR_FRITAS',     'Proveedor Fritas',         FALSE, 120),
        ('PROVEEDOR_LACTEOS',    'Proveedor Lácteos',        FALSE, 130),
        ('PROVEEDOR_ACEITES',    'Proveedor Aceites',        FALSE, 140),
        ('PROVEEDOR_BEBIDAS',    'Proveedor Bebidas',        FALSE, 150),
        ('PROVEEDOR_MAKRO',      'Makro',                    FALSE, 160),
        ('PROVEEDOR_LIMPIEZA',   'Proveedor Limpieza',       FALSE, 170),
        ('PROVEEDOR_PACKAGING',  'Proveedor Packaging',      FALSE, 180),
        ('PROVEEDOR_OTROS',      'Proveedor Otros',          FALSE, 190),
        ('MANTENIMIENTO',        'Mantenimiento',            FALSE, 200),
        ('EQUIPAMIENTO',         'Equipamiento',             FALSE, 210),
        ('SEGUROS',              'Seguros',                  FALSE, 220),
        ('FINANCIERO',           'Financiero',               TRUE,  230),
        ('PRESTAMOS',            'Préstamos',                TRUE,  240),
        ('PUBLICIDAD',           'Publicidad',               FALSE, 250),
        ('SERVICIOS_PROF',       'Servicios Profesionales',  FALSE, 260),
        ('DELIVERY',             'Delivery',                 FALSE, 270),
        ('GASTOS_DIRECCION',     'Gastos Dirección',         TRUE,  280),
        ('GASTOS_VEHICULOS',     'Gastos Vehículos',         FALSE, 290),
        ('OTROS_GASTOS',         'Otros Gastos',             FALSE, 300),
        ('OTROS',                'Otros',                    FALSE, 310),
        ('INTRAGRUPO',           'Intragrupo',               TRUE,  999)
      ON CONFLICT (codigo) DO NOTHING;
    `,
  },
  {
    // Categoría especial SIN_CLASIFICAR. Recibe TODOS los movimientos
    // cuyo concepto no matchea ninguna regla activa en ab_reglas_normalizacion.
    // Se incluye en el donut por categoría como un slice más (para que
    // 100% del gasto siga estando representado y el usuario vea cuánto
    // queda por clasificar), pero NO aparece en las drop-zones de
    // Gestionar Reglas (no es un destino de drag&drop — es ausencia de
    // regla). Protegida del sistema.
    id: 20,
    name: 'categoria_sin_clasificar',
    up: `
      INSERT INTO ab_categorias (codigo, nombre_display, protegida, orden) VALUES
        ('SIN_CLASIFICAR', 'Sin clasificar', TRUE, 998)
      ON CONFLICT (codigo) DO NOTHING;
    `,
  },
  {
    // Cleanup de la regla legacy de Raba que clasificaba sus movimientos
    // como INTRAGRUPO con prioridad baja (120). La regla protegida #127
    // (id puede variar entre deploys; lo importante es categoria='GASTOS_DIRECCION'
    // + prioridad=999 + protegida=true) gana siempre por orden de prioridad
    // DESC, pero la legacy seguía apareciendo como "segunda regla Raba" en
    // la auditoría — ruido innecesario.
    //
    // Idempotente: si la regla legacy no existe (deploy fresh donde nunca
    // se sembró, o deploy donde ya fue limpiada), el DELETE afecta 0 filas
    // sin error. La condición prioridad<500 protege a la regla #127 prio 999
    // de ser borrada por error si en algún momento alguien cambiara su
    // categoria a INTRAGRUPO (no debería pasar — está protegida=true).
    //
    // Borrar manualmente desde la DB de prod se hizo el 2026-05-28; esta
    // migration garantiza que un deploy a entorno nuevo (staging, restore
    // desde backup viejo, etc.) no traiga la regla legacy de vuelta.
    id: 21,
    name: 'cleanup_regla_legacy_raba_intragrupo',
    up: `
      DELETE FROM ab_reglas_normalizacion
       WHERE patron ILIKE '%raba%'
         AND categoria = 'INTRAGRUPO'
         AND prioridad < 500;
    `,
  },
  {
    // Backfill: 16 movs del bucket 'Rros' agrupaban tres proveedores reales
    // distintos bajo el mismo nombre normalizado. Aplicado a prod el
    // 2026-06-03 via script de un solo uso; esta migration lo perpetúa
    // para deploys frescos (staging, restore desde backup viejo).
    //
    //   - Hierros Mora Anton (4 movs) → MANTENIMIENTO (estaba en PUBLICIDAD
    //     y un INGRESO_TRANSFERENCIA). Regla 'hierros mora' prio 110.
    //   - Rros Imagen Gráfica (12 movs) → renombrado, sigue en PUBLICIDAD.
    //     Regla 'rros imagen' prio 110.
    //   - Internet en Hierros Diaz (1 mov) → renombrado, ya tenía regla
    //     #325 que el pipeline runtime resolverá a MANTENIMIENTO.
    //
    // Idempotente: las INSERT de reglas usan WHERE NOT EXISTS sobre patron;
    // los UPDATE solo tocan filas que aún no estén en el estado final.
    id: 22,
    name: 'backfill_hierros_mora_y_rros_split',
    up: `
      INSERT INTO ab_reglas_normalizacion
        (patron, tipo_match, categoria, proveedor_normalizado, prioridad, activo, forzar_visible, protegida)
      SELECT 'hierros mora', 'ilike', 'MANTENIMIENTO', 'Hierros Mora Anton', 110, TRUE, FALSE, FALSE
       WHERE NOT EXISTS (
         SELECT 1 FROM ab_reglas_normalizacion WHERE patron = 'hierros mora'
       );

      INSERT INTO ab_reglas_normalizacion
        (patron, tipo_match, categoria, proveedor_normalizado, prioridad, activo, forzar_visible, protegida)
      SELECT 'rros imagen', 'ilike', 'PUBLICIDAD', 'Rros Imagen Gráfica', 110, TRUE, FALSE, FALSE
       WHERE NOT EXISTS (
         SELECT 1 FROM ab_reglas_normalizacion WHERE patron = 'rros imagen'
       );

      UPDATE ab_movimientos
         SET categoria = 'MANTENIMIENTO',
             proveedor_normalizado = 'Hierros Mora Anton'
       WHERE concepto ILIKE '%hierros mora%'
         AND (categoria <> 'MANTENIMIENTO'
              OR proveedor_normalizado IS DISTINCT FROM 'Hierros Mora Anton');

      UPDATE ab_movimientos
         SET proveedor_normalizado = 'Rros Imagen Gráfica'
       WHERE concepto ILIKE '%rros imagen%'
         AND proveedor_normalizado IS DISTINCT FROM 'Rros Imagen Gráfica';

      UPDATE ab_movimientos
         SET proveedor_normalizado = 'Internet en Hierros Diaz'
       WHERE concepto ILIKE '%hierros diaz%'
         AND proveedor_normalizado = 'Rros';
    `,
  },
  {
    // Backfill: 72 movs de Radius Business Solutions (€6.733) estaban
    // categorizados como SUMINISTROS_ENERGIA con proveedor truncado
    // "Radius". Son gastos de telemetría/gestión de flota — pertenecen
    // a GASTOS_VEHICULOS. Aplicado a prod 2026-06-03.
    //
    // En vez de insertar una regla nueva con patron='radius' (ya existía
    // la #25 con el mismo patrón apuntando mal a OTROS_GASTOS/Radius),
    // actualizamos la regla existente para evitar dos reglas en conflicto
    // con el mismo patrón.
    //
    // Idempotente: el UPDATE de regla sólo se aplica si los campos
    // difieren; el UPDATE de movs sólo toca filas que aún no estén en
    // el estado final.
    id: 23,
    name: 'backfill_radius_business_solutions',
    up: `
      UPDATE ab_reglas_normalizacion
         SET categoria = 'GASTOS_VEHICULOS',
             proveedor_normalizado = 'Radius Business Solutions',
             forzar_visible = TRUE
       WHERE patron = 'radius'
         AND tipo_match = 'ilike'
         AND (categoria <> 'GASTOS_VEHICULOS'
              OR proveedor_normalizado <> 'Radius Business Solutions'
              OR forzar_visible <> TRUE);

      UPDATE ab_movimientos
         SET categoria = 'GASTOS_VEHICULOS',
             proveedor_normalizado = 'Radius Business Solutions'
       WHERE (concepto ILIKE '%radius%' OR proveedor_normalizado ILIKE '%radius%')
         AND (categoria <> 'GASTOS_VEHICULOS'
              OR proveedor_normalizado IS DISTINCT FROM 'Radius Business Solutions');
    `,
  },
  {
    // Ampliar codigo_banco de VARCHAR(10) a VARCHAR(50) — el parser
    // Sabadell (Phase 12) llena este campo con "Referencia 1" del Excel,
    // que en líneas COMISIONES/ABONO TPV son códigos de 12 chars como
    // "035424100201" (cuenta del local). Con el límite de 10 chars,
    // 4 de 5 archivos Sabadell fallaron al importar con error
    // `value too long for type character varying(10)`.
    //
    // No destructivo: ampliar VARCHAR no toca datos existentes ni
    // requiere reescritura de tabla (operación de metadatos pura en
    // Postgres). Idempotente: el ALTER no falla si el tipo ya es
    // VARCHAR(50), pero por seguridad condicionamos con information_schema.
    id: 24,
    name: 'ampliar_codigo_banco_para_sabadell',
    up: `
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_name = 'ab_movimientos'
             AND column_name = 'codigo_banco'
             AND character_maximum_length < 50
        ) THEN
          ALTER TABLE ab_movimientos ALTER COLUMN codigo_banco TYPE VARCHAR(50);
        END IF;
      END $$;
    `,
  },
  {
    // Reclasificar ingresos intra-grupo mal categorizados a INTRAGRUPO.
    //
    // Aplicado a prod 2026-06-04 via script de un solo uso: 246 movs
    // (€1.168.367,33 acumulado) habían sido persistidos como
    // INGRESO_OTROS / INGRESO_TRANSFERENCIA aunque sus conceptos
    // muestran claramente traspasos/préstamos entre sociedades
    // hermanas ("Transferencia [Inmediata] De <SOC_HERMANA> Sl.,
    // Concepto Traspaso Entre" o "Traspaso: ... Prestamo ...").
    //
    // Causa raíz (corregida en lib/bank/categorizer.js): la función
    // categorizarIngreso NO chequeaba esIntraGrupo antes de aplicar
    // las reglas glovo/justeat/bizum/stripe/transferencia, por lo
    // que cualquier ingreso entrante de sociedad hermana caía en
    // INGRESO_TRANSFERENCIA (por la regla 'transferencia de').
    //
    // Para futuras importaciones el parser ya los categoriza
    // correctamente desde el inicio (categorizarIngreso ahora chequea
    // esIntraGrupo). Esta migration es backfill para datos históricos.
    //
    // Filtro de seguridad: WHERE excluye prefijos que mencionan a la
    // sociedad pero NO son intra-grupo (TPV, ABONO TPV, Comisiones,
    // Recibo a proveedor, Transferencia A Favor De — espejo de
    // FALSOS_POSITIVOS_INTRA_GRUPO_PREFIJOS en lib/bank/normalizers.js).
    //
    // Idempotente: el filtro categoria<>'INTRAGRUPO' evita re-aplicar
    // en deploys posteriores.
    id: 25,
    name: 'backfill_ingresos_intragrupo_mal_categorizados',
    up: `
      UPDATE ab_movimientos
         SET categoria = 'INTRAGRUPO'
       WHERE categoria IN ('INGRESO_OTROS', 'INGRESO_TRANSFERENCIA')
         AND importe > 0
         AND concepto !~* '^liquidacion efectuada'
         AND concepto !~* '^abono tpv'
         AND concepto !~* '^comisiones '
         AND concepto !~* '^recibo '
         AND concepto !~* '^transferencia (inmediata )?a favor de '
         AND (
              concepto ILIKE '%Aires Burger Bar Murcia%'
           OR concepto ILIKE '%Aires Burger Bar Benidorm%'
           OR concepto ILIKE '%Aires Alicante%'
           OR concepto ILIKE '%Smart Aires%'
           OR concepto ILIKE '%Grupo Hostelero Aires%'
           OR concepto ILIKE '%Grupo Hostelero Sl%'
           OR concepto ILIKE '%Aires Murcia%'
           OR concepto ILIKE '%Aires Benidorm%'
         );
    `,
  },
  {
    // Caja / efectivo histórico — tabla nueva alimentada desde CSV
    // (cajas_historico_completo.csv) con ~11k movs desde jul 2025.
    // PK = id del CSV (idempotente, INSERT ON CONFLICT DO NOTHING).
    // sociedad_id se calcula en el script de import (no se almacena
    // como FK; es snapshot del mapeo al momento de la inserción).
    // es_prorrateo y es_especial son columnas calculadas (STORED) para
    // poder indexar y filtrar rápido en /por-sucursal y /flujo-mensual.
    id: 26,
    name: 'crear_ab_caja_movimientos',
    up: `
      CREATE TABLE IF NOT EXISTS ab_caja_movimientos (
        id INTEGER PRIMARY KEY,
        fecha DATE NOT NULL,
        hora TIME,
        sucursal VARCHAR(100) NOT NULL,
        sociedad_id VARCHAR(50),
        tipo VARCHAR(20) NOT NULL,
        subtipo VARCHAR(300),
        metodo_pago VARCHAR(50),
        monto DECIMAL(10,2) NOT NULL,
        observaciones TEXT,
        fecha_carga DATE,
        es_prorrateo BOOLEAN GENERATED ALWAYS AS (
          subtipo ILIKE '%prorrateo%'
        ) STORED,
        es_especial BOOLEAN GENERATED ALWAYS AS (
          sucursal IN ('ESPECIALES','CAJA MAXI Y DANI','NAVE','NAVE NUEVA',
                       'OFICINA','Oficina','OFICINA VERONICA','PRODUCCIÓN',
                       'IFA','TRASTERO','MADRID','MURCIA NUEVO')
        ) STORED,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_caja_fecha     ON ab_caja_movimientos(fecha);
      CREATE INDEX IF NOT EXISTS idx_caja_sucursal  ON ab_caja_movimientos(sucursal);
      CREATE INDEX IF NOT EXISTS idx_caja_sociedad  ON ab_caja_movimientos(sociedad_id);
      CREATE INDEX IF NOT EXISTS idx_caja_tipo      ON ab_caja_movimientos(tipo);
    `,
  },
  {
    id: 27,
    name: 'mapeo_subtipos_caja',
    // Tabla persistente de mapeo subtipo libre (caja) → categoría
    // canónica banco. Reemplaza los patrones hardcoded de
    // lib/caja/mapeo-categorias.js (que quedan como fallback). El
    // endpoint /api/v1/caja/donut-* la lee con cache (TTL 60s) e
    // invalida cuando se guarda un mapeo.
    //
    // tipo_match:
    //   'exact'  → patron === subtipo (case-insensitive, trim)
    //   'prefix' → subtipo empieza por patron (case-insensitive)
    //   'regex'  → new RegExp(patron, 'i').test(subtipo)
    // prioridad: mayor primero (gana el primer match). Las reglas
    // específicas (GASTOS_DIRECCION para socios) deben tener prioridad
    // más alta que las genéricas (NOMINAS).
    up: `
      CREATE TABLE IF NOT EXISTS ab_caja_mapeo_subtipos (
        id SERIAL PRIMARY KEY,
        patron TEXT NOT NULL,
        tipo_match VARCHAR(10) NOT NULL DEFAULT 'regex',
        prioridad INTEGER NOT NULL DEFAULT 100,
        categoria_destino VARCHAR(40) NOT NULL,
        notas TEXT,
        autor TEXT,
        activa BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (patron, tipo_match)
      );
      CREATE INDEX IF NOT EXISTS idx_caja_mapeo_prior
        ON ab_caja_mapeo_subtipos(prioridad DESC, id);
      CREATE INDEX IF NOT EXISTS idx_caja_mapeo_activa
        ON ab_caja_mapeo_subtipos(activa);

      -- Seed: replica reglas hardcoded actuales + nuevos mapeos para
      -- los 180 movs SIN_CATEGORIA_CAJA detectados en gasto_directo.
      -- ON CONFLICT (patron, tipo_match) DO NOTHING garantiza
      -- idempotencia ante re-ejecuciones manuales.
      INSERT INTO ab_caja_mapeo_subtipos
        (patron, tipo_match, prioridad, categoria_destino, autor, notas)
      VALUES
        -- ─── Dirección / socios (alta prioridad) ──────────────────
        ('direcci[oó]n|\\bmaxi\\b|\\bdani\\b|maxi\\s+y\\s+dani|dani\\s+y\\s+maxi|prorrateo\\s+desde', 'regex', 1000, 'GASTOS_DIRECCION', 'system', 'Socios y prorrateos'),
        -- ─── NOMINAS (sueldos, finiquitos, vacaciones, bonos) ─────
        ('sueld|n[oó]mina|liq\\.?\\s*final|^pago\\s+[a-zà-ſ]+\\s*$|^[a-zà-ſ]+\\s+marius$|pago\\s+(cristian|marius)', 'regex', 900, 'NOMINAS', 'system', 'Nóminas (regex original)'),
        ('finiquito|vacaciones|^pago\\s+[a-zà-ſ]+\\s+vacaciones', 'regex', 920, 'NOMINAS', 'system', 'Finiquitos y vacaciones'),
        ('^bonos\\b|^pago\\s+bonos', 'regex', 920, 'NOMINAS', 'system', 'Bonos'),
        ('vi[aá]ticos|^pago\\s+vi[aá]ticos', 'regex', 920, 'NOMINAS', 'system', 'Viáticos personal'),
        -- ─── SS_LABORAL ───────────────────────────────────────────
        ('\\bss\\b|seguridad\\s*social|cotizaci[oó]n|tgss', 'regex', 800, 'SS_LABORAL', 'system', NULL),
        -- ─── ALQUILER ─────────────────────────────────────────────
        ('alquil|renta\\b|arrend', 'regex', 800, 'ALQUILER', 'system', NULL),
        -- ─── Proveedores específicos ──────────────────────────────
        ('makro', 'regex', 700, 'PROVEEDOR_MAKRO', 'system', NULL),
        ('carnic|carn[eé]s|hamgus|don\\s+hangus|mulas?|polo', 'regex', 700, 'PROVEEDOR_CARNES', 'system', NULL),
        ('panad|panet|^pan\\s', 'regex', 700, 'PROVEEDOR_PANADERIA', 'system', NULL),
        ('bebid|coca|cerveza|cervez|refresc|aguad?\\s*natural', 'regex', 700, 'PROVEEDOR_BEBIDAS', 'system', NULL),
        ('lacteo|queso|leche|yogur', 'regex', 700, 'PROVEEDOR_LACTEOS', 'system', NULL),
        ('aceit|oliva', 'regex', 700, 'PROVEEDOR_ACEITES', 'system', NULL),
        ('papas|patatas|fritas?\\b', 'regex', 700, 'PROVEEDOR_FRITAS', 'system', NULL),
        ('pack|envase|cubierto|servilleta|caja[s]?\\s*carton', 'regex', 700, 'PROVEEDOR_PACKAGING', 'system', NULL),
        ('limpi|jab[oó]n|detergente|lej[ií]a|papel\\s+hig', 'regex', 700, 'PROVEEDOR_LIMPIEZA', 'system', NULL),
        -- ─── Suministros ──────────────────────────────────────────
        ('luz|electric|iberdrola|endesa|naturgy|edp', 'regex', 600, 'SUMINISTROS_ENERGIA', 'system', NULL),
        ('\\bagua\\b|aigua|hidraqua', 'regex', 600, 'SUMINISTROS_AGUA', 'system', NULL),
        ('internet|tel[eé]fon|wifi|fibra|m[oó]vil|orange|vodafone|movistar|jazztel', 'regex', 600, 'TELECOMUNICACIONES', 'system', NULL),
        -- ─── SERVICIOS_PROF (honorarios + sistemas/IT) ───────────
        ('honor|asesor|gestor|abogad|fiscal|notari', 'regex', 500, 'SERVICIOS_PROF', 'system', NULL),
        ('^sistemas?(\\s|$)', 'regex', 520, 'SERVICIOS_PROF', 'system', 'IT/Sistemas pagados en caja'),
        -- ─── MANTENIMIENTO (obras + oficios manuales) ────────────
        ('obra|reform|manten|reparac|arregl|migraci[oó]n', 'regex', 500, 'MANTENIMIENTO', 'system', NULL),
        ('pintor|saldo\\s+pintor', 'regex', 520, 'MANTENIMIENTO', 'system', 'Pintores'),
        ('gasista|^paco$|paco\\s+gasista', 'regex', 520, 'MANTENIMIENTO', 'system', 'Gasista Paco'),
        ('^marius$|^pago\\s+marius$', 'regex', 510, 'MANTENIMIENTO', 'system', 'Marius oficios'),
        ('^pago\\s+anton\\s+carlos', 'regex', 520, 'MANTENIMIENTO', 'system', 'Anton Carlos reparaciones'),
        -- ─── PUBLICIDAD (ads + camisetas/merchandising) ──────────
        ('publici|marketing|facebook|google\\s*ads|instagram|tiktok', 'regex', 400, 'PUBLICIDAD', 'system', NULL),
        ('^ads\\b|^pago\\s+ads', 'regex', 420, 'PUBLICIDAD', 'system', 'ADS sueltos'),
        ('camiseta|^merchand|uniform', 'regex', 420, 'PUBLICIDAD', 'system', 'Camisetas / merchandising'),
        -- ─── IMPUESTOS ────────────────────────────────────────────
        ('impuest|\\biva\\b|hacienda|modelo\\s*\\d|tasa|recibo\\s+suma', 'regex', 400, 'IMPUESTOS', 'system', NULL),
        ('autoliquidaci[oó]n|^pago\\s+autoliq|multa|sanci[oó]n', 'regex', 420, 'IMPUESTOS', 'system', 'Autoliquidaciones y multas'),
        -- ─── SEGUROS / PRESTAMOS / FINANCIERO ────────────────────
        ('seguro|insurance', 'regex', 400, 'SEGUROS', 'system', NULL),
        ('prestam|cuota\\s*prest', 'regex', 400, 'PRESTAMOS', 'system', NULL),
        ('comisi[oó]n|cargo\\s*banc', 'regex', 400, 'FINANCIERO', 'system', NULL),
        -- ─── GASTOS_VEHICULOS (incluye parking y uber service) ──
        ('veh[ií]culo|gasolin|combustib|coche|moto\\b|peaje', 'regex', 400, 'GASTOS_VEHICULOS', 'system', NULL),
        ('^parking|^pago\\s+parking|uber\\s+service', 'regex', 420, 'GASTOS_VEHICULOS', 'system', 'Parking y Uber vehicular'),
        -- ─── EQUIPAMIENTO ─────────────────────────────────────────
        ('equip|mobiliari|mueble|herram|maquin', 'regex', 400, 'EQUIPAMIENTO', 'system', NULL),
        -- ─── DIETAS ───────────────────────────────────────────────
        ('dieta|comida\\s*personal', 'regex', 400, 'DIETAS', 'system', NULL)
      ON CONFLICT (patron, tipo_match) DO NOTHING;
    `,
  },
  {
    id: 28,
    name: 'mapeo_cajas_sociedades',
    // Tabla persistente caja externa (Control de Cajas) → sociedad SL.
    // Reemplaza el match por nombre hardcoded en
    // lib/caja/sucursales.js#SUCURSAL_A_SOCIEDAD, que tenía el bug de
    // atribuir 'CHICKEN ELCHE' a Grupo Hostelero (es Aires Alicante SL).
    //
    // tipo:
    //   'sociedad'  → caja operativa de una SL. sociedad_slug/cif/nombre poblados.
    //   'interno'   → cuenta admin (oficina, nave, producción, etc.) NO atribuir a SL.
    //   'pendiente' → desconocida, esperar decisión del editor.
    //   'excluir'   → caja a ignorar del análisis (legacy/test).
    //
    // El backfill al final del up: reescribe `sociedad_id` en
    // ab_caja_movimientos según la tabla — corrige los 652 movs de
    // CHICKEN ELCHE que estaban como 'hostelero'.
    //
    // El nombre_canonico (ej "CHICKEN UNCLES") es SOLO para mostrar; la
    // reconciliación contra el sistema externo sigue usando el nombre
    // de origen ("CHICKEN ELCHE") como key.
    up: `
      CREATE TABLE IF NOT EXISTS ab_caja_mapeo_sociedades (
        id SERIAL PRIMARY KEY,
        caja_origen VARCHAR(100) NOT NULL UNIQUE,
        tipo VARCHAR(20) NOT NULL DEFAULT 'pendiente'
          CHECK (tipo IN ('sociedad','interno','pendiente','excluir')),
        sociedad_slug VARCHAR(50),
        sociedad_cif VARCHAR(20),
        sociedad_nombre TEXT,
        nombre_canonico TEXT,
        notas TEXT,
        autor TEXT,
        activa BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_caja_soc_tipo
        ON ab_caja_mapeo_sociedades(tipo);

      -- Seed: 15 operativas + 11 internas + 3 pendientes.
      -- Los nombres en caja_origen ya van normalizados (uppercase).
      INSERT INTO ab_caja_mapeo_sociedades
        (caja_origen, tipo, sociedad_slug, sociedad_cif, sociedad_nombre, nombre_canonico, autor)
      VALUES
        -- ─── Grupo Hostelero Aires SL ────────────────────────────
        ('ELCHE',           'sociedad', 'hostelero', 'B06851935', 'Grupo Hostelero Aires SL', NULL,             'system'),
        -- ─── Aires Alicante SL ───────────────────────────────────
        ('ALICANTE',        'sociedad', 'alicante',  'B44897973', 'Aires Alicante SL',        NULL,             'system'),
        ('ARENALES',        'sociedad', 'alicante',  'B44897973', 'Aires Alicante SL',        NULL,             'system'),
        ('CREVILLENTE',     'sociedad', 'alicante',  'B44897973', 'Aires Alicante SL',        NULL,             'system'),
        -- Chicken Uncles aparece en Control de Cajas como "CHICKEN ELCHE"
        -- (typo histórico). La SL real es Aires Alicante. nombre_canonico
        -- permite que la UI lo muestre como "CHICKEN UNCLES".
        ('CHICKEN ELCHE',   'sociedad', 'alicante',  'B44897973', 'Aires Alicante SL',        'CHICKEN UNCLES', 'system'),
        ('CHICKEN UNCLES',  'sociedad', 'alicante',  'B44897973', 'Aires Alicante SL',        NULL,             'system'),
        -- ─── Smart Aires SL ──────────────────────────────────────
        ('SANTA POLA',      'sociedad', 'smart',     'B67929901', 'Smart Aires SL',           NULL,             'system'),
        ('TORREVIEJA',      'sociedad', 'smart',     'B67929901', 'Smart Aires SL',           NULL,             'system'),
        ('SAN VICENTE',     'sociedad', 'smart',     'B67929901', 'Smart Aires SL',           NULL,             'system'),
        -- ─── Aires Burger Bar Murcia SL ──────────────────────────
        ('MURCIA MERCED',   'sociedad', 'murcia',    'B44896793', 'Aires Burger Bar Murcia SL', NULL,           'system'),
        ('SANTO DOMINGO',   'sociedad', 'murcia',    'B44896793', 'Aires Burger Bar Murcia SL', NULL,           'system'),
        ('ORIHUELA',        'sociedad', 'murcia',    'B44896793', 'Aires Burger Bar Murcia SL', NULL,           'system'),
        ('THADER',          'sociedad', 'murcia',    'B44896793', 'Aires Burger Bar Murcia SL', NULL,           'system'),
        ('CHICKEN THADER',  'sociedad', 'murcia',    'B44896793', 'Aires Burger Bar Murcia SL', NULL,           'system'),
        -- ─── Aires Burger Bar Benidorm SL ────────────────────────
        ('BENIDORM',        'sociedad', 'benidorm',  'B70864954', 'Aires Burger Bar Benidorm SL', NULL,         'system'),
        -- ─── Internas (NO atribuir a SL) ─────────────────────────
        ('ESPECIALES',        'interno', NULL, NULL, NULL, NULL, 'system'),
        ('PRODUCCIÓN',        'interno', NULL, NULL, NULL, NULL, 'system'),
        ('OFICINA',           'interno', NULL, NULL, NULL, NULL, 'system'),
        ('OFICINA VERONICA',  'interno', NULL, NULL, NULL, NULL, 'system'),
        ('NAVE',              'interno', NULL, NULL, NULL, NULL, 'system'),
        ('NAVE NUEVA',        'interno', NULL, NULL, NULL, NULL, 'system'),
        ('CAJA MAXI Y DANI',  'interno', NULL, NULL, NULL, NULL, 'system'),
        ('TRASTERO',          'interno', NULL, NULL, NULL, NULL, 'system'),
        ('SUCURSAL DE PRUEBA','interno', NULL, NULL, NULL, NULL, 'system'),
        ('OFICINA (FORA)',    'interno', NULL, NULL, NULL, NULL, 'system'),
        -- ─── Pendientes (esperar decisión del admin) ─────────────
        ('IFA',               'pendiente', NULL, NULL, NULL, NULL, 'system'),
        ('MADRID',            'pendiente', NULL, NULL, NULL, NULL, 'system'),
        ('MURCIA NUEVO',      'pendiente', NULL, NULL, NULL, NULL, 'system')
      ON CONFLICT (caja_origen) DO NOTHING;

      -- Backfill: recomputa sociedad_id de ab_caja_movimientos según
      -- la tabla. Esto es lo que CORRIGE los 652 movs de CHICKEN ELCHE
      -- (los pasa de 'hostelero' a 'alicante') y nullifica las cajas
      -- internas que la matriz hardcoded no cubría.
      UPDATE ab_caja_movimientos m
         SET sociedad_id = s.sociedad_slug
        FROM ab_caja_mapeo_sociedades s
       WHERE s.caja_origen = UPPER(TRIM(m.sucursal))
         AND s.activa = TRUE
         AND m.sociedad_id IS DISTINCT FROM s.sociedad_slug;

      -- Cajas sin mapeo activo (o tipo interno/pendiente/excluir) → NULL.
      UPDATE ab_caja_movimientos m
         SET sociedad_id = NULL
       WHERE m.sociedad_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM ab_caja_mapeo_sociedades s
            WHERE s.caja_origen = UPPER(TRIM(m.sucursal))
              AND s.activa = TRUE
              AND s.sociedad_slug IS NOT NULL
         );
    `,
  },
  {
    id: 29,
    name: 'prorrateo_padres_a_nominas',
    // Reasigna "Prorrateo desde ESPECIALES/PRODUCCIÓN" de
    // GASTOS_DIRECCION a NOMINAS. El sistema externo "Control de
    // Cajas" carga los sueldos en las cajas padre ESPECIALES y
    // PRODUCCIÓN y luego los reparte como prorrateo a las operativas.
    // Esos €196k repartidos son PERSONAL, no dirección.
    //
    // Prioridad 1100 — gana sobre la regla genérica 'prorrateo desde'
    // (1000, GASTOS_DIRECCION) que seguimos usando para "prorrateo
    // desde [otros] CAJA MAXI Y DANI" y similares dirección.
    up: `
      INSERT INTO ab_caja_mapeo_subtipos
        (patron, tipo_match, prioridad, categoria_destino, autor, notas)
      VALUES
        ('prorrateo\\s+desde\\s+especiales', 'regex', 1100, 'NOMINAS', 'system',
         'Prorrateo desde ESPECIALES — sueldos repartidos por el sistema externo. Plata de personal.'),
        ('prorrateo\\s+desde\\s+producci(o|ó)n', 'regex', 1100, 'NOMINAS', 'system',
         'Prorrateo desde PRODUCCIÓN — idem ESPECIALES.')
      ON CONFLICT (patron, tipo_match) DO UPDATE
        SET categoria_destino = EXCLUDED.categoria_destino,
            prioridad = EXCLUDED.prioridad,
            notas = EXCLUDED.notas,
            updated_at = NOW();
    `,
  },
  {
    id: 30,
    name: 'reasignar_madrid_murcia_nuevo_ifa',
    // Decisiones manuales sobre las 3 cajas que estaban pendientes:
    //   · MADRID       → operativa Aires Alicante SL (B44897973)
    //   · MURCIA NUEVO → operativa Aires Burger Bar Murcia SL (B44896793),
    //                    nombre canónico de display "MADERO"
    //   · IFA          → interno (excluida del análisis)
    //
    // El reto técnico: la columna `es_especial` en ab_caja_movimientos
    // es GENERATED ALWAYS AS STORED con la lista hardcoded — incluye
    // MADRID, MURCIA NUEVO e IFA como TRUE. No se puede UPDATE; hay
    // que DROP + ADD con la lista nueva. Tras el DROP/ADD, Postgres
    // recalcula es_especial para los 10.986 movs.
    //
    // Tras el cambio:
    //   · MADRID y MURCIA NUEVO pasan a es_especial=FALSE — sus egresos
    //     (~€54k) y sus prorrateos entran al donut combinado por su SL.
    //   · IFA sigue es_especial=TRUE — sigue fuera del donut.
    up: `
      -- 1) Reasignar en la tabla maestra de mapeo.
      UPDATE ab_caja_mapeo_sociedades
         SET tipo = 'sociedad',
             sociedad_slug = 'alicante',
             sociedad_cif = 'B44897973',
             sociedad_nombre = 'Aires Alicante SL',
             nombre_canonico = NULL,
             notas = 'Reasignada 2026-06-07: era pendiente; operativa Aires Alicante.',
             autor = 'system',
             updated_at = NOW()
       WHERE caja_origen = 'MADRID';

      UPDATE ab_caja_mapeo_sociedades
         SET tipo = 'sociedad',
             sociedad_slug = 'murcia',
             sociedad_cif = 'B44896793',
             sociedad_nombre = 'Aires Burger Bar Murcia SL',
             nombre_canonico = 'MADERO',
             notas = 'Reasignada 2026-06-07: era pendiente; operativa Aires Burger Bar Murcia. Display "MADERO".',
             autor = 'system',
             updated_at = NOW()
       WHERE caja_origen = 'MURCIA NUEVO';

      UPDATE ab_caja_mapeo_sociedades
         SET tipo = 'interno',
             sociedad_slug = NULL,
             sociedad_cif = NULL,
             sociedad_nombre = NULL,
             nombre_canonico = NULL,
             notas = 'Reasignada 2026-06-07: era pendiente; queda como interna (excluida).',
             autor = 'system',
             updated_at = NOW()
       WHERE caja_origen = 'IFA';

      -- 2) Reescribir la columna generada es_especial para que ya no
      -- incluya MADRID/MURCIA NUEVO. La lista nueva = las cajas que
      -- estan tipo=interno o excluir en ab_caja_mapeo_sociedades.
      ALTER TABLE ab_caja_movimientos DROP COLUMN es_especial;
      ALTER TABLE ab_caja_movimientos
        ADD COLUMN es_especial BOOLEAN GENERATED ALWAYS AS (
          sucursal IN ('ESPECIALES','CAJA MAXI Y DANI','NAVE','NAVE NUEVA',
                       'OFICINA','Oficina','OFICINA VERONICA','PRODUCCIÓN',
                       'IFA','TRASTERO','OFICINA (FORA)','SUCURSAL DE PRUEBA')
        ) STORED;

      -- 3) Backfill sociedad_id desde la tabla recién editada.
      UPDATE ab_caja_movimientos m
         SET sociedad_id = s.sociedad_slug
        FROM ab_caja_mapeo_sociedades s
       WHERE s.caja_origen = UPPER(TRIM(m.sucursal))
         AND s.activa = TRUE
         AND m.sociedad_id IS DISTINCT FROM s.sociedad_slug;

      UPDATE ab_caja_movimientos m
         SET sociedad_id = NULL
       WHERE m.sociedad_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM ab_caja_mapeo_sociedades s
            WHERE s.caja_origen = UPPER(TRIM(m.sucursal))
              AND s.activa = TRUE
              AND s.sociedad_slug IS NOT NULL
         );
    `,
  },
  {
    id: 31,
    name: 'ab_presupuesto_costos_categoria',
    // Simulador de presupuesto por categoría (panel al final del tab
    // Presupuesto). Permite al usuario asignar un monto por categoría
    // de gasto sobre la facturación presupuestada del mes y recortar
    // hasta llegar a un neto positivo. Persiste por (anio, mes, scope,
    // categoria). El user_id queda como NULL por ahora (todos comparten
    // el presupuesto); si en el futuro se quiere por-usuario, basta
    // setearlo y ajustar el UNIQUE.
    up: `
      CREATE TABLE IF NOT EXISTS ab_presupuesto_costos_categoria (
        id           SERIAL PRIMARY KEY,
        user_id      INT,
        anio         INT NOT NULL,
        mes          INT NOT NULL CHECK (mes BETWEEN 1 AND 12),
        scope        TEXT NOT NULL CHECK (scope IN ('sin_elche','solo_elche','todas')),
        categoria    TEXT NOT NULL,
        monto        NUMERIC NOT NULL DEFAULT 0,
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, anio, mes, scope, categoria)
      );
      CREATE INDEX IF NOT EXISTS idx_presup_costos_periodo
        ON ab_presupuesto_costos_categoria (anio, mes, scope);
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
