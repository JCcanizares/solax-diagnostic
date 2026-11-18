# Diagnóstico SolaX (X3-MIC/PRO G2)

Panel en tiempo real que lee el Pocket WiFi por la red local, sin pasar por SolaX Cloud.

## Requisitos
Node.js 18 o superior. Sin dependencias: no hace falta `npm install`.

## Uso
```bash
node server.js
```
Abre http://localhost:8080 e introduce la IP del dongle y su número de registro en el formulario de conexión.
La app prueba la conexión antes de guardarla. Para cambiarla después, usa el botón «Conexión».

Si marcas «Recordar en este equipo», los datos se guardan en `config.json` (texto plano, excluido en `.gitignore`).

Opcional por línea de comandos o variables de entorno: `--ip` / `SOLAX_IP`, `--pwd` / `SOLAX_PWD`,
`--interval 3000` / `SOLAX_INTERVAL`, `--port 8080` / `SOLAX_PORT`.
Para probar la interfaz sin el inversor: `node server.js --mock`.

Para verlo en el móvil, abre `http://IP-DEL-PC:8080` con el móvil en la misma WiFi.

## Qué muestra
- Producción AC, red (+ exporta / − importa) y consumo calculado (producción − red).
- Avisos cuando el consumo sale negativo o la exportación supera la producción.
- Prueba de carga: marca el inicio, enciende un aparato y compara cuánto cambian red y consumo.
- Cada sesión guarda todas las lecturas y marcas en `logs/solax-FECHA.csv`.

## Notas
- Mapa de datos del tipo 16: github.com/nazar-pc/solax-local-api-docs (Data2.txt).
- La potencia de red es el total de las tres fases; la API local no da el valor del contador por fase.
- No bajes mucho el intervalo: el dongle es un dispositivo limitado y además tiene que seguir subiendo datos a SolaX Cloud.
# solax-diagnostic
