// Hash canónico de un movimiento bancario.
//
// Diseñado para ser ESTABLE a través de los distintos formatos/parsers
// (XLS Santander, PDF Santander, XLS Sabadell) para que un mismo extracto
// importado dos veces — aunque sea en formato distinto — no genere
// duplicados al pasar por el ON CONFLICT (hash) DO NOTHING del bulk insert.
//
// Decisiones explícitas:
//
//   - codigo_banco y num_documento NO entran al hash. Distintos formatos
//     los pueblan distinto: el XLS viejo de Sabadell escribía codigo_banco
//     fijo 'SAB' y num_documento=NULL; el XLS nuevo (Phase 12) usa la
//     Referencia 1 real (12 chars) + Referencia 2; el PDF Santander deja
//     ambos en NULL. Incluirlos en el hash hace que la "misma" transacción
//     tenga 2-3 hashes distintos según el formato → bypass del dedupe.
//
//   - La fecha usada es MIN(fecha, fecha_valor). Algunos parsers han usado
//     fecha-operación como `fecha` principal y otros fecha-valor — al
//     hashear consistentemente la más temprana de las dos, los pares
//     "vieja=5-may / nueva=4-may" del mismo recibo (donde uno persistió
//     F.Operación y el otro F.Valor) colisionan al mismo hash. Si
//     fecha_valor es null, usamos fecha directamente.
//
//   - sociedad_id + concepto + importe son los identificadores fuertes.
//     concepto se trimea (los formatos pueden agregar espacios al final).
//     importe se normaliza a 2 decimales como string (mismo número en
//     punto/coma decimal colisiona después de parseo).
//
// NOTA: cambiar este hash invalida el dedupe vs los movs YA importados
// con la fórmula vieja. Para meses ya cargados con doble formato, hace
// falta un cleanup manual (script de borrar duplicados como los del
// turno 2026-06-03). El hash nuevo protege importaciones FUTURAS.

const crypto = require('crypto');

function hashMovimiento({ sociedad_id, fecha, fecha_valor, concepto, importe }) {
  const fechaCanonica = (fecha_valor && fecha_valor < fecha) ? fecha_valor : fecha;
  const key = [
    sociedad_id || '',
    fechaCanonica || '',
    (concepto || '').trim(),
    Number(importe).toFixed(2),
  ].join('|');
  return crypto.createHash('sha256').update(key).digest('hex');
}

module.exports = { hashMovimiento };
