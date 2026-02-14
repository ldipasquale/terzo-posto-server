import express from 'express';
import db from '../database.js';

const router = express.Router();

// Get all Mercado Pago accounts
router.get('/mercado-pago', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, holder, alias, is_default, active
      FROM mercado_pago_accounts
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
      `INSERT INTO mercado_pago_accounts (id, holder, alias, is_default, active)
       VALUES ($1, $2, $3, $4, $5)`,
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
