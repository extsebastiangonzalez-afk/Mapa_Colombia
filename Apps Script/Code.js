/**
 * ============================================================
 * VISOR COBERTURA ESTRATÉGICA — Backend (Code.gs)
 * ============================================================
 * Lee los JSON que genera etl_sellout.py desde Drive y los sirve
 * al frontend (Index.html).
 *
 * ARCHIVOS QUE CONSUME (carpeta _visor_json en Drive):
 *   so_pdv.json          PDV × BU × mes        → base del mapa
 *   so_portafolio.json   SKU × mes + catálogo  → panel de portafolio
 *   so_indice.json       PDV → fragmento       → enrutador detalle por PDV
 *   so_detalle_NN.json   PDV × SKU × mes       → portafolio de un PDV
 *   so_sku_indice.json   SKU → fragmento       → enrutador análisis producto
 *   so_sku_NN.json       SKU × PDV × mes       → distribución de un producto
 *   so_manifiesto.json   metadatos             → diagnóstico
 *
 * CONFIGURACIÓN: solo hay que revisar CARPETA_JSON_ID y SPREADSHEET_ID.
 *
 * DESPUÉS DE CADA CORRIDA DEL ETL: ejecutar limpiarCache().
 */

/* ============================================================
 * CONFIGURACIÓN
 * ============================================================ */

var CARPETA_JSON_ID = '1Kg2WPunJtn-KjeNdhsEN4ojT6q00JPhm';
var SPREADSHEET_ID  = '1fILFlz4cO4mmW-oOnhTuewCicoWJ8bzFUUAN30GaewI';

var NOMBRE_HOJA_PUNTOS = 'CO_Puntos_Maestro clientes';
var VISOR_HOJA_BRICKS  = 'Bricks';

var CACHE_SEGUNDOS   = 21600;   // 6 horas
var CACHE_TROZO      = 90000;   // CacheService acepta 100 KB por clave
var CACHE_MAX_TROZOS = 60;      // ~5.4 MB máximo por archivo

/* ============================================================
 * Entrada de la Web App
 * ============================================================ */

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Cobertura Estratégica · ISDIN Colombia')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function abrirHoja_() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

/* ============================================================
 * Lectura de Drive con caché por trozos
 * ============================================================ */

function carpetaJson_() {
  if (!CARPETA_JSON_ID || CARPETA_JSON_ID.indexOf('PEGAR') === 0) {
    throw new Error('Falta configurar CARPETA_JSON_ID en Code.gs.');
  }
  try {
    return DriveApp.getFolderById(CARPETA_JSON_ID);
  } catch (e) {
    throw new Error('No pude abrir la carpeta de Drive (' + CARPETA_JSON_ID + '): ' + e.message);
  }
}

function leerArchivoDrive_(nombre) {
  var cache = CacheService.getScriptCache();
  var meta  = cache.get('meta::' + nombre);

  if (meta) {
    var n = Number(meta), claves = [];
    for (var i = 0; i < n; i++) claves.push('t::' + nombre + '::' + i);
    var trozos = cache.getAll(claves), partes = [], ok = true;
    for (var j = 0; j < n; j++) {
      var t = trozos['t::' + nombre + '::' + j];
      if (!t) { ok = false; break; }
      partes.push(t);
    }
    if (ok) return partes.join('');
  }

  var it = carpetaJson_().getFilesByName(nombre);
  if (!it.hasNext()) {
    throw new Error("No encontré '" + nombre + "' en Drive. Corre etl_sellout.py.");
  }
  var texto = it.next().getBlob().getDataAsString('UTF-8');

  var total = Math.ceil(texto.length / CACHE_TROZO);
  if (total <= CACHE_MAX_TROZOS) {
    var mapa = {};
    for (var k = 0; k < total; k++) {
      mapa['t::' + nombre + '::' + k] = texto.substr(k * CACHE_TROZO, CACHE_TROZO);
    }
    mapa['meta::' + nombre] = String(total);
    try { cache.putAll(mapa, CACHE_SEGUNDOS); } catch (e) { /* caché llena */ }
  }
  return texto;
}

/** Ejecutar tras cada corrida del ETL. */
function limpiarCache() {
  CacheService.getScriptCache().removeAll([
    'meta::so_pdv.json', 'meta::so_portafolio.json', 'meta::so_indice.json',
    'meta::so_sku_indice.json', 'meta::so_manifiesto.json'
  ]);
  Logger.log('Caché limpiada.');
  return 'OK';
}

function nombreFrag_(prefijo, n) {
  var num = parseInt(n, 10);
  if (isNaN(num) || num < 0) {
    throw new Error('Fragmento inválido para ' + prefijo + ': ' + JSON.stringify(n) +
                    '. Revisa el índice generado por etl_sellout.py.');
  }
  var s = String(num);
  while (s.length < 2) s = '0' + s;
  return prefijo + s + '.json';
}

/**
 * Número de fragmento de un PDV en so_indice.json. El ETL guarda cada PDV
 * como objeto {desc, frag, unidades, importe}; se acepta también un número
 * suelto por compatibilidad. Devuelve NaN si no hay fragmento válido.
 */
function fragDePdv_(entrada) {
  if (entrada !== null && typeof entrada === 'object') entrada = entrada.frag;
  return parseInt(entrada, 10);
}

/**
 * so_detalle_NN.json trae {fragmento, meses, pdv: {POS_ID: {SKU: serie}}}.
 * Devuelve el mapa de PDV; si el archivo viene plano ({POS_ID: ...}) lo usa tal cual.
 */
function pdvsDeFragmento_(datos) {
  return (datos && datos.pdv && typeof datos.pdv === 'object') ? datos.pdv : (datos || {});
}

/* ============================================================
 * Endpoints — ventas
 * ============================================================ */

/** PDV × BU × mes. Base del mapa. */
function getVentasJson() {
  return leerArchivoDrive_('so_pdv.json');
}

/** SKU × mes + catálogo de productos. */
function getPortafolioJson() {
  return leerArchivoDrive_('so_portafolio.json');
}

/** Portafolio de UN PDV (bajo demanda, al hacer clic en un marcador). */
function getDetallePdvJson(posId) {
  var pos = normalizarPos_(posId);
  if (!pos) return JSON.stringify({ posId: '', productos: {} });

  var indice = JSON.parse(leerArchivoDrive_('so_indice.json'));
  var entrada = indice.pdv ? indice.pdv[pos] : undefined;
  if (entrada === undefined) {
    return JSON.stringify({ posId: pos, productos: {}, aviso: 'PDV sin ventas.' });
  }
  var frag  = fragDePdv_(entrada);
  var datos = JSON.parse(leerArchivoDrive_(nombreFrag_('so_detalle_', parseInt(frag, 10))));
  return JSON.stringify({ posId: pos, productos: pdvsDeFragmento_(datos)[pos] || {} });
}

/** Portafolio agregado de varios PDV (todos los de un brick). */
function getDetalleAgregadoJson(posIdsCsv) {
  var lista = (posIdsCsv || '').split(',').map(normalizarPos_).filter(Boolean);
  if (!lista.length) {
    return JSON.stringify({ productos: {}, pdvConsultados: 0, pdvConVentas: 0 });
  }

  var vistos = {}, unicos = [];
  lista.forEach(function(p) { if (!vistos[p]) { vistos[p] = 1; unicos.push(p); } });

  var indice  = JSON.parse(leerArchivoDrive_('so_indice.json'));
  var porFrag = {}, encontrados = 0;
  unicos.forEach(function(pos) {
    var entrada = indice.pdv ? indice.pdv[pos] : undefined;
    if (entrada === undefined) return;
    var f = fragDePdv_(entrada);
    if (isNaN(f)) return;
    if (!porFrag[f]) porFrag[f] = [];
    porFrag[f].push(pos);
    encontrados++;
  });

  var acc = {};
  Object.keys(porFrag).forEach(function(f) {
    // Las claves de porFrag son strings (Object.keys): se convierten a entero.
    var datos = pdvsDeFragmento_(JSON.parse(
      leerArchivoDrive_(nombreFrag_('so_detalle_', parseInt(f, 10)))));
    porFrag[f].forEach(function(pos) {
      var skus = datos[pos];
      if (!skus) return;
      Object.keys(skus).forEach(function(sku) {
        if (!acc[sku]) acc[sku] = {};
        skus[sku].forEach(function(t) {
          var s = acc[sku][t[0]];
          if (!s) s = acc[sku][t[0]] = [0, 0];
          s[0] += t[1]; s[1] += t[2];
        });
      });
    });
  });

  var productos = {};
  Object.keys(acc).forEach(function(sku) {
    var serie = [];
    Object.keys(acc[sku]).forEach(function(im) {
      serie.push([Number(im), acc[sku][im][0], acc[sku][im][1]]);
    });
    serie.sort(function(a, b) { return a[0] - b[0]; });
    productos[sku] = serie;
  });

  return JSON.stringify({
    productos: productos, pdvConsultados: unicos.length, pdvConVentas: encontrados
  });
}

/* ============================================================
 * Endpoint nuevo: distribución geográfica de UN producto
 * ============================================================
 * Responde "¿dónde rota este SKU?". El frontend lo usa para
 * recolorear el mapa por ventas de ese producto y para calcular
 * cobertura, precio promedio ponderado y brechas.
 *
 * Devuelve: { sku, pdv: { 'POS_ID': [[iMes, units, amount], ...] } }
 */
function getDistribucionSkuJson(sku) {
  var s = (sku || '').toString().trim();
  if (!s) return JSON.stringify({ sku: '', pdv: {} });

  var indice = JSON.parse(leerArchivoDrive_('so_sku_indice.json'));
  var frag   = indice.sku ? indice.sku[s] : undefined;
  if (frag === undefined) {
    return JSON.stringify({ sku: s, pdv: {}, aviso: 'Producto sin ventas registradas.' });
  }
  var datos = JSON.parse(leerArchivoDrive_(nombreFrag_('so_sku_', parseInt(frag, 10))));
  return JSON.stringify({ sku: s, pdv: datos[s] || {} });
}

/* ============================================================
 * Endpoints — geografía (Google Sheets)
 * ============================================================ */

function getBricksJson() {
  var sheet = abrirHoja_().getSheetByName(VISOR_HOJA_BRICKS);
  if (!sheet) {
    throw new Error("No se encontró la hoja '" + VISOR_HOJA_BRICKS + "'. " +
                    "Disponibles: " + listarPestanas_().join(' | '));
  }

  var data    = sheet.getDataRange().getValues();
  var headers = data[0].map(function(h) { return String(h).trim().toLowerCase(); });

  var iId     = buscarCol_(headers, ['brick_id', 'brick id', 'brickid', 'id_brick']);
  var iGeo    = buscarCol_(headers, ['geometria_geojson', 'geometría_geojson', 'geojson',
                                     'geometria', 'geometría', 'polygon', 'poligono']);
  var iNombre = buscarCol_(headers, ['nombre_brick', 'nombre brick']);
  var iNom2   = buscarCol_(headers, ['nombre']);
  var iZona   = buscarCol_(headers, ['zona']);
  var iCiudad = buscarCol_(headers, ['ciudad']);
  var iDpto   = buscarCol_(headers, ['departamento', 'depto']);

  if (iId === -1 || iGeo === -1) {
    throw new Error("Faltan columnas de ID y geometría. Encabezados: " + headers.join(' | '));
  }

  var bricks = [], conGeo = 0, sinGeo = 0, errores = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i], bid = row[iId];
    if (!bid || !bid.toString().trim()) continue;

    var geom = null, raw = row[iGeo];
    if (raw && raw.toString().trim()) {
      try { geom = normalizarGeometria_(JSON.parse(raw.toString())); }
      catch (e) { if (errores.length < 3) errores.push(bid + ': ' + raw.toString().substring(0, 60)); }
    }
    if (geom) conGeo++; else sinGeo++;

    bricks.push({
      brickId:      bid.toString().trim(),
      nombre:       iNom2   !== -1 ? String(row[iNom2])   : '',
      zona:         iZona   !== -1 ? String(row[iZona])   : '',
      ciudad:       iCiudad !== -1 ? String(row[iCiudad]) : '',
      departamento: iDpto   !== -1 ? String(row[iDpto])   : '',
      nombreBrick:  iNombre !== -1 ? String(row[iNombre]) : '',
      geometry:     geom
    });
  }

  return JSON.stringify({
    bricks: bricks,
    stats: { filas: bricks.length, conGeometria: conGeo,
             sinGeometria: sinGeo, erroresMuestra: errores }
  });
}

function getPuntosJson() {
  var sheet = abrirHoja_().getSheetByName(NOMBRE_HOJA_PUNTOS);
  if (!sheet) {
    throw new Error("No se encontró la hoja '" + NOMBRE_HOJA_PUNTOS + "'. " +
                    "Disponibles: " + listarPestanas_().join(' | '));
  }

  var data    = sheet.getDataRange().getValues();
  var headers = data[0].map(function(h) { return String(h).trim().toLowerCase(); });

  var idIdx     = buscarCol_(headers, ['id cuenta']);
  var idSapIdx  = buscarCol_(headers, ['id cliente sap']);
  var nameIdx   = buscarCol_(headers, ['nombre de la cuenta']);
  var grupoIdx  = buscarCol_(headers, ['grupo de compras']);
  var canalIdx  = buscarCol_(headers, ['channel']);
  var regIdx    = buscarCol_(headers, ['región', 'region']);
  var pobIdx    = buscarCol_(headers, ['población', 'poblacion']);
  var calleIdx  = buscarCol_(headers, ['calle']);
  var numIdx    = buscarCol_(headers, ['número/piso', 'numero/piso']);
  var brickIdx  = buscarCol_(headers, ['brick ubicación', 'brick ubicacion']);
  var latIdx    = buscarCol_(headers, ['latitud']);
  var lngIdx    = buscarCol_(headers, ['longitud']);
  var posIdIdx  = buscarCol_(headers, ['oficina farmacia', 'oficina de farmacia']);
  var potIdx    = buscarCol_(headers, ['potencial cliente', 'potencial']);
  var afinIdx   = buscarCol_(headers, ['afinidad']);

  if (latIdx === -1 || lngIdx === -1) {
    throw new Error("No encontré 'Latitud'/'Longitud'.");
  }

  var puntos = [], filas = 0, sinCoord = 0, conPos = 0;
  function txt(row, i) { return (i !== -1 && row[i] != null) ? row[i].toString().trim() : ''; }

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (!txt(row, idIdx) && !txt(row, nameIdx)) continue;
    filas++;

    var lat = parseNum_(row[latIdx]), lng = parseNum_(row[lngIdx]);
    if (isNaN(lat) || isNaN(lng) || (lat === 0 && lng === 0) ||
        lat < -90 || lat > 90 || lng < -180 || lng > 180) { sinCoord++; continue; }

    var posId = normalizarPos_(txt(row, posIdIdx));
    if (posId) conPos++;

    puntos.push({
      id: txt(row, idIdx), idSap: txt(row, idSapIdx), posId: posId,
      name:      txt(row, nameIdx)  || 'Sin Nombre',
      lat: lat, lng: lng,
      grupo:     txt(row, grupoIdx) || 'Sin Grupo',
      channel:   txt(row, canalIdx) || 'Sin Canal',
      region:    txt(row, regIdx)   || 'Sin Región',
      poblacion: txt(row, pobIdx)   || 'Sin Población',
      potencial: txt(row, potIdx)   || 'Sin Potencial',
      afinidad:  txt(row, afinIdx),
      direccion: [txt(row, calleIdx), txt(row, numIdx)].filter(Boolean).join(' ') || 'Sin Dirección',
      brickCrm:  txt(row, brickIdx)
    });
  }

  return JSON.stringify({
    puntos: puntos,
    stats: { filas: filas, conCoordenada: puntos.length, sinCoordenada: sinCoord,
             conPosId: conPos,
             columnaPosIdDetectada: posIdIdx !== -1 ? String(data[0][posIdIdx]) : '(no encontrada)' }
  });
}

/* ============================================================
 * Diagnóstico
 * ============================================================ */

function getDiagnosticoJson() {
  var d = { drive: {}, bricks: {}, puntos: {}, cruce: {} };

  try {
    var carpeta = carpetaJson_(), archivos = [], it = carpeta.getFiles();
    while (it.hasNext()) {
      var f = it.next();
      archivos.push(f.getName() + ' (' + Math.round(f.getSize() / 1024) + ' KB)');
    }
    d.drive.carpeta  = carpeta.getName();
    d.drive.archivos = archivos.sort();
    try { d.drive.manifiesto = JSON.parse(leerArchivoDrive_('so_manifiesto.json')); }
    catch (e) { d.drive.manifiesto = 'No disponible: ' + e.message; }
    d.drive.indiceSkuDisponible = archivos.some(function(a) { return a.indexOf('so_sku_indice') === 0; });
  } catch (e) { d.drive.error = e.message; }

  try {
    var pb = JSON.parse(getBricksJson());
    d.bricks = { total: pb.bricks.length, conGeometria: pb.stats.conGeometria,
                 sinGeometria: pb.stats.sinGeometria };
    for (var i = 0; i < pb.bricks.length; i++) {
      if (pb.bricks[i].geometry) {
        var g = pb.bricks[i].geometry;
        d.bricks.ejemplo = {
          brickId: pb.bricks[i].brickId, tipo: g.type,
          primerVertice: g.type === 'Polygon' ? g.coordinates[0][0] : g.coordinates[0][0][0]
        };
        break;
      }
    }
  } catch (e) { d.bricks.error = e.message; }

  try {
    var pp = JSON.parse(getPuntosJson());
    d.puntos = pp.stats;
    var indice = JSON.parse(leerArchivoDrive_('so_indice.json'));
    var ventas = indice.pdv || {};
    var cruzan = 0, sinPos = 0;
    pp.puntos.forEach(function(p) {
      if (!p.posId || p.posId === '0') { sinPos++; return; }
      if (ventas[p.posId] !== undefined) cruzan++;
    });
    d.cruce = {
      pdvTotales: pp.puntos.length, pdvSinPosId: sinPos, pdvQueCruzan: cruzan,
      porcentaje: pp.puntos.length ? Math.round(100 * cruzan / pp.puntos.length) + '%' : '0%'
    };
  } catch (e) { d.puntos.error = e.message; }

  return JSON.stringify(d, null, 2);
}

function probarConexion() {
  try {
    var carpeta = carpetaJson_(), archivos = [], it = carpeta.getFiles();
    while (it.hasNext()) archivos.push(it.next().getName());
    archivos.sort();
    var haySku = archivos.some(function(a) { return a.indexOf('so_sku_') === 0; });
    Logger.log('Carpeta "' + carpeta.getName() + '" accesible.');
    Logger.log('Archivos (' + archivos.length + '): ' + archivos.join(', '));
    Logger.log(haySku ? 'Índice por SKU disponible: análisis de producto activo.'
                      : 'FALTA el índice por SKU. Corre el ETL actualizado.');
    return 'OK: ' + archivos.length + ' archivos.';
  } catch (e) {
    Logger.log('Error: ' + e.message);
    return 'ERROR: ' + e.message;
  }
}

function verDiagnostico() { Logger.log(getDiagnosticoJson()); }

/* ============================================================
 * Utilidades
 * ============================================================ */

function parseNum_(v) {
  if (v === null || v === undefined || v === '') return NaN;
  if (typeof v === 'number') return v;
  var s = v.toString().trim().replace(/\s+/g, '');
  if (!s) return NaN;
  var coma = s.indexOf(',') !== -1, punto = s.indexOf('.') !== -1;
  if (coma && punto) {
    s = s.lastIndexOf(',') > s.lastIndexOf('.')
      ? s.replace(/\./g, '').replace(/,/g, '.') : s.replace(/,/g, '');
  } else if (coma) {
    var p = s.split(','); s = p[0] + '.' + p.slice(1).join('');
  }
  var n = parseFloat(s);
  return isNaN(n) ? NaN : n;
}

function normalizarPos_(v) {
  if (!v) return '';
  return v.toString().trim().toUpperCase().replace(/\s+/g, '').replace(/:/g, '_');
}

function buscarCol_(headers, frags) {
  for (var f = 0; f < frags.length; f++) {
    for (var i = 0; i < headers.length; i++) {
      if (headers[i].indexOf(frags[f]) !== -1) return i;
    }
  }
  return -1;
}

function normalizarGeometria_(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.type === 'FeatureCollection' && obj.features) {
    var geoms = [];
    obj.features.forEach(function(ft) {
      var g = normalizarGeometria_(ft);
      if (!g) return;
      if (g.type === 'Polygon') geoms.push(g.coordinates);
      else if (g.type === 'MultiPolygon') geoms = geoms.concat(g.coordinates);
    });
    if (!geoms.length) return null;
    return geoms.length === 1 ? { type: 'Polygon', coordinates: geoms[0] }
                              : { type: 'MultiPolygon', coordinates: geoms };
  }
  if (obj.type === 'Feature') return normalizarGeometria_(obj.geometry);
  if (obj.type === 'Polygon' || obj.type === 'MultiPolygon') {
    return (obj.coordinates && obj.coordinates.length) ? obj : null;
  }
  if (Array.isArray(obj) && obj.length) return { type: 'Polygon', coordinates: obj };
  return null;
}

function listarPestanas_() {
  return abrirHoja_().getSheets().map(function(s) { return s.getName(); });
}