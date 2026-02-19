import express from 'express';
import db from '../database.js';
import { randomUUID } from 'crypto';

const router = express.Router();

/**
 * GET /open-accounts?cashRegisterId=xxx
 * List open accounts (status = 'open') for the given cash register.
 * Response: array of { id, customerName, orderIds, total, cashRegisterId, createdAt }
 */
router.get('/', async (req, res) => {
  try {
    const { cashRegisterId } = req.query;
    if (!cashRegisterId) {
      return res.status(400).json({ error: 'cashRegisterId es requerido' });
    }

    const accounts = await db.query(
      `SELECT id, name, cash_register_id, status, created_at
       FROM open_accounts
       WHERE cash_register_id = $1 AND status = 'open'
       ORDER BY created_at ASC`,
      [cashRegisterId]
    );

    const result = [];
    for (const row of accounts.rows) {
      const orders = await db.query(
        `SELECT id, total FROM orders WHERE open_account_id = $1 ORDER BY created_at ASC`,
        [row.id]
      );
      const orderIds = orders.rows.map((o) => o.id);
      const total = orders.rows.reduce((sum, o) => sum + Number(o.total), 0);
      result.push({
        id: row.id,
        customerName: row.name,
        orderIds,
        total,
        cashRegisterId: row.cash_register_id,
        createdAt: new Date(row.created_at).toISOString(),
      });
    }

    res.json(result);
  } catch (error) {
    console.error('Error fetching open accounts:', error);
    res.status(500).json({ error: 'Error al obtener cuentas abiertas' });
  }
});

/**
 * POST /open-accounts
 * Body: { name, cashRegisterId }
 * Create a new open account.
 */
router.post('/', async (req, res) => {
  try {
    const { name, cashRegisterId } = req.body;
    if (!name || !cashRegisterId) {
      return res.status(400).json({ error: 'name y cashRegisterId son requeridos' });
    }

    const id = randomUUID();
    await db.query(
      `INSERT INTO open_accounts (id, name, cash_register_id, status)
       VALUES ($1, $2, $3, 'open')`,
      [id, name.trim(), cashRegisterId]
    );

    const row = (await db.query(
      'SELECT id, name, cash_register_id, created_at FROM open_accounts WHERE id = $1',
      [id]
    )).rows[0];

    res.status(201).json({
      id: row.id,
      customerName: row.name,
      orderIds: [],
      total: 0,
      cashRegisterId: row.cash_register_id,
      createdAt: new Date(row.created_at).toISOString(),
    });
  } catch (error) {
    if (error.code === '23503') {
      return res.status(400).json({ error: 'cash_register_id no válido' });
    }
    console.error('Error creating open account:', error);
    res.status(500).json({ error: 'Error al crear cuenta abierta' });
  }
});

/**
 * POST /open-accounts/:id/close
 * Body: { paymentMethod: 'efectivo' | 'mercadopago', mercadoPagoAccountId?: string, discount?: number, discountReason?: string }
 * Close the account: update all related orders with the payment method and set closed_open_account_* for history.
 */
router.post('/:id/close', async (req, res) => {
  try {
    const id = req.params.id;
    const { paymentMethod, mercadoPagoAccountId, discount, discountReason } = req.body;

    if (!paymentMethod || !['efectivo', 'mercadopago'].includes(paymentMethod)) {
      return res.status(400).json({ error: 'paymentMethod debe ser "efectivo" o "mercadopago"' });
    }
    if (paymentMethod === 'mercadopago' && !mercadoPagoAccountId) {
      return res.status(400).json({ error: 'mercadoPagoAccountId requerido para mercadopago' });
    }

    const accountRow = (await db.query(
      'SELECT id, name, status FROM open_accounts WHERE id = $1',
      [id]
    )).rows[0];

    if (!accountRow) {
      return res.status(404).json({ error: 'Cuenta abierta no encontrada' });
    }
    if (accountRow.status !== 'open') {
      return res.status(400).json({ error: 'La cuenta ya está cerrada' });
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // If there's a discount, apply it to orders from last to first until fully applied
      const hasDiscount = discount != null && Number(discount) > 0;
      let ordersToDiscount = [];
      if (hasDiscount && discountReason && String(discountReason).trim()) {
        const ordersResult = await client.query(
          `SELECT id, total, discount, discount_reason FROM orders
           WHERE open_account_id = $1
           ORDER BY created_at DESC`,
          [id]
        );
        ordersToDiscount = ordersResult.rows || [];
      }

      await client.query(
        `UPDATE orders
         SET payment_method = $1,
             mercado_pago_account_id = $2,
             closed_open_account_id = $3,
             closed_open_account_name = $4,
             open_account_id = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE open_account_id = $3`,
        [
          paymentMethod,
          paymentMethod === 'mercadopago' ? mercadoPagoAccountId : null,
          id,
          accountRow.name,
        ]
      );

      if (ordersToDiscount.length > 0) {
        const discountAmount = Number(discount);
        const accountReasonPart = 'Descuento de la cuenta: ' + String(discountReason).trim();
        let remainingDiscount = discountAmount;

        for (const order of ordersToDiscount) {
          if (remainingDiscount <= 0) break;

          const currentTotal = Number(order.total);
          const applyHere = Math.min(remainingDiscount, Math.max(0, currentTotal));
          if (applyHere <= 0) continue;

          const existingDiscount = order.discount != null ? Number(order.discount) : 0;
          const existingReason = (order.discount_reason && String(order.discount_reason).trim()) || '';
          const newTotal = currentTotal - applyHere;
          const newDiscount = existingDiscount + applyHere;
          const newReason = existingReason ? existingReason + ' ' + accountReasonPart : accountReasonPart;

          await client.query(
            `UPDATE orders
             SET total = $1, discount = $2, discount_reason = $3, updated_at = CURRENT_TIMESTAMP
             WHERE id = $4`,
            [newTotal, newDiscount, newReason, order.id]
          );

          remainingDiscount -= applyHere;
        }
      }

      await client.query(
        `UPDATE open_accounts
         SET status = 'closed',
             closed_at = CURRENT_TIMESTAMP,
             payment_method_used = $1,
             mercado_pago_account_id = $2,
             closed_discount = $3,
             closed_discount_reason = $4,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $5`,
        [
          paymentMethod,
          paymentMethod === 'mercadopago' ? mercadoPagoAccountId : null,
          discount != null ? Number(discount) : null,
          discountReason && String(discountReason).trim() ? String(discountReason).trim() : null,
          id,
        ]
      );

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    res.json({
      ok: true,
      message: 'Cuenta cerrada correctamente',
    });
  } catch (error) {
    console.error('Error closing open account:', error);
    res.status(500).json({ error: 'Error al cerrar la cuenta' });
  }
});

export default router;
