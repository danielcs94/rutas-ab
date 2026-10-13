// Servicios cartográficos abiertos (sin API key):
//   · Valhalla (FOSSGIS): rutas a pie, altitud del trazado (/height) y atributos de cada
//     tramo (/trace_attributes: tipo de vía, superficie y semáforos)
//   · OSRM (FOSSGIS): rutas a pie de reserva si Valhalla falla
//   · Nominatim (OpenStreetMap): buscar direcciones y nombrar puntos del mapa
import { decodePolyline, encodePolyline } from './geo.js';

const VALHALLA = 'https://valhalla1.openstreetmap.de';
const OSRM_URL = 'https://routing.openstreetmap.de/routed-foot/route/v1/driving/';
const NOMINATIM = 'https://nominatim.openstreetmap.org';

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const memo = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// AbortSignal.timeout no existe antes de iOS 16: equivalente con AbortController.
function timeoutSignal(ms) {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

// Cola por host: los servidores públicos penalizan ráfagas de peticiones.
const lastCall = new Map();
async function throttle(url, minGap) {
  const host = new URL(url).host;
  const wait = (lastCall.get(host) ?? 0) + minGap - Date.now();
  lastCall.set(host, Date.now() + Math.max(0, wait));
  if (wait > 0) await sleep(wait);
}

async function fetchJSON(url, opts = {}, { retries = 4, base = 1500, gap = 350, timeout = 20000 } = {}) {
  const key = url + '|' + (opts.body ?? '');
  if (memo.has(key)) return memo.get(key);
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      await throttle(url, gap);
      const r = await fetch(url, { ...opts, signal: timeoutSignal(timeout) });
      if (r.ok) {
        const json = await r.json();
        memo.set(key, json);
        return json;
      }
      const detail = await r.text().then((t) => { try { return JSON.parse(t).error ?? t; } catch { return t; } }).catch(() => '');
      lastErr = new Error(`HTTP ${r.status} en ${new URL(url).host}${detail ? `: ${String(detail).slice(0, 120)}` : ''}`);
      if (!RETRY_STATUS.has(r.status)) break;
      const retryAfter = Number(r.headers.get('Retry-After'));
      if (retryAfter > 0) { await sleep(retryAfter * 1000); continue; }
    } catch (e) {
      lastErr = e;
    }
    await sleep(base * 2 ** i);
  }
  throw lastErr;
}

// POST con Content-Type text/plain: es una petición "simple" (sin preflight CORS) y, a
// diferencia de un GET, no tiene límite de tamaño para los trazados largos de 42 km.
const valhallaPost = (endpoint, req, opts) =>
  fetchJSON(`${VALHALLA}/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(req) }, opts);

// ---------------------------------------------------------------------------
// Rutas a pie
// ---------------------------------------------------------------------------
const ROUTE_CACHE_KEY = 'rutas-ab:routes:v1';
const ROUTE_CACHE_MAX = 200;
const routeCache = (() => {
  try { return new Map(JSON.parse(localStorage.getItem(ROUTE_CACHE_KEY)) ?? []); } catch { return new Map(); }
})();
let saveTimer = null;
function persistRouteCache() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const entries = [...routeCache].slice(-ROUTE_CACHE_MAX);  // descarta las más antiguas
    try { localStorage.setItem(ROUTE_CACHE_KEY, JSON.stringify(entries)); } catch { /* cuota llena o bloqueado */ }
  }, 500);
}

// Preferencias de corredor: paseos peatonales y caminos de tierra antes que aceras de calle;
// `use_hills` (0 evita cuestas, 1 las busca) lo fija la intensidad.
const RUNNER_COSTING = { walkway_factor: 0.7, use_tracks: 0.8, use_living_streets: 0.6, step_penalty: 15 };
const VALHALLA_MAX_LOCATIONS = 10; // límite del servidor público

async function valhallaChunk(points, prefs) {
  const j = await valhallaPost('route', {
    // minimum_reachability: no enganchar un punto aleatorio a una calle aislada (patio, recinto
    // cerrado...), que deja la ruta sin solución.
    locations: points.map(([lat, lon]) => ({ lat, lon, minimum_reachability: 50 })),
    costing: 'pedestrian',
    costing_options: { pedestrian: { ...RUNNER_COSTING, ...prefs } },
    directions_type: 'none',
  });
  if (!j.trip) throw new Error(`Valhalla: ${j.error ?? 'sin ruta'}`);
  const coords = [];
  for (const leg of j.trip.legs) coords.push(...decodePolyline(leg.shape, 6).slice(coords.length ? 1 : 0));
  return { distance: j.trip.summary.length * 1000, duration: j.trip.summary.time, coords };
}

// Cada tramo entre puntos consecutivos se calcula por separado: una lista larga se trocea
// en bloques de 10 que comparten el punto frontera y se concatenan sin cambiar nada.
async function valhalla(points, prefs) {
  const total = { distance: 0, duration: 0, coords: [] };
  for (let i = 0; i < points.length - 1; i += VALHALLA_MAX_LOCATIONS - 1) {
    const part = await valhallaChunk(points.slice(i, i + VALHALLA_MAX_LOCATIONS), prefs);
    total.distance += part.distance;
    total.duration += part.duration;
    total.coords.push(...part.coords.slice(total.coords.length ? 1 : 0));
  }
  return total;
}

async function osrm(points) {
  const path = points.map(([lat, lon]) => `${lon.toFixed(5)},${lat.toFixed(5)}`).join(';');
  const j = await fetchJSON(`${OSRM_URL}${path}?overview=full&geometries=polyline`, {}, { retries: 1 });
  if (j.code !== 'Ok' || !j.routes?.length) throw new Error(`OSRM: ${j.code}`);
  return { distance: j.routes[0].distance, duration: j.routes[0].duration, coords: decodePolyline(j.routes[0].geometry) };
}

// Ruta a pie que pasa por `points` ([lat, lon]) en orden.
export async function routeFoot(points, prefs = {}) {
  const pts = points
    .map(([lat, lon]) => [Number(lat.toFixed(5)), Number(lon.toFixed(5))])
    .filter((p, i, a) => i === 0 || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]); // sin duplicados seguidos
  const key = JSON.stringify([pts, prefs]);
  const hit = routeCache.get(key);
  if (hit) return { distance: hit.distance, duration: hit.duration, coords: decodePolyline(hit.geometry) };

  let r;
  try {
    r = await valhalla(pts, prefs);
  } catch (e) {
    console.warn('Valhalla no disponible, uso OSRM', e);
    r = await osrm(pts);
  }
  routeCache.set(key, { distance: r.distance, duration: r.duration, geometry: encodePolyline(r.coords) });
  persistRouteCache();
  return r;
}

// ---------------------------------------------------------------------------
// Detalle de una ruta ya calculada
// ---------------------------------------------------------------------------
// Altitud cada `step` metros: [[distancia_m, altitud_m], ...]
export async function heightsAlong(coords, step = 50) {
  const j = await valhallaPost('height', { encoded_polyline: encodePolyline(coords, 6), range: true, resample_distance: step });
  if (!j.range_height?.length) throw new Error('Valhalla no devolvió altitudes');
  return j.range_height.filter(([, h]) => h != null);
}

// Atributos de cada tramo del trazado: tipo de vía, superficie y semáforo.
export async function edgesAlong(coords) {
  const j = await valhallaPost('trace_attributes', {
    encoded_polyline: encodePolyline(coords, 6),
    shape_match: 'map_snap',
    costing: 'pedestrian',
    filters: {
      attributes: ['edge.names', 'edge.use', 'edge.surface', 'edge.length', 'edge.traffic_signal', 'edge.begin_shape_index', 'edge.end_shape_index', 'shape'],
      action: 'include',
    },
  }, { timeout: 30000 });
  if (!j.edges?.length) throw new Error('Valhalla no devolvió atributos');
  return { edges: j.edges, shape: j.shape ? decodePolyline(j.shape, 6) : coords };
}

// ---------------------------------------------------------------------------
// Búsqueda de direcciones (Nominatim: máximo 1 petición por segundo)
// ---------------------------------------------------------------------------
const nominatimOpts = { gap: 1100, retries: 2, timeout: 12000 };
// Nombres en el idioma del navegador (con español de reserva): en Tokio o en Lisboa los
// resultados salen como los conoce quien usa la app.
const LANGS = [...new Set([...(navigator.languages ?? []), 'es'])].join(',');

// Busca en todo el mundo. Si se pasa `near` ({lat, lon}), da prioridad a los resultados de
// alrededor (unos 70 km), sin excluir el resto: "Plaza Mayor" encuentra la de tu ciudad, y
// "Córdoba, Argentina" sigue funcionando aunque el otro punto esté en Madrid.
export async function searchPlaces(query, near = null) {
  const params = new URLSearchParams({ q: query, format: 'jsonv2', limit: '6', 'accept-language': LANGS });
  if (near) {
    const d = 0.6;
    params.set('viewbox', `${near.lon - d},${near.lat + d},${near.lon + d},${near.lat - d}`);
  }
  const results = await fetchJSON(`${NOMINATIM}/search?${params}`, {}, nominatimOpts);
  return results.map((r) => ({
    name: r.name || r.display_name.split(',')[0],
    detail: r.display_name.split(',').slice(1, 3).join(',').trim(),
    lat: Number(r.lat),
    lon: Number(r.lon),
  }));
}

// Centro aproximado de una ciudad (para situar el mapa la primera vez sin pedir la ubicación).
// Búsqueda estructurada: con el país aparte no hay confusión entre Córdoba (Argentina) y Córdoba (España).
// `countryCode` (ISO, p. ej. 'ar') sale de la región del idioma del navegador ("es-AR").
export async function locateCity(city, { country = '', countryCode = '' } = {}) {
  const params = new URLSearchParams({ city, format: 'jsonv2', limit: '1', 'accept-language': LANGS });
  if (countryCode) params.set('countrycodes', countryCode);
  else if (country) params.set('country', country);
  const [r] = await fetchJSON(`${NOMINATIM}/search?${params}`, {}, nominatimOpts);
  return r ? { lat: Number(r.lat), lon: Number(r.lon) } : null;
}

export async function placeName(lat, lon) {
  const params = new URLSearchParams({ lat, lon, format: 'jsonv2', zoom: '17', 'accept-language': LANGS });
  try {
    const r = await fetchJSON(`${NOMINATIM}/reverse?${params}`, {}, nominatimOpts);
    const a = r.address ?? {};
    return r.name || [a.road, a.house_number].filter(Boolean).join(' ') || a.neighbourhood || a.suburb || 'Punto del mapa';
  } catch {
    return `Punto (${lat.toFixed(4)}, ${lon.toFixed(4)})`;
  }
}
