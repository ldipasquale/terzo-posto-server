import express from 'express';
import crypto from 'crypto';
import db from '../database.js';
import { getCupPrice } from '../lib/cupPrice.js';

const router = express.Router();

async function assertMercadoPagoLiquidityAccount(client, mercadoPagoAccountId) {
  const mp = await client.query(
    "SELECT id FROM mercado_pago_accounts WHERE id = $1 AND id != 'efectivo'",
    [mercadoPagoAccountId],
  );
  if (!mp.rows[0]) {
    const err = new Error('Cuenta de Mercado Pago no encontrada');
    err.statusCode = 400;
    throw err;
  }
}

function formatMovement(row) {
  return {
    id: row.id,
    cashRegisterId: row.cash_register_id,
    type: row.type,
    quantity: Number(row.quantity),
    amount: Number(row.amount),
    paymentMethod: row.payment_method || undefined,
    mercadoPagoAccountId: row.mercado_pago_account_id || undefined,
    openAccountId: row.open_account_id || undefined,
    orderId: row.order_id || undefined,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** GET /api/cups/circulation?cashRegisterId= */
router.get('/circulation', async (req, res) => {
  try {
    const { cashRegisterId } = req.query;
    if (!cashRegisterId || typeof cashRegisterId !== 'string') {
      return res.status(400).json({ error: 'cashRegisterId es requerido' });
    }

    const cr = await db.query('SELECT id FROM cash_registers WHERE id = $1', [
      cashRegisterId,
    ]);
    if (!cr.rows[0]) {
      return res.status(404).json({ error: 'Caja no encontrada' });
    }

    const agg = await db.query(
      `SELECT
        COALESCE(SUM(CASE WHEN type = 'delivery' THEN quantity ELSE 0 END), 0)::int AS delivered,
        COALESCE(SUM(CASE WHEN type = 'return' THEN quantity ELSE 0 END), 0)::int AS returned,
        COALESCE(SUM(CASE WHEN type = 'delivery' THEN quantity ELSE -quantity END), 0)::int AS in_circulation
       FROM cup_movements WHERE cash_register_id = $1`,
      [cashRegisterId],
    );
    const row = agg.rows[0];
    res.json({
      inCirculation: Math.max(0, Number(row.in_circulation)),
      delivered: Number(row.delivered),
      returned: Number(row.returned),
    });
  } catch (error) {
    console.error('Error cup circulation:', error);
    res.status(500).json({ error: 'Error al obtener circulación de vasos' });
  }
});

/** GET /api/cups/movements?cashRegisterId= */
router.get('/movements', async (req, res) => {
  try {
    const { cashRegisterId } = req.query;
    if (!cashRegisterId || typeof cashRegisterId !== 'string') {
      return res.status(400).json({ error: 'cashRegisterId es requerido' });
    }

    const result = await db.query(
      `SELECT * FROM cup_movements WHERE cash_register_id = $1 ORDER BY created_at ASC`,
      [cashRegisterId],
    );
    res.json(result.rows.map(formatMovement));
  } catch (error) {
    console.error('Error cup movements:', error);
    res.status(500).json({ error: 'Error al obtener movimientos de vasos' });
  }
});

/** POST /api/cups/return */
router.post('/return', async (req, res) => {
  try {
    const {
      cashRegisterId,
      quantity: rawQty,
      paymentMethod,
      mercadoPagoAccountId,
      openAccountId,
    } = req.body;

    if (!cashRegisterId) {
      return res.status(400).json({ error: 'cashRegisterId es requerido' });
    }

    const quantity =
      rawQty != null ? Math.max(0, Math.floor(Number(rawQty))) : 0;
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return res.status(400).json({ error: 'quantity inválida' });
    }

    if (
      !paymentMethod ||
      !['efectivo', 'mercadopago', 'cuenta_abierta'].includes(paymentMethod)
    ) {
      return res.status(400).json({ error: 'paymentMethod inválido' });
    }

    if (paymentMethod === 'mercadopago' && !mercadoPagoAccountId) {
      return res
        .status(400)
        .json({ error: 'mercadoPagoAccountId requerido para Mercado Pago' });
    }

    if (paymentMethod === 'cuenta_abierta' && !openAccountId) {
      return res
        .status(400)
        .json({ error: 'openAccountId requerido para cuenta abierta' });
    }

    const cupPrice = await getCupPrice();
    const amount = cupPrice * quantity;
    const movementId = crypto.randomUUID();
    const now = new Date().toISOString();

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const crRes = await client.query(
        'SELECT id, status FROM cash_registers WHERE id = $1 FOR UPDATE',
        [cashRegisterId],
      );
      const cr = crRes.rows[0];
      if (!cr) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Caja no encontrada' });
      }
      if (cr.status !== 'open') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'La caja no está abierta' });
      }

      const circRes = await client.query(
        `SELECT COALESCE(SUM(CASE WHEN type = 'delivery' THEN quantity ELSE -quantity END), 0)::int AS net
         FROM cup_movements WHERE cash_register_id = $1`,
        [cashRegisterId],
      );
      const inCirculation = Math.max(0, Number(circRes.rows[0].net));
      if (quantity > inCirculation) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `No hay suficientes vasos en circulación (máx. ${inCirculation})`,
        });
      }

      if (paymentMethod === 'cuenta_abierta') {
        const oa = await client.query(
          `SELECT id, cash_register_id, status FROM open_accounts WHERE id = $1`,
          [openAccountId],
        );
        const tab = oa.rows[0];
        if (!tab || tab.status !== 'open') {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: 'Cuenta abierta no encontrada o ya cerrada',
          });
        }
        if (tab.cash_register_id !== cashRegisterId) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: 'La cuenta no pertenece a esta caja',
          });
        }
      }

      await client.query(
        `INSERT INTO cup_movements (
          id, cash_register_id, type, quantity, amount,
          payment_method, mercado_pago_account_id, open_account_id, order_id
        ) VALUES ($1, $2, 'return', $3, $4, $5, $6, $7, NULL)`,
        [
          movementId,
          cashRegisterId,
          quantity,
          amount,
          paymentMethod,
          paymentMethod === 'mercadopago' ? mercadoPagoAccountId : null,
          paymentMethod === 'cuenta_abierta' ? openAccountId : null,
        ],
      );

      if (paymentMethod === 'efectivo') {
        const txId = crypto.randomUUID();
        await client.query(
          `INSERT INTO finance_transactions
           (id, account_id, type, amount, description, source, category, reference_id, date)
           VALUES ($1, 'efectivo', 'expense', $2, $3, 'buffet', 'devolucion-vasos', $4, $5)`,
          [
            txId,
            amount,
            `Devolución depósito vasos (${quantity} u.)`,
            `cup-return:${movementId}`,
            now,
          ],
        );
      } else if (paymentMethod === 'mercadopago') {
        await assertMercadoPagoLiquidityAccount(client, mercadoPagoAccountId);
        const txId = crypto.randomUUID();
        await client.query(
          `INSERT INTO finance_transactions
           (id, account_id, type, amount, description, source, category, reference_id, date)
           VALUES ($1, $2, 'expense', $3, $4, 'buffet', 'devolucion-vasos', $5, $6)`,
          [
            txId,
            mercadoPagoAccountId,
            amount,
            `Devolución depósito vasos (${quantity} u.)`,
            `cup-return:${movementId}`,
            now,
          ],
        );
      }

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    res.status(201).json({ ok: true, id: movementId, amount, quantity });
  } catch (error) {
    console.error('Error cup return:', error);
    if (error.statusCode === 400) {
      return res.status(400).json({ error: error.message });
    }
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Conflicto al registrar devolución' });
    }
    res.status(500).json({ error: 'Error al registrar devolución de vasos' });
  }
});

export default router;
