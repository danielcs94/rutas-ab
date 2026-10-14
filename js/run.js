// Modo carrera: pantalla a pantalla completa para correr la ruta con el GPS del móvil.
// Cronómetro, distancia, ritmo actual y medio, parciales por km, avisos por voz (giros,
// desvíos, cada km), pantalla siempre encendida, resumen al terminar y "Mis carreras".
// Toda la lógica de medida está en tracker.js; aquí solo hay pantalla, GPS y voz.
import { Tracker, prepareRoute, runToGpx } from './tracker.js';
import { encodePolyline, decodePolyline } from './geo.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
  del(key) { try { localStorage.removeItem(key); } catch { /* sin almacenamiento */ } },
};

// ---------------------------------------------------------------------------
// Formatos
// ---------------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
export function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}
export function pace(minKm) {
  if (minKm == null || !Number.isFinite(minKm) || minKm > 30) return '—';
  const s = Math.round(minKm * 60);
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}
const km = (m) => (m / 1000).toFixed(2);
const sayTime = (ms) => {
  const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return [h && `${h} ${h === 1 ? 'hora' : 'horas'}`, m && `${m} ${m === 1 ? 'minuto' : 'minutos'}`, !h && r && `${r} segundos`]
    .filter(Boolean).join(' ') || '0 segundos';
};
const sayPace = (p) => {
  const s = Math.round(p * 60);
  return `${Math.floor(s / 60)} ${Math.floor(s / 60) === 1 ? 'minuto' : 'minutos'}${s % 60 ? ` ${s % 60}` : ''} por kilómetro`;
};
const dateLabel = (t) => new Date(t).toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' })
  + ' · ' + new Date(t).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });

// ---------------------------------------------------------------------------
// Pantalla (se crea una vez, igual en las dos apps)
// ---------------------------------------------------------------------------
const TEMPLATE = `
<section class="run" id="run" hidden aria-label="Modo carrera">
  <div class="run-map-wrap">
    <div class="run-map" id="run-map"></div>
    <div class="run-top">
      <span class="run-gps" id="run-gps" data-q="none">Buscando GPS…</span>
      <button class="icon-btn" id="run-voice" type="button" aria-pressed="true" title="Avisos por voz" aria-label="Avisos por voz">🔊</button>
      <button class="icon-btn" id="run-close" type="button" title="Salir" aria-label="Salir del modo carrera">✕</button>
    </div>
    <button class="run-recenter" id="run-recenter" type="button" hidden>Seguirme</button>
  </div>
  <div class="run-sheet" id="run-sheet">
    <div id="run-live">
      <p class="run-banner" id="run-banner" hidden></p>
      <div class="run-next" id="run-next" hidden></div>
      <div class="run-hero"><span class="v" id="run-dist">0.00</span><span class="u">km</span></div>
      <div class="run-grid">
        <div><span class="v" id="run-time">0:00</span><span class="l">Tiempo</span></div>
        <div><span class="v" id="run-pace">—</span><span class="l">Ritmo actual</span></div>
        <div><span class="v" id="run-avg">—</span><span class="l">Ritmo medio</span></div>
        <div><span class="v" id="run-left">—</span><span class="l">Km restantes</span></div>
      </div>
      <div class="run-progress" aria-hidden="true"><span id="run-progress"></span></div>
      <div class="run-controls" id="run-controls"></div>
      <p class="hint run-hint" id="run-hint"></p>
      <label class="run-option"><input type="checkbox" id="run-autopause"> Pausa automática al pararte</label>
      <ol class="run-splits" id="run-splits"></ol>
    </div>
    <div id="run-summary" hidden></div>
  </div>
</section>`;

export function createRunMode({ app, prefix, createMap, getTheme, track = () => {} }) {
  document.body.insertAdjacentHTML('beforeend', TEMPLATE);
  const ACTIVE_KEY = `${prefix}:run-active`;
  const RUNS_KEY = `${prefix}:runs`;
  const VOICE_KEY = `${prefix}:voice`;
  const AUTOPAUSE_KEY = `${prefix}:autopause`;

  let route = null;        // ruta planeada (objeto de la app)
  let tracker = null;
  let runMap = null;
  let watchId = null;
  let tick = null;
  let wakeLock = null;
  let follow = true;
  let lastSave = 0;
  let bannerTimer = null;
  let voiceOn = store.get(VOICE_KEY, true);
  $('run-autopause').checked = store.get(AUTOPAUSE_KEY, true);

  // -------------------------------------------------------------------------
  // Voz
  // -------------------------------------------------------------------------
  const canSpeak = 'speechSynthesis' in window;
  function say(text, { force = false } = {}) {
    if (!canSpeak || (!voiceOn && !force)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'es-ES';
    const v = speechSynthesis.getVoices().find((x) => x.lang?.replace('_', '-').startsWith('es-ES'))
      ?? speechSynthesis.getVoices().find((x) => x.lang?.startsWith('es'));
    if (v) u.voice = v;
    u.rate = 1.05;
    speechSynthesis.speak(u);
  }
  function renderVoice() {
    $('run-voice').setAttribute('aria-pressed', String(voiceOn));
    $('run-voice').textContent = voiceOn ? '🔊' : '🔇';
    $('run-voice').hidden = !canSpeak;
  }
  $('run-voice').addEventListener('click', () => {
    voiceOn = !voiceOn;
    store.set(VOICE_KEY, voiceOn);
    renderVoice();
    if (voiceOn) say('Avisos por voz activados');
    else speechSynthesis.cancel();
  });
  renderVoice();

  // -------------------------------------------------------------------------
  // Pantalla siempre encendida (si el navegador lo permite)
  // -------------------------------------------------------------------------
  const canWake = 'wakeLock' in navigator;
  async function keepAwake() {
    if (!canWake || wakeLock) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch { wakeLock = null; }
  }
  function releaseAwake() { wakeLock?.release?.().catch(() => {}); wakeLock = null; }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && tracker && !['ready', 'finished'].includes(tracker.status)) keepAwake();
    if (document.visibilityState === 'hidden') save(true);
  });

  // -------------------------------------------------------------------------
  // GPS
  // -------------------------------------------------------------------------
  function startGps() {
    if (watchId != null) return;
    if (!('geolocation' in navigator)) { showGpsError('Este navegador no tiene GPS.'); return; }
    watchId = navigator.geolocation.watchPosition(onPosition, onGpsError, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  }
  function stopGps() {
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  function showGpsError(msg) {
    $('run-gps').dataset.q = 'none';
    $('run-gps').textContent = 'Sin GPS';
    banner(msg, 'alert', 0);
  }
  function onGpsError(err) {
    if (err.code === 1) {
      showGpsError('Sin permiso de ubicación. En iPhone: Ajustes › Privacidad y seguridad › Localización › Safari (o esta app, si la añadiste a la pantalla de inicio) › «Mientras se usa» y «Ubicación exacta» activada. En Android: toca el candado de la barra de direcciones › Permisos › Ubicación.');
    } else if (err.code === 2) {
      // Los móviles dan este error un instante aunque el GPS vaya bien: solo se avisa si lleva
      // 20 s sin ninguna posición
      const lastT = tracker?.fix?.t;
      if (lastT && Date.now() - lastT < 20000) return;
      $('run-gps').dataset.q = 'none';
      $('run-gps').textContent = 'Sin GPS';
      if ($('run-banner').dataset.kind !== 'alert') banner('El móvil no encuentra tu posición. Sal a cielo abierto y comprueba que la ubicación está activada.', 'info', 8000);
    }
    // code 3 (tiempo agotado): se sigue esperando, watchPosition reintenta solo
  }
  function onPosition(pos) {
    if (!tracker) return;
    const { latitude: lat, longitude: lon, accuracy } = pos.coords;
    const f = { lat, lon, acc: accuracy, t: Date.now() };
    const q = accuracy <= 15 ? 'good' : accuracy <= 35 ? 'ok' : 'weak';
    $('run-gps').dataset.q = q;
    $('run-gps').textContent = `GPS ±${Math.round(accuracy)} m`;
    if ($('run-banner').dataset.kind === 'alert' && /permiso|posición/.test($('run-banner').textContent)) hideBanner();

    const events = tracker.addFix(f);
    for (const e of events) handle(e);
    runMap?.setRun({ track: tracker.points, pos: { lat, lon, acc: Math.min(accuracy, 100) } });
    if (follow) runMap?.follow({ lat, lon });
    if (tracker.status === 'ready') renderControls();
    render();
    save();
  }

  // -------------------------------------------------------------------------
  // Avisos
  // -------------------------------------------------------------------------
  function banner(text, kind = 'info', ms = 6000) {
    const b = $('run-banner');
    b.textContent = text;
    b.dataset.kind = kind;
    b.hidden = false;
    clearTimeout(bannerTimer);
    if (ms) bannerTimer = setTimeout(hideBanner, ms);
  }
  function hideBanner() { $('run-banner').hidden = true; $('run-banner').dataset.kind = ''; }

  function handle(e) {
    const now = Date.now();
    switch (e.type) {
      case 'split': {
        const p = e.ms / 60000;
        say(`Kilómetro ${e.km}. ${sayPace(p)}. Tiempo total, ${sayTime(e.totalMs)}.`);
        banner(`Km ${e.km} · ${pace(p)} min/km`, 'good', 5000);
        save(true);
        break;
      }
      case 'turn': {
        const what = e.sharp ? (Math.abs(e.delta ?? 180) >= 150 ? 'da media vuelta' : `gira cerrado a la ${e.side}`) : `gira a la ${e.side}`;
        say(`En ${Math.max(10, Math.round(e.inM / 10) * 10)} metros, ${what}.`);
        break;
      }
      case 'offroute':
        say(`Te has salido de la ruta. Está a ${e.dist} metros, hacia el ${e.dir}.`);
        banner(`Te has salido de la ruta · está a ${e.dist} m hacia el ${e.dir}`, 'alert', 0);
        navigator.vibrate?.([200, 100, 200]);
        break;
      case 'onroute':
        say('De vuelta en la ruta.');
        banner('De vuelta en la ruta', 'good', 3000);
        break;
      case 'autopause':
        say('Pausa automática.');
        banner('Pausa automática: sigue corriendo y se reanuda sola', 'info', 0);
        renderControls();
        break;
      case 'autoresume':
        say('Seguimos.');
        hideBanner();
        renderControls();
        break;
      case 'complete':
        say(`Ruta completada. ${km(tracker.dist).replace('.', ',')} kilómetros en ${sayTime(tracker.movingMs(now))}. Mantén pulsado terminar para guardarla.`);
        banner('¡Ruta completada! Mantén pulsado «Terminar» para guardarla', 'good', 0);
        break;
      case 'gap':
        banner(`Sin GPS durante ${clock(e.ms)} (pantalla bloqueada o sin señal): ${e.filled ? 'he unido el tramo siguiendo la ruta' : 'he unido el tramo en línea recta'}.`, 'info', 8000);
        break;
      default:
    }
  }

  // -------------------------------------------------------------------------
  // Pintado
  // -------------------------------------------------------------------------
  function render() {
    if (!tracker) return;
    const now = Date.now();
    const R = tracker.route;
    $('run-dist').textContent = km(tracker.dist);
    $('run-time').textContent = clock(tracker.movingMs(now));
    $('run-pace').textContent = tracker.status === 'running' ? pace(tracker.pace) : '—';
    $('run-avg').textContent = pace(tracker.avgPace(now));
    $('run-left').textContent = ((R.length - tracker.progress) / 1000).toFixed(1);
    $('run-progress').style.width = `${Math.min(100, (100 * tracker.progress) / R.length)}%`;

    // Próximo giro (o seguir recto) mientras vas por la ruta
    const next = $('run-next');
    const turn = tracker.nextTurn();
    if (tracker.status === 'running' && !tracker.off && tracker.points.length) {
      next.hidden = false;
      if (turn && turn.inM <= 400) {
        const arrow = turn.sharp ? (turn.side === 'derecha' ? '↷' : '↶') : (turn.side === 'derecha' ? '↱' : '↰');
        next.innerHTML = `<b>${arrow}</b><span>${turn.sharp ? 'Giro cerrado' : 'Gira'} a la ${turn.side}</span><em>${Math.round(turn.inM / 10) * 10} m</em>`;
      } else {
        next.innerHTML = `<b>↑</b><span>Sigue la ruta</span><em>${turn ? `${(turn.inM / 1000).toFixed(1)} km` : 'hasta el final'}</em>`;
      }
    } else next.hidden = true;

    const done = tracker.splits.length;
    if ($('run-splits').childElementCount !== done) {
      $('run-splits').innerHTML = tracker.splits.slice().reverse().map((s) =>
        `<li><span>Km ${s.km}</span><b>${pace(s.ms / 60000)}</b><em>${clock(s.totalMs)}</em></li>`).join('');
    }
  }

  function renderControls() {
    const st = tracker?.status;
    const box = $('run-controls');
    $('run-close').hidden = !(st === 'ready' || st === 'finished');
    $('run-autopause').parentElement.hidden = st === 'finished';
    if (st === 'ready') {
      const fix = tracker.fix;
      const ready = fix && fix.acc <= 35;
      box.innerHTML = `<button class="primary run-big" id="run-start" type="button">${ready ? 'Empezar' : 'Empezar sin esperar al GPS'}</button>`;
      $('run-hint').textContent = !fix
        ? 'Buscando tu posición… Al aire libre tarda unos segundos.'
        : ready
          ? `GPS listo (±${Math.round(fix.acc)} m). ${canWake ? 'La pantalla se quedará encendida mientras corres.' : ''}`
          : `Señal débil (±${Math.round(fix.acc)} m): espera un poco a cielo abierto para que la distancia salga exacta.`;
      $('run-start').addEventListener('click', start);
      return;
    }
    if (st === 'running' || st === 'autopaused') {
      box.innerHTML = `<button class="secondary run-big" id="run-pause" type="button">Pausa</button>${holdButton()}`;
      $('run-pause').addEventListener('click', () => { tracker.pause(Date.now()); say('Carrera en pausa.'); hideBanner(); renderControls(); render(); save(true); });
    } else if (st === 'paused') {
      box.innerHTML = `<button class="primary run-big" id="run-resume" type="button">Seguir</button>${holdButton()}`;
      $('run-resume').addEventListener('click', () => { tracker.resume(Date.now()); keepAwake(); say('Seguimos.'); hideBanner(); renderControls(); render(); save(true); });
    }
    bindHold();
    $('run-hint').textContent = st === 'paused'
      ? 'En pausa: el tiempo está parado y lo que andes no cuenta.'
      : canWake
        ? 'No bloquees el móvil: la pantalla se mantiene encendida. Si se bloquea, el GPS se para y al volver se une el tramo.'
        : 'Pon el bloqueo automático en «Nunca» mientras corres: si la pantalla se apaga, el GPS se para.';
  }

  // Terminar se mantiene pulsado 1 s: así no se acaba la carrera por un toque sin querer
  const holdButton = () => '<button class="run-hold run-big" id="run-finish" type="button"><span class="fill"></span><span class="txt">Mantén para terminar</span></button>';
  function bindHold() {
    const b = $('run-finish');
    let timer = null;
    const startHold = (e) => {
      e.preventDefault();
      b.classList.add('holding');
      timer = setTimeout(() => { b.classList.remove('holding'); finish(); }, 1000);
    };
    const cancel = () => { clearTimeout(timer); b.classList.remove('holding'); };
    b.addEventListener('pointerdown', startHold);
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, cancel);
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    b.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) startHold(e); });
    b.addEventListener('keyup', cancel);
  }

  // -------------------------------------------------------------------------
  // Ciclo de la carrera
  // -------------------------------------------------------------------------
  function compactRoute(c) {
    const r5 = (p) => [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5];
    return {
      id: c.id, name: c.name, km: c.km, zoneName: c.zoneName, intensity: c.intensity,
      samples: c.samples.map(r5), coords: c.samples.map(r5), cats: c.cats, profile: c.profile,
      A: c.A, B: c.B, signalPoints: c.signalPoints, urlPoints: c.urlPoints, anchorPoints: c.anchorPoints,
    };
  }

  function save(force = false) {
    if (!tracker || tracker.status === 'ready' || tracker.status === 'finished') return;
    const now = Date.now();
    if (!force && now - lastSave < 5000) return;
    lastSave = now;
    store.set(ACTIVE_KEY, { route: compactRoute(route), tracker: tracker.toJSON(), savedAt: now });
  }

  function ensureMap() {
    if (runMap) return;
    try {
      runMap = createMap($('run-map'), getTheme());
      runMap.onUserMove(() => { follow = false; $('run-recenter').hidden = false; });
    } catch { $('run-map').innerHTML = '<p class="run-nomap">Mapa no disponible</p>'; }
  }

  function show() {
    $('run').hidden = false;
    document.documentElement.classList.add('run-open');
    ensureMap();
    requestAnimationFrame(() => runMap?.invalidate?.());
  }

  function open(c, restored = null) {
    route = c;
    tracker = restored ?? new Tracker(prepareRoute(c), { autoPause: $('run-autopause').checked });
    follow = true;
    $('run-recenter').hidden = true;
    $('run-live').hidden = false;
    $('run-summary').hidden = true;
    $('run-splits').innerHTML = '';
    hideBanner();
    show();
    runMap?.draw(c);
    runMap?.setRun({ track: tracker.points, pos: null });
    if (tracker.points.length) runMap?.fitTrack(tracker.points); else runMap?.fit(c);
    renderControls();
    render();
    startGps();
    clearInterval(tick);
    tick = setInterval(render, 1000);
    if (restored) banner('La página se recargó y la carrera quedó en pausa. Pulsa «Seguir» para continuar.', 'info', 0);
  }

  function start() {
    // Se habla dentro del toque: iOS solo deja usar la voz después de un gesto del usuario
    say(`Empezamos. ${route.name}, ${route.km.toFixed(1).replace('.', ',')} kilómetros.`);
    tracker.autoPause = $('run-autopause').checked;
    tracker.start(Date.now());
    keepAwake();
    track('carrera-iniciada', `${route.km.toFixed(1)} km`);
    renderControls();
    render();
    save(true);
  }

  $('run-autopause').addEventListener('change', (e) => {
    store.set(AUTOPAUSE_KEY, e.target.checked);
    if (tracker) tracker.autoPause = e.target.checked;
  });

  function finish() {
    const now = Date.now();
    tracker.finish(now);
    stopGps();
    releaseAwake();
    clearInterval(tick);
    store.del(ACTIVE_KEY);
    const s = tracker.summary(now);
    if (tracker.dist < 50) {
      say('Carrera descartada: no ha dado tiempo a registrar distancia.');
      close();
      return;
    }
    const saved = saveRun(s);
    say(`Carrera terminada. ${km(s.dist).replace('.', ',')} kilómetros en ${sayTime(s.ms)}${s.pace ? `, a ${sayPace(s.pace)}` : ''}.`);
    track('carrera-terminada', `${km(s.dist)} km · ${pace(s.pace)} min/km`);
    showSummary(saved);
    renderRuns();
  }

  function close() {
    stopGps();
    releaseAwake();
    clearInterval(tick);
    speechSynthesis?.cancel?.();
    if (tracker && tracker.status === 'ready') tracker = null;
    $('run').hidden = true;
    document.documentElement.classList.remove('run-open');
  }
  $('run-close').addEventListener('click', close);
  $('run-recenter').addEventListener('click', () => {
    follow = true;
    $('run-recenter').hidden = true;
    if (tracker?.fix) runMap?.follow(tracker.fix);
  });
  window.addEventListener('beforeunload', (e) => {
    if (tracker && ['running', 'autopaused', 'paused'].includes(tracker.status)) { save(true); e.preventDefault(); }
  });

  // -------------------------------------------------------------------------
  // Carreras guardadas
  // -------------------------------------------------------------------------
  function saveRun(s) {
    const pts = tracker.points;
    const t0 = pts[0]?.t ?? tracker.startedAt;
    const run = {
      id: `${tracker.startedAt}`,
      at: tracker.startedAt,
      name: route.name,
      routeKm: route.km,
      dist: s.dist, ms: s.ms, pace: s.pace, gain: s.gain, completedPct: s.completedPct,
      splits: s.splits.map((x) => ({ km: x.km, ms: Math.round(x.ms), totalMs: Math.round(x.totalMs) })),
      line: encodePolyline(pts.map((p) => [p.lat, p.lon])),
      times: pts.map((p) => Math.round((p.t - t0) / 1000)).join(','),
      segs: pts.map((p, i) => (p.seg ? i : -1)).filter((i) => i >= 0).join(','),
      t0,
      route: compactRoute(route),
    };
    const list = [run, ...store.get(RUNS_KEY, [])].slice(0, 30);
    // Si no cabe (el almacenamiento del navegador es pequeño), se borran las más antiguas
    while (!store.set(RUNS_KEY, list) && list.length > 1) list.pop();
    return run;
  }

  function runPoints(run) {
    const ll = decodePolyline(run.line);
    const times = run.times.split(',').map(Number);
    const segs = new Set(String(run.segs || '').split(',').filter(Boolean).map(Number));
    return ll.map(([lat, lon], i) => ({ lat, lon, t: run.t0 + (times[i] ?? 0) * 1000, ...(segs.has(i) ? { seg: true } : {}) }));
  }

  function showSummary(run) {
    $('run-live').hidden = true;
    const box = $('run-summary');
    box.hidden = false;
    $('run-close').hidden = false;
    const best = run.splits.length ? run.splits.reduce((b, s) => (s.ms < b.ms ? s : b)) : null;
    const slowest = Math.max(...run.splits.map((s) => s.ms), 1);
    box.innerHTML = `
      <p class="eyebrow">Carrera terminada · ${dateLabel(run.at)}</p>
      <h2>${run.name}</h2>
      <div class="run-hero"><span class="v">${km(run.dist)}</span><span class="u">km</span></div>
      <div class="run-grid">
        <div><span class="v">${clock(run.ms)}</span><span class="l">Tiempo</span></div>
        <div><span class="v">${pace(run.pace)}</span><span class="l">Ritmo medio</span></div>
        <div><span class="v">+${Math.round(run.gain)} m</span><span class="l">Desnivel</span></div>
        <div><span class="v">${Math.round(run.completedPct)} %</span><span class="l">De la ruta</span></div>
      </div>
      ${best ? `<p class="hint">Mejor kilómetro: el ${best.km}, a ${pace(best.ms / 60000)} min/km.</p>` : ''}
      ${run.splits.length ? `<h3>Parciales</h3><ol class="run-bars">${run.splits.map((s) => `
        <li${best && s.km === best.km ? ' class="best"' : ''}><span>Km ${s.km}</span><i style="--w:${Math.round((100 * s.ms) / slowest)}%"></i><b>${pace(s.ms / 60000)}</b></li>`).join('')}</ol>` : ''}
      <div class="actions">
        <button class="primary" id="run-share" type="button">Compartir GPX</button>
        <button class="secondary" id="run-gpx" type="button">Descargar GPX</button>
        <a class="secondary" href="https://www.strava.com/upload/select" target="_blank" rel="noopener">Subir a Strava</a>
      </div>
      <p class="note">El GPX lleva tu recorrido real con la hora de cada punto. Las webs no pueden escribir en Salud (iPhone) ni en Health Connect (Android): para tenerla ahí, impórtala en una app que sí lo haga, como Strava conectada a Salud.</p>
      <div class="run-summary-foot">
        <button class="link-btn" id="run-delete" type="button">Borrar esta carrera</button>
        <button class="secondary" id="run-done" type="button">Cerrar</button>
      </div>`;
    const pts = runPoints(run);
    const gpx = () => runToGpx(pts, { name: `${run.name} · ${km(run.dist)} km`, app });
    const fileName = `carrera-${new Date(run.at).toISOString().slice(0, 10)}-${km(run.dist)}km.gpx`;
    const download = () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([gpx()], { type: 'application/gpx+xml' }));
      a.download = fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    $('run-gpx').addEventListener('click', () => { download(); track('carrera-gpx'); });
    $('run-share').addEventListener('click', async () => {
      const file = new File([gpx()], fileName, { type: 'application/gpx+xml' });
      track('carrera-compartir');
      if (navigator.canShare?.({ files: [file] })) {
        try { await navigator.share({ files: [file], title: run.name }); } catch { /* cancelado */ }
      } else download();
    });
    $('run-done').addEventListener('click', close);
    $('run-delete').addEventListener('click', () => {
      if (!confirm('¿Borrar esta carrera? No se puede deshacer.')) return;
      store.set(RUNS_KEY, store.get(RUNS_KEY, []).filter((r) => r.id !== run.id));
      renderRuns();
      close();
    });
    if (runMap) {
      if (run.route) runMap.draw(run.route);
      runMap.setRun({ track: pts, pos: null });
      runMap.fitTrack(pts);
    }
    follow = false;
    $('run-recenter').hidden = true;
  }

  function openSaved(id) {
    const run = store.get(RUNS_KEY, []).find((r) => r.id === id);
    if (!run) return;
    show();
    showSummary(run);
  }

  // Lista "Mis carreras" del panel
  function renderRuns() {
    const list = store.get(RUNS_KEY, []);
    const section = $('runs');
    if (!section) return;
    section.hidden = !list.length;
    $('runs-list').innerHTML = list.map((r) => `
      <button type="button" class="card" data-run="${r.id}">
        <span class="t">${r.name}</span><span class="k">${km(r.dist)} km</span>
        <span class="z">${dateLabel(r.at)}</span>
        <span class="m">${clock(r.ms)} · ${pace(r.pace)} min/km</span>
      </button>`).join('');
  }
  $('runs-list')?.addEventListener('click', (e) => {
    const id = e.target.closest('[data-run]')?.dataset.run;
    if (id) openSaved(id);
  });
  $('runs-clear')?.addEventListener('click', () => {
    if (!confirm('¿Borrar todas tus carreras guardadas? No se puede deshacer.')) return;
    store.set(RUNS_KEY, []);
    renderRuns();
  });
  renderRuns();

  // Carrera a medias (se recargó la página o se cerró la pestaña): se recupera en pausa
  const active = store.get(ACTIVE_KEY, null);
  if (active?.route?.samples?.length && active.tracker) {
    try {
      const tr = Tracker.fromJSON(prepareRoute(active.route), active.tracker);
      open(active.route, tr);
    } catch (err) {
      console.warn('No se pudo recuperar la carrera', err);
      store.del(ACTIVE_KEY);
    }
  }

  return {
    open: (c) => open(c),
    setTheme(theme) { runMap?.setTheme(theme); if (route && runMap) runMap.draw(route); },
    isActive: () => !!tracker && !['ready', 'finished'].includes(tracker.status),
  };
}
