export const VENUE_LOCATION_SETTINGS_KEY = 'venue_location';

export const DEFAULT_VENUE_LOCATION = {
  name: 'Terzo Posto',
  address: 'Julián Álvarez 985',
  city: 'Buenos Aires',
  lat: -34.59527,
  lng: -58.42155,
};

function trimText(value, max) {
  if (value == null) return '';
  return String(value).trim().slice(0, max);
}

function parseCoord(value, min, max) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) return undefined;
  return Math.round(n * 1e6) / 1e6;
}

export function normalizeVenueLocation(raw) {
  const source =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  const name = trimText(source.name, 80);
  const address = trimText(source.address, 160);
  const city = trimText(source.city, 80);
  if (!name) return { error: 'El nombre del lugar es requerido' };
  if (!address) return { error: 'La dirección es requerida' };

  const latEmpty =
    source.lat === undefined || source.lat === null || source.lat === '';
  const lngEmpty =
    source.lng === undefined || source.lng === null || source.lng === '';

  if (latEmpty && lngEmpty) {
    return {
      data: { name, address, city: city || null, lat: null, lng: null },
    };
  }

  const lat = parseCoord(source.lat, -90, 90);
  const lng = parseCoord(source.lng, -180, 180);
  if (lat == null || lng == null) {
    return { error: 'Ingresá latitud y longitud válidas' };
  }

  return {
    data: { name, address, city: city || null, lat, lng },
  };
}

export function venueLocationFromStored(raw) {
  if (!raw) return { ...DEFAULT_VENUE_LOCATION };
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ...DEFAULT_VENUE_LOCATION };
    }
  }
  const normalized = normalizeVenueLocation(parsed);
  if (normalized.error) return { ...DEFAULT_VENUE_LOCATION };
  return normalized.data;
}

export async function getVenueLocation(client) {
  const result = await client.query('SELECT value FROM settings WHERE key = $1', [
    VENUE_LOCATION_SETTINGS_KEY,
  ]);
  return venueLocationFromStored(result.rows[0]?.value);
}
