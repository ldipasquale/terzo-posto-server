import db from '../database.js';
import {
  getSupplyCostInfo,
  rowToSupplyInternal,
} from '../routes/supplies.js';

function parseMenuRecipeJson(recipeJson) {
  if (typeof recipeJson !== 'string') return [];
  try {
    const arr = JSON.parse(recipeJson);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function normalizeMenuRecipe(recipe) {
  if (!Array.isArray(recipe)) return [];
  return recipe
    .filter(
      (line) =>
        line &&
        (line.supplyId != null || line.supply_id != null) &&
        line.quantity != null,
    )
    .map((line) => ({
      supplyId: String(line.supplyId ?? line.supply_id),
      quantity: Number(line.quantity),
    }));
}

/**
 * Cost per sold unit (one menu portion) from recipe + supply costs at call time.
 * @returns {number|null}
 */
function unitCostFromMenuRow(row, suppliesById) {
  const recipe = normalizeMenuRecipe(parseMenuRecipeJson(row.recipe));
  const portions =
    row.portions != null && Number(row.portions) > 0
      ? Number(row.portions)
      : 1;
  if (recipe.length === 0) return null;

  let recipeTotal = 0;
  for (const line of recipe) {
    const sub = suppliesById[line.supplyId];
    if (!sub) return null;
    try {
      const info = getSupplyCostInfo(sub, suppliesById);
      if (info.costPerUnit == null) return null;
      recipeTotal += info.costPerUnit * line.quantity;
    } catch {
      return null;
    }
  }
  return recipeTotal / portions;
}

/**
 * Snapshot costs for many menu items in one round-trip (supplies loaded once).
 * @param {string[]} menuItemIds
 * @returns {Promise<Map<string, number|null>>}
 */
export async function getUnitCostsForMenuItemIds(menuItemIds) {
  const unique = [...new Set(menuItemIds.filter(Boolean))];
  const out = new Map();
  for (const id of unique) out.set(id, null);
  if (unique.length === 0) return out;

  const suppliesRes = await db.query(`
    SELECT id, name, type, unit, purchase_price, purchase_quantity, recipe, yield_amount, yield_unit
    FROM supplies
  `);
  const suppliesById = {};
  for (const r of suppliesRes.rows) {
    suppliesById[r.id] = rowToSupplyInternal(r);
  }

  const menuRes = await db.query(
    `SELECT id, recipe, portions FROM menu_items WHERE id = ANY($1::text[])`,
    [unique],
  );
  for (const row of menuRes.rows) {
    out.set(row.id, unitCostFromMenuRow(row, suppliesById));
  }
  return out;
}
