// Utilidades de semanas ISO (lunes a domingo).
// Todas las operaciones se hacen en UTC para evitar drift de TZ:
// las fechas siempre representan días calendario sin hora.

function pad(n) { return n < 10 ? '0' + n : String(n); }

function isoStr(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function fromIso(s) {
  // Acepta 'YYYY-MM-DD' (sin tiempo) y devuelve un Date UTC.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) throw new Error(`fecha inválida: ${s}`);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}

function addDays(d, n) {
  const t = new Date(d);
  t.setUTCDate(t.getUTCDate() + n);
  return t;
}

// Número de semana ISO (1..53) del día dado.
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
}

// Año ISO (puede diferir del año calendario en bordes diciembre/enero).
function isoYear(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  return t.getUTCFullYear();
}

// Lunes (00:00 UTC) de la semana ISO que contiene al día dado.
function isoMonday(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (t.getUTCDay() + 6) % 7; // 0=Lun, 6=Dom
  t.setUTCDate(t.getUTCDate() - dow);
  return t;
}

// Lunes (00:00 UTC) de la semana ISO `semana_iso` del año ISO `anio`.
// Útil para reconstruir fecha cuando el cliente sólo manda (anio, semana_iso).
function mondayOfIsoWeek(anio, semana_iso) {
  const jan4 = new Date(Date.UTC(anio, 0, 4));
  const week1Monday = isoMonday(jan4);
  return addDays(week1Monday, (semana_iso - 1) * 7);
}

// Devuelve las semanas ISO que tocan el mes (anio, mes 1-12).
// Cada entrada: { semana_iso, anio_iso, fecha_lunes, fecha_domingo, dias_en_mes }
function weeksInMonth(anio, mes) {
  const first = new Date(Date.UTC(anio, mes - 1, 1));
  const last = new Date(Date.UTC(anio, mes, 0)); // último día del mes
  const out = [];
  let cur = isoMonday(first);
  while (cur <= last) {
    const sunday = addDays(cur, 6);
    let dias = 0;
    for (let i = 0; i < 7; i++) {
      const day = addDays(cur, i);
      if (day.getUTCMonth() === mes - 1 && day.getUTCFullYear() === anio) dias++;
    }
    out.push({
      semana_iso: isoWeek(cur),
      anio_iso: isoYear(cur),
      fecha_lunes: isoStr(cur),
      fecha_domingo: isoStr(sunday),
      dias_en_mes: dias,
    });
    cur = addDays(cur, 7);
  }
  return out;
}

// Etiqueta corta de rango DD/M-DD/M para mostrar en UI.
function rangoCorto(lunesIso, domingoIso) {
  const a = fromIso(lunesIso);
  const b = fromIso(domingoIso);
  return `${a.getUTCDate()}/${a.getUTCMonth() + 1}-${b.getUTCDate()}/${b.getUTCMonth() + 1}`;
}

module.exports = {
  isoStr, fromIso, addDays,
  isoWeek, isoYear, isoMonday, mondayOfIsoWeek,
  weeksInMonth, rangoCorto,
};
