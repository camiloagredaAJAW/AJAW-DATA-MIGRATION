## Base de datos de Leads

La base de datos de leads será el banco de consulta de registros que serán transportados hacia AXELOR (Ajawmrp) donde quedarán finalmente alojados.

> **Solo empresas.** El origen de datos actual únicamente expone leads de tipo empresa (endpoint `/companies`). El dominio de persona (LinkedinSearch/LinkedinSearchResults) no está contemplado con este origen de datos.

### Autenticación

Hasta el momento no requiere autenticación para consultar los datos.

### Endpoints de Base de datos de Leads

Los endpoints se construyen combinando la variable de entorno de la url de base de datos de leads `<LEADS_DB_BASE_URL>` con:

- `<LEADS_DB_ALL>` (`dbs`): devuelve la lista de países disponibles. Se usa **solo** para obtener las claves de `countries` — el objeto `databases` de esta misma respuesta ya no se utiliza (quedó obsoleto junto con el modelo anterior de db/table).
- `<LEADS_DB_EXPORT>` (`companies`): devuelve los leads de empresa a persistir en Axelor, paginados por país.

Ejemplo conceptual para `<LEADS_DB_ALL>`:

```text
{LEADS_DB_BASE_URL}/{LEADS_DB_ALL}
```

Ejemplo resultante:

```text
http://76.13.98.70:8080/dbs
```

Ejemplo conceptual para `<LEADS_DB_EXPORT>`:

```text
{LEADS_DB_BASE_URL}/{LEADS_DB_EXPORT}
```

Ejemplo resultante:

```text
http://76.13.98.70:8080/companies
```

### Petición GET para obtener la lista de países

La petición `<LEADS_DB_ALL>` requiere el query parameter `key=<LEADS_DB_QP_KEY_VALUE>` como identificador del conjunto de datos.

Ejemplo para `<LEADS_DB_ALL>` `dbs` con `<LEADS_DB_QP_KEY_VALUE>` `ajaw_live_2026`:

```text
http://76.13.98.70:8080/dbs?key=ajaw_live_2026
```

La respuesta devuelve los países dentro de `countries` (clave = código de país ISO, valor = slug interno del origen, ya no usado). **Se debe iterar únicamente sobre las claves de `countries`** (`AR`, `BO`, `BR`, `CL`, `CO`, `CR`, `DO`, `EC`, `GT`, `HN`, `MX`, `NI`, `PA`, `PE`, `PY`, `SV`, `UY`), no sobre sus valores ni sobre el objeto `databases` (obsoleto).

```json
{
    "countries": {
        "AR": "ar",
        "BO": "bo",
        "BR": "brazil_cnpj",
        "CL": "cl",
        "CO": "colombia_rues",
        "CR": "cr",
        "DO": "do",
        "EC": "ec",
        "GT": "gt",
        "HN": "hn",
        "MX": "mexico_denue",
        "NI": "ni",
        "PA": "pa",
        "PE": "pe",
        "PY": "py",
        "SV": "sv",
        "UY": "uy"
    },
    "databases": { "...": "obsoleto, ya no se utiliza" }
}
```

### Petición GET para obtener los leads de empresa

La petición de leads de empresa (`<LEADS_DB_EXPORT>` = `companies`) requiere esta lista de query parameters:

`<LEADS_DB_QP_KEYS>`: `country` | `has_phone` | `has_email` | `key` | `format` | `limit` | `offset`

Ejemplo:

```text
http://76.13.98.70:8080/companies?country=BR&has_phone=1&has_email=1&key=ajaw_live_2026&format=jsonl&limit=50&offset=0
```

#### Query parameters

- `country`: código de país (clave de `countries`, ej. `AR`, `BR`, `CO`), se va recorriendo uno por uno.
- `has_phone` y `has_email`: banderas fijas en `1` — solo interesan leads con teléfono y email presentes. No configurables por ahora.
- `key`: se debe mantener el mismo `<LEADS_DB_QP_KEY_VALUE>`.
- `format`: mantener el valor `jsonl`.
- `limit`: número máximo de registros a obtener en la petición. Para la paginación real de la migración, este valor se toma de la variable de entorno `LEADS_DB_PAGE_LIMIT`. Para el sondeo/mapeo de campos se usa un valor fijo de `3`.
- `offset`: desplazamiento para paginación. Empieza en `0` para la página 1; para cada página siguiente, `offset = offset + limit`:
    - Página 1: `?limit=50&offset=0` (trae los primeros 50).
    - Página 2: `?limit=50&offset=50` (salta los primeros 50 y trae los 50 siguientes).
    - Página 3: `?limit=50&offset=100` (salta los primeros 100 y trae los 50 siguientes).

#### Responses Base de datos de Leads

La forma de la respuesta puede variar levemente según el país, pero todos comparten el mismo endpoint `/companies`.

Ejemplo:

```text
http://76.13.98.70:8080/companies?country=BR&has_phone=1&has_email=1&key=ajaw_live_2026&format=jsonl&limit=3&offset=0
```

```json
{"cnpj": "07571801000156", "cnpj_basico": "07571801", "legal_name": "CONDOMINIO RESIDENCIAL JACUBA", "trade_name": "", "status": "ATIVA", "activity_code": "8112500", "share_capital": 0.0, "address": "RUA FRANCISCO JOAO CARDOSO 377", "neighborhood": "JD NOVA HORTOLANDIA", "city": "2951", "state": "SP", "postal_code": "13183282", "phone": "1922162989", "phone2": "", "email": "JACUBA.ADM@LEGITIMACONDOMINIAL.COM.BR", "sector": "ADMIN", "porte_code": "05", "company_size": "MEDIANA_GRANDE", "legal_form_code": "3085", "country": "BR"}
{"cnpj": "07573551000193", "cnpj_basico": "07573551", "legal_name": "ASSOCIACAO DA AGRICULTURA FAMILIAR E ECONOMIA SOLIDARIA PARA MELHORIA DO ANTEIRO - AMA", "trade_name": "AMA", "status": "ATIVA", "activity_code": "9430800", "share_capital": 0.0, "address": "POVOADO DO ANTEIRO S/N FAZ. ANTEIRO-BATUQUE", "neighborhood": "SAO JOAO DA VITORIA", "city": "3965", "state": "BA", "postal_code": "45111000", "phone": "7788047538", "phone2": "", "email": "ALMEIDABEATRIZ785@YAHOO.COM", "sector": "OTHER", "porte_code": "05", "company_size": "MEDIANA_GRANDE", "legal_form_code": "3999", "country": "BR"}
{"cnpj": "47508411117932", "cnpj_basico": "47508411", "legal_name": "COMPANHIA BRASILEIRA DE DISTRIBUICAO", "trade_name": "PAO DE ACUCAR - SUPERMERCADO", "status": "ATIVA", "activity_code": "4711302", "share_capital": 2511174034.76, "address": "AVENIDA REPUBLICA DO LIBANO 2079 QUADRAD4                  LOTE  53E", "neighborhood": "SETOR OESTE", "city": "9373", "state": "GO", "postal_code": "74125125", "phone": "1140040010", "phone2": "", "email": "PARALEGAL@GRUPOPAODEACUCAR.COM.BR", "sector": "RETAIL", "porte_code": "05", "company_size": "MEDIANA_GRANDE", "legal_form_code": "2046", "country": "BR"}
```

> Nota: algunos países pueden devolver 0 registros en un momento dado — el origen expone "solo las bases ya scrapeadas en la sesión actual", igual que antes. `city` puede venir como un código numérico interno (no el nombre de la ciudad) dependiendo del país — confirmar caso por caso durante el mapeo.

Se debería hacer un sondeo (muestreo con `limit=3`) por cada país para mapear los datos contra Axelor (Ajawmrp).
