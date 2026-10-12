# Compatibilidad y plan de pruebas

## Estado de verificación

| Qué | Cómo se verificó | Estado |
|---|---|---|
| Protocolo, reloj, línea de tiempo, deriva, historial, pista de calibración | Pruebas unitarias (`swift test --package-path Core`) en GitHub Actions (macOS) | Automatizado |
| Compilación de la app iOS | `xcodebuild` para simulador en GitHub Actions | Automatizado |
| Reproducción real en dos parlantes Bluetooth | Requiere dos dispositivos iOS físicos y dos parlantes | **Pendiente: no probado en hardware** |

El simulador de iOS no tiene Bluetooth, así que la prueba de audio real
**solo** se puede hacer en dispositivos físicos. No hay ningún dispositivo ni
parlante que se haya probado todavía: la lista de compatibilidad de abajo es
lo que se espera según la documentación de Apple, no un resultado medido.

## Requisitos

| Elemento | Requisito |
|---|---|
| Emisor | iPhone con iOS 16 o posterior |
| Receptor | Otro iPhone, iPad o iPod touch con iOS/iPadOS 16 o posterior |
| Parlantes | Cualquier parlante Bluetooth A2DP (uno emparejado a cada dispositivo) |
| Red | Mismo WiFi, o ambos dispositivos cerca con WiFi y Bluetooth activados (WiFi directo entre dispositivos Apple) |
| Audio | Archivos propios en la app Archivos (MP3, M4A/AAC, WAV, AIFF, FLAC, ALAC) |
| Modo AirPlay 2 | Parlantes con AirPlay 2 |

**No compatible:** Spotify, Apple Music y otros servicios con DRM; receptores
Android (el protocolo está documentado para implementarlo en el futuro).

## Pruebas manuales en dispositivos

Anota en cada prueba los modelos de los dispositivos y los parlantes.

### 1. Conexión básica
1. Empareja el parlante A con el iPhone emisor y el parlante B con el receptor.
2. En el receptor: DualSound › Receptor. Acepta el permiso de **Red local**.
3. En el emisor: DualSound › Emisor. Acepta el permiso de **Red local**.
4. Toca "Seleccionar parlante 2" y elige el receptor.
   - ✅ El receptor aparece "Conectado" y muestra el nombre del parlante B.
   - ✅ "Reloj (ida y vuelta)" muestra un valor (normalmente < 10 ms).

### 2. Sincronía con la pista de calibración
1. Emisor › "Pista de calibración (clics)" › Reproducir.
2. Coloca los dos parlantes juntos y escucha.
   - ✅ Ambos suenan unos 0,8 s después de tocar Reproducir.
   - ✅ El indicador muestra "Sincronizado" (error < 5 ms).
3. Si se oye un doble clic, ajusta el retardo del parlante que suena antes con
   "+" (5 ms por toque) hasta oír un solo clic. Anota el valor.
   - Diferencias de latencia entre marcas de 20–100 ms son normales.

### 3. Archivo de música
1. "Elegir archivo de audio…" y elige un MP3 o M4A.
2. Reproduce, pausa y reanuda varias veces.
   - ✅ Al reanudar, sigue desde donde quedó en ambos parlantes.
   - ✅ Al terminar la canción, ambos se detienen.

### 4. Estabilidad a largo plazo
1. Reproduce la pista de calibración 30 minutos.
   - ✅ No aparece eco. "Corrección de velocidad" en el receptor se mantiene
     dentro de ±0,2 %.

### 5. Recuperación ante fallas
| Acción | Resultado esperado |
|---|---|
| Apagar el WiFi del receptor 5 s y volver a encenderlo | El emisor muestra "Reconectando…" y luego vuelve a "Conectado". El receptor vuelve a sonar sincronizado. |
| Cerrar DualSound en el receptor y volver a abrirlo en modo Receptor | Igual que arriba. |
| Apagar el parlante B | El receptor muestra la nueva salida (altavoz) y avisa. Al volver a conectar el parlante se reprograma solo. |
| Recibir una llamada en el emisor | El audio se interrumpe y aparece un aviso. Pulsa Reproducir para continuar. |
| Alejar el receptor hasta que el WiFi sea débil | Pueden aparecer "Bloques que llegaron tarde" (silencios cortos), sin desfase permanente. |

### 6. Modo AirPlay 2 (si tienes parlantes AirPlay 2)
1. DualSound › AirPlay 2 › elige un archivo.
2. "Elegir parlantes AirPlay" y marca dos parlantes.
   - ✅ Ambos aparecen en "Salidas activas" y suenan juntos.

## Registro de compatibilidad (completar al probar)

| Emisor | Receptor | Parlante 1 | Parlante 2 | Retardo calibrado | Resultado |
|---|---|---|---|---|---|
| — | — | — | — | — | Sin pruebas todavía |
