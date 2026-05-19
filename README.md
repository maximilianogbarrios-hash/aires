# Aires Solo — Análisis de rentabilidad

App independiente para Aires Burger Bar. Postgres + Express + HTML.

## Stack
- Node.js >= 20, Express 5
- PostgreSQL (Railway lo provee vía `DATABASE_URL`)
- `express-session` con store en Postgres (`connect-pg-simple`)
- Frontend: HTML estático + Chart.js (CDN). Sin bundler.

## Estructura
```
aires-solo/
├── index.js                # bootstrap Express
├── package.json
├── railway.json            # config Railway
├── Procfile
├── lib/
│   ├── db.js               # pool pg
│   ├── migrations.js       # versionadas
│   ├── seed-data.js        # LOCALES + H25 + DEFAULT_CONFIG
│   └── auth.js             # bcrypt + middlewares
├── routes/
│   ├── auth.js             # /api/v1/auth/login|logout|me
│   ├── users.js            # /api/v1/users (admin)
│   └── aires.js            # /api/v1/aires/* (config, locales, presupuesto, historial, bootstrap)
├── scripts/
│   ├── migrate.js          # corre migrations
│   └── seed.js             # usuarios + config + locales + H25 (idempotente)
└── public/
    ├── css/styles.css
    ├── login/index.html
    ├── dashboard/index.html
    ├── admin/index.html
    └── js/
        ├── data.js         # constantes UI + HTOT_MENSUAL
        ├── engine.js       # calcOne/calcAll/calcElche/calcBudget/grpSum (puro)
        ├── api.js          # fetch wrapper + debounced savers
        └── main.js         # render + tabs + UI
```

## DB schema (prefijo `ab_`)
- `ab_users` — id, email, password_hash, role(admin|socio), `totp_secret`, `totp_enabled`
- `ab_config` — clave PK, valor jsonb
- `ab_locales` — id, nombre_display, short_name, grupo(A-D), dani_only, alquiler, suministros, fac_mi_analisis, horas_sem_override
- `ab_presupuesto` — local_id, anio, mes, fac_presupuestada, fac_real (UNIQUE local_id+anio+mes)
- `ab_historial` — local_id, anio, mes, facturacion, fuente (UNIQUE local_id+anio+mes+fuente)
- `ab_session` — sid, sess, expire (manejado por connect-pg-simple)
- `ab_migrations` — control de versiones

## API
Todas requieren sesión.

### Auth
- `POST /api/v1/auth/login` — `{ email, password }` → si el usuario tiene 2FA, responde `{ needs2fa: true }` y abre sesión parcial (5 min); si no, abre sesión completa (7 días).
- `POST /api/v1/auth/login/2fa` — `{ code }` completa el login si hay sesión parcial.
- `POST /api/v1/auth/logout`
- `GET  /api/v1/auth/me`

### 2FA (TOTP — Google Authenticator / Authy / 1Password)
- `GET  /api/v1/auth/2fa/status` — `{ enabled }`
- `POST /api/v1/auth/2fa/setup` — genera secret + URL otpauth + QR data URL.
- `POST /api/v1/auth/2fa/confirm` — `{ code }` activa el 2FA tras verificar el primer código.
- `POST /api/v1/auth/2fa/disable` — `{ password, code }` desactiva 2FA (requiere ambos).

### Users (solo admin)
- `GET    /api/v1/users` — devuelve también `max_users` y `totp_enabled` por usuario.
- `POST   /api/v1/users` — `{ email, password, role }` (límite `MAX_USERS`, default 10)
- `PUT    /api/v1/users/:id/password` — `{ password }`
- `DELETE /api/v1/users/:id/2fa` — admin fuerza desactivar 2FA (rescate si pierde el autenticador).
- `DELETE /api/v1/users/:id` — borrar usuario.

### Aires
- `GET /api/v1/aires/bootstrap` — todo lo que el front necesita (config + locales + historial + presupuesto + user)
- `GET /api/v1/aires/config` · `PUT /api/v1/aires/config` (patch parcial)
- `GET /api/v1/aires/locales` · `PUT /api/v1/aires/locales/:id` (alquiler/suministros/fac_mi_analisis/horas_sem_override)
- `GET /api/v1/aires/presupuesto?anio=&mes=` · `PUT /api/v1/aires/presupuesto` (upsert por local+anio+mes)
- `GET /api/v1/aires/historial?anio=&local_id=&fuente=` · `POST /api/v1/aires/historial` (upsert)

## Local development
```bash
cp .env.example .env
# editar .env: DATABASE_URL (postgres local), SESSION_SECRET, ADMIN_*, SOCIO_*

npm install
npm run migrate
npm run seed
npm start
# http://localhost:3000/login
```

## Deploy en Railway

1. **Crear proyecto nuevo en Railway** (NO usar el de mi-panel)
2. **Add service: PostgreSQL** — Railway inyecta `DATABASE_URL` automáticamente
3. **Add service: GitHub repo** — apuntar a este repo (rama `main`)
4. **Variables a setear manualmente** en el servicio web:
   - `SESSION_SECRET` — string aleatorio largo (ej. `openssl rand -hex 32`)
   - `NODE_ENV=production`
   - `ADMIN_EMAIL` y `ADMIN_PASSWORD`
   - `SOCIO_EMAIL` y `SOCIO_PASSWORD`
   - (Opcional) `USER1_EMAIL`/`USER1_PASSWORD`/`USER1_ROLE` … `USER10_*` para seedear más usuarios al primer arranque.
   - (Opcional) `MAX_USERS=10` — límite duro de usuarios.
   - (Opcional) `TOTP_ISSUER=AiresBurger` — nombre que aparece en la app autenticadora.
5. Railway corre `npm run migrate && npm run seed && npm start` automáticamente (ver `Procfile` / `railway.json`)
6. El healthcheck es `GET /health`

## Arquitectura — para extensibilidad
- **API RESTful** en `/api/v1/aires/*` — cada feature nueva suma un endpoint
- **Config global en DB** (no hardcodeada) — cambiar parámetros sin redeploy
- **Engine de cálculo en `/public/js/engine.js`** — un solo archivo, puro, versionado
- **Frontend modular**: cada `<script>` es un módulo cargado por orden (`data.js` → `engine.js` → `api.js` → `main.js`)
- **Datos históricos H25** en `ab_historial` con `fuente='2025_real'` — ampliable a nuevos años/meses
- **`HTOT_MENSUAL`** en `data.js` (constante por ahora — agregar a DB cuando se cargue 2026 completo)
- **`updated_at`** en todas las tablas — para auditoría futura
- **`ab_migrations`** — agregar migraciones a `lib/migrations.js` con id nuevo

## Roadmap (P2)
- Carga de reales mensual: form para ingresar facturación real por local
- Historial: ver meses reales cargados vs presupuesto
- Export PDF por tab
- Notificaciones: alertas si un local baja del breakeven
- Dashboard móvil simplificado
