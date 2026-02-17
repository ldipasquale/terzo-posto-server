import express from 'express';
import db from '../database.js';

const router = express.Router();

function parseRecipe(recipeJson) {
  if (typeof recipeJson !== 'string') return [];
  try {
    const arr = JSON.parse(recipeJson);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** Normalize recipe lines to { supplyId, quantity } for the frontend */
function normalizeMenuRecipe(recipe) {
  if (!Array.isArray(recipe)) return [];
  return recipe
    .filter((line) => line && (line.supplyId != null || line.supply_id != null) && line.quantity != null)
    .map((line) => ({
      supplyId: String(line.supplyId ?? line.supply_id),
      quantity: Number(line.quantity),
    }));
}

// Get all menu items
router.get('/', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, name, description, price, category, type, available, popular, portions, recipe
      FROM menu_items
      ORDER BY category, name
    `);

    const formattedItems = result.rows.map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      price: item.price,
      category: item.category,
      type: item.type,
      available: Boolean(item.available),
      popular: Boolean(item.popular),
      portions: item.portions != null ? item.portions : 1,
      recipe: normalizeMenuRecipe(parseRecipe(item.recipe)),
    }));

    res.json(formattedItems);
  } catch (error) {
    console.error('Error fetching menu items:', error);
    res.status(500).json({ error: 'Error al obtener el menú' });
  }
});

// Get menu item by ID
router.get('/:id', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, description, price, category, type, available, popular, portions, recipe
       FROM menu_items WHERE id = $1`,
      [req.params.id]
    );
    const item = result.rows[0];

    if (!item) {
      return res.status(404).json({ error: 'Item del menú no encontrado' });
    }

    res.json({
      id: item.id,
      name: item.name,
      description: item.description,
      price: item.price,
      category: item.category,
      type: item.type,
      available: Boolean(item.available),
      popular: Boolean(item.popular),
      portions: item.portions != null ? item.portions : 1,
      recipe: normalizeMenuRecipe(parseRecipe(item.recipe)),
    });
  } catch (error) {
    console.error('Error fetching menu item:', error);
    res.status(500).json({ error: 'Error al obtener el item del menú' });
  }
});

// Create menu item
router.post('/', async (req, res) => {
  try {
    const { id, name, description, price, category, type, available, popular, portions, recipe } = req.body;

    if (!id || !name || !description || price === undefined || !category || !type) {
      return res.status(400).json({ error: 'Datos del item incompletos' });
    }

    if (type !== 'comida' && type !== 'bebida') {
      return res.status(400).json({ error: 'Tipo debe ser "comida" o "bebida"' });
    }

    const recipeNormalized = Array.isArray(recipe) ? normalizeMenuRecipe(recipe) : [];
    const recipeJson = JSON.stringify(recipeNormalized);
    const portionsNum = typeof portions === 'number' && portions >= 1 ? portions : 1;

    await db.query(
      `INSERT INTO menu_items (id, name, description, price, category, type, available, popular, portions, recipe)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        name,
        description,
        price,
        category,
        type,
        available ? 1 : 0,
        popular ? 1 : 0,
        portionsNum,
        recipeJson,
      ]
    );

    const result = await db.query(
      `SELECT id, name, description, price, category, type, available, popular, portions, recipe
       FROM menu_items WHERE id = $1`,
      [id]
    );
    const item = result.rows[0];

    res.status(201).json({
      id: item.id,
      name: item.name,
      description: item.description,
      price: item.price,
      category: item.category,
      type: item.type,
      available: Boolean(item.available),
      popular: Boolean(item.popular),
      portions: item.portions != null ? item.portions : 1,
      recipe: normalizeMenuRecipe(parseRecipe(item.recipe)),
    });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'El ID del item ya existe' });
    }
    console.error('Error creating menu item:', error);
    res.status(500).json({ error: 'Error al crear el item del menú' });
  }
});

// Update menu item
router.put('/:id', async (req, res) => {
  try {
    const { name, description, price, category, type, available, popular, portions, recipe } = req.body;

    const recipeNormalized = Array.isArray(recipe) ? normalizeMenuRecipe(recipe) : [];
    const recipeJson = JSON.stringify(recipeNormalized);
    const portionsNum = typeof portions === 'number' && portions >= 1 ? portions : 1;

    const result = await db.query(
      `UPDATE menu_items
       SET name = $1, description = $2, price = $3, category = $4, type = $5,
           available = $6, popular = $7, portions = $8, recipe = $9, updated_at = CURRENT_TIMESTAMP
       WHERE id = $10`,
      [
        name,
        description,
        price,
        category,
        type,
        available ? 1 : 0,
        popular ? 1 : 0,
        portionsNum,
        recipeJson,
        req.params.id,
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Item del menú no encontrado' });
    }

    const itemResult = await db.query(
      `SELECT id, name, description, price, category, type, available, popular, portions, recipe
       FROM menu_items WHERE id = $1`,
      [req.params.id]
    );
    const item = itemResult.rows[0];

    res.json({
      id: item.id,
      name: item.name,
      description: item.description,
      price: item.price,
      category: item.category,
      type: item.type,
      available: Boolean(item.available),
      popular: Boolean(item.popular),
      portions: item.portions != null ? item.portions : 1,
      recipe: normalizeMenuRecipe(parseRecipe(item.recipe)),
    });
  } catch (error) {
    console.error('Error updating menu item:', error);
    res.status(500).json({ error: 'Error al actualizar el item del menú' });
  }
});

// Delete menu item
router.delete('/:id', async (req, res) => {
  try {
    const countResult = await db.query(
      `SELECT COUNT(*)::int AS count FROM order_items WHERE menu_item_id = $1`,
      [req.params.id]
    );

    if (countResult.rows[0].count > 0) {
      return res.status(400).json({
        error: 'No se puede eliminar el item porque está asociado a pedidos existentes',
      });
    }

    const result = await db.query('DELETE FROM menu_items WHERE id = $1', [req.params.id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Item del menú no encontrado' });
    }

    res.status(204).send();
  } catch (error) {
    console.error('Error deleting menu item:', error);
    res.status(500).json({ error: 'Error al eliminar el item del menú' });
  }
});

export default router;
