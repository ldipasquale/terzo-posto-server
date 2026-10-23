export const WIZ_LIGHTS_SETTINGS_KEY = 'wiz_lights';

export const LIGHT_ZONE_ICONS = [
  'lamp',
  'bath',
  'trees',
  'sofa',
  'utensils',
  'door',
  'music',
  'sun',
];

const EMPTY = { zones: [], lamps: [], scenes: [] };
const IPV4 =
  /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

function trimText(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

function clampInt(value, min, max) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

function iconForName(name) {
  const text = name.toLocaleLowerCase('es');
  if (text.includes('baño') || text.includes('bano')) return 'bath';
  if (text.includes('patio') || text.includes('jardín') || text.includes('jardin')) {
    return 'trees';
  }
  if (text.includes('cocina') || text.includes('buffet') || text.includes('barra')) {
    return 'utensils';
  }
  if (text.includes('escenario') || text.includes('música') || text.includes('musica')) {
    return 'music';
  }
  if (text.includes('entrada') || text.includes('puerta')) return 'door';
  if (text.includes('salón') || text.includes('salon')) return 'sofa';
  if (text.includes('exterior') || text.includes('vereda')) return 'sun';
  return 'lamp';
}

function validIp(ip) {
  return IPV4.test(ip) && !ip.endsWith('.255') && !ip.endsWith('.0');
}

const WIZ_EFFECT_IDS = new Set([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 31, 32,
  33, 35, 36,
]);

function normalizeState(state) {
  const on = Boolean(state?.on);
  const dimming = clampInt(state?.dimming ?? 100, 10, 100);
  const r = clampInt(state?.r ?? 255, 0, 255);
  const g = clampInt(state?.g ?? 255, 0, 255);
  const b = clampInt(state?.b ?? 255, 0, 255);
  if (dimming == null || r == null || g == null || b == null) return null;
  const effectRaw = clampInt(state?.effect, 1, 1000);
  const effect = effectRaw != null && WIZ_EFFECT_IDS.has(effectRaw) ? effectRaw : null;
  const next = { on, dimming, r, g, b };
  if (effect) {
    next.effect = effect;
    next.speed = clampInt(state?.speed ?? 100, 10, 200);
  }
  return next;
}

function normalizeScenes(scenesIn, zoneIds, lampIds = new Set()) {
  if (scenesIn.length > 40) return { error: 'Demasiadas escenas' };
  const scenes = [];
  const sceneIds = new Set();
  const sceneNames = new Set();

  for (const scene of scenesIn) {
    const id = trimText(scene?.id, 40);
    const name = trimText(scene?.name, 40);
    if (!id || !name) return { error: 'Cada escena necesita id y nombre' };
    const nameKey = name.toLocaleLowerCase('es');
    if (sceneIds.has(id)) return { error: 'Hay escenas con el mismo id' };
    if (sceneNames.has(nameKey)) return { error: 'Hay dos escenas con el mismo nombre' };
    sceneIds.add(id);
    sceneNames.add(nameKey);

    const statesIn =
      scene?.zones && typeof scene.zones === 'object' && !Array.isArray(scene.zones)
        ? scene.zones
        : null;
    if (!statesIn) return { error: `La escena ${name} no tiene zonas` };

    const zonesState = {};
    for (const [zoneId, state] of Object.entries(statesIn)) {
      if (!zoneIds.has(zoneId)) continue;
      const normalized = normalizeState(state);
      if (!normalized) return { error: 'Estado de luz inválido' };
      zonesState[zoneId] = normalized;
    }

    const lampsIn =
      scene?.lamps && typeof scene.lamps === 'object' && !Array.isArray(scene.lamps)
        ? scene.lamps
        : {};
    const lampsState = {};
    for (const [lampId, state] of Object.entries(lampsIn)) {
      if (!lampIds.has(lampId)) continue;
      const normalized = normalizeState(state);
      if (!normalized) return { error: 'Estado de luz inválido' };
      lampsState[lampId] = normalized;
    }
    const saved = { id, name, zones: zonesState };
    if (Object.keys(lampsState).length > 0) saved.lamps = lampsState;
    scenes.push(saved);
  }

  return { scenes };
}

/** La config vieja guardaba cada lámpara como zona con IP. */
function fromLegacy(zonesIn, scenesIn) {
  if (zonesIn.length > 24) return { error: 'Demasiadas zonas' };
  const zones = [];
  const lamps = [];
  const zoneIds = new Set();
  const zoneNames = new Set();
  const lampIps = new Set();

  for (const zone of zonesIn) {
    const id = trimText(zone?.id, 40);
    const name = trimText(zone?.name, 40);
    const ip = trimText(zone?.ip, 40);
    if (!id || !name) return { error: 'Cada zona necesita id y nombre' };
    if (!validIp(ip)) return { error: `IP inválida${name ? `: ${name}` : ''}` };
    const nameKey = name.toLocaleLowerCase('es');
    if (zoneIds.has(id) || zoneNames.has(nameKey) || lampIps.has(ip)) {
      return { error: 'Hay dos zonas con el mismo nombre o la misma IP' };
    }
    zoneIds.add(id);
    zoneNames.add(nameKey);
    lampIps.add(ip);
    zones.push({ id, name, icon: iconForName(name) });
    lamps.push({
      id: `${id}-lamp`,
      name,
      ip,
      zoneId: id,
    });
  }

  const scenes = normalizeScenes(
    scenesIn,
    zoneIds,
    new Set(lamps.map((lamp) => lamp.id)),
  );
  if (scenes.error) return scenes;
  return { data: { zones, lamps, scenes: scenes.scenes } };
}

export function normalizeWizLights(raw) {
  const source =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const zonesIn = Array.isArray(source.zones) ? source.zones : null;
  const scenesIn = Array.isArray(source.scenes) ? source.scenes : null;
  if (!zonesIn || !scenesIn) {
    return { error: 'zones y scenes son requeridos' };
  }

  const legacy = zonesIn.some(
    (zone) => typeof zone?.ip === 'string' && String(zone.ip).trim(),
  );
  if (legacy) return fromLegacy(zonesIn, scenesIn);

  const lampsIn = Array.isArray(source.lamps) ? source.lamps : null;
  if (!lampsIn) return { error: 'lamps es requerido' };
  if (zonesIn.length > 24) return { error: 'Demasiadas zonas' };
  if (lampsIn.length > 24) return { error: 'Demasiadas lámparas' };

  const zones = [];
  const zoneIds = new Set();
  const zoneNames = new Set();
  for (const zone of zonesIn) {
    const id = trimText(zone?.id, 40);
    const name = trimText(zone?.name, 40);
    const icon = LIGHT_ZONE_ICONS.includes(zone?.icon) ? zone.icon : 'lamp';
    if (!id || !name) return { error: 'Cada zona necesita id y nombre' };
    const nameKey = name.toLocaleLowerCase('es');
    if (zoneIds.has(id)) return { error: 'Hay zonas con el mismo id' };
    if (zoneNames.has(nameKey)) return { error: 'Hay dos zonas con el mismo nombre' };
    zoneIds.add(id);
    zoneNames.add(nameKey);
    zones.push({ id, name, icon });
  }

  const lamps = [];
  const lampIds = new Set();
  const lampIps = new Set();
  const lampNamesByZone = new Map();
  for (const lamp of lampsIn) {
    const id = trimText(lamp?.id, 40);
    const name = trimText(lamp?.name, 40);
    const ip = trimText(lamp?.ip, 40);
    const zoneId = trimText(lamp?.zoneId, 40);
    if (!id || !name) return { error: 'Cada lámpara necesita id y nombre' };
    if (!zoneIds.has(zoneId)) return { error: 'La lámpara no tiene una zona válida' };
    if (!validIp(ip)) return { error: `IP inválida${name ? `: ${name}` : ''}` };
    const nameKey = name.toLocaleLowerCase('es');
    const names = lampNamesByZone.get(zoneId) ?? new Set();
    if (lampIds.has(id)) return { error: 'Hay lámparas con el mismo id' };
    if (lampIps.has(ip)) return { error: 'Hay dos lámparas con la misma IP' };
    if (names.has(nameKey)) return { error: 'Hay dos lámparas con el mismo nombre en la zona' };
    lampIds.add(id);
    lampIps.add(ip);
    names.add(nameKey);
    lampNamesByZone.set(zoneId, names);
    lamps.push({ id, name, ip, zoneId });
  }

  const scenes = normalizeScenes(scenesIn, zoneIds, lampIds);
  if (scenes.error) return scenes;
  return { data: { zones, lamps, scenes: scenes.scenes } };
}

export async function getWizLights(db) {
  const row = (
    await db.query('SELECT value FROM settings WHERE key = $1', [
      WIZ_LIGHTS_SETTINGS_KEY,
    ])
  ).rows[0];
  if (!row?.value) return EMPTY;
  try {
    const normalized = normalizeWizLights(JSON.parse(row.value));
    return normalized.data ?? EMPTY;
  } catch {
    return EMPTY;
  }
}
