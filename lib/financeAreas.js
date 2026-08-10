/**
 * Áreas del negocio y categorías fijas por tipo de movimiento.
 * Se persisten en columnas separadas: finance_transactions.area + .category.
 * Alineado con ui/src/types/financeAreas.ts.
 */

export const AREAS = [
  'cocina',
  'bar',
  'agenda-eventos',
  'comunicacion-marketing',
  'talleres',
  'administracion',
  'obra',
  'mantenimiento',
];

/** Áreas que admiten vincular un movimiento a un evento (agenda one-off) */
export const EVENT_LINKABLE_AREAS = [
  'cocina',
  'bar',
  'agenda-eventos',
  'comunicacion-marketing',
];

const AREA_SET = new Set(AREAS);
const EVENT_LINKABLE_SET = new Set(EVENT_LINKABLE_AREAS);

export function canLinkEventToArea(area) {
  return typeof area === 'string' && EVENT_LINKABLE_SET.has(area);
}

/** Categorías de EGRESO por área */
export const EXPENSE_CATEGORIES = {
  cocina: ['materia-prima', 'equipamiento', 'mantenimiento', 'sueldos'],
  bar: ['bebidas', 'insumos-barra', 'equipamiento', 'sueldos', 'vasos'],
  'agenda-eventos': ['produccion-evento'],
  'comunicacion-marketing': ['publicidad', 'diseno-contenido'],
  talleres: [],
  administracion: ['gastos-fijos', 'honorarios', 'tramites', 'impositivos', 'socios'],
  obra: ['materiales', 'mano-de-obra', 'equipamiento'],
  mantenimiento: ['insumos-limpieza', 'sueldos', 'reparaciones-menores'],
};

/** Categorías de INGRESO por área */
export const INCOME_CATEGORIES = {
  cocina: ['ventas-comida-salon', 'catering-eventos-privados'],
  bar: ['ventas-bebidas-salon', 'vasos'],
  'agenda-eventos': ['alquiler-espacio', 'entradas', 'produccion-propia'],
  'comunicacion-marketing': ['sponsors'],
  talleres: ['alquiler-salas'],
  administracion: [],
  obra: [],
  mantenimiento: [],
};

export function parseEncodedCategory(encoded) {
  if (!encoded || typeof encoded !== 'string') {
    return { area: null, category: null };
  }
  const [maybeArea, ...rest] = encoded.split('/');
  if (!AREA_SET.has(maybeArea)) return { area: null, category: null };
  return {
    area: maybeArea,
    category: rest.length > 0 ? rest.join('/') : null,
  };
}

function categoriesFor(type, area) {
  if (!area || !AREA_SET.has(area)) return [];
  return type === 'income' ? INCOME_CATEGORIES[area] : EXPENSE_CATEGORIES[area];
}

/**
 * Valida area + category para ingreso/egreso.
 * Área sin categorías definidas (ej. talleres en egreso) admite category null.
 */
export function isValidAreaCategory(type, area, category) {
  if (type !== 'income' && type !== 'expense') {
    return area == null && category == null;
  }
  if (!area || !AREA_SET.has(area)) return false;
  const opts = categoriesFor(type, area);
  if (opts.length === 0) return category == null || category === '';
  return typeof category === 'string' && opts.includes(category);
}

/** Pares área/categoría usados por rutas automáticas */
export const FINANCE_AREA_CATEGORY = {
  purchaseFood: { area: 'cocina', category: 'materia-prima' },
  purchaseDrink: { area: 'bar', category: 'bebidas' },
  fixedExpense: { area: 'administracion', category: 'gastos-fijos' },
  eventRental: { area: 'agenda-eventos', category: 'alquiler-espacio' },
  eventTickets: { area: 'agenda-eventos', category: 'entradas' },
  workshopRental: { area: 'talleres', category: 'alquiler-salas' },
  cupReturn: { area: 'bar', category: 'vasos' },
  socios: { area: 'administracion', category: 'socios' },
  obraMateriales: { area: 'obra', category: 'materiales' },
  obraEquipamiento: { area: 'obra', category: 'equipamiento' },
  barSueldos: { area: 'bar', category: 'sueldos' },
  /** Parte vasos (neto) del cierre de caja → Bar / Vasos */
  buffetCupsIncome: { area: 'bar', category: 'vasos' },
  /** Parte comida del cierre de caja → Cocina / Ventas de comida (salón) */
  buffetFoodIncome: { area: 'cocina', category: 'ventas-comida-salon' },
  /** Parte bebida del cierre de caja → Bar / Ventas de bebidas (salón) */
  buffetDrinkIncome: { area: 'bar', category: 'ventas-bebidas-salon' },
  /** @deprecated alias — usar buffetDrinkIncome; legacy sin split */
  buffetIncome: { area: 'bar', category: 'ventas-bebidas-salon' },
};

/**
 * Mapea categorías legacy (planas o `area/cat`) a { area, category }.
 * Devuelve null si no hay mapeo (queda Sin área).
 */
export function mapLegacyCategory(type, category, hints = {}) {
  if (!category || typeof category !== 'string') return null;

  const encoded = parseEncodedCategory(category);
  if (encoded.area) {
    // Legacy "obra" as area-only → Materiales
    if (encoded.area === 'obra' && !encoded.category) {
      return FINANCE_AREA_CATEGORY.obraMateriales;
    }
    return encoded;
  }

  const legacyMap = {
    'insumos-comida': FINANCE_AREA_CATEGORY.purchaseFood,
    'insumos-bebida': FINANCE_AREA_CATEGORY.purchaseDrink,
    'gasto-fijo': FINANCE_AREA_CATEGORY.fixedExpense,
    'insumos-higiene': { area: 'mantenimiento', category: 'insumos-limpieza' },
    agenda: FINANCE_AREA_CATEGORY.workshopRental,
    'talleres-puntuales': FINANCE_AREA_CATEGORY.workshopRental,
    eventos:
      hints.paymentType === 'tickets'
        ? FINANCE_AREA_CATEGORY.eventTickets
        : FINANCE_AREA_CATEGORY.eventRental,
    // Buffet y Otros: Sin área
    buffet: FINANCE_AREA_CATEGORY.buffetIncome,
    otros: null,
    equipamiento: FINANCE_AREA_CATEGORY.obraEquipamiento,
    obra: FINANCE_AREA_CATEGORY.obraMateriales,
    sueldos: FINANCE_AREA_CATEGORY.barSueldos,
    'devolucion-vasos': FINANCE_AREA_CATEGORY.cupReturn,
    nosotros: FINANCE_AREA_CATEGORY.socios,
  };

  return legacyMap[category] ?? null;
}
