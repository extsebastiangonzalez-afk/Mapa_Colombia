# -*- coding: utf-8 -*-
"""
Plantilla de configuración del ETL de Sell Out — ISDIN Colombia.

Este archivo SÍ se sube a GitHub. Para usarlo:
  1. Cópialo como config.py en esta misma carpeta:
       Windows:    copy config.example.py config.py
       Mac/Linux:  cp config.example.py config.py
  2. Ajusta las rutas de config.py a tu equipo.
  3. No subas config.py a GitHub (contiene rutas locales): agrégalo al .gitignore.

Después revisa que el mapeo de columnas sea correcto con:
  python etl_sellout.py --inspect
"""

# ---------------------------------------------------------------------------
# Rutas
# ---------------------------------------------------------------------------

# Archivo .xlsm que produce el paso 3 del Sell Out (base consolidada).
# Usa r"..." para que las barras invertidas de Windows no se interpreten.
RUTA_EXCEL = r"C:\Users\TU_USUARIO\Documents\Sell Out\Paso 3\SellOut_Paso3.xlsm"

# Carpeta donde se dejan los JSON generados. Debe estar dentro de Google Drive
# (Drive para escritorio) para que la web app los lea. Se crea si no existe.
CARPETA_SALIDA = r"G:\Mi unidad\ISDIN\Sell Out\datos_web"

# ---------------------------------------------------------------------------
# Lectura del Excel
# ---------------------------------------------------------------------------

# Nombre de la hoja con los datos. None = primera hoja del libro.
NOMBRE_HOJA = None

# Número de fila (empezando en 1) donde están los encabezados.
# Todas las filas posteriores se tratan como datos.
FILA_ENCABEZADOS = 1

# ---------------------------------------------------------------------------
# Salida
# ---------------------------------------------------------------------------

# Número de archivos so_detalle_NN.json en que se reparte el detalle
# PDV × SKU × mes. Cada PDV cae siempre en el mismo fragmento (hash de su
# POS_ID), así la web app solo descarga el fragmento del PDV que consulta.
N_FRAGMENTOS = 16

# ---------------------------------------------------------------------------
# Mapeo de columnas
# ---------------------------------------------------------------------------
# Para cada campo del ETL, lista de fragmentos candidatos (en minúsculas) que se
# buscan en los encabezados del Excel. Reglas de búsqueda:
#   - Los encabezados se comparan sin tildes y en minúsculas; "_", "-", "." y
#     "/" cuentan como espacio ("POS_ID" equivale a "pos id").
#   - Primero se buscan coincidencias EXACTAS para todos los campos y luego
#     coincidencias PARCIALES (el encabezado contiene el fragmento).
#   - Los fragmentos de 3 letras o menos ("bu", "pos", "sku") solo coinciden
#     como palabra completa, para no confundir "bu" con "distribuidor".
#   - Dentro de cada lista gana el primer candidato que encuentre columna:
#     ordénalos del más específico al más genérico.
#   - Una columna no se asigna a dos campos.
# Verifica el resultado con: python etl_sellout.py --inspect
COLUMNAS = {
    # Fecha de la venta (datetime, serial de Excel, d/m/yyyy o yyyy-mm-dd).
    "fecha": ["fecha", "date", "fecha venta", "periodo", "mes"],
    # Código del punto de venta. Se normaliza a mayúsculas y sin espacios.
    "pos_id": ["pos_id", "pos id", "id pos", "codigo pdv", "cod pdv", "id pdv", "pos"],
    # Nombre o descripción del punto de venta.
    "pdv_desc": ["pos_desc", "pos desc", "pos name", "nombre pdv", "desc pdv", "punto de venta", "pdv"],
    # Unidad de negocio (BU).
    "bu": ["bu", "business unit", "unidad de negocio", "unidad negocio"],
    # Código del producto.
    "sku": ["sku", "cod producto", "codigo producto", "material", "cod material", "ean"],
    # Descripción del producto.
    "prod_desc": ["prod_desc", "prod desc", "desc producto", "descripcion producto", "producto", "descripcion"],
    # Familia o marca del producto.
    "familia": ["familia", "family", "marca", "brand"],
    # Unidades vendidas.
    "units": ["units", "unidades", "cantidad", "qty"],
    # Importe (valor) de la venta.
    "amount": ["amount", "importe", "valor venta", "venta neta", "ventas", "valor"],
}

# Campos sin los cuales una fila se descarta (se cuentan en so_manifiesto.json).
# "fecha" y "pos_id" son siempre necesarios aunque se quiten de esta lista.
OBLIGATORIOS = ["fecha", "pos_id", "amount"]
