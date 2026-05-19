// Constantes UI — no cambian. Datos vienen de /api/v1/aires/bootstrap.
window.UICONST = {
  GC: { A: '#639922', B: '#BA7517', C: '#185FA5', D: '#A32D2D' },
  MESES: ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'],
  LCOLORS: ['#185FA5','#639922','#BA7517','#A32D2D','#7C3AED','#DB2777','#0891B2','#D97706','#059669','#DC2626','#0F766E','#9333EA','#B45309'],
  COST_KEYS: ['mp','pers','imp','pub','alq','sum','glv','prod','esp'],
  COST_LBLS: ['Mat. Prima','Personal','Impuestos','Publicidad','Alquiler','Suministros','Glovo','Producción','Especiales'],
  COST_CLRS: [
    'rgba(99,153,34,.75)','rgba(186,117,23,.75)','rgba(163,45,45,.55)',
    'rgba(219,39,119,.6)','rgba(24,95,165,.75)','rgba(24,95,165,.4)',
    'rgba(124,58,237,.7)','rgba(8,145,178,.75)','rgba(8,145,178,.4)',
  ],
  // Facturación total mensual agregada Ene 2024 – Abr 2026 (incluye revenues no capturados en H25 per-local)
  HTOT_MENSUAL: [
    {m:"E'24",t:313720,y:24},{m:"F'24",t:300572,y:24},{m:"M'24",t:513954,y:24},{m:"A'24",t:448785,y:24},
    {m:"My'24",t:446012,y:24},{m:"J'24",t:452719,y:24},{m:"Jl'24",t:526904,y:24},{m:"Ag'24",t:627336,y:24},
    {m:"S'24",t:424127,y:24},{m:"O'24",t:402477,y:24},{m:"N'24",t:401855,y:24},{m:"D'24",t:535349,y:24},
    {m:"E'25",t:533142,y:25},{m:"F'25",t:477860,y:25},{m:"M'25",t:526475,y:25},{m:"A'25",t:578332,y:25},
    {m:"My'25",t:551097,y:25},{m:"J'25",t:485630,y:25},{m:"Jl'25",t:591510,y:25},{m:"Ag'25",t:649817,y:25},
    {m:"S'25",t:436817,y:25},{m:"O'25",t:421668,y:25},{m:"N'25",t:403850,y:25},{m:"D'25",t:424673,y:25},
    {m:"E'26",t:394342,y:26},{m:"F'26",t:326194,y:26},{m:"M'26",t:370521,y:26},{m:"A'26·",t:405692,y:26},
  ],
};
