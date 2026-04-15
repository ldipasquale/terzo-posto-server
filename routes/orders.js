import express from 'express';
import db from '../database.js';
import { getUnitCostsForMenuItemIds } from '../lib/menuItemCost.js';

const router = express.Router();

// Build order SELECT with items as JSON (PostgreSQL)
const orderSelectWithItems = `
  SELECT
    o.*,
    (SELECT COALESCE(json_agg(json_build_object(
      'id', oi.id,
      'menuItem', json_build_object(
        'id', oi.menu_item_id,
        'name', oi.name,
        'description', oi.description,
        'price', oi.price,
        'category', oi.category,
        'type', oi.type,
        'unitCost', oi.unit_cost
      ),
      'quantity', oi.quantity,
      'notes', oi.notes,
      'isDelivered', oi.is_delivered
    )), '[]'::json)
    FROM order_items oi WHERE oi.order_id = o.id) AS items_json
  FROM orders o
`;

function formatOrder(order) {
  const items = Array.isArray(order.items_json)
    ? order.items_json
    : order.items_json
      ? JSON.parse(order.items_json)
      : [];
  return {
    id: order.id,
    customerName: order.customer_name,
    items: items.map((item) => {
      const mi = item.menuItem || {};
      const menuItem = {
        id: mi.id,
        name: mi.name,
        description: mi.description,
        price: Number(mi.price),
        category: mi.category,
        type: mi.type,
      };
      if (mi.unitCost != null && mi.unitCost !== '') {
        menuItem.unitCost = Number(mi.unitCost);
      }
      return {
        id: item.id,
        menuItem,
        quantity: item.quantity,
        notes: item.notes || undefined,
        isDelivered: Boolean(item.isDelivered),
      };
    }),
    total: Number(order.total),
    status: order.status,
    paymentMethod: order.payment_method,
    mercadoPagoAccountId: order.mercado_pago_account_id || undefined,
    cashRegisterId: order.cash_register_id || undefined,
    openAccountId: order.open_account_id || undefined,
    closedOpenAccountId: order.closed_open_account_id || undefined,
    closedOpenAccountName: order.closed_open_account_name || undefined,
    discount: order.discount != null ? Number(order.discount) : undefined,
    discountReason: order.discount_reason || undefined,
    notes: order.notes || undefined,
    createdAt: new Date(order.created_at).toISOString(),
  };
}

/**
 * GET /orders
 * Query: forCashRegisterPeriod=true limits orders to those whose cash_register_id
 * belongs to a cash register opened in the given dateFrom/dateTo window (same as
 * GET /cash-registers). Does not filter by order created_at. Otherwise dateFrom/dateTo
 * apply to orders.created_at.
 */
router.get('/', async (req, res) => {
  try {
    const {
      dateFrom,
      dateTo,
      status,
      paymentMethod,
      mercadoPagoAccountId,
      cashRegisterId: rawCashRegisterId,
      type,
      productSearch,
      forCashRegisterPeriod,
    } = req.query;
    const useCashRegisterPeriod =
      forCashRegisterPeriod === 'true' || forCashRegisterPeriod === '1';
    const cashRegisterId =
      rawCashRegisterId != null
        ? Array.isArray(rawCashRegisterId)
          ? rawCashRegisterId[0]
          : rawCashRegisterId
        : null;

    const whereClauses = [];
    const params = [];
    let paramIndex = 1;

    if (cashRegisterId && !useCashRegisterPeriod) {
      whereClauses.push(`o.cash_register_id = $${paramIndex++}`);
      params.push(cashRegisterId);
    }

    if (useCashRegisterPeriod && !dateFrom && !dateTo) {
      return res.status(400).json({
        error: 'forCashRegisterPeriod requiere dateFrom o dateTo',
      });
    }

    if (useCashRegisterPeriod) {
      const crWhere = [];
      const crParams = [];
      if (dateFrom) {
        crWhere.push(`cr.created_at >= $${crParams.length + 1}::timestamp`);
        crParams.push(dateFrom);
      }
      if (dateTo) {
        crWhere.push(
          `cr.created_at < ($${crParams.length + 1}::timestamp::date + interval '1 day')`,
        );
        crParams.push(dateTo);
      }
      const crSql =
        crWhere.length > 0
          ? `SELECT id FROM cash_registers cr WHERE ${crWhere.join(' AND ')}`
          : `SELECT id FROM cash_registers cr`;
      const crResult = await db.query(crSql, crParams);
      const crIds = crResult.rows.map((r) => r.id);
      if (crIds.length === 0) {
        return res.json([]);
      }
      whereClauses.push(`o.cash_register_id = ANY($${paramIndex++}::text[])`);
      params.push(crIds);
    } else {
      if (dateFrom) {
        whereClauses.push(`o.created_at::date >= $${paramIndex++}::date`);
        params.push(dateFrom);
      }
      if (dateTo) {
        whereClauses.push(`o.created_at::date <= $${paramIndex++}::date`);
        params.push(dateTo);
      }
    }
    if (status) {
      whereClauses.push(`o.status = $${paramIndex++}`);
      params.push(status);
    }
    if (paymentMethod) {
      whereClauses.push(`o.payment_method = $${paramIndex++}`);
      params.push(paymentMethod);
      if (paymentMethod === 'mercadopago' && mercadoPagoAccountId) {
        whereClauses.push(`o.mercado_pago_account_id = $${paramIndex++}`);
        params.push(mercadoPagoAccountId);
      }
    }
    if (type && type !== 'todos') {
      whereClauses.push(`EXISTS (
        SELECT 1 FROM order_items oi2
        WHERE oi2.order_id = o.id AND oi2.type = $${paramIndex++}
      )`);
      params.push(type);
    }
    if (productSearch) {
      whereClauses.push(`EXISTS (
        SELECT 1 FROM order_items oi3
        WHERE oi3.order_id = o.id AND oi3.name ILIKE $${paramIndex++}
      )`);
      params.push(`%${productSearch}%`);
    }

    const whereClause =
      whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

    const query = `
      ${orderSelectWithItems}
      ${whereClause}
      ORDER BY o.created_at DESC
    `;

    const result = await db.query(query, params);
    const formattedOrders = result.rows.map(formatOrder);
    res.json(formattedOrders);
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ error: 'Error al obtener los pedidos' });
  }
});

// Get order by ID
router.get('/:id', async (req, res) => {
  try {
    const id = req.params.id.startsWith('#')
      ? req.params.id
      : `#${req.params.id}`;
    const result = await db.query(`${orderSelectWithItems} WHERE o.id = $1`, [
      id,
    ]);
    const order = result.rows[0];

    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    res.json(formatOrder(order));
  } catch (error) {
    console.error('Error fetching order:', error);
    res.status(500).json({ error: 'Error al obtener el pedido' });
  }
});

// Create new order
router.post('/', async (req, res) => {
  try {
    const {
      customerName,
      items,
      total,
      status,
      paymentMethod,
      mercadoPagoAccountId,
      cashRegisterId,
      discount,
      discountReason,
      notes,
      openAccountId,
    } = req.body;

    if (
      !customerName ||
      !items ||
      !Array.isArray(items) ||
      items.length === 0 ||
      total === undefined
    ) {
      return res.status(400).json({ error: 'Datos del pedido incompletos' });
    }

    const isOpenAccount = paymentMethod === 'cuenta_abierta' || openAccountId;
    const effectivePaymentMethod = isOpenAccount
      ? 'cuenta_abierta'
      : paymentMethod || 'efectivo';
    if (
      !['efectivo', 'mercadopago', 'cuenta_abierta'].includes(
        effectivePaymentMethod,
      )
    ) {
      return res.status(400).json({ error: 'paymentMethod inválido' });
    }

    if (effectivePaymentMethod === 'cuenta_abierta' && !openAccountId) {
      return res
        .status(400)
        .json({ error: 'openAccountId es requerido para cuenta abierta' });
    }

    if (effectivePaymentMethod === 'cuenta_abierta' && openAccountId) {
      const accountCheck = await db.query(
        'SELECT id FROM open_accounts WHERE id = $1 AND status = $2',
        [openAccountId, 'open'],
      );
      if (accountCheck.rows.length === 0) {
        return res
          .status(400)
          .json({ error: 'Cuenta abierta no encontrada o ya cerrada' });
      }
    }

    const menuIds = items.map((item) => item.menuItem?.id).filter(Boolean);
    const unitCostMap = await getUnitCostsForMenuItemIds(menuIds);

    const client = await db.connect();
    let orderId;
    try {
      await client.query('BEGIN');

      let row = (
        await client.query('SELECT value FROM settings WHERE key = $1', [
          'order_counter',
        ])
      ).rows[0];
      let nextNum;
      if (row) {
        nextNum = parseInt(row.value, 10) + 1;
      } else {
        const maxRow = await client.query(
          "SELECT MAX(CAST(REPLACE(id, '#', '') AS INTEGER)) AS max_id FROM orders",
        );
        nextNum =
          (maxRow.rows[0]?.max_id != null ? Number(maxRow.rows[0].max_id) : 0) +
          1;
      }
      orderId = `#${nextNum}`;

      await client.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
        ['order_counter', String(nextNum)],
      );

      await client.query(
        `INSERT INTO orders (id, customer_name, total, status, payment_method, mercado_pago_account_id, cash_register_id, open_account_id, discount, discount_reason, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          orderId,
          customerName,
          total,
          status || 'pending',
          effectivePaymentMethod,
          effectivePaymentMethod === 'mercadopago'
            ? mercadoPagoAccountId || null
            : null,
          cashRegisterId || null,
          effectivePaymentMethod === 'cuenta_abierta' ? openAccountId : null,
          discount ?? null,
          discountReason ?? null,
          notes ?? null,
        ],
      );

      for (const item of items) {
        const unitCost = unitCostMap.get(item.menuItem.id) ?? null;
        await client.query(
          `INSERT INTO order_items (order_id, menu_item_id, name, description, price, category, type, quantity, notes, unit_cost, is_delivered)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            orderId,
            item.menuItem.id,
            item.menuItem.name,
            item.menuItem.description,
            item.menuItem.price,
            item.menuItem.category,
            item.menuItem.type,
            item.quantity,
            item.notes || null,
            unitCost,
            false,
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

    const result = await db.query(`${orderSelectWithItems} WHERE o.id = $1`, [
      orderId,
    ]);
    const order = result.rows[0];
    res.status(201).json(formatOrder(order));
  } catch (error) {
    console.error('Error creating order:', error);
    res.status(500).json({ error: 'Error al crear el pedido' });
  }
});

// Update order status
router.patch('/:id/status', async (req, res) => {
  try {
    const id = req.params.id.startsWith('#')
      ? req.params.id
      : `#${req.params.id}`;
    const { status } = req.body;

    if (
      !status ||
      !['pending', 'preparing', 'ready', 'delivered'].includes(status)
    ) {
      return res.status(400).json({ error: 'Estado inválido' });
    }

    const result = await db.query(
      `UPDATE orders SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [status, id],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const orderResult = await db.query(
      `${orderSelectWithItems} WHERE o.id = $1`,
      [id],
    );
    res.json(formatOrder(orderResult.rows[0]));
  } catch (error) {
    console.error('Error updating order:', error);
    res.status(500).json({ error: 'Error al actualizar el pedido' });
  }
});

// Update a single order item delivered state
router.patch('/:id/items/:itemId/delivered', async (req, res) => {
  try {
    const id = req.params.id.startsWith('#')
      ? req.params.id
      : `#${req.params.id}`;
    const itemId = Number(req.params.itemId);
    const { isDelivered } = req.body;

    if (!Number.isInteger(itemId) || itemId <= 0) {
      return res.status(400).json({ error: 'itemId inválido' });
    }
    if (typeof isDelivered !== 'boolean') {
      return res.status(400).json({ error: 'isDelivered debe ser boolean' });
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const orderStatusResult = await client.query(
        `SELECT status FROM orders WHERE id = $1`,
        [id],
      );
      if (orderStatusResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Pedido no encontrado' });
      }
      const orderStatus = orderStatusResult.rows[0].status;
      const canToggleInPending = orderStatus === 'pending';
      const canUncheckInDelivered = orderStatus === 'delivered' && isDelivered === false;
      if (!canToggleInPending && !canUncheckInDelivered) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error:
            'Solo se puede editar items en pendientes, o destachar en entregados',
        });
      }

      const itemResult = await client.query(
        `UPDATE order_items
         SET is_delivered = $1
         WHERE id = $2 AND order_id = $3
         RETURNING id`,
        [isDelivered, itemId, id],
      );

      if (itemResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Item de pedido no encontrado' });
      }

      const countsResult = await client.query(
        `SELECT
           COUNT(*)::int AS total_items,
           COUNT(*) FILTER (WHERE is_delivered) ::int AS delivered_items
         FROM order_items
         WHERE order_id = $1`,
        [id],
      );

      const totals = countsResult.rows[0];
      const allDelivered =
        totals.total_items > 0 && totals.delivered_items === totals.total_items;

      if (allDelivered) {
        await client.query(
          `UPDATE orders
           SET status = 'delivered', updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [id],
        );
      } else {
        // If any item is unmarked again, keep the order open.
        await client.query(
          `UPDATE orders
           SET status = 'pending', updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND status = 'delivered'`,
          [id],
        );
      }

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    const orderResult = await db.query(`${orderSelectWithItems} WHERE o.id = $1`, [
      id,
    ]);
    if (orderResult.rowCount === 0) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    res.json(formatOrder(orderResult.rows[0]));
  } catch (error) {
    console.error('Error updating delivered item state:', error);
    res.status(500).json({ error: 'Error al actualizar el item del pedido' });
  }
});

// Delete order
router.delete('/:id', async (req, res) => {
  try {
    const id = req.params.id.startsWith('#')
      ? req.params.id
      : `#${req.params.id}`;
    const result = await db.query('DELETE FROM orders WHERE id = $1', [id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    res.status(204).send();
  } catch (error) {
    console.error('Error deleting order:', error);
    res.status(500).json({ error: 'Error al eliminar el pedido' });
  }
});

export default router;
