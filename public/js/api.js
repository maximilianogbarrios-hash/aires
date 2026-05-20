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
  const pending = new Map();
  function debouncedSave(key, fn, ms = 350) {
    if (pending.has(key)) {
      clearTimeout(pending.get(key).timer);
    }
    const entry = {
      timer: setTimeout(async () => {
        pending.delete(key);
        try {
          await fn();
          pill('Guardado');
        } catch (e) {
          console.error('[save]', key, e);
          pill('Error al guardar', true);
        }
      }, ms),
    };
    pending.set(key, entry);
  }

  const bootstrap = () => jsonFetch('/api/v1/aires/bootstrap');

  const saveConfig = (patch) => jsonFetch('/api/v1/aires/config', {
    method: 'PUT', body: JSON.stringify(patch),
  });

  const saveLocal = (id, patch) => jsonFetch(`/api/v1/aires/locales/${encodeURIComponent(id)}`, {
    method: 'PUT', body: JSON.stringify(patch),
  });

  const savePresupuesto = (payload) => jsonFetch('/api/v1/aires/presupuesto', {
    method: 'PUT', body: JSON.stringify(payload),
  });

  const presupuestoContexto = (periodo) =>
    jsonFetch(`/api/v1/aires/presupuesto/contexto?periodo=${encodeURIComponent(periodo)}`);

  const saveFacturacionSemanal = (payload) =>
    jsonFetch('/api/v1/facturacion/semanal', { method: 'POST', body: JSON.stringify(payload) });

  const getFacturacionSemanal = ({ anio, mes, local_id }) => {
    const qs = new URLSearchParams({ anio, mes });
    if (local_id) qs.set('local_id', local_id);
    return jsonFetch(`/api/v1/facturacion/semanal?${qs}`);
  };

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

  return {
    bootstrap, saveConfig, saveLocal, savePresupuesto, presupuestoContexto,
    saveFacturacionSemanal, getFacturacionSemanal,
    pedidosBootstrap, pedidosMP, pedidosPersonal,
    pedidosMix, pedidosMixSave, pedidosMixCopy, pedidosMixImport,
    pedidosSavePedido, pedidosConfirmar, pedidosCmpBancos,
    pedidosHistorial, pedidosRanking,
    logout, debouncedSave, pill,
  };
})();
