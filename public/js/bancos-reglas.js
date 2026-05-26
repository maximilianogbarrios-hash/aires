// Pantalla "Reglas de Proveedores" — drag & drop admin/socio.
//
// Entry: window.rpOpen() / window.rpClose() — switchea entre la vista
// normal de Bancos y la pantalla full-section #sect-reglas-prov.
//
// Endpoints:
//   GET    /api/v1/bancos/reglas-prov/categorias
//   GET    /api/v1/bancos/reglas-prov/sin-clasificar
//   GET    /api/v1/bancos/reglas-prov/clasificados
//   GET    /api/v1/bancos/reglas-prov/detalle/:proveedor
//   POST   /api/v1/bancos/reglas-prov/asignar       body { proveedor, categoria }
//   DELETE /api/v1/bancos/reglas-prov/:id

(function () {
  const $ = (id) => document.getElementById(id);
  const eur0 = (v) => v == null ? '—' : new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(Math.round(v));
  const eur2 = (v) => v == null ? '—' : new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 }).format(v);
  const num0 = (v) => v == null ? '—' : new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 }).format(v);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  async function api(path, opts) {
    const r = await fetch(path, { credentials: 'same-origin', ...(opts || {}) });
    if (r.status === 401) { location.href = '/login'; return null; }
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      const e = new Error(t || `HTTP ${r.status}`); e.code = r.status; throw e;
    }
    return r.json();
  }

  const rp = {
    booted: false,
    categorias: [],
    sinClasificar: [],
    clasificadosByCat: {},
    searchQ: '',
    dragging: null,           // proveedor name being dragged
    prevSection: null,        // id de la sección activa antes de abrir reglas (para volver)
    autoScrollRaf: null,      // requestAnimationFrame id para el auto-scroll del drag
    autoScrollDelta: 0,       // px por frame (signo: + abajo / − arriba)
    sugerencias: new Map(),   // proveedor → { categoria, confianza, motivo } (post-IA)
    iaCorriendo: false,       // bloquea botones mientras se procesa
  };
  // Detectar rol admin/socio desde la sesión expuesta por el shell de
  // bancos (`const state` global en bancos.js). Importante: en scripts
  // clásicos los `const` top-level NO se cuelgan en `window`, viven en
  // el lexical scope global. Por eso accedemos directo a `state`, no a
  // `window.state` (cuyo uso anterior siempre era undefined y dejaba el
  // botón oculto incluso para admin).
  // Misma lógica que `rolEsAdmin()` en bancos.js (que cubre admin+socio)
  // para mantener consistencia con el resto de botones admin de la pestaña
  // (prov-btn-reglas, prov-btn-gd-manage, prov-btn-add-prov).
  function esAdminEstricto() {
    try {
      if (typeof state !== 'undefined' && state && state.user) {
        return state.user.role === 'admin' || state.user.role === 'socio';
      }
    } catch {}
    return false;
  }

  // ─── Auto-scroll durante drag ──────────────────────────────────────
  // HTML5 drag&drop NO hace auto-scroll cuando el item se acerca a los
  // bordes del viewport — el usuario queda trabado si la lista es larga.
  // Implementamos scroll manual con requestAnimationFrame mientras
  // dragover entra a la zona "caliente" (últimos 100px superior/inferior).
  // La velocidad escala linealmente con la cercanía al borde (px/frame).
  const SCROLL_EDGE = 100;     // px desde el borde donde activa el scroll
  const SCROLL_MAX_SPEED = 18; // px por frame en el borde mismo

  function _scrollLoop() {
    if (!rp.autoScrollDelta) {
      rp.autoScrollRaf = null;
      return;
    }
    // Si la pantalla está dentro de #sect-reglas-prov, scrollea su
    // contenedor scrollable más cercano O la ventana, según corresponda.
    window.scrollBy(0, rp.autoScrollDelta);
    rp.autoScrollRaf = requestAnimationFrame(_scrollLoop);
  }

  function _updateAutoScroll(clientY) {
    if (!rp.dragging) { rp.autoScrollDelta = 0; return; }
    const vh = window.innerHeight;
    let delta = 0;
    if (clientY < SCROLL_EDGE) {
      // Cerca del top → scroll hacia arriba (negativo).
      const intensity = (SCROLL_EDGE - clientY) / SCROLL_EDGE; // 1.0 en el borde, 0 al límite
      delta = -Math.round(SCROLL_MAX_SPEED * Math.max(0, Math.min(1, intensity)));
    } else if (clientY > vh - SCROLL_EDGE) {
      // Cerca del bottom → scroll hacia abajo (positivo).
      const intensity = (clientY - (vh - SCROLL_EDGE)) / SCROLL_EDGE;
      delta = Math.round(SCROLL_MAX_SPEED * Math.max(0, Math.min(1, intensity)));
    }
    rp.autoScrollDelta = delta;
    if (delta !== 0 && !rp.autoScrollRaf) rp.autoScrollRaf = requestAnimationFrame(_scrollLoop);
  }

  function _stopAutoScroll() {
    rp.autoScrollDelta = 0;
    if (rp.autoScrollRaf) { cancelAnimationFrame(rp.autoScrollRaf); rp.autoScrollRaf = null; }
  }

  function feedback(msg, ok) {
    const div = document.createElement('div');
    div.className = 'rp-feedback ' + (ok === false ? 'err' : 'ok');
    div.textContent = msg;
    document.body.appendChild(div);
    setTimeout(() => { div.style.transition = 'opacity .3s'; div.style.opacity = '0'; }, 2200);
    setTimeout(() => div.remove(), 2700);
  }

  // ─── Entry / Exit ──────────────────────────────────────────────────
  async function rpOpen() {
    // Ocultamos cualquier .sect activa y mostramos la nuestra. Recordamos
    // cuál estaba activa para "Volver" luego.
    const activa = document.querySelector('#sect-resumen.on, #sect-movimientos.on, #sect-gastos.on, #sect-proveedores.on, #sect-cruce.on');
    rp.prevSection = activa ? activa.id : 'sect-proveedores';
    document.querySelectorAll('.sect').forEach((s) => s.classList.remove('on'));
    // Ocultamos también la tab-bar para que se vea fullscreen.
    const tabsBar = document.querySelector('.tabs');
    if (tabsBar) tabsBar.style.display = 'none';
    $('sect-reglas-prov').classList.add('on');
    // Botón IA sólo admin (no socio).
    const btnIA = $('rp-btn-ia');
    if (btnIA) btnIA.style.display = esAdminEstricto() ? '' : 'none';
    if (!rp.booted) {
      await loadAll();
      rp.booted = true;
    } else {
      // Refresh cada vez por si algo cambió en otra pestaña.
      await loadAll();
    }
  }
  function rpClose() {
    $('sect-reglas-prov').classList.remove('on');
    const tabsBar = document.querySelector('.tabs');
    if (tabsBar) tabsBar.style.display = '';
    const prev = $(rp.prevSection || 'sect-proveedores');
    if (prev) prev.classList.add('on');
  }
  window.rpOpen = rpOpen;
  window.rpClose = rpClose;

  // ─── Load + render ─────────────────────────────────────────────────
  async function loadAll() {
    try {
      const [cats, sc, cl] = await Promise.all([
        api('/api/v1/bancos/reglas-prov/categorias'),
        api('/api/v1/bancos/reglas-prov/sin-clasificar?limit=1000'),
        api('/api/v1/bancos/reglas-prov/clasificados'),
      ]);
      rp.categorias = cats.categorias || [];
      rp.sinClasificar = sc.proveedores || [];
      rp.clasificadosByCat = cl.por_categoria || {};
      renderSinClasificar();
      renderCategorias();
      $('rp-cat-n').textContent = rp.categorias.length;
      _updateBulkButtonVisibility();
    } catch (e) {
      feedback('Error cargando reglas: ' + e.message, false);
      $('rp-sc-list').innerHTML = `<p style="color:var(--rp-red);padding:8px;font-size:11px">${esc(e.message)}</p>`;
    }
  }

  function renderSinClasificar() {
    const q = (rp.searchQ || '').toLowerCase();
    const rows = q
      ? rp.sinClasificar.filter((p) => (p.proveedor || '').toLowerCase().includes(q))
      : rp.sinClasificar;
    $('rp-sc-n').textContent = rows.length === rp.sinClasificar.length
      ? num0(rp.sinClasificar.length)
      : `${num0(rows.length)} de ${num0(rp.sinClasificar.length)}`;
    if (!rows.length) {
      $('rp-sc-list').innerHTML = `<p style="color:var(--text-2);padding:10px;font-size:11px;text-align:center">${q ? 'Sin matches para "' + esc(q) + '"' : '✓ No hay proveedores sin clasificar'}</p>`;
      return;
    }
    $('rp-sc-list').innerHTML = rows.map((p) => {
      const provEsc = esc(p.proveedor);
      const provAttr = String(p.proveedor).replace(/"/g, '&quot;');
      const sug = rp.sugerencias.get(p.proveedor);
      const sugClass = sug ? ` has-sug sug-${sug.confianza}` : '';
      const icon = sug
        ? (sug.confianza === 'alta' ? '🟢' : sug.confianza === 'media' ? '🟡' : '🔴')
        : '🔴';
      const sugBlock = sug ? `
        <div class="rp-sug-line">
          <span class="rp-sug-arrow">→</span>
          <span class="rp-sug-cat ${sug.confianza}">${esc(sug.categoria)}</span>
          <span style="font-size:9.5px;color:var(--text-2);text-transform:uppercase;letter-spacing:.3px">conf. ${sug.confianza}</span>
          <div class="rp-sug-actions">
            ${sug.confianza !== 'baja'
              ? `<button class="rp-sug-btn accept" onclick="rpAceptarSug('${provAttr}', event)" title="Aplicar esta clasificación">✓ Aceptar</button>`
              : `<button class="rp-sug-btn" onclick="rpEditarSug('${provAttr}', event)" title="Elegir categoría manual">⚙ manual</button>`}
            <button class="rp-sug-btn reject" onclick="rpRechazarSug('${provAttr}', event)" title="Descartar sugerencia">✗</button>
          </div>
        </div>
        ${sug.motivo ? `<div class="rp-sug-motivo">💡 ${esc(sug.motivo)}</div>` : ''}` : '';
      return `<div style="display:flex;flex-direction:column;gap:0">
        <div class="rp-item${sugClass}" draggable="true" data-prov="${provAttr}" title="Click para ver detalle · Arrastrar a una categoría">
          ${icon}
          <span class="rp-name">${provEsc}</span>
          <span class="rp-badge">${p.n_movimientos}mv · ${eur0(p.total_importe)}</span>
        </div>
        ${sugBlock}
      </div>`;
    }).join('');
    // Wire drag + click
    $('rp-sc-list').querySelectorAll('.rp-item').forEach((el) => {
      const prov = el.dataset.prov;
      el.addEventListener('dragstart', (ev) => {
        rp.dragging = prov;
        el.classList.add('dragging');
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', prov);
      });
      el.addEventListener('dragend', () => {
        el.classList.remove('dragging');
        rp.dragging = null;
        _stopAutoScroll();
      });
      // Click sin arrastre → modal de detalle. Usamos timeout para no
      // disparar al inicio del drag.
      let clickTimer = null;
      el.addEventListener('mousedown', () => {
        clickTimer = Date.now();
      });
      el.addEventListener('click', (ev) => {
        if (rp.dragging) return; // ignore if dragstart was triggered
        if (clickTimer && Date.now() - clickTimer < 200) verDetalle(prov);
      });
    });
  }

  function renderCategorias() {
    const cats = rp.categorias;
    const byCat = rp.clasificadosByCat;
    $('rp-cats').innerHTML = cats.map((c) => {
      const reglas = byCat[c] || [];
      const items = reglas.length === 0
        ? `<div class="rp-cat-drop">soltar acá</div>`
        : `<div class="rp-cat-drop has-items">${reglas.map((r) => {
            const checkClass = r.protegida ? ' protegida' : '';
            const lockIcon = r.protegida ? ' 🔒' : '';
            const btn = r.protegida
              ? ''
              : `<button onclick="rpDeleteRule(${r.id}, event)" title="Quitar regla · el histórico se mantiene en esta categoría">×</button>`;
            return `<div class="rp-rule${checkClass}">
              <span>✓</span>
              <span class="rp-name">${esc(r.proveedor_normalizado)}${lockIcon}</span>
              <span class="rp-badge">${r.n_movimientos}mv · ${eur0(r.total_importe)}</span>
              ${btn}
            </div>`;
          }).join('')}</div>`;
      return `<div class="rp-cat" data-cat="${esc(c)}">
        <h4>${esc(c)}<span class="rp-cat-count">${reglas.length} ${reglas.length === 1 ? 'regla' : 'reglas'}</span></h4>
        ${items}
      </div>`;
    }).join('');
    // Wire drop zones
    $('rp-cats').querySelectorAll('.rp-cat').forEach((cat) => {
      const c = cat.dataset.cat;
      cat.addEventListener('dragover', (ev) => {
        if (!rp.dragging) return;
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'move';
        cat.classList.add('drop-over');
      });
      cat.addEventListener('dragleave', () => cat.classList.remove('drop-over'));
      cat.addEventListener('drop', async (ev) => {
        ev.preventDefault();
        cat.classList.remove('drop-over');
        const prov = ev.dataTransfer.getData('text/plain') || rp.dragging;
        if (!prov) return;
        await asignar(prov, c);
      });
    });
  }

  // ─── Acciones ──────────────────────────────────────────────────────
  async function asignar(proveedor, categoria) {
    try {
      const r = await api('/api/v1/bancos/reglas-prov/asignar', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ proveedor, categoria }),
      });
      feedback(`✓ ${proveedor} → ${categoria} (${r.affected} movs · ${r.combos} combos)`);
      await loadAll();
    } catch (e) {
      feedback('✗ ' + e.message, false);
    }
  }

  window.rpDeleteRule = async function (id, ev) {
    if (ev) ev.stopPropagation();
    if (!confirm('¿Quitar la regla? El histórico de movimientos ya reclasificados se mantiene en esa categoría.')) return;
    try {
      await api('/api/v1/bancos/reglas-prov/' + id, { method: 'DELETE' });
      feedback('✓ Regla eliminada');
      await loadAll();
    } catch (e) {
      feedback('✗ ' + e.message, false);
    }
  };

  // ─── Modal detalle proveedor ───────────────────────────────────────
  async function verDetalle(proveedor) {
    const modal = $('rp-modal');
    const overlay = $('rp-modal-overlay');
    modal.innerHTML = '<p style="font-size:12px;color:var(--text-2)">Cargando…</p>';
    modal.style.display = 'block';
    overlay.style.display = 'block';
    try {
      const j = await api('/api/v1/bancos/reglas-prov/detalle/' + encodeURIComponent(proveedor));
      const t = j.total || { n: 0, total: 0 };
      modal.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px">
          <div>
            <h3 style="font-size:16px;font-weight:700">${esc(j.proveedor)}</h3>
            <p style="font-size:11px;color:var(--text-2);margin-top:3px">${num0(t.n)} movimientos · ${eur2(t.total)} en histórico</p>
          </div>
          <button onclick="rpCloseModal()" style="background:transparent;border:none;color:var(--text-2);cursor:pointer;font-size:20px;line-height:1">×</button>
        </div>
        <p style="font-size:11px;color:var(--text-2);margin-bottom:10px">Top 50 movimientos por importe (cualquier categoría / cualquier período):</p>
        <table style="width:100%;font-size:11px;border-collapse:collapse">
          <thead><tr style="border-bottom:1px solid var(--border-2);color:var(--text-2)">
            <th style="text-align:left;padding:5px">Fecha</th>
            <th style="text-align:left;padding:5px">Concepto</th>
            <th style="text-align:left;padding:5px">Categoría actual</th>
            <th style="text-align:right;padding:5px">Importe</th>
          </tr></thead>
          <tbody>
            ${(j.movimientos || []).map((m) => `
              <tr style="border-bottom:.5px solid var(--border-3)">
                <td style="padding:5px;color:var(--text-2)">${esc(m.fecha)}</td>
                <td style="padding:5px;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(m.concepto)}">${esc(m.concepto)}</td>
                <td style="padding:5px;color:var(--text-2);font-size:10px">${esc(m.categoria || '—')}</td>
                <td style="padding:5px;text-align:right;color:#dc2626">${eur2(m.importe)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
        <p style="font-size:10px;color:var(--text-2);margin-top:12px;font-style:italic">💡 Cerrá este modal y arrastrá el proveedor a una categoría para crear la regla.</p>`;
    } catch (e) {
      modal.innerHTML = `<p style="color:var(--rp-red);font-size:12px">Error: ${esc(e.message)}</p>`;
    }
  }
  window.rpCloseModal = function () {
    $('rp-modal').style.display = 'none';
    $('rp-modal-overlay').style.display = 'none';
  };

  // ─── Search wire ───────────────────────────────────────────────────
  // Lo conectamos cuando el sidebar esté visible (después del primer render).
  document.addEventListener('input', (ev) => {
    if (ev.target && ev.target.id === 'rp-sc-q') {
      rp.searchQ = ev.target.value;
      renderSinClasificar();
    }
  });

  // ─── IA: clasificación con Claude ─────────────────────────────────
  function _updateProgress(done, total, extra) {
    const bar = $('rp-progress'); const txt = $('rp-progress-text'); const fill = $('rp-progress-fill');
    if (!bar) return;
    if (total === 0) { bar.classList.remove('on'); return; }
    bar.classList.add('on');
    const pct = total > 0 ? (done / total) * 100 : 0;
    fill.style.width = pct.toFixed(1) + '%';
    txt.textContent = `Procesando con Claude… batch ${done} de ${total}${extra ? ' · ' + extra : ''}`;
  }
  function _hideProgress() {
    const bar = $('rp-progress'); if (bar) bar.classList.remove('on');
  }
  function _updateBulkButtonVisibility() {
    let verdes = 0;
    for (const s of rp.sugerencias.values()) if (s.confianza === 'alta') verdes++;
    const btn = $('rp-btn-accept-all');
    if (btn) {
      btn.style.display = verdes > 0 ? '' : 'none';
      btn.textContent = `✓ Aceptar todas las verdes (${verdes})`;
    }
    const clr = $('rp-btn-clear-sug');
    if (clr) clr.style.display = rp.sugerencias.size > 0 ? '' : 'none';
  }

  window.rpClasificarConIA = async function () {
    if (rp.iaCorriendo) return;
    const items = (rp.sinClasificar || []).filter((p) => !rp.sugerencias.has(p.proveedor));
    console.log('[ia-debug] sinClasificar:', (rp.sinClasificar || []).length, 'items:', items.length, 'sugerencias ya:', rp.sugerencias.size);
    if (!items.length) {
      feedback('No hay proveedores nuevos para clasificar (todos ya tienen sugerencia)', false);
      return;
    }
    if (!confirm(`Vamos a pedirle a Claude que clasifique ${items.length} proveedores. Esto consume tokens de la API y puede tardar 1–2 min. ¿Continuar?`)) return;

    rp.iaCorriendo = true;
    const btnIA = $('rp-btn-ia'); if (btnIA) btnIA.disabled = true;
    const BATCH = 50;
    const batches = [];
    for (let i = 0; i < items.length; i += BATCH) batches.push(items.slice(i, i + BATCH));
    _updateProgress(0, batches.length);
    let ok = 0, fail = 0;
    for (let i = 0; i < batches.length; i++) {
      try {
        const r = await api('/api/v1/bancos/reglas-prov/ia-clasificar', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ proveedores: batches[i] }),
        });
        for (const s of r.sugerencias || []) {
          if (s.proveedor) rp.sugerencias.set(s.proveedor, s);
        }
        ok += r.sugerencias?.length || 0;
      } catch (e) {
        console.error('[ia] batch', i, 'failed:', e);
        fail += batches[i].length;
        if (e.code === 503) {
          // Falta API key → no tiene sentido seguir intentando.
          feedback('Falta OPENROUTER_API_KEY en el server', false);
          break;
        }
      }
      _updateProgress(i + 1, batches.length, `${ok} sugerencias`);
      // Re-render parcial para que se vean apareciendo en vivo.
      renderSinClasificar();
      _updateBulkButtonVisibility();
    }
    _hideProgress();
    rp.iaCorriendo = false;
    if (btnIA) btnIA.disabled = false;
    feedback(`✓ ${ok} sugerencias generadas${fail ? ` · ${fail} fallaron` : ''}`, !fail);
  };

  window.rpAceptarSug = async function (proveedor, ev) {
    if (ev) ev.stopPropagation();
    const sug = rp.sugerencias.get(proveedor);
    if (!sug) return;
    try {
      await api('/api/v1/bancos/reglas-prov/asignar', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ proveedor, categoria: sug.categoria }),
      });
      rp.sugerencias.delete(proveedor);
      feedback(`✓ ${proveedor} → ${sug.categoria}`);
      await loadAll();
      _updateBulkButtonVisibility();
    } catch (e) {
      feedback('✗ ' + e.message, false);
    }
  };

  window.rpRechazarSug = function (proveedor, ev) {
    if (ev) ev.stopPropagation();
    rp.sugerencias.delete(proveedor);
    renderSinClasificar();
    _updateBulkButtonVisibility();
  };

  window.rpEditarSug = function (proveedor, ev) {
    if (ev) ev.stopPropagation();
    feedback('Arrastrá el proveedor a la categoría que prefieras', true);
  };

  window.rpLimpiarSugerencias = function () {
    if (!rp.sugerencias.size) return;
    if (!confirm(`Descartar ${rp.sugerencias.size} sugerencias?`)) return;
    rp.sugerencias.clear();
    renderSinClasificar();
    _updateBulkButtonVisibility();
  };

  window.rpAceptarTodasVerdes = async function () {
    const verdes = [...rp.sugerencias.entries()]
      .filter(([, s]) => s.confianza === 'alta')
      .map(([proveedor, s]) => ({ proveedor, categoria: s.categoria }));
    if (!verdes.length) return;
    if (!confirm(`Aplicar ${verdes.length} sugerencias de confianza ALTA?\n\nCada una crea una regla y reclasifica todos los movimientos históricos que coincidan.`)) return;
    rp.iaCorriendo = true;
    const btn = $('rp-btn-accept-all'); if (btn) btn.disabled = true;
    _updateProgress(0, verdes.length);
    let ok = 0, fail = 0;
    for (let i = 0; i < verdes.length; i++) {
      try {
        await api('/api/v1/bancos/reglas-prov/asignar', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(verdes[i]),
        });
        rp.sugerencias.delete(verdes[i].proveedor);
        ok++;
      } catch (e) {
        console.error('bulk asignar fail', verdes[i], e);
        fail++;
      }
      _updateProgress(i + 1, verdes.length, `${ok} OK${fail ? ' · ' + fail + ' fail' : ''}`);
    }
    _hideProgress();
    rp.iaCorriendo = false;
    if (btn) btn.disabled = false;
    feedback(`✓ ${ok} reglas creadas${fail ? ` · ${fail} fallaron` : ''}`, !fail);
    await loadAll();
    _updateBulkButtonVisibility();
  };

  // Esc para cerrar modal
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      if ($('rp-modal').style.display === 'block') window.rpCloseModal();
      else if ($('sect-reglas-prov').classList.contains('on')) rpClose();
    }
  });

  // Auto-scroll global mientras se está arrastrando un proveedor.
  // dragover dispara muy frecuentemente (cada movimiento del mouse),
  // así que sólo actualizamos el delta y dejamos que el RAF loop
  // haga el scroll a un ritmo consistente.
  document.addEventListener('dragover', (ev) => {
    if (!rp.dragging) return;
    // ev.preventDefault() acá NO — sólo en los drop zones específicos.
    // Si lo hacemos global, el browser muestra el cursor "drop" en
    // cualquier zona y confunde al user. Sólo necesitamos clientY.
    _updateAutoScroll(ev.clientY);
  }, true);
  // Safety net: si el drag se cancela (Esc, drop fuera, etc.) o termina
  // limpiamos el RAF aunque el dragend del item no haya disparado.
  document.addEventListener('dragend', _stopAutoScroll, true);
  document.addEventListener('drop', _stopAutoScroll, true);

  // ─── Gestión de categorías (CRUD) ──────────────────────────────────
  // Reutiliza el modal #rp-modal swappeando contenido. Estado local
  // efímero: rp.cats (array desde GET /categorias), rp.catsCreating
  // (form Nueva visible), rp.catsEditing (codigo que se está editando).
  rp.cats = [];
  rp.catsCreating = false;
  rp.catsEditing = null;

  async function rpOpenCategoriasManager() {
    const modal = $('rp-modal');
    const overlay = $('rp-modal-overlay');
    modal.innerHTML = '<p style="font-size:12px;color:var(--text-2)">Cargando categorías…</p>';
    modal.style.display = 'block';
    overlay.style.display = 'block';
    rp.catsCreating = false;
    rp.catsEditing = null;
    await _loadAndRenderCategorias();
  }
  window.rpOpenCategoriasManager = rpOpenCategoriasManager;

  async function _loadAndRenderCategorias() {
    try {
      const j = await api('/api/v1/bancos/categorias');
      rp.cats = j.categorias || [];
      _renderCategoriasList();
    } catch (e) {
      const modal = $('rp-modal');
      modal.innerHTML = `<p style="color:var(--rp-red);font-size:12px">Error: ${esc(e.message)}</p>`;
    }
  }

  function _renderCategoriasList() {
    const modal = $('rp-modal');
    const cats = rp.cats || [];
    const filaNueva = rp.catsCreating ? `
      <tr style="background:rgba(33,230,211,.08)">
        <td style="padding:6px"><input id="rp-cat-new-codigo" type="text" placeholder="NUEVA_CAT" maxlength="50"
          style="width:160px;padding:5px 8px;border:.5px solid var(--border-2);border-radius:5px;background:var(--bg-secondary);color:var(--text);font-size:12px;text-transform:uppercase"
          oninput="this.value=this.value.toUpperCase().replace(/[^A-Z_]/g,'')"></td>
        <td style="padding:6px"><input id="rp-cat-new-nombre" type="text" placeholder="Nombre visible" maxlength="100"
          style="width:200px;padding:5px 8px;border:.5px solid var(--border-2);border-radius:5px;background:var(--bg-secondary);color:var(--text);font-size:12px"></td>
        <td style="padding:6px;color:var(--text-2)">—</td>
        <td style="padding:6px;color:var(--text-2)">—</td>
        <td style="padding:6px;white-space:nowrap">
          <button onclick="rpCatCrearSubmit()" style="padding:4px 10px;border:none;border-radius:5px;background:#185FA5;color:#fff;cursor:pointer;font-size:11px;font-weight:500">Crear</button>
          <button onclick="rpCatCancelarNueva()" style="padding:4px 8px;border:.5px solid var(--border-2);border-radius:5px;background:transparent;color:var(--text);cursor:pointer;font-size:11px">Cancelar</button>
        </td>
      </tr>` : '';

    const rows = cats.map((c) => _renderCatRow(c)).join('');
    modal.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h3 style="font-size:16px;font-weight:700">Gestionar categorías <span style="font-size:11px;color:var(--text-2);font-weight:400">(${cats.length})</span></h3>
        <div style="display:flex;gap:6px">
          ${rp.catsCreating ? '' : '<button onclick="rpCatNueva()" style="padding:5px 12px;border:none;border-radius:6px;background:#185FA5;color:#fff;cursor:pointer;font-size:12px;font-weight:500">+ Nueva categoría</button>'}
          <button onclick="rpCloseModal()" style="background:transparent;border:none;color:var(--text-2);cursor:pointer;font-size:20px;line-height:1">×</button>
        </div>
      </div>
      <p style="font-size:11px;color:var(--text-2);margin-bottom:10px">El código interno no se puede editar (rompería reglas y movimientos existentes). Sólo el nombre display. Categorías 🔒 son del sistema y no se pueden eliminar.</p>
      <table style="width:100%;font-size:12px;border-collapse:collapse">
        <thead><tr style="border-bottom:1px solid var(--border-2);color:var(--text-2);font-size:11px">
          <th style="text-align:left;padding:6px">Código</th>
          <th style="text-align:left;padding:6px">Nombre display</th>
          <th style="text-align:right;padding:6px">Reglas</th>
          <th style="text-align:right;padding:6px">Movs</th>
          <th style="text-align:right;padding:6px">Acciones</th>
        </tr></thead>
        <tbody>
          ${filaNueva}
          ${rows}
        </tbody>
      </table>
      <div id="rp-cat-feedback" style="margin-top:10px;font-size:11px"></div>
    `;
    if (rp.catsCreating) setTimeout(() => $('rp-cat-new-codigo')?.focus(), 50);
  }

  function _renderCatRow(c) {
    const isEditing = rp.catsEditing === c.codigo;
    const codigoEsc = esc(c.codigo);
    const nombreEsc = esc(c.nombre_display);
    const lockedActions = c.protegida
      ? `<span title="Categoría protegida del sistema" style="color:var(--text-2);font-size:14px">🔒</span>`
      : `<button onclick="rpCatBorrar('${c.codigo}')" title="Eliminar" style="background:transparent;border:none;color:var(--text-2);cursor:pointer;font-size:14px;padding:2px 6px">🗑️</button>`;
    const editActions = isEditing
      ? `<button onclick="rpCatGuardarEdit('${c.codigo}')" style="padding:3px 8px;border:none;border-radius:5px;background:#185FA5;color:#fff;cursor:pointer;font-size:11px">Guardar</button>
         <button onclick="rpCatCancelarEdit()" style="padding:3px 8px;border:.5px solid var(--border-2);border-radius:5px;background:transparent;color:var(--text);cursor:pointer;font-size:11px">Cancelar</button>`
      : `<button onclick="rpCatEditar('${c.codigo}')" title="Editar nombre display" style="background:transparent;border:none;color:var(--text-2);cursor:pointer;font-size:14px;padding:2px 6px">✏️</button>
         ${lockedActions}`;
    const nombreCell = isEditing
      ? `<input id="rp-cat-edit-${c.codigo}" type="text" value="${nombreEsc}" maxlength="100"
          style="width:100%;padding:4px 8px;border:.5px solid var(--border-2);border-radius:4px;background:var(--bg-secondary);color:var(--text);font-size:12px"
          onkeydown="if(event.key==='Enter')rpCatGuardarEdit('${c.codigo}');if(event.key==='Escape')rpCatCancelarEdit()">`
      : nombreEsc;
    return `<tr style="border-bottom:.5px solid var(--border-3)">
      <td style="padding:6px;font-family:monospace;font-size:11px">${codigoEsc}${c.protegida ? ' 🔒' : ''}</td>
      <td style="padding:6px">${nombreCell}</td>
      <td style="padding:6px;text-align:right;color:var(--text-2)">${c.n_reglas}</td>
      <td style="padding:6px;text-align:right;color:var(--text-2)">${num0(c.n_movimientos)}</td>
      <td style="padding:6px;text-align:right;white-space:nowrap">${editActions}</td>
    </tr>`;
  }

  function _catFeedback(html, ok) {
    const el = $('rp-cat-feedback');
    if (!el) return;
    el.innerHTML = html;
    el.style.color = ok === false ? 'var(--rp-red)' : 'var(--rp-green)';
  }

  window.rpCatNueva = function () {
    rp.catsCreating = true;
    rp.catsEditing = null;
    _renderCategoriasList();
  };

  window.rpCatCancelarNueva = function () {
    rp.catsCreating = false;
    _renderCategoriasList();
  };

  window.rpCatCrearSubmit = async function () {
    const codigo = ($('rp-cat-new-codigo')?.value || '').trim();
    const nombre_display = ($('rp-cat-new-nombre')?.value || '').trim();
    if (!codigo || !nombre_display) {
      _catFeedback('Código y nombre son requeridos', false);
      return;
    }
    if (!/^[A-Z][A-Z_]*$/.test(codigo)) {
      _catFeedback('Código inválido — sólo letras mayúsculas y guión bajo (ej. NUEVA_CAT)', false);
      return;
    }
    try {
      await api('/api/v1/bancos/categorias', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ codigo, nombre_display }),
      });
      feedback(`✓ Categoría "${codigo}" creada`);
      rp.catsCreating = false;
      await _loadAndRenderCategorias();
      // Refrescar el panel de Reglas para que la nueva cat aparezca como drop-zone.
      loadAll().catch((err) => console.warn('[cat-new] refresh panel reglas', err));
    } catch (e) {
      _catFeedback('✗ ' + e.message, false);
    }
  };

  window.rpCatEditar = function (codigo) {
    rp.catsEditing = codigo;
    rp.catsCreating = false;
    _renderCategoriasList();
    setTimeout(() => {
      const inp = $(`rp-cat-edit-${codigo}`);
      if (inp) { inp.focus(); inp.select(); }
    }, 50);
  };

  window.rpCatCancelarEdit = function () {
    rp.catsEditing = null;
    _renderCategoriasList();
  };

  window.rpCatGuardarEdit = async function (codigo) {
    const nombre_display = ($(`rp-cat-edit-${codigo}`)?.value || '').trim();
    if (!nombre_display) {
      _catFeedback('Nombre no puede estar vacío', false);
      return;
    }
    try {
      await api(`/api/v1/bancos/categorias/${encodeURIComponent(codigo)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nombre_display }),
      });
      feedback(`✓ "${codigo}" renombrada → "${nombre_display}"`);
      rp.catsEditing = null;
      await _loadAndRenderCategorias();
      // Refresh del panel de Reglas para que las cards muestren el nombre actualizado.
      loadAll().catch((err) => console.warn('[cat-edit] refresh panel reglas', err));
    } catch (e) {
      _catFeedback('✗ ' + e.message, false);
    }
  };

  window.rpCatBorrar = async function (codigo) {
    const cat = (rp.cats || []).find((c) => c.codigo === codigo);
    if (!cat) return;
    if (cat.protegida) {
      _catFeedback('Categoría protegida del sistema — no se puede eliminar', false);
      return;
    }
    const tieneRefs = (cat.n_reglas + cat.n_movimientos) > 0;
    if (!tieneRefs) {
      if (!confirm(`¿Eliminar categoría "${codigo}"? No tiene reglas ni movimientos.`)) return;
      try {
        await api(`/api/v1/bancos/categorias/${encodeURIComponent(codigo)}`, { method: 'DELETE' });
        feedback(`✓ "${codigo}" eliminada`);
        await _loadAndRenderCategorias();
        loadAll().catch(() => {});
      } catch (e) {
        _catFeedback('✗ ' + e.message, false);
      }
      return;
    }
    // Con referencias: mostrar confirmación con opciones de reasignación.
    _showCatDeleteDialog(cat);
  };

  function _showCatDeleteDialog(cat) {
    const otrasCats = (rp.cats || []).filter((c) => c.codigo !== cat.codigo);
    const optionsHtml = otrasCats.map((c) => `<option value="${esc(c.codigo)}">${esc(c.nombre_display)} (${esc(c.codigo)})</option>`).join('');
    const modal = $('rp-modal');
    modal.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px">
        <div>
          <h3 style="font-size:15px;font-weight:700">⚠️ Eliminar "${esc(cat.codigo)}"</h3>
          <p style="font-size:12px;color:var(--text-2);margin-top:4px">Esta categoría tiene <strong>${cat.n_reglas} reglas</strong> y <strong>${num0(cat.n_movimientos)} movimientos</strong>. ¿Qué hacés con ellos?</p>
        </div>
        <button onclick="rpOpenCategoriasManager()" style="background:transparent;border:none;color:var(--text-2);cursor:pointer;font-size:18px;line-height:1">×</button>
      </div>
      <div style="background:var(--bg-secondary);border-radius:8px;padding:14px;margin-bottom:14px">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;padding:6px 0;font-size:13px">
          <input type="radio" name="rp-cat-reassign" id="rp-cat-r-sin" value="sin_clasificar" checked>
          <span>Mover todo a <strong>"Sin clasificar"</strong> (las reglas se eliminan, los movimientos quedan sin categoría hasta que se reclasifiquen)</span>
        </label>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;padding:6px 0;font-size:13px;flex-wrap:wrap">
          <input type="radio" name="rp-cat-reassign" id="rp-cat-r-otra" value="otra">
          <span>Mover todo a:</span>
          <select id="rp-cat-r-destino" onchange="document.getElementById('rp-cat-r-otra').checked=true" style="padding:4px 8px;border:.5px solid var(--border-2);border-radius:5px;background:var(--bg-primary);color:var(--text);font-size:12px">
            <option value="">— elegir categoría —</option>
            ${optionsHtml}
          </select>
        </label>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button onclick="rpOpenCategoriasManager()" style="padding:6px 14px;border:.5px solid var(--border-2);border-radius:6px;background:transparent;color:var(--text);cursor:pointer;font-size:12px">Cancelar</button>
        <button onclick="rpCatConfirmarBorrar('${esc(cat.codigo)}')" style="padding:6px 14px;border:none;border-radius:6px;background:#e63946;color:#fff;cursor:pointer;font-size:12px;font-weight:500">Eliminar igual</button>
      </div>
      <div id="rp-cat-feedback" style="margin-top:10px;font-size:11px"></div>
    `;
  }

  window.rpCatConfirmarBorrar = async function (codigo) {
    const modoSelec = document.querySelector('input[name="rp-cat-reassign"]:checked')?.value || 'sin_clasificar';
    let reassignTo = 'sin_clasificar';
    if (modoSelec === 'otra') {
      const destino = $('rp-cat-r-destino')?.value;
      if (!destino) {
        _catFeedback('Seleccioná una categoría destino', false);
        return;
      }
      reassignTo = destino;
    }
    try {
      const r = await api(`/api/v1/bancos/categorias/${encodeURIComponent(codigo)}?reassign_to=${encodeURIComponent(reassignTo)}`, { method: 'DELETE' });
      feedback(`✓ "${codigo}" eliminada — ${r.n_reglas} reglas + ${r.n_movimientos} movs ${r.modo === 'sin_clasificar' ? 'sin clasificar' : 'movidos a ' + r.reassign_to}`);
      // Volver a la lista
      await rpOpenCategoriasManager();
      loadAll().catch(() => {});
    } catch (e) {
      _catFeedback('✗ ' + e.message, false);
    }
  };

})();
