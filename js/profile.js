// Perfil de elevación en SVG: área + línea de 2 px, rejilla discreta y
// cursor con tooltip al pasar el ratón (sincronizado con el mapa vía onHover).

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

function niceTicks(min, max, count = 3) {
  const span = max - min || 1;
  const step = [5, 10, 20, 25, 50].find((s) => span / s <= count) ?? 100;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) ticks.push(v);
  return ticks;
}

export function renderProfile(container, profile, { onHover, onLeave } = {}) {
  container.innerHTML = '';
  if (!profile?.length) return;

  const W = Math.max(260, container.clientWidth);
  const H = 132;
  const m = { t: 10, r: 8, b: 22, l: 38 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;

  const es = profile.map((p) => p.e);
  const minE = Math.floor(Math.min(...es) - 4);
  const maxE = Math.ceil(Math.max(...es) + 4);
  const maxD = profile[profile.length - 1].d;
  const x = (d) => m.l + (d / maxD) * iw;
  const y = (e) => m.t + ih - ((e - minE) / (maxE - minE)) * ih;

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img',
    'aria-label': `Perfil de elevación: entre ${Math.round(Math.min(...es))} y ${Math.round(Math.max(...es))} metros` });

  // Rejilla y eje Y
  for (const t of niceTicks(minE, maxE)) {
    svg.append(el('line', { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), class: 'pf-grid' }));
    const lbl = el('text', { x: m.l - 6, y: y(t) + 3.5, class: 'pf-tick', 'text-anchor': 'end' });
    lbl.textContent = `${t} m`;
    svg.append(lbl);
  }
  // Eje X (km)
  const kmStep = maxD > 30 ? 10 : maxD > 14 ? 5 : maxD > 6 ? 2 : 1; // pocas etiquetas también en una maratón
  for (let k = 0; k <= maxD; k += kmStep) {
    const lbl = el('text', { x: x(k), y: H - 6, class: 'pf-tick', 'text-anchor': k === 0 ? 'start' : 'middle' });
    lbl.textContent = k === 0 ? '0 km' : `${k}`;
    svg.append(lbl);
  }

  const line = profile.map((p, i) => `${i ? 'L' : 'M'}${x(p.d).toFixed(1)},${y(p.e).toFixed(1)}`).join('');
  svg.append(el('path', { d: `${line}L${x(maxD)},${m.t + ih}L${m.l},${m.t + ih}Z`, class: 'pf-area' }));
  svg.append(el('line', { x1: m.l, x2: W - m.r, y1: m.t + ih, y2: m.t + ih, class: 'pf-base' }));
  svg.append(el('path', { d: line, class: 'pf-line' }));

  // Capa de hover
  const cross = el('line', { y1: m.t, y2: m.t + ih, class: 'pf-cross', visibility: 'hidden' });
  const dot = el('circle', { r: 4.5, class: 'pf-dot', visibility: 'hidden' });
  svg.append(cross, dot);
  const hit = el('rect', { x: m.l, y: 0, width: iw, height: H, fill: 'transparent' });
  svg.append(hit);

  const tip = document.createElement('div');
  tip.className = 'pf-tip';
  tip.hidden = true;

  const move = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    const d = Math.max(0, Math.min(maxD, ((px - m.l) / iw) * maxD));
    const i = Math.round((d / maxD) * (profile.length - 1));
    const p = profile[i];
    const prev = profile[Math.max(0, i - 3)], next = profile[Math.min(profile.length - 1, i + 3)];
    const grade = next.d > prev.d ? ((next.e - prev.e) / ((next.d - prev.d) * 1000)) * 100 : 0;
    cross.setAttribute('x1', x(p.d)); cross.setAttribute('x2', x(p.d));
    dot.setAttribute('cx', x(p.d)); dot.setAttribute('cy', y(p.e));
    cross.setAttribute('visibility', 'visible'); dot.setAttribute('visibility', 'visible');
    tip.hidden = false;
    tip.innerHTML = `<strong>${p.e.toFixed(0)} m</strong><span>km ${p.d.toFixed(2)} · ${grade >= 0 ? '+' : ''}${grade.toFixed(1)} %</span>`;
    const left = (x(p.d) / W) * r.width;
    tip.style.left = `${Math.min(r.width - 120, Math.max(0, left - 60))}px`;
    onHover?.(i);
  };
  const leave = () => {
    cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden');
    tip.hidden = true;
    onLeave?.();
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', leave);

  container.append(svg, tip);
}
