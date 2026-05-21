// Engine de cálculo — puro, sin DOM. Recibe `ctx` con config + locales y devuelve cálculos.
// Mismo modelo que el HTML v7 original.
//
// ctx = {
//   config: { pctMP, pctPersonal, pctImpuestos, pctPublicidad, euroHora,
//             incluirGlovo, modoSociedad, poolGroups:['A',...],
//             poolProduccion, poolEspeciales },
//   locales: [ { id, nombre_display, short_name, grupo, dani_only,
//                alquiler, suministros, fac_mi_analisis, horas_sem_override } ],
// }

window.Engine = (function () {
  function calcOne(localObj, fac, ctx, facMap) {
    const { config } = ctx;
    const pMP = config.pctMP / 100;
    const pP = config.pctPersonal / 100;
    const pI = config.pctImpuestos / 100;
    const pPb = config.pctPublicidad / 100;
    const eH = config.euroHora;

    const isA = localObj.grupo === 'A';
    const isEl = localObj.dani_only === true;
    const isEsp = isA && !isEl;

    const alq = +localObj.alquiler || 0;
    const sum_ = +localObj.suministros || 0;

    let pers, hM, hS;
    if (localObj.horas_sem_override != null) {
      hS = +localObj.horas_sem_override;
      hM = hS * 4.3;
      pers = hM * eH;
    } else {
      pers = fac * pP;
      hM = eH > 0 ? pers / eH : 0;
      hS = hM / 4.3;
    }

    const mp = fac * pMP;
    const imp = fac * pI;
    const glv = config.incluirGlovo ? fac * 0.22 * 0.27 : 0;
    const pub = fac * pPb;

    // Pool: ELCHE nunca participa (es de Dani solo)
    const poolGroups = new Set(config.poolGroups || []);
    const inPool = (l) => {
      if (l.dani_only) return false;
      return poolGroups.has(l.grupo);
    };

    const poolLocs = ctx.locales.filter((l) => facMap[l.id] != null && inPool(l));
    const poolSum = poolLocs.reduce((s, l) => s + (facMap[l.id] || 0), 0);
    const especLocs = ctx.locales.filter(
      (l) => facMap[l.id] != null && l.grupo === 'A' && !l.dani_only
    );
    const especSum = especLocs.reduce((s, l) => s + (facMap[l.id] || 0), 0);

    let prod = 0;
    if (inPool(localObj) && poolSum > 0) {
      prod = (fac / poolSum) * (config.poolProduccion || 17530);
    }
    const esp = isEsp && especSum > 0 ? (fac / especSum) * (config.poolEspeciales || 16440) : 0;

    const tG = mp + pers + imp + alq + sum_ + glv + pub + prod + esp;
    const mg = fac - tG;
    const mgP = fac > 0 ? mg / fac : 0;
    const ratioAlq = fac > 0 ? alq / fac : 0;
    const estado = mgP > 0.15 ? 'VIABLE' : mgP > 0 ? 'AJUSTADO' : 'PÉRDIDA';

    return {
      id: localObj.id, n: localObj.nombre_display, s: localObj.short_name,
      g: localObj.grupo, dani_only: localObj.dani_only,
      fac, mp, pers, hM, hS, imp, glv, pub, alq, sum: sum_, srvTotal: alq + sum_,
      prod, esp, tG, mg, mgP, ratioAlq, estado,
    };
  }

  function calcAll(ctx, excOverride) {
    const excE = excOverride !== undefined ? excOverride : ctx.config.modoSociedad;
    const wL = ctx.locales.filter((l) => !(excE && l.dani_only));
    const facMap = Object.fromEntries(wL.map((l) => [l.id, +l.fac_mi_analisis || 0]));
    return wL.map((l) => calcOne(l, facMap[l.id], { ...ctx, locales: wL }, facMap));
  }

  function calcElche(ctx) {
    const elche = ctx.locales.find((l) => l.dani_only);
    if (!elche) return null;
    const fac = +elche.fac_mi_analisis || 0;
    const { config } = ctx;
    const pMP = config.pctMP / 100, pP = config.pctPersonal / 100;
    const pI = config.pctImpuestos / 100, pPb = config.pctPublicidad / 100, eH = config.euroHora;
    const alq = +elche.alquiler || 0, sum_ = +elche.suministros || 0;
    let pers, hM, hS;
    if (elche.horas_sem_override != null) {
      hS = +elche.horas_sem_override; hM = hS * 4.3; pers = hM * eH;
    } else {
      pers = fac * pP; hM = eH > 0 ? pers / eH : 0; hS = hM / 4.3;
    }
    const mp = fac * pMP, imp = fac * pI;
    const glv = config.incluirGlovo ? fac * 0.22 * 0.27 : 0;
    const pub = fac * pPb;
    const tG = mp + pers + imp + alq + sum_ + glv + pub;
    const mg = fac - tG, mgP = fac > 0 ? mg / fac : 0;
    return {
      id: elche.id, n: elche.nombre_display, s: elche.short_name, g: elche.grupo, dani_only: true,
      fac, mp, pers, hM, hS, imp, glv, pub, alq, sum: sum_, srvTotal: alq + sum_,
      prod: 0, esp: 0, tG, mg, mgP, ratioAlq: fac > 0 ? alq / fac : 0,
      estado: mgP > 0.15 ? 'VIABLE' : mgP > 0 ? 'AJUSTADO' : 'PÉRDIDA',
    };
  }

  // Presupuesto: usa fac_presupuestada por local/mes, default = histórico 2025 mismo mes
  function calcBudget(ctx, monthIdx) {
    const excE = ctx.config.modoSociedad;
    const wL = ctx.locales.filter((l) => !(excE && l.dani_only));
    const facMap = Object.fromEntries(wL.map((l) => {
      const presVal = (ctx.presupuestoMap?.[l.id]?.fac_presupuestada);
      const hist = ctx.h25?.[l.id]?.[monthIdx];
      const v = presVal != null ? presVal : (hist != null ? hist : (+l.fac_mi_analisis || 0));
      return [l.id, +v];
    }));
    return wL.map((l) => {
      const r = calcOne(l, facMap[l.id], { ...ctx, locales: wL }, facMap);
      r.real = ctx.presupuestoMap?.[l.id]?.fac_real ?? null;
      r.presBase = facMap[l.id];
      return r;
    });
  }

  // Devuelve los rows de presupuesto para los locales dani_only (Elche)
  // — para mostrar en sección separada cuando modoSociedad está activo
  // pero el spec pide que igual aparezcan con todas sus columnas.
  function calcBudgetElche(ctx, monthIdx) {
    const elches = ctx.locales.filter((l) => l.dani_only);
    if (!elches.length) return [];
    // Cálculo con TODOS los locales (no excluye, para que pool de producción etc. den coherente)
    const facMap = Object.fromEntries(ctx.locales.map((l) => {
      const presVal = (ctx.presupuestoMap?.[l.id]?.fac_presupuestada);
      const hist = ctx.h25?.[l.id]?.[monthIdx];
      const v = presVal != null ? presVal : (hist != null ? hist : (+l.fac_mi_analisis || 0));
      return [l.id, +v];
    }));
    return elches.map((l) => {
      const r = calcOne(l, facMap[l.id], ctx, facMap);
      r.real = ctx.presupuestoMap?.[l.id]?.fac_real ?? null;
      r.presBase = facMap[l.id];
      return r;
    });
  }

  function grpSum(R, gs) {
    const sub = R.filter((r) => gs.includes(r.g));
    const f = sub.reduce((s, r) => s + r.fac, 0);
    const tG = sub.reduce((s, r) => s + r.tG, 0);
    const mg = sub.reduce((s, r) => s + r.mg, 0);
    const hT = sub.reduce((s, r) => s + r.hS, 0);
    return { f, tG, mg, mgP: f > 0 ? mg / f : 0, n: sub.length, hT };
  }

  return { calcOne, calcAll, calcElche, calcBudget, calcBudgetElche, grpSum };
})();
