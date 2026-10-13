# Rutas A→B

Mi versión personal de [Rutas Noviciado](https://github.com/danielcs94/rutas-noviciado). En vez de
salir y volver siempre al mismo sitio, aquí eliges un punto de salida y uno de llegada, y la app te
inventa una ruta para correr entre los dos, de hasta 42 km. Si no pones llegada, hace un bucle desde
la salida.

Los puntos se pueden buscar por dirección, marcar tocando el mapa o, para la salida, usar tu ubicación.
Hay atajos para las distancias de siempre: 5, 10, 15, media maratón, 30 y 42.

## Cómo se inventa la ruta

Con A y B como focos dibujo una elipse. Cualquier camino que vaya de A a un punto de la elipse y de
ahí a B mide lo mismo en línea recta, así que el tamaño de la elipse decide la distancia. Sobre ella
coloco 2 o 3 puntos de paso al azar, por un lado o por el otro del camino directo, y le pido a
Valhalla la ruta a pie que pasa por ellos. Luego ajusto el tamaño hasta que la ruta real queda justo
por debajo de los kilómetros pedidos.

Se generan cuatro rutas distintas y se queda la que mejor encaja con la intensidad elegida. Antes de
nada mide el camino más corto entre A y B: si pides menos que eso, te avisa de cuál es el mínimo.

## De dónde salen los datos

A diferencia de la versión de Noviciado, aquí no hay nada precalculado, porque la ruta puede ir a
cualquier parte. Todo lo da Valhalla en directo:

- `route` para las rutas a pie, prefiriendo paseos peatonales y caminos de tierra.
- `height` para el desnivel.
- `trace_attributes` para saber de cada tramo si es calle, sendero o tierra, y si tiene semáforo.

Las direcciones se buscan con Nominatim, de OpenStreetMap.

## Ejecutarla

```bash
python3 tools/serve.py 5182
```

Y abrir http://localhost:5182. Antes de publicar cambios, `python3 tools/release.py`.

## Límites

Una ruta de 42 km tarda unos 30 segundos en salir, porque los servidores gratuitos no dejan hacer
muchas peticiones seguidas. A veces un punto de paso cae en un sitio sin acceso a pie y esa ruta se
descarta o se calcula con OSRM. Fuera del centro de Madrid las rutas no llevan nombre de lugares
conocidos, solo "salida → llegada".
