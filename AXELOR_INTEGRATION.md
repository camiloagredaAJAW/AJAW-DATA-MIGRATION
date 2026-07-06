## Integración con Axelor

Axelor será el dueño de la persistencia funcional. Este backend no debe transformarse en una segunda fuente de verdad.

### Autenticación contra Axelor

La integración inicial contempla autenticación mediante endpoint `login.jsp` usando Basic Auth. El header `Authorization` no debe guardarse como valor estático: debe construirse a partir de `AXELOR_USERNAME` y `AXELOR_PASSWORD`, siguiendo la norma de uso de autenticación básica HTTP para REST API.

```bash
curl --location --request POST '<AXELOR_BASE_URL>/login.jsp' \
  --header 'Authorization: Basic <base64(AXELOR_USERNAME:AXELOR_PASSWORD)>' \
  --data ''
```

| Campo | Valor |
|-------|-------|
| Método | `POST` |
| URL | `<AXELOR_BASE_URL>/login.jsp` |
| Auth | `Authorization: Basic base64(AXELOR_USERNAME:AXELOR_PASSWORD)` |
| Body | Vacío |
| Uso esperado | Obtener o inicializar sesión/autenticación para llamadas posteriores a modelos Axelor. |

Después del login, las siguientes peticiones a la REST API de AJAWMRP deben enviar:

- `Authorization: Basic base64(AXELOR_USERNAME:AXELOR_PASSWORD)`
- Cookie de sesión extraída de la respuesta del login, por ejemplo: `CSRF-TOKEN=<value>; JSESSIONID=<value>; TENANTID=<value>`

> Nota: no debe commitearse una credencial real, token o cookie en documentación o código. La especificación SDD deberá definir cómo se inyectan estas credenciales por ambiente y cómo se renueva la cookie de sesión.

### Construcción de endpoints REST Axelor/AJAWMRP

Los endpoints REST de modelos AJAWMRP se construyen combinando el namespace configurado y el nombre del modelo.

Las referencias base para estas peticiones serán:

- REST estándar Axelor ADK 7.1: `https://docs.axelor.com/adk/7.1/dev-guide/web-services/rest.html`
- Servicios avanzados Axelor ADK 7.1: `https://docs.axelor.com/adk/7.1/dev-guide/web-services/advanced.html`

| Variable | Propósito |
|----------|-----------|
| `AJAW_NAMESPACE` | Namespace base de los modelos AJAWMRP. |
| `MODEL_NAME_COMPANIES` | Nombre del modelo de leads tipo empresa. |
| `MODEL_NAME_PEOPLE` | Nombre del modelo de leads tipo persona. |

Ejemplo conceptual para `AiSearchResults`:

```text
ws/rest/{AJAW_NAMESPACE}.{MODEL_NAME_COMPANIES}
```

Ejemplo resultante:

```text
ws/rest/com.ajawmrp3.apps.prospectingai.db.AiSearchResults
```

### Operaciones REST estándar de Axelor

Según la documentación oficial de Axelor ADK 7.1, los servicios REST estándar siguen estos patrones:

| Operación | Método | Patrón |
|-----------|--------|--------|
| Buscar/listar registros | `GET` | `/ws/rest/:model?offset=0&limit=10` |
| Leer un registro | `GET` | `/ws/rest/:model/:id` |
| Crear un registro | `PUT` | `/ws/rest/:model` |
| Actualizar un registro | `POST` | `/ws/rest/:model/:id` |
| Eliminar un registro | `DELETE` | `/ws/rest/:model/:id` |

Para creación y actualización, el payload debe enviarse dentro de la propiedad `data`.

```json
{
  "data": {
    "fieldName": "value"
  }
}
```

Para actualización, Axelor requiere enviar el número de `version` del registro para evitar modificaciones conflictivas.

```json
{
  "data": {
    "id": 1,
    "version": 1,
    "fieldName": "new-value"
  }
}
```

Las respuestas exitosas usan `status: 0` y devuelven los registros dentro de `data`.

### Operaciones avanzadas de Axelor

Axelor también expone servicios avanzados para casos donde REST puro no alcanza.

| Operación | Método | Patrón | Uso esperado |
|-----------|--------|--------|--------------|
| Lectura parcial | `POST` | `/ws/rest/:model/:id/fetch` | Leer campos específicos y relaciones. |
| Eliminación masiva | `POST` | `/ws/rest/:model/removeAll` | Eliminar múltiples registros con `id` y `version`. |
| Búsqueda avanzada | `POST` | `/ws/rest/:model/search` | Buscar con `_domain`, `_domainContext` o `criteria`. |
| Ejecución de acciones | `POST` | `/ws/action` | Ejecutar acciones XML o métodos de controlador. |

La búsqueda avanzada será el patrón principal para consultar modelos con filtros dinámicos, como `InstagramAccount` por `instagramState`.

Ejemplo de filtro con `_domain`:

```json
{
  "offset": 0,
  "limit": 10,
  "fields": ["id", "aiSearch", "title", "categoryName", "address", "neighborhood", "street", "city", "postalCode", "state", "countryCode", "phoneUnformatted", "permanentlyClosed", "openingHours", "website", "additionalInfo", "description", "descriptionMd", "slug", "email"],
  "sortBy": ["-id"],
  "data": {
    "_domain": "self.title=:companyName",
    "_domainContext": {
      "companyName": "<company-name>"
    }
  }
}
```

La búsqueda avanzada también soporta `criteria` anidados con operadores como `and`, `or`, `not`, `=`, `!=`, `like`, `between`, `isNull` y `notNull`.


### Ejemplo ingreso de data padre Lead empresa

```bash
curl --location --request PUT 'https://salesai-dev.ajawmrp.com/ws/rest/com.ajawmrp3.apps.prospectingai.db.AiSearch' \
--header 'Content-Type: application/json' \
--header 'Authorization: Basic <base64(AXELOR_USERNAME:AXELOR_PASSWORD)>' \
--header 'Cookie: CSRF-TOKEN=<csrf-token>; JSESSIONID=<session-id>; TENANTID=<tenant-id>' \
--data '{
  "data": {
        "statusSelect": "1",
        "searchString": "aesthetic clinics",
        "resultsNumber": 0
  }
} '
```

Respuesta esperada:

```json
{
    "status": 0,
    "data": [
        {
            "processInstanceId": null,
            "importOrigin": null,
            "updatedBy": null,
            "updatedOn": null,
            "createdOn": "2026-07-03T18:43:31.578028Z",
            "version": 0,
            "attrs": null,
            "$wkfStatus": null,
            "statusSelect": 1,
            "resultsNumber": 0,
            "searchString": "aesthetic clinics",
            "importId": null,
            "createdBy": {
                "code": "Super.Admin",
                "fullName": "super admin",
                "id": 2,
                "$version": 492
            },
            "id": 1,
            "selected": false
        }
    ]
}
```

Tener en cuenta que el `data.id` se debe obtener para usarlo en la petición de ingreso de data en el lead de tipo empresa

### Ejemplo de ingreso de registro lead tipo empresa



```bash
curl --location --request PUT 'https://salesai-dev.ajawmrp.com/ws/rest/com.ajawmrp3.apps.prospectingai.db.AiSearchResults' \
--header 'Content-Type: application/json' \
--header 'Authorization: Basic <base64(AXELOR_USERNAME:AXELOR_PASSWORD)>' \
--header 'Cookie: CSRF-TOKEN=<csrf-token>; JSESSIONID=<session-id>; TENANTID=<tenant-id>' \
--data '{
  "data": {
        "title": "AESTHETIC MEDICAL CENTER",
        "categoryName": "Medical office",
        "address": "PACIFICMALL #Piso 11, Santa Monica Residential, Cali, Valle del Cauca, Colombia",
        "neighborhood": "Santa Monica Residential",
        "street": "PACIFICMALL #Piso 11",
        "city": "Cali",
        "postalCode": "000000",
        "state": "Valle del Cauca",
        "countryCode": "CO",
        "phoneUnformatted": "+573153139472",
        "permanentlyClosed": "null",
        "openingHours": "[{\"day\":\"Monday\",\"hours\":\"Closed\"},{\"day\":\"Tuesday\",\"hours\":\"1 to 5 PM\"},{\"day\":\"Wednesday\",\"hours\":\"Closed\"},{\"day\":\"Thursday\",\"hours\":\"Closed\"},{\"day\":\"Friday\",\"hours\":\"Closed\"},{\"day\":\"Saturday\",\"hours\":\"Closed\"},{\"day\":\"Sunday\",\"hours\":\"Closed\"}]",
        "website": "https://sites.google.com/view/draleidyarizamedicoestetico/inicio",
        "additionalInfo": "{\"From the business\":[{\"Identifies as women-owned\":true}],\"Accessibility\":[{\"Assistive hearing loop\":true},{\"Wheelchair accessible entrance\":true},{\"Wheelchair accessible parking lot\":true},{\"Wheelchair accessible restroom\":true},{\"Wheelchair accessible seating\":true}],\"Amenities\":[{\"Gender-neutral restroom\":true}]}",
        "error":"null",
        "errorDescription":"null",
        "description": "",
        "descriptionMD": "",
        "aiSearch":{
            "id":1
        }
  }
} '
```
Recuerda que `data.aiSearch.id` debe recibir el id del registro padre

Respuesta esperada:

```json
{
    "status": 0,
    "data": [
        {
            "importOrigin": null,
            "errorDescription": "null",
            "city": "Cali",
            "postalCode": "000000",
            "description": "",
            "error": "null",
            "title": "AESTHETIC MEDICAL CENTER",
            "categoryName": "Medical office",
            "createdOn": "2026-07-03T19:01:13.975504Z",
            "phoneUnformatted": "+573153139472",
            "permanentlyClosed": "null",
            "countryCode": "CO",
            "street": "PACIFICMALL #Piso 11",
            "descriptionMd": null,
            "additionalInfo": "{\"From the business\":[{\"Identifies as women-owned\":true}],\"Accessibility\":[{\"Assistive hearing loop\":true},{\"Wheelchair accessible entrance\":true},{\"Wheelchair accessible parking lot\":true},{\"Wheelchair accessible restroom\":true},{\"Wheelchair accessible seating\":true}],\"Amenities\":[{\"Gender-neutral restroom\":true}]}",
            "id": 1,
            "state": "Valle del Cauca",
            "email": null,
            "selected": false,
            "slug": "/1/aesthetic-medical-center",
            "processInstanceId": null,
            "website": "https://sites.google.com/view/draleidyarizamedicoestetico/inicio",
            "address": "PACIFICMALL #Piso 11, Santa Monica Residential, Cali, Valle del Cauca, Colombia",
            "updatedBy": {
                "code": "Super.Admin",
                "fullName": "super admin",
                "id": 2,
                "$version": 493
            },
            "updatedOn": "2026-07-03T19:01:14.029267Z",
            "version": 1,
            "aiSearch": {
                "id": 1,
                "$version": 0
            },
            "attrs": null,
            "$wkfStatus": null,
            "importId": null,
            "createdBy": {
                "code": "Super.Admin",
                "fullName": "super admin",
                "id": 2,
                "$version": 493
            },
            "openingHours": "[{\"day\":\"Monday\",\"hours\":\"Closed\"},{\"day\":\"Tuesday\",\"hours\":\"1 to 5 PM\"},{\"day\":\"Wednesday\",\"hours\":\"Closed\"},{\"day\":\"Thursday\",\"hours\":\"Closed\"},{\"day\":\"Friday\",\"hours\":\"Closed\"},{\"day\":\"Saturday\",\"hours\":\"Closed\"},{\"day\":\"Sunday\",\"hours\":\"Closed\"}]",
            "neighborhood": "Santa Monica Residential"
        }
    ]
}
```


### Ejemplo de búsqueda de lead tipo empresa

Para consultar un lead tipo empresa con un nombre específico, el backend deberá ejecutar una petición `search` sobre el modelo `AiSearchResults`.

```bash
curl --location 'https://salesai-dev.ajawmrp.com/ws/rest/com.ajawmrp3.apps.prospectingai.db.AiSearchResults/search' \
  --header 'Content-Type: application/json' \
  --header 'Authorization: Basic <base64(AXELOR_USERNAME:AXELOR_PASSWORD)>' \
  --header 'Cookie: JSESSIONID=<session-id>; TENANTID=<tenant-id>' \
  --data '{
    "limit": 1,
    "fields": [
      "id", 
      "title", 
      "categoryName",
      "address",
      "neighborhood",
      "street",
      "city",
      "postalCode",
      "state",
      "countryCode",
      "phoneUnformatted",
      "openingHours",
      "website",
      "additionalInfo",
      "description",
      "descriptionMd",
      "createdOn"
    ],
    "sortBy": ["-createdOn"],
    "data": {
      "_domain": "self.aiSearch.id = :aiSerachId",
      "_domainContext": {
        "aiSerachId": "<aisearch-id>"
      }
    }
  }'
```

Respuesta esperada:

```json
{
    "status": 0,
    "offset": 0,
    "total": 2,
    "data": [
        {
            "website": "https://sites.google.com/view/draleidyarizamedicoestetico/inicio",
            "address": "PACIFICMALL #Piso 11, Santa Monica Residential, Cali, Valle del Cauca, Colombia",
            "city": "Cali",
            "postalCode": "000000",
            "description": "",
            "title": "AESTHETIC MEDICAL CENTER",
            "version": 0,
            "categoryName": "Medical office",
            "createdOn": "2025-05-16T16:56:09.873086Z",
            "phoneUnformatted": "+573153139472",
            "$wkfStatus": null,
            "street": "PACIFICMALL #Piso 11",
            "countryCode": "CO",
            "descriptionMd": null,
            "additionalInfo": "{\"Amenities\": [{\"Gender-neutral restroom\": true}], \"Accessibility\": [{\"Assistive hearing loop\": true}, {\"Wheelchair accessible entrance\": true}, {\"Wheelchair accessible parking lot\": true}, {\"Wheelchair accessible restroom\": true}, {\"Wheelchair accessible seating\": true}], \"From the business\": [{\"Identifies as women-owned\": true}]}",
            "openingHours": "[{\"day\": \"Monday\", \"hours\": \"Closed\"}, {\"day\": \"Tuesday\", \"hours\": \"1 to 5\u202fPM\"}, {\"day\": \"Wednesday\", \"hours\": \"Closed\"}, {\"day\": \"Thursday\", \"hours\": \"Closed\"}, {\"day\": \"Friday\", \"hours\": \"Closed\"}, {\"day\": \"Saturday\", \"hours\": \"Closed\"}, {\"day\": \"Sunday\", \"hours\": \"Closed\"}]",
            "id": 20,
            "neighborhood": "Santa Monica Residential",
            "state": "Valle del Cauca"
        },
        {
            "website": "https://sites.google.com/view/draleidyarizamedicoestetico/inicio",
            "address": "PACIFICMALL #Piso 11, Santa Monica Residential, Cali, Valle del Cauca, Colombia",
            "city": "Cali",
            "postalCode": "000000",
            "description": "",
            "title": "AESTHETIC MEDICAL CENTER",
            "version": 0,
            "categoryName": "Medical office",
            "createdOn": "2025-05-16T16:54:42.166565Z",
            "phoneUnformatted": "+573153139472",
            "street": "PACIFICMALL #Piso 11",
            "countryCode": "CO",
            "descriptionMd": null,
            "additionalInfo": "{\"Amenities\": [{\"Gender-neutral restroom\": true}], \"Accessibility\": [{\"Assistive hearing loop\": true}, {\"Wheelchair accessible entrance\": true}, {\"Wheelchair accessible parking lot\": true}, {\"Wheelchair accessible restroom\": true}, {\"Wheelchair accessible seating\": true}], \"From the business\": [{\"Identifies as women-owned\": true}]}",
            "openingHours": "[{\"day\": \"Monday\", \"hours\": \"Closed\"}, {\"day\": \"Tuesday\", \"hours\": \"1 to 5\u202fPM\"}, {\"day\": \"Wednesday\", \"hours\": \"Closed\"}, {\"day\": \"Thursday\", \"hours\": \"Closed\"}, {\"day\": \"Friday\", \"hours\": \"Closed\"}, {\"day\": \"Saturday\", \"hours\": \"Closed\"}, {\"day\": \"Sunday\", \"hours\": \"Closed\"}]",
            "id": 19,
            "neighborhood": "Santa Monica Residential",
            "state": "Valle del Cauca"
        }
    ]
}
```

El backend debe tratar `additionalInfo` y `openingHours` son campos de tipo jsonb por tanto el json a guardar en estos campos debe ser convertido a string