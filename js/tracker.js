// Seguimiento de una carrera: recibe posiciones del GPS y calcula distancia, tiempo en
// movimiento, ritmos, parciales por kilómetro, avance sobre la ruta planeada, giros y
// desvíos. No toca la pantalla ni la red, así se puede probar con carreras simuladas.
import { haversine, pointSegDist } from './geo.js';

export const CFG = {
  maxAccuracy: 35,       // m: posiciones peores se ignoran (señal débil)
  maxSpeed: 9,           // m/s (32 km/h): más rápido es un salto del GPS
  gapMs: 20000,          // sin posiciones durante 20 s = hueco (pantalla bloqueada, túnel…)
  autoPauseMs: 15000,    // 15 s sin moverse = pausa automática
  moveM: 10,             // m que hay que alejarse para contar como movimiento (más si el GPS va mal)
  paceWindowMs: 20000,   // el ritmo actual se mide sobre los últimos 20 s
  kalmanQ: 2,            // m/s: cuánto se fía el filtro de cada posición nueva (más = menos suavizado)
  accSigma: 0.6,         // la precisión que da el móvil es pesimista: error típico ≈ 0,6 × precisión
  offRouteM: 45,         // a más de 45 m de la ruta = desvío…
  offRouteFixes: 2,      // …en dos posiciones seguidas (una sola puede ser ruido)
  backOnRouteM: 25,      // a menos de 25 m = de vuelta en la ruta
  turnAheadM: 60,        // aviso de giro a 60 m
  finishM: 40,           // a menos de 40 m del final = ruta completada
};

const COMPASS = ['norte', 'noreste', 'este', 'sureste', 'sur', 'suroeste', 'oeste', 'noroeste'];
const rad = (d) => (d * Math.PI) / 180;
export function bearing(a, b) {
  return (Math.atan2((b[1] - a[1]) * Math.cos(rad(a[0])), b[0] - a[0]) * 180) / Math.PI;
}
const compass = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

// ---------------------------------------------------------------------------
// Ruta planeada: distancias acumuladas, giros y altitud en cada punto
// ---------------------------------------------------------------------------
// Giro = cambio de rumbo de 50° o más entre los 40 m anteriores y los 40 m siguientes.
// De cada grupo de giros seguidos (menos de 60 m) se queda el más marcado.
function findTurns(pts, cum) {
  const k = 2;
  const raw = [];
  for (let i = k; i < pts.length - k; i++) {
    let delta = bearing(pts[i], pts[i + k]) - bearing(pts[i - k], pts[i]);
    delta = ((delta + 540) % 360) - 180; // −180…180, positivo = a la derecha
    if (Math.abs(delta) >= 50) raw.push({ i, d: cum[i], delta });
  }
  const turns = [];
  for (const t of raw) {
    const last = turns.at(-1);
    if (last && t.d - last.d < 60) {
      if (Math.abs(t.delta) > Math.abs(last.delta)) turns[turns.length - 1] = t;
    } else turns.push(t);
  }
  const len = cum.at(-1);
  return turns.filter((t) => t.d > 30 && t.d < len - 30)
    .map((t) => ({ ...t, side: t.delta > 0 ? 'derecha' : 'izquierda', sharp: Math.abs(t.delta) >= 120 }));
}

export function prepareRoute(c) {
  const pts = c.samples;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversine(pts[i - 1], pts[i]));
  const prof = (c.profile ?? []).map((p) => [p.d * 1000, p.e]);
  // Altitud (m) a `d` metros del inicio, interpolada en el perfil de la ruta
  const elevAt = (d) => {
    if (!prof.length) return null;
    if (d <= prof[0][0]) return prof[0][1];
    for (let i = 1; i < prof.length; i++) {
      if (d <= prof[i][0]) {
        const [d0, e0] = prof[i - 1], [d1, e1] = prof[i];
        return d1 === d0 ? e1 : e0 + ((e1 - e0) * (d - d0)) / (d1 - d0);
      }
    }
    return prof.at(-1)[1];
  };
  return { pts, cum, length: cum.at(-1), turns: findTurns(pts, cum), elevAt };
}

// ---------------------------------------------------------------------------
// Carrera
// ---------------------------------------------------------------------------
export class Tracker {
  constructor(route, { autoPause = true } = {}) {
    this.route = route;               // de prepareRoute()
    this.autoPause = autoPause;
    this.status = 'ready';            // ready | running | autopaused | paused | finished
    this.startedAt = null;            // hora de inicio (reloj)
    this.finishedAt = null;
    this.accMs = 0;                   // tiempo en movimiento de los tramos ya cerrados
    this.segStart = null;             // inicio del tramo en marcha
    this.points = [];                 // { lat, lon, t, d, m, seg?, fill? } (d = m recorridos, m = ms en movimiento)
    this.dist = 0;
    this.splits = [];                 // { km, ms, totalMs }
    this.fix = null;                  // última posición recibida (aunque se descarte)
    this.weak = false;
    this.last = null;                 // última posición aceptada
    this.anchor = null;               // referencia para detectar movimiento
    this.lastMoveT = null;
    this.newSeg = true;
    this.pace = null;                 // min/km, suavizado
    this.idx = 0;                     // punto de la ruta por el que vas
    this.progress = 0;                // m de ruta recorridos
    this.counted = 0;                 // avance de la ruta ya sumado a la distancia
    this.routeDist = null;            // m a los que estás de la ruta
    this.off = false;
    this.offCount = 0;
    this.announced = new Set();       // giros ya avisados
    this.completed = false;
    this.gain = 0;
    this.eRef = null;
  }

  movingMs(t) {
    return this.accMs + (this.status === 'running' ? Math.max(0, t - this.segStart) : 0);
  }

  start(t) {
    if (this.status !== 'ready') return;
    this.status = 'running';
    this.startedAt = t;
    this.segStart = t;
    this.lastMoveT = t;
    // Si ya hay posición buena, la carrera empieza ahí
    if (this.fix && !this.weak) this.addFix(this.fix);
  }

  pause(t) {
    if (this.status === 'running') this.accMs += Math.max(0, t - this.segStart);
    if (this.status === 'running' || this.status === 'autopaused') this.status = 'paused';
  }

  resume(t) {
    if (this.status !== 'paused') return;
    this.status = 'running';
    this.segStart = t;
    this.lastMoveT = t;
    this.last = null;                 // lo andado en pausa no cuenta: nuevo tramo
    this.kf = null;
    this.lastFixT = null;
    this.newSeg = true;
  }

  finish(t) {
    if (this.status === 'finished') return;
    this.pause(t);
    this.status = 'finished';
    this.finishedAt = t;
  }

  // Ritmo medio (min/km) sobre el tiempo en movimiento
  avgPace(t) {
    return this.dist >= 50 ? this.movingMs(t) / 60000 / (this.dist / 1000) : null;
  }

  // Siguiente giro de la ruta y a cuántos metros está
  nextTurn() {
    const t = this.route.turns.find((x) => x.d > this.progress + 5);
    return t ? { ...t, inM: t.d - this.progress } : null;
  }

  // Filtro de Kalman sencillo (sin velocidad): mezcla cada posición con la anterior según su
  // precisión. Sin él, el baile del GPS (unos metros en cada lectura) infla la distancia.
  smooth(f) {
    const k = this.kf;
    if (!k || f.t - k.t >= CFG.gapMs || f.t <= k.t) {
      this.kf = { lat: f.lat, lon: f.lon, v: (f.acc * CFG.accSigma) ** 2, t: f.t };
      return { ...f };
    }
    k.v += ((f.t - k.t) / 1000) * CFG.kalmanQ ** 2; // incertidumbre que se gana al moverse
    const gain = k.v / (k.v + (f.acc * CFG.accSigma) ** 2);
    k.lat += gain * (f.lat - k.lat);
    k.lon += gain * (f.lon - k.lon);
    k.v *= 1 - gain;
    k.t = f.t;
    return { ...f, lat: k.lat, lon: k.lon };
  }

  // Procesa una posición { lat, lon, acc, t } y devuelve los avisos que genera.
  addFix(raw) {
    const ev = [];
    this.fix = raw;
    this.weak = raw.acc > CFG.maxAccuracy;
    if (this.weak || (this.status !== 'running' && this.status !== 'autopaused')) return ev;
    // Un salto imposible se descarta antes de que contamine el filtro
    if (this.last && raw.t - this.last.t < CFG.gapMs && raw.t > this.last.t
      && haversine([this.last.lat, this.last.lon], [raw.lat, raw.lon]) / ((raw.t - this.last.t) / 1000) > CFG.maxSpeed * 2) return ev;
    const f = this.smooth(raw);
    // Hueco = tiempo sin ninguna posición buena (no el tiempo parado en un semáforo)
    const sinceFix = this.lastFixT == null ? 0 : f.t - this.lastFixT;
    this.lastFixT = f.t;

    const p = [f.lat, f.lon];
    const last = this.last;
    if (!last) {
      this.anchor = p;
      this.lastMoveT = f.t;
      this.push(f, 0, ev);
      this.locate(f, ev);
      this.counted = this.progress;
      return ev;
    }
    const dt = f.t - last.t;
    if (dt <= 0) return ev;
    const d = haversine([last.lat, last.lon], p);
    const gap = sinceFix >= CFG.gapMs;
    if (!gap && d / (dt / 1000) > CFG.maxSpeed) return ev; // salto del GPS

    // Movimiento y pausa automática
    let moved = false;
    if (haversine(this.anchor, p) > Math.max(CFG.moveM, f.acc * 0.8)) {
      this.anchor = p;
      this.lastMoveT = f.t;
      moved = true;
    }
    if (this.status === 'autopaused') {
      if (!moved) return ev;
      this.status = 'running';
      this.segStart = f.t;
      ev.push({ type: 'autoresume' });
    } else if (this.autoPause && !gap && f.t - this.lastMoveT > CFG.autoPauseMs) {
      this.accMs += Math.max(0, this.lastMoveT - this.segStart);
      this.status = 'autopaused';
      this.pace = null;
      ev.push({ type: 'autopause' });
      return ev;
    }

    const R = this.route;
    const before = this.idx;
    const wasOn = this.isOn();
    this.locate(f, ev);
    const nowOn = this.isOn();

    if (gap) {
      // Hueco (p. ej. pantalla bloqueada): si antes y después ibas por la ruta, se rellena
      // siguiendo la ruta; si no, en línea recta.
      if (wasOn && nowOn && this.idx > before + 1) {
        const span = R.cum[this.idx] - R.cum[before];
        for (let i = before + 1; i < this.idx; i++) {
          const frac = (R.cum[i] - R.cum[before]) / span;
          const prev = this.last;
          this.push({ lat: R.pts[i][0], lon: R.pts[i][1], t: last.t + frac * dt, acc: f.acc }, haversine([prev.lat, prev.lon], R.pts[i]), ev, true);
        }
        const prev = this.last;
        this.push(f, haversine([prev.lat, prev.lon], p), ev);
        ev.push({ type: 'gap', ms: dt, filled: true });
      } else {
        this.push(f, d, ev);
        ev.push({ type: 'gap', ms: dt, filled: false });
      }
      this.counted = this.progress;
      return ev;
    }

    if (wasOn && nowOn) {
      // Por la ruta: la distancia es lo que avanzas sobre ella, exacta aunque el GPS baile o
      // recorte las esquinas. Si el GPS se mueve bastante más que el avance (vas hacia atrás,
      // das vueltas en un sitio), manda el GPS.
      const step = this.progress - this.counted;
      if (d > step + 25) this.push(f, d, ev);
      else if (step >= 3) this.push(f, step, ev);
      else return ev;
    } else {
      // Fuera de la ruta: GPS filtrado; quieto o casi, el ruido no suma distancia
      if (d < Math.max(5, Math.min(f.acc, 20) * 0.5)) return ev;
      this.push(f, d, ev);
    }
    this.counted = this.progress;
    return ev;
  }

  isOn() {
    return !this.off && this.routeDist != null && this.routeDist < CFG.offRouteM;
  }

  push(f, d, ev, fill = false) {
    const m = this.movingMs(f.t);
    const prev = this.points.at(-1);
    this.dist += d;
    const pt = { lat: f.lat, lon: f.lon, t: Math.round(f.t), d: this.dist, m };
    if (this.newSeg) { pt.seg = true; this.newSeg = false; }
    if (fill) pt.fill = true;
    this.points.push(pt);
    this.last = pt;

    // Parciales: cada km, interpolando el instante exacto en que se cruzó
    while (prev && this.dist >= (this.splits.length + 1) * 1000) {
      const km = this.splits.length + 1;
      const frac = (km * 1000 - prev.d) / (this.dist - prev.d || 1);
      const totalMs = prev.m + frac * (m - prev.m);
      const ms = totalMs - (this.splits.at(-1)?.totalMs ?? 0);
      this.splits.push({ km, ms, totalMs });
      ev.push({ type: 'split', km, ms, totalMs });
    }

    // Ritmo actual: últimos 20 s en movimiento
    if (!fill) {
      let i = this.points.length - 1;
      while (i > 0 && f.t - this.points[i - 1].t <= CFG.paceWindowMs && !this.points[i].seg) i--;
      const p0 = this.points[i];
      const dd = this.dist - p0.d, dm = m - p0.m;
      if (dd >= 15 && dm > 0) {
        const pace = dm / 60000 / (dd / 1000);
        this.pace = this.pace == null ? pace : this.pace * 0.6 + pace * 0.4;
      }
    }
  }

  // Dónde estás respecto a la ruta: avance, desvío, giros, final y desnivel
  locate(f, ev) {
    const R = this.route;
    const p = [f.lat, f.lon];
    const segDist = (i) => Math.min(
      i > 0 ? pointSegDist(p, R.pts[i - 1], R.pts[i]) : Infinity,
      i < R.pts.length - 1 ? pointSegDist(p, R.pts[i], R.pts[i + 1]) : Infinity,
    );
    // Se busca hacia delante (hasta 2 km) el primer tramo casi tan cercano como el mejor y,
    // desde ahí, se baja hasta su punto más próximo. Así, en un tramo de ida y vuelta por la
    // misma calle no salta a la vuelta antes de tiempo.
    const from = Math.max(0, this.idx - 5);
    const to = Math.min(R.pts.length - 1, this.idx + 100);
    const near = [];
    let bestD = Infinity;
    for (let i = from; i <= to; i++) {
      near.push(haversine(p, R.pts[i]));
      bestD = Math.min(bestD, segDist(i));
    }
    const minNear = Math.min(...near);
    let best = from + near.findIndex((dd) => dd <= minNear + 10);
    while (best < to && near[best + 1 - from] < near[best - from]) best++;
    let dist = bestD;
    // ¿Te has saltado un tramo? Si estás lejos, se busca en el resto de la ruta por delante.
    if (bestD > CFG.offRouteM) {
      for (let i = to + 1; i < R.pts.length; i++) {
        const dd = segDist(i);
        if (dd < CFG.backOnRouteM && dd < dist) { dist = dd; best = i; break; }
      }
    }
    this.routeDist = dist;

    if (dist > CFG.offRouteM) {
      if (f.acc <= 25) this.offCount++;
      if (!this.off && this.offCount >= CFG.offRouteFixes) {
        this.off = true;
        // Hacia dónde queda la ruta (el punto más cercano por delante)
        let ni = this.idx, nd = Infinity;
        for (let i = this.idx; i < Math.min(R.pts.length, this.idx + 150); i++) {
          const dd = haversine(p, R.pts[i]);
          if (dd < nd) { nd = dd; ni = i; }
        }
        ev.push({ type: 'offroute', dist: Math.round(nd), dir: compass(bearing(p, R.pts[ni])) });
      }
      return;
    }
    this.offCount = 0;
    if (this.off && dist < CFG.backOnRouteM) {
      this.off = false;
      ev.push({ type: 'onroute' });
    }
    if (this.off) return;

    if (best >= this.idx - 5) this.idx = Math.max(this.idx, best);
    // Avance exacto: proyección sobre el tramo anterior o el siguiente al punto de la ruta
    const proj = (i) => {
      const a = R.pts[i], b = R.pts[i + 1];
      const k = Math.cos(rad(a[0])) * 111320;
      const ax = a[1] * k, ay = a[0] * 110540, bx = b[1] * k, by = b[0] * 110540;
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      const t = len2 ? ((p[1] * k - ax) * dx + (p[0] * 110540 - ay) * dy) / len2 : 0;
      return t;
    };
    let prog = R.cum[this.idx];
    if (this.idx < R.pts.length - 1 && proj(this.idx) > 0) {
      prog += Math.min(1, proj(this.idx)) * (R.cum[this.idx + 1] - R.cum[this.idx]);
    } else if (this.idx > 0 && proj(this.idx - 1) < 1) {
      prog -= (1 - Math.max(0, proj(this.idx - 1))) * (R.cum[this.idx] - R.cum[this.idx - 1]);
    }
    this.progress = Math.max(this.progress, prog);

    // Desnivel según el perfil de la ruta (la altitud del GPS del móvil es poco fiable)
    const e = R.elevAt(this.progress);
    if (e != null) {
      if (this.eRef == null) this.eRef = e;
      else if (e - this.eRef >= 2) { this.gain += e - this.eRef; this.eRef = e; }
      else if (this.eRef - e >= 2) this.eRef = e;
    }

    const turn = this.nextTurn();
    if (turn && turn.inM <= CFG.turnAheadM && !this.announced.has(turn.i)) {
      this.announced.add(turn.i);
      ev.push({ type: 'turn', side: turn.side, sharp: turn.sharp, delta: turn.delta, inM: Math.round(turn.inM) });
    }

    if (!this.completed && this.progress >= R.length - CFG.finishM
      && haversine(p, R.pts.at(-1)) < CFG.finishM && this.dist >= R.length * 0.7) {
      this.completed = true;
      ev.push({ type: 'complete' });
    }
  }

  summary(t = this.finishedAt ?? Date.now()) {
    const ms = this.movingMs(t);
    const best = this.splits.reduce((b, s) => (!b || s.ms < b.ms ? s : b), null);
    return {
      dist: this.dist,
      ms,
      wallMs: this.startedAt ? (this.finishedAt ?? t) - this.startedAt : 0,
      pace: this.avgPace(t),
      gain: this.gain,
      splits: this.splits,
      best,
      completedPct: Math.min(100, (100 * this.progress) / this.route.length),
    };
  }

  // Para guardar la carrera en curso y recuperarla si se recarga la página
  toJSON() {
    const keys = ['autoPause', 'status', 'startedAt', 'finishedAt', 'accMs', 'segStart', 'points', 'dist',
      'splits', 'pace', 'idx', 'progress', 'counted', 'routeDist', 'off', 'completed', 'gain', 'eRef'];
    return { ...Object.fromEntries(keys.map((k) => [k, this[k]])), announced: [...this.announced] };
  }

  static fromJSON(route, data) {
    const tr = new Tracker(route, { autoPause: data.autoPause });
    Object.assign(tr, data, { announced: new Set(data.announced ?? []) });
    tr.last = tr.points.at(-1) ?? null;
    tr.anchor = tr.last ? [tr.last.lat, tr.last.lon] : null;
    tr.lastMoveT = tr.last?.t ?? null;
    // Tras recargar, la carrera queda en pausa: el tiempo sin datos no cuenta
    if (tr.status === 'running' || tr.status === 'autopaused') {
      if (tr.status === 'running') tr.accMs = tr.last ? tr.last.m : tr.accMs;
      tr.status = 'paused';
    }
    return tr;
  }
}

// GPX de lo que has corrido de verdad, con la hora de cada punto
export function runToGpx(points, { name, app }) {
  const esc = (s) => String(s).replace(/[<>&]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[ch]);
  const segs = [];
  for (const p of points) {
    if (p.seg || !segs.length) segs.push([]);
    segs.at(-1).push(`      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}"><time>${new Date(p.t).toISOString()}</time></trkpt>`);
  }
  const start = points[0] ? new Date(points[0].t).toISOString() : new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="${esc(app)}" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${esc(name)}</name><time>${start}</time></metadata>
  <trk><name>${esc(name)}</name><type>running</type>
${segs.map((s) => `    <trkseg>\n${s.join('\n')}\n    </trkseg>`).join('\n')}
  </trk>
</gpx>
`;
}
