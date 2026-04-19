import db from '../database.js';

const SETTINGS_KEY = 'buffet_cup_price';
const DEFAULT = 2000;

let cache = { price: null, at: 0 };
const TTL_MS = 30_000;

function envPrice() {
  const n = Number(process.env.CUP_PRICE);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

export function invalidateCupPriceCache() {
  cache = { price: null, at: 0 };
}

/**
 * Precio unitario depósito vasos (ARS). Orden: `settings` → `CUP_PRICE` env → default.
 */
export async function getCupPrice() {
  const now = Date.now();
  if (cache.price != null && now - cache.at < TTL_MS) {
    return cache.price;
  }
  try {
    const r = await db.query('SELECT value FROM settings WHERE key = $1', [
      SETTINGS_KEY,
    ]);
    const fromDb = Number(r.rows[0]?.value);
    if (Number.isFinite(fromDb) && fromDb > 0) {
      const price = Math.round(fromDb);
      cache = { price, at: now };
      return price;
    }
  } catch {
    /* fall through */
  }
  const price = envPrice() ?? DEFAULT;
  cache = { price, at: now };
  return price;
}

export { SETTINGS_KEY as BUFFET_CUP_PRICE_SETTINGS_KEY };
