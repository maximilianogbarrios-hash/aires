// Módulo Ventas — dashboard TPV.
//
// Entry: window.vtInit() — invocado por showTab('ventas') la primera
// vez que se abre la pestaña. Idempotente (no re-arma si ya está).
//
// Estado: vt.state contiene filtros activos + meta + caches por tab.
// Cualquier cambio en filtros dispara vt.refresh() debounced 300ms,
// que refresca KPIs + topbar + el tab activo (no todos los tabs).

(function () {
  const $ = (id) => document.getElementById(id);

  // ─── Formateo es-ES ────────────────────────────────────────────────
  const _eurFmt0 = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
  const _eurFmt2 = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 });
  const _numFmt0 = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 });
  const _numFmt2 = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2 });
  const eur0 = (v) => v == null || !isFinite(v) ? '—' : _eurFmt0.format(v);
  const eur2 = (v) => v == null || !isFinite(v) ? '—' : _eurFmt2.format(v);
  const num0 = (v) => v == null || !isFinite(v) ? '—' : _numFmt0.format(v);
  const num2 = (v) => v == null || !isFinite(v) ? '—' : _numFmt2.format(v);
  const pct1 = (v) => v == null || !isFinite(v) ? '—' : (v * 100).toFixed(1).replace('.', ',') + '%';
  const pct2 = (v) => v == null || !isFinite(v) ? '—' : (v * 100).toFixed(2).replace('.', ',') + '%';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // ─── HTTP ──────────────────────────────────────────────────────────
  async function api(path) {
    const r = await fetch(path, { credentials: 'same-origin' });
    if (r.status === 401) { location.href = '/login'; return null; }
    if (r.status === 403) { const e = new Error('forbidden'); e.code = 403; throw e; }
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      const e = new Error(t || `HTTP ${r.status}`); e.code = r.status; throw e;
    }
    return r.json();
  }

  // ─── Estado del módulo ─────────────────────────────────────────────
  const vt = {
    booted: false,
    meta: null,           // { locales, familias, semanas, productos, rango }
    role: null,
    filtros: {
      marca: 'all',
      fecha_desde: '',
      fecha_hasta: '',
      semanas: new Set(),
      franja: 'all',
      canal: 'all',
      locales: new Set(),   // vacío = todos
      familias: new Set(),  // vacío = todas
      productos: new Set(), // vacío = todos
      solo_jueves: false,
    },
    currentTab: 'productos',
    productSearch: '',
    productSort: { col: 'venta_total', dir: -1 },
    productPage: 0,
    productPageSize: 50,
    sucursalSort: { col: 'venta_total', dir: -1 },
    promoSort: { col: 'venta_total', dir: -1 },
    camareroSort: { col: 'venta_total', dir: -1 },
    cache: { productos: null, sucursales: null, promociones: null, diahora: null, camareros: null, costos: null },
    charts: {},   // Chart.js instances keyed by canvas id (destruir antes de re-crear)
    camarerosAccess: true,    // se vuelve false en el primer 403
    refreshTimer: null,
    // Estado del tab Costos
    costosFiltros: { q: '', familia: '', estado: 'all' },
    costosSort: { col: 'uds_vendidas', dir: -1 },
    costosPage: 0,
    costosPageSize: 50,
  };

  // Permiso para editar costos (admin/socio/gerente)
  function puedeEditarCostos() {
    return ['admin', 'socio', 'gerente'].includes(vt.role);
  }

  // ─── Boot ──────────────────────────────────────────────────────────
  async function vtInit() {
    if (vt.booted) return;
    vt.booted = true;
    try {
      vt.role = (window.ctx && ctx.user && ctx.user.role) || null;
      vt.meta = await api('/api/v1/ventas/filtros-meta');
      // Defaults de fechas = rango completo del dataset.
      if (vt.meta.rango) {
        vt.filtros.fecha_desde = vt.meta.rango.fecha_min || '';
        vt.filtros.fecha_hasta = vt.meta.rango.fecha_max || '';
      }
      // Locales/familias por defecto: todos seleccionados (Set vacío =
      // sin filtro, pero queremos marcar las checkboxes; representamos
      // "todos" como Set lleno y el query helper lo trata como sin filtro
      // si su tamaño = total).
      for (const l of vt.meta.locales) vt.filtros.locales.add(l.nombre);
      for (const f of vt.meta.familias) vt.filtros.familias.add(f.nombre);
      aplicarAccessControl();
      renderSidebar();
      renderTopbar();
      await refresh();
    } catch (e) {
      console.error('[ventas] init failed', e);
      $('vt-sidebar').innerHTML = '<p style="font-size:12px;color:#e63946;padding:8px">Error cargando filtros: ' + esc(e.message) + '</p>';
    }
  }

  // ─── Access control ────────────────────────────────────────────────
  // pedidos:  sólo Productos con columnas reducidas (sin €, sin margen)
  // personal: sólo Día y Hora
  // admin/socio/gerente: todo
  function aplicarAccessControl() {
    const r = vt.role;
    const tabs = document.querySelectorAll('#sect-ventas .vt-tab');
    let permitidos = ['productos', 'graficos', 'sucursales', 'promociones', 'diahora', 'camareros', 'costos'];
    // Pedidos: sólo Productos + Costos (sin margen/M.Obra, sólo costo MP).
    if (r === 'pedidos')  permitidos = ['productos', 'costos'];
    // Personal: sólo Día y Hora.
    if (r === 'personal') permitidos = ['diahora'];
    // Camareros sólo admin/socio/gerente.
    if (!['admin', 'socio', 'gerente'].includes(r)) {
      permitidos = permitidos.filter((t) => t !== 'camareros');
    }
    tabs.forEach((btn) => {
      const t = btn.dataset.vtab;
      btn.style.display = permitidos.includes(t) ? '' : 'none';
    });
    // Si la tab activa actual no es accesible, switchear a la primera permitida.
    if (!permitidos.includes(vt.currentTab)) {
      vt.currentTab = permitidos[0] || 'productos';
      tabs.forEach((b) => b.classList.toggle('active', b.dataset.vtab === vt.currentTab));
      document.querySelectorAll('#sect-ventas .vt-tab-pane').forEach((p) => p.classList.remove('active'));
      const pane = $(`vt-pane-${vt.currentTab}`);
      if (pane) pane.classList.add('active');
    }
  }

  // ─── Sidebar ───────────────────────────────────────────────────────
  function renderSidebar() {
    const m = vt.meta;
    const f = vt.filtros;
    const esRolReducido = vt.role === 'pedidos' || vt.role === 'personal';
    const sb = $('vt-sidebar');
    if (!sb) return;
    const pillsSemanas = (m.semanas || []).map((s) => {
      const id = `${s.anio}-${s.semana}`;
      const active = f.semanas.has(id) ? ' active' : '';
      return `<button class="vt-pill${active}" data-sem="${id}" title="${esc(s.fecha_min)} → ${esc(s.fecha_max)}">S${s.semana}</button>`;
    }).join('');
    const locales = (m.locales || []).map((l) => `
      <label class="vt-chk-row">
        <input type="checkbox" data-loc="${esc(l.nombre)}" ${f.locales.has(l.nombre) ? 'checked' : ''}>
        <span>${esc(l.nombre)}</span>
      </label>`).join('');
    const familias = (m.familias || []).map((fa) => `
      <label class="vt-chk-row">
        <input type="checkbox" data-fam="${esc(fa.nombre)}" ${f.familias.has(fa.nombre) ? 'checked' : ''}>
        <span>${esc(fa.nombre)}</span>
      </label>`).join('');

    sb.innerHTML = `
      <div class="vt-sec">
        <div class="vt-lbl">Marca</div>
        <div class="vt-brand-btns" id="vt-brand-btns">
          <button class="vt-brand-btn b-all ${f.marca === 'all' ? 'active' : ''}"     data-marca="all">Todas</button>
          <button class="vt-brand-btn b-aires ${f.marca === 'aires' ? 'active' : ''}" data-marca="aires">Aires</button>
          <button class="vt-brand-btn b-chicken ${f.marca === 'chicken' ? 'active' : ''}" data-marca="chicken">Chicken</button>
        </div>
      </div>

      <div class="vt-sec">
        <div class="vt-lbl">Rango de fechas</div>
        <div class="vt-date-grid">
          <div><label>Desde</label><input type="date" id="vt-desde" value="${esc(f.fecha_desde)}"></div>
          <div><label>Hasta</label><input type="date" id="vt-hasta" value="${esc(f.fecha_hasta)}"></div>
        </div>
      </div>

      <div class="vt-sec">
        <div class="vt-lbl">Semanas
          <div class="vt-lbl-btns">
            <button class="vt-btn-xs" id="vt-sem-all">Todas</button>
            <button class="vt-btn-xs" id="vt-sem-none">Ninguna</button>
          </div>
        </div>
        <div class="vt-pills" id="vt-pills-sem">${pillsSemanas || '<span style="font-size:10px;color:var(--vt-muted)">—</span>'}</div>
        <button class="vt-jue ${f.solo_jueves ? 'active' : ''}" id="vt-jueves">Solo Jueves 2×1</button>
      </div>

      <div class="vt-sec">
        <div class="vt-lbl">Franja horaria</div>
        <div class="vt-tog-row" id="vt-franja-row">
          <button class="vt-tog ${f.franja === 'all' ? 'active' : ''}" data-franja="all">Todas</button>
          <button class="vt-tog ${f.franja === '12' ? 'active' : ''}"  data-franja="12">12-16h</button>
          <button class="vt-tog ${f.franja === '16' ? 'active' : ''}"  data-franja="16">16-19h</button>
          <button class="vt-tog ${f.franja === '19' ? 'active' : ''}"  data-franja="19">19-2am</button>
        </div>
      </div>

      <div class="vt-sec">
        <div class="vt-lbl">Canal de ventas</div>
        <div class="vt-tog-row" id="vt-canal-row">
          <button class="vt-tog ${f.canal === 'all' ? 'active' : ''}"   data-canal="all">Todos</button>
          <button class="vt-tog glv ${f.canal === 'glovo' ? 'active' : ''}" data-canal="glovo">GLOVO</button>
          <button class="vt-tog ${f.canal === 'sala' ? 'active' : ''}"  data-canal="sala">Sala/Terraza</button>
        </div>
      </div>

      <div class="vt-sec">
        <div class="vt-lbl">Locales (${(m.locales || []).length})
          <div class="vt-lbl-btns">
            <button class="vt-btn-xs" id="vt-loc-all">Todas</button>
            <button class="vt-btn-xs" id="vt-loc-none">Ninguna</button>
          </div>
        </div>
        <div class="vt-chk-list" id="vt-loc-list">${locales}</div>
      </div>

      <div class="vt-sec">
        <div class="vt-lbl">Familias (${(m.familias || []).length})
          <div class="vt-lbl-btns">
            <button class="vt-btn-xs" id="vt-fam-all">Todas</button>
            <button class="vt-btn-xs" id="vt-fam-none">Ninguna</button>
          </div>
        </div>
        <div class="vt-chk-list" id="vt-fam-list">${familias}</div>
      </div>

      <div class="vt-sec">
        <div class="vt-lbl">Productos (buscar)</div>
        <input type="text" class="vt-search" id="vt-prod-search" placeholder="🔍 escribir nombre…" value="${esc(f.productos.size === 1 ? [...f.productos][0] : '')}">
        <p style="font-size:9.5px;color:var(--vt-muted);margin-top:5px">Tip: escribí parte del nombre para filtrar al producto exacto. Vacío = todos.</p>
      </div>

      <div class="vt-foot">
        <div class="vt-foot-stat"><span>Registros</span><strong id="vt-foot-n">—</strong></div>
        <div class="vt-foot-stat"><span>Venta total</span><strong id="vt-foot-venta">—</strong></div>
        ${esRolReducido ? '' : `<div class="vt-foot-stat"><span>Neto Glovo</span><strong id="vt-foot-neto">—</strong></div>`}
        <button class="vt-reset" id="vt-reset">× Restablecer filtros</button>
      </div>
    `;

    // Wire events
    sb.querySelectorAll('#vt-brand-btns .vt-brand-btn').forEach((b) => b.onclick = () => { f.marca = b.dataset.marca; refreshSidebarActive('marca'); scheduleRefresh(); });
    sb.querySelectorAll('#vt-franja-row .vt-tog').forEach((b) => b.onclick = () => { f.franja = b.dataset.franja; refreshSidebarActive('franja'); scheduleRefresh(); });
    sb.querySelectorAll('#vt-canal-row .vt-tog').forEach((b) => b.onclick = () => { f.canal = b.dataset.canal; refreshSidebarActive('canal'); scheduleRefresh(); });
    sb.querySelectorAll('#vt-pills-sem .vt-pill').forEach((b) => b.onclick = () => {
      const id = b.dataset.sem;
      if (f.semanas.has(id)) f.semanas.delete(id); else f.semanas.add(id);
      b.classList.toggle('active');
      scheduleRefresh();
    });
    sb.querySelectorAll('#vt-loc-list input').forEach((cb) => cb.onchange = () => {
      if (cb.checked) f.locales.add(cb.dataset.loc); else f.locales.delete(cb.dataset.loc);
      scheduleRefresh();
    });
    sb.querySelectorAll('#vt-fam-list input').forEach((cb) => cb.onchange = () => {
      if (cb.checked) f.familias.add(cb.dataset.fam); else f.familias.delete(cb.dataset.fam);
      scheduleRefresh();
    });
    const $d = $('vt-desde'); if ($d) $d.onchange = () => { f.fecha_desde = $d.value; scheduleRefresh(); };
    const $h = $('vt-hasta'); if ($h) $h.onchange = () => { f.fecha_hasta = $h.value; scheduleRefresh(); };
    $('vt-jueves').onclick = (e) => { f.solo_jueves = !f.solo_jueves; e.currentTarget.classList.toggle('active'); scheduleRefresh(); };
    $('vt-sem-all').onclick  = () => { f.semanas = new Set((vt.meta.semanas || []).map((s) => `${s.anio}-${s.semana}`)); renderSidebar(); scheduleRefresh(); };
    $('vt-sem-none').onclick = () => { f.semanas.clear(); renderSidebar(); scheduleRefresh(); };
    $('vt-loc-all').onclick  = () => { f.locales = new Set((vt.meta.locales || []).map((l) => l.nombre)); renderSidebar(); scheduleRefresh(); };
    $('vt-loc-none').onclick = () => { f.locales.clear(); renderSidebar(); scheduleRefresh(); };
    $('vt-fam-all').onclick  = () => { f.familias = new Set((vt.meta.familias || []).map((x) => x.nombre)); renderSidebar(); scheduleRefresh(); };
    $('vt-fam-none').onclick = () => { f.familias.clear(); renderSidebar(); scheduleRefresh(); };
    const $p = $('vt-prod-search');
    if ($p) {
      $p.oninput = () => {
        const q = $p.value.trim();
        f.productos.clear();
        if (q) {
          // Match exacto contra meta.productos (sino el filtro server no
          // sirve). Si el usuario escribe parcial, sumamos los matches.
          const matches = (vt.meta.productos || []).filter((p) => (p.nombre || '').toLowerCase().includes(q.toLowerCase()));
          matches.slice(0, 15).forEach((p) => f.productos.add(p.nombre));
        }
        scheduleRefresh();
      };
    }
    $('vt-reset').onclick = () => { resetFiltros(); renderSidebar(); refresh(); };
  }

  function refreshSidebarActive(group) {
    const sb = $('vt-sidebar'); if (!sb) return;
    const f = vt.filtros;
    if (group === 'marca')  sb.querySelectorAll('#vt-brand-btns .vt-brand-btn').forEach((b) => b.classList.toggle('active', b.dataset.marca === f.marca));
    if (group === 'franja') sb.querySelectorAll('#vt-franja-row .vt-tog').forEach((b) => b.classList.toggle('active', b.dataset.franja === f.franja));
    if (group === 'canal')  sb.querySelectorAll('#vt-canal-row .vt-tog').forEach((b) => b.classList.toggle('active', b.dataset.canal === f.canal));
  }

  function resetFiltros() {
    vt.filtros.marca = 'all';
    vt.filtros.fecha_desde = vt.meta.rango?.fecha_min || '';
    vt.filtros.fecha_hasta = vt.meta.rango?.fecha_max || '';
    vt.filtros.semanas.clear();
    vt.filtros.franja = 'all';
    vt.filtros.canal = 'all';
    vt.filtros.locales = new Set((vt.meta.locales || []).map((l) => l.nombre));
    vt.filtros.familias = new Set((vt.meta.familias || []).map((x) => x.nombre));
    vt.filtros.productos.clear();
    vt.filtros.solo_jueves = false;
  }

  // ─── Topbar ────────────────────────────────────────────────────────
  function renderTopbar() {
    const f = vt.filtros;
    const r = vt.meta.rango || {};
    const pill = $('vt-tb-pill');
    if (pill) {
      pill.className = 'vt-tb-pill b-' + f.marca;
      pill.textContent = f.marca === 'all' ? 'Todas' : f.marca === 'aires' ? 'Aires' : 'Chicken';
    }
    const sub = $('vt-tb-sub');
    if (sub) {
      const d = f.fecha_desde || r.fecha_min;
      const h = f.fecha_hasta || r.fecha_max;
      sub.textContent = `${d || '—'} → ${h || '—'} · ${r.total_lineas != null ? num0(r.total_lineas) + ' líneas en BD' : ''}`;
    }
  }

  // ─── Query params builder ──────────────────────────────────────────
  function buildQS() {
    const f = vt.filtros;
    const p = new URLSearchParams();
    if (f.fecha_desde) p.set('fecha_desde', f.fecha_desde);
    if (f.fecha_hasta) p.set('fecha_hasta', f.fecha_hasta);
    if (f.marca !== 'all') p.set('marca', f.marca);
    if (f.canal !== 'all') p.set('canal', f.canal);
    if (f.franja !== 'all') p.set('franja', f.franja);
    if (f.solo_jueves) p.set('solo_jueves', 'true');
    if (f.semanas.size) p.set('semanas', [...f.semanas].map((id) => id.split('-')[1]).join(','));
    // Locales: si están TODOS seleccionados, no enviamos filtro
    // (más rápido en backend y semántica clara).
    const totalLoc = (vt.meta.locales || []).length;
    if (f.locales.size && f.locales.size < totalLoc) p.set('locales', [...f.locales].join(','));
    const totalFam = (vt.meta.familias || []).length;
    if (f.familias.size && f.familias.size < totalFam) p.set('familias', [...f.familias].join(','));
    if (f.productos.size) p.set('productos', [...f.productos].join(','));
    return p.toString();
  }

  // ─── Refresh debounced ─────────────────────────────────────────────
  function scheduleRefresh() {
    clearTimeout(vt.refreshTimer);
    vt.refreshTimer = setTimeout(refresh, 300);
  }

  async function refresh() {
    renderTopbar();
    // Invalidar caches del tab activo
    vt.cache = { productos: null, sucursales: null, promociones: null, diahora: null, camareros: null };
    await Promise.all([loadKpis(), loadTab(vt.currentTab)]);
  }

  // ─── KPIs ──────────────────────────────────────────────────────────
  async function loadKpis() {
    const qs = buildQS();
    try {
      const k = await api('/api/v1/ventas/kpis?' + qs);
      renderKpis(k);
    } catch (e) {
      $('vt-kpis').innerHTML = `<p style="font-size:12px;color:#e63946;grid-column:1/-1">Error KPIs: ${esc(e.message)}</p>`;
    }
  }

  function renderKpis(k) {
    const esRolReducido = vt.role === 'pedidos' || vt.role === 'personal';
    const subMargenReal = k.n_productos_con_costo
      ? `Margen real · ${k.n_productos_con_costo}/${k.n_productos_total} prods (${k.venta_cubierta > 0 ? pct1(k.venta_cubierta / k.venta_total) : '0%'} venta cubierta)`
      : 'sin costos cargados';
    const cards = [
      { lbl: 'Venta Total', val: eur0(k.venta_total), cls: '' },
      { lbl: 'Venta GLOVO', val: eur0(k.venta_glovo), sub: k.venta_total > 0 ? pct1(k.venta_glovo / k.venta_total) + ' del total' : '', cls: 'vt-kpi-glovo' },
      { lbl: 'Comisión GLOVO', val: eur0(k.comision_glovo), sub: pct2(k.pct_comision_glovo), cls: '' },
      { lbl: 'Neto GLOVO', val: eur0(k.neto_glovo), cls: 'vt-kpi-glovo' },
      { lbl: 'Margen Bruto TPV', val: eur0(k.margen_bruto_total), sub: k.mostrar_aviso_anomalas ? '⚠️ ver nota (TPV)' : '', cls: 'vt-kpi-margen' },
      { lbl: '% Margen TPV', val: pct2(k.pct_margen_medio), cls: 'vt-kpi-margen' },
      { lbl: 'Margen Real', val: eur0(k.margen_real), sub: subMargenReal, cls: 'vt-kpi-real' },
      { lbl: '% Margen Real', val: pct2(k.pct_margen_real), sub: k.n_productos_con_costo ? `${k.n_productos_con_costo} productos con costo` : '', cls: 'vt-kpi-real' },
    ];
    // En pedidos/personal escondemos cards de €/margen.
    const visibles = esRolReducido ? cards.filter((c) => c.lbl === 'Venta Total') : cards;
    $('vt-kpis').innerHTML = visibles.map((c) => `
      <div class="vt-kpi ${c.cls}">
        <div class="vt-kpi-lbl">${esc(c.lbl)}</div>
        <div class="vt-kpi-val">${c.val}</div>
        ${c.sub ? `<div class="vt-kpi-sub">${esc(c.sub)}</div>` : ''}
      </div>`).join('');

    // Badges del topbar
    $('vt-tb-venta').textContent  = eur0(k.venta_total);
    $('vt-tb-glovo').textContent  = eur0(k.venta_glovo);
    $('vt-tb-margen').textContent = eur0(k.margen_bruto_total);

    const warn = $('vt-warn');
    if (k.mostrar_aviso_anomalas) {
      warn.style.display = '';
      warn.innerHTML = `⚠️ <strong>${num0(k.n_lineas_anomalas)}</strong> productos tienen costes pendientes de validación en el TPV — los márgenes pueden no ser exactos`;
    } else {
      warn.style.display = 'none';
    }

    // Foot stats del sidebar
    if ($('vt-foot-n'))     $('vt-foot-n').textContent     = num0(k.n_lineas);
    if ($('vt-foot-venta')) $('vt-foot-venta').textContent = eur0(k.venta_total);
    if ($('vt-foot-neto'))  $('vt-foot-neto').textContent  = eur0(k.neto_glovo);
  }

  // ─── Tab switching ─────────────────────────────────────────────────
  function vtShowTab(name, btn) {
    vt.currentTab = name;
    document.querySelectorAll('#sect-ventas .vt-tab').forEach((b) => b.classList.toggle('active', b.dataset.vtab === name));
    document.querySelectorAll('#sect-ventas .vt-tab-pane').forEach((p) => p.classList.remove('active'));
    const pane = $(`vt-pane-${name}`); if (pane) pane.classList.add('active');
    loadTab(name);
  }
  window.vtShowTab = vtShowTab;

  async function loadTab(name) {
    if (name === 'productos')   return loadProductos();
    if (name === 'graficos')    return loadGraficos();
    if (name === 'sucursales')  return loadSucursales();
    if (name === 'promociones') return loadPromociones();
    if (name === 'diahora')     return loadDiaHora();
    if (name === 'camareros')   return loadCamareros();
    if (name === 'costos')      return loadCostos();
  }

  function _paneSkel(id) {
    const p = $(id); if (!p) return;
    p.innerHTML = '<div class="vt-card"><div class="vt-skel" style="height:18px;width:30%"></div><div class="vt-skel"></div><div class="vt-skel"></div><div class="vt-skel"></div><div class="vt-skel"></div></div>';
  }
  function _paneError(id, e) {
    const p = $(id); if (!p) return;
    p.innerHTML = `<div class="vt-card"><p style="font-size:12px;color:#e63946">Error: ${esc(e.message)}</p></div>`;
  }

  // ─── Productos ─────────────────────────────────────────────────────
  async function loadProductos() {
    _paneSkel('vt-pane-productos');
    try {
      const j = vt.cache.productos || await api('/api/v1/ventas/productos?limit=2000&' + buildQS());
      vt.cache.productos = j;
      renderProductos(j);
    } catch (e) { _paneError('vt-pane-productos', e); }
  }

  function _margenColor(p) {
    if (p == null) return 'var(--vt-muted)';
    if (p >= 0.5) return 'var(--vt-green)';
    if (p >= 0.3) return 'var(--vt-amber)';
    return 'var(--vt-red)';
  }

  function renderProductos(j) {
    const esRolReducido = vt.role === 'pedidos';
    let rows = j.productos || [];
    // Search en cliente
    const q = (vt.productSearch || '').toLowerCase();
    if (q) rows = rows.filter((r) => (r.producto || '').toLowerCase().includes(q));
    // Sort
    const { col, dir } = vt.productSort;
    rows = [...rows].sort((a, b) => {
      const av = a[col], bv = b[col];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'string') return dir * av.localeCompare(bv);
      return dir * (av < bv ? -1 : av > bv ? 1 : 0);
    });
    const total = rows.length;
    const pageSize = vt.productPageSize;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    if (vt.productPage >= totalPages) vt.productPage = 0;
    const pageRows = rows.slice(vt.productPage * pageSize, (vt.productPage + 1) * pageSize);

    const arrow = (c) => col === c ? (dir < 0 ? ' ↓' : ' ↑') : '';
    const headFull = `
      <tr>
        <th onclick="vtSortProd('producto')">Producto${arrow('producto')}</th>
        <th onclick="vtSortProd('familia')">Familia${arrow('familia')}</th>
        <th>Canal</th>
        <th class="r" onclick="vtSortProd('uds')">Uds.${arrow('uds')}</th>
        <th class="r" onclick="vtSortProd('p_medio_venta')">P. Medio €${arrow('p_medio_venta')}</th>
        <th class="r" onclick="vtSortProd('costo_ud')">Costo/Ud €${arrow('costo_ud')}</th>
        <th class="r" onclick="vtSortProd('com_glovo_ud')">Com.Glovo/Ud €${arrow('com_glovo_ud')}</th>
        <th class="r" onclick="vtSortProd('neto_ud_real')">Neto/Ud €${arrow('neto_ud_real')}</th>
        <th class="r" onclick="vtSortProd('margen_ud')">Margen/Ud €${arrow('margen_ud')}</th>
        <th class="r" onclick="vtSortProd('pct_margen')">% Margen${arrow('pct_margen')}</th>
        <th class="r" onclick="vtSortProd('venta_total')">Venta Total €${arrow('venta_total')}</th>
        <th class="r" onclick="vtSortProd('margen_total')">Margen Total €${arrow('margen_total')}</th>
        <th>Promo</th>
      </tr>`;
    const headReducido = `
      <tr>
        <th onclick="vtSortProd('producto')">Producto${arrow('producto')}</th>
        <th onclick="vtSortProd('familia')">Familia${arrow('familia')}</th>
        <th class="r" onclick="vtSortProd('uds')">Uds.${arrow('uds')}</th>
      </tr>`;
    const trsFull = pageRows.map((r) => {
      const barPct = Math.max(0, Math.min(1, r.pct_margen || 0));
      const barCol = _margenColor(r.pct_margen);
      return `<tr>
        <td>${esc(r.producto)}</td>
        <td style="color:var(--vt-muted)">${esc(r.familia || '—')}</td>
        <td><span class="vt-chip-canal ${r.canal}">${esc(r.canal.toUpperCase())}</span></td>
        <td class="r">${num2(r.uds)}</td>
        <td class="r">${eur2(r.p_medio_venta)}</td>
        <td class="r">${eur2(r.costo_ud)}</td>
        <td class="r" style="color:var(--vt-glovo)">${r.com_glovo_ud > 0 ? eur2(r.com_glovo_ud) : '—'}</td>
        <td class="r">${eur2(r.neto_ud_real)}</td>
        <td class="r">${eur2(r.margen_ud)}</td>
        <td class="r"><span class="vt-margen-bar"><i style="width:${(barPct*100).toFixed(0)}%;background:${barCol}"></i></span>${pct1(r.pct_margen)}</td>
        <td class="r">${eur0(r.venta_total)}</td>
        <td class="r">${eur0(r.margen_total)}</td>
        <td style="color:var(--vt-muted);font-size:10px">${r.promocion_sample ? esc(r.promocion_sample) : ''}</td>
      </tr>`;
    }).join('');
    const trsReducido = pageRows.map((r) => `<tr>
      <td>${esc(r.producto)}</td>
      <td style="color:var(--vt-muted)">${esc(r.familia || '—')}</td>
      <td class="r">${num2(r.uds)}</td>
    </tr>`).join('');

    $('vt-pane-productos').innerHTML = `
      <div class="vt-card">
        <div class="vt-card-head">
          <span class="vt-card-title">Productos · ${num0(total)} filas</span>
          <input type="text" id="vt-prod-q" class="vt-search" style="max-width:280px" placeholder="🔍 filtrar producto…" value="${esc(vt.productSearch)}">
        </div>
        <div class="vt-tbl-wrap">
          <table class="vt-tbl">
            <thead>${esRolReducido ? headReducido : headFull}</thead>
            <tbody>${esRolReducido ? trsReducido : trsFull}</tbody>
          </table>
        </div>
        <div class="vt-paginator">
          <span>Página ${vt.productPage + 1} / ${totalPages} · ${num0(pageRows.length)} de ${num0(total)}</span>
          <div>
            <button id="vt-prod-prev" ${vt.productPage === 0 ? 'disabled' : ''}>← Anterior</button>
            <button id="vt-prod-next" ${vt.productPage >= totalPages - 1 ? 'disabled' : ''}>Siguiente →</button>
          </div>
        </div>
      </div>`;
    const $q = $('vt-prod-q');
    if ($q) {
      $q.oninput = () => { vt.productSearch = $q.value; vt.productPage = 0; renderProductos(j); };
      // Restore focus + cursor position after innerHTML replacement
      setTimeout(() => { $q.focus(); $q.setSelectionRange($q.value.length, $q.value.length); }, 0);
    }
    $('vt-prod-prev').onclick = () => { vt.productPage = Math.max(0, vt.productPage - 1); renderProductos(j); };
    $('vt-prod-next').onclick = () => { vt.productPage = Math.min(totalPages - 1, vt.productPage + 1); renderProductos(j); };
  }

  window.vtSortProd = function (col) {
    const s = vt.productSort;
    if (s.col === col) s.dir = -s.dir;
    else { s.col = col; s.dir = (col === 'producto' || col === 'familia') ? 1 : -1; }
    vt.productPage = 0;
    renderProductos(vt.cache.productos);
  };

  // ─── Gráficos (6 Chart.js horizontales) ────────────────────────────
  async function loadGraficos() {
    _paneSkel('vt-pane-graficos');
    try {
      const j = vt.cache.productos || await api('/api/v1/ventas/productos?limit=2000&' + buildQS());
      vt.cache.productos = j;
      renderGraficos(j);
    } catch (e) { _paneError('vt-pane-graficos', e); }
  }

  function _topN(rows, key, n, filter) {
    let r = filter ? rows.filter(filter) : rows;
    r = [...r].sort((a, b) => (b[key] || 0) - (a[key] || 0));
    return r.slice(0, n);
  }

  function _destroyChart(id) {
    if (vt.charts[id]) { vt.charts[id].destroy(); vt.charts[id] = null; }
  }

  function _hBar(canvasId, title, rows, labelKey, valueKey, valFmt, color) {
    _destroyChart(canvasId);
    const ctx = document.getElementById(canvasId);
    if (!ctx || typeof Chart === 'undefined') return;
    const labels = rows.map((r) => r[labelKey]);
    const values = rows.map((r) => r[valueKey] || 0);
    const colors = values.map((_, i) => {
      // Degradado por posición.
      const intensity = 1 - (i / Math.max(1, values.length - 1)) * 0.55;
      return `rgba(${color},${intensity})`;
    });
    vt.charts[canvasId] = new Chart(ctx, {
      type: 'bar',
      data: { labels, datasets: [{ label: title, data: values, backgroundColor: colors, borderRadius: 4, barThickness: 12 }] },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => `${c.label}: ${valFmt(c.raw)}` } },
          title: { display: true, text: title, color: '#f0ece6', font: { size: 12, weight: 'bold' } },
        },
        scales: {
          x: { ticks: { color: '#8a8a96', font: { size: 9 }, callback: (v) => valFmt(v) }, grid: { color: 'rgba(255,255,255,.04)' } },
          y: { ticks: { color: '#f0ece6', font: { size: 10 }, autoSkip: false }, grid: { display: false } },
        },
      },
    });
  }

  function renderGraficos(j) {
    // Por-producto, sumando canales para los charts agregados.
    const byProd = new Map();
    for (const r of j.productos || []) {
      const k = r.producto;
      if (!byProd.has(k)) byProd.set(k, { producto: k, familia: r.familia, uds: 0, venta_total: 0, margen_total: 0 });
      const o = byProd.get(k);
      o.uds += r.uds || 0;
      o.venta_total += r.venta_total || 0;
      o.margen_total += r.margen_total || 0;
    }
    const aggArr = [...byProd.values()].map((o) => ({
      ...o,
      pct_margen: o.venta_total > 0 ? o.margen_total / o.venta_total : null,
    }));
    const glovo = (j.productos || []).filter((r) => r.canal === 'glovo')
      .map((r) => ({ ...r, neto_total: (r.venta_total || 0) - ((r.venta_total || 0) * (j.pct_comision_glovo || 0)) }));
    const sala = (j.productos || []).filter((r) => r.canal === 'sala');

    $('vt-pane-graficos').innerHTML = `
      <div class="vt-charts-grid">
        <div class="vt-card"><div class="vt-chart-h"><canvas id="vt-ch-margen"></canvas></div></div>
        <div class="vt-card"><div class="vt-chart-h"><canvas id="vt-ch-pctmargen"></canvas></div></div>
        <div class="vt-card"><div class="vt-chart-h"><canvas id="vt-ch-venta"></canvas></div></div>
        <div class="vt-card"><div class="vt-chart-h"><canvas id="vt-ch-uds"></canvas></div></div>
        <div class="vt-card"><div class="vt-chart-h"><canvas id="vt-ch-glv"></canvas></div></div>
        <div class="vt-card"><div class="vt-chart-h"><canvas id="vt-ch-sala"></canvas></div></div>
      </div>`;
    _hBar('vt-ch-margen',    'Top 20 · Margen Bruto Total €', _topN(aggArr, 'margen_total', 20), 'producto', 'margen_total', eur0, '38,166,91');
    _hBar('vt-ch-pctmargen', 'Top 20 · % Margen (mín 10 uds)',
      _topN(aggArr.filter((r) => (r.uds || 0) >= 10), 'pct_margen', 20),
      'producto', 'pct_margen', pct1, '244,162,97');
    _hBar('vt-ch-venta', 'Top 20 · Venta Total €',     _topN(aggArr, 'venta_total', 20), 'producto', 'venta_total', eur0, '76,201,240');
    _hBar('vt-ch-uds',   'Top 20 · Unidades vendidas', _topN(aggArr, 'uds', 20),         'producto', 'uds',         num0, '167,139,250');
    _hBar('vt-ch-glv',   'Top 15 GLOVO · Neto €',      _topN(glovo, 'neto_total', 15),    'producto', 'neto_total',  eur0, '249,115,22');
    _hBar('vt-ch-sala',  'Top 15 Sala · Venta €',      _topN(sala, 'venta_total', 15),    'producto', 'venta_total', eur0, '96,165,250');
  }

  // ─── Sucursales ────────────────────────────────────────────────────
  async function loadSucursales() {
    _paneSkel('vt-pane-sucursales');
    try {
      const j = vt.cache.sucursales || await api('/api/v1/ventas/sucursales?' + buildQS());
      vt.cache.sucursales = j;
      renderSucursales(j);
    } catch (e) { _paneError('vt-pane-sucursales', e); }
  }

  function renderSucursales(j) {
    let rows = j.sucursales || [];
    const { col, dir } = vt.sucursalSort;
    rows = [...rows].sort((a, b) => {
      const av = a[col], bv = b[col];
      if (av == null && bv == null) return 0; if (av == null) return 1; if (bv == null) return -1;
      if (typeof av === 'string') return dir * av.localeCompare(bv);
      return dir * (av < bv ? -1 : av > bv ? 1 : 0);
    });
    const max = Math.max(1, ...rows.map((r) => r.venta_total || 0));
    const arrow = (c) => col === c ? (dir < 0 ? ' ↓' : ' ↑') : '';
    // Totales
    const T = rows.reduce((a, r) => ({
      uds: a.uds + (r.uds || 0),
      venta: a.venta + (r.venta_total || 0),
      glovo: a.glovo + (r.venta_glovo || 0),
      com: a.com + (r.comision_glovo || 0),
      neto: a.neto + (r.neto_glovo || 0),
      margen: a.margen + (r.margen_bruto || 0),
    }), { uds: 0, venta: 0, glovo: 0, com: 0, neto: 0, margen: 0 });
    const pctTot = T.venta > 0 ? T.margen / T.venta : null;

    $('vt-pane-sucursales').innerHTML = `
      <div class="vt-card">
        <div class="vt-card-head"><span class="vt-card-title">Ranking por sucursal · ${num0(rows.length)} locales</span></div>
        <div class="vt-tbl-wrap">
          <table class="vt-tbl">
            <thead><tr>
              <th onclick="vtSortSuc('local')">Sucursal${arrow('local')}</th>
              <th class="r" onclick="vtSortSuc('uds')">Uds.${arrow('uds')}</th>
              <th class="r" onclick="vtSortSuc('venta_total')">Venta €${arrow('venta_total')}</th>
              <th class="r" onclick="vtSortSuc('venta_glovo')">Glovo €${arrow('venta_glovo')}</th>
              <th class="r" onclick="vtSortSuc('comision_glovo')">Com. Glovo${arrow('comision_glovo')}</th>
              <th class="r" onclick="vtSortSuc('neto_glovo')">Neto Glovo${arrow('neto_glovo')}</th>
              <th class="r" onclick="vtSortSuc('margen_bruto')">Margen €${arrow('margen_bruto')}</th>
              <th class="r" onclick="vtSortSuc('pct_margen')">% Margen${arrow('pct_margen')}</th>
              <th>Visual</th>
            </tr></thead>
            <tbody>
              ${rows.map((r) => `
                <tr>
                  <td><strong>${esc(r.local)}</strong></td>
                  <td class="r">${num0(r.uds)}</td>
                  <td class="r">${eur0(r.venta_total)}</td>
                  <td class="r" style="color:var(--vt-glovo)">${eur0(r.venta_glovo)}</td>
                  <td class="r" style="color:var(--vt-muted)">${eur0(r.comision_glovo)}</td>
                  <td class="r">${eur0(r.neto_glovo)}</td>
                  <td class="r" style="color:var(--vt-green)">${eur0(r.margen_bruto)}</td>
                  <td class="r" style="color:${_margenColor(r.pct_margen)}">${pct1(r.pct_margen)}</td>
                  <td><span class="vt-margen-bar" style="width:100px"><i style="width:${((r.venta_total||0)/max*100).toFixed(0)}%;background:var(--vt-amber)"></i></span></td>
                </tr>`).join('')}
              <tr class="total">
                <td>TOTAL</td>
                <td class="r">${num0(T.uds)}</td>
                <td class="r">${eur0(T.venta)}</td>
                <td class="r" style="color:var(--vt-glovo)">${eur0(T.glovo)}</td>
                <td class="r">${eur0(T.com)}</td>
                <td class="r">${eur0(T.neto)}</td>
                <td class="r" style="color:var(--vt-green)">${eur0(T.margen)}</td>
                <td class="r">${pct1(pctTot)}</td>
                <td></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <div class="vt-card">
        <div class="vt-card-head"><span class="vt-card-title">Venta por sucursal</span></div>
        <div style="position:relative;height:${Math.max(220, rows.length * 28)}px"><canvas id="vt-ch-suc"></canvas></div>
      </div>`;

    _hBar('vt-ch-suc', 'Venta total por sucursal', [...rows].sort((a, b) => (b.venta_total||0) - (a.venta_total||0)),
      'local', 'venta_total', eur0, '244,162,97');
  }

  window.vtSortSuc = function (col) {
    const s = vt.sucursalSort;
    if (s.col === col) s.dir = -s.dir;
    else { s.col = col; s.dir = (col === 'local') ? 1 : -1; }
    renderSucursales(vt.cache.sucursales);
  };

  // ─── Promociones ───────────────────────────────────────────────────
  async function loadPromociones() {
    _paneSkel('vt-pane-promociones');
    try {
      const j = vt.cache.promociones || await api('/api/v1/ventas/promociones?' + buildQS());
      vt.cache.promociones = j;
      renderPromociones(j);
    } catch (e) { _paneError('vt-pane-promociones', e); }
  }

  function renderPromociones(j) {
    let rows = j.promociones || [];
    const { col, dir } = vt.promoSort;
    rows = [...rows].sort((a, b) => {
      const av = a[col], bv = b[col];
      if (av == null && bv == null) return 0; if (av == null) return 1; if (bv == null) return -1;
      if (typeof av === 'string') return dir * av.localeCompare(bv);
      return dir * (av < bv ? -1 : av > bv ? 1 : 0);
    });
    const arrow = (c) => col === c ? (dir < 0 ? ' ↓' : ' ↑') : '';
    $('vt-pane-promociones').innerHTML = `
      <div class="vt-card">
        <div class="vt-card-head"><span class="vt-card-title">Promociones · ${num0(rows.length)} filas</span></div>
        <div class="vt-tbl-wrap">
          <table class="vt-tbl">
            <thead><tr>
              <th onclick="vtSortPromo('producto')">Producto${arrow('producto')}</th>
              <th onclick="vtSortPromo('promocion')">Promoción${arrow('promocion')}</th>
              <th>Canal</th>
              <th class="r" onclick="vtSortPromo('uds')">Uds.${arrow('uds')}</th>
              <th class="r" onclick="vtSortPromo('venta_total')">Venta €${arrow('venta_total')}</th>
              <th class="r" onclick="vtSortPromo('neto')">Neto €${arrow('neto')}</th>
              <th class="r" onclick="vtSortPromo('costo_ud')">Costo/Ud €${arrow('costo_ud')}</th>
              <th class="r" onclick="vtSortPromo('neto_ud')">Neto/Ud €${arrow('neto_ud')}</th>
              <th class="r" onclick="vtSortPromo('margen_ud')">Margen/Ud €${arrow('margen_ud')}</th>
              <th class="r" onclick="vtSortPromo('pct_margen')">% Margen${arrow('pct_margen')}</th>
              <th>Visual</th>
            </tr></thead>
            <tbody>
              ${rows.length === 0 ? `<tr><td colspan="11" style="text-align:center;color:var(--vt-muted);padding:14px">Sin promociones en el filtro actual</td></tr>` : rows.map((r) => {
                const barPct = Math.max(-1, Math.min(1, r.pct_margen || 0));
                const barCol = _margenColor(r.pct_margen);
                return `<tr>
                  <td>${esc(r.producto)}</td>
                  <td style="color:var(--vt-jueves);font-size:10px">${esc(r.promocion || '—')}</td>
                  <td><span class="vt-chip-canal ${r.canal}">${esc(r.canal.toUpperCase())}</span></td>
                  <td class="r">${num0(r.uds)}</td>
                  <td class="r">${eur0(r.venta_total)}</td>
                  <td class="r">${eur0(r.neto)}</td>
                  <td class="r">${eur2(r.costo_ud)}</td>
                  <td class="r">${eur2(r.neto_ud)}</td>
                  <td class="r" style="color:${barCol}">${eur2(r.margen_ud)}</td>
                  <td class="r" style="color:${barCol}">${pct1(r.pct_margen)}</td>
                  <td><span class="vt-margen-bar"><i style="width:${(Math.abs(barPct)*100).toFixed(0)}%;background:${barCol}"></i></span></td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  window.vtSortPromo = function (col) {
    const s = vt.promoSort;
    if (s.col === col) s.dir = -s.dir;
    else { s.col = col; s.dir = (col === 'producto' || col === 'promocion') ? 1 : -1; }
    renderPromociones(vt.cache.promociones);
  };

  // ─── Día y Hora ────────────────────────────────────────────────────
  async function loadDiaHora() {
    _paneSkel('vt-pane-diahora');
    try {
      const j = vt.cache.diahora || await api('/api/v1/ventas/dia-hora?' + buildQS());
      vt.cache.diahora = j;
      renderDiaHora(j);
    } catch (e) { _paneError('vt-pane-diahora', e); }
  }

  function renderDiaHora(j) {
    const NOMBRES_DIA = ['', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
    const dias = j.dias || [];
    const maxDia = Math.max(1, ...dias.map((d) => d.venta_total || 0));
    const totalDia = dias.reduce((s, d) => s + (d.venta_total || 0), 0);

    const franjas = j.franjas || [];
    const maxFranja = Math.max(1, ...franjas.map((f) => f.venta_total || 0));
    const totalFranja = franjas.reduce((s, f) => s + (f.venta_total || 0), 0);

    $('vt-pane-diahora').innerHTML = `
      <div class="vt-card">
        <div class="vt-card-head"><span class="vt-card-title">Por día de semana</span></div>
        <div class="vt-bar-list">
          ${dias.map((d) => {
            const w = ((d.venta_total || 0) / maxDia * 100).toFixed(0);
            const p = totalDia > 0 ? (d.venta_total || 0) / totalDia : 0;
            return `<div class="vt-bar-row">
              <span class="vt-lblw">${NOMBRES_DIA[d.dia] || '?'}</span>
              <span class="vt-barw"><i style="width:${w}%"></i></span>
              <span class="vt-valw">${eur0(d.venta_total)}</span>
              <span class="vt-pctw">${pct1(p)}</span>
            </div>`;
          }).join('')}
        </div>
      </div>
      <div class="vt-card">
        <div class="vt-card-head"><span class="vt-card-title">Por franja horaria</span></div>
        <div class="vt-bar-list">
          ${franjas.map((f) => {
            const w = ((f.venta_total || 0) / maxFranja * 100).toFixed(0);
            const p = totalFranja > 0 ? (f.venta_total || 0) / totalFranja : 0;
            return `<div class="vt-bar-row">
              <span class="vt-lblw">${esc(f.franja)}h</span>
              <span class="vt-barw"><i style="width:${w}%"></i></span>
              <span class="vt-valw">${eur0(f.venta_total)}</span>
              <span class="vt-pctw">${pct1(p)}</span>
            </div>`;
          }).join('')}
        </div>
      </div>`;
  }

  // ─── Camareros ─────────────────────────────────────────────────────
  async function loadCamareros() {
    if (!vt.camarerosAccess) return;
    _paneSkel('vt-pane-camareros');
    try {
      const j = vt.cache.camareros || await api('/api/v1/ventas/camareros?' + buildQS());
      vt.cache.camareros = j;
      renderCamareros(j);
    } catch (e) {
      if (e.code === 403) {
        vt.camarerosAccess = false;
        const btn = $('vt-tab-camareros'); if (btn) btn.style.display = 'none';
        // Si era la activa, ir a Productos.
        if (vt.currentTab === 'camareros') {
          const fallback = vt.role === 'personal' ? 'diahora' : 'productos';
          vtShowTab(fallback, document.querySelector(`#sect-ventas .vt-tab[data-vtab="${fallback}"]`));
        }
        return;
      }
      _paneError('vt-pane-camareros', e);
    }
  }

  function renderCamareros(j) {
    let rows = j.camareros || [];
    const { col, dir } = vt.camareroSort;
    rows = [...rows].sort((a, b) => {
      const av = a[col], bv = b[col];
      if (av == null && bv == null) return 0; if (av == null) return 1; if (bv == null) return -1;
      if (typeof av === 'string') return dir * av.localeCompare(bv);
      return dir * (av < bv ? -1 : av > bv ? 1 : 0);
    });
    const arrow = (c) => col === c ? (dir < 0 ? ' ↓' : ' ↑') : '';
    $('vt-pane-camareros').innerHTML = `
      <div class="vt-card">
        <div class="vt-card-head"><span class="vt-card-title">Camareros · ${num0(rows.length)} usuario-local</span></div>
        <div class="vt-tbl-wrap">
          <table class="vt-tbl">
            <thead><tr>
              <th onclick="vtSortCam('usuario')">Usuario${arrow('usuario')}</th>
              <th onclick="vtSortCam('local')">Local${arrow('local')}</th>
              <th class="r" onclick="vtSortCam('uds')">Uds. vendidas${arrow('uds')}</th>
              <th class="r" onclick="vtSortCam('venta_total')">Venta total €${arrow('venta_total')}</th>
            </tr></thead>
            <tbody>
              ${rows.length === 0 ? `<tr><td colspan="4" style="text-align:center;color:var(--vt-muted);padding:14px">Sin datos de camareros para los filtros actuales</td></tr>` : rows.map((r) => `
                <tr>
                  <td><strong>${esc(r.usuario)}</strong></td>
                  <td style="color:var(--vt-muted)">${esc(r.local)}</td>
                  <td class="r">${num0(r.uds)}</td>
                  <td class="r">${eur0(r.venta_total)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  window.vtSortCam = function (col) {
    const s = vt.camareroSort;
    if (s.col === col) s.dir = -s.dir;
    else { s.col = col; s.dir = (col === 'usuario' || col === 'local') ? 1 : -1; }
    renderCamareros(vt.cache.camareros);
  };

  // ─── Costos ────────────────────────────────────────────────────────
  async function loadCostos() {
    _paneSkel('vt-pane-costos');
    try {
      const f = vt.costosFiltros;
      const p = new URLSearchParams();
      if (f.q) p.set('q', f.q);
      if (f.familia) p.set('familia', f.familia);
      if (f.estado && f.estado !== 'all') p.set('estado', f.estado);
      const j = await api('/api/v1/ventas/costos?' + p.toString());
      vt.cache.costos = j;
      renderCostos(j);
    } catch (e) { _paneError('vt-pane-costos', e); }
  }

  function renderCostos(j) {
    const reducido = vt.role === 'pedidos';
    const puedeEditar = puedeEditarCostos();
    const f = vt.costosFiltros;
    let rows = j.productos || [];
    const { col, dir } = vt.costosSort;
    rows = [...rows].sort((a, b) => {
      const av = a[col], bv = b[col];
      if (av == null && bv == null) return 0;
      if (av == null) return 1; if (bv == null) return -1;
      if (typeof av === 'string') return dir * av.localeCompare(bv);
      return dir * (av < bv ? -1 : av > bv ? 1 : 0);
    });
    const total = rows.length;
    const pages = Math.max(1, Math.ceil(total / vt.costosPageSize));
    if (vt.costosPage >= pages) vt.costosPage = 0;
    const pageRows = rows.slice(vt.costosPage * vt.costosPageSize, (vt.costosPage + 1) * vt.costosPageSize);
    const arrow = (c) => col === c ? (dir < 0 ? ' ↓' : ' ↑') : '';

    // Familias únicas para el filtro
    const familiasUnicas = [...new Set((j.productos || []).map((r) => r.familia).filter(Boolean))].sort();
    const stats = j.stats || { total: 0, con_costo: 0, sin_costo: 0, pct_cubierto: 0 };
    const covCls = stats.pct_cubierto >= 0.7 ? 'good' : stats.pct_cubierto >= 0.3 ? '' : 'warn';

    $('vt-pane-costos').innerHTML = `
      <div class="vt-card">
        <div class="vt-card-head">
          <div>
            <span class="vt-card-title">💰 Costos por producto</span>
            <span class="vt-cov-pill ${covCls}" style="margin-left:8px">
              ${stats.con_costo} / ${stats.total} con costo · ${pct1(stats.pct_cubierto)} cubierto
            </span>
          </div>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
            <input id="vt-cs-q" class="vt-search" style="max-width:200px" placeholder="🔍 buscar producto…" value="${esc(f.q)}">
            <select id="vt-cs-fam" class="vt-search" style="max-width:180px">
              <option value="">Todas las familias</option>
              ${familiasUnicas.map((fa) => `<option value="${esc(fa)}" ${fa === f.familia ? 'selected' : ''}>${esc(fa)}</option>`).join('')}
            </select>
            <div class="vt-tog-row">
              <button class="vt-tog ${f.estado === 'all' ? 'active' : ''}" data-est="all">Todos</button>
              <button class="vt-tog ${f.estado === 'con-costo' ? 'active' : ''}" data-est="con-costo">Con costo</button>
              <button class="vt-tog ${f.estado === 'sin-costo' ? 'active' : ''}" data-est="sin-costo">Sin costo</button>
            </div>
          </div>
        </div>
        <div class="vt-stat-bar">
          <span><strong>${num0(stats.total)}</strong> productos vendidos</span>
          <span style="color:var(--vt-green)"><strong>${num0(stats.con_costo)}</strong> con costo</span>
          <span style="color:var(--vt-red)"><strong>${num0(stats.sin_costo)}</strong> sin costo</span>
          <span>cobertura<span class="vt-pct-bar-bg"><i style="width:${(stats.pct_cubierto * 100).toFixed(0)}%"></i></span> <strong>${pct1(stats.pct_cubierto)}</strong></span>
        </div>
        <div class="vt-tbl-wrap">
          <table class="vt-tbl">
            <thead><tr>
              <th></th>
              <th onclick="vtSortCostos('producto')">Producto${arrow('producto')}</th>
              <th onclick="vtSortCostos('familia')">Familia${arrow('familia')}</th>
              <th class="r" onclick="vtSortCostos('uds_vendidas')">Uds.${arrow('uds_vendidas')}</th>
              <th class="r" onclick="vtSortCostos('costo_mp')">Costo MP${arrow('costo_mp')}</th>
              ${reducido ? '' : `
              <th class="r" onclick="vtSortCostos('mano_obra')">M.Obra${arrow('mano_obra')}</th>
              <th class="r" onclick="vtSortCostos('costo_total')">Costo Total${arrow('costo_total')}</th>
              <th class="r" onclick="vtSortCostos('margen_pvp')">Margen PVP*${arrow('margen_pvp')}</th>`}
              <th></th>
            </tr></thead>
            <tbody>
              ${pageRows.length === 0 ? `<tr><td colspan="${reducido ? 6 : 9}" style="text-align:center;color:var(--vt-muted);padding:14px">Sin resultados</td></tr>`
                : pageRows.map((r) => `
                <tr>
                  <td><span class="vt-status-pill ${r.tiene_costo ? 'ok' : 'no'}"></span></td>
                  <td><strong>${esc(r.producto)}</strong></td>
                  <td style="color:var(--vt-muted)">${esc(r.familia || '—')}</td>
                  <td class="r">${num0(r.uds_vendidas)}</td>
                  <td class="r">${r.costo_mp != null ? eur2(r.costo_mp) : '<span style="color:var(--vt-red)">—</span>'}</td>
                  ${reducido ? '' : `
                  <td class="r" style="color:var(--vt-muted)">${r.mano_obra != null ? eur2(r.mano_obra) : '—'}</td>
                  <td class="r"><strong>${r.costo_total != null ? eur2(r.costo_total) : '<span style="color:var(--vt-red)">—</span>'}</strong></td>
                  <td class="r" style="color:${_margenColor(r.margen_pvp)}">${r.margen_pvp != null ? pct1(r.margen_pvp) : '—'}</td>`}
                  <td style="text-align:right;white-space:nowrap">
                    ${r.tiene_costo
                      ? `<button class="vt-btn-link" onclick="vtVerReceta('${esc(r.producto).replace(/'/g, '&#39;')}')">📋 receta</button>${puedeEditar ? `<button class="vt-btn-link" onclick="vtEditarCosto('${esc(r.producto).replace(/'/g, '&#39;')}')">✏️ editar</button>` : ''}`
                      : (puedeEditar ? `<button class="vt-btn-link danger" onclick="vtCargarCosto('${esc(r.producto).replace(/'/g, '&#39;')}','${esc(r.familia || '')}')">+ cargar costo</button>` : '<span style="color:var(--vt-muted);font-size:10px">sin costo</span>')
                    }
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
        ${reducido ? '' : '<p style="font-size:10px;color:var(--vt-muted);margin-top:8px">*Margen sobre precio medio de venta real en el período (cruzando con TPV).</p>'}
        <div class="vt-paginator">
          <span>Página ${vt.costosPage + 1} / ${pages} · ${num0(pageRows.length)} de ${num0(total)}</span>
          <div>
            <button id="vt-cs-prev" ${vt.costosPage === 0 ? 'disabled' : ''}>← Anterior</button>
            <button id="vt-cs-next" ${vt.costosPage >= pages - 1 ? 'disabled' : ''}>Siguiente →</button>
          </div>
        </div>
      </div>`;
    // Wire
    const $q = $('vt-cs-q');
    if ($q) {
      $q.oninput = (() => {
        let t;
        return () => { clearTimeout(t); t = setTimeout(() => { f.q = $q.value.trim(); vt.costosPage = 0; loadCostos(); }, 300); };
      })();
      setTimeout(() => { $q.focus(); $q.setSelectionRange($q.value.length, $q.value.length); }, 0);
    }
    const $fam = $('vt-cs-fam');
    if ($fam) $fam.onchange = () => { f.familia = $fam.value; vt.costosPage = 0; loadCostos(); };
    document.querySelectorAll('#vt-pane-costos .vt-tog[data-est]').forEach((b) => b.onclick = () => {
      f.estado = b.dataset.est; vt.costosPage = 0; loadCostos();
    });
    $('vt-cs-prev').onclick = () => { vt.costosPage = Math.max(0, vt.costosPage - 1); renderCostos(j); };
    $('vt-cs-next').onclick = () => { vt.costosPage = Math.min(pages - 1, vt.costosPage + 1); renderCostos(j); };
  }

  window.vtSortCostos = function (col) {
    const s = vt.costosSort;
    if (s.col === col) s.dir = -s.dir;
    else { s.col = col; s.dir = (col === 'producto' || col === 'familia') ? 1 : -1; }
    renderCostos(vt.cache.costos);
  };

  // ─── Slide-in: Ver Receta ──────────────────────────────────────────
  window.vtVerReceta = async function (producto) {
    if (!producto) return;
    const panel = $('vt-receta');
    const overlay = $('vt-receta-overlay');
    panel.innerHTML = '<div style="padding:18px"><div class="vt-skel" style="height:24px;width:60%"></div><div class="vt-skel"></div><div class="vt-skel"></div></div>';
    overlay.style.display = 'block'; panel.style.display = 'block';
    try {
      const j = await api('/api/v1/ventas/costos/' + encodeURIComponent(producto));
      _renderRecetaPanel(j);
    } catch (e) {
      panel.innerHTML = `<p style="color:#e63946;font-size:12px">Error: ${esc(e.message)}</p>`;
    }
  };
  window.vtCloseReceta = function () {
    $('vt-receta').style.display = 'none';
    $('vt-receta-overlay').style.display = 'none';
  };

  function _renderRecetaPanel(j) {
    const reducido = vt.role === 'pedidos';
    const c = j.costo;
    const v = j.ventas || {};
    const recetas = j.recetas || [];
    const pvp = v.pvp_medio;
    const margenBruto = (pvp != null && c?.costo_total != null) ? pvp - +c.costo_total : null;
    const pctMargen = (margenBruto != null && pvp > 0) ? margenBruto / pvp : null;
    const updated = c?.updated_at ? new Date(c.updated_at).toLocaleDateString('es-ES') : '—';
    $('vt-receta').innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px">
        <div>
          <p style="font-size:9px;text-transform:uppercase;letter-spacing:1px;color:var(--vt-muted);margin-bottom:3px">${esc(c?.familia || '—')}</p>
          <h2 style="font-size:18px;font-weight:800">${esc(j.producto)}</h2>
        </div>
        <button class="vt-btn-secondary" onclick="vtCloseReceta()">×</button>
      </div>
      <div style="margin-bottom:18px">
        <p style="font-size:10px;color:var(--vt-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;font-weight:700">Ingredientes</p>
        ${recetas.length === 0 ? `<p style="font-size:11px;color:var(--vt-muted);font-style:italic">Sin receta detallada cargada. ${puedeEditarCostos() ? 'Podés editarlo desde el modal.' : ''}</p>` : `
          <div style="background:#242429;border-radius:8px;padding:10px 12px">
            <div class="vt-receta-line" style="font-weight:700;color:var(--vt-muted);border-bottom:1px solid #2e2e35">
              <span>Ingrediente</span><span class="r">€/kg</span><span class="r">Cant g</span><span class="r">Subtotal</span>
            </div>
            ${recetas.map((r) => `<div class="vt-receta-line">
              <span>${esc(r.ingrediente)}</span>
              <span class="r">${r.costo_unitario != null ? eur2(r.costo_unitario) : '—'}</span>
              <span class="r">${r.cantidad_receta != null ? num2(r.cantidad_receta) : '—'}</span>
              <span class="r" style="color:var(--vt-amber)">${r.subtotal != null ? eur2(r.subtotal) : '—'}</span>
            </div>`).join('')}
          </div>`}
      </div>
      <div style="background:#242429;border-radius:8px;padding:12px 14px;margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--vt-muted);padding:3px 0">
          <span>Costo MP:</span><strong style="color:var(--vt-text)">${c?.costo_mp != null ? eur2(c.costo_mp) : '—'}</strong>
        </div>
        ${reducido ? '' : `
        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--vt-muted);padding:3px 0">
          <span>Mano de obra:</span><strong style="color:var(--vt-text)">${c?.mano_obra != null ? eur2(c.mano_obra) : '—'}</strong>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--vt-muted);padding:3px 0">
          <span>Fritura/Energía:</span><strong style="color:var(--vt-text)">${c?.costo_fritura != null ? eur2(c.costo_fritura) : '—'}</strong>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:13px;font-weight:700;border-top:1px solid #2e2e35;padding-top:8px;margin-top:5px">
          <span>COSTO TOTAL:</span><span style="color:var(--vt-amber)">${c?.costo_total != null ? eur2(c.costo_total) : '—'}</span>
        </div>`}
      </div>
      ${reducido ? '' : `
      <div style="background:#242429;border-radius:8px;padding:12px 14px;margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--vt-muted);padding:3px 0">
          <span>Precio medio venta:</span><strong style="color:var(--vt-text)">${eur2(pvp)}</strong>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--vt-muted);padding:3px 0">
          <span>Margen bruto:</span><strong style="color:${margenBruto != null ? _margenColor(pctMargen) : 'var(--vt-text)'}">${eur2(margenBruto)}</strong>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:13px;font-weight:700;border-top:1px solid #2e2e35;padding-top:8px;margin-top:5px">
          <span>% Margen:</span><span style="color:${_margenColor(pctMargen)}">${pct1(pctMargen)}</span>
        </div>
      </div>`}
      <p style="font-size:10px;color:var(--vt-muted);margin-bottom:14px">Última actualización: ${updated}${c?.actualizado_por_email ? ` · ${esc(c.actualizado_por_email)}` : ''}${v.uds_vendidas ? ` · ${num0(v.uds_vendidas)} uds vendidas` : ''}</p>
      ${puedeEditarCostos() ? `<button class="vt-btn-primary" style="width:100%" onclick="vtEditarCosto('${esc(j.producto).replace(/'/g, "&#39;")}')">✏️ Editar costo</button>` : ''}
    `;
  }

  // ─── Modal: Cargar / Editar costo ──────────────────────────────────
  window.vtCargarCosto = function (producto, familia) {
    _openModalCosto({ producto, familia, esNuevo: true });
  };
  window.vtEditarCosto = async function (producto) {
    try {
      const j = await api('/api/v1/ventas/costos/' + encodeURIComponent(producto));
      _openModalCosto({ producto, familia: j.costo?.familia, costo: j.costo, esNuevo: false });
    } catch (e) {
      alert('Error: ' + e.message);
    }
  };
  window.vtCloseModal = function () {
    $('vt-modal').style.display = 'none';
    $('vt-modal-overlay').style.display = 'none';
  };

  function _openModalCosto(ctx) {
    const c = ctx.costo || {};
    const overlay = $('vt-modal-overlay'); const modal = $('vt-modal');
    overlay.style.display = 'block'; modal.style.display = 'block';
    modal.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px">
        <div>
          <p style="font-size:9px;text-transform:uppercase;letter-spacing:1px;color:var(--vt-muted);margin-bottom:3px">${ctx.esNuevo ? 'Cargar costo' : 'Editar costo'}</p>
          <h2 style="font-size:17px;font-weight:800">${esc(ctx.producto)}</h2>
        </div>
        <button class="vt-btn-secondary" onclick="vtCloseModal()">×</button>
      </div>
      <div class="vt-form-row">
        <label>Familia</label>
        <input id="vt-mod-fam" type="text" value="${esc(ctx.familia || c.familia || '')}">
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:11px">
        <div class="vt-form-row" style="margin-bottom:0">
          <label>Costo MP (€)</label>
          <input id="vt-mod-mp" type="number" step="0.0001" value="${c.costo_mp != null ? c.costo_mp : ''}">
        </div>
        <div class="vt-form-row" style="margin-bottom:0">
          <label>M. Obra (€)</label>
          <input id="vt-mod-mo" type="number" step="0.01" value="${c.mano_obra != null ? c.mano_obra : '0.65'}">
        </div>
        <div class="vt-form-row" style="margin-bottom:0">
          <label>Fritura (€)</label>
          <input id="vt-mod-fr" type="number" step="0.01" value="${c.costo_fritura != null ? c.costo_fritura : '0'}">
        </div>
      </div>
      <div class="vt-form-row">
        <label>Costo Total (€) <span style="color:var(--vt-muted);text-transform:none;letter-spacing:0">— autocalculado, podés sobrescribir</span></label>
        <input id="vt-mod-total" type="number" step="0.0001" value="${c.costo_total != null ? c.costo_total : ''}">
      </div>
      <div class="vt-form-row">
        <label>Notas</label>
        <textarea id="vt-mod-notas" rows="2">${esc(c.notas || '')}</textarea>
      </div>
      <p id="vt-mod-err" style="font-size:11px;color:#e63946;min-height:1em;margin-bottom:8px"></p>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="vt-btn-secondary" onclick="vtCloseModal()">Cancelar</button>
        <button class="vt-btn-primary" id="vt-mod-save">Guardar</button>
      </div>
    `;
    // Auto-calc costo_total cuando cambian los componentes (si total está vacío o coincide con la suma anterior).
    const upd = () => {
      const mp = parseFloat($('vt-mod-mp').value) || 0;
      const mo = parseFloat($('vt-mod-mo').value) || 0;
      const fr = parseFloat($('vt-mod-fr').value) || 0;
      $('vt-mod-total').value = (mp + mo + fr).toFixed(4);
    };
    ['vt-mod-mp', 'vt-mod-mo', 'vt-mod-fr'].forEach((id) => { const el = $(id); if (el) el.oninput = upd; });
    $('vt-mod-save').onclick = async () => {
      const body = {
        familia: $('vt-mod-fam').value.trim() || null,
        costo_mp: parseFloat($('vt-mod-mp').value) || null,
        mano_obra: parseFloat($('vt-mod-mo').value) || 0,
        costo_fritura: parseFloat($('vt-mod-fr').value) || 0,
        costo_total: parseFloat($('vt-mod-total').value) || null,
        notas: $('vt-mod-notas').value.trim() || null,
      };
      if (body.costo_mp == null && body.costo_total == null) {
        $('vt-mod-err').textContent = 'Cargá al menos el costo MP o el costo total.'; return;
      }
      try {
        const r = await fetch('/api/v1/ventas/costos/' + encodeURIComponent(ctx.producto), {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          const t = await r.text().catch(() => '');
          $('vt-mod-err').textContent = `Error ${r.status}: ${t || 'no se pudo guardar'}`;
          return;
        }
        vtCloseModal();
        vt.cache.costos = null;
        await loadCostos();
        // Refrescamos KPIs ya que cambió la cobertura.
        loadKpis();
      } catch (e) {
        $('vt-mod-err').textContent = 'Error: ' + e.message;
      }
    };
  }

  // Expose entry point
  window.vtInit = vtInit;
})();
