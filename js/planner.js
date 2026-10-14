// Planificador de rutas aleatorias de A a B (o bucles si A y B coinciden), de hasta 42 km.
//
// A→B: los puntos de paso se colocan sobre una elipse con A y B como focos. Cualquier
// camino A → punto → B sobre esa elipse mide lo mismo en línea recta, así que el tamaño
// de la elipse (semieje mayor `a`) controla la distancia y el lado y la posición de los
// puntos, que se sortean, dan la variedad. Después se calibra `a` con la distancia real
// a pie hasta quedar justo por debajo de lo pedido.
// Bucle: círculo que pasa por A con tres puntos de paso, escalado del mismo modo.
import { MAX_KM, LOOP_RADIUS_KM, LANDMARKS, INTENSITIES, LONG_RUN_KM } from './config.js';
import { haversine, resample, lineLength } from './geo.js';
import { routeFoot, heightsAlong, edgesAlong } from './api.js';

const SAMPLE_M = 20;     // resolución de la telemetría
const CANDIDATES = 4;    // rutas distintas por generación
const DETOUR = 1.25;     // la ruta a pie mide ~1,25 × la línea recta entre sus puntos

const COMPASS = ['norte', 'noreste', 'este', 'sureste', 'sur', 'suroeste', 'oeste', 'noroeste'];

// Generador pseudoaleatorio con semilla (mulberry32): la misma semilla da la misma ruta.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Desplaza `p` ([lat, lon]) en km hacia el este y el norte.
const offset = ([lat, lon], eastKm, northKm) => [
  lat + northKm / 110.574,
  lon + eastKm / (111.32 * Math.cos((lat * Math.PI) / 180)),
];
// Vector de `p` a `q` en km (este, norte).
const vec = (p, q) => [
  (q[1] - p[1]) * 111.32 * Math.cos((p[0] * Math.PI) / 180),
  (q[0] - p[0]) * 110.574,
];

// ---------------------------------------------------------------------------
// Formas
// ---------------------------------------------------------------------------
// Elipse con focos A y B. En su sistema local, x va de A (-c) a B (+c) e y es perpendicular.
function ellipseShape(A, B, rand, side) {
  const [e, n] = vec(A, B);
  const len = Math.hypot(e, n);
  const k = rand() < 0.5 ? 2 : 3;                                  // 2 o 3 puntos de paso
  const step = Math.PI / (k + 1);
  return {
    kind: 'ellipse', A, B, side, c: len / 2,
    mid: offset(A, e / 2, n / 2),
    u: [e / len, n / len],                                          // eje A→B
    v: [-n / len, e / len],                                         // perpendicular (izquierda)
    ts: Array.from({ length: k }, (_, j) => Math.PI - (j + 1) * step + (rand() - 0.5) * step * 0.6),
    stretch: Array.from({ length: k }, () => 0.75 + rand() * 0.5),
  };
}

// Zigzag: los puntos de paso van a lo largo del camino directo, alternando a un lado y a otro.
// La ruta va por en medio, serpenteando, en vez de rodear por fuera como la elipse. El tamaño
// `a` es aquí la amplitud lateral del zigzag (km).
function zigzagShape(A, B, rand) {
  const [e, n] = vec(A, B);
  const len = Math.hypot(e, n);
  const k = rand() < 0.5 ? 3 : 4;
  const first = rand() < 0.5 ? 1 : -1;
  return {
    kind: 'zigzag', A, B, c: len / 2,
    u: [e / len, n / len],
    v: [-n / len, e / len],
    ts: Array.from({ length: k }, (_, j) => (j + 1) / (k + 1) + (rand() - 0.5) * 0.08),
    sides: Array.from({ length: k }, (_, j) => (j % 2 ? -first : first) * (0.7 + rand() * 0.3)),
  };
}

function loopShape(A, rand, bearing) {
  return {
    kind: 'loop', A, B: A, bearing,
    jitter: [0, 1, 2].map(() => (rand() - 0.5) * 0.6),
    stretch: [0, 1, 2].map(() => 0.85 + rand() * 0.3),
  };
}

// Puntos de paso de la forma para el tamaño `a` (semieje mayor, o radio en un bucle), en km.
function waypoints(s, a) {
  if (s.kind === 'zigzag') {
    return s.ts.map((t, i) => {
      const x = t * 2 * s.c;                 // distancia a lo largo de A→B
      const y = s.sides[i] * a;              // desvío lateral, alternando lados
      return offset(s.A, x * s.u[0] + y * s.v[0], x * s.u[1] + y * s.v[1]);
    });
  }
  if (s.kind === 'loop') {
    const center = offset(s.A, a * Math.sin(s.bearing), a * Math.cos(s.bearing));
    const back = s.bearing + Math.PI;
    return [1, 2, 3].map((j, i) => {
      const ang = back + (j * Math.PI) / 2 + s.jitter[i];
      return offset(center, a * s.stretch[i] * Math.sin(ang), a * s.stretch[i] * Math.cos(ang));
    });
  }
  const b = Math.sqrt(Math.max(a * a - s.c * s.c, 1e-6));
  return s.ts.map((t, i) => {
    const x = a * Math.cos(t);
    const y = s.side * b * Math.sin(t) * s.stretch[i];
    return offset(s.mid, x * s.u[0] + y * s.v[0], x * s.u[1] + y * s.v[1]);
  });
}

const minSize = (s) => (s.kind === 'loop' ? 0.05 : s.kind === 'zigzag' ? 0.01 : s.c * 1.0005);

// Tamaño inicial: el que da una línea recta A → puntos → B de `km / DETOUR` (búsqueda binaria local).
function initialSize(s, km) {
  const want = km / DETOUR;
  let lo = minSize(s), hi = Math.max(lo * 2, km);
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const len = lineLength([s.A, ...waypoints(s, mid), s.B]) / 1000;
    if (len < want) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------------------
// Calibración: la distancia a pie crece casi en proporción al tamaño de la forma, así que
// se estima, se enruta y se afina con secante (3-5 llamadas), sin pasarse nunca del límite.
// ---------------------------------------------------------------------------
async function calibrate(s, targetKm, prefs) {
  const limit = Math.min(targetKm, MAX_KM);
  const aim = limit - Math.max(0.05, limit * 0.005);
  const make = async (a) => {
    const wps = waypoints(s, a);
    const route = await routeFoot([s.A, ...wps, s.B], prefs);
    return { a, wps, route, km: route.distance / 1000 };
  };

  let a = initialSize(s, aim);
  let lo = null, hi = null, best = null;
  for (let i = 0; i < 6; i++) {
    const c = await make(a);
    if (c.km <= limit) {
      if (!best || c.km > best.km) best = c;
      if (!lo || c.a > lo.a) lo = c;
      if (limit - c.km < Math.max(0.15, limit * 0.015)) break;
    } else if (!hi || c.a < hi.a) {
      hi = c;
    }
    const ref = lo ?? hi;
    a = lo && hi
      ? lo.a + ((aim - lo.km) * (hi.a - lo.a)) / (hi.km - lo.km)
      : ref.a * (aim / ref.km);
    if (lo && hi && (a <= lo.a || a >= hi.a)) a = (lo.a + hi.a) / 2;
    a = Math.max(minSize(s), a);
  }
  if (!best || best.km < targetKm * 0.9) return null;
  return best;
}

// ---------------------------------------------------------------------------
// Telemetría
// ---------------------------------------------------------------------------
function smooth(values, win = 3) {
  const h = Math.floor(win / 2);
  return values.map((_, i) => {
    const s = values.slice(Math.max(0, i - h), i + h + 1);
    return s.reduce((x, y) => x + y, 0) / s.length;
  });
}

// D+ / D- con histéresis de 2 m: sin esto el ruido del modelo de terreno infla el desnivel.
function gainLoss(elev, threshold = 2) {
  let gain = 0, loss = 0, ref = elev[0];
  for (const e of elev.slice(1)) {
    if (e - ref >= threshold) { gain += e - ref; ref = e; }
    else if (ref - e >= threshold) { loss += ref - e; ref = e; }
  }
  return { gain, loss };
}

async function addElevation(c) {
  const step = c.km > 20 ? 100 : 50;
  const heights = await heightsAlong(c.coords, step);
  const elev = smooth(heights.map(([, h]) => h));
  Object.assign(c, gainLoss(elev));
  c.profile = heights.map(([d], i) => ({ d: Math.min(c.km, d / 1000), e: elev[i] }));
  c.elevStep = Math.round(step / SAMPLE_M);
}

const PEDESTRIAN = new Set(['footway', 'path', 'pedestrian', 'living_street', 'pedestrian_crossing',
  'steps', 'cycleway', 'track', 'bridleway', 'mountain_bike', 'elevator']);
const DIRT = new Set(['compacted', 'dirt', 'gravel', 'path', 'impassable']);

function classify(edge) {
  if (DIRT.has(edge.surface) || edge.use === 'track') return 'tierra';
  if (PEDESTRIAN.has(edge.use)) return 'parque';
  return 'asfalto';   // calles y aceras ('road', 'sidewalk', 'service_road'...)
}

// Superficie y semáforos a partir de los atributos de cada tramo que da Valhalla.
async function addSurface(c) {
  const { edges, shape } = await edgesAlong(c.samples);
  const cum = [0];
  for (let i = 1; i < shape.length; i++) cum.push(cum[i - 1] + haversine(shape[i - 1], shape[i]));
  const total = cum[cum.length - 1] || 1;
  const spans = edges.map((e) => ({
    from: cum[e.begin_shape_index ?? 0] / total,
    to: cum[e.end_shape_index ?? 0] / total,
    cat: classify(e),
    name: e.names?.[0] ?? null,
    km: e.length ?? 0,
    at: shape[Math.min(shape.length - 1, e.begin_shape_index ?? 0)],
  }));
  // Calles y paseos con nombre, por kilómetros recorridos en cada uno (sirven en cualquier ciudad)
  const streets = new Map();
  let unnamedGreenKm = 0;
  for (const sp of spans) {
    if (!sp.name) { if (sp.cat !== 'asfalto') unnamedGreenKm += sp.km; continue; }
    const st = streets.get(sp.name) ?? { name: sp.name, km: 0, greenKm: 0, f: sp.from, at: sp.at };
    st.km += sp.km;
    if (sp.cat !== 'asfalto') st.greenKm += sp.km;
    streets.set(sp.name, st);
  }
  c.streets = [...streets.values()];
  c.unnamedGreenKm = unnamedGreenKm;
  // Cada muestra de la ruta toma la categoría del tramo en la misma fracción del recorrido.
  const counts = { asfalto: 0, parque: 0, tierra: 0 };
  let j = 0;
  c.cats = c.samples.map((_, i) => {
    const f = i / Math.max(1, c.samples.length - 1);
    while (j < spans.length - 1 && spans[j].to < f) j++;
    const cat = spans[j]?.cat ?? 'asfalto';
    counts[cat]++;
    return cat;
  });
  c.surface = Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, (100 * v) / c.samples.length]));
  c.signalPoints = edges
    .filter((e) => e.traffic_signal)
    .map((e) => shape[Math.min(shape.length - 1, e.end_shape_index ?? 0)]);
  c.signals = c.signalPoints.length;
}

// % del recorrido que repite calle ya pisada (> 400 m antes).
function overlapPct(samples) {
  const cell = (p) => [Math.round(p[0] * 2000), Math.round(p[1] * 2000)]; // celdas de ~55 m
  const seen = new Map();
  let repeated = 0;
  samples.forEach((p, i) => {
    const [a, b] = cell(p);
    let hit = false;
    for (let da = -1; da <= 1 && !hit; da++) for (let db = -1; db <= 1 && !hit; db++) {
      for (const k of seen.get(`${a + da},${b + db}`) ?? []) {
        if (i - k > 400 / SAMPLE_M && haversine(p, samples[k]) < 20) { hit = true; break; }
      }
    }
    if (hit) repeated++;
    const key = `${a},${b}`;
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(i);
  });
  return (100 * repeated) / samples.length;
}

// Lugares conocidos a < 120 m del trazado, en el orden en que se pasa por ellos.
function landmarksAlong(samples) {
  const hits = [];
  for (const lm of LANDMARKS) {
    const p = [lm.lat, lm.lon];
    let bestI = -1, bestD = 120;
    samples.forEach((s, i) => {
      const d = haversine(s, p);
      if (d < bestD) { bestD = d; bestI = i; }
    });
    if (bestI >= 0) hits.push({ ...lm, at: p, i: bestI });
  }
  return hits.sort((x, y) => x.i - y.i)
    .filter((h, k, arr) => !(k > 0 && h.name.startsWith('Puente') && arr[k - 1].name.startsWith('Puente')));
}

const joinNames = (names) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} y ${names.at(-1)}` : names[0]);
const fmtKm = (km) => km.toLocaleString('es-ES', { maximumFractionDigits: 1 });

// Nombre de la ruta: en Madrid, los lugares conocidos por los que pasa; en cualquier sitio, los
// paseos y calles en los que más kilómetros se corre, más el tramo de parque sin nombre.
function routeName(c, A, B, loop) {
  const green = c.landmarks.filter((l) => l.green && !l.name.startsWith('Puente')).map((l) => l.name);
  if (c.landmarks.some((l) => l.name.startsWith('Puente'))) green.push('Madrid Río');
  const known = [...new Set(green)].slice(0, 3);
  if (known.length) return `Por ${joinNames(known)}`;

  const streets = [...(c.streets ?? [])]
    .filter((s) => s.km >= 0.25)
    .sort((x, y) => (y.greenKm * 2 + y.km) - (x.greenKm * 2 + x.km))   // los verdes pesan más
    .slice(0, 2)
    .map((s) => s.name);
  if ((c.unnamedGreenKm ?? 0) >= 1) streets.push(`${fmtKm(c.unnamedGreenKm)} km de parque`);
  if (streets.length) return `Por ${joinNames(streets)}`;
  return loop ? `Bucle desde ${A.name}` : `${A.name} → ${B.name}`;
}

// "Por dónde pasa": lugares conocidos y calles principales (más de 400 m), en orden de paso.
function waypointList(c, A, B) {
  const n = Math.max(1, c.samples.length - 1);
  const items = [
    ...c.landmarks.map((l) => ({ name: l.name, f: l.i / n })),
    ...(c.streets ?? []).filter((s) => s.km >= 0.4).map((s) => ({ name: `${s.name} (${fmtKm(s.km)} km)`, f: s.f })),
  ].sort((x, y) => x.f - y.f);
  const middle = items.slice(0, 10).map((it) => it.name);
  return [A.name, ...middle, B.name].filter((w, k, arr) => w !== arr[k - 1]);
}

// "Por dónde": cuánto pesan el asfalto y los semáforos al elegir la mejor ruta.
// En "Ciudad" no penalizan: ir por el centro es justo lo que se pide.
export const PREFERENCES = {
  parques: { label: 'Parques', hint: 'Rodeos buscando zonas verdes y pocos semáforos.', ellipses: 4, urban: 1 },
  mezcla: { label: 'Mezcla', hint: 'Rutas que rodean y rutas que cruzan la ciudad.', ellipses: 2, urban: 0.5 },
  ciudad: { label: 'Ciudad', hint: 'Por en medio, serpenteando cerca del camino directo.', ellipses: 0, urban: 0 },
};

function score(c, targetKm, it, pref = PREFERENCES.mezcla) {
  const gpk = c.gain == null ? (it.gainPerKm[0] + it.gainPerKm[1]) / 2 : c.gain / c.km;
  const [lo, hi] = it.gainPerKm;
  const gainDev = Math.max(0, lo - gpk) + Math.max(0, gpk - hi);
  const signalsPer10 = c.signals == null ? 10 : (10 * c.signals) / c.km;
  const asphalt = c.surface ? c.surface.asfalto : 45;
  return (Math.abs(targetKm - c.km) / targetKm) * 100 + gainDev * it.wGain
    + (signalsPer10 * it.wSignals + asphalt * it.wAsphalt) * pref.urban + c.overlap * 0.5;
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------
// A y B: { name, lat, lon }. Si B falta o está a menos de LOOP_RADIUS_KM de A, sale un bucle.
export async function plan({ A, B, targetKm, intensity, prefer = 'mezcla', seed = Date.now(), onProgress = () => {} }) {
  const pref = PREFERENCES[prefer] ?? PREFERENCES.mezcla;
  if (!(targetKm > 0 && targetKm <= MAX_KM)) throw new Error(`La distancia debe estar entre 1 y ${MAX_KM} km`);
  const it = INTENSITIES[intensity];
  const prefs = { use_hills: it.useHills };
  const rand = rng(seed);
  const pA = [A.lat, A.lon];
  const loop = !B || haversine(pA, [B.lat, B.lon]) < LOOP_RADIUS_KM * 1000;
  const end = loop ? A : B;
  const pB = [end.lat, end.lon];

  let shapes;
  let direct = null;
  if (loop) {
    const base = rand() * 2 * Math.PI;
    shapes = Array.from({ length: CANDIDATES }, (_, i) => loopShape(pA, rand, base + (i * Math.PI * 2) / CANDIDATES));
  } else {
    const straightKm = haversine(pA, pB) / 1000;
    if (straightKm > MAX_KM) {
      throw new Error(`A y B están a ${Math.round(straightKm).toLocaleString('es-ES')} km en línea recta, más del máximo de ${MAX_KM} km. Revisa el punto A: ahora es «${A.name}».`);
    }
    onProgress('Calculando el camino más corto de A a B…', 0.03);
    direct = await routeFoot([pA, pB], prefs);
    const directKm = direct.distance / 1000;
    if (directKm > MAX_KM) throw new Error(`A y B están a ${directKm.toFixed(1)} km a pie: más de ${MAX_KM} km.`);
    if (targetKm < directKm * 0.98) {
      const err = new Error(`El camino más corto de A a B ya mide ${directKm.toFixed(1)} km. Sube la distancia o acerca los puntos.`);
      err.minKm = directKm;
      throw err;
    }
    // Elipses (rodean) y zigzags (cruzan por en medio) según la preferencia
    shapes = Array.from({ length: CANDIDATES }, (_, i) => (i < pref.ellipses
      ? ellipseShape(pA, pB, rand, i % 2 ? -1 : 1)
      : zigzagShape(pA, pB, rand)));
  }

  let done = 0;
  const results = await pool(shapes, 2, async (s) => {
    try {
      // Si lo pedido apenas supera el camino directo, no hay margen para desvíos: vale el directo.
      if (direct && targetKm < (direct.distance / 1000) * 1.06) {
        return { shape: s, best: { route: direct, wps: [], km: direct.distance / 1000 } };
      }
      return { shape: s, best: await calibrate(s, targetKm, prefs) };
    } catch (e) {
      console.warn('Ruta descartada', e);
      return null;
    } finally {
      done++;
      onProgress(`Trazando rutas aleatorias (${done}/${shapes.length})`, 0.05 + (done / shapes.length) * 0.65);
    }
  });

  // Rutas únicas (si se usó el camino directo, las cuatro serían iguales)
  const unique = [];
  for (const r of results) {
    if (r?.best && !unique.some((u) => Math.abs(u.best.km - r.best.km) < 0.01)) unique.push(r);
  }
  if (!unique.length) throw new Error('No se pudo trazar una ruta con esa distancia. Vuelve a intentarlo.');

  const fits = [];
  for (const [i, { shape, best }] of unique.entries()) {
    onProgress(`Analizando desnivel, superficie y semáforos (${i + 1}/${unique.length})`, 0.72 + (i / unique.length) * 0.27);
    const [e, n] = loop ? [Math.sin(shape.bearing), Math.cos(shape.bearing)]
      : (() => { const mid = best.wps[Math.floor(best.wps.length / 2)] ?? pB; return vec(pA, mid); })();
    const deg = ((Math.atan2(e, n) * 180) / Math.PI + 360) % 360;
    const c = {
      id: `${seed}-${i}`,
      seed,
      km: best.km,
      coords: best.route.coords,
      urlPoints: best.wps,
      A: { ...A }, B: { ...end }, loop,
      direction: COMPASS[Math.round(deg / 45) % 8],
      intensity,
      engine: 'Valhalla (OpenStreetMap)',
      shapeKind: shape.kind,
    };
    c.samples = resample(c.coords, SAMPLE_M);
    try { await addElevation(c); } catch (err) { console.warn(err); c.gain = null; c.profile = []; }
    try { await addSurface(c); } catch (err) { console.warn(err); c.surface = null; c.signals = null; c.signalPoints = []; }
    c.overlap = overlapPct(c.samples);
    c.landmarks = landmarksAlong(c.samples);
    c.name = routeName(c, A, end, loop);
    c.zoneName = loop ? `Bucle hacia el ${c.direction}`
      : shape.kind === 'zigzag' ? 'De A a B cruzando por en medio' : `De A a B rodeando por el ${c.direction}`;
    c.anchorPoints = c.landmarks.map((l) => ({ name: l.name, at: l.at }));
    c.waypoints = waypointList(c, A, end);
    c.minutes = [c.km * it.pace[0], c.km * it.pace[1]];
    c.workout = c.km >= LONG_RUN_KM ? it.longWorkout : it.workout;
    c.elevSource = 'Valhalla';
    c.score = score(c, targetKm, it, pref);
    if (c.km > MAX_KM) throw new Error(`Límite de ${MAX_KM} km violado`); // garantía final
    fits.push(c);
  }
  fits.sort((x, y) => x.score - y.score);
  onProgress('Listo', 1);
  return { candidates: fits, directKm: direct ? direct.distance / 1000 : null };
}

// URL universal de Google Maps (abre la app en el móvil, a pie). Lleva 9 puntos de la ruta real
// repartidos a lo largo del recorrido: es el máximo de paradas intermedias que acepta Google Maps
// (en la app y en el navegador del ordenador) y le deja muy poco margen para irse por otro camino.
// En navegadores de móvil Google solo usa las 3 primeras; la ruta exacta siempre está en el GPX.
export const GMAPS_WAYPOINTS = 9;

export function googleMapsWaypoints(c, n = GMAPS_WAYPOINTS) {
  const pts = c.samples?.length ? c.samples : c.coords;   // muestras cada 20 m, equiespaciadas
  if (!pts || pts.length < n + 2) return pts?.slice(1, -1) ?? [];
  return Array.from({ length: n }, (_, k) => pts[Math.round(((k + 1) / (n + 1)) * (pts.length - 1))]);
}

export function googleMapsUrl(c) {
  const fmt = ([a, b]) => `${a.toFixed(6)},${b.toFixed(6)}`;
  const params = new URLSearchParams({
    api: '1',
    origin: fmt([c.A.lat, c.A.lon]),
    destination: fmt([c.B.lat, c.B.lon]),
    travelmode: 'walking',
  });
  const wps = googleMapsWaypoints(c);
  if (wps.length) params.set('waypoints', wps.map(fmt).join('|'));
  // Comas y "|" codificados (%2C, %7C), como pide Google: sin codificar, su página de aviso de
  // cookies (la primera vez que se abre en un navegador europeo) responde con error 400.
  return `https://www.google.com/maps/dir/?${params}`;
}

export function toGpx(c) {
  const esc = (s) => s.replace(/[<>&]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[ch]);
  // Altitud de cada muestra: el punto del perfil más cercano por distancia
  const eleAt = (i) => {
    if (!c.profile.length) return null;
    const d = (i * SAMPLE_M) / 1000;
    let k = 0;
    while (k < c.profile.length - 1 && c.profile[k + 1].d <= d) k++;
    return c.profile[k].e;
  };
  const pts = c.samples.map((p, i) => {
    const e = eleAt(i);
    return `      <trkpt lat="${p[0].toFixed(6)}" lon="${p[1].toFixed(6)}">${e != null ? `<ele>${e.toFixed(1)}</ele>` : ''}</trkpt>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Rutas A-B" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>${esc(c.name)} · ${c.km.toFixed(2)} km</name><trkseg>
${pts}
  </trkseg></trk>
</gpx>
`;
}
