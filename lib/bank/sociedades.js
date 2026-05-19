// Sociedades y mapeo a locales. Estos datos son la fuente de verdad
// para el módulo bancario — no se sobreescriben desde la UI.

const SOCIEDADES = [
  { id: 'hostelero', nombre: 'Grupo Hostelero Aires SL',    cif: 'B06851935', banco_default: 'santander',
    locales: ['ELCHE'] },
  { id: 'alicante',  nombre: 'Aires Alicante SL',           cif: 'B44897973', banco_default: 'santander',
    locales: ['ALICANTE', 'ARENALES', 'CREVILLENTE', 'CHICKEN_UNCLES'] },
  { id: 'smart',     nombre: 'Smart Aires SL',              cif: 'B67929901', banco_default: 'santander',
    locales: ['SANTA_POLA', 'TORREVIEJA', 'SAN_VICENTE'] },
  { id: 'murcia',    nombre: 'Aires Burger Bar Murcia SL',  cif: 'B44896793', banco_default: 'santander',
    locales: ['MURCIA_MERCED', 'SANTO_DOMINGO', 'ORIHUELA', 'THADER', 'CHICKEN_THADER'] },
  { id: 'benidorm',  nombre: 'Aires Burger Bar Benidorm SL',cif: 'B70864954', banco_default: 'santander',
    locales: ['BENIDORM'] },
];

const DIRECCIONES = {
  ELCHE:           'Calle Troneta 13',
  SANTA_POLA:      'Av Jesús Astondoa 9',
  TORREVIEJA:      'Calle Canónigo Torres 3',
  MURCIA_MERCED:   'Calle Merced 14',
  SANTO_DOMINGO:   'Calle Santa Ana 1',
  ALICANTE:        'Calle Pintor Sorolla 3',
  ARENALES:        'Av Bartolomé de Tir 48',
  CREVILLENTE:     'Plaza Com. Valenciana 6',
  ORIHUELA:        'Calle Valencia 9',
  BENIDORM:        'Av Europa 9',
  CHICKEN_UNCLES:  'Calle Troneta 11',
  SAN_VICENTE:     'Calle Pelayo 23',
  THADER:          'Complejo Las Arenas P35-36',
  CHICKEN_THADER:  'Complejo Las Arenas P50',
};

// Reverse index: local_id → sociedad_id
const LOCAL_TO_SOCIEDAD = {};
for (const s of SOCIEDADES) {
  for (const l of s.locales) LOCAL_TO_SOCIEDAD[l] = s.id;
}

const SOCIEDAD_IDS = new Set(SOCIEDADES.map((s) => s.id));

function findSociedad(id) {
  return SOCIEDADES.find((s) => s.id === id) || null;
}

function sociedadDeLocal(localId) {
  return LOCAL_TO_SOCIEDAD[localId] || null;
}

module.exports = { SOCIEDADES, DIRECCIONES, LOCAL_TO_SOCIEDAD, SOCIEDAD_IDS, findSociedad, sociedadDeLocal };
