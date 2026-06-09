// Fetch wrapper + savers con debounce/coalescing por entidad.
window.Api = (function () {
  async function jsonFetch(url, opts = {}) {
    const r = await fetch(url, {
      ...opts,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    });
    if (r.status === 401) {
      location.href = '/login';
      throw new Error('unauthorized');
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }

  function pill(text, isError) {
    const el = document.getElementById('save-pill');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('error', !!isError);
    el.classList.add('show');
    clearTimeout(pill._t);
    pill._t = setTimeout(() => el.classList.remove('show'), 1400);
  }

  // Coalescing per (entity, key): el último request gana.
  // Guardamos también `fn` en el entry para poder hacer flush forzado desde
  // afuera (ver flushPending). Sin esto, el save quedaba colgado del setTimeout
  // y módulos consumidores (Pedidos/Personal) leían backend con datos viejos
  // si el usuario navegaba dentro de la ventana del debounce.
  const pending = new Map();
  function debouncedSave(key, fn, ms = 350) {
    if (pending.has(key)) {
      clearTimeout(pending.get(key).timer);
    }
    const run = async () => {
      pending.delete(key);
      try {
        await fn();
        pill('Guardado');
      } catch (e) {
        console.error('[save]', key, e);
        pill('Error al guardar', true);
      }
    };
    const entry = { fn: run, timer: setTimeout(run, ms) };
    pending.set(key, entry);
  }

  // Fuerza ejecución inmediata de todos los saves pendientes cuyo `key`
  // empiece por `prefix`. Usado por consumidores que necesitan datos
  // garantizadamente frescos del backend (p.ej. Pedidos/Personal al
  // abrirse después de tocar Presupuesto o Parámetros).
  async function flushPending(prefix) {
    const matches = [];
    for (const [key, entry] of pending.entries()) {
      if (prefix && !key.startsWith(prefix)) continue;
      clearTimeout(entry.timer);
      matches.push(entry.fn());
    }
    if (matches.length) await Promise.allSettled(matches);
  }

  const bootstrap = () => jsonFetch('/api/v1/aires/bootstrap');

  const saveConfig = (patch) => jsonFetch('/api/v1/aires/config', {
    method: 'PUT', body: JSON.stringify(patch),
  });

  const lastParamsMod = () => jsonFetch('/api/v1/aires/parametros/last-mod');

  const saveLocal = (id, patch) => jsonFetch(`/api/v1/aires/locales/${encodeURIComponent(id)}`, {
    method: 'PUT', body: JSON.stringify(patch),
  });

  const savePresupuesto = (payload) => jsonFetch('/api/v1/aires/presupuesto', {
    method: 'PUT', body: JSON.stringify(payload),
  });

  const presupuestoContexto = (periodo) =>
    jsonFetch(`/api/v1/aires/presupuesto/contexto?periodo=${encodeURIComponent(periodo)}`);

  // ─── Simulador de presupuesto de costos por categoría ─────────────
  const simPresupSeed = ({ anio, mes, scope }) =>
    jsonFetch(`/api/v1/aires/presupuesto-costos/seed?anio=${anio}&mes=${mes}&scope=${encodeURIComponent(scope)}`);
  const simPresupGet = ({ anio, mes, scope }) =>
    jsonFetch(`/api/v1/aires/presupuesto-costos?anio=${anio}&mes=${mes}&scope=${encodeURIComponent(scope)}`);
  const simPresupSave = (payload) =>
    jsonFetch('/api/v1/aires/presupuesto-costos', { method: 'PUT', body: JSON.stringify(payload) });
  const simPresupReset = ({ anio, mes, scope }) =>
    jsonFetch(`/api/v1/aires/presupuesto-costos?anio=${anio}&mes=${mes}&scope=${encodeURIComponent(scope)}`, { method: 'DELETE' });

  const saveFacturacionSemanal = (payload) =>
    jsonFetch('/api/v1/facturacion/semanal', { method: 'POST', body: JSON.stringify(payload) });

  const getFacturacionSemanal = ({ anio, mes, local_id }) => {
    const qs = new URLSearchParams({ anio, mes });
    if (local_id) qs.set('local_id', local_id);
    return jsonFetch(`/api/v1/facturacion/semanal?${qs}`);
  };

  // Horas cargadas en la sub-pestaña Personal del módulo Pedidos —
  // persisten en ab_facturacion_semanal.horas (migration 8).
  const saveHorasSemanal = ({ local_id, anio, semana_iso, horas }) =>
    jsonFetch('/api/v1/facturacion/semanal', {
      method: 'POST',
      body: JSON.stringify({ local_id, anio, semana_iso, horas, fuente_horas: 'manual_pedidos' }),
    });

  const logout = () => jsonFetch('/api/v1/auth/logout', { method: 'POST' });

  // ─── Módulo Pedidos ───────────────────────────────────────────────────
  const pedidosBootstrap = (q = {}) => {
    const qs = new URLSearchParams(q).toString();
    return jsonFetch('/api/v1/pedidos/bootstrap' + (qs ? '?' + qs : ''));
  };
  const pedidosMP = (q = {}) => {
    const qs = new URLSearchParams(q).toString();
    return jsonFetch('/api/v1/pedidos/materia-prima' + (qs ? '?' + qs : ''));
  };
  const pedidosPersonal = (q = {}) => {
    const qs = new URLSearchParams(q).toString();
    return jsonFetch('/api/v1/pedidos/personal' + (qs ? '?' + qs : ''));
  };
  const pedidosMix = (q = {}) => {
    const qs = new URLSearchParams(q).toString();
    return jsonFetch('/api/v1/pedidos/proveedores-mix' + (qs ? '?' + qs : ''));
  };
  const pedidosMixSave = (rows) => jsonFetch('/api/v1/pedidos/proveedores-mix', {
    method: 'PUT', body: JSON.stringify({ rows }),
  });
  const pedidosMixCopy = (payload) => jsonFetch('/api/v1/pedidos/proveedores-mix/copiar', {
    method: 'POST', body: JSON.stringify(payload),
  });
  const pedidosMixImport = (payload) => jsonFetch('/api/v1/pedidos/proveedores-mix/importar-bancos', {
    method: 'POST', body: JSON.stringify(payload),
  });
  const pedidosSavePedido = (payload) => jsonFetch('/api/v1/pedidos/pedido', {
    method: 'PUT', body: JSON.stringify(payload),
  });
  const pedidosConfirmar = (payload) => jsonFetch('/api/v1/pedidos/confirmar-semana', {
    method: 'POST', body: JSON.stringify(payload),
  });
  const pedidosMarcarPagado = (payload) => jsonFetch('/api/v1/pedidos/marcar-pagado', {
    method: 'PUT', body: JSON.stringify(payload),
  });
  const pedidosCmpBancos = (q = {}) => {
    const qs = new URLSearchParams(q).toString();
    return jsonFetch('/api/v1/pedidos/comparativa-bancos' + (qs ? '?' + qs : ''));
  };
  const pedidosHistorial = (q = {}) => {
    const qs = new URLSearchParams(q).toString();
    return jsonFetch('/api/v1/pedidos/historial' + (qs ? '?' + qs : ''));
  };
  const pedidosRanking = (q = {}) => {
    const qs = new URLSearchParams(q).toString();
    return jsonFetch('/api/v1/pedidos/ranking-eficiencia' + (qs ? '?' + qs : ''));
  };
  const pedidosProveedoresActivos = () => jsonFetch('/api/v1/pedidos/proveedores-activos');

  // ─── MP v2 (módulo por volumen) ─────────────────────────────────────
  const mp2 = {
    meta:                () => jsonFetch('/api/v1/mp2/meta'),
    catalogoGet:         (q={}) => jsonFetch('/api/v1/mp2/catalogo' + qs(q)),
    catalogoSave:        (body) => jsonFetch('/api/v1/mp2/catalogo', { method: 'PUT', body: JSON.stringify(body) }),
    catalogoHistorico:   (q={}) => jsonFetch('/api/v1/mp2/catalogo/historico' + qs(q)),
    pedidosList:         (q={}) => jsonFetch('/api/v1/mp2/pedidos' + qs(q)),
    pedidoGet:           (id) => jsonFetch('/api/v1/mp2/pedidos/' + id),
    pedidoSave:          (body) => jsonFetch('/api/v1/mp2/pedidos', { method: 'POST', body: JSON.stringify(body) }),
    pedidoConfirmar:     (id) => jsonFetch(`/api/v1/mp2/pedidos/${id}/confirmar`, { method: 'POST', body: '{}' }),
    pedidoEstado:        (id, estado) => jsonFetch(`/api/v1/mp2/pedidos/${id}/estado`, { method: 'PUT', body: JSON.stringify({ estado }) }),
    pedidoLineaUpdate:   (id, lineaId, body) => jsonFetch(`/api/v1/mp2/pedidos/${id}/lineas/${lineaId}`, { method: 'PUT', body: JSON.stringify(body) }),
    pedidoDelete:        (id) => jsonFetch('/api/v1/mp2/pedidos/' + id, { method: 'DELETE' }),
    semaforo:            (q={}) => jsonFetch('/api/v1/mp2/semaforo' + qs(q)),
    budgetSemana:        (q={}) => jsonFetch('/api/v1/mp2/budget-semana' + qs(q)),
    kpis:                (q={}) => jsonFetch('/api/v1/mp2/kpis' + qs(q)),
    conciliacionDebitos: (q={}) => jsonFetch('/api/v1/mp2/conciliacion/debitos' + qs(q)),
    conciliacionPendientes: (q={}) => jsonFetch('/api/v1/mp2/conciliacion/pendientes' + qs(q)),
    conciliar:           (body) => jsonFetch('/api/v1/mp2/conciliacion', { method: 'POST', body: JSON.stringify(body) }),
    resumen:             (q={}) => jsonFetch('/api/v1/mp2/resumen' + qs(q)),
  };
  function qs(o) {
    const p = new URLSearchParams();
    for (const k of Object.keys(o)) if (o[k] !== null && o[k] !== undefined && o[k] !== '') p.set(k, o[k]);
    const s = p.toString();
    return s ? '?' + s : '';
  }

  return {
    bootstrap, saveConfig, lastParamsMod, saveLocal, savePresupuesto, presupuestoContexto,
    simPresupSeed, simPresupGet, simPresupSave, simPresupReset,
    saveFacturacionSemanal, getFacturacionSemanal, saveHorasSemanal,
    pedidosBootstrap, pedidosMP, pedidosPersonal,
    pedidosMix, pedidosMixSave, pedidosMixCopy, pedidosMixImport,
    pedidosSavePedido, pedidosConfirmar, pedidosMarcarPagado, pedidosCmpBancos,
    pedidosHistorial, pedidosRanking, pedidosProveedoresActivos,
    mp2,
    logout, debouncedSave, flushPending, pill,
  };
})();
