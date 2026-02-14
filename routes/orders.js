import express from 'express';
import db from '../database.js';

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
        'type', oi.type
      ),
      'quantity', oi.quantity,
      'notes', oi.notes
    )), '[]'::json)
    FROM order_items oi WHERE oi.order_id = o.id) AS items_json
  FROM orders o
`;

function formatOrder(order) {
  const items = Array.isArray(order.items_json) ? order.items_json : (order.items_json ? JSON.parse(order.items_json) : []);
  return {
    id: order.id,
    customerName: order.customer_name,
    items: items.map((item) => ({
      menuItem: item.menuItem,
      quantity: item.quantity,
      notes: item.notes || undefined,
    })),
    total: Number(order.total),
    status: order.status,
    paymentMethod: order.payment_method,
    mercadoPagoAccountId: order.mercado_pago_account_id || undefined,
    discount: order.discount != null ? Number(order.discount) : undefined,
    discountReason: order.discount_reason || undefined,
    notes: order.notes || undefined,
    createdAt: new Date(order.created_at).toISOString(),
  };
}

// Get all orders with optional filtering
router.get('/', async (req, res) => {
  try {
    const { dateFrom, dateTo, status, paymentMethod, mercadoPagoAccountId, type, productSearch } = req.query;

    const whereClauses = [];
    const params = [];
    let paramIndex = 1;

    if (dateFrom) {
      whereClauses.push(`o.created_at >= $${paramIndex++}`);
      params.push(dateFrom);
    }
    if (dateTo) {
      whereClauses.push(`o.created_at <= $${paramIndex++}`);
      params.push(dateTo);
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

    const whereClause = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

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
    const id = req.params.id.startsWith('#') ? req.params.id : `#${req.params.id}`;
    const result = await db.query(
      `${orderSelectWithItems} WHERE o.id = $1`,
      [id]
    );
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
    const { customerName, items, total, status, paymentMethod, mercadoPagoAccountId, discount, discountReason, notes } = req.body;

    if (!customerName || !items || !Array.isArray(items) || items.length === 0 || total === undefined) {
      return res.status(400).json({ error: 'Datos del pedido incompletos' });
    }

    const client = await db.connect();
    let orderId;
    try {
      await client.query('BEGIN');

      let row = (await client.query('SELECT value FROM settings WHERE key = $1', ['order_counter'])).rows[0];
      let nextNum;
      if (row) {
        nextNum = parseInt(row.value, 10) + 1;
      } else {
        const maxRow = await client.query(
          "SELECT MAX(CAST(REPLACE(id, '#', '') AS INTEGER)) AS max_id FROM orders"
        );
        nextNum = (maxRow.rows[0]?.max_id != null ? Number(maxRow.rows[0].max_id) : 0) + 1;
      }
      orderId = `#${nextNum}`;

      await client.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
        ['order_counter', String(nextNum)]
      );

      await client.query(
        `INSERT INTO orders (id, customer_name, total, status, payment_method, mercado_pago_account_id, discount, discount_reason, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          orderId,
          customerName,
          total,
          status || 'pending',
          paymentMethod || 'efectivo',
          mercadoPagoAccountId || null,
          discount ?? null,
          discountReason ?? null,
          notes ?? null,
        ]
      );

      for (const item of items) {
        await client.query(
          `INSERT INTO order_items (order_id, menu_item_id, name, description, price, category, type, quantity, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
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
          ]
        );
      }

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    const result = await db.query(
      `${orderSelectWithItems} WHERE o.id = $1`,
      [orderId]
    );
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
    const id = req.params.id.startsWith('#') ? req.params.id : `#${req.params.id}`;
    const { status } = req.body;

    if (!status || !['pending', 'preparing', 'ready', 'delivered'].includes(status)) {
      return res.status(400).json({ error: 'Estado inválido' });
    }

    const result = await db.query(
      `UPDATE orders SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [status, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const orderResult = await db.query(
      `${orderSelectWithItems} WHERE o.id = $1`,
      [id]
    );
    res.json(formatOrder(orderResult.rows[0]));
  } catch (error) {
    console.error('Error updating order:', error);
    res.status(500).json({ error: 'Error al actualizar el pedido' });
  }
});

// Delete order
router.delete('/:id', async (req, res) => {
  try {
    const id = req.params.id.startsWith('#') ? req.params.id : `#${req.params.id}`;
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
