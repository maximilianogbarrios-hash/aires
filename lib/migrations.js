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
