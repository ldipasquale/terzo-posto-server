import express from 'express';
import crypto from 'crypto';
import db from '../database.js';

const router = express.Router();

const promotionSelectWithItems = `
  SELECT
    p.*,
    (SELECT COALESCE(json_agg(json_build_object(
      'menuItemId', pi.menu_item_id,
      'quantity', pi.quantity
    ) ORDER BY pi.id), '[]'::json)
    FROM promotion_items pi WHERE pi.promotion_id = p.id) AS items_json
  FROM promotions p
`;

function parseItemsJson(itemsJson) {
  if (Array.isArray(itemsJson)) return itemsJson;
  if (itemsJson) {
    try {
      const parsed = JSON.parse(itemsJson);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function formatPromotion(row) {
  const items = parseItemsJson(row.items_json).map((it) => ({
    menuItemId: String(it.menuItemId),
    quantity: Number(it.quantity),
  }));
  return {
    id: row.id,
    name: row.name,
    description: row.description || undefined,
    items,
    price: Number(row.price),
    active: Boolean(row.active),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function validatePromotionBody(body, { requireItems = true } = {}) {
  const { name, description, items, price, active } = body;

  if (!name || typeof name !== 'string' || !name.trim()) {
    return { error: 'El nombre es requerido' };
  }

  if (price === undefined || price === null || price === '') {
    return { error: 'El precio es requerido' };
  }
  const priceNum = Number(price);
  if (!Number.isFinite(priceNum) || priceNum <= 0) {
    return { error: 'El precio debe ser mayor a 0' };
  }

  if (requireItems) {
    if (!Array.isArray(items) || items.length === 0) {
      return { error: 'La promoción debe incluir al menos un producto' };
    }
    for (const it of items) {
      if (!it?.menuItemId) {
        return { error: 'Cada ítem debe tener menuItemId' };
      }
      const qty = Math.floor(Number(it.quantity));
      if (!Number.isFinite(qty) || qty <= 0) {
        return { error: 'Cantidad de ítem inválida' };
      }
    }
  } else if (items !== undefined) {
    if (!Array.isArray(items) || items.length === 0) {
      return { error: 'La promoción debe incluir al menos un producto' };
    }
    for (const it of items) {
      if (!it?.menuItemId) {
        return { error: 'Cada ítem debe tener menuItemId' };
      }
      const qty = Math.floor(Number(it.quantity));
      if (!Number.isFinite(qty) || qty <= 0) {
        return { error: 'Cantidad de ítem inválida' };
      }
    }
  }

  return {
    data: {
      name: name.trim(),
      description:
        description != null && String(description).trim()
          ? String(description).trim()
          : null,
      price: priceNum,
      active: active === undefined ? true : Boolean(active),
      items: Array.isArray(items)
        ? items.map((it) => ({
            menuItemId: String(it.menuItemId),
            quantity: Math.max(1, Math.floor(Number(it.quantity) || 1)),
          }))
        : undefined,
    },
  };
}

async function assertMenuItemsExist(client, items) {
  const ids = [...new Set(items.map((it) => it.menuItemId))];
  const result = await client.query(
    'SELECT id FROM menu_items WHERE id = ANY($1::text[])',
    [ids],
  );
  if (result.rows.length !== ids.length) {
    const err = new Error('Uno o más productos del menú no existen');
    err.statusCode = 400;
    throw err;
  }
}

async function insertPromotionItems(client, promotionId, items) {
  for (const it of items) {
    await client.query(
      `INSERT INTO promotion_items (promotion_id, menu_item_id, quantity)
       VALUES ($1, $2, $3)`,
      [promotionId, it.menuItemId, it.quantity],
    );
  }
}

// GET all promotions
router.get('/', async (req, res) => {
  try {
    const result = await db.query(
      `${promotionSelectWithItems} ORDER BY p.created_at DESC`,
    );
    res.json(result.rows.map(formatPromotion));
  } catch (error) {
    console.error('Error fetching promotions:', error);
    res.status(500).json({ error: 'Error al obtener promociones' });
  }
});

// GET promotion by ID
router.get('/:id', async (req, res) => {
  try {
    const result = await db.query(
      `${promotionSelectWithItems} WHERE p.id = $1`,
      [req.params.id],
    );
    const row = result.rows[0];
    if (!row) {
      return res.status(404).json({ error: 'Promoción no encontrada' });
    }
    res.json(formatPromotion(row));
  } catch (error) {
    console.error('Error fetching promotion:', error);
    res.status(500).json({ error: 'Error al obtener la promoción' });
  }
});

// CREATE promotion
router.post('/', async (req, res) => {
  try {
    const validated = validatePromotionBody(req.body);
    if (validated.error) {
      return res.status(400).json({ error: validated.error });
    }
    const { name, description, price, active, items } = validated.data;
    const id =
      req.body.id && typeof req.body.id === 'string'
        ? req.body.id
        : crypto.randomUUID();

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await assertMenuItemsExist(client, items);
      await client.query(
        `INSERT INTO promotions (id, name, description, price, active)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, name, description, price, active ? 1 : 0],
      );
      await insertPromotionItems(client, id, items);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      if (e.code === '23505') {
        return res.status(409).json({ error: 'Ya existe una promoción con ese id' });
      }
      if (e.statusCode === 400) {
        return res.status(400).json({ error: e.message });
      }
      throw e;
    } finally {
      client.release();
    }

    const result = await db.query(
      `${promotionSelectWithItems} WHERE p.id = $1`,
      [id],
    );
    res.status(201).json(formatPromotion(result.rows[0]));
  } catch (error) {
    console.error('Error creating promotion:', error);
    res.status(500).json({ error: 'Error al crear la promoción' });
  }
});

// UPDATE promotion
router.put('/:id', async (req, res) => {
  try {
    const validated = validatePromotionBody(req.body, { requireItems: false });
    if (validated.error) {
      return res.status(400).json({ error: validated.error });
    }
    const { name, description, price, active, items } = validated.data;
    const id = req.params.id;

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const existing = await client.query(
        'SELECT id FROM promotions WHERE id = $1',
        [id],
      );
      if (existing.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Promoción no encontrada' });
      }

      if (items) {
        await assertMenuItemsExist(client, items);
      }

      await client.query(
        `UPDATE promotions
         SET name = $1,
             description = $2,
             price = $3,
             active = $4,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $5`,
        [name, description, price, active ? 1 : 0, id],
      );

      if (items) {
        await client.query('DELETE FROM promotion_items WHERE promotion_id = $1', [
          id,
        ]);
        await insertPromotionItems(client, id, items);
      }

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      if (e.statusCode === 400) {
        return res.status(400).json({ error: e.message });
      }
      throw e;
    } finally {
      client.release();
    }

    const result = await db.query(
      `${promotionSelectWithItems} WHERE p.id = $1`,
      [id],
    );
    res.json(formatPromotion(result.rows[0]));
  } catch (error) {
    console.error('Error updating promotion:', error);
    res.status(500).json({ error: 'Error al actualizar la promoción' });
  }
});

// DELETE promotion
router.delete('/:id', async (req, res) => {
  try {
    const result = await db.query('DELETE FROM promotions WHERE id = $1', [
      req.params.id,
    ]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Promoción no encontrada' });
    }
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting promotion:', error);
    res.status(500).json({ error: 'Error al eliminar la promoción' });
  }
});

export default router;
