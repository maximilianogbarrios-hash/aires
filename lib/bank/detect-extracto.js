// Auto-detección de formato y sociedad para extractos bancarios.
//
// Lo usa el endpoint /upload-extracto-auto: recibe un buffer + filename y
// decide qué parser invocar (santander-xls, santander-pdf, sabadell-xls,
// sabadell-pdf) y, si el body no trajo sociedad_id, intenta deducirla del
// nombre del archivo (heurística rápida) antes de delegar la detección
// definitiva al parser (que lee el titular del header).

const { TITULAR_PATRONES } = require('./parser-santander-pdf');

// Magic bytes para distinguir PDF vs XLS/XLSX en buffer.
function detectarTipoArchivo(buffer) {
  if (!buffer || buffer.length < 4) return null;
  // PDF empieza con %PDF-
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
    return 'pdf';
  }
  // XLSX (OOXML) — zip: PK\x03\x04
  if (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
    return 'xlsx';
  }
  // XLS antiguo (BIFF) — D0 CF 11 E0
  if (buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0) {
    return 'xls';
  }
  return null;
}

// Detecta el banco a partir de pistas en el filename y/o de magic bytes
// para los XLS (Sabadell y Santander generan layouts internos distintos
// que se distinguen recién al parsear; el filename es el primer indicio).
function detectarBancoPorFilename(filename) {
  const n = (filename || '').toLowerCase();
  if (/sabadell|bsabadell|0081/.test(n)) return 'sabadell';
  if (/santander|0049/.test(n))           return 'santander';
  return null;
}

// Sociedad por filename. Permite al usuario nombrar los archivos como
// "Santander_Murcia_May2026.pdf" / "Sabadell_SmartAires_*.xls" y nos
// salvamos la detección por header.
function detectarSociedadPorFilename(filename) {
  const n = (filename || '').toLowerCase();
  if (/murcia/.test(n))                          return 'murcia';
  if (/benidorm/.test(n))                        return 'benidorm';
  if (/smart|smartaires|smart_aires/.test(n))    return 'smart';
  if (/alicante|crevillente|arenales/.test(n))   return 'alicante';
  if (/hostelero|elche/.test(n))                 return 'hostelero';
  return null;
}

// Resuelve el formato a una clave canónica que el endpoint usa para
// despachar al parser correcto. Retorna null si no podemos decidir.
// El banco a veces NO se puede determinar del buffer (XLS sabadell vs
// santander se distinguen sólo al parsear el header). Para esos casos
// retornamos el formato con banco=null y dejamos que el caller pruebe
// ambos parsers (o use el filename como hint).
function detectarFormato(buffer, filename) {
  const tipo = detectarTipoArchivo(buffer);
  const banco = detectarBancoPorFilename(filename);
  if (!tipo) return { tipo: null, banco, formato: null };
  if (tipo === 'pdf') {
    // Para PDF distinguimos por filename. Si no hay hint asumimos santander
    // (parser principal hoy); el parser fallará limpiamente si el layout no
    // matchea y el caller puede mostrar el error.
    return { tipo, banco: banco || 'santander', formato: `${banco || 'santander'}-pdf` };
  }
  // XLS/XLSX: idem, pero asumimos sabadell por defecto cuando no hay hint
  // (Santander se distingue porque su parser actual es el viejo /upload-extracto;
  // si el filename no da pistas, probamos sabadell primero — fallback santander
  // se maneja en el endpoint).
  return { tipo, banco, formato: banco ? `${banco}-xls` : null };
}

// Mira los primeros chars del archivo (texto descomprimido del XLS no lo
// tenemos sin parsear; para PDF sí podemos hacer un substring en bruto del
// buffer). Útil como fallback cuando filename no dice nada.
function detectarBancoDesdeContenido(buffer, tipo) {
  if (tipo !== 'pdf') return null;
  // En el binario del PDF, los strings de texto aparecen como ASCII en
  // streams Tj — buscamos "Sabadell" / "Santander" como substring crudo.
  // No siempre funciona (algunos PDFs comprimen los streams), pero es
  // mejor que nada como hint adicional.
  const head = buffer.slice(0, Math.min(8000, buffer.length)).toString('latin1');
  if (/Sabadell/i.test(head)) return 'sabadell';
  if (/Santander/i.test(head)) return 'santander';
  return null;
}

module.exports = {
  detectarTipoArchivo,
  detectarBancoPorFilename,
  detectarSociedadPorFilename,
  detectarFormato,
  detectarBancoDesdeContenido,
  TITULAR_PATRONES,
};
