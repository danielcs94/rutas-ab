// Mapa vectorial (MapLibre GL + OpenFreeMap, sin API key) con estética de Apple Maps
// (ver mapstyle.js): nítido en pantallas retina y con zoom fluido.
// El trazado se colorea por superficie y lleva flechas con el sentido de la marcha.
/* global maplibregl */
import { DEFAULT_A } from './config.js';
import { appleStyle, LAND } from './mapstyle.js';

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const ll = ([lat, lon]) => [lon, lat]; // la app usa [lat, lon]; MapLibre, [lon, lat]

function el(cls, html, title) {
  const d = document.createElement('div');
  d.className = `pin ${cls}`;
  d.innerHTML = `<span>${html}</span>`;
  if (title) d.title = title;
  return d;
}

// Flecha para indicar el sentido de la ruta, dibujada en un canvas (sin imágenes externas).
function arrowImage() {
  const s = 32, c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const chevron = () => { g.beginPath(); g.moveTo(13, 10); g.lineTo(20, 16); g.lineTo(13, 22); g.stroke(); };
  g.fillStyle = '#ffffff';                                          // disco blanco con flecha oscura
  g.beginPath(); g.arc(16, 16, 14, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(0,0,0,.25)'; g.lineWidth = 1.5; g.stroke();
  g.strokeStyle = '#1a1a19'; g.lineWidth = 3.5; chevron();
  return g.getImageData(0, 0, s, s);
}

export function createMap(container, theme = 'light') {
  if (typeof maplibregl === 'undefined') throw new Error('MapLibre no se ha cargado');
  let current = theme;
  let route = null;          // ruta dibujada (para redibujar al cambiar de estilo)
  let markers = [];

  const map = new maplibregl.Map({
    container,
    // Estilo mínimo mientras se descarga y recolorea el de verdad
    style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': LAND[current] } }] },
    center: ll([DEFAULT_A.lat, DEFAULT_A.lon]),
    zoom: 14,
    attributionControl: { compact: true },
    dragRotate: false,
    pitchWithRotate: false,
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

  // Puntos A y B (se recolocan al cambiarlos en la interfaz)
  const markerA = new maplibregl.Marker({ element: el('pin-end pin-a', 'A', 'Salida') });
  const markerB = new maplibregl.Marker({ element: el('pin-end pin-b', 'B', 'Llegada') });
  const hoverMarker = new maplibregl.Marker({ element: el('pin-hover', '') });
  let hoverShown = false;
  let lastSize = [container.clientWidth, container.clientHeight];

  // La atribución empieza plegada (botón "i"); en móvil desplegada tapa media franja del mapa.
  map.once('load', () => container.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'));

  async function applyStyle() {
    const theme = current;
    const style = await appleStyle(theme);
    if (theme === current) map.setStyle(style, { diff: false }); // 'style.load' vuelve a añadir la ruta
  }
  applyStyle();

  function addRouteLayers() {
    map.addSource('route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addSource('arrows', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addSource('signals', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    if (!map.hasImage('route-arrow')) map.addImage('route-arrow', arrowImage(), { pixelRatio: 2 });

    map.addLayer({
      id: 'route-casing', type: 'line', source: 'route',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': cssVar('--map-casing'), 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 6, 17, 13] },
    });
    map.addLayer({
      id: 'route-line', type: 'line', source: 'route',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': ['match', ['get', 'cat'],
          'asfalto', cssVar('--series-2'), 'tierra', cssVar('--series-3'), cssVar('--series-1')],
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 3.5, 17, 8],
      },
    });
    map.addLayer({
      id: 'route-arrows', type: 'symbol', source: 'arrows',
      layout: {
        'icon-image': 'route-arrow', 'icon-rotate': ['get', 'rotate'],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 12, 0.8, 17, 1.2],
        'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-rotation-alignment': 'map',
      },
    });
    map.addLayer({
      id: 'signals', type: 'circle', source: 'signals', minzoom: 13,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 2.5, 17, 5],
        'circle-color': cssVar('--signal'),
        'circle-stroke-color': cssVar('--map-casing'), 'circle-stroke-width': 1.5,
      },
    });
  }

  function render() {
    for (const m of markers) m.remove();
    markers = [];
    if (!route || !map.getSource('route')) return;
    const c = route;

    // Un tramo por cada cambio de superficie
    const features = [];
    if (c.cats) {
      let start = 0;
      for (let i = 1; i <= c.samples.length; i++) {
        if (i === c.samples.length || c.cats[i] !== c.cats[start]) {
          const seg = c.samples.slice(start, Math.min(i + 1, c.samples.length)).map(ll);
          if (seg.length > 1) features.push({ type: 'Feature', properties: { cat: c.cats[start] }, geometry: { type: 'LineString', coordinates: seg } });
          start = i;
        }
      }
    } else {
      features.push({ type: 'Feature', properties: { cat: 'parque' }, geometry: { type: 'LineString', coordinates: c.coords.map(ll) } });
    }
    map.getSource('route').setData({ type: 'FeatureCollection', features });
    // Flechas de sentido a mitad de cada km (500 m, 1,5 km…), entre los marcadores de km.
    const arrows = [];
    for (let i = 25; i < c.samples.length - 2; i += 50) {
      const [a, b] = [c.samples[i - 1], c.samples[i + 1]];
      const bearing = (Math.atan2((b[1] - a[1]) * Math.cos((a[0] * Math.PI) / 180), b[0] - a[0]) * 180) / Math.PI;
      arrows.push({ type: 'Feature', properties: { rotate: bearing - 90 }, geometry: { type: 'Point', coordinates: ll(c.samples[i]) } });
    }
    map.getSource('arrows').setData({ type: 'FeatureCollection', features: arrows });
    map.getSource('signals').setData({
      type: 'FeatureCollection',
      features: (c.signalPoints ?? []).map((p) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: ll(p) } })),
    });

    const add = (element, at) => markers.push(new maplibregl.Marker({ element }).setLngLat(ll(at)).addTo(map));
    // Kilómetros
    const perKm = Math.round(1000 / 20);
    for (let k = 1; k * perKm < c.samples.length - perKm / 3; k++) add(el('pin-km', k, `Km ${k}`), c.samples[k * perKm]);
    // Lugares por los que pasa
    for (const a of c.anchorPoints ?? []) add(el('pin-place', '', a.name), a.at);
    // Puntos de paso A, B, C (los mismos del enlace de Google Maps)
    (c.urlPoints ?? []).forEach((p, i) => add(el('pin-wp', i + 1, `Punto de paso ${i + 1}`), p));
  }

  map.on('error', (e) => console.warn('Mapa:', e.error?.message ?? e));

  map.on('style.load', () => {
    addRouteLayers();
    render();
  });

  let clickHandler = null;
  map.on('click', (e) => clickHandler?.(e.lngLat.lat, e.lngLat.lng));

  return {
    map,
    // Coloca los marcadores A y B (sin B: bucle, solo A)
    setEndpoints(A, B, { fit = false } = {}) {
      if (A) markerA.setLngLat(ll([A.lat, A.lon])).addTo(map); else markerA.remove();
      if (B) markerB.setLngLat(ll([B.lat, B.lon])).addTo(map); else markerB.remove();
      if (!fit || !A) return;
      if (B) {
        const b = new maplibregl.LngLatBounds(ll([A.lat, A.lon]), ll([A.lat, A.lon])).extend(ll([B.lat, B.lon]));
        map.fitBounds(b, { padding: 80, maxZoom: 15, duration: 500 });
      } else {
        map.easeTo({ center: ll([A.lat, A.lon]), zoom: Math.max(map.getZoom(), 13), duration: 500 });
      }
    },
    onClick(cb) { clickHandler = cb; },
    setPicking(on) { map.getCanvas().style.cursor = on ? 'crosshair' : ''; },
    setTheme(theme) {
      if (theme === current) return;
      current = theme;
      applyStyle();
    },
    draw(c) {
      route = c;
      // Los colores salen de los tokens CSS: se actualizan al redibujar
      if (map.getLayer('route-line')) {
        map.setPaintProperty('route-casing', 'line-color', cssVar('--map-casing'));
        map.setPaintProperty('route-line', 'line-color', ['match', ['get', 'cat'],
          'asfalto', cssVar('--series-2'), 'tierra', cssVar('--series-3'), cssVar('--series-1')]);
      }
      render();
    },
    fit(c) {
      const narrow = window.matchMedia('(max-width: 860px)').matches;
      const bounds = c.coords.reduce((b, p) => b.extend(ll(p)), new maplibregl.LngLatBounds(ll(c.coords[0]), ll(c.coords[0])));
      lastSize = [container.clientWidth, container.clientHeight];
      map.resize();
      map.fitBounds(bounds, { padding: narrow ? 28 : 56, duration: 500 });
    },
    hover(latlng) {
      if (!latlng) { hoverMarker.remove(); hoverShown = false; return; }
      hoverMarker.setLngLat(ll(latlng));
      if (!hoverShown) { hoverMarker.addTo(map); hoverShown = true; }
    },
    // Solo si el contenedor cambió de tamaño: resize() cancela la animación de encuadre en curso.
    invalidate() {
      const { clientWidth: w, clientHeight: h } = container;
      if (w === lastSize[0] && h === lastSize[1]) return;
      lastSize = [w, h];
      map.resize();
    },
  };
}
