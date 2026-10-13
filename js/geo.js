// Utilidades geográficas puras (sin red). Coordenadas como [lat, lon].

export function haversine(a, b) {
  const R = 6371000;
  const p1 = (a[0] * Math.PI) / 180;
  const p2 = (b[0] * Math.PI) / 180;
  const dp = p2 - p1;
  const dl = ((b[1] - a[1]) * Math.PI) / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function lineLength(coords) {
  let d = 0;
  for (let i = 1; i < coords.length; i++) d += haversine(coords[i - 1], coords[i]);
  return d;
}

// Encoded Polyline (formato de Google y OSRM).
export function decodePolyline(str, precision = 5) {
  const coords = [];
  const factor = 10 ** precision;
  let idx = 0, lat = 0, lng = 0;
  while (idx < str.length) {
    for (let which = 0; which < 2; which++) {
      let shift = 0, result = 0, b;
      do {
        b = str.charCodeAt(idx++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += delta;
      else lng += delta;
    }
    coords.push([lat / factor, lng / factor]);
  }
  return coords;
}

export function encodePolyline(coords, precision = 5) {
  const factor = 10 ** precision;
  let out = '', plat = 0, plng = 0;
  const enc = (v) => {
    v = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    return s + String.fromCharCode(v + 63);
  };
  for (const [lat, lng] of coords) {
    const a = Math.round(lat * factor), b = Math.round(lng * factor);
    out += enc(a - plat) + enc(b - plng);
    plat = a; plng = b;
  }
  return out;
}

// Puntos equiespaciados cada `step` metros a lo largo de la polilínea.
export function resample(coords, step) {
  const out = [coords[0]];
  let carry = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1], b = coords[i];
    const seg = haversine(a, b);
    let d = step - carry;
    while (d <= seg) {
      const t = d / seg;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      d += step;
    }
    carry = (carry + seg) % step;
  }
  const last = coords[coords.length - 1];
  if (haversine(out[out.length - 1], last) > step / 4) out.push(last);
  return out;
}

// Punto situado en la fracción f (0..1) de la longitud de la polilínea.
export function pointAtFraction(coords, f) {
  let target = f * lineLength(coords);
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1], b = coords[i];
    const d = haversine(a, b);
    if (target <= d && d > 0) {
      const t = target / d;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    target -= d;
  }
  return coords[coords.length - 1];
}

// Distancia (m) de un punto a un segmento, proyección equirectangular local.
export function pointSegDist(p, a, b) {
  const k = Math.cos((p[0] * Math.PI) / 180) * 111320;
  const px = p[1] * k, py = p[0] * 110540;
  const ax = a[1] * k, ay = a[0] * 110540, bx = b[1] * k, by = b[0] * 110540;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
