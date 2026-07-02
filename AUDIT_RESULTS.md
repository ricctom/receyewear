# Auditoría de códigos REC Eyewear — título vs. foto

Método: por cada producto se lee la imagen y se compara el código del título con el
código que aparece grabado/impreso en la foto.

Leyenda: ✅ coincide · ❌ NO coincide (foto es de otro modelo) · ⚠️ sin código visible / genérica

---

## Lavanett (12 productos — 9 MAL, 3 bien)

| Título | Foto muestra | Estado |
|---|---|---|
| 1200 | 1210 | ❌ → foto es 1210 |
| 1201 | 1218 | ❌ → foto es 1218 |
| 1202 | 1200 | ❌ → foto es 1200 |
| 1203 | 1213 | ❌ → foto es 1213 |
| 1205 | 1205 | ✅ |
| 1207 | 1202 | ❌ → foto es 1202 (duplicada con 1213) |
| 1208 | 1208 | ✅ |
| 1209 | 1209 | ✅ |
| 1210 | 1203 | ❌ → foto es 1203 (duplicada con 1214) |
| 1213 | 1202 | ❌ → foto es 1202 (duplicada con 1207) |
| 1214 | 1203 | ❌ → foto es 1203 (duplicada con 1210) |
| 1218 | 1207 | ❌ → foto es 1207 |

**Ojo:** ninguna foto muestra realmente el 1201 ni el 1214 (sus fotos están repetidas de otros modelos). Faltan esas dos fotos reales.

## ⚠️ Fotos DUPLICADAS detectadas (mismo archivo, 2 productos)
- `lav_1207.jpeg` = `lav_1213.jpeg` (las dos muestran 1202)
- `lav_1210.jpeg` = `lav_1214.jpeg` (las dos muestran 1203)

---

## Kids — CRUZADO total (nombre de línea + código)

Confirmado el problema Runflex↔Rubbers, pero además los códigos no coinciden.

**"Runflex Kids" (la foto dice "Rubbers" con OTRO código):**
| Título web | Foto real |
|---|---|
| Runflex Kids 9001 | Rubbers 8297 |
| Runflex Kids 9002 | Rubbers 503 |
| Runflex Kids 9013 | Rubbers 8279 |
| Runflex Kids 9017 | Rubbers 8251 |
| Runflex Kids 9021 | Rubbers 8294 |
| Runflex Kids 9022 | Rubbers 8197 |
| Runflex Kids 9023 | Rubbers 8142 |
| Runflex Kids 9024 | Rubbers 891 |
| Runflex Kids Cat01 | Rubbers 825 |
| Runflex Kids 1063 | Runflex 1063 ✅ (único bien) |

**"Rubber Kids" (la foto dice "Runflex"):**
| Título web | Foto real |
|---|---|
| Rubber Kids 503 | Rubbers 8310 |
| Rubber Kids 891 | Runflex 9017 |
| (resto pendiente) | |

**Patrón:** los archivos `kids_*` contienen fotos de **Rubbers**, y los `rubber_*` contienen fotos de **Runflex**. Alguien cruzó los nombres de archivo. Las líneas están invertidas en toda la categoría Kids.
