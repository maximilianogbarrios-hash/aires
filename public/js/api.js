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

  const logout = () => jsonFetch('/api/v1/auth/logout', { method: 'POST' });

  return { bootstrap, saveConfig, saveLocal, savePresupuesto, logout, debouncedSave, pill };
})();
