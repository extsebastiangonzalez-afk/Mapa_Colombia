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
 * Además lee, directo del Sheet (no del Drive/ETL), la hoja 'Asignacion'
 * (VM/LAM por PDV) vía getAsignacionesJson().
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

var NOMBRE_HOJA_PUNTOS     = 'CO_Puntos_Maestro clientes';
var VISOR_HOJA_BRICKS      = 'Bricks';
var NOMBRE_HOJA_ASIGNACION = 'Asignacion';

var CACHE_SEGUNDOS   = 21600;   // 6 horas
var CACHE_TROZO      = 90000;   // CacheService acepta 100 KB por clave
var CACHE_MAX_TROZOS = 60;      // ~5.4 MB máximo por archivo

/* ============================================================
 * Entrada de la Web App
 * ============================================================ */

function doGet(e) {
  // Ruteo opcional por ?accion=... para consumir los endpoints como API REST.
  // Sin parámetro (el caso normal de la web app) sigue devolviendo el HTML.
  var accion = (e && e.parameter && e.parameter.accion) || '';
  if (accion === 'getVentasMtdJson') {
    return ContentService.createTextOutput(getVentasMtdJson())
      .setMimeType(ContentService.MimeType.JSON);
  }

  // createTemplateFromFile + evaluate(): obligatorio para que se procesen los
  // <?!= include('...') ?> con los que Index.html ensambla Estilos y los Js*.
  return HtmlService.createTemplateFromFile('Index').evaluate()
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
/**
 * Cantidad de SKUs distintos vendidos (histórico, no filtrado por período) por cada
 * PDV de la lista. Usado por la tabla ampliada del panel de brick (columna "#SKUs"):
 * mismo agrupamiento por fragmento que getDetalleAgregadoJson(), pero devuelve un
 * conteo por PDV en vez de sumar todo junto.
 */
function getConteoSkuJson(posIdsCsv) {
  var lista = (posIdsCsv || '').split(',').map(normalizarPos_).filter(Boolean);
  if (!lista.length) return JSON.stringify({ conteo: {} });

  var vistos = {}, unicos = [];
  lista.forEach(function(p) { if (!vistos[p]) { vistos[p] = 1; unicos.push(p); } });

  var indice  = JSON.parse(leerArchivoDrive_('so_indice.json'));
  var porFrag = {};
  unicos.forEach(function(pos) {
    var entrada = indice.pdv ? indice.pdv[pos] : undefined;
    if (entrada === undefined) return;
    var f = fragDePdv_(entrada);
    if (isNaN(f)) return;
    if (!porFrag[f]) porFrag[f] = [];
    porFrag[f].push(pos);
  });

  var conteo = {};
  Object.keys(porFrag).forEach(function(f) {
    var datos = pdvsDeFragmento_(JSON.parse(
      leerArchivoDrive_(nombreFrag_('so_detalle_', parseInt(f, 10)))));
    porFrag[f].forEach(function(pos) {
      var skus = datos[pos];
      conteo[pos] = skus ? Object.keys(skus).length : 0;
    });
  });

  return JSON.stringify({ conteo: conteo });
}

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
 * Endpoint — cobertura comercial (Google Sheets)
 * ============================================================ */

/**
 * Hoja 'Asignacion': quién (VM o LAM) tiene asignado cada PDV. Cruza por
 * 'Nº Oficina Farmacia' (mismo POS_ID normalizado que el resto del visor).
 * Un PDV puede tener más de una fila (p. ej. un VM y un LAM a la vez),
 * así que devuelve un arreglo de asignaciones por PDV, no una sola.
 */
function getAsignacionesJson() {
  var sheet = abrirHoja_().getSheetByName(NOMBRE_HOJA_ASIGNACION);
  if (!sheet) {
    return JSON.stringify({ pdv: {}, aviso: "No se encontró la hoja '" + NOMBRE_HOJA_ASIGNACION + "'." });
  }

  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return JSON.stringify({ pdv: {} });
  var headers = data[0].map(function(h) { return String(h).trim().toLowerCase(); });

  var iPos      = buscarCol_(headers, ['oficina farmacia', 'oficina de farmacia']);
  var iDelegado = buscarCol_(headers, ['delegado']);
  var iCuentaId = buscarCol_(headers, ['id cuenta']);
  var iCuentaNom= buscarCol_(headers, ['nombre de la cuenta']);
  var iTipo     = buscarCol_(headers, ['tipo de registro']);
  var iTeam     = buscarCol_(headers, ['team']);

  if (iPos === -1) {
    throw new Error("No encontré 'Nº Oficina Farmacia' en la hoja '" + NOMBRE_HOJA_ASIGNACION +
                    "'. Encabezados: " + headers.join(' | '));
  }

  var pdv = {};
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var pos = normalizarPos_(row[iPos]);
    var delegado = iDelegado !== -1 ? String(row[iDelegado] || '').trim() : '';
    if (!pos || !delegado) continue;
    var asignacion = {
      delegado:     delegado,
      team:         iTeam      !== -1 ? String(row[iTeam]       || '').trim() : '',
      tipo:         iTipo      !== -1 ? String(row[iTipo]       || '').trim() : '',
      cuentaId:     iCuentaId  !== -1 ? String(row[iCuentaId]   || '').trim() : '',
      cuentaNombre: iCuentaNom !== -1 ? String(row[iCuentaNom]  || '').trim() : ''
    };
    if (!pdv[pos]) pdv[pos] = [];
    pdv[pos].push(asignacion);
  }

  return JSON.stringify({ pdv: pdv });
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

/** Inserta otro archivo del proyecto en la plantilla: <?!= include('JsMapa') ?>. */
function include(nombre) {
  return HtmlService.createHtmlOutputFromFile(nombre).getContent();
}

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

/* ============================================================
 * VENTAS MTD — pestaña 2 del dashboard
 * ============================================================
 * Lee DOS hojas del MISMO archivo (SPREADSHEET_ID_MTD):
 *   'CUMPLIMIENTO' → tarjeta KPI, tabla de clientes y tabla de KAM
 *   'PLANTILLA'    → tabla de productos
 *
 * Los encabezados se buscan por fragmentos (no por posición), así que
 * aguanta que muevan o renombren columnas. Los de PLANTILLA se escriben
 * en Logger.log() en cada lectura real para poder verificarlos.
 *
 * Caché: 'ventas_mtd' por 30 min. Si cambian las hojas y se quiere ver
 * el dato fresco antes, ejecutar limpiarCacheMtd().
 */

var SPREADSHEET_ID_MTD = '1hViwAW2zhLky4bg8uOsmlmeHa9AnLm5KtcWRvSrzoGw';

var HOJA_MTD_CUMPLIMIENTO = 'CUMPLIMIENTO';
var HOJA_MTD_PLANTILLA    = 'PLANTILLA';

var CACHE_MTD_CLAVE    = 'ventas_mtd';
var CACHE_MTD_SEGUNDOS = 1800;   // 30 min

/** Minúsculas, sin tildes y con espacios colapsados, para comparar encabezados. */
function mtdNorm_(v) {
  var s = String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');
  try { s = s.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (err) { /* sin normalize */ }
  return s;
}

/**
 * Índice del primer encabezado que contiene TODOS los fragmentos de `incluye`
 * y ninguno de `excluye`. Devuelve null si no hay ninguno (nunca lanza error).
 * Más estricto que buscarCol_: distingue 'Real (LOCAL)' de 'Real -1 (LOCAL)'.
 */
function mtdCol_(headers, incluye, excluye) {
  excluye = excluye || [];
  for (var i = 0; i < headers.length; i++) {
    var h = headers[i];
    if (!h) continue;
    var ok = true;
    for (var a = 0; a < incluye.length; a++) {
      if (h.indexOf(mtdNorm_(incluye[a])) === -1) { ok = false; break; }
    }
    if (!ok) continue;
    for (var b = 0; b < excluye.length; b++) {
      if (h.indexOf(mtdNorm_(excluye[b])) !== -1) { ok = false; break; }
    }
    if (ok) return i;
  }
  return null;
}

/** Primera alternativa de columna que exista: mtdColAlt_(h, [[inc, exc], ...]). */
function mtdColAlt_(headers, alternativas) {
  for (var i = 0; i < alternativas.length; i++) {
    var idx = mtdCol_(headers, alternativas[i][0], alternativas[i][1]);
    if (idx !== null) return idx;
  }
  return null;
}

/**
 * Valor numérico de una celda (0 si no es número). Usa parseNum_ existente,
 * salvo en un caso que parseNum_ no cubre: importes en texto con puntos de
 * miles al estilo colombiano ("3.100.000.000" o "1.234.567,89"), donde
 * parseFloat leería 3,1. El patrón exige grupos de exactamente 3 dígitos,
 * así que un decimal normal como "3.1" sigue yendo por parseNum_.
 */
function mtdNum_(row, idx) {
  if (idx === null || idx === undefined) return 0;
  var v = row[idx];
  if (typeof v === 'string') {
    var s = v.replace(/[$\s]/g, '');
    if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) {
      var n2 = parseFloat(s.replace(/\./g, '').replace(',', '.'));
      return isNaN(n2) ? 0 : n2;
    }
  }
  var n = parseNum_(v);
  return isNaN(n) ? 0 : n;
}

function mtdTexto_(row, idx) {
  if (idx === null || idx === undefined) return '';
  return String(row[idx] == null ? '' : row[idx]).trim();
}

/**
 * Porcentaje de cumplimiento: "62%" (string) → 0.62; 0.62 (número) → 0.62.
 * Devuelve null si la celda está vacía o no es interpretable.
 */
function mtdPct_(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  if (typeof valor === 'string' && valor.indexOf('%') !== -1) {
    var p = parseNum_(valor.replace(/%/g, ''));
    return isNaN(p) ? null : p / 100;
  }
  var d = parseNum_(valor);
  return isNaN(d) ? null : d;
}

/** Las filas de totales de la hoja se ignoran: el total se recalcula aquí. */
function mtdEsFilaTotal_(texto) {
  var t = mtdNorm_(texto);
  return t === '' ? false : (t.indexOf('total') === 0 || t.indexOf('gran total') === 0);
}

/* ---------- Caché por trozos (CacheService acepta 100 KB por clave) ---------- */

function mtdCacheLeer_(clave) {
  var cache = CacheService.getScriptCache();
  var meta  = cache.get('meta::' + clave);
  if (!meta) return null;
  var n = Number(meta), claves = [];
  for (var i = 0; i < n; i++) claves.push('t::' + clave + '::' + i);
  var trozos = cache.getAll(claves), partes = [];
  for (var j = 0; j < n; j++) {
    var t = trozos['t::' + clave + '::' + j];
    if (!t) return null;   // trozo vencido: se vuelve a leer la hoja
    partes.push(t);
  }
  return partes.join('');
}

function mtdCacheGuardar_(clave, texto, segundos) {
  var total = Math.ceil(texto.length / CACHE_TROZO);
  if (total > CACHE_MAX_TROZOS) return;
  var mapa = {};
  for (var i = 0; i < total; i++) {
    mapa['t::' + clave + '::' + i] = texto.substr(i * CACHE_TROZO, CACHE_TROZO);
  }
  mapa['meta::' + clave] = String(total);
  try { CacheService.getScriptCache().putAll(mapa, segundos); } catch (e) { /* caché llena */ }
}

/** Borra la caché de Ventas MTD (útil tras actualizar las hojas). */
function limpiarCacheMtd() {
  var cache = CacheService.getScriptCache();
  var meta = cache.get('meta::' + CACHE_MTD_CLAVE);
  var claves = ['meta::' + CACHE_MTD_CLAVE];
  if (meta) {
    for (var i = 0; i < Number(meta); i++) claves.push('t::' + CACHE_MTD_CLAVE + '::' + i);
  }
  cache.removeAll(claves);
  Logger.log('Caché de Ventas MTD limpiada.');
  return 'OK';
}

/* ---------- Lectura de cada hoja ---------- */

function mtdLeerCumplimiento_(libro) {
  var hoja = libro.getSheetByName(HOJA_MTD_CUMPLIMIENTO);
  if (!hoja) {
    throw new Error("No se encontró la hoja '" + HOJA_MTD_CUMPLIMIENTO + "' en el archivo de Ventas MTD. " +
                    'Hojas disponibles: ' + libro.getSheets().map(function(s) { return s.getName(); }).join(' | '));
  }

  var data = hoja.getDataRange().getValues();
  if (data.length < 2) return { filas: [], totales: null };

  var headers = data[0].map(mtdNorm_);
  var col = {
    sapId:    mtdColAlt_(headers, [[['sap id'], []], [['sap'], []]]),
    cliente:  mtdCol_(headers, ['cliente'], []),
    kam:      mtdCol_(headers, ['kam'], []),
    canal:    mtdCol_(headers, ['canal'], []),
    // 'Real -1 (LOCAL)' se busca ANTES que 'Real (LOCAL)' y se excluye de esta.
    realAnt:  mtdColAlt_(headers, [[['real', '-1'], ['plan']], [['anterior'], ['plan']]]),
    realMes:  mtdCol_(headers, ['real'], ['-1', 'anterior', 'plan', 'ano', 'anio']),
    planMes:  mtdCol_(headers, ['plan'], ['ano', 'anio']),
    cumpl:    mtdCol_(headers, ['cumpl'], []),
    realAnio: mtdColAlt_(headers, [[['real', 'ano'], ['plan']], [['real', 'anio'], ['plan']]]),
    planAnio: mtdColAlt_(headers, [[['plan', 'ano'], []], [['plan', 'anio'], []]])
  };

  var filas = [], tot = { realMes: 0, planMes: 0, realAnio: 0, planAnio: 0 }, ignoradas = 0;
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var cliente = mtdTexto_(row, col.cliente);
    var sapId   = mtdTexto_(row, col.sapId);
    if (!cliente && !sapId) continue;
    if (mtdEsFilaTotal_(cliente)) { ignoradas++; continue; }

    var realMes = mtdNum_(row, col.realMes);
    var planMes = mtdNum_(row, col.planMes);
    var pct = col.cumpl !== null ? mtdPct_(row[col.cumpl]) : null;
    if (pct === null) pct = planMes !== 0 ? realMes / planMes : null;   // respaldo calculado

    filas.push({
      sapId:           sapId,
      cliente:         cliente,
      kam:             mtdTexto_(row, col.kam),
      canal:           mtdTexto_(row, col.canal),
      realMes:         realMes,
      realMesAnterior: mtdNum_(row, col.realAnt),
      planMes:         planMes,
      cumplPct:        pct,
      realAnio:        mtdNum_(row, col.realAnio),
      planAnio:        mtdNum_(row, col.planAnio)
    });

    tot.realMes  += realMes;
    tot.planMes  += planMes;
    tot.realAnio += mtdNum_(row, col.realAnio);
    tot.planAnio += mtdNum_(row, col.planAnio);
  }

  return {
    filas: filas,
    totales: {
      realMes:  tot.realMes,
      planMes:  tot.planMes,
      cumplPct: tot.planMes !== 0 ? tot.realMes / tot.planMes : null,
      realAnio: tot.realAnio,
      planAnio: tot.planAnio
    },
    columnas: col,
    filasTotalIgnoradas: ignoradas
  };
}

function mtdLeerProductos_(libro) {
  var hoja = libro.getSheetByName(HOJA_MTD_PLANTILLA);
  if (!hoja) {
    Logger.log("AVISO: no existe la hoja '" + HOJA_MTD_PLANTILLA + "'; la tabla de productos irá vacía.");
    return { productos: [], columnas: null };
  }

  var data = hoja.getDataRange().getValues();
  if (data.length < 2) return { productos: [], columnas: null };

  // Encabezados reales de la fila 1, para verificar el mapeo desde el editor.
  Logger.log("Encabezados de '" + HOJA_MTD_PLANTILLA + "' (fila 1): " +
             data[0].map(function(h, i) { return (i + 1) + '=' + h; }).join(' | '));

  var headers = data[0].map(mtdNorm_);
  var col = {
    nombre:   mtdColAlt_(headers, [[['product'], []], [['nombre'], []], [['descripci'], []]]),
    ventaAnt: mtdColAlt_(headers, [[['real', '-1'], ['plan']], [['anterior'], ['plan']]]),
    // 'Real' es el importe original; 'Real (LOCAL)' y 'Real #' también contienen "real",
    // así que primero se exige coincidencia exacta y solo después se cae al parcial.
    ventaMes: (function() {
      for (var i = 0; i < headers.length; i++) {
        if (headers[i] === 'real') return i;
      }
      return mtdCol_(headers, ['real'],
        ['-1', 'anterior', 'plan', 'ano', 'anio', 'local', '#']);
    })(),
    unidades: mtdColAlt_(headers, [[['unidad'], []], [['unit'], []],
                                    [['real', '#'], ['-1', 'plan', 'ano', 'anio']]])
  };
  Logger.log('Mapeo PLANTILLA → nombre=' + col.nombre + ' ventaMes=' + col.ventaMes +
             ' ventaMesAnterior=' + col.ventaAnt + ' unidades=' + col.unidades +
             ' (null = columna no encontrada)');

  var productos = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var nombre = mtdTexto_(row, col.nombre);
    if (mtdEsFilaTotal_(nombre)) continue;

    var ventaMes = mtdNum_(row, col.ventaMes);
    var ventaAnt = mtdNum_(row, col.ventaAnt);
    var unidades = mtdNum_(row, col.unidades);
    if (!nombre && !ventaMes && !ventaAnt && !unidades) continue;

    productos.push({
      nombre:                nombre,
      ventaMes:              ventaMes,
      ventaMesAnterior:      ventaAnt,
      unidades:              unidades,
      deltaVsPctMesAnterior: ventaAnt !== 0 ? (ventaMes - ventaAnt) / ventaAnt : null
    });
  }

  // La hoja está a nivel cliente x producto (73 clientes x ~102 productos), no es un
  // catálogo: se consolida por nombre para que la tabla muestre una fila por producto.
  var agrupado = {};
  productos.forEach(function(p) {
    var k = p.nombre || '(sin nombre)';
    if (!agrupado[k]) {
      agrupado[k] = { nombre: k, ventaMes: 0, ventaMesAnterior: 0, unidades: 0 };
    }
    agrupado[k].ventaMes += p.ventaMes || 0;
    agrupado[k].ventaMesAnterior += p.ventaMesAnterior || 0;
    agrupado[k].unidades += p.unidades || 0;
  });
  var productosAgrupados = Object.keys(agrupado).map(function(k) {
    var x = agrupado[k];
    x.deltaVsPctMesAnterior = x.ventaMesAnterior !== 0
      ? (x.ventaMes - x.ventaMesAnterior) / x.ventaMesAnterior : null;
    return x;
  });

  Logger.log('Productos antes de agrupar: ' + productos.length +
             ' · después de agrupar: ' + productosAgrupados.length);

  return { productos: productosAgrupados, columnas: col };
}

/**
 * Datos del informe de Ventas MTD (cumplimiento por cliente y por KAM, más
 * productos). Devuelve un STRING JSON, igual que el resto de endpoints.
 */
function getVentasMtdJson() {
  var enCache = mtdCacheLeer_(CACHE_MTD_CLAVE);
  if (enCache) return enCache;

  var libro = SpreadsheetApp.openById(SPREADSHEET_ID_MTD);   // una sola apertura para las dos hojas
  var cumpl = mtdLeerCumplimiento_(libro);
  var prod  = mtdLeerProductos_(libro);

  var salida = {
    cumplimiento: {
      filas: cumpl.filas,
      totales: cumpl.totales || { realMes: 0, planMes: 0, cumplPct: null, realAnio: 0, planAnio: 0 }
    },
    productos: prod.productos,
    meta: {
      actualizadoEn:        new Date().toISOString(),
      totalFilasClientes:   cumpl.filas.length,
      totalFilasProductos:  prod.productos.length,
      hojaCumplimiento:     HOJA_MTD_CUMPLIMIENTO,
      hojaProductos:        HOJA_MTD_PLANTILLA,
      columnasProductos:    prod.columnas,
      filasTotalIgnoradas:  cumpl.filasTotalIgnoradas || 0
    }
  };

  var texto = JSON.stringify(salida);
  mtdCacheGuardar_(CACHE_MTD_CLAVE, texto, CACHE_MTD_SEGUNDOS);
  return texto;
}

/** Diagnóstico manual desde el editor: encabezados y primeras filas leídas. */
function verVentasMtd() {
  var d = JSON.parse(getVentasMtdJson());
  Logger.log('Clientes: ' + d.meta.totalFilasClientes + ' · Productos: ' + d.meta.totalFilasProductos);
  Logger.log('Totales: ' + JSON.stringify(d.cumplimiento.totales));
  Logger.log('Primera fila cliente: ' + JSON.stringify(d.cumplimiento.filas[0]));
  Logger.log('Primer producto: ' + JSON.stringify(d.productos[0]));
}