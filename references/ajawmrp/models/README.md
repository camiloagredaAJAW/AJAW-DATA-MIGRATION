# AJAWMRP / Axelor model references

Este directorio guarda XMLs de modelos AJAWMRP/Axelor como referencia para los agentes. No representa código compilado ni publicado automáticamente.

## Estructura

| Directorio | Uso |
|------------|-----|
| `existing/` | XMLs de modelos que ya existen en AJAWMRP y pueden ser consultados como referencia. |
| `proposed/` | XMLs de modelos nuevos o cambios sugeridos por agentes, pendientes de revisión/publicación manual. |

## Flujo recomendado

1. Colocar modelos actuales en `existing/`.
2. Si un agente necesita un modelo nuevo, debe proponerlo en `proposed/`.
3. Vos revisás, llevás el XML a AJAWMRP, compilás y publicás.
4. Cuando esté disponible, se mueve o copia la versión final a `existing/`.

## Regla importante

Los agentes pueden usar estos archivos para entender contratos y proponer modelos, pero AJAWMRP sigue siendo la fuente operativa real de esos modelos.
