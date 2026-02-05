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

// Get all menu items
router.get('/', (req, res) => {
  try {
    const items = db.prepare(`
      SELECT 
        id,
        name,
        description,
        price,
        category,
        type,
        available,
        popular,
        portions,
        recipe
      FROM menu_items
      ORDER BY category, name
    `).all();

    const formattedItems = items.map(item => ({
      id: item.id,
      name: item.name,
      description: item.description,
      price: item.price,
      category: item.category,
      type: item.type,
      available: Boolean(item.available),
      popular: Boolean(item.popular),
      portions: item.portions != null ? item.portions : 1,
      recipe: parseRecipe(item.recipe)
    }));

    res.json(formattedItems);
  } catch (error) {
    console.error('Error fetching menu items:', error);
    res.status(500).json({ error: 'Error al obtener el menú' });
  }
});

// Get menu item by ID
router.get('/:id', (req, res) => {
  try {
    const item = db.prepare(`
      SELECT 
        id,
        name,
        description,
        price,
        category,
        type,
        available,
        popular,
        portions,
        recipe
      FROM menu_items
      WHERE id = ?
    `).get(req.params.id);

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
      recipe: parseRecipe(item.recipe)
    });
  } catch (error) {
    console.error('Error fetching menu item:', error);
    res.status(500).json({ error: 'Error al obtener el item del menú' });
  }
});

// Create menu item
router.post('/', (req, res) => {
  try {
    const { id, name, description, price, category, type, available, popular, portions, recipe } = req.body;

    if (!id || !name || !description || price === undefined || !category || !type) {
      return res.status(400).json({ error: 'Datos del item incompletos' });
    }

    if (type !== 'comida' && type !== 'bebida') {
      return res.status(400).json({ error: 'Tipo debe ser "comida" o "bebida"' });
    }

    const recipeJson = Array.isArray(recipe) ? JSON.stringify(recipe) : '[]';
    const portionsNum = typeof portions === 'number' && portions >= 1 ? portions : 1;

    const insertItem = db.prepare(`
      INSERT INTO menu_items (id, name, description, price, category, type, available, popular, portions, recipe)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertItem.run(
      id,
      name,
      description,
      price,
      category,
      type,
      available ? 1 : 0,
      popular ? 1 : 0,
      portionsNum,
      recipeJson
    );

    const item = db.prepare(`
      SELECT id, name, description, price, category, type, available, popular, portions, recipe
      FROM menu_items WHERE id = ?
    `).get(id);

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
      recipe: parseRecipe(item.recipe)
    });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'El ID del item ya existe' });
    }
    console.error('Error creating menu item:', error);
    res.status(500).json({ error: 'Error al crear el item del menú' });
  }
});

// Update menu item
router.put('/:id', (req, res) => {
  try {
    const { name, description, price, category, type, available, popular, portions, recipe } = req.body;

    const recipeJson = Array.isArray(recipe) ? JSON.stringify(recipe) : '[]';
    const portionsNum = typeof portions === 'number' && portions >= 1 ? portions : 1;

    const updateItem = db.prepare(`
      UPDATE menu_items 
      SET name = ?,
          description = ?,
          price = ?,
          category = ?,
          type = ?,
          available = ?,
          popular = ?,
          portions = ?,
          recipe = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    const result = updateItem.run(
      name,
      description,
      price,
      category,
      type,
      available ? 1 : 0,
      popular ? 1 : 0,
      portionsNum,
      recipeJson,
      req.params.id
    );

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Item del menú no encontrado' });
    }

    const item = db.prepare(`
      SELECT id, name, description, price, category, type, available, popular, portions, recipe
      FROM menu_items WHERE id = ?
    `).get(req.params.id);

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
      recipe: parseRecipe(item.recipe)
    });
  } catch (error) {
    console.error('Error updating menu item:', error);
    res.status(500).json({ error: 'Error al actualizar el item del menú' });
  }
});

// Delete menu item
router.delete('/:id', (req, res) => {
  try {
    // Check if item is used in any orders
    const orderItemsCount = db.prepare(`
      SELECT COUNT(*) as count 
      FROM order_items 
      WHERE menu_item_id = ?
    `).get(req.params.id);

    if (orderItemsCount.count > 0) {
      return res.status(400).json({ 
        error: 'No se puede eliminar el item porque está asociado a pedidos existentes' 
      });
    }

    const deleteItem = db.prepare('DELETE FROM menu_items WHERE id = ?');
    const result = deleteItem.run(req.params.id);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Item del menú no encontrado' });
    }

    res.status(204).send();
  } catch (error) {
    console.error('Error deleting menu item:', error);
    res.status(500).json({ error: 'Error al eliminar el item del menú' });
  }
});

export default router;
