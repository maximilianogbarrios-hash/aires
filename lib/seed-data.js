// Datos base — locales, historial 2025, totales mensuales agregados.
// Estos valores se cargan en seed inicial. Se pueden editar luego desde la UI
// (alquiler/suministros/fac_mi_analisis/horas_override).

const LOCALES = [
  { id: 'ELCHE',          nombre_display: 'ELCHE',          short: 'ELCHE',      grupo: 'A', dani_only: true,  mi: 50000, alq: 2700, sum: 1432, orden:  1 },
  { id: 'SANTO_DOMINGO',  nombre_display: 'SANTO DOMINGO',  short: 'S.DOM.',     grupo: 'A', dani_only: false, mi: 50000, alq: 3876, sum: 1513, orden:  2 },
  { id: 'THADER',         nombre_display: 'THADER',         short: 'THADER',     grupo: 'A', dani_only: false, mi: 50000, alq: 4000, sum:  666, orden:  3 },
  { id: 'BENIDORM',       nombre_display: 'BENIDORM',       short: 'BENIDORM',   grupo: 'A', dani_only: false, mi: 55000, alq: 5242, sum: 2536, orden:  4 },
  { id: 'ARENALES',       nombre_display: 'ARENALES',       short: 'ARENALES',   grupo: 'A', dani_only: false, mi: 37000, alq: 1530, sum:  778, orden:  5 },
  { id: 'ALICANTE',       nombre_display: 'ALICANTE',       short: 'ALICANTE',   grupo: 'A', dani_only: false, mi: 32000, alq: 2500, sum: 1023, orden:  6 },
  { id: 'TORREVIEJA',     nombre_display: 'TORREVIEJA',     short: 'TORREVIEJA', grupo: 'A', dani_only: false, mi: 17000, alq: 1429, sum:  613, orden:  7 },
  { id: 'SANTA_POLA',     nombre_display: 'SANTA POLA',     short: 'S.POLA',     grupo: 'A', dani_only: false, mi: 23000, alq: 1785, sum:  819, orden:  8 },
  { id: 'CREVILLENTE',    nombre_display: 'CREVILLENTE',    short: 'CREVILL.',   grupo: 'B', dani_only: false, mi: 16000, alq: 1179, sum:  403, orden:  9 },
  { id: 'ORIHUELA',       nombre_display: 'ORIHUELA',       short: 'ORIHUELA',   grupo: 'B', dani_only: false, mi: 25000, alq: 1326, sum:  895, orden: 10 },
  { id: 'SAN_VICENTE',    nombre_display: 'SAN VICENTE',    short: 'S.VICE.',    grupo: 'B', dani_only: false, mi: 23000, alq: 1453, sum:  856, orden: 11 },
  { id: 'MURCIA_MERCED',  nombre_display: 'MURCIA MERCED',  short: 'MERCED',     grupo: 'C', dani_only: false, mi:  7880, alq: 1470, sum:  630, orden: 12 },
  { id: 'CHICKEN_THADER', nombre_display: 'CHICKEN THADER', short: 'CH.THADER',  grupo: 'D', dani_only: false, mi: 10320, alq: 1554, sum:  666, orden: 13 },
  { id: 'CHICKEN_UNCLES', nombre_display: 'CHICKEN UNCLES', short: 'CH.UNCLES',  grupo: 'D', dani_only: false, mi:  9492, alq: 1023, sum:  270, orden: 14 },
];

// Historial 2025 — Ene a Dic
const H25 = {
  ELCHE:          [72953,59018,64575,66877,64355,50593,53457,70732,52904,59741,61812,69922],
  SANTO_DOMINGO:  [75268,63946,70513,76013,57752,49166,39481,16828,48238,56707,60261,76900],
  THADER:         [85503,59200,68889,57260,55367,41291,46874,41341,36934,41086,48623,52548],
  BENIDORM:       [45117,42371,48270,90830,74726,70137,116811,134660,68566,48613,42529,41623],
  ARENALES:       [20175,20161,20990,34112,48026,62945,105183,122644,33917,19424,14199,12815],
  ALICANTE:       [43097,43399,48518,43396,42730,40043,39748,41157,32935,34896,32738,39488],
  TORREVIEJA:     [30983,28992,32709,38086,34785,29163,37573,45157,22764,21424,22341,22213],
  SANTA_POLA:     [17213,18686,17675,23712,28052,28913,46028,53754,23549,13784,11958,8626],
  CREVILLENTE:    [26542,23695,28002,29022,29572,23407,23066,25136,21791,25581,17752,15079],
  ORIHUELA:       [43585,35675,34883,35676,32984,28092,29888,31511,27355,31193,27222,28238],
  SAN_VICENTE:    [40248,44750,48579,37592,37495,30227,28328,28820,30154,32545,27693,27584],
  MURCIA_MERCED:  [5655,6721,7963,9651,7310,4624,4146,11696,10263,8529,10181,7825],
  CHICKEN_THADER: [0,0,0,11116,10222,6747,7887,8244,12025,10469,14411,11761],
  CHICKEN_UNCLES: [8894,10040,13308,9864,11850,8264,5834,10350,6479,6837,12130,10051],
};

// Totales agregados Ene 2024 — Abr 2026
const HTOT_MENSUAL = [
  { anio: 2024, mes:  1, total: 313720 }, { anio: 2024, mes:  2, total: 300572 },
  { anio: 2024, mes:  3, total: 513954 }, { anio: 2024, mes:  4, total: 448785 },
  { anio: 2024, mes:  5, total: 446012 }, { anio: 2024, mes:  6, total: 452719 },
  { anio: 2024, mes:  7, total: 526904 }, { anio: 2024, mes:  8, total: 627336 },
  { anio: 2024, mes:  9, total: 424127 }, { anio: 2024, mes: 10, total: 402477 },
  { anio: 2024, mes: 11, total: 401855 }, { anio: 2024, mes: 12, total: 535349 },
  { anio: 2025, mes:  1, total: 533142 }, { anio: 2025, mes:  2, total: 477860 },
  { anio: 2025, mes:  3, total: 526475 }, { anio: 2025, mes:  4, total: 578332 },
  { anio: 2025, mes:  5, total: 551097 }, { anio: 2025, mes:  6, total: 485630 },
  { anio: 2025, mes:  7, total: 591510 }, { anio: 2025, mes:  8, total: 649817 },
  { anio: 2025, mes:  9, total: 436817 }, { anio: 2025, mes: 10, total: 421668 },
  { anio: 2025, mes: 11, total: 403850 }, { anio: 2025, mes: 12, total: 424673 },
  { anio: 2026, mes:  1, total: 394342 }, { anio: 2026, mes:  2, total: 326194 },
  { anio: 2026, mes:  3, total: 370521 }, { anio: 2026, mes:  4, total: 405692 },
];

const DEFAULT_CONFIG = {
  pctMP: 38,
  pctPersonal: 28,
  pctImpuestos: 2,
  pctPublicidad: 1.5,
  euroHora: 12,
  incluirGlovo: true,
  modoSociedad: false,
  poolGroups: ['A'],
  poolProduccion: 17530,
  poolEspeciales: 16440,
};

module.exports = { LOCALES, H25, HTOT_MENSUAL, DEFAULT_CONFIG };
