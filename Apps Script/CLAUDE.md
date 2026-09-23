# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Qué es este directorio

Proyecto de Google Apps Script (clasp) vinculado a la hoja de cálculo **"MAESTRO PDV's"** (`1fILFlz4cO4mmW-oOnhTuewCicoWJ8bzFUUAN30GaewI`). El directorio padre (`Bricks CO/`) tiene su propio CLAUDE.md con el pipeline Python que genera los bricks — leerlo antes de tocar nada relacionado con bricks.

**Contiene DOS proyectos lógicos en el mismo contenedor de script; no mezclarlos:**

1. **Web app "Visor PDV + Bricks"** — `Code.js` + `Index.html`. Dashboard para un **Gerente de Zona** (equipo de visitadores / merch), no un explorador de datos genérico: las decisiones que debe soportar son de cobertura y priorización de PDV. Leaflet sin frameworks sobre base CARTO Voyager (sobria, con calles y nombres de ciudad, sin depender de la API de pago de Google). Layout de 3 columnas: filtros · mapa · panel de análisis con pestañas, más una franja de KPIs en el header.
   - **Regla de layout que NO se debe romper**: el dashboard mide `100vh` y **cada panel hace scroll por dentro** (`min-height:0` en los hijos del grid + `overflow-y:auto` en el panel). Nada de contenido apilado en el flujo de la página. Antes la lista de PDV y la tabla resumen se apilaban debajo del mapa y la página llegaba a 2.400px de alto, con el resumen fuera de pantalla — inservible como dashboard. Si se agrega una sección nueva, va **dentro** de un panel existente (o como pestaña), nunca al final del `<body>`.
   - **Traducción de términos**: el CRM es de Salesforce (Europa) y usa palabras que no son las que se usan en Colombia. Las etiquetas visibles ya están traducidas (dato interno sin tocar, solo la etiqueta): "Región" → **Departamento**, "Población" → **Ciudad**, "Grupo de compras" → **Cliente**, "NIF/CIF" → **NIT**. Si aparece un campo nuevo del CRM, revisar si necesita el mismo tratamiento antes de mostrarlo tal cual.
   - **`Conectados`** es un supuesto sin confirmar: cuenta PDV con `ID Cliente SAP` diligenciado (no hay un campo "conectado" explícito en el CRM). **`Visitados`** cuenta PDV con `Delegado` (columna "Delegado Name") asignado — no hay fecha de última visita en los datos, así que es la única señal de cobertura disponible. Ajustar en `dibujarTabla()` y `actualizarKpis()` (Index.html) si el significado de negocio real es otro.
2. **Herramientas de menú de la hoja** — `Menú Principal.js`, `Módulo Cruce de Datos.js`, `Módulo Geocodificación.js`, `Módulo Centros Médicos.js`. Proyecto aparte (menú "🛠️ Herramientas Datos": geocodificación, cruce CRM vs Sell Out, buscador de centros médicos). **No modificarlos al trabajar en el visor**; solo cuidar que no haya colisiones de nombres de funciones globales (todo comparte el mismo scope global de GAS).

## Geocodificación: cómo se obtiene el Código Postal

En Colombia la Geocoding API **casi nunca devuelve `postal_code` en `results[0]` de una búsqueda por dirección**: las direcciones tipo "Calle 30, Barranquilla" resuelven a nivel de vía (`types=route`) o de negocio (`establishment`), y una vía entera atraviesa varios códigos postales, así que Google no le adjunta ninguno. Por eso la hoja llegó a tener 4.202 filas con "Geocodificación OK" y **cero** códigos postales. El CP sí existe: hay que pedirlo por coordenada.

`resolverCodigoPostal_()` va en cascada y para en cuanto encuentra algo:
1. barre **todos** los `results` y todos sus `address_components` de la respuesta que ya se tiene (el CP suele venir en un result de menor granularidad, no en el primero);
2. reverse geocode con `result_type=postal_code` sobre lat/lng — **este es el que resuelve la mayoría**;
3. reverse geocode completo, por si el CP viaja dentro de un result de otro tipo (se salta si la llamada primaria ya era un reverse).

Detalles que no se deben romper:
- La columna **Postal Code se fuerza a formato texto (`@`)**: el CP colombiano tiene 6 dígitos y muchos empiezan por cero (Antioquia `05xxxx`, Atlántico `08xxxx`); como número, Sheets se come el cero inicial.
- Una fila **sin CP no cuenta como terminada** en el chequeo de "saltar fila completa". Antes el CP no entraba en esa condición y las filas ya geocodificadas se saltaban para siempre, así que ninguna corrida posterior las podía arreglar.
- Cuando Google realmente no tiene CP para el punto, se escribe `NOTA_CP_NO_DISPONIBLE` en Notas y esa fila no se reintenta en las siguientes corridas (si no, cada corrida vuelve a gastar cuota en las mismas filas imposibles). Para reintentarlas: `FORZAR_REINTENTO_CP = true` durante una corrida.
- Si solo hay `postal_code_prefix`, se guarda marcado como aproximado en Notas (`ACEPTAR_PREFIJO_POSTAL`).
- `region=co` + `components=country:CO`: sin eso Google puede resolver una dirección colombiana en otro país.
- `REQUEST_DENIED` **corta la corrida** con el `error_message` de Google (clave, API no habilitada, restricción de referrer) en vez de escribir el mismo error en miles de filas.

Rendimiento (el script se ejecutaba fila a fila y no cabía en los 6 min de Apps Script):
- Lectura y escritura **en bloque**. La columna **Dirección Completa es una fórmula** y no se toca; **Enlace Google Maps lleva RichText** y se escribe celda a celda solo cuando hay enlace nuevo.
- `completarCodigosPostales()` (menú "🏷️ Completar solo Código Postal") es la vía para las filas que ya tienen coordenadas: solo llena el CP, en lotes paralelos de `LOTE_FETCH` con `UrlFetchApp.fetchAll()`.
- Todas las funciones cortan a `MINUTOS_MAXIMOS_EJECUCION` (5), vuelcan lo hecho y avisan cuántas filas quedan; la siguiente corrida retoma sola gracias a la lógica de saltar filas completas.
- `diagnosticarCodigoPostal()` (menú "🔎") pide una dirección o `lat,lng` y muestra qué devolvió Google en cada paso de la cascada, sin escribir en la hoja. Es lo primero que hay que correr si alguien reporta que falta un CP.

## Buscador de Centros Médicos: por qué usa dos APIs de Google en cascada

`Módulo Centros Médicos.js` (hoja `buscador de Centros Médicos`: `Pais`, `Dirección`, `Nombre Centro médico`) resuelve el nombre del centro médico/consultorio en una dirección. No existe ninguna lista propia de centros médicos en el proyecto, así que es un problema de búsqueda, no de cruce de datos:

1. **Geocoding API** resuelve `"<Dirección>, <Pais>"` a una coordenada. A diferencia de `Módulo Geocodificación.js`, aquí **no se fija `region=co`**: el país es un dato de cada fila (la columna existe justo para eso), no una constante del proyecto.
2. **Places API (Nearby Search, legacy — no "Places API (New)")** busca alrededor de esa coordenada, en un radio de `RADIO_BUSQUEDA_CM_METROS` (150 m), y se queda con el resultado más cercano cuyo tipo esté en `TIPOS_LUGAR_SALUD_CM` (`hospital`, `doctor`, `dentist`, `physiotherapist`; se excluye `pharmacy` a propósito — una droguería no es un centro médico). El filtro por tipo se aplica **en el cliente sobre un solo Nearby Search sin `type`**, no con una búsqueda por tipo: la Places API solo acepta un `type` por request, y pagar 4 búsquedas por fila para cubrir los 4 tipos habría multiplicado el costo.

Si falta país o dirección, si Google no geocodifica, o si no hay ningún lugar de salud dentro del radio, la celda se deja vacía — nunca se inventa un dato. Como no hay columna de estado (no se pidió), una fila vacía no distingue "no procesada" de "procesada sin resultado": volver a ejecutar la herramienta reintenta (y vuelve a cobrar) esas filas. Sí hay una caché en memoria por corrida (clave `país|dirección` normalizada con `normalizarTexto_`) para no pagar dos veces la misma dirección repetida en varias filas.

Costo: Places API Nearby Search es una API aparte de Geocoding, con su propio costo por búsqueda (más caro que un geocode) — hay que habilitarla en el mismo proyecto de Google Cloud que la `GOOGLE_MAPS_API_KEY` antes de usar esta herramienta con volumen.

### Las columnas se localizan por encabezado, no por número fijo

**Incidente real (2026-08-11)**: la hoja de direcciones tenía las columnas hardcodeadas por número (`COL.LATITUD = 6`, etc.). El usuario insertó una columna "Departamento" en medio del esquema para enriquecer la fórmula de Dirección Completa, y todo lo que venía después se corrió un lugar — si el script hubiera corrido con el mapeo viejo, habría escrito la latitud encima de la fórmula de Dirección Completa, la longitud encima de la Latitud, etc. en toda fila nueva que procesara.

Arreglo: `resolverColumnas_(sheet)` lee la fila de encabezados al inicio de cada corrida y ubica cada columna por su nombre normalizado (`NOMBRES_COLUMNA`), devolviendo `{ COL, IDX, numColumnas }` (`COL` base 1 para `getRange`, `IDX` base 0 para arrays de `getValues()`). Se pasa como parámetro a todo lo que necesita columnas — `forzarFormatoTexto_`, `escribirSalida_`, `escribirEnlacesMaps_`, `guardarDireccionNormalizada_` — nada depende de un número de columna fijo ni de que las columnas sean contiguas. Insertar/mover una columna ya no rompe nada; **falta** una columna esperada sí sigue siendo un error (mensaje claro con el nombre del encabezado que no encontró).

`escribirSalida_` ya no asume bloques contiguos: escribe cada columna de `CLAVES_ESCRIBIBLES` por separado, una llamada `setValues` por columna (todas las filas de una vez), en la posición real que resolvió `resolverColumnas_`.

Pruebas locales de la lógica pura (sin GAS): se carga el archivo en un contexto `vm` de Node con stubs de `UrlFetchApp`/`SpreadsheetApp`, y una hoja falsa (`crearHojaFake`) parametrizada por un array de encabezados — incluye el caso exacto del incidente (encabezados con "Departamento" insertado) para que no se repita en silencio.

## Deploy

- El usuario ejecuta `clasp push` **manualmente** — no pushear desde Claude.
- Tras un push, la URL de producción de la web app **sigue sirviendo la versión desplegada anterior**: hay que crear una nueva versión del deployment (Implementar → Administrar implementaciones → editar → nueva versión) o probar con la URL `/dev` (implementación de prueba), que siempre sirve el código más reciente. Si "no se ve nada" tras un cambio, revisar esto primero.
- `appsscript.json`: web app con `executeAs: USER_DEPLOYING`, `access: DOMAIN`, V8.

## Arquitectura del visor

**Esta sección se reescribió el 2026-09-21 porque describía una versión anterior del visor (pre-migración a JSON de Drive) que ya no existe en el código — verificar siempre contra `Code.js`/`Index.html` antes de confiar en identificadores citados aquí; si algo no aparece con `grep`, esta sección quedó desactualizada de nuevo.**

- `doGet()` sirve `Index.html`. El frontend hace **cinco llamadas paralelas** por `google.script.run`: `getPuntosJson()`, `getBricksJson()`, `getVentasJson()`, `getPortafolioJson()` y `getAsignacionesJson()`. Cada una marca su propio flag en `listo{}` (Index.html) y `boot()`/`actOverlay()` esperan a que las cinco terminen.
- **Todos los endpoints devuelven strings JSON (`JSON.stringify`), nunca objetos**: la serialización de objetos grandes/anidados de `google.script.run` es lenta y falla en silencio. El cliente hace `JSON.parse`. Mantener este patrón al agregar un endpoint nuevo.
- Las columnas se localizan por fragmento de encabezado en minúsculas (`buscarCol_`), no por índice fijo — las hojas son export de Salesforce y los nombres pueden variar levemente o traer un prefijo tipo `"Cuenta: Nombre de la cuenta"`.
- `parseNum_()` tolera números nativos, coma decimal ("4,7447"), separadores de miles y espacios; descarta NaN. `normalizarPos_()` es la función de normalización de POS_ID (mayúsculas, sin espacios, `:`→`_`) — es la clave de cruce entre PDV, ventas (Drive) y asignaciones (hoja `Asignacion`).
- Colores de bricks por ciudad (paleta categórica validada, orden fijo — no reordenar ni agregar tonos inventados): BOGOTA `#2a78d6`, MEDELLIN `#008300`, CALI `#e87ba4`, CARTAGENA `#eda100`, BARRANQUILLA `#8b5cf6`. Ciudad nueva → siguiente slot de la paleta del skill dataviz.
- `Index.html` funciona también fuera de GAS (abre con datos mock si `google.script` no existe) — **así se revisa el layout sin desplegar**: ver "Cómo ver el visor" abajo.
- Filtros cruzados: `filtros{}` es un objeto plano (no array — un solo valor por dimensión, `'TODOS'` = sin filtro), evaluado por `pasa(p,ig)` (`ig` es la dimensión a ignorar, para que cada dropdown cuente opciones sin excluirse a sí mismo). Cada filtro de PDV (grupo, canal, región, población, potencial, brick, PDV, agente, BU, SKU) es un `<input type="text">` + `<div class="smart-dropdown">` — buscador con cross-filtering, sin acentos (`normTxt`), motor centralizado en `opcionesDropdown()`/`renderDropdown()`/`seleccionarOpcion()`. Agregar un filtro nuevo: sumar su caso a `pasa()`, a `opcionesDropdown()`, al arreglo de `llenarDropdowns()` y su bloque HTML (mismo patrón que `brick`/`agente`). No hay `<select>` salvo el período (`preset`) y "Colorear por" (`modoColor`), fuera de este patrón a propósito.
- **Tamaño de los puntos**: el radio es ∝ **raíz** de la venta (`Math.sqrt`) para que el *área*, no el radio, represente la magnitud — sin eso los círculos grandes dominan visualmente de más. No hay reescalado por zoom todavía (los markers se recrean en cada `actualizar()`).
- Clic en un brick del mapa: además de abrir el popup (`popupBrick()`), el `click` del layer llama `aplicarFiltroBrick(brickId)` — filtra el mapa a ese brick **inmediatamente**, sin que haga falta abrir el popup y pulsar un botón. Como Leaflet ya generó el popup con el contenido de *antes* de filtrar (su propio listener de `bindPopup` corre primero), el handler lo refresca con `capa.setPopupContent(popupBrick(b))` justo después de filtrar. El botón "Ver portafolio del brick" dentro del popup sigue existiendo para abrir el detalle; el botón "Ver solo PDV de este brick" (`filtrarPorBrick`, variante que además cierra el popup) queda como confirmación redundante-pero-inofensiva para cuando el filtro ya se aplicó solo con el clic.
- `brickCrm` (texto libre que trae el CRM en `Ubicación: Brick`) **no se normaliza** contra la hoja `Bricks` en el backend actual — se usa tal cual llega. El brick real de cada PDV para filtros/agregados es el geométrico (`p._brick`, calculado en el cliente con punto-en-polígono, ver `asignarBricks()`/`pip()` en Index.html), no `brickCrm`.
- La hoja **`Asignacion`** (columnas: `Delegado: Delegado Name`, `Cuenta: Id cuenta 18`, `Cuenta: Nombre de la cuenta`, `Cuenta: Tipo de registro de cuenta`, `Team`, `Nº Oficina Farmacia`) asigna un VM o un LAM a cada PDV. `getAsignacionesJson()` (Code.js) la cruza por `Nº Oficina Farmacia` normalizado y devuelve `{pdv: {POS_ID: [{delegado,team,tipo,cuentaId,cuentaNombre}, ...]}}` — **arreglo**, no un solo objeto, porque un mismo PDV puede tener más de una fila (p. ej. un VM y un LAM a la vez). En el cliente, `asignacionesG` + `asignacionesDe(p)`/`tieneAgente(p)`/`marcaAgenteTxt(p)`/`marcaAgenteHtml(p)` (Index.html) alimentan el ícono 👤 junto al nombre del PDV (popups y listas) y el filtro "Agente / Delegado" (`filtros.agente`, mismo patrón que `brick`/`pdv` en `pasa()`).

## Estilo visual: emular Zebra BI (regla general)

Toda métrica o visual nuevo en este dashboard (tarjetas KPI, gráficas de barras, badges) debe seguir el lenguaje visual de **Zebra BI** (add-in de Power BI/Excel, estilo IBCS): alta densidad de información, cero elementos decorativos.
- Etiquetas de valor **directas** sobre la barra/punto, nunca depender de un eje o leyenda aparte (`pintarBarras()` ya sigue esto — mantenerlo al agregar gráficas).
- Tarjetas KPI **compactas**: poco padding, tipografía pequeña, sin sombras ni bordes gruesos; un acento de color va como franja lateral fina (`border-left`), no como recoloreo de toda la tarjeta (ver `.kpi`/`.kpi.modo-prod`).
- Color **con significado**, nunca decorativo: la paleta semáforo (`SEM`) ya existe para esto — no introducir colores nuevos que no codifiquen alto/medio/bajo/brecha/selección.
- Tipografía sans-serif chica, números con `font-variant-numeric:tabular-nums` (alineación de dígitos).
- Nada de 3D, gradientes ni iconografía decorativa — el único ícono admitido hoy es 👤 (`badge-agente`) para cobertura de agente, con significado, no decoración.

## Cómo ver el visor sin desplegar (revisión visual)

`Index.html` se abre directo en el navegador: si no existe `google.script`, entra en modo mock y se puede evaluar el layout completo. **Revisar en el navegador antes de dar por bueno un cambio de UI** — problemas como el solapamiento de puntos o el layout que crece a 2.400px no se ven leyendo el código.

En esta máquina el **depurador remoto de Chrome está bloqueado por política corporativa** ("DevTools remote debugging is disallowed by the system admin"), así que Puppeteer/Playwright **no funcionan** (fallan con "browser is already running", incluso con `userDataDir` propio). Lo que sí funciona es el modo screenshot nativo:

```bash
"/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --disable-gpu \
  --no-sandbox --hide-scrollbars --window-size=1440,900 --virtual-time-budget=6000 \
  --screenshot="salida.png" "file:///c:/ruta/a/Index.html"
```

Limitación: captura solo el viewport y **no permite interactuar**. Para ver un estado que requiere clic (pestaña, filtro desplegado, zoom), copiar el HTML a un scratch y parchear el arranque (p. ej. cambiar la llamada final a `cambiarVista('pdv')`, o `toggleMs('grupo')` con un `setTimeout`) — nunca tocar el archivo real. Para probar densidad, inyectar un mock grande (~500 PDV agrupados en centros urbanos reales, no uniformes: la distribución importa para juzgar el solapamiento).

## Hojas relevantes del spreadsheet

- **`CO_Puntos_Maestro clientes`** (~4.740 filas de datos reales; la cuadrícula aparenta 126k filas pero están vacías). Export de Salesforce. Columnas clave: `Id cuenta 18`, `Nombre de la cuenta`, `Chain: Grupo de compras Name`, `Channel 2`, `Ubicación: Región: Region Name`, `Ubicación: Población`, `Ubicación: Calle` + `Ubicación: Número/Piso`, `Brick Ubicación` (texto libre del CRM, no confiable — a veces trae el `brick_id` corto en vez del nombre), `Ubicación: Coordenadas (Latitud)`/`(Longitud)`, `Units YTD`, `Delegado: Delegado Name` (agregada 2026-08; nombre del delegado/visitador asignado). Las dos columnas `Fecha de creación` se llaman igual (duplicadas).
- **`Bricks`** — espejo de la hoja Bricks de `Colombia_Bricks.xlsx` del proyecto padre (162 bricks: `brick_id`, `nombre`, `zona`, `ciudad`, `departamento`, `nombre_brick`, centroides, bounding box, `geometria_geojson`). No editarla a mano: se regenera con `python unificar_bricks.py` en el directorio padre y se vuelve a pegar/importar.
- **`buscador de Centros Médicos`** — `Pais`, `Dirección`, `Nombre Centro médico`. La llena `buscarCentrosMedicos()` (menú "🏥"); ver "Buscador de Centros Médicos" arriba.

`datos_sheets/` contiene **snapshots CSV locales** de esas dos hojas (UTF-8, tomados 2026-07-17 vía MCP de Google Sheets) para tener contexto sin llamar a la API. Son copias de referencia, no fuente de verdad — el visor siempre lee del spreadsheet en vivo.

## Cómo inspeccionar el spreadsheet

Hay dos servidores MCP de Google Sheets conectados (`gsheets-oauth` y `mcp-gsheets`). Para volúmenes grandes (miles de filas), delegar la lectura a subagentes para no inundar el contexto; los CSV de `datos_sheets/` suelen bastar.
