# Mapa de Cobertura Estratégica — ISDIN Colombia

Proyecto de Google Apps Script (GIS + BI) que visualiza la cobertura comercial de ISDIN en Colombia (Bogotá, Medellín, Cali) cruzando **bricks/zonas geográficas**, **maestro de puntos de venta (PDV)** y **datos de Sell Out**, con un semáforo de rendimiento por zona y detección de brechas de oportunidad.

## ¿Qué es esto?

El proyecto es un único proyecto de Apps Script (gestionado con [`clasp`](https://github.com/google/clasp)) atado a una hoja de Google Sheets. Dentro conviven **dos superficies independientes que comparten la misma hoja**:

1. **Visor web (mapa interactivo)** — `Code.js` (backend) + `Index.html` (frontend con [Leaflet](https://leafletjs.com/)). Muestra los bricks como polígonos coloreados por un semáforo de Sell Out (ponderado por volumen, no por promedio simple) y superpone los puntos de venta como marcadores interactivos con KPIs en el tooltip.
2. **Herramientas de datos sobre la hoja** — `Menú Principal.js` agrega el menú personalizado `🛠️ Herramientas Datos` en la hoja de cálculo. Desde ahí se ejecutan los módulos que geocodifican, limpian y cruzan la información antes de que llegue al visor.

No hay build step, ni tests, ni linter: es JavaScript puro para el runtime de Apps Script, y Leaflet se carga por CDN dentro de `Index.html`.

## Estructura del proyecto

```
Mapa_Cobertura_Estrategica/
├── Index.html                       # Frontend del visor (mapa Leaflet + KPIs)
├── Code.js                          # Backend del visor (doGet, endpoints JSON)
├── Menú Principal.js                # Menú "🛠️ Herramientas Datos" en la hoja
├── Módulo Geocodificación.js        # Geocoding, códigos postales, asignación de bricks
├── Módulo Cruce de Datos.js         # Reconciliación CRM ↔ Sell Out
├── Módulo Centros Médicos.js        # Búsqueda de centros médicos cercanos (Places API)
├── appsscript.json                  # Manifest del proyecto de Apps Script
├── .clasp.json                      # Configuración de clasp (scriptId del proyecto)
└── CLAUDE.md                        # Guía técnica detallada para trabajar en el código
```

`CLAUDE.md` documenta a fondo las convenciones internas (contrato de datos, límites de ejecución de Apps Script, lógica del semáforo, etc.) — es la referencia técnica más completa del repo.

## Contrato de datos (la hoja de Google Sheets)

Ambas superficies leen las mismas pestañas:

| Pestaña | Contenido | Columnas clave |
| --- | --- | --- |
| `Bricks` | Polígonos de zona | `brick_id`, `geometria_geojson`, `nombre_brick`, `ciudad`, `zona` |
| `CO_Puntos_Maestro clientes` | Maestro de puntos de venta | `Latitud`, `Longitud`, `Nº Oficina Farmacia` (clave de cruce), `Potencial Cliente`, `Channel` |
| `Sell Out 2026` | Ventas mensuales | `Fecha`, `POS_ID`, `BU`, `Units`, `Amount` |

El cruce entre fuentes se hace por `POS_ID` (Sell Out) ↔ `Nº Oficina Farmacia` (maestro de PDV), normalizando mayúsculas y espacios.

## Lógica de negocio (BI)

- **Semáforo de rendimiento por brick**: se calcula por **cuartiles del Sell Out ponderado por volumen**, no por promedio simple — Q1 o menos = muy bajo (rojo), hasta Q2 = bajo (naranja), hasta Q3 = medio (amarillo), el resto = alto (verde).
- **Brechas de oportunidad**: cruzando densidad comercial de la zona contra la distribución ponderada de la marca, para priorizar dónde debería enfocarse la fuerza de ventas.
- **Roadmap (Fase 2)**: dejar la arquitectura lista para incorporar prescripciones médicas de competencia y un índice de precios competitivos (basado en los productos de mayor rotación).

## Cómo desplegar / trabajar en el proyecto

El proyecto se sincroniza con el editor de Apps Script mediante `clasp`:

```bash
clasp login          # una sola vez, con la cuenta de Google dueña del script
clasp push           # sube los archivos locales al proyecto de Apps Script
clasp pull           # descarga la versión publicada (sobreescribe lo local)
clasp open           # abre el proyecto en el editor de Apps Script
clasp deployments    # lista los despliegues del web app
```

La API key de Google Maps (`GOOGLE_MAPS_API_KEY`) vive en **Script Properties** dentro del proyecto de Apps Script, nunca en el código.

## Estado actual

- Visor y herramientas de datos funcionando sobre la hoja de cálculo maestra.
- Semáforo por cuartiles y asignación de PDV a bricks (por CRM o por punto-en-polígono) implementados.
- Próximos pasos: scoring de brechas de oportunidad por cohorte y diseño del índice de precios competitivos (Fase 2).

## Autor

Sebastián González — Trade Marketing / Analítica Comercial, ISDIN Colombia.
