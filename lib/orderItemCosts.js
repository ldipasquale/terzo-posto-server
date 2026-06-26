import { getUnitCostsForMenuItemIds } from './menuItemCost.js';

/**
 * Congela unit_cost y promotion_group_cost de una comanda con los costos vigentes
 * al momento de la llamada (p. ej. al cobrar una cuenta abierta).
 * @param {import('pg').PoolClient} client
 * @param {string} orderId
 */
export async function snapshotCostsForOrder(client, orderId) {
  const itemsResult = await client.query(
    `SELECT id, menu_item_id, quantity, promotion_group_id
     FROM order_items
     WHERE order_id = $1`,
    [orderId],
  );
  const rows = itemsResult.rows;
  if (rows.length === 0) return;

  const menuIds = rows.map((r) => r.menu_item_id);
  const unitCostMap = await getUnitCostsForMenuItemIds(menuIds);

  const promotionGroupCostMap = new Map();
  for (const row of rows) {
    if (!row.promotion_group_id) continue;
    const qty = Math.max(1, Math.floor(Number(row.quantity) || 1));
    const unitCost = unitCostMap.get(row.menu_item_id) ?? 0;
    const prev = promotionGroupCostMap.get(row.promotion_group_id) ?? 0;
    promotionGroupCostMap.set(
      row.promotion_group_id,
      prev + unitCost * qty,
    );
  }

  for (const row of rows) {
    const unitCost = unitCostMap.get(row.menu_item_id) ?? null;
    const promotionGroupCost = row.promotion_group_id
      ? promotionGroupCostMap.get(row.promotion_group_id) ?? null
      : null;
    await client.query(
      `UPDATE order_items
       SET unit_cost = $1, promotion_group_cost = $2
       WHERE id = $3`,
      [unitCost, promotionGroupCost, row.id],
    );
  }
}
