// Configuración: límites de distancia, punto por defecto, lugares de referencia e intensidades.

export const MAX_KM = 42.0;   // máximo: una maratón
export const MIN_KM = 1.0;
export const LOOP_RADIUS_KM = 0.3; // si A y B están más cerca que esto, la ruta es un bucle

// Punto de salida por defecto (se puede cambiar en la app)
export const DEFAULT_A = {
  name: 'Noviciado Coffee Shop',
  lat: 40.4255,
  lon: -3.7083,
};

// Lugares conocidos del centro de Madrid (coordenadas de OpenStreetMap/Nominatim). No guían
// la ruta: sirven para ponerle nombre y listar por dónde pasa. `green` = parque o paseo fluvial.
export const LANDMARKS = [
  // Parques y zonas verdes
  { name: 'Templo de Debod', lat: 40.42406, lon: -3.71761, green: true },
  { name: 'Rosaleda del Parque del Oeste', lat: 40.428, lon: -3.72449, green: true },
  { name: 'Parque del Oeste', lat: 40.42992, lon: -3.72667, green: true },
  { name: 'Jardines de Sabatini', lat: 40.42056, lon: -3.71398, green: true },
  { name: 'Campo del Moro', lat: 40.4185, lon: -3.7175, green: true },
  { name: 'Parque de Atenas', lat: 40.41482, lon: -3.71871, green: true },
  { name: 'Lago de la Casa de Campo', lat: 40.41879, lon: -3.73268, green: true },
  { name: 'Teleférico', lat: 40.42386, lon: -3.73547, green: true },
  { name: 'Estanque del Retiro', lat: 40.4176, lon: -3.6838, green: true },
  { name: 'Palacio de Cristal', lat: 40.41359, lon: -3.68206, green: true },
  { name: 'Fuente del Ángel Caído', lat: 40.41104, lon: -3.68253, green: true },
  { name: 'Real Jardín Botánico', lat: 40.41148, lon: -3.69068, green: true },
  { name: 'Jardines del Descubrimiento', lat: 40.42485, lon: -3.68909, green: true },
  { name: 'Parque del Tercer Depósito', lat: 40.44278, lon: -3.70712, green: true },
  { name: 'Casino de la Reina', lat: 40.4062, lon: -3.70514, green: true },
  { name: 'Matadero', lat: 40.39154, lon: -3.69766, green: true },
  // Madrid Río
  { name: 'Puente del Rey', lat: 40.41885, lon: -3.72197, green: true },
  { name: 'Puente de Segovia', lat: 40.41413, lon: -3.72285, green: true },
  { name: 'Puente Oblicuo', lat: 40.41109, lon: -3.72241, green: true },
  { name: 'Puente de Toledo', lat: 40.39912, lon: -3.71516, green: true },
  { name: 'Puente de Praga', lat: 40.39509, lon: -3.7049, green: true },
  // Ciudad
  { name: 'Plaza de España', lat: 40.42345, lon: -3.71088 },
  { name: 'Cuartel de Conde Duque', lat: 40.42755, lon: -3.71147 },
  { name: 'Plaza del Dos de Mayo', lat: 40.42696, lon: -3.70409 },
  { name: 'Glorieta de Bilbao', lat: 40.42874, lon: -3.70217 },
  { name: 'Plaza de Olavide', lat: 40.43277, lon: -3.70103 },
  { name: 'Plaza de Chamberí', lat: 40.43279, lon: -3.69735 },
  { name: 'Glorieta de Cuatro Caminos', lat: 40.44722, lon: -3.70389 },
  { name: 'Arco de la Victoria', lat: 40.4359, lon: -3.72019 },
  { name: 'Plaza de Colón', lat: 40.42534, lon: -3.69051 },
  { name: 'Cibeles', lat: 40.41899, lon: -3.69332 },
  { name: 'Puerta de Alcalá', lat: 40.41998, lon: -3.68872 },
  { name: 'Museo del Prado', lat: 40.41379, lon: -3.69204 },
  { name: 'Palacio Real', lat: 40.41674, lon: -3.71362 },
  { name: 'Plaza de Oriente', lat: 40.41833, lon: -3.7132 },
  { name: 'Catedral de la Almudena', lat: 40.41571, lon: -3.71458 },
  { name: 'Cuesta de la Vega', lat: 40.41459, lon: -3.71518 },
  { name: 'Plaza Mayor', lat: 40.41539, lon: -3.70699 },
  { name: 'Puerta del Sol', lat: 40.41686, lon: -3.70387 },
  { name: 'Plaza de Santa Ana', lat: 40.4148, lon: -3.70079 },
  { name: 'Plaza de la Paja', lat: 40.41298, lon: -3.71157 },
  { name: 'Tirso de Molina', lat: 40.4123, lon: -3.70395 },
  { name: 'Plaza de Lavapiés', lat: 40.40882, lon: -3.70114 },
  { name: 'Glorieta de Embajadores', lat: 40.40493, lon: -3.70319 },
];

// Desde esta distancia se propone la sesión de tirada larga
export const LONG_RUN_KM = 18;

export const INTENSITIES = {
  suave: {
    label: 'Suave',
    full: 'Suave / Recuperación',
    hint: 'Llano, pocos cruces, ritmo conversacional.',
    gainPerKm: [0, 8], useHills: 0.1, wGain: 3.0, wSignals: 1.5, wAsphalt: 0.6, pace: [6.0, 7.0],
    workout: 'Rodaje continuo en Z1–Z2, conversacional. Sin cambios de ritmo; camina en las subidas si hace falta.',
    longWorkout: 'Tirada larga en Z2, a ritmo cómodo de principio a fin. Bebe cada 20-25 minutos y no aprietes en las subidas.',
  },
  medio: {
    label: 'Medio',
    full: 'Medio / Sostenido',
    hint: 'Algo de desnivel, bloque a ritmo sostenido.',
    gainPerKm: [6, 14], useHills: 0.5, wGain: 1.5, wSignals: 1.0, wAsphalt: 0.4, pace: [5.0, 5.75],
    workout: 'Calentamiento 2 km suave + bloque sostenido en Z3 en el tramo de parque + último km de vuelta a la calma.',
    longWorkout: 'Tirada larga progresiva: dos tercios en Z2 y el último tercio a ritmo objetivo de carrera. Practica la hidratación.',
  },
  avanzado: {
    label: 'Avanzado',
    full: 'Avanzado / Desnivel o Series',
    hint: 'Busca cuestas; series en el tramo llano.',
    gainPerKm: [14, 35], useHills: 1.0, wGain: 2.0, wSignals: 0.7, wAsphalt: 0.2, pace: [4.25, 5.0],
    workout: 'Series en el tramo más llano de parque: 6×400 m con 1\'30" de recuperación, o cuestas en la subida más larga (6×45" fuerte, bajada trotando).',
    longWorkout: 'Tirada larga con bloques: 3 × 4 km a ritmo de maratón con 1 km suave entre bloques. Aprovecha las cuestas para trabajar fuerza.',
  },
};
