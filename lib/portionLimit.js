export const MAX_PORTION_LIMIT = 999;

function fail(message) {
  const err = new Error(message);
  err.statusCode = 400;
  throw err;
}

/** Map of menu item id → remaining portions. Empty input means no caps. */
export function parsePortionLimitMap(raw, selectedIds) {
  if (raw == null) return new Map();
  if (typeof raw !== "object" || Array.isArray(raw)) {
    fail("portionLimits inválido");
  }
  const selected = new Set(selectedIds);
  const out = new Map();
  for (const [id, value] of Object.entries(raw)) {
    const key = String(id).trim();
    if (!key || !selected.has(key)) {
      fail("El tope de porciones es solo para platos disponibles");
    }
    if (value == null || value === "") continue;
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isInteger(n) || n < 1 || n > MAX_PORTION_LIMIT) {
      fail("Las porciones tienen que ser un entero entre 1 y 999");
    }
    out.set(key, n);
  }
  return out;
}

/** Sum quantities by menu item id for one comanda. */
export function aggregateOrderQuantities(items) {
  const qtyById = new Map();
  if (!Array.isArray(items)) return qtyById;
  for (const item of items) {
    const id = item?.menuItem?.id;
    if (!id) continue;
    const qty = Math.floor(Number(item.quantity));
    if (!Number.isFinite(qty) || qty <= 0) continue;
    qtyById.set(id, (qtyById.get(id) || 0) + qty);
  }
  return qtyById;
}

export function portionShortageMessage(shortages) {
  return shortages
    .map((shortage) => {
      const remaining = Number(shortage.remaining) || 0;
      if (remaining <= 0) return `${shortage.name} está agotado`;
      if (remaining === 1) return `${shortage.name}: queda 1`;
      return `${shortage.name}: quedan ${remaining}`;
    })
    .join(". ");
}

/**
 * Decrement portion_limit for items that have one.
 * Returns the ids that were counted, so the order lines can be restored on delete.
 */
export async function consumePortionLimits(client, items) {
  const qtyById = aggregateOrderQuantities(items);
  const ids = [...qtyById.keys()];
  const countedIds = new Set();
  if (ids.length === 0) return countedIds;

  const locked = await client.query(
    `SELECT id, name, portion_limit
     FROM menu_items
     WHERE id = ANY($1::text[])
     FOR UPDATE`,
    [ids],
  );
  const byId = new Map(locked.rows.map((row) => [row.id, row]));
  const shortages = [];
  for (const [id, qty] of qtyById) {
    const row = byId.get(id);
    if (!row || row.portion_limit == null) continue;
    const remaining = Number(row.portion_limit);
    if (remaining < qty) {
      shortages.push({ name: row.name, remaining });
    }
  }
  if (shortages.length > 0) {
    const err = new Error(portionShortageMessage(shortages));
    err.statusCode = 409;
    throw err;
  }

  for (const [id, qty] of qtyById) {
    const row = byId.get(id);
    if (!row || row.portion_limit == null) continue;
    countedIds.add(id);
    await client.query(
      `UPDATE menu_items
       SET portion_limit = portion_limit - $2,
           available = CASE WHEN portion_limit - $2 <= 0 THEN 0 ELSE available END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [id, qty],
    );
  }
  return countedIds;
}

/** Put portions back for lines that actually consumed a cap. */
export async function restorePortionLimits(client, orderId) {
  const rows = await client.query(
    `SELECT menu_item_id, SUM(quantity)::int AS qty
     FROM order_items
     WHERE order_id = $1 AND portion_counted = 1
     GROUP BY menu_item_id`,
    [orderId],
  );
  for (const row of rows.rows) {
    await client.query(
      `UPDATE menu_items
       SET portion_limit = portion_limit + $2,
           available = CASE
             WHEN type = 'comida'
                  AND requires_kitchen = 1
                  AND archived = 0
                  AND portion_limit + $2 > 0
             THEN 1
             ELSE available
           END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND portion_limit IS NOT NULL`,
      [row.menu_item_id, row.qty],
    );
  }
}

/** Drop tonight's caps. Past comandas no longer restore into a new number. */
export async function clearKitchenPortionLimits(client) {
  await client.query(
    `UPDATE order_items oi
     SET portion_counted = 0
     FROM menu_items m
     WHERE oi.menu_item_id = m.id
       AND oi.portion_counted = 1
       AND m.portion_limit IS NOT NULL
       AND m.type = 'comida'
       AND m.requires_kitchen = 1`,
  );
  await client.query(
    `UPDATE menu_items
     SET portion_limit = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE portion_limit IS NOT NULL
       AND type = 'comida'
       AND requires_kitchen = 1`,
  );
}
