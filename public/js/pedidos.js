// Módulo Pedidos — orquesta sub-pestañas MP / Personal / Mix / Cmp Bancos / Historial / Ranking.
//
// Estado en window.pState. Lazy load: nada se trae hasta que se abre la
// pestaña principal Pedidos. Cada sub-tab se carga on-demand.

(function () {
  const $ = (id) => document.getElementById(id);
  const eur = (v) => v == null ? '—' : new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(Math.round(v));
  const n1 = (v) => v == null ? '—' : Number(v).toFixed(1).replace('.', ',');
  const pct = (v) => v == null ? '—' : `${(v).toFixed(1).replace('.', ',')}%`;
  const todayDow = () => new Date().getDay(); // 0=dom..6=sab

  // Permisos (rol del user — viene en window.ctx.user después de boot()).
  function hasPerm(perm) {
    const role = window.ctx?.user?.role;
    if (!role) return false;
    const map = {
      pedidos_view:  ['admin','socio','gerente','administrativo','pedidos'],
      pedidos_w:     ['admin','socio','gerente','administrativo','pedidos'],
      pedidos_mix_w: ['admin','socio'],
    };
    return (map[perm] || []).includes(role);
  }

  // Semana ISO de hoy (lunes / domingo).
  function isoWeekToday() {
    const now = new Date();
    const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const dow = (t.getUTCDay() + 6) % 7;
    const mon = new Date(t); mon.setUTCDate(mon.getUTCDate() - dow);
    const thu = new Date(mon); thu.setUTCDate(thu.getUTCDate() + 3);
    const yearStart = new Date(Date.UTC(thu.getUTCFullYear(), 0, 1));
    const sem = Math.ceil(((thu - yearStart) / 86400000 + 1) / 7);
    return { anio: thu.getUTCFullYear(), semana_iso: sem };
  }
  function addWeeks(anio, sem, delta) {
    // Toscamente: calcular el lunes y desplazar 7*delta días.
    const jan4 = new Date(Date.UTC(anio, 0, 4));
    const dow = (jan4.getUTCDay() + 6) % 7;
    const mon1 = new Date(jan4); mon1.setUTCDate(mon1.getUTCDate() - dow);
    const target = new Date(mon1); target.setUTCDate(target.getUTCDate() + (sem - 1) * 7 + delta * 7);
    const thu = new Date(target); thu.setUTCDate(thu.getUTCDate() + 3);
    const yearStart = new Date(Date.UTC(thu.getUTCFullYear(), 0, 1));
    return {
      anio: thu.getUTCFullYear(),
      semana_iso: Math.ceil(((thu - yearStart) / 86400000 + 1) / 7),
    };
  }
  function rangoSemana(fl, fd) {
    if (!fl || !fd) return '';
    const a = new Date(fl + 'T00:00:00Z'); const b = new Date(fd + 'T00:00:00Z');
    return `${a.getUTCDate()}/${a.getUTCMonth() + 1}–${b.getUTCDate()}/${b.getUTCMonth() + 1}`;
  }

  const pState = window.pState = {
    initialized: false,
    sub: 'mp',
    week: isoWeekToday(),
    mes: { anio: new Date().getFullYear(), mes: new Date().getMonth() + 1 },
    config: {},
    categorias_mp: ['Carnes','Lácteos','Verduras','Bebidas','Packaging','Limpieza','Otros MP'],
    locales: [],
    mix: [],
    mp: null,
    personal: null,
    cmp: null,
    hist: null,
    rk: null,
    // Edición local de horas cargadas (Personal): { 'local|sem': horas }
    personalCargado: {},
    // Filtro local activo (compartido por sub-tabs cuando aplique)
    filterLocal: null,
  };

  // Esconder "% Proveedores" si no tiene perm.
  function adjustPerms() {
    const t = document.getElementById('sub-tab-mix');
    if (t && !hasPerm('pedidos_mix_w')) t.style.display = 'none';
  }

  // ─── Carga lazy ─────────────────────────────────────────────────────
  async function ensureBootstrap() {
    if (pState.initialized) return;
    try {
      const data = await Api.pedidosBootstrap({ anio: pState.week.anio, semana_iso: pState.week.semana_iso });
      pState.config = data.config || {};
      pState.locales = data.locales || [];
      pState.mix = data.mix || [];
      pState.categorias_mp = data.categorias_mp || pState.categorias_mp;
      pState.week = data.week || pState.week;
      pState.initialized = true;
      adjustPerms();
    } catch (e) {
      Api.pill('Error cargando Pedidos: ' + e.message, true);
      throw e;
    }
  }

  // ─── Entry point al cambiar a la pestaña Pedidos ────────────────────
  async function onEnterPedidos() {
    await ensureBootstrap();
    renderControls();
    renderAlerta();
    await renderSub(pState.sub);
  }

  function renderAlerta() {
    if (!pState.mp || !pState.mp.kpis?.alerta_tardia) {
      $('ped-alerta').style.display = 'none'; return;
    }
    $('ped-alerta').style.display = 'block';
    $('ped-alerta-txt').textContent =
      `⚠ Hoy es ${['domingo','lunes','martes','miércoles','jueves','viernes','sábado'][todayDow()]} y hay pedidos PENDIENTES de la semana ${pState.week.semana_iso}/${pState.week.anio}. Confirmá los pedidos cuanto antes.`;
  }

  // ─── Controles superiores (cambia según sub-tab) ───────────────────
  function renderControls() {
    const c = $('ped-sub-controls'); if (!c) return;
    if (pState.sub === 'mp' || pState.sub === 'mix') {
      c.innerHTML = `
        <button class="tgl" onclick="pedWeekNav(-1)" title="Semana anterior">◀</button>
        <span style="font-size:12px;font-weight:500" id="ped-week-lbl">Semana ${pState.week.semana_iso} · ${pState.week.anio}</span>
        <button class="tgl" onclick="pedWeekNav(1)" title="Semana siguiente">▶</button>
        <select id="ped-loc-filter" onchange="pedSetLocalFilter(this.value)" style="padding:5px 8px;border:.5px solid var(--border-2);border-radius:var(--r-md);font-size:12px;background:var(--bg-primary);color:var(--text)">
          <option value="">— Todos los locales —</option>
          ${pState.locales.map((l) => `<option value="${l.id}" ${pState.filterLocal === l.id ? 'selected' : ''}>${l.nombre_display}</option>`).join('')}
        </select>
      `;
    } else if (pState.sub === 'personal' || pState.sub === 'cmp' || pState.sub === 'rk') {
      const m = pState.mes;
      c.innerHTML = `
        <select onchange="pedSetMes(+this.value, ${m.mes})" style="padding:5px 8px;border:.5px solid var(--border-2);border-radius:var(--r-md);font-size:12px;background:var(--bg-primary);color:var(--text)">
          ${[2025,2026,2027].map((y) => `<option value="${y}" ${y === m.anio ? 'selected' : ''}>${y}</option>`).join('')}
        </select>
        <select onchange="pedSetMes(${m.anio}, +this.value)" style="padding:5px 8px;border:.5px solid var(--border-2);border-radius:var(--r-md);font-size:12px;background:var(--bg-primary);color:var(--text)">
          ${['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'].map((lbl, i) => `<option value="${i+1}" ${i+1 === m.mes ? 'selected' : ''}>${lbl}</option>`).join('')}
        </select>
      `;
    } else {
      c.innerHTML = '';
    }
  }

  async function renderSub(name) {
    pState.sub = name;
    document.querySelectorAll('.ped-sub').forEach((s) => s.classList.remove('on'));
    document.querySelectorAll('.sub-tab').forEach((t) => t.classList.remove('on'));
    const el = $(`pedsub-${name}`); if (el) el.classList.add('on');
    document.querySelectorAll(`.sub-tab[data-sub="${name}"]`).forEach((t) => t.classList.add('on'));
    renderControls();
    try {
      if (name === 'mp')        await renderMP();
      if (name === 'personal')  await renderPersonal();
      if (name === 'mix')       await renderMix();
      if (name === 'cmp')       await renderCmpBancos();
      if (name === 'hist')      await renderHistorial();
      if (name === 'rk')        await renderRanking();
    } catch (e) {
      console.error('[pedidos.renderSub]', name, e);
    }
  }

  // ─── MATERIA PRIMA ───────────────────────────────────────────────────
  async function renderMP() {
    const q = { anio: pState.week.anio, semana_iso: pState.week.semana_iso };
    if (pState.filterLocal) q.local_id = pState.filterLocal;
    pState.mp = await Api.pedidosMP(q);
    renderAlerta();
    const items = pState.mp.items || [];
    const k = pState.mp.kpis || {};
    $('ped-k-budget').textContent = eur(k.total_budget_mp);
    $('ped-k-conf').textContent = k.confirmados ?? '—';
    $('ped-k-pend').textContent = k.pendientes ?? '—';
    $('ped-k-exec').textContent = (k.pct_ejecutado ?? 0).toFixed(1).replace('.', ',') + '%';
    $('ped-k-exec-eur').textContent = `${eur(k.total_pedido_real)} de ${eur(k.total_budget_mp)}`;

    // Conjunto de proveedores únicos para columnas dinámicas.
    const provs = new Set();
    items.forEach((it) => it.proveedores.forEach((p) => provs.add(p.proveedor)));
    const provList = [...provs];

    if (!items.length) {
      $('ped-mp-table').innerHTML = '<p style="font-size:12px;color:var(--text-2);padding:1rem">Sin datos para esta semana. Cargá presupuesto mensual y mix de proveedores.</p>';
      return;
    }

    const canWrite = hasPerm('pedidos_w');
    const html = `
      <table>
        <thead><tr>
          <th>Local</th>
          <th style="text-align:right">Fac. est. sem</th>
          <th style="text-align:right">% MP</th>
          <th style="text-align:right">Budget MP sem</th>
          ${provList.map((p) => `<th style="text-align:right" title="${p}">${p.length > 14 ? p.slice(0, 12) + '…' : p}</th>`).join('')}
          <th style="text-align:right">Total pedido</th>
          <th style="text-align:center">Estado</th>
          <th class="no-print">Acción</th>
        </tr></thead>
        <tbody>
          ${items.map((it) => {
            const provMap = new Map(it.proveedores.map((p) => [p.proveedor, p]));
            return `<tr>
              <td style="font-weight:500">${it.nombre}<br><span class="bdg b${it.dani_only ? 'E' : it.grupo}" style="font-size:9px">${it.grupo}</span></td>
              <td style="text-align:right">${eur(it.fac_estimada_semana)}</td>
              <td style="text-align:right">${it.pct_mp.toFixed(1).replace('.', ',')}%</td>
              <td style="text-align:right;font-weight:500">${eur(it.budget_mp_semana)}</td>
              ${provList.map((pname) => {
                const p = provMap.get(pname);
                if (!p) return '<td style="text-align:right;color:var(--text-2)">—</td>';
                const semClass = p.semaforo === 'verde' ? 'sem-cell-v' : p.semaforo === 'amarillo' ? 'sem-cell-a' : p.semaforo === 'rojo' ? 'sem-cell-r' : '';
                const realVal = p.importe_real == null ? '' : p.importe_real;
                const sugTxt = `<span style="font-size:10px;color:var(--text-2)" title="Sugerido">${eur(p.importe_sugerido)}</span>`;
                const inp = canWrite
                  ? `<input class="ped-cell-inp" type="number" min="0" step="10" placeholder="${Math.round(p.importe_sugerido)}" value="${realVal}" onchange="pedSetReal('${it.local_id}','${pname.replace(/'/g, '&#39;')}','${p.categoria}',this.value,${p.importe_sugerido})">`
                  : `<span style="font-size:11px">${eur(p.importe_real)}</span>`;
                return `<td class="${semClass}" style="text-align:right">${inp}<br>${sugTxt}</td>`;
              }).join('')}
              <td style="text-align:right;font-weight:500">${eur(it.total_pedido)}</td>
              <td style="text-align:center"><span class="ped-estado ${it.estado_local}">${it.estado_local}</span></td>
              <td class="no-print">${canWrite && it.estado_local !== 'enviado' && it.proveedores.length
                ? `<button class="tgl" onclick="pedConfirmar('${it.local_id}')">Confirmar</button>`
                : ''}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;
    $('ped-mp-table').innerHTML = html;
  }

  window.pedSetReal = async function (localId, proveedor, categoria, val, sugerido) {
    const real = val === '' || val == null ? null : Math.max(0, +val || 0);
    try {
      await Api.pedidosSavePedido({
        local_id: localId, anio: pState.week.anio, semana_iso: pState.week.semana_iso,
        proveedor, categoria, importe_sugerido: sugerido, importe_real: real,
        estado: 'pendiente',
      });
      Api.pill('Guardado');
      await renderMP();
    } catch (e) {
      Api.pill('Error: ' + e.message, true);
    }
  };

  window.pedConfirmar = async function (localId) {
    if (!confirm(`¿Confirmar pedidos pendientes de ${localId} en la semana ${pState.week.semana_iso}?`)) return;
    try {
      const r = await Api.pedidosConfirmar({
        local_id: localId, anio: pState.week.anio, semana_iso: pState.week.semana_iso,
      });
      Api.pill(`Confirmados: ${r.confirmados}`);
      await renderMP();
    } catch (e) {
      Api.pill('Error: ' + e.message, true);
    }
  };

  // ─── PERSONAL ────────────────────────────────────────────────────────
  async function renderPersonal() {
    pState.personal = await Api.pedidosPersonal({ anio: pState.mes.anio, mes: pState.mes.mes });
    const items = pState.personal.items || [];
    const semanas = pState.personal.semanas || [];

    let totalDisp = 0, totalCarg = 0, enRojo = 0;
    const rows = items.map((it) => {
      const cargadas = it.semanas.map((s) => {
        const k = `${it.local_id}|${s.semana_iso}`;
        const v = pState.personalCargado[k];
        return v == null ? null : +v;
      });
      const totalCargLocal = cargadas.reduce((s, v) => s + (v || 0), 0);
      const totalDispLocal = it.horas_disponibles_mes;
      const varPct = totalDispLocal > 0 && cargadas.some((v) => v != null) ? (totalCargLocal - totalDispLocal) / totalDispLocal : null;
      const sem = varPct == null ? 'sem-x'
        : Math.abs(varPct) <= 0.05 ? 'sem-v'
        : Math.abs(varPct) <= 0.12 ? 'sem-a' : 'sem-r';
      if (sem === 'sem-r') enRojo++;
      totalDisp += totalDispLocal;
      totalCarg += totalCargLocal;
      return { it, cargadas, totalDispLocal, totalCargLocal, varPct, sem };
    });

    $('ped-pk-disp').textContent = n1(totalDisp) + ' h';
    $('ped-pk-carg').textContent = n1(totalCarg) + ' h';
    $('ped-pk-util').textContent = totalDisp > 0 ? pct((totalCarg / totalDisp) * 100) : '—';
    $('ped-pk-rojo').textContent = enRojo;

    const semHdr = semanas.map((w) => `<th style="text-align:right" title="${w.fecha_lunes} a ${w.fecha_domingo}">S${w.semana_iso}<br><span style="font-size:9px;color:var(--text-2);font-weight:400">${rangoSemana(w.fecha_lunes, w.fecha_domingo)}</span></th>`).join('');
    const html = `
      <table>
        <thead><tr>
          <th>Local</th><th>G</th>
          <th style="text-align:right">Fac. presup. mes</th>
          <th style="text-align:right">% P</th>
          <th style="text-align:right">Budget €</th>
          <th style="text-align:right">€/h</th>
          <th style="text-align:right">Horas/mes</th>
          ${semHdr}
          <th style="text-align:right">H. cargadas</th>
          <th style="text-align:right">Var %</th>
          <th style="text-align:center">●</th>
        </tr></thead>
        <tbody>
          ${rows.map(({ it, cargadas, totalDispLocal, totalCargLocal, varPct, sem }) => `
            <tr>
              <td style="font-weight:500">${it.nombre}</td>
              <td><span class="bdg b${it.dani_only ? 'E' : it.grupo}" style="font-size:9px">${it.grupo}</span></td>
              <td style="text-align:right">${eur(it.fac_presup_mes)}</td>
              <td style="text-align:right">${it.pct_personal.toFixed(1).replace('.', ',')}%</td>
              <td style="text-align:right">${eur(it.budget_personal)}</td>
              <td style="text-align:right">${it.euro_hora.toFixed(2).replace('.', ',')}</td>
              <td style="text-align:right;font-weight:500">${n1(it.horas_disponibles_mes)}</td>
              ${it.semanas.map((s, i) => {
                const disp = s.horas_disponibles;
                const cargVal = cargadas[i] == null ? '' : cargadas[i];
                return `<td style="text-align:right"><span style="font-size:10px;color:var(--text-2)">d:${n1(disp)}</span><br>
                  <input class="ped-cell-inp" type="number" min="0" step="0.5" placeholder="${n1(disp)}" value="${cargVal}" onchange="pedSetHoras('${it.local_id}',${s.semana_iso},this.value)"></td>`;
              }).join('')}
              <td style="text-align:right;font-weight:500">${cargadas.some((v) => v != null) ? n1(totalCargLocal) : '—'}</td>
              <td style="text-align:right;color:${varPct == null ? 'var(--text-2)' : varPct < 0 ? '#16a34a' : '#dc2626'}">${varPct == null ? '—' : ((varPct >= 0 ? '+' : '') + (varPct * 100).toFixed(1).replace('.', ',') + '%')}</td>
              <td style="text-align:center"><span class="sem ${sem}"></span></td>
            </tr>
          `).join('')}
        </tbody>
      </table>`;
    $('ped-personal-table').innerHTML = html;
  }

  window.pedSetHoras = function (localId, semIso, val) {
    const k = `${localId}|${semIso}`;
    if (val === '' || val == null) delete pState.personalCargado[k];
    else pState.personalCargado[k] = Math.max(0, +val || 0);
    renderPersonal();
  };

  // ─── MIX ──────────────────────────────────────────────────────────────
  async function renderMix() {
    if (!hasPerm('pedidos_view')) return;
    // Recargar el mix.
    const data = await Api.pedidosMix(pState.filterLocal ? { local_id: pState.filterLocal } : {});
    pState.mix = data.mix || [];

    const canWrite = hasPerm('pedidos_mix_w');
    const locales = pState.filterLocal
      ? pState.locales.filter((l) => l.id === pState.filterLocal)
      : pState.locales;

    // Conjunto de proveedores presentes en el mix actual.
    const provs = new Set();
    pState.mix.forEach((m) => provs.add(`${m.categoria}|${m.proveedor}`));
    const provList = [...provs].sort();

    if (!provList.length) {
      $('ped-mix-grid').innerHTML = '<p style="font-size:12px;color:var(--text-2);padding:1rem">No hay proveedores cargados. Usá <b>+ Proveedor</b> o <b>Importar desde bancos</b> para empezar.</p>';
      return;
    }

    const cellInp = (loc, cat, prov, pctVal) => {
      const inp = `<input class="ped-cell-inp" type="number" min="0" max="100" step="0.5" value="${pctVal != null ? pctVal : ''}" onchange="pedMixSet('${loc}','${prov.replace(/'/g, "&#39;")}','${cat}',this.value)" ${canWrite ? '' : 'disabled'}>`;
      return `<td class="mix-grid-cell" style="text-align:right">${inp}</td>`;
    };

    const sumsPorLocal = locales.map((l) => {
      const s = pState.mix.filter((m) => m.local_id === l.id && m.activo)
        .reduce((acc, m) => acc + (+m.porcentaje || 0), 0);
      return { id: l.id, sum: Math.round(s * 10) / 10 };
    });

    const html = `
      <table>
        <thead><tr>
          <th>Local</th>
          ${provList.map((pk) => {
            const [cat, prov] = pk.split('|');
            return `<th style="text-align:right" title="${cat} · ${prov}">${prov.length > 14 ? prov.slice(0, 12) + '…' : prov}<br><span style="font-size:9px;color:var(--text-2);font-weight:400">${cat}</span></th>`;
          }).join('')}
          <th style="text-align:right">Suma</th>
        </tr></thead>
        <tbody>
          ${locales.map((l) => {
            const byKey = new Map(pState.mix.filter((m) => m.local_id === l.id).map((m) => [`${m.categoria}|${m.proveedor}`, m]));
            const sum = sumsPorLocal.find((x) => x.id === l.id)?.sum || 0;
            const sumClass = Math.abs(sum - 100) < 0.5 ? 'mix-sum-ok' : 'mix-sum-bad';
            return `<tr>
              <td style="font-weight:500">${l.nombre_display}</td>
              ${provList.map((pk) => {
                const [cat, prov] = pk.split('|');
                const m = byKey.get(pk);
                return cellInp(l.id, cat, prov, m?.porcentaje);
              }).join('')}
              <td style="text-align:right" class="${sumClass}">${sum.toFixed(1)}%</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;
    $('ped-mix-grid').innerHTML = html;
  }

  window.pedMixSet = async function (localId, proveedor, categoria, val) {
    const v = val === '' || val == null ? null : Math.max(0, Math.min(100, +val || 0));
    try {
      await Api.pedidosMixSave([{ local_id: localId, proveedor, categoria, porcentaje: v, activo: true }]);
      Api.pill('Guardado');
      // Sin re-render completo: actualizar local sólo.
      const i = pState.mix.findIndex((m) => m.local_id === localId && m.proveedor === proveedor && m.categoria === categoria);
      if (v == null) {
        if (i >= 0) pState.mix.splice(i, 1);
      } else if (i >= 0) {
        pState.mix[i].porcentaje = v;
      } else {
        pState.mix.push({ local_id: localId, proveedor, categoria, porcentaje: v, activo: true });
      }
      renderMix();
    } catch (e) {
      Api.pill('Error: ' + e.message, true);
    }
  };

  window.openMixAddRow = function () {
    if (!hasPerm('pedidos_mix_w')) return;
    $('ped-mix-modal-title').textContent = 'Agregar proveedor al mix';
    const cats = pState.categorias_mp.map((c) => `<option value="${c}">${c}</option>`).join('');
    const locs = pState.locales.map((l) => `<option value="${l.id}">${l.nombre_display}</option>`).join('');
    $('ped-mix-modal-body').innerHTML = `
      <div style="display:grid;gap:8px">
        <label style="font-size:11px;color:var(--text-2)">Local</label>
        <select id="mix-add-local" style="padding:5px 8px;border:.5px solid var(--border-2);border-radius:var(--r-md);font-size:12px;background:var(--bg-primary);color:var(--text)">${locs}</select>
        <label style="font-size:11px;color:var(--text-2)">Proveedor</label>
        <input id="mix-add-prov" type="text" class="num-inp" style="width:auto" placeholder="Carnicas Garcia SL">
        <label style="font-size:11px;color:var(--text-2)">Categoría</label>
        <select id="mix-add-cat" style="padding:5px 8px;border:.5px solid var(--border-2);border-radius:var(--r-md);font-size:12px;background:var(--bg-primary);color:var(--text)">${cats}</select>
        <label style="font-size:11px;color:var(--text-2)">% del gasto MP</label>
        <input id="mix-add-pct" type="number" min="0" max="100" step="0.5" class="num-inp" style="width:auto" value="10">
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:.5rem">
          <button class="tgl" onclick="closeMixModal()">Cancelar</button>
          <button class="tgl on" onclick="pedMixAddSubmit()">Agregar</button>
        </div>
      </div>`;
    $('ped-mix-modal').style.display = 'flex';
  };

  window.pedMixAddSubmit = async function () {
    const local = $('mix-add-local').value;
    const prov = ($('mix-add-prov').value || '').trim();
    const cat = $('mix-add-cat').value;
    const pctVal = +$('mix-add-pct').value || 0;
    if (!prov) { Api.pill('Falta proveedor', true); return; }
    try {
      await Api.pedidosMixSave([{ local_id: local, proveedor: prov, categoria: cat, porcentaje: pctVal, activo: true }]);
      Api.pill('Agregado');
      closeMixModal();
      await renderMix();
    } catch (e) {
      Api.pill('Error: ' + e.message, true);
    }
  };

  window.openImportBancos = function () {
    if (!hasPerm('pedidos_mix_w')) return;
    const locs = pState.locales.map((l) => `<option value="${l.id}">${l.nombre_display}</option>`).join('');
    $('ped-mix-modal-title').textContent = 'Importar mix desde bancos';
    $('ped-mix-modal-body').innerHTML = `
      <p style="font-size:11px;color:var(--text-2);margin-bottom:.5rem">Calcula el % real de cada proveedor de MP en los últimos N meses desde <b>ab_movimientos</b>. Después podés tildar qué filas guardar.</p>
      <div style="display:grid;gap:8px">
        <label style="font-size:11px;color:var(--text-2)">Local</label>
        <select id="imp-local" style="padding:5px 8px;border:.5px solid var(--border-2);border-radius:var(--r-md);font-size:12px;background:var(--bg-primary);color:var(--text)">${locs}</select>
        <label style="font-size:11px;color:var(--text-2)">Meses hacia atrás</label>
        <input id="imp-meses" type="number" min="1" max="24" value="6" class="num-inp" style="width:auto">
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:.5rem">
          <button class="tgl" onclick="closeMixModal()">Cancelar</button>
          <button class="tgl on" onclick="pedImportPreview()">Calcular sugerencia</button>
        </div>
        <div id="imp-preview"></div>
      </div>`;
    $('ped-mix-modal').style.display = 'flex';
  };

  window.pedImportPreview = async function () {
    const local = $('imp-local').value;
    const meses = +$('imp-meses').value || 6;
    try {
      const data = await Api.pedidosMixImport({ local_id: local, meses });
      const sug = data.sugerencia || [];
      if (!sug.length) {
        $('imp-preview').innerHTML = '<p style="font-size:11px;color:var(--text-2);padding:.5rem">Sin movimientos de MP en ese período.</p>';
        return;
      }
      window._impPreview = { local, sug };
      const cats = pState.categorias_mp.map((c) => `<option value="${c}">${c}</option>`).join('');
      $('imp-preview').innerHTML = `
        <p style="font-size:11px;color:var(--text-2);margin:.5rem 0">Total gasto del período: ${eur(data.total_periodo)}</p>
        <table style="width:100%"><thead><tr>
          <th><input type="checkbox" checked onchange="document.querySelectorAll('.imp-chk').forEach(c=>c.checked=this.checked)"></th>
          <th>Proveedor</th><th>Categoría</th><th style="text-align:right">% sug.</th>
        </tr></thead><tbody>
        ${sug.map((s, i) => `<tr>
          <td><input type="checkbox" class="imp-chk" data-i="${i}" checked></td>
          <td>${s.proveedor}</td>
          <td><select data-i="${i}" class="imp-cat">${cats.replace(`value="${s.categoria_mp}"`, `value="${s.categoria_mp}" selected`)}</select></td>
          <td style="text-align:right"><input type="number" min="0" max="100" step="0.5" class="num-inp imp-pct" data-i="${i}" value="${s.porcentaje}"></td>
        </tr>`).join('')}
        </tbody></table>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:.75rem">
          <button class="tgl on" onclick="pedImportApply()">Guardar seleccionados</button>
        </div>`;
    } catch (e) {
      Api.pill('Error: ' + e.message, true);
    }
  };

  window.pedImportApply = async function () {
    const { local, sug } = window._impPreview || {};
    if (!sug) return;
    const rows = [];
    document.querySelectorAll('.imp-chk').forEach((c) => {
      if (!c.checked) return;
      const i = +c.dataset.i;
      const s = sug[i];
      const cat = document.querySelector(`.imp-cat[data-i="${i}"]`).value;
      const pctV = +document.querySelector(`.imp-pct[data-i="${i}"]`).value || 0;
      rows.push({ local_id: local, proveedor: s.proveedor, categoria: cat, porcentaje: pctV, activo: true });
    });
    if (!rows.length) { Api.pill('Nada para guardar', true); return; }
    try {
      const r = await Api.pedidosMixSave(rows);
      Api.pill(`Guardados: ${r.upserted}`);
      closeMixModal();
      await renderMix();
    } catch (e) {
      Api.pill('Error: ' + e.message, true);
    }
  };

  window.openCopyMix = function () {
    if (!hasPerm('pedidos_mix_w')) return;
    const locs = pState.locales.map((l) => `<option value="${l.id}">${l.nombre_display}</option>`).join('');
    $('ped-mix-modal-title').textContent = 'Aplicar mix de un local a otros';
    $('ped-mix-modal-body').innerHTML = `
      <p style="font-size:11px;color:#dc2626;margin-bottom:.5rem">⚠ Esta acción borra el mix existente en los locales destino y lo reemplaza por el del origen.</p>
      <div style="display:grid;gap:8px">
        <label style="font-size:11px;color:var(--text-2)">Local origen</label>
        <select id="copy-from" style="padding:5px 8px;border:.5px solid var(--border-2);border-radius:var(--r-md);font-size:12px;background:var(--bg-primary);color:var(--text)">${locs}</select>
        <label style="font-size:11px;color:var(--text-2)">Locales destino</label>
        <div style="max-height:200px;overflow:auto;border:.5px solid var(--border-3);border-radius:var(--r-md);padding:.5rem">
          ${pState.locales.map((l) => `<label style="display:block;font-size:12px;padding:2px 0"><input type="checkbox" class="copy-dest" value="${l.id}"> ${l.nombre_display}</label>`).join('')}
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:.5rem">
          <button class="tgl" onclick="closeMixModal()">Cancelar</button>
          <button class="tgl on" onclick="pedCopySubmit()">Copiar</button>
        </div>
      </div>`;
    $('ped-mix-modal').style.display = 'flex';
  };

  window.pedCopySubmit = async function () {
    const from = $('copy-from').value;
    const dests = [...document.querySelectorAll('.copy-dest:checked')].map((c) => c.value).filter((id) => id !== from);
    if (!dests.length) { Api.pill('Elegí al menos un destino', true); return; }
    if (!confirm(`Copiar mix de ${from} a ${dests.length} locales (sobreescribe)?`)) return;
    try {
      const r = await Api.pedidosMixCopy({ from_local_id: from, to_local_ids: dests });
      Api.pill(`Copiados: ${r.copied} en ${r.destinos} locales`);
      closeMixModal();
      await renderMix();
    } catch (e) {
      Api.pill('Error: ' + e.message, true);
    }
  };

  window.closeMixModal = function () { $('ped-mix-modal').style.display = 'none'; };

  // ─── COMPARATIVA BANCOS ──────────────────────────────────────────────
  async function renderCmpBancos() {
    const q = { anio: pState.mes.anio, mes: pState.mes.mes };
    if (pState.filterLocal) q.local_id = pState.filterLocal;
    pState.cmp = await Api.pedidosCmpBancos(q);
    const items = pState.cmp.items || [];
    if (!items.length) {
      $('ped-cmp-table').innerHTML = '<p style="font-size:12px;color:var(--text-2);padding:1rem">Sin pedidos ni movimientos para este mes.</p>';
      return;
    }
    const estadoLbl = { ok: '🟢 OK', pago_pendiente: '🟠 Pago pendiente', sobrepago: '🔵 Sobrepago', sin_pago: '🟠 Sin pago', sin_pedido: '⚪ Sin pedido', sin_dato: '—' };
    $('ped-cmp-table').innerHTML = `
      <table>
        <thead><tr>
          <th>Local</th><th>Proveedor</th><th>Cat. banco</th>
          <th style="text-align:right">Pedido</th>
          <th style="text-align:right">Pagado</th>
          <th style="text-align:right">Diferencia</th>
          <th style="text-align:center">Estado</th>
        </tr></thead>
        <tbody>
          ${items.map((r) => `<tr>
            <td>${r.local_id}</td>
            <td>${r.proveedor}</td>
            <td style="font-size:10px;color:var(--text-2)">${r.categoria_banco || '—'}</td>
            <td style="text-align:right">${eur(r.pedido)}</td>
            <td style="text-align:right">${eur(r.pagado)}</td>
            <td style="text-align:right;color:${r.diferencia > 0 ? '#dc2626' : r.diferencia < 0 ? '#185FA5' : 'var(--text)'}">${eur(r.diferencia)}</td>
            <td style="text-align:center;font-size:11px">${estadoLbl[r.estado] || r.estado}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
  }

  // ─── HISTORIAL ───────────────────────────────────────────────────────
  async function renderHistorial() {
    const q = { semanas: 8 };
    if (pState.filterLocal) q.local_id = pState.filterLocal;
    pState.hist = await Api.pedidosHistorial(q);
    const items = pState.hist.items || [];
    if (!items.length) {
      $('ped-hist-table').innerHTML = '<p style="font-size:12px;color:var(--text-2);padding:1rem">Sin historial de pedidos.</p>';
      return;
    }
    // Agrupar por (anio, semana_iso, local) → suma.
    const agg = new Map();
    for (const r of items) {
      const k = `${r.anio}|${r.semana_iso}|${r.local_id}`;
      const cur = agg.get(k) || { anio: r.anio, semana_iso: r.semana_iso, local_id: r.local_id, sug: 0, real: 0, items: 0, estados: {} };
      cur.sug += +r.importe_sugerido || 0;
      cur.real += +(r.importe_real == null ? r.importe_sugerido : r.importe_real) || 0;
      cur.items += 1;
      cur.estados[r.estado] = (cur.estados[r.estado] || 0) + 1;
      agg.set(k, cur);
    }
    const rows = [...agg.values()].sort((a, b) => (b.anio - a.anio) || (b.semana_iso - a.semana_iso) || a.local_id.localeCompare(b.local_id));
    $('ped-hist-table').innerHTML = `
      <table>
        <thead><tr>
          <th>Semana</th><th>Local</th>
          <th style="text-align:right">Sugerido</th>
          <th style="text-align:right">Real / efectivo</th>
          <th style="text-align:right">Var %</th>
          <th>Items</th>
        </tr></thead>
        <tbody>
          ${rows.map((r) => {
            const v = r.sug > 0 ? (r.real - r.sug) / r.sug * 100 : null;
            return `<tr>
              <td>${r.anio} · S${r.semana_iso}</td>
              <td>${r.local_id}</td>
              <td style="text-align:right">${eur(r.sug)}</td>
              <td style="text-align:right;font-weight:500">${eur(r.real)}</td>
              <td style="text-align:right;color:${v == null ? 'var(--text-2)' : v < 0 ? '#16a34a' : '#dc2626'}">${v == null ? '—' : ((v >= 0 ? '+' : '') + v.toFixed(1).replace('.', ',') + '%')}</td>
              <td style="font-size:10px;color:var(--text-2)">${Object.entries(r.estados).map(([k, n]) => `${k}:${n}`).join(' · ')}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;
  }

  // ─── RANKING ─────────────────────────────────────────────────────────
  async function renderRanking() {
    pState.rk = await Api.pedidosRanking({ anio: pState.mes.anio, mes: pState.mes.mes });
    const items = pState.rk.items || [];
    if (!items.length) {
      $('ped-rk-table').innerHTML = '<p style="font-size:12px;color:var(--text-2);padding:1rem">Sin datos. Cargá presupuesto y pedidos.</p>';
      return;
    }
    $('ped-rk-table').innerHTML = `
      <table>
        <thead><tr>
          <th>#</th><th>Local</th><th>G</th>
          <th style="text-align:right">Budget MP mes</th>
          <th style="text-align:right">Gastado</th>
          <th style="text-align:right">Ratio</th>
          <th>Eficiencia</th>
        </tr></thead>
        <tbody>
          ${items.map((it, i) => {
            const r = it.ratio == null ? null : it.ratio * 100;
            const cls = r == null ? '' : r <= 100 ? 'sem-v' : r <= 110 ? 'sem-a' : 'sem-r';
            const lbl = r == null ? '—' : r <= 100 ? 'Bajo budget' : r <= 110 ? 'Cerca' : 'Sobrepasa';
            return `<tr>
              <td>${i + 1}</td>
              <td style="font-weight:500">${it.nombre}</td>
              <td><span class="bdg b${it.dani_only ? 'E' : it.grupo}" style="font-size:9px">${it.grupo}</span></td>
              <td style="text-align:right">${eur(it.budget_mp_mes)}</td>
              <td style="text-align:right">${eur(it.gastado)}</td>
              <td style="text-align:right;font-weight:500">${r == null ? '—' : r.toFixed(1).replace('.', ',') + '%'}</td>
              <td><span class="sem ${cls}"></span> ${lbl}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;
  }

  // ─── Navegación / filtros ────────────────────────────────────────────
  window.pedWeekNav = async function (delta) {
    const w = addWeeks(pState.week.anio, pState.week.semana_iso, delta);
    pState.week = { ...pState.week, ...w };
    renderControls();
    if (pState.sub === 'mp')  await renderMP();
    if (pState.sub === 'mix') await renderMix();
  };
  window.pedSetMes = async function (anio, mes) {
    pState.mes = { anio: +anio, mes: +mes };
    renderControls();
    if (pState.sub === 'personal') await renderPersonal();
    if (pState.sub === 'cmp') await renderCmpBancos();
    if (pState.sub === 'rk')  await renderRanking();
  };
  window.pedSetLocalFilter = async function (id) {
    pState.filterLocal = id || null;
    await renderSub(pState.sub);
  };
  window.showPedidosSub = async function (name, btn) {
    pState.sub = name;
    if (btn) {
      document.querySelectorAll('.sub-tab').forEach((t) => t.classList.remove('on'));
      btn.classList.add('on');
    }
    await renderSub(name);
  };

  // Hook al showTab del main: cuando entran a 'pedidos', llamamos init.
  const origShowTab = window.showTab;
  window.showTab = function (name, btn) {
    if (typeof origShowTab === 'function') origShowTab(name, btn);
    if (name === 'pedidos') onEnterPedidos();
  };

  // Si el usuario quedó parado en la pestaña Pedidos al cargar (no esperado
  // hoy, pero por las dudas), no hacemos nada hasta el primer click.
})();
