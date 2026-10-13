// Estilo de mapa con la estética de Apple Maps sobre teselas vectoriales gratuitas de
// OpenFreeMap (datos de OpenStreetMap). Se parte del estilo "liberty" y se recolorea
// cada capa según su función: suelo, parques, agua, tipo de vía y etiquetas.

const BASE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const FALLBACK_URL = 'https://tiles.openfreemap.org/styles/positron';

const PALETTES = {
  light: {
    land: '#f9f6f0', urban: '#f1eee8', building: '#e9e5de', buildingLine: '#dcd7cf',
    park: '#cde8b8', wood: '#bfe0a6', parkLine: '#b5d99c', sport: '#d5ebc2',
    water: '#a6d2f2', hospital: '#f6e3e3', school: '#f2ecdd',
    road: '#ffffff', roadCasing: '#ddd8cf', path: '#ffffff', pathCasing: '#e6e1d8',
    major: '#fee7a0', majorCasing: '#e8c66a', motorway: '#fccf6e', motorwayCasing: '#e3a93f',
    rail: '#c9c4bb',
    placeText: '#3a3a3c', roadText: '#6e6a64', waterText: '#3f7fb8', poiText: '#6e6a64', halo: '#ffffff',
  },
  dark: {
    land: '#1e1e20', urban: '#232325', building: '#2c2c2f', buildingLine: '#38383c',
    park: '#1f3324', wood: '#22392a', parkLine: '#2a4532', sport: '#22382a',
    water: '#17344f', hospital: '#3a2a2c', school: '#2f2c26',
    road: '#3a3a3e', roadCasing: '#2a2a2d', path: '#343438', pathCasing: '#2a2a2d',
    major: '#5f5745', majorCasing: '#3f3a30', motorway: '#7a6740', motorwayCasing: '#4d4230',
    rail: '#47474b',
    placeText: '#e5e5ea', roadText: '#a1a1a6', waterText: '#6fa8dc', poiText: '#a1a1a6', halo: '#1e1e20',
  },
};

// Capas que sobran para un mapa de correr: flechas de sentido único (se confundirían con
// las de la ruta), edificios en 3D, relieve de baja resolución, puntos de interés menores
// y el rayado de las plazas peatonales.
const DROP = new Set(['natural_earth', 'road_one_way_arrow', 'road_one_way_arrow_opposite',
  'building-3d', 'poi_r20', 'poi_r7', 'road_area_pattern']);

// Color de cada capa según su id (el primer patrón que encaja gana).
function colorFor(id, type, p) {
  const rules = [
    [/^park_outline$/, p.parkLine],
    [/^(park|landcover_grass)$/, p.park],
    [/^(landcover_wood|landuse_cemetery)$/, p.wood],
    [/^(landuse_pitch|landuse_track)$/, p.sport],
    [/^landuse_residential$|^aeroway_fill$|^landcover_(ice|sand)$/, p.urban],
    [/^landuse_hospital$/, p.hospital],
    [/^landuse_school$/, p.school],
    [/^water$|^waterway/, p.water],
    [/^building$/, p.building],
    [/rail/, p.rail],
    [/motorway.*casing/, p.motorwayCasing],
    [/motorway/, p.motorway],
    [/(trunk_primary|link).*casing/, p.majorCasing],
    [/trunk_primary|_link$/, p.major],
    [/(secondary_tertiary|minor|street|service_track).*casing/, p.roadCasing],
    [/path_pedestrian_casing/, p.pathCasing],
    [/path_pedestrian/, p.path],
    [/secondary_tertiary|minor|street|service_track|aeroway_(runway|taxiway)/, p.road],
  ];
  for (const [re, color] of rules) if (re.test(id)) return color;
  return null;
}

function textColorFor(id, p) {
  if (/water|waterway/.test(id)) return p.waterText;
  if (/^highway-name|road_shield/.test(id)) return p.roadText;
  if (/^poi|airport/.test(id)) return p.poiText;
  if (/^label_/.test(id)) return p.placeText;
  return null;
}

let baseP = null;
async function base() {
  baseP ??= fetch(BASE_URL).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
  return baseP;
}

// Devuelve el objeto de estilo listo para map.setStyle(); si OpenFreeMap no responde,
// la URL de un estilo sencillo como reserva.
export async function appleStyle(theme) {
  const p = PALETTES[theme] ?? PALETTES.light;
  let style;
  try {
    style = JSON.parse(JSON.stringify(await base())); // copia profunda (structuredClone falta en iOS < 15.4)
  } catch {
    baseP = null;
    return FALLBACK_URL;
  }
  style.layers = style.layers.filter((l) => !DROP.has(l.id));
  for (const layer of style.layers) {
    const paint = (layer.paint ??= {});
    if (layer.type === 'background') {
      paint['background-color'] = p.land;
    } else if (layer.type === 'fill') {
      const c = colorFor(layer.id, 'fill', p);
      if (c) { paint['fill-color'] = c; delete paint['fill-opacity']; }
      if (layer.id === 'building') paint['fill-outline-color'] = p.buildingLine;
      if (layer.id === 'park') paint['fill-outline-color'] = p.parkLine;
    } else if (layer.type === 'line') {
      const c = colorFor(layer.id, 'line', p);
      if (c) paint['line-color'] = c;
    } else if (layer.type === 'symbol' && layer.layout?.['text-field']) {
      const c = textColorFor(layer.id, p);
      if (c) paint['text-color'] = c;
      paint['text-halo-color'] = p.halo;
      paint['text-halo-width'] = 1.2;
    }
  }
  return style;
}

export const LAND = { light: PALETTES.light.land, dark: PALETTES.dark.land };
