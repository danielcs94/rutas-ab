// Interfaz: puntos A y B, controles, generación, resultado, alternativas e historial.
import { MAX_KM, MIN_KM, DEFAULT_A, LOOP_RADIUS_KM, INTENSITIES } from './config.js';
import { plan, googleMapsUrl, toGpx } from './planner.js';
import { routeFoot, searchPlaces, placeName } from './api.js';
import { haversine } from './geo.js';
import { createMap } from './map.js';
import { renderProfile } from './profile.js';

const $ = (id) => document.getElementById(id);
const HISTORY_KEY = 'rutas-ab:history';
const THEME_KEY = 'rutas-ab:theme';
const POINTS_KEY = 'rutas-ab:points';
const SURFACES = [
  { key: 'parque', label: 'Parque / peatonal', color: '--series-1' },
  { key: 'asfalto', label: 'Asfalto / acera', color: '--series-2' },
  { key: 'tierra', label: 'Tierra', color: '--series-3' },
];
// Estadísticas anónimas (GoatCounter). Los eventos llevan el prefijo "ab-" para distinguirlos
// de los de Rutas Noviciado en el mismo panel.
function track(path, title = path) {
  try { window.goatcounter?.count?.({ path: `ab-${path}`, title, event: true }); } catch { /* sin estadísticas */ }
}

const QUICK_KM = [[5, '5'], [10, '10'], [15, '15'], [21.1, 'Media'], [30, '30'], [42, '42']];

// ---------------------------------------------------------------------------
// Almacenamiento local (tolerante a modo privado / bloqueo)
// ---------------------------------------------------------------------------
const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* sin almacenamiento */ }
  },
};

const saved = store.get(POINTS_KEY, {});
const state = {
  km: 10,
  intensity: 'medio',
  A: saved.A ?? { ...DEFAULT_A },
  B: saved.B ?? null,
  pick: null,            // 'A' | 'B' mientras se elige un punto tocando el mapa
  directKm: null,
  candidates: [],
  current: null,
};

// ---------------------------------------------------------------------------
// Tema y mapa
// ---------------------------------------------------------------------------
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
const effectiveTheme = () => document.documentElement.dataset.theme || (systemDark.matches ? 'dark' : 'light');
const savedTheme = store.get(THEME_KEY, null);
if (savedTheme) document.documentElement.dataset.theme = savedTheme;

// Si el mapa no puede arrancar (WebGL desactivado, librería sin cargar…), la app sigue
// funcionando sin él: se generan rutas y se abren en Google Maps o se descarga el GPX.
const noMap = { setTheme() {}, draw() {}, fit() {}, hover() {}, invalidate() {}, setEndpoints() {}, onClick() {}, setPicking() {} };
let mapView = noMap;
try {
  mapView = createMap($('map'), effectiveTheme());
} catch (err) {
  console.error('Mapa no disponible', err);
  $('map-empty').innerHTML = '<p>No se pudo cargar el mapa en este navegador. Puedes generar rutas igualmente y abrirlas en Google Maps.</p>';
}

function applyTheme() {
  mapView.setTheme(effectiveTheme());
  if (state.current) showCandidate(state.current, { fit: false });
}
applyTheme();
systemDark.addEventListener('change', () => { if (!document.documentElement.dataset.theme) applyTheme(); });
$('theme-toggle').addEventListener('click', () => {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  store.set(THEME_KEY, next);
  applyTheme();
});

// ---------------------------------------------------------------------------
// Puntos A y B
// ---------------------------------------------------------------------------
const isLoop = () => !state.B || haversine([state.A.lat, state.A.lon], [state.B.lat, state.B.lon]) < LOOP_RADIUS_KM * 1000;

let directToken = 0;
async function setPoints({ fit = true } = {}) {
  store.set(POINTS_KEY, { A: state.A, B: state.B });
  $('a-input').value = state.A?.name ?? '';
  $('b-input').value = state.B?.name ?? '';
  $('b-clear').hidden = !state.B;
  mapView.setEndpoints(state.A, state.B, { fit: fit && !state.current });

  state.directKm = null;
  if (isLoop()) {
    $('points-hint').textContent = 'Sin punto B: la ruta sale de A y vuelve a A.';
    return;
  }
  // Camino más corto de A a B: marca el mínimo de distancia posible
  const token = ++directToken;
  $('points-hint').textContent = 'Midiendo el camino más corto de A a B…';
  try {
    const r = await routeFoot([[state.A.lat, state.A.lon], [state.B.lat, state.B.lon]], { use_hills: INTENSITIES[state.intensity].useHills });
    if (token !== directToken) return;
    state.directKm = r.distance / 1000;
    $('points-hint').textContent = state.directKm > MAX_KM
      ? `A y B están a ${state.directKm.toFixed(1)} km a pie: más del máximo de ${MAX_KM} km.`
      : `El camino más corto de A a B mide ${state.directKm.toFixed(1)} km. Puedes pedir entre ${state.directKm.toFixed(1)} y ${MAX_KM} km.`;
    if (state.km < state.directKm) setKm(Math.min(MAX_KM, Math.ceil(state.directKm * 1.15)));
  } catch {
    if (token === directToken) $('points-hint').textContent = 'No se pudo medir el camino de A a B ahora mismo.';
  }
}

// Búsqueda de direcciones con sugerencias
function setupSearch(which) {
  const input = $(`${which.toLowerCase()}-input`);
  const list = $(`${which.toLowerCase()}-suggest`);
  let timer = null;
  let token = 0;

  const run = async () => {
    const q = input.value.trim();
    if (q.length < 3) { list.hidden = true; return; }
    const my = ++token;
    list.hidden = false;
    list.innerHTML = '<li class="muted">Buscando…</li>';
    try {
      const results = await searchPlaces(q);
      if (my !== token) return;
      list.innerHTML = results.length
        ? results.map((r, i) => `<li><button type="button" data-i="${i}"><b>${r.name}</b><span>${r.detail}</span></button></li>`).join('')
        : '<li class="muted">Sin resultados. Prueba con otra dirección.</li>';
      list.onclick = (e) => {
        const i = e.target.closest('button')?.dataset.i;
        if (i == null) return;
        state[which] = results[Number(i)];
        list.hidden = true;
        setPoints();
      };
    } catch {
      if (my === token) list.innerHTML = '<li class="muted">No se pudo buscar ahora mismo.</li>';
    }
  };

  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 700); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); run(); }
    if (e.key === 'Escape') list.hidden = true;
  });
  input.addEventListener('focus', () => input.select());
  input.addEventListener('blur', () => setTimeout(() => {
    list.hidden = true;
    input.value = state[which]?.name ?? '';
  }, 200));
}
setupSearch('A');
setupSearch('B');

// Elegir un punto tocando el mapa
function startPick(which) {
  state.pick = state.pick === which ? null : which;
  for (const w of ['A', 'B']) $(`${w.toLowerCase()}-pick`).setAttribute('aria-pressed', String(state.pick === w));
  mapView.setPicking(Boolean(state.pick));
  $('map-empty').hidden = !state.pick && Boolean(state.current);
  if (state.pick) $('map-empty').innerHTML = `<p>Toca el mapa para colocar el punto <b>${state.pick}</b>.</p>`;
  else if (!state.current) $('map-empty').innerHTML = '<p>Elige A, B y la distancia, y pulsa <b>Generar ruta</b>.</p>';
}
$('a-pick').addEventListener('click', () => startPick('A'));
$('b-pick').addEventListener('click', () => startPick('B'));
mapView.onClick(async (lat, lon) => {
  if (!state.pick) return;
  const which = state.pick;
  startPick(which); // sale del modo selección
  state[which] = { name: 'Buscando nombre…', lat, lon };
  setPoints({ fit: false });
  state[which] = { name: await placeName(lat, lon), lat, lon };
  setPoints({ fit: false });
});

// Mi ubicación como punto A
$('a-locate').addEventListener('click', () => {
  if (!navigator.geolocation) { showError('Este navegador no permite usar tu ubicación.'); return; }
  $('a-locate').disabled = true;
  navigator.geolocation.getCurrentPosition(async (pos) => {
    const { latitude: lat, longitude: lon } = pos.coords;
    state.A = { name: 'Mi ubicación', lat, lon };
    await setPoints();
    state.A = { name: await placeName(lat, lon), lat, lon };
    setPoints({ fit: false });
    $('a-locate').disabled = false;
  }, () => {
    showError('No se pudo obtener tu ubicación. Revisa los permisos de localización.');
    $('a-locate').disabled = false;
  }, { enableHighAccuracy: true, timeout: 10000 });
});

$('swap').addEventListener('click', () => {
  if (!state.B) return;
  [state.A, state.B] = [state.B, state.A];
  setPoints();
});
$('b-clear').addEventListener('click', () => { state.B = null; setPoints(); });

// ---------------------------------------------------------------------------
// Distancia e intensidad
// ---------------------------------------------------------------------------
function setKm(km) {
  state.km = Math.max(MIN_KM, Math.min(MAX_KM, Math.round(km * 10) / 10));
  $('km').value = state.km;
  renderControls();
}

function renderControls() {
  $('km-out').innerHTML = `<b>${state.km.toFixed(1)}</b> km`;
  $('km-quick').innerHTML = QUICK_KM.map(([k, label]) =>
    `<button type="button" data-km="${k}" aria-pressed="${Math.abs(state.km - k) < 0.05}">${label}</button>`).join('');
  $('intensity').innerHTML = Object.entries(INTENSITIES).map(([k, it]) =>
    `<button type="button" data-k="${k}" aria-pressed="${k === state.intensity}">${it.label}</button>`).join('');
  $('intensity-hint').textContent = INTENSITIES[state.intensity].hint;
}

$('km').addEventListener('input', (e) => setKm(Number(e.target.value)));
$('km-quick').addEventListener('click', (e) => {
  const km = e.target.closest('button')?.dataset.km;
  if (km) setKm(Number(km));
});
$('intensity').addEventListener('click', (e) => {
  const k = e.target.closest('button')?.dataset.k;
  if (k) { state.intensity = k; renderControls(); }
});

// ---------------------------------------------------------------------------
// Generación
// ---------------------------------------------------------------------------
function showError(msg) {
  $('error').textContent = msg;
  $('error').hidden = false;
}

$('controls').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('generate');
  btn.disabled = true;
  btn.textContent = 'Calculando…';
  $('error').hidden = true;
  $('progress').hidden = false;
  try {
    const { candidates } = await plan({
      A: state.A,
      B: isLoop() ? null : state.B,
      targetKm: state.km,
      intensity: state.intensity,
      onProgress: (msg, frac) => {
        $('progress-text').textContent = msg;
        $('progress-bar').style.width = `${Math.round(frac * 100)}%`;
      },
    });
    state.candidates = candidates;
    showCandidate(candidates[0]);
    saveHistory(candidates[0]);
    renderHistory();
    const tramo = state.km <= 10 ? 'hasta-10km' : state.km <= 21.1 ? '10-a-21km' : 'mas-de-21km';
    track('ruta-generada', `${state.km.toFixed(1)} km · ${INTENSITIES[state.intensity].label}`);
    track(isLoop() ? 'tipo-bucle' : 'tipo-a-b');
    track(`distancia-${tramo}`);
  } catch (err) {
    console.error(err);
    track('error-al-generar', String(err.message).slice(0, 80));
    showError(err.message || 'No se pudo calcular la ruta. Inténtalo de nuevo en unos segundos.');
    if (err.minKm) setKm(Math.min(MAX_KM, Math.ceil(err.minKm * 1.15)));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generar otra ruta';
    $('progress').hidden = true;
  }
});

// ---------------------------------------------------------------------------
// Resultado
// ---------------------------------------------------------------------------
// En rutas largas, formato de reloj como en las carreras ("1:29–1:44 h"); si no, minutos ("40–46′")
const fmtMin = ([a, b]) => {
  if (b < 90) return `${Math.round(a)}–${Math.round(b)}′`;
  const h = (m) => { const t = Math.round(m); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
  return `${h(a)}–${h(b)} h`;
};
const fmtPace = (p) => `${Math.floor(p)}:${String(Math.round((p % 1) * 60)).padStart(2, '0')}`;

function renderSurface(c) {
  const box = $('r-surface');
  if (!c.surface) {
    box.innerHTML = '<p class="unavailable">No disponible: el servicio de atributos de la ruta no respondió. Vuelve a generar en un minuto.</p>';
    return;
  }
  const bar = SURFACES.filter((s) => c.surface[s.key] > 0)
    .map((s) => `<span style="flex:${c.surface[s.key]};background:var(${s.color})" title="${s.label}: ${c.surface[s.key].toFixed(0)} %"></span>`).join('');
  const legend = SURFACES.map((s) =>
    `<li><b><i class="swatch" style="background:var(${s.color})"></i>${c.surface[s.key].toFixed(0)} %</b>${s.label}</li>`).join('');
  box.innerHTML = `<div class="sbar" role="img" aria-label="${SURFACES.map((s) => `${s.label} ${c.surface[s.key].toFixed(0)} %`).join(', ')}">${bar}</div><ul class="slegend">${legend}</ul>`;
}

function drawProfile(c) {
  if (!c.profile?.length) {
    $('r-profile').innerHTML = '<p class="unavailable">No disponible: el servicio de elevación no respondió. Vuelve a generar en un minuto.</p>';
    return;
  }
  renderProfile($('r-profile'), c.profile, {
    onHover: (i) => mapView.hover(c.samples[Math.min(c.samples.length - 1, Math.round(i * (c.elevStep ?? 5)))]),
    onLeave: () => mapView.hover(null),
  });
}

function showCandidate(c, { fit = true } = {}) {
  state.current = c;
  const it = INTENSITIES[c.intensity];
  $('map-empty').hidden = !state.pick;
  $('result').hidden = false;

  $('r-zone').textContent = c.zoneName;
  $('r-name').textContent = c.name;
  $('r-km').textContent = `${c.km.toFixed(2)} km`;
  $('r-gain').textContent = c.gain == null ? '—' : `+${Math.round(c.gain)} m`;
  $('r-time').textContent = fmtMin(c.minutes);
  $('r-time').title = `Ritmo ${fmtPace(it.pace[0])}–${fmtPace(it.pace[1])} min/km`;
  $('r-signals').textContent = c.signals ?? '—';
  $('r-intensity').textContent = `${it.full} · ${fmtPace(it.pace[0])}–${fmtPace(it.pace[1])} min/km`;
  $('r-workout').textContent = c.workout ?? it.workout;
  $('r-waypoints').innerHTML = c.waypoints.map((w) => `<li>${w}</li>`).join('');
  $('r-overlap').textContent = c.overlap == null ? '' : c.overlap < 3
    ? 'Sin tramos repetidos.'
    : `Repite ${Math.round(c.overlap)} % del recorrido (ida y vuelta por la misma calle).`;

  renderSurface(c);
  drawProfile(c);

  $('r-gmaps').href = googleMapsUrl(c);
  mapView.setEndpoints(c.A, c.loop ? null : c.B, { fit: false });
  mapView.draw(c);
  if (fit) mapView.fit(c);
  renderAlternatives();
  renderHistory();
}

$('r-gmaps').addEventListener('click', () => track('abrir-google-maps'));

$('r-gpx').addEventListener('click', () => {
  const c = state.current;
  if (!c) return;
  track('descargar-gpx');
  const blob = new Blob([toGpx(c)], { type: 'application/gpx+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ruta-${c.km.toFixed(1)}km-${c.id}.gpx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('r-copy').addEventListener('click', async (e) => {
  try {
    await navigator.clipboard.writeText($('r-gmaps').href);
    e.target.textContent = '¡Copiado!';
    track('copiar-enlace');
  } catch {
    e.target.textContent = 'No se pudo copiar';
  }
  setTimeout(() => { e.target.textContent = 'Copiar enlace'; }, 1600);
});

// ---------------------------------------------------------------------------
// Alternativas e historial
// ---------------------------------------------------------------------------
const card = (c, attrs) => `
  <button type="button" class="card" ${attrs}>
    <span class="t">${c.name}</span><span class="k">${c.km.toFixed(2)} km</span>
    <span class="z">${c.zoneName} · ${INTENSITIES[c.intensity].label}</span>
    <span class="m">${c.gain == null ? '' : `+${Math.round(c.gain)} m`}${c.surface ? `${c.gain == null ? '' : ' · '}${Math.round(100 - c.surface.asfalto)} % parque/tierra` : ''}</span>
  </button>`;

function renderAlternatives() {
  const list = state.candidates;
  $('alternatives').hidden = list.length < 2;
  $('alt-list').innerHTML = list.map((c, i) => card(c, `data-i="${i}" aria-current="${c === state.current}"`)).join('');
}
$('alt-list').addEventListener('click', (e) => {
  const i = e.target.closest('.card')?.dataset.i;
  if (i != null) showCandidate(state.candidates[Number(i)]);
});

// Para el historial se guardan las muestras (cada 20 m), que bastan para redibujar todo.
const round5 = (p) => [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5];
function serialize(c) {
  return {
    ...c,
    savedAt: Date.now(),
    coords: c.samples.map(round5),
    samples: c.samples.map(round5),
    signalPoints: (c.signalPoints ?? []).map(round5),
    profile: (c.profile ?? []).map((p) => ({ d: Math.round(p.d * 1000) / 1000, e: Math.round(p.e * 10) / 10 })),
  };
}

function saveHistory(c) {
  const list = store.get(HISTORY_KEY, []).filter((h) => h.id !== c.id);
  list.unshift(serialize(c));
  store.set(HISTORY_KEY, list.slice(0, 8));
}

function renderHistory() {
  const list = store.get(HISTORY_KEY, []);
  $('history').hidden = !list.length;
  $('history-list').innerHTML = list.map((h, i) => card(h, `data-h="${i}"`)).join('');
}
$('history-list').addEventListener('click', (e) => {
  const i = e.target.closest('.card')?.dataset.h;
  if (i == null) return;
  const h = store.get(HISTORY_KEY, [])[Number(i)];
  if (!h) return;
  state.candidates = [h];
  state.A = h.A;
  state.B = h.loop ? null : h.B;
  setPoints({ fit: false });
  showCandidate(h);
});
$('history-clear').addEventListener('click', () => {
  store.set(HISTORY_KEY, []);
  renderHistory();
});

// Redibuja el perfil al cambiar el ancho del panel.
new ResizeObserver(() => {
  if (state.current) drawProfile(state.current);
  mapView.invalidate();
}).observe(document.querySelector('.panel'));

renderControls();
renderHistory();
setPoints();
