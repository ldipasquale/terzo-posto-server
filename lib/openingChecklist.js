export const OPENING_CHECKLIST_SETTINGS_KEY = 'opening_checklist_template';

function bathroomItems(prefix) {
  return [
    { id: `${prefix}-papel-higienico`, label: 'Papel higiénico', critical: true },
    { id: `${prefix}-jabon`, label: 'Jabón de manos', critical: true },
    { id: `${prefix}-papel-toalla`, label: 'Papel toalla', critical: false },
    { id: `${prefix}-tacho`, label: 'Tacho de basura con bolsa', critical: false },
    { id: `${prefix}-piso`, label: 'Piso limpio', critical: false },
  ];
}

export function getDefaultOpeningChecklistTemplate() {
  return {
    zones: [
      {
        id: 'zone-bano-adelante',
        name: 'Baño adelante',
        canDisablePerOpening: false,
        items: bathroomItems('bano-adelante'),
      },
      {
        id: 'zone-bano-atras',
        name: 'Baño atrás',
        canDisablePerOpening: false,
        items: bathroomItems('bano-atras'),
      },
      {
        id: 'zone-sala-adelante',
        name: 'Sala de adelante (bar)',
        canDisablePerOpening: false,
        items: [
          { id: 'sala-adelante-tacho', label: 'Tacho de basura con bolsa', critical: false },
          { id: 'sala-adelante-mesas-sillas', label: 'Mesas y sillas acomodadas', critical: false },
          { id: 'sala-adelante-piso', label: 'Piso limpio', critical: false },
          { id: 'sala-adelante-mesas-limpias', label: 'Mesas limpias', critical: false },
          { id: 'sala-adelante-musica', label: 'Música sonando', critical: false },
        ],
      },
      {
        id: 'zone-salas-atras',
        name: 'Salas de atrás',
        canDisablePerOpening: true,
        items: [
          { id: 'salas-atras-tacho', label: 'Tacho de basura con bolsa', critical: false },
          { id: 'salas-atras-muebles', label: 'Muebles acomodados', critical: false },
          { id: 'salas-atras-iluminacion', label: 'Iluminación', critical: false },
        ],
      },
      {
        id: 'zone-sala-medio',
        name: 'Sala del medio',
        canDisablePerOpening: true,
        items: [
          { id: 'sala-medio-tacho', label: 'Tacho de basura con bolsa', critical: false },
          { id: 'sala-medio-iluminacion', label: 'Iluminación', critical: false },
        ],
      },
      {
        id: 'zone-barra',
        name: 'Barra',
        canDisablePerOpening: false,
        items: [
          {
            id: 'barra-alcohol',
            label: 'Stock de alcohol (fernet, gin, vino, vermut)',
            critical: true,
          },
          { id: 'barra-hielo', label: 'Hielo', critical: true },
          { id: 'barra-vasos', label: 'Vasos', critical: true },
          { id: 'barra-tablet', label: 'Tablet cargada', critical: true },
          {
            id: 'barra-sin-alcohol',
            label:
              'Stock de bebidas sin alcohol (coca, tónica, soda, latas de gaseosas, aguas con y sin gas)',
            critical: false,
          },
          { id: 'barra-cervezas-frias', label: 'Stock de cervezas frías', critical: false },
          {
            id: 'barra-repuesto-cervezas',
            label: 'Repuesto de cervezas en heladera bajo mesada',
            critical: false,
          },
          {
            id: 'barra-insumos',
            label: 'Insumos de barra (limones y naranjas)',
            critical: false,
          },
          { id: 'barra-tacho', label: 'Tacho de basura con bolsa', critical: false },
          { id: 'barra-beepers', label: 'Beepers cargando', critical: false },
          {
            id: 'barra-elementos',
            label: 'Elementos de barra (mezclador, pinza)',
            critical: false,
          },
        ],
      },
      {
        id: 'zone-patio',
        name: 'Patio',
        canDisablePerOpening: false,
        items: [
          { id: 'patio-tacho', label: 'Tacho de basura con bolsa', critical: false },
          { id: 'patio-mesas-sillas', label: 'Mesas y sillas acomodadas', critical: false },
          { id: 'patio-piso', label: 'Piso limpio', critical: false },
          { id: 'patio-iluminacion', label: 'Iluminación', critical: false },
          { id: 'patio-musica', label: 'Música sonando', critical: false },
        ],
      },
    ],
  };
}

function createId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeOpeningChecklistTemplate(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.zones)) {
    return { error: 'El checklist debe incluir una lista de zonas' };
  }

  const zoneIds = new Set();
  const itemIds = new Set();
  const zones = [];

  for (const zone of raw.zones) {
    if (!zone || typeof zone !== 'object') {
      return { error: 'Hay una zona inválida' };
    }
    const name = typeof zone.name === 'string' ? zone.name.trim() : '';
    if (!name) {
      return { error: 'Todas las zonas necesitan un nombre' };
    }
    if (!Array.isArray(zone.items)) {
      return { error: `La zona "${name}" tiene ítems inválidos` };
    }

    let id = typeof zone.id === 'string' && zone.id.trim() ? zone.id.trim() : createId('zone');
    if (zoneIds.has(id)) id = createId('zone');
    zoneIds.add(id);

    const items = [];
    for (const item of zone.items) {
      if (!item || typeof item !== 'object') {
        return { error: `Hay un ítem inválido en "${name}"` };
      }
      const label = typeof item.label === 'string' ? item.label.trim() : '';
      if (!label) {
        return { error: `Hay un ítem sin nombre en "${name}"` };
      }
      let itemId =
        typeof item.id === 'string' && item.id.trim() ? item.id.trim() : createId('item');
      if (itemIds.has(itemId) || zoneIds.has(itemId)) itemId = createId('item');
      itemIds.add(itemId);
      items.push({
        id: itemId,
        label,
        critical: Boolean(item.critical),
      });
    }

    zones.push({
      id,
      name,
      canDisablePerOpening: Boolean(zone.canDisablePerOpening),
      items,
    });
  }

  return { data: { zones } };
}

const CHECKLIST_STATUSES = new Set(['ok', 'missing', 'na']);

export function normalizeOpeningChecklistRecord(raw) {
  if (raw == null) return { record: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'Checklist de apertura inválido' };
  }

  const completedAt =
    typeof raw.completedAt === 'string' ? raw.completedAt.trim() : '';
  if (!completedAt || Number.isNaN(Date.parse(completedAt))) {
    return { error: 'El checklist no tiene una fecha válida' };
  }

  const by = raw.completedBy;
  const completedById =
    by && typeof by === 'object' && typeof by.id === 'string' ? by.id.trim() : '';
  const completedByName =
    by && typeof by === 'object' && typeof by.name === 'string'
      ? by.name.trim()
      : '';
  if (!completedById || !completedByName) {
    return { error: 'El checklist no tiene quién lo completó' };
  }

  const disabledZones = [];
  if (raw.disabledZones != null) {
    if (!Array.isArray(raw.disabledZones)) {
      return { error: 'Las zonas desactivadas del checklist son inválidas' };
    }
    for (const zone of raw.disabledZones) {
      if (!zone || typeof zone !== 'object') {
        return { error: 'Hay una zona desactivada inválida' };
      }
      const id = typeof zone.id === 'string' ? zone.id.trim() : '';
      const name = typeof zone.name === 'string' ? zone.name.trim() : '';
      if (!id || !name) {
        return { error: 'Hay una zona desactivada inválida' };
      }
      disabledZones.push({ id, name });
    }
  }

  if (!Array.isArray(raw.items)) {
    return { error: 'El checklist no incluye ítems' };
  }

  const items = [];
  for (const item of raw.items) {
    if (!item || typeof item !== 'object') {
      return { error: 'Hay un ítem de checklist inválido' };
    }
    const itemId = typeof item.itemId === 'string' ? item.itemId.trim() : '';
    const zoneId = typeof item.zoneId === 'string' ? item.zoneId.trim() : '';
    const zoneName =
      typeof item.zoneName === 'string' ? item.zoneName.trim() : '';
    const label = typeof item.label === 'string' ? item.label.trim() : '';
    const status = typeof item.status === 'string' ? item.status : '';
    if (!itemId || !zoneId || !zoneName || !label || !CHECKLIST_STATUSES.has(status)) {
      return { error: 'Hay un ítem de checklist inválido' };
    }
    const note =
      typeof item.note === 'string' && item.note.trim()
        ? item.note.trim()
        : undefined;
    items.push({
      itemId,
      zoneId,
      zoneName,
      label,
      critical: Boolean(item.critical),
      status,
      ...(note && status === 'missing' ? { note } : {}),
    });
  }

  return {
    record: {
      completedAt,
      completedBy: { id: completedById, name: completedByName },
      disabledZones,
      items,
    },
  };
}
