import express from 'express';
import crypto from 'crypto';
import db from '../database.js';
import {
  getCupPrice,
  invalidateCupPriceCache,
  BUFFET_CUP_PRICE_SETTINGS_KEY,
} from '../lib/cupPrice.js';

const router = express.Router();

const discountPresetSelect = `
  SELECT
    dp.id,
    dp.name,
    dp.percent,
    (SELECT COALESCE(json_agg(dpm.menu_item_id ORDER BY dpm.menu_item_id), '[]'::json)
     FROM discount_preset_menu_items dpm
     WHERE dpm.discount_preset_id = dp.id) AS menu_item_ids_json
  FROM discount_presets dp
`;

function parseMenuItemIdsJson(menuItemIdsJson) {
  if (Array.isArray(menuItemIdsJson)) {
    return menuItemIdsJson.map((id) => String(id));
  }
  if (menuItemIdsJson) {
    try {
      const parsed = JSON.parse(menuItemIdsJson);
      return Array.isArray(parsed) ? parsed.map((id) => String(id)) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function formatDiscountPreset(row) {
  const preset = {
    id: row.id,
    name: row.name,
    percent: Number(row.percent),
  };
  const menuItemIds = parseMenuItemIdsJson(row.menu_item_ids_json);
  if (menuItemIds.length > 0) {
    preset.menuItemIds = menuItemIds;
  }
  return preset;
}

function normalizeMenuItemIds(menuItemIds) {
  if (menuItemIds === undefined || menuItemIds === null) {
    return undefined;
  }
  if (!Array.isArray(menuItemIds)) {
    return { error: 'menuItemIds debe ser un arreglo' };
  }
  const ids = [...new Set(menuItemIds.map((id) => String(id)).filter(Boolean))];
  return { menuItemIds: ids };
}

async function assertMenuItemIdsExist(client, menuItemIds) {
  if (menuItemIds.length === 0) return;
  const result = await client.query(
    'SELECT id FROM menu_items WHERE id = ANY($1::text[])',
    [menuItemIds],
  );
  if (result.rows.length !== menuItemIds.length) {
    const err = new Error('Uno o más productos del menú no existen');
    err.statusCode = 400;
    throw err;
  }
}

async function replaceDiscountPresetMenuItems(client, presetId, menuItemIds) {
  await client.query(
    'DELETE FROM discount_preset_menu_items WHERE discount_preset_id = $1',
    [presetId],
  );
  for (const menuItemId of menuItemIds) {
    await client.query(
      `INSERT INTO discount_preset_menu_items (discount_preset_id, menu_item_id)
       VALUES ($1, $2)`,
      [presetId, menuItemId],
    );
  }
}

function validateDiscountPresetBody(body, { partial = false } = {}) {
  const { name, percent, menuItemIds } = body;

  if (!partial || name !== undefined) {
    if (!name || typeof name !== 'string' || !name.trim()) {
      return { error: 'El nombre es requerido' };
    }
  }

  if (!partial || percent !== undefined) {
    if (percent === undefined || percent === null || percent === '') {
      return { error: 'El porcentaje es requerido' };
    }
    const percentNum = Number(percent);
    if (!Number.isFinite(percentNum) || percentNum <= 0 || percentNum > 100) {
      return { error: 'El porcentaje debe estar entre 1 y 100' };
    }
  }

  let normalizedMenuItemIds;
  if (!partial || menuItemIds !== undefined) {
    const normalized = normalizeMenuItemIds(menuItemIds);
    if (normalized?.error) {
      return { error: normalized.error };
    }
    normalizedMenuItemIds = normalized.menuItemIds;
  }

  return {
    data: {
      name: name !== undefined ? name.trim() : undefined,
      percent: percent !== undefined ? Number(percent) : undefined,
      menuItemIds: normalizedMenuItemIds,
    },
  };
}

/** Buffet: precio depósito vasos retornables (ARS) */
router.get('/buffet', async (_req, res) => {
  try {
    const cupPrice = await getCupPrice();
    res.json({ cupPrice });
  } catch (error) {
    console.error('Error fetching buffet settings:', error);
    res.status(500).json({ error: 'Error al obtener la configuración del buffet' });
  }
});

router.put('/buffet', async (req, res) => {
  try {
    const raw = req.body?.cupPrice;
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n) || n < 1 || n > 1_000_000) {
      return res.status(400).json({
        error: 'Precio inválido: ingresá un entero entre 1 y 1.000.000',
      });
    }
    await db.query(
      `INSERT INTO settings (key, value, updated_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
      [BUFFET_CUP_PRICE_SETTINGS_KEY, String(n)],
    );
    invalidateCupPriceCache();
    res.json({ cupPrice: n });
  } catch (error) {
    console.error('Error updating buffet settings:', error);
    res.status(500).json({ error: 'Error al guardar la configuración del buffet' });
  }
});

/** Descuentos reutilizables (configuración → comandas) */
router.get('/discount-presets', async (_req, res) => {
  try {
    const result = await db.query(
      `${discountPresetSelect}
       ORDER BY dp.name ASC`,
    );
    res.json(result.rows.map(formatDiscountPreset));
  } catch (error) {
    console.error('Error fetching discount presets:', error);
    res.status(500).json({ error: 'Error al obtener los descuentos' });
  }
});

router.post('/discount-presets', async (req, res) => {
  try {
    const validated = validateDiscountPresetBody(req.body);
    if (validated.error) {
      return res.status(400).json({ error: validated.error });
    }
    const { name, percent, menuItemIds = [] } = validated.data;
    const id =
      req.body.id && typeof req.body.id === 'string'
        ? req.body.id
        : crypto.randomUUID();

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await assertMenuItemIdsExist(client, menuItemIds);
      await client.query(
        `INSERT INTO discount_presets (id, name, percent)
         VALUES ($1, $2, $3)`,
        [id, name, percent],
      );
      if (menuItemIds.length > 0) {
        await replaceDiscountPresetMenuItems(client, id, menuItemIds);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      if (e.code === '23505') {
        return res.status(409).json({ error: 'Ya existe un descuento con ese id' });
      }
      if (e.statusCode === 400) {
        return res.status(400).json({ error: e.message });
      }
      throw e;
    } finally {
      client.release();
    }

    const result = await db.query(
      `${discountPresetSelect} WHERE dp.id = $1`,
      [id],
    );
    res.status(201).json(formatDiscountPreset(result.rows[0]));
  } catch (error) {
    console.error('Error creating discount preset:', error);
    res.status(500).json({ error: 'Error al crear el descuento' });
  }
});

router.put('/discount-presets/:id', async (req, res) => {
  try {
    const validated = validateDiscountPresetBody(req.body, { partial: true });
    if (validated.error) {
      return res.status(400).json({ error: validated.error });
    }
    const { name, percent, menuItemIds } = validated.data;
    if (
      name === undefined &&
      percent === undefined &&
      menuItemIds === undefined
    ) {
      return res.status(400).json({ error: 'No hay campos para actualizar' });
    }

    const id = req.params.id;
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const existing = await client.query(
        `SELECT id FROM discount_presets WHERE id = $1`,
        [id],
      );
      if (existing.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Descuento no encontrado' });
      }

      if (menuItemIds !== undefined) {
        await assertMenuItemIdsExist(client, menuItemIds);
      }

      if (name !== undefined || percent !== undefined) {
        await client.query(
          `UPDATE discount_presets
           SET name = COALESCE($1, name),
               percent = COALESCE($2, percent),
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $3`,
          [name ?? null, percent ?? null, id],
        );
      } else if (menuItemIds !== undefined) {
        await client.query(
          `UPDATE discount_presets
           SET updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [id],
        );
      }

      if (menuItemIds !== undefined) {
        await replaceDiscountPresetMenuItems(client, id, menuItemIds);
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
      `${discountPresetSelect} WHERE dp.id = $1`,
      [id],
    );
    res.json(formatDiscountPreset(result.rows[0]));
  } catch (error) {
    console.error('Error updating discount preset:', error);
    res.status(500).json({ error: 'Error al actualizar el descuento' });
  }
});

router.delete('/discount-presets/:id', async (req, res) => {
  try {
    const result = await db.query(`DELETE FROM discount_presets WHERE id = $1`, [
      req.params.id,
    ]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Descuento no encontrado' });
    }
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting discount preset:', error);
    res.status(500).json({ error: 'Error al eliminar el descuento' });
  }
});

// Get all Mercado Pago accounts
router.get('/mercado-pago', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, holder, alias, is_default, active
      FROM mercado_pago_accounts
      WHERE id != 'efectivo' AND COALESCE(kind, 'mercadopago') = 'mercadopago'
      ORDER BY is_default DESC, created_at ASC
    `);

    const formattedAccounts = result.rows.map((account) => ({
      id: account.id,
      holder: account.holder,
      alias: account.alias,
      isDefault: Boolean(account.is_default),
      active: Boolean(account.active),
    }));

    res.json(formattedAccounts);
  } catch (error) {
    console.error('Error fetching Mercado Pago accounts:', error);
    res.status(500).json({ error: 'Error al obtener las cuentas de Mercado Pago' });
  }
});

// Create Mercado Pago account
router.post('/mercado-pago', async (req, res) => {
  try {
    const { holder, alias, isDefault, active } = req.body;

    if (!holder || !alias) {
      return res.status(400).json({ error: 'Titular y alias son requeridos' });
    }

    if (isDefault) {
      await db.query('UPDATE mercado_pago_accounts SET is_default = 0');
    } else {
      const defaultCount = await db.query(
        'SELECT COUNT(*)::int AS count FROM mercado_pago_accounts WHERE is_default = 1'
      );
      // If no default exists, we'll set this one as default below
    }

    const accountId = Date.now().toString();
    const accountCount = await db.query('SELECT COUNT(*)::int AS count FROM mercado_pago_accounts');
    const shouldBeDefault = isDefault || accountCount.rows[0].count === 0;

    await db.query(
      `INSERT INTO mercado_pago_accounts (id, holder, alias, is_default, active, kind)
       VALUES ($1, $2, $3, $4, $5, 'mercadopago')`,
      [accountId, holder, alias, shouldBeDefault ? 1 : 0, active !== false ? 1 : 0]
    );

    const result = await db.query(
      `SELECT id, holder, alias, is_default, active
       FROM mercado_pago_accounts WHERE id = $1`,
      [accountId]
    );
    const account = result.rows[0];

    res.status(201).json({
      id: account.id,
      holder: account.holder,
      alias: account.alias,
      isDefault: Boolean(account.is_default),
      active: Boolean(account.active),
    });
  } catch (error) {
    console.error('Error creating Mercado Pago account:', error);
    res.status(500).json({ error: 'Error al crear la cuenta de Mercado Pago' });
  }
});

// Update Mercado Pago account
router.put('/mercado-pago/:id', async (req, res) => {
  try {
    if (req.params.id === 'efectivo') {
      return res.status(400).json({ error: 'No se puede editar la cuenta de efectivo' });
    }
    const { holder, alias, isDefault, active } = req.body;

    if (isDefault) {
      await db.query('UPDATE mercado_pago_accounts SET is_default = 0 WHERE id != $1', [
        req.params.id,
      ]);
    }

    const result = await db.query(
      `UPDATE mercado_pago_accounts
       SET holder = $1, alias = $2, is_default = $3, active = $4
       WHERE id = $5`,
      [holder, alias, isDefault ? 1 : 0, active !== false ? 1 : 0, req.params.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Cuenta de Mercado Pago no encontrada' });
    }

    const accountResult = await db.query(
      `SELECT id, holder, alias, is_default, active
       FROM mercado_pago_accounts WHERE id = $1`,
      [req.params.id]
    );
    const account = accountResult.rows[0];

    res.json({
      id: account.id,
      holder: account.holder,
      alias: account.alias,
      isDefault: Boolean(account.is_default),
      active: Boolean(account.active),
    });
  } catch (error) {
    console.error('Error updating Mercado Pago account:', error);
    res.status(500).json({ error: 'Error al actualizar la cuenta de Mercado Pago' });
  }
});

// Delete Mercado Pago account
router.delete('/mercado-pago/:id', async (req, res) => {
  try {
    if (req.params.id === 'efectivo') {
      return res.status(400).json({ error: 'No se puede eliminar la cuenta de efectivo' });
    }

    const countResult = await db.query(
      `SELECT COUNT(*)::int AS count FROM orders WHERE mercado_pago_account_id = $1`,
      [req.params.id]
    );

    if (countResult.rows[0].count > 0) {
      return res.status(400).json({
        error: 'No se puede eliminar la cuenta porque está asociada a pedidos existentes',
      });
    }

    const result = await db.query('DELETE FROM mercado_pago_accounts WHERE id = $1', [
      req.params.id,
    ]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Cuenta de Mercado Pago no encontrada' });
    }

    res.status(204).send();
  } catch (error) {
    console.error('Error deleting Mercado Pago account:', error);
    res.status(500).json({ error: 'Error al eliminar la cuenta de Mercado Pago' });
  }
});

export default router;
