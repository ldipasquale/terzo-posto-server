import express from 'express';
import db from '../database.js';

const router = express.Router();

// Get all Mercado Pago accounts
router.get('/mercado-pago', (req, res) => {
  try {
    const accounts = db.prepare(`
      SELECT id, holder, alias, is_default, active
      FROM mercado_pago_accounts
      ORDER BY is_default DESC, created_at ASC
    `).all();

    const formattedAccounts = accounts.map(account => ({
      id: account.id,
      holder: account.holder,
      alias: account.alias,
      isDefault: Boolean(account.is_default),
      active: Boolean(account.active)
    }));

    res.json(formattedAccounts);
  } catch (error) {
    console.error('Error fetching Mercado Pago accounts:', error);
    res.status(500).json({ error: 'Error al obtener las cuentas de Mercado Pago' });
  }
});

// Create Mercado Pago account
router.post('/mercado-pago', (req, res) => {
  try {
    const { holder, alias, isDefault, active } = req.body;

    if (!holder || !alias) {
      return res.status(400).json({ error: 'Titular y alias son requeridos' });
    }

    // If this is set as default, unset other defaults
    if (isDefault) {
      db.prepare('UPDATE mercado_pago_accounts SET is_default = 0').run();
    } else {
      // If no default exists, make this one default
      const defaultCount = db.prepare('SELECT COUNT(*) as count FROM mercado_pago_accounts WHERE is_default = 1').get();
      if (defaultCount.count === 0) {
        // Will set as default below
      }
    }

    const accountId = Date.now().toString();
    const shouldBeDefault = isDefault || db.prepare('SELECT COUNT(*) as count FROM mercado_pago_accounts').get().count === 0;

    const insertAccount = db.prepare(`
      INSERT INTO mercado_pago_accounts (id, holder, alias, is_default, active)
      VALUES (?, ?, ?, ?, ?)
    `);

    insertAccount.run(accountId, holder, alias, shouldBeDefault ? 1 : 0, active !== false ? 1 : 0);

    const account = db.prepare(`
      SELECT id, holder, alias, is_default, active
      FROM mercado_pago_accounts
      WHERE id = ?
    `).get(accountId);

    res.status(201).json({
      id: account.id,
      holder: account.holder,
      alias: account.alias,
      isDefault: Boolean(account.is_default),
      active: Boolean(account.active)
    });
  } catch (error) {
    console.error('Error creating Mercado Pago account:', error);
    res.status(500).json({ error: 'Error al crear la cuenta de Mercado Pago' });
  }
});

// Update Mercado Pago account
router.put('/mercado-pago/:id', (req, res) => {
  try {
    const { holder, alias, isDefault, active } = req.body;

    // If setting as default, unset other defaults
    if (isDefault) {
      db.prepare('UPDATE mercado_pago_accounts SET is_default = 0 WHERE id != ?').run(req.params.id);
    }

    const updateAccount = db.prepare(`
      UPDATE mercado_pago_accounts
      SET holder = ?, alias = ?, is_default = ?, active = ?
      WHERE id = ?
    `);

    const result = updateAccount.run(
      holder,
      alias,
      isDefault ? 1 : 0,
      active !== false ? 1 : 0,
      req.params.id
    );

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Cuenta de Mercado Pago no encontrada' });
    }

    const account = db.prepare(`
      SELECT id, holder, alias, is_default, active
      FROM mercado_pago_accounts
      WHERE id = ?
    `).get(req.params.id);

    res.json({
      id: account.id,
      holder: account.holder,
      alias: account.alias,
      isDefault: Boolean(account.is_default),
      active: Boolean(account.active)
    });
  } catch (error) {
    console.error('Error updating Mercado Pago account:', error);
    res.status(500).json({ error: 'Error al actualizar la cuenta de Mercado Pago' });
  }
});

// Delete Mercado Pago account
router.delete('/mercado-pago/:id', (req, res) => {
  try {
    // Check if account is used in any orders
    const orderCount = db.prepare(`
      SELECT COUNT(*) as count 
      FROM orders 
      WHERE mercado_pago_account_id = ?
    `).get(req.params.id);

    if (orderCount.count > 0) {
      return res.status(400).json({ 
        error: 'No se puede eliminar la cuenta porque está asociada a pedidos existentes' 
      });
    }

    const deleteAccount = db.prepare('DELETE FROM mercado_pago_accounts WHERE id = ?');
    const result = deleteAccount.run(req.params.id);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Cuenta de Mercado Pago no encontrada' });
    }

    res.status(204).send();
  } catch (error) {
    console.error('Error deleting Mercado Pago account:', error);
    res.status(500).json({ error: 'Error al eliminar la cuenta de Mercado Pago' });
  }
});

export default router;
