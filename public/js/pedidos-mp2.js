// Módulo Materia Prima v2 — pedidos por volumen con distribución automática.
// 5 pantallas: lista, formulario modal, conciliación banco, catálogo, resumen.

(function () {
  const $ = (id) => document.getElementById(id);
  const escAttr = (s) => String(s || '').replace(/"/g, '&quot;');
  const escJs = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const eur = (v) => v == null ? '—' : new Intl.NumberFormat('es-ES', { style:'currency', currency:'EUR', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(Math.round(+v));
  const eur2 = (v) => v == null ? '—' : new Intl.NumberFormat('es-ES', { style:'currency', currency:'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(+v);
  const fdate = (s) => s ? s.slice(0, 10).split('-').reverse().join('/') : '';

  // Semana ISO actual
  function isoWeekToday() {
    const now = new Date();
    const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const dow = (t.getUTCDay() + 6) % 7;
    const mon = new Date(t); mon.setUTCDate(mon.getUTCDate() - dow);
    const thu = new Date(mon); thu.setUTCDate(thu.getUTCDate() + 3);
    const yearStart = new Date(Date.UTC(thu.getUTCFullYear(), 0, 1));
    const sem = Math.ceil(((thu - yearStart) / 86400000 + 1) / 7);
    return { anio: thu.getUTCFullYear(), semana: sem };
  }
  function addWeeks(anio, sem, delta) {
    const jan4 = new Date(Date.UTC(anio, 0, 4));
    const dow = (jan4.getUTCDay() + 6) % 7;
    const mon1 = new Date(jan4); mon1.setUTCDate(mon1.getUTCDate() - dow);
    const target = new Date(mon1); target.setUTCDate(target.getUTCDate() + (sem - 1) * 7 + delta * 7);
    const thu = new Date(target); thu.setUTCDate(thu.getUTCDate() + 3);
    const yearStart = new Date(Date.UTC(thu.getUTCFullYear(), 0, 1));
    return { anio: thu.getUTCFullYear(), semana: Math.ceil(((thu - yearStart) / 86400000 + 1) / 7) };
  }
  function anioMesActual() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  const state = {
    booted: false,
    meta: null,           // { sociedades, user, flags }
    week: isoWeekToday(),
    pedidos: [],
    semaforo: {},         // proveedor → { semaforo, presupuesto_mes, ... } (vista mensual)
    budgetSemana: null,   // { total_budget_mp, por_proveedor:{prov:€} } de la semana actual
    proveedoresNorm: [],  // proveedores activos (lista blanca para autocomplete)
    catalogo: [],         // por proveedor
    catalogoIdx: {},      // proveedor → [{ producto, unidad, precio_ref }]
    modal: { open: false, pedido: null, lineas: [], autosaveTimer: null },
    concil: { debitoSel: null, pendientes: [] },
  };

  // ─── Boot perezoso: se llama al entrar a la sub-tab "mp2" ──────────
  window.mp2Enter = async function () {
    if (!state.booted) {
      try {
        const meta = await Api.mp2.meta();
        state.meta = meta;
        state.booted = true;
        renderSociedadFiltro();
        applyFlags();
        await refreshProveedoresNorm();
      } catch (e) {
        $('mp2-tabla').innerHTML = `<p style="color:#dc2626;padding:1rem;font-size:12px">Error al cargar: ${e.message}</p>`;
        return;
      }
    }
    mp2BackToLista();
  };

  function applyFlags() {
    const f = state.meta?.flags || {};
    if (f.mp2_conciliar_w) $('mp2-tab-conciliar').style.display = '';
    if (f.mp2_catalogo_w)  $('mp2-tab-catalogo').style.display = '';
    if (f.mp2_catalogo_w)  $('mp2-cat-add').style.display = '';
  }

  function renderSociedadFiltro() {
    const sel = $('mp2-f-soc');
    sel.innerHTML = '<option value="">— Todas las sociedades —</option>'
      + (state.meta?.sociedades || []).map((s) => `<option value="${s.id}">${s.nombre}</option>`).join('');
  }

  async function refreshProveedoresNorm() {
    try {
      // Lista blanca compartida con MP v1 — administrable desde DB
      // (tabla ab_mp_proveedores_activos). Permiso pedidos_view cubre
      // todos los roles que ven MP (admin/socio/gerente/administrativo/pedidos).
      const j = await Api.pedidosProveedoresActivos();
      state.proveedoresNorm = j.proveedores || [];
    } catch {
      state.proveedoresNorm = [];
    }
  }

  // ─── Navegación entre vistas ──────────────────────────────────────
  window.mp2BackToLista = function () {
    document.querySelectorAll('#pedsub-mp2 > div[id^="mp2-vista-"]').forEach((el) => el.style.display = 'none');
    $('mp2-vista-lista').style.display = '';
    mp2RenderLista();
  };
  window.mp2ShowConciliar = async function () {
    if (!state.meta?.flags?.mp2_conciliar_w) return;
    document.querySelectorAll('#pedsub-mp2 > div[id^="mp2-vista-"]').forEach((el) => el.style.display = 'none');
    $('mp2-vista-conciliar').style.display = '';
    await renderConciliarDebitos();
  };
  window.mp2ShowCatalogo = async function () {
    document.querySelectorAll('#pedsub-mp2 > div[id^="mp2-vista-"]').forEach((el) => el.style.display = 'none');
    $('mp2-vista-catalogo').style.display = '';
    await renderCatalogo();
  };
  window.mp2ShowResumen = async function () {
    document.querySelectorAll('#pedsub-mp2 > div[id^="mp2-vista-"]').forEach((el) => el.style.display = 'none');
    $('mp2-vista-resumen').style.display = '';
    await renderResumen();
  };

  // ─── PANTALLA 1: lista ─────────────────────────────────────────────
  window.mp2WeekNav = async function (delta) {
    state.week = addWeeks(state.week.anio, state.week.semana, delta);
    await mp2RenderLista();
  };

  window.mp2RenderLista = async function () {
    $('mp2-week-lbl').textContent = `Semana ${state.week.semana} · ${state.week.anio}`;
    const f = {
      anio: state.week.anio,
      semana: state.week.semana,
      sociedad_id: $('mp2-f-soc').value || undefined,
      estado: $('mp2-f-estado').value || undefined,
    };
    try {
      // budget-semana sustituye el roundtrip a /pedidos/materia-prima:
      // devuelve total_budget_mp y por_proveedor en una sola query.
      const [j, kj, sj, bj] = await Promise.all([
        Api.mp2.pedidosList(f),
        Api.mp2.kpis({ anio: f.anio, semana: f.semana, anio_mes: anioMesActual() }),
        Api.mp2.semaforo({ anio_mes: anioMesActual() }),
        Api.mp2.budgetSemana({ anio: f.anio, semana: f.semana, sociedad_id: f.sociedad_id }),
      ]);
      state.pedidos = j.pedidos || [];
      state.semaforo = Object.fromEntries((sj.proveedores || []).map((p) => [p.proveedor, p]));
      state.budgetSemana = bj || { total_budget_mp: 0, por_proveedor: {} };
      const k = kj.kpis || {};
      // Budget MP semana ahora muestra el acumulado de pedidos de la semana
      // (todas las filas, no por pedido) vs el budget total.
      const acumSemana = k.estimado_semana || 0;
      const budgetTot = state.budgetSemana.total_budget_mp || 0;
      const exceso = budgetTot > 0 && acumSemana > budgetTot;
      $('mp2-k-budget').innerHTML = `<span style="color:${exceso ? '#dc2626' : 'inherit'}">${eur(acumSemana)}</span><span style="font-size:11px;color:var(--text-2);font-weight:400"> / ${eur(budgetTot)}</span>`;
      $('mp2-k-conf').textContent = k.confirmados ?? '—';
      $('mp2-k-borr').textContent = k.borradores ?? '—';
      $('mp2-k-est').textContent = eur(k.estimado_semana);
      $('mp2-k-pag').textContent = eur(k.real_pagado_mes);
      renderTablaPedidos();
    } catch (e) {
      $('mp2-tabla').innerHTML = `<p style="color:#dc2626;padding:1rem;font-size:12px">Error: ${e.message}</p>`;
    }
  };

  const ESTADO_STYLE = {
    borrador:   { bg:'#E5E7EB', fg:'#374151' },
    confirmado: { bg:'#DBEAFE', fg:'#1E40AF' },
    recibido:   { bg:'#CFFAFE', fg:'#155E75' },
    facturado:  { bg:'#FFEDD5', fg:'#9A3412' },
    pagado:     { bg:'#DCFCE7', fg:'#166534' },
  };

  function renderTablaPedidos() {
    if (!state.pedidos.length) {
      $('mp2-tabla').innerHTML = '<p style="font-size:12px;color:var(--text-2);padding:1rem">Sin pedidos en este filtro. <a href="javascript:mp2NuevoPedido()" style="color:#185FA5">Crear el primero →</a></p>';
      return;
    }
    const f = state.meta?.flags || {};
    const budgetProv = state.budgetSemana?.por_proveedor || {};

    // Agrupar por proveedor + sociedad para soportar pedidos múltiples
    // al mismo proveedor en la misma semana. El botón "+ Otro pedido"
    // precarga (proveedor + sociedad), por eso esa es la unidad de grupo.
    const grupos = new Map(); // key='prov||soc' → { proveedor, sociedad_id, pedidos:[], sumEst }
    for (const p of state.pedidos) {
      const k = `${p.proveedor_normalizado}||${p.sociedad_id}`;
      const g = grupos.get(k) || {
        proveedor: p.proveedor_normalizado,
        sociedad_id: p.sociedad_id,
        pedidos: [],
      };
      g.pedidos.push(p);
      grupos.set(k, g);
    }
    // Total por proveedor (cross-sociedad) en la semana: el budget asignado
    // es uno solo por proveedor — la suma de pedidos a ese proveedor (todas
    // las sociedades) es lo que se compara contra el budget.
    const sumPorProv = new Map();
    for (const p of state.pedidos) {
      sumPorProv.set(p.proveedor_normalizado,
        (sumPorProv.get(p.proveedor_normalizado) || 0) + (+p.importe_estimado || 0));
    }

    // Mantener orden estable: por proveedor alfabético, luego sociedad, luego id.
    const gruposArr = [...grupos.values()]
      .map((g) => {
        g.pedidos.sort((a, b) => a.id - b.id);
        g.sumEst = g.pedidos.reduce((s, p) => s + (+p.importe_estimado || 0), 0);
        return g;
      })
      .sort((a, b) =>
        a.proveedor.localeCompare(b.proveedor) || a.sociedad_id.localeCompare(b.sociedad_id)
      );

    // Mostrar el aviso de exceso de budget una sola vez por proveedor
    // (en el primer grupo donde aparece). El badge usa el total cross-sociedad.
    const provVistos = new Set();
    const filas = [];
    for (const g of gruposArr) {
      const multi = g.pedidos.length > 1;
      // Aviso naranja una vez por proveedor (en su primer grupo): la suma
      // de todos los pedidos al proveedor en la semana (cross-sociedad)
      // supera el budget asignado a ese proveedor. No bloquea — sólo informa.
      const budget = +budgetProv[g.proveedor] || 0;
      const sumProv = sumPorProv.get(g.proveedor) || 0;
      const excede = budget > 0 && sumProv > budget;
      const esPrimerGrupoProv = !provVistos.has(g.proveedor);
      provVistos.add(g.proveedor);
      const avisoBadge = (excede && esPrimerGrupoProv)
        ? `<span title="Suma de pedidos al proveedor en la semana (${eur(sumProv)}) supera el budget asignado (${eur(budget)})" style="display:inline-block;margin-left:6px;padding:1px 6px;border-radius:8px;background:#FFEDD5;color:#9A3412;font-size:9px;font-weight:500">⚠ +${eur(sumProv - budget)} sobre budget</span>`
        : '';

      g.pedidos.forEach((p, idx) => {
        const st = ESTADO_STYLE[p.estado] || ESTADO_STYLE.borrador;
        const sem = state.semaforo[p.proveedor_normalizado];
        const semDot = sem
          ? `<span class="sem sem-${sem.semaforo === 'verde' ? 'v' : sem.semaforo === 'amarillo' ? 'a' : sem.semaforo === 'rojo' ? 'r' : 'x'}" title="Presup mes ${eur(sem.presupuesto_mes)} · Est mes ${eur(sem.estimado_mes)} · Pag mes ${eur(sem.pagado_mes)}"></span>`
          : '<span class="sem sem-x"></span>';
        const accDel = f.mp2_delete ? `<button class="tgl" onclick="mp2DeletePedido(${p.id})" title="Eliminar">×</button>` : '';
        // Botón "+ Otro pedido a este proveedor" — sólo en filas no-borrador
        // (un borrador todavía se está editando; no tiene sentido duplicar).
        const accOtro = (f.mp2_w && p.estado !== 'borrador')
          ? `<button class="tgl" onclick="mp2NuevoPedidoConProveedor('${escJs(p.proveedor_normalizado)}','${escJs(p.sociedad_id)}')" title="Crear otro pedido al mismo proveedor en esta semana">+ Otro</button>`
          : '';

        // Visual de grupo:
        //  - Primer pedido del grupo: borde superior + nombre del proveedor visible
        //  - Pedidos siguientes (mismo proveedor+sociedad): nombre tenue/elidido
        //    con marca "·· mismo proveedor" para indicar continuación
        const isFirst = idx === 0;
        const rowStyle = isFirst
          ? `border-top:1px solid var(--border-2)`
          : `border-top:1px dashed var(--border-3);background:var(--bg-secondary)`;
        const provCell = isFirst
          ? `<td style="font-weight:500">${p.proveedor_normalizado}${multi ? ` <span style="font-size:9px;font-weight:400;color:var(--text-2)">(${g.pedidos.length} pedidos)</span>` : ''}${avisoBadge}</td>`
          : `<td style="color:var(--text-2);padding-left:1.25rem;font-style:italic">·· ${p.proveedor_normalizado}</td>`;

        filas.push(`<tr style="${rowStyle}">
          <td>${p.id}</td>
          ${provCell}
          <td>${isFirst ? p.sociedad_id : `<span style="color:var(--text-2)">${p.sociedad_id}</span>`}</td>
          <td style="text-align:right">${p.n_lineas}</td>
          <td style="text-align:right">${eur(p.importe_estimado)}</td>
          <td style="text-align:right">${p.importe_real != null ? eur(p.importe_real) : '—'}</td>
          <td style="text-align:center"><span class="ped-estado" style="background:${st.bg};color:${st.fg}">${p.estado}</span></td>
          <td style="text-align:center">${semDot}</td>
          <td class="no-print" style="white-space:nowrap">
            <button class="tgl" onclick="mp2OpenPedido(${p.id})">Ver</button>
            ${accOtro}
            ${accDel}
          </td>
        </tr>`);
      });
    }

    const html = `
      <table>
        <thead><tr>
          <th>#</th>
          <th>Proveedor</th>
          <th>Sociedad</th>
          <th style="text-align:right">Líneas</th>
          <th style="text-align:right">Est. €</th>
          <th style="text-align:right">Real €</th>
          <th style="text-align:center">Estado</th>
          <th style="text-align:center" title="Semáforo presupuesto del mes para ese proveedor">●</th>
          <th class="no-print"></th>
        </tr></thead>
        <tbody>${filas.join('')}</tbody>
      </table>
    `;
    $('mp2-tabla').innerHTML = html;
  }

  // Crear otro pedido al mismo proveedor + sociedad en la misma semana.
  // No hay UNIQUE en (semana,anio,sociedad,proveedor) → backend admite N filas.
  window.mp2NuevoPedidoConProveedor = function (prov, soc) {
    state.modal.pedido = {
      id: null, semana: state.week.semana, anio: state.week.anio,
      sociedad_id: soc || '', proveedor_normalizado: prov || '',
      notas: '', estado: 'borrador',
    };
    state.modal.lineas = [];
    state.modal.distribucion = null;
    abrirModal();
  };

  window.mp2DeletePedido = async function (id) {
    if (!confirm(`¿Eliminar pedido #${id}? Esta acción no se puede deshacer.`)) return;
    try {
      await Api.mp2.pedidoDelete(id);
      Api.pill('Eliminado');
      mp2RenderLista();
    } catch (e) { Api.pill('Error: ' + e.message, true); }
  };

  // ─── PANTALLA 2: formulario nuevo/edición (modal) ─────────────────
  window.mp2NuevoPedido = function () {
    state.modal.pedido = {
      id: null, semana: state.week.semana, anio: state.week.anio,
      sociedad_id: '', proveedor_normalizado: '', notas: '', estado: 'borrador',
    };
    state.modal.lineas = [];
    state.modal.distribucion = null;
    abrirModal();
  };

  window.mp2OpenPedido = async function (id) {
    try {
      const j = await Api.mp2.pedidoGet(id);
      state.modal.pedido = j.pedido;
      state.modal.lineas = j.lineas || [];
      state.modal.distribucion = j.distribucion || null;
      abrirModal();
    } catch (e) { Api.pill('Error: ' + e.message, true); }
  };

  function abrirModal() {
    state.modal.open = true;
    $('mp2-modal').style.display = 'flex';
    $('mp2-modal-title').textContent = state.modal.pedido.id
      ? `Pedido #${state.modal.pedido.id} · ${state.modal.pedido.estado}`
      : 'Nuevo pedido';
    renderModalBody();
  }
  window.mp2ModalClose = function () {
    state.modal.open = false;
    clearTimeout(state.modal.autosaveTimer);
    $('mp2-modal').style.display = 'none';
    mp2RenderLista();
  };

  function renderModalBody() {
    const p = state.modal.pedido;
    const f = state.meta?.flags || {};
    const editable = (p.estado === 'borrador') || f.mp2_avanzado_w;
    const socOptions = (state.meta?.sociedades || []).map((s) =>
      `<option value="${s.id}" ${s.id === p.sociedad_id ? 'selected' : ''}>${s.nombre}</option>`).join('');
    const provOptions = state.proveedoresNorm.map((nm) =>
      `<option value="${escAttr(nm)}" ${nm === p.proveedor_normalizado ? 'selected' : ''}>${nm}</option>`).join('');
    // Sección líneas
    const lineasHtml = state.modal.lineas.map((l, i) => renderLineaRow(l, i, editable)).join('')
      + (editable ? `<tr><td colspan="6" style="text-align:left;padding:6px 8px"><button class="tgl" onclick="mp2AddLinea()">+ Agregar producto</button></td></tr>` : '');
    const totalEst = state.modal.lineas.reduce((s, l) => s + ((+l.cantidad || 0) * (+l.precio_estimado || 0)), 0);
    const totalReal = state.modal.lineas.reduce((s, l) => s + (l.precio_real != null ? (+l.cantidad * +l.precio_real) : 0), 0);
    const hasReal = state.modal.lineas.some((l) => l.precio_real != null);
    // Sección distribución (informativa)
    const distHtml = state.modal.distribucion?.length
      ? `<div style="margin-top:1rem;padding:.75rem;background:var(--bg-secondary);border-radius:6px">
          <p style="font-size:11px;font-weight:500;text-transform:uppercase;letter-spacing:.5px;color:var(--text-2);margin-bottom:.5rem">Distribución automática</p>
          ${state.modal.distribucion.map((d) => `
            <div style="display:flex;justify-content:space-between;font-size:12px;padding:2px 0">
              <span>${d.local_id}</span>
              <span><span style="color:var(--text-2);margin-right:8px">${(d.pct * 100).toFixed(1)}%</span><b>${eur(d.importe_estimado)}</b></span>
            </div>
          `).join('')}
          <p style="font-size:10px;color:var(--text-2);margin-top:.5rem">Base: fac. presupuestada del mes</p>
        </div>`
      : (p.sociedad_id ? '<p style="font-size:11px;color:var(--text-2);margin-top:1rem">La distribución se calcula al confirmar el pedido.</p>' : '');

    const html = `
      <!-- Sección A: cabecera -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:1rem">
        <div>
          <label style="display:block;font-size:11px;color:var(--text-2);margin-bottom:3px">Semana</label>
          <div style="display:flex;gap:4px;align-items:center">
            <input type="number" class="num-inp" id="mp2-fld-anio"   value="${p.anio}"   min="2024" max="2030" style="width:80px" ${editable ? '' : 'disabled'}>
            <input type="number" class="num-inp" id="mp2-fld-semana" value="${p.semana}" min="1"    max="53"   style="width:60px" ${editable ? '' : 'disabled'}>
          </div>
        </div>
        <div>
          <label style="display:block;font-size:11px;color:var(--text-2);margin-bottom:3px">Sociedad</label>
          <select id="mp2-fld-soc" onchange="mp2OnSociedadChange()" style="width:100%;padding:6px 8px;border:.5px solid var(--border-2);border-radius:6px;background:var(--bg-secondary);color:var(--text);font-size:13px" ${editable ? '' : 'disabled'}>
            <option value="">— Seleccionar —</option>
            ${socOptions}
          </select>
        </div>
        <div style="grid-column:1/-1">
          <label style="display:block;font-size:11px;color:var(--text-2);margin-bottom:3px">Proveedor</label>
          <input type="text" id="mp2-fld-prov" list="mp2-prov-list" value="${escAttr(p.proveedor_normalizado)}" placeholder="Escribir o elegir proveedor"
            style="width:100%;padding:6px 8px;border:.5px solid var(--border-2);border-radius:6px;background:var(--bg-secondary);color:var(--text);font-size:13px" ${editable ? '' : 'disabled'}
            oninput="mp2OnProveedorInput()">
          <datalist id="mp2-prov-list">${provOptions}</datalist>
          <p id="mp2-prov-hint" style="font-size:10px;color:var(--text-2);margin-top:4px"></p>
        </div>
        <div style="grid-column:1/-1">
          <label style="display:block;font-size:11px;color:var(--text-2);margin-bottom:3px">Notas</label>
          <textarea id="mp2-fld-notas" rows="2" style="width:100%;padding:6px 8px;border:.5px solid var(--border-2);border-radius:6px;background:var(--bg-secondary);color:var(--text);font-size:12px;resize:vertical" ${editable ? '' : 'disabled'}>${p.notas || ''}</textarea>
        </div>
      </div>

      <!-- Sección B: líneas -->
      <p style="font-size:11px;font-weight:500;text-transform:uppercase;letter-spacing:.5px;color:var(--text-2);margin-bottom:.5rem">Líneas de productos</p>
      <table style="margin-bottom:.5rem">
        <thead><tr>
          <th>Producto</th>
          <th style="text-align:right">Cantidad</th>
          <th>Unidad</th>
          <th style="text-align:right">€/u</th>
          <th style="text-align:right">Subtotal</th>
          ${editable ? '<th class="no-print"></th>' : ''}
        </tr></thead>
        <tbody id="mp2-lineas-body">
          ${lineasHtml}
        </tbody>
      </table>
      <div style="display:flex;justify-content:space-between;align-items:center;padding:.5rem 0;border-top:.5px solid var(--border-3)">
        <div>
          ${hasReal ? `<span style="font-size:11px;color:var(--text-2)">Real (parcial): <b style="color:#16a34a">${eur2(totalReal)}</b></span>` : ''}
        </div>
        <div style="font-size:14px;font-weight:500">Total estimado: ${eur2(totalEst)}</div>
      </div>

      <!-- Sección C: distribución -->
      ${distHtml}

      <!-- Botones acción -->
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:1rem;border-top:.5px solid var(--border-3);padding-top:.75rem">
        ${editable ? `
          <button class="tgl" onclick="mp2GuardarBorrador()">Guardar borrador</button>
          ${p.estado === 'borrador' ? '<button class="tgl on" onclick="mp2ConfirmarPedido()" style="background:#16a34a;color:#fff;border-color:#16a34a">✓ Confirmar pedido</button>' : ''}
        ` : ''}
        ${f.mp2_avanzado_w && p.id ? renderEstadoControls(p) : ''}
      </div>
    `;
    $('mp2-modal-body').innerHTML = html;
    setupAutosave();
    if (p.proveedor_normalizado) showProveedorHint(p.proveedor_normalizado);
  }

  function renderLineaRow(l, i, editable) {
    const cant = l.cantidad != null ? l.cantidad : '';
    const prec = l.precio_estimado != null ? l.precio_estimado : '';
    const sub = (+cant || 0) * (+prec || 0);
    const sinPrecio = editable && (prec === '' || prec == null);
    const inpStyle = `width:100%;padding:4px 6px;border:.5px solid var(--border-2);border-radius:4px;background:var(--bg-secondary);color:var(--text);font-size:12px;text-align:right`;
    const inpProd = `<input type="text" value="${escAttr(l.producto || '')}" placeholder="Producto" oninput="mp2LineaChange(${i},'producto',this.value)" list="mp2-prod-${i}" style="width:100%;padding:4px 6px;border:.5px solid var(--border-2);border-radius:4px;background:var(--bg-secondary);color:var(--text);font-size:12px" ${editable ? '' : 'disabled'}>`;
    const inpCant = `<input type="number" step="0.001" value="${cant}" oninput="mp2LineaChange(${i},'cantidad',this.value)" style="${inpStyle}" ${editable ? '' : 'disabled'}>`;
    const inpUni = `<select onchange="mp2LineaChange(${i},'unidad',this.value)" style="padding:4px;border:.5px solid var(--border-2);border-radius:4px;background:var(--bg-secondary);color:var(--text);font-size:12px" ${editable ? '' : 'disabled'}>
      ${['kg','ud','l','caja','sobre','m','paq'].map((u) => `<option value="${u}" ${u === (l.unidad || 'ud') ? 'selected' : ''}>${u}</option>`).join('')}
    </select>`;
    const inpPrec = `<input type="number" step="0.0001" value="${prec}" placeholder="—" oninput="mp2LineaChange(${i},'precio_estimado',this.value)" style="${inpStyle}${sinPrecio ? ';background:#FEE2E2;border-color:#dc2626' : ''}" ${editable ? '' : 'disabled'}>`;
    const datalistProd = renderProductosDatalist(i);
    const btnDel = editable ? `<button class="tgl" onclick="mp2DelLinea(${i})" style="padding:2px 8px;color:#dc2626">×</button>` : '';
    return `<tr>
      <td>${inpProd}${datalistProd}</td>
      <td style="text-align:right;width:90px">${inpCant}</td>
      <td style="width:70px">${inpUni}</td>
      <td style="text-align:right;width:90px">${inpPrec}</td>
      <td style="text-align:right;width:90px;font-weight:500">${eur2(sub)}</td>
      ${editable ? `<td class="no-print" style="width:40px">${btnDel}</td>` : ''}
    </tr>`;
  }

  function renderProductosDatalist(i) {
    const p = state.modal.pedido?.proveedor_normalizado;
    if (!p) return '';
    const productos = state.catalogoIdx[p] || [];
    return `<datalist id="mp2-prod-${i}">${productos.map((x) => `<option value="${escAttr(x.producto)}">`).join('')}</datalist>`;
  }

  function renderEstadoControls(p) {
    const sigs = { confirmado: 'recibido', recibido: 'facturado', facturado: 'pagado' };
    const next = sigs[p.estado];
    const buttons = [];
    if (next) buttons.push(`<button class="tgl" onclick="mp2CambiarEstado(${p.id}, '${next}')">→ ${next}</button>`);
    if (p.estado === 'confirmado') buttons.push(`<button class="tgl" onclick="mp2CambiarEstado(${p.id}, 'borrador')">⟲ Reabrir borrador</button>`);
    return buttons.join('');
  }

  window.mp2LineaChange = function (i, field, val) {
    const l = state.modal.lineas[i];
    if (!l) return;
    l[field] = (field === 'producto' || field === 'unidad') ? val : (val === '' ? null : +val);
    // Si cambió producto, autocompletar precio desde catálogo
    if (field === 'producto') {
      const prov = state.modal.pedido?.proveedor_normalizado;
      const cat = state.catalogoIdx[prov] || [];
      const match = cat.find((x) => x.producto.toLowerCase() === String(val).toLowerCase());
      if (match) {
        l.precio_estimado = match.precio_ref;
        l.unidad = match.unidad;
      }
    }
    renderModalBody();
    scheduleAutosave();
  };
  window.mp2AddLinea = function () {
    state.modal.lineas.push({ producto: '', cantidad: null, unidad: 'ud', precio_estimado: null });
    renderModalBody();
  };
  window.mp2DelLinea = function (i) {
    state.modal.lineas.splice(i, 1);
    renderModalBody();
    scheduleAutosave();
  };

  window.mp2OnSociedadChange = function () {
    state.modal.pedido.sociedad_id = $('mp2-fld-soc').value;
    state.modal.distribucion = null;  // se recalcula al confirmar
    scheduleAutosave();
  };

  window.mp2OnProveedorInput = async function () {
    const v = $('mp2-fld-prov').value;
    state.modal.pedido.proveedor_normalizado = v;
    if (v && !state.catalogoIdx[v]) await loadCatalogoProveedor(v);
    showProveedorHint(v);
    scheduleAutosave();
  };

  async function loadCatalogoProveedor(prov) {
    try {
      const j = await Api.mp2.catalogoGet({ proveedor: prov });
      state.catalogoIdx[prov] = j.catalogo || [];
    } catch { state.catalogoIdx[prov] = []; }
  }

  async function showProveedorHint(prov) {
    const el = $('mp2-prov-hint');
    if (!el || !prov) return;
    // Último pedido del proveedor
    try {
      const j = await Api.mp2.pedidosList({ proveedor: prov });
      const ult = (j.pedidos || []).find((p) => p.id !== state.modal.pedido.id);
      el.textContent = ult
        ? `Último pedido: S${ult.semana}/${ult.anio} · ${eur(ult.importe_estimado)} · ${ult.estado}`
        : 'Primer pedido a este proveedor.';
    } catch { el.textContent = ''; }
  }

  // Auto-guardado (debounce 30s)
  function setupAutosave() {
    // Nada que hacer — scheduleAutosave se llama desde cada cambio.
  }
  function scheduleAutosave() {
    clearTimeout(state.modal.autosaveTimer);
    state.modal.autosaveTimer = setTimeout(async () => {
      if (!state.modal.pedido?.sociedad_id || !state.modal.pedido?.proveedor_normalizado) return;
      try {
        await mp2GuardarBorrador({ silent: true });
        showAutosaveDot();
      } catch {}
    }, 30000);
  }
  function showAutosaveDot() {
    const el = $('mp2-modal-autosave');
    if (!el) return;
    el.style.opacity = '1';
    setTimeout(() => { el.style.opacity = '0'; }, 1500);
  }

  function readCabeceraFromForm() {
    state.modal.pedido.anio = +$('mp2-fld-anio').value;
    state.modal.pedido.semana = +$('mp2-fld-semana').value;
    state.modal.pedido.sociedad_id = $('mp2-fld-soc').value;
    state.modal.pedido.proveedor_normalizado = $('mp2-fld-prov').value;
    state.modal.pedido.notas = $('mp2-fld-notas').value;
  }

  window.mp2GuardarBorrador = async function (opts = {}) {
    readCabeceraFromForm();
    const p = state.modal.pedido;
    if (!p.sociedad_id || !p.proveedor_normalizado) {
      if (!opts.silent) Api.pill('Falta sociedad o proveedor', true);
      return;
    }
    try {
      const r = await Api.mp2.pedidoSave({
        id: p.id, semana: p.semana, anio: p.anio,
        sociedad_id: p.sociedad_id, proveedor_normalizado: p.proveedor_normalizado,
        notas: p.notas, lineas: state.modal.lineas,
      });
      state.modal.pedido.id = r.id;
      if (!opts.silent) {
        Api.pill('Guardado');
        // Recargar para sincronizar líneas con sus ids
        const j = await Api.mp2.pedidoGet(r.id);
        state.modal.lineas = j.lineas || [];
        renderModalBody();
      }
    } catch (e) {
      if (!opts.silent) Api.pill('Error: ' + e.message, true);
    }
  };

  window.mp2ConfirmarPedido = async function () {
    readCabeceraFromForm();
    const lineas = state.modal.lineas;
    if (!lineas.length) return Api.pill('Agregá al menos una línea', true);
    if (lineas.some((l) => !(+l.cantidad > 0))) return Api.pill('Todas las líneas requieren cantidad > 0', true);
    if (lineas.some((l) => l.precio_estimado == null)) return Api.pill('Todas las líneas requieren precio', true);
    await mp2GuardarBorrador({ silent: true });
    try {
      await Api.mp2.pedidoConfirmar(state.modal.pedido.id);
      Api.pill('✓ Pedido confirmado');
      // Recargar para mostrar distribución
      const j = await Api.mp2.pedidoGet(state.modal.pedido.id);
      state.modal.pedido = j.pedido;
      state.modal.distribucion = j.distribucion;
      renderModalBody();
    } catch (e) { Api.pill('Error al confirmar: ' + e.message, true); }
  };

  window.mp2CambiarEstado = async function (id, estado) {
    try {
      await Api.mp2.pedidoEstado(id, estado);
      Api.pill('Estado: ' + estado);
      const j = await Api.mp2.pedidoGet(id);
      state.modal.pedido = j.pedido;
      state.modal.lineas = j.lineas;
      state.modal.distribucion = j.distribucion;
      renderModalBody();
    } catch (e) { Api.pill('Error: ' + e.message, true); }
  };

  // ─── PANTALLA 4: conciliación banco ───────────────────────────────
  async function renderConciliarDebitos() {
    const am = anioMesActual();
    const [y, m] = am.split('-').map(Number);
    try {
      const j = await Api.mp2.conciliacionDebitos({ anio: y, mes: m });
      const rows = j.debitos || [];
      $('mp2-debitos').innerHTML = rows.length
        ? `<table><thead><tr><th>Fecha</th><th>Proveedor / Concepto</th><th style="text-align:right">€</th><th>Soc.</th><th></th></tr></thead><tbody>
            ${rows.map((d) => `<tr>
              <td>${fdate(d.fecha)}</td>
              <td><b>${d.proveedor_normalizado || '—'}</b><br><span style="font-size:10px;color:var(--text-2)">${(d.concepto || '').slice(0, 50)}</span></td>
              <td style="text-align:right;color:#dc2626">${eur(Math.abs(d.importe))}</td>
              <td><span class="bdg" style="font-size:9px">${d.sociedad_id}</span></td>
              <td><button class="tgl" onclick="mp2SelectDebito(${d.id})">+</button></td>
            </tr>`).join('')}</tbody></table>`
        : '<p style="font-size:11px;color:var(--text-2);padding:1rem">Sin débitos sin conciliar este mes.</p>';
      $('mp2-pendientes').innerHTML = '<p style="font-size:11px;color:var(--text-2);padding:1rem">Seleccioná un débito.</p>';
    } catch (e) {
      $('mp2-debitos').innerHTML = `<p style="color:#dc2626;padding:1rem">Error: ${e.message}</p>`;
    }
  }

  window.mp2SelectDebito = async function (debitoId) {
    // Buscar el débito en la lista
    const debs = await Api.mp2.conciliacionDebitos({ anio: new Date().getFullYear(), mes: new Date().getMonth() + 1 });
    const deb = (debs.debitos || []).find((d) => d.id === debitoId);
    if (!deb) return;
    state.concil.debitoSel = deb;
    // Pedidos pendientes del mismo proveedor + sociedad
    const j = await Api.mp2.conciliacionPendientes({ proveedor: deb.proveedor_normalizado, sociedad_id: deb.sociedad_id });
    state.concil.pendientes = j.pedidos || [];
    renderPanelPendientes();
  };

  function renderPanelPendientes() {
    const deb = state.concil.debitoSel;
    const peds = state.concil.pendientes;
    if (!peds.length) {
      $('mp2-pendientes').innerHTML = `<p style="font-size:11px;color:var(--text-2);padding:1rem">Sin pedidos pendientes para ${deb.proveedor_normalizado} / ${deb.sociedad_id}.</p>`;
      return;
    }
    const html = `
      <p style="font-size:11px;color:var(--text-2);margin-bottom:.5rem"><b>${deb.proveedor_normalizado}</b> · ${deb.sociedad_id} · Débito ${eur(Math.abs(deb.importe))}</p>
      <div id="mp2-pend-list">
        ${peds.map((p) => `<label style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:.5px dashed var(--border-3);font-size:12px;cursor:pointer">
          <input type="checkbox" class="mp2-pend-chk" data-id="${p.id}" data-imp="${p.importe_real ?? p.importe_estimado ?? 0}" onchange="mp2RecalcSelec()">
          <span style="flex:1">S${p.semana}/${p.anio} · ${p.estado} · ${eur(p.importe_estimado)}</span>
        </label>`).join('')}
      </div>
      <div style="margin-top:.75rem;padding:.5rem;background:var(--bg-secondary);border-radius:6px;font-size:12px">
        Seleccionado: <b id="mp2-sum-sel">0 €</b><br>
        Débito banco: <b>${eur(Math.abs(deb.importe))}</b><br>
        Diferencia: <span id="mp2-diff" style="font-weight:500">—</span>
      </div>
      <div style="margin-top:.5rem">
        <input type="text" id="mp2-nota-concil" placeholder="Nota (obligatoria si hay diferencia)" style="width:100%;padding:5px 8px;border:.5px solid var(--border-2);border-radius:4px;background:var(--bg-secondary);color:var(--text);font-size:11px">
      </div>
      <button class="tgl on" onclick="mp2DoConciliar()" style="margin-top:.5rem;width:100%;background:#185FA5;color:#fff;border-color:#185FA5">Conciliar seleccionados</button>
    `;
    $('mp2-pendientes').innerHTML = html;
  }

  window.mp2RecalcSelec = function () {
    const sel = [...document.querySelectorAll('.mp2-pend-chk:checked')];
    const sum = sel.reduce((s, el) => s + (+el.dataset.imp || 0), 0);
    const banco = Math.abs(state.concil.debitoSel?.importe || 0);
    const diff = banco - sum;
    $('mp2-sum-sel').textContent = eur(sum);
    const el = $('mp2-diff');
    el.textContent = (diff > 0 ? '+' : '') + eur2(diff);
    el.style.color = Math.abs(diff) < 0.5 ? '#16a34a' : '#BA7517';
  };

  window.mp2DoConciliar = async function () {
    const sel = [...document.querySelectorAll('.mp2-pend-chk:checked')].map((el) => +el.dataset.id);
    if (!sel.length) return Api.pill('Seleccioná al menos un pedido', true);
    const nota = $('mp2-nota-concil').value;
    try {
      const r = await Api.mp2.conciliar({
        movimiento_id: state.concil.debitoSel.id,
        pedido_ids: sel,
        nota,
      });
      Api.pill(`Conciliados ${r.conciliados} · dif ${eur2(r.diferencia)}`);
      renderConciliarDebitos();
    } catch (e) { Api.pill('Error: ' + e.message, true); }
  };

  // ─── PANTALLA 5: catálogo ──────────────────────────────────────────
  async function renderCatalogo() {
    try {
      const j = await Api.mp2.catalogoGet();
      state.catalogo = j.catalogo || [];
      const f = state.meta?.flags || {};
      const porProv = new Map();
      for (const c of state.catalogo) {
        if (!porProv.has(c.proveedor_normalizado)) porProv.set(c.proveedor_normalizado, []);
        porProv.get(c.proveedor_normalizado).push(c);
      }
      if (!porProv.size) {
        $('mp2-catalogo').innerHTML = '<p style="font-size:12px;color:var(--text-2);padding:1rem">Catálogo vacío. ' + (f.mp2_catalogo_w ? 'Hacé click en "Añadir producto" arriba.' : '') + '</p>';
        return;
      }
      const html = [...porProv.entries()].map(([prov, items]) => `
        <div style="margin-bottom:1rem">
          <p style="font-size:13px;font-weight:500;color:#185FA5;margin-bottom:.5rem">▼ ${prov}</p>
          <table>
            <thead><tr><th>Producto</th><th>Unidad</th><th style="text-align:right">€/u</th><th>Desde</th><th>Actualizado por</th><th></th></tr></thead>
            <tbody>
            ${items.map((c) => {
              const stale = c.dias_desde_actualizacion > 45;
              return `<tr>
                <td>${c.producto}${c.notas_temporada ? `<br><span style="font-size:9px;color:var(--text-2)">${c.notas_temporada}</span>` : ''}</td>
                <td>${c.unidad}</td>
                <td style="text-align:right;font-weight:500">${eur2(c.precio_ref)}</td>
                <td>${fdate(c.vigente_desde)} ${stale ? '<span style="background:#FFEDD5;color:#9A3412;font-size:9px;padding:1px 5px;border-radius:8px;margin-left:4px">+45d</span>' : ''}</td>
                <td style="font-size:11px;color:var(--text-2)">${c.actualizado_por_email || '—'}</td>
                <td style="white-space:nowrap">
                  ${f.mp2_catalogo_w ? `<button class="tgl" onclick="mp2CatEdit('${escJs(prov)}','${escJs(c.producto)}','${c.unidad}',${c.precio_ref})">Editar</button>` : ''}
                  <button class="tgl" onclick="mp2CatHistorico('${escJs(prov)}','${escJs(c.producto)}')">Histórico</button>
                </td>
              </tr>`;
            }).join('')}
            </tbody>
          </table>
        </div>
      `).join('');
      $('mp2-catalogo').innerHTML = html;
    } catch (e) {
      $('mp2-catalogo').innerHTML = `<p style="color:#dc2626;padding:1rem">Error: ${e.message}</p>`;
    }
  }

  window.mp2CatAdd = function () {
    const prov = prompt('Proveedor (nombre normalizado):');
    if (!prov) return;
    mp2CatEdit(prov, '', 'ud', 0);
  };

  window.mp2CatEdit = async function (prov, producto, unidad, precio) {
    const nuevoProd = prompt(`Producto (proveedor: ${prov}):`, producto || '');
    if (nuevoProd == null) return;
    const nuevoUni = prompt('Unidad (kg/ud/l/caja/sobre):', unidad || 'ud');
    if (nuevoUni == null) return;
    const nuevoPrec = prompt('Precio €/unidad:', precio || '');
    if (nuevoPrec == null) return;
    const motivo = (Math.abs((+nuevoPrec || 0) - precio) > 0.001)
      ? prompt('Motivo del cambio de precio:') || 'sin motivo'
      : null;
    try {
      await Api.mp2.catalogoSave({
        proveedor_normalizado: prov,
        producto: nuevoProd,
        unidad: nuevoUni,
        precio_ref: +nuevoPrec,
        motivo,
      });
      Api.pill('Guardado');
      renderCatalogo();
    } catch (e) { Api.pill('Error: ' + e.message, true); }
  };

  window.mp2CatHistorico = async function (prov, producto) {
    try {
      const j = await Api.mp2.catalogoHistorico({ proveedor: prov, producto });
      const rows = j.historico || [];
      $('mp2-hist-title').textContent = `${prov} · ${producto}`;
      $('mp2-hist-body').innerHTML = rows.length
        ? `<table><thead><tr><th>Fecha</th><th style="text-align:right">€ ant.</th><th style="text-align:right">€ nuevo</th><th>Usuario</th><th>Motivo</th></tr></thead><tbody>
            ${rows.map((h) => `<tr>
              <td>${fdate(h.fecha)}</td>
              <td style="text-align:right">${h.precio_anterior != null ? eur2(h.precio_anterior) : '—'}</td>
              <td style="text-align:right;font-weight:500">${eur2(h.precio_nuevo)}</td>
              <td style="font-size:11px;color:var(--text-2)">${h.usuario_email || '—'}</td>
              <td style="font-size:11px">${h.motivo || ''}</td>
            </tr>`).join('')}
          </tbody></table>`
        : '<p style="font-size:12px;color:var(--text-2)">Sin histórico (primera carga).</p>';
      $('mp2-hist-modal').style.display = 'flex';
    } catch (e) { Api.pill('Error: ' + e.message, true); }
  };

  // ─── PANTALLA 3: resumen grilla read-only ──────────────────────────
  async function renderResumen() {
    try {
      const j = await Api.mp2.resumen({ anio: state.week.anio, semana: state.week.semana });
      const rows = j.rows || [];
      if (!rows.length) {
        $('mp2-resumen').innerHTML = '<p style="font-size:12px;color:var(--text-2);padding:1rem">Sin pedidos confirmados en esta semana.</p>';
        return;
      }
      // Pivot: locales en filas, proveedores en columnas
      const locales = [...new Set(rows.map((r) => r.local_id))].sort();
      const provs = [...new Set(rows.map((r) => r.proveedor))].sort();
      const idx = new Map(rows.map((r) => [`${r.local_id}|${r.proveedor}`, r]));
      const html = `<table>
        <thead><tr><th>Local</th>${provs.map((p) => `<th style="text-align:right">${p}</th>`).join('')}<th style="text-align:right">Total</th></tr></thead>
        <tbody>
        ${locales.map((l) => {
          let tot = 0;
          const cells = provs.map((p) => {
            const r = idx.get(`${l}|${p}`);
            const v = r ? (r.real_ ?? r.est) : 0;
            tot += v || 0;
            return `<td style="text-align:right">${v ? eur(v) : '—'}</td>`;
          }).join('');
          return `<tr><td style="font-weight:500">${l}</td>${cells}<td style="text-align:right;font-weight:500">${eur(tot)}</td></tr>`;
        }).join('')}
        </tbody>
      </table>`;
      $('mp2-resumen').innerHTML = html;
    } catch (e) {
      $('mp2-resumen').innerHTML = `<p style="color:#dc2626;padding:1rem">Error: ${e.message}</p>`;
    }
  }

  // ─── Hook al showPedidosSub del módulo padre ──────────────────────
  const origShowSub = window.showPedidosSub;
  window.showPedidosSub = async function (name, btn) {
    if (typeof origShowSub === 'function') origShowSub(name, btn);
    if (name === 'mp2') await window.mp2Enter();
  };
})();
