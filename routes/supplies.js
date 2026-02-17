import express from 'express';
import db from '../database.js';
import { randomUUID } from 'crypto';

const router = express.Router();

const VALID_UNITS = ['g', 'ml', 'unidad'];

function parseRecipe(recipeJson) {
  if (recipeJson == null) return null;
  if (typeof recipeJson !== 'string') return Array.isArray(recipeJson) ? recipeJson : null;
  try {
    const arr = JSON.parse(recipeJson);
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

/** Normalize recipe line: accept supplyId or supply_id, output supplyId + quantity */
function normalizeRecipeLine(line) {
  if (!line || line.quantity == null) return null;
  const supplyId = line.supplyId ?? line.supply_id;
  if (!supplyId) return null;
  return { supplyId: String(supplyId), quantity: Number(line.quantity) };
}

function rowToSupply(row, costPerUnit = null) {
  const recipe = parseRecipe(row.recipe);
  const recipeNormalized = Array.isArray(recipe)
    ? recipe.map(normalizeRecipeLine).filter(Boolean)
    : null;
  const out = {
    id: row.id,
    name: row.name,
    type: row.type,
    unit: row.unit ?? undefined,
    purchasePrice: row.purchase_price != null ? Number(row.purchase_price) : undefined,
    purchaseQuantity: row.purchase_quantity != null ? Number(row.purchase_quantity) : undefined,
    recipe: recipeNormalized ?? undefined,
    yieldAmount: row.yield_amount != null ? Number(row.yield_amount) : undefined,
    yieldUnit: row.yield_unit ?? undefined,
  };
  if (costPerUnit !== undefined && costPerUnit !== null) {
    out.costPerUnit = costPerUnit;
  }
  return out;
}

/** Build supply object from row for internal use (with recipe array) */
function rowToSupplyInternal(row) {
  const recipe = parseRecipe(row.recipe);
  const recipeNormalized = Array.isArray(recipe)
    ? recipe.map(normalizeRecipeLine).filter(Boolean)
    : [];
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    unit: row.unit ?? null,
    purchase_price: row.purchase_price != null ? Number(row.purchase_price) : null,
    purchase_quantity: row.purchase_quantity != null ? Number(row.purchase_quantity) : null,
    recipe: recipeNormalized,
    yield_amount: row.yield_amount != null ? Number(row.yield_amount) : null,
    yield_unit: row.yield_unit ?? null,
  };
}

/**
 * Compute cost per unit. Purchased: purchasePrice / purchaseQuantity.
 * Composed: sum(recipe line cost) / yieldAmount. Uses visited set for cycle detection.
 */
function getSupplyCostPerUnit(supply, suppliesById, visited = new Set()) {
  if (visited.has(supply.id)) {
    throw new Error('Circular reference in supply recipe');
  }
  visited.add(supply.id);

  try {
    if (supply.type === 'purchased') {
      const price = supply.purchase_price;
      const qty = supply.purchase_quantity;
      if (price == null || qty == null || qty <= 0) return null;
      return price / qty;
    }
    // composed
    if (!supply.recipe || supply.recipe.length === 0) return null;
    if (supply.yield_amount == null || supply.yield_amount <= 0) return null;
    let total = 0;
    for (const line of supply.recipe) {
      const sub = suppliesById[line.supplyId];
      if (!sub) return null;
      const subCost = getSupplyCostPerUnit(sub, suppliesById, new Set(visited));
      if (subCost == null) return null;
      total += subCost * line.quantity;
    }
    return total / supply.yield_amount;
  } finally {
    visited.delete(supply.id);
  }
}

// GET all supplies
router.get('/', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, name, type, unit, purchase_price, purchase_quantity, recipe, yield_amount, yield_unit, created_at, updated_at
      FROM supplies
      ORDER BY name
    `);
    const suppliesById = {};
    for (const row of result.rows) {
      suppliesById[row.id] = rowToSupplyInternal(row);
    }
    const items = result.rows.map((row) => {
      const supply = suppliesById[row.id];
      let costPerUnit = null;
      try {
        costPerUnit = getSupplyCostPerUnit(supply, suppliesById);
      } catch {
        // circular
      }
      return rowToSupply(row, costPerUnit);
    });
    res.json(items);
  } catch (error) {
    console.error('Error fetching supplies:', error);
    res.status(500).json({ error: 'Error al obtener insumos' });
  }
});

// GET supply by ID
router.get('/:id', async (req, res) => {
  try {
    const all = await db.query(`
      SELECT id, name, type, unit, purchase_price, purchase_quantity, recipe, yield_amount, yield_unit, created_at, updated_at
      FROM supplies
    `);
    const suppliesById = {};
    for (const row of all.rows) {
      suppliesById[row.id] = rowToSupplyInternal(row);
    }
    const supply = suppliesById[req.params.id];
    if (!supply) {
      return res.status(404).json({ error: 'Insumo no encontrado' });
    }
    let costPerUnit = null;
    try {
      costPerUnit = getSupplyCostPerUnit(supply, suppliesById);
    } catch {
      // circular
    }
    const row = all.rows.find((r) => r.id === req.params.id);
    res.json(rowToSupply(row, costPerUnit));
  } catch (error) {
    console.error('Error fetching supply:', error);
    res.status(500).json({ error: 'Error al obtener insumo' });
  }
});

// POST create supply
router.post('/', async (req, res) => {
  try {
    const {
      id,
      name,
      type,
      unit,
      purchasePrice,
      purchaseQuantity,
      recipe,
      yieldAmount,
      yieldUnit,
    } = req.body;

    if (!name || !type) {
      return res.status(400).json({ error: 'name y type son requeridos' });
    }
    if (type !== 'purchased' && type !== 'composed') {
      return res.status(400).json({ error: 'type debe ser "purchased" o "composed"' });
    }

    const supplyId = id && String(id).trim() ? String(id).trim() : randomUUID();

    if (type === 'purchased') {
      if (!unit || !VALID_UNITS.includes(unit)) {
        return res.status(400).json({ error: 'purchased requiere unit (g, ml o unidad)' });
      }
      const qty = purchaseQuantity != null ? Number(purchaseQuantity) : null;
      if (qty == null || isNaN(qty) || qty <= 0) {
        return res.status(400).json({ error: 'purchased requiere purchaseQuantity > 0' });
      }
    }

    if (type === 'composed') {
      const recipeArr = Array.isArray(recipe) ? recipe.map(normalizeRecipeLine).filter(Boolean) : [];
      if (recipeArr.length === 0) {
        return res.status(400).json({ error: 'composed requiere recipe con al menos una línea' });
      }
      if (yieldAmount == null || Number(yieldAmount) <= 0 || !yieldUnit || !VALID_UNITS.includes(yieldUnit)) {
        return res.status(400).json({ error: 'composed requiere yieldAmount y yieldUnit' });
      }
      for (const line of recipeArr) {
        if (line.supplyId === supplyId) {
          return res.status(400).json({ error: 'Un insumo no puede referenciarse a sí mismo en la receta' });
        }
      }
    }

    const recipeJson = type === 'composed' && Array.isArray(recipe)
      ? JSON.stringify(recipe.map(normalizeRecipeLine).filter(Boolean))
      : null;
    const unitVal = type === 'purchased' && unit ? unit : null;
    const purchasePriceVal = type === 'purchased' && purchasePrice != null ? Number(purchasePrice) : null;
    const purchaseQuantityVal = type === 'purchased' && purchaseQuantity != null ? Number(purchaseQuantity) : null;
    const yieldAmountVal = type === 'composed' && yieldAmount != null ? Number(yieldAmount) : null;
    const yieldUnitVal = type === 'composed' && yieldUnit ? yieldUnit : null;

    // Cycle check
    const recipeArrForCandidate =
      type === 'composed' && Array.isArray(recipe)
        ? recipe.map(normalizeRecipeLine).filter(Boolean)
        : [];
    const candidate = {
      id: supplyId,
      name,
      type,
      unit: unitVal,
      purchase_price: purchasePriceVal,
      purchase_quantity: purchaseQuantityVal,
      recipe: recipeArrForCandidate,
      yield_amount: yieldAmountVal,
      yield_unit: yieldUnitVal,
    };
    const allRows = await db.query(
      'SELECT id, name, type, unit, purchase_price, purchase_quantity, recipe, yield_amount, yield_unit FROM supplies',
    );
    const suppliesById = {};
    for (const row of allRows.rows) {
      suppliesById[row.id] = rowToSupplyInternal(row);
    }
    suppliesById[supplyId] = candidate;
    try {
      getSupplyCostPerUnit(candidate, suppliesById);
    } catch (err) {
      if (err.message === 'Circular reference in supply recipe') {
        return res.status(400).json({ error: 'Referencia circular en la receta' });
      }
      throw err;
    }

    await db.query(
      `INSERT INTO supplies (id, name, type, unit, purchase_price, purchase_quantity, recipe, yield_amount, yield_unit)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        supplyId,
        name,
        type,
        unitVal,
        purchasePriceVal,
        purchaseQuantityVal,
        recipeJson,
        yieldAmountVal,
        yieldUnitVal,
      ],
    );

    const row = (
      await db.query(
        `SELECT id, name, type, unit, purchase_price, purchase_quantity, recipe, yield_amount, yield_unit, created_at, updated_at
         FROM supplies WHERE id = $1`,
        [supplyId],
      )
    ).rows[0];
    const supplyInternal = rowToSupplyInternal(row);
    let costPerUnit = null;
    try {
      const map = { ...suppliesById, [supplyId]: supplyInternal };
      costPerUnit = getSupplyCostPerUnit(supplyInternal, map);
    } catch {
      // ignore
    }
    res.status(201).json(rowToSupply(row, costPerUnit));
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Ya existe un insumo con ese ID' });
    }
    console.error('Error creating supply:', error);
    res.status(500).json({ error: 'Error al crear insumo' });
  }
});

// PUT update supply
router.put('/:id', async (req, res) => {
  try {
    const {
      name,
      type,
      unit,
      purchasePrice,
      purchaseQuantity,
      recipe,
      yieldAmount,
      yieldUnit,
    } = req.body;

    if (!name || !type) {
      return res.status(400).json({ error: 'name y type son requeridos' });
    }
    if (type !== 'purchased' && type !== 'composed') {
      return res.status(400).json({ error: 'type debe ser "purchased" o "composed"' });
    }

    const id = req.params.id;

    if (type === 'purchased') {
      if (!unit || !VALID_UNITS.includes(unit)) {
        return res.status(400).json({ error: 'purchased requiere unit (g, ml o unidad)' });
      }
      const qty = purchaseQuantity != null ? Number(purchaseQuantity) : null;
      if (qty == null || isNaN(qty) || qty <= 0) {
        return res.status(400).json({ error: 'purchased requiere purchaseQuantity > 0' });
      }
    }

    if (type === 'composed') {
      const recipeArr = Array.isArray(recipe) ? recipe.map(normalizeRecipeLine).filter(Boolean) : [];
      if (recipeArr.length === 0) {
        return res.status(400).json({ error: 'composed requiere recipe con al menos una línea' });
      }
      if (yieldAmount == null || Number(yieldAmount) <= 0 || !yieldUnit || !VALID_UNITS.includes(yieldUnit)) {
        return res.status(400).json({ error: 'composed requiere yieldAmount y yieldUnit' });
      }
      for (const line of recipeArr) {
        if (line.supplyId === id) {
          return res.status(400).json({ error: 'Un insumo no puede referenciarse a sí mismo en la receta' });
        }
      }
    }

    const recipeJson = type === 'composed' && Array.isArray(recipe)
      ? JSON.stringify(recipe.map(normalizeRecipeLine).filter(Boolean))
      : null;
    const unitVal = type === 'purchased' && unit ? unit : null;
    const purchasePriceVal = type === 'purchased' && purchasePrice != null ? Number(purchasePrice) : null;
    const purchaseQuantityVal = type === 'purchased' && purchaseQuantity != null ? Number(purchaseQuantity) : null;
    const yieldAmountVal = type === 'composed' && yieldAmount != null ? Number(yieldAmount) : null;
    const yieldUnitVal = type === 'composed' && yieldUnit ? yieldUnit : null;

    const recipeArrForCandidate =
      type === 'composed' && Array.isArray(recipe)
        ? recipe.map(normalizeRecipeLine).filter(Boolean)
        : [];
    const candidate = {
      id,
      name,
      type,
      unit: unitVal,
      purchase_price: purchasePriceVal,
      purchase_quantity: purchaseQuantityVal,
      recipe: recipeArrForCandidate,
      yield_amount: yieldAmountVal,
      yield_unit: yieldUnitVal,
    };
    const allRows = await db.query(
      'SELECT id, name, type, unit, purchase_price, purchase_quantity, recipe, yield_amount, yield_unit FROM supplies',
    );
    const suppliesById = {};
    for (const row of allRows.rows) {
      suppliesById[row.id] = rowToSupplyInternal(row);
    }
    suppliesById[id] = candidate;
    try {
      getSupplyCostPerUnit(candidate, suppliesById);
    } catch (err) {
      if (err.message === 'Circular reference in supply recipe') {
        return res.status(400).json({ error: 'Referencia circular en la receta' });
      }
      throw err;
    }

    const result = await db.query(
      `UPDATE supplies
       SET name = $1, type = $2, unit = $3, purchase_price = $4, purchase_quantity = $5, recipe = $6, yield_amount = $7, yield_unit = $8, updated_at = CURRENT_TIMESTAMP
       WHERE id = $9`,
      [
        name,
        type,
        unitVal,
        purchasePriceVal,
        purchaseQuantityVal,
        recipeJson,
        yieldAmountVal,
        yieldUnitVal,
        id,
      ],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Insumo no encontrado' });
    }

    const row = (
      await db.query(
        `SELECT id, name, type, unit, purchase_price, purchase_quantity, recipe, yield_amount, yield_unit, created_at, updated_at
         FROM supplies WHERE id = $1`,
        [id],
      )
    ).rows[0];
    const supplyInternal = rowToSupplyInternal(row);
    const map = { ...suppliesById, [id]: supplyInternal };
    let costPerUnit = null;
    try {
      costPerUnit = getSupplyCostPerUnit(supplyInternal, map);
    } catch {
      // ignore
    }
    res.json(rowToSupply(row, costPerUnit));
  } catch (error) {
    console.error('Error updating supply:', error);
    res.status(500).json({ error: 'Error al actualizar insumo' });
  }
});

// DELETE supply (only if not used in menu or other supplies)
router.delete('/:id', async (req, res) => {
  try {
    const id = req.params.id;

    const menuItems = await db.query('SELECT id, recipe FROM menu_items');
    for (const row of menuItems.rows) {
      const recipe = parseRecipe(row.recipe);
      if (Array.isArray(recipe)) {
        const hasRef = recipe.some((line) => {
          const sid = line?.supplyId ?? line?.supply_id;
          return sid === id;
        });
        if (hasRef) {
          return res.status(400).json({
            error: 'No se puede eliminar: el insumo está en una receta del menú',
          });
        }
      }
    }

    const allSupplies = await db.query('SELECT id, recipe FROM supplies');
    for (const row of allSupplies.rows) {
      if (row.id === id) continue;
      const recipe = parseRecipe(row.recipe);
      if (Array.isArray(recipe)) {
        const hasRef = recipe.some((line) => {
          const sid = line?.supplyId ?? line?.supply_id;
          return sid === id;
        });
        if (hasRef) {
          return res.status(400).json({
            error: 'No se puede eliminar: el insumo está en la receta de otro insumo',
          });
        }
      }
    }

    const result = await db.query('DELETE FROM supplies WHERE id = $1', [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Insumo no encontrado' });
    }
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting supply:', error);
    res.status(500).json({ error: 'Error al eliminar insumo' });
  }
});

export default router;
export { getSupplyCostPerUnit, rowToSupplyInternal, parseRecipe as parseSupplyRecipe };
