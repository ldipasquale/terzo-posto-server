import express from 'express';
import db from '../database.js';

const router = express.Router();

// Get all orders
router.get('/', (req, res) => {
  try {
    const orders = db.prepare(`
      SELECT
        o.*,
        GROUP_CONCAT(
          json_object(
            'id', oi.id,
            'menuItem', json_object(
              'id', oi.menu_item_id,
              'name', oi.name,
              'description', oi.description,
              'price', oi.price,
              'category', oi.category,
              'type', oi.type
            ),
            'quantity', oi.quantity,
            'notes', oi.notes
          )
        ) as items_json
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
      GROUP BY o.id
      ORDER BY o.created_at DESC
    `).all();

    const formattedOrders = orders.map(order => {
      const items = order.items_json
        ? JSON.parse('[' + order.items_json + ']')
        : [];

      return {
        id: order.id,
        customerName: order.customer_name,
        items: items.map(item => ({
          menuItem: item.menuItem,
          quantity: item.quantity,
          notes: item.notes || undefined
        })),
        total: order.total,
        status: order.status,
        paymentMethod: order.payment_method,
        mercadoPagoAccountId: order.mercado_pago_account_id || undefined,
        createdAt: new Date(order.created_at + 'Z').toISOString()
      };
    });

    res.json(formattedOrders);
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ error: 'Error al obtener los pedidos' });
  }
});

// Get order by ID (id may be #1, #2, etc. - ensure we match correctly)
router.get('/:id', (req, res) => {
  try {
    const id = req.params.id.startsWith('#') ? req.params.id : `#${req.params.id}`;
    const order = db.prepare(`
      SELECT
        o.*,
        GROUP_CONCAT(
          json_object(
            'id', oi.id,
            'menuItem', json_object(
              'id', oi.menu_item_id,
              'name', oi.name,
              'description', oi.description,
              'price', oi.price,
              'category', oi.category,
              'type', oi.type
            ),
            'quantity', oi.quantity,
            'notes', oi.notes
          )
        ) as items_json
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
      WHERE o.id = ?
      GROUP BY o.id
    `).get(id);

    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const items = order.items_json 
      ? JSON.parse('[' + order.items_json + ']')
      : [];

    const formattedOrder = {
      id: order.id,
      customerName: order.customer_name,
      items: items.map(item => ({
        menuItem: item.menuItem,
        quantity: item.quantity,
        notes: item.notes || undefined
      })),
      total: order.total,
      status: order.status,
      paymentMethod: order.payment_method,
      mercadoPagoAccountId: order.mercado_pago_account_id || undefined,
      createdAt: new Date(order.created_at + 'Z').toISOString()
    };

    res.json(formattedOrder);
  } catch (error) {
    console.error('Error fetching order:', error);
    res.status(500).json({ error: 'Error al obtener el pedido' });
  }
});

// Create new order (order id and counter updated in one transaction)
router.post('/', (req, res) => {
  try {
    const { customerName, items, total, status, paymentMethod, mercadoPagoAccountId } = req.body;

    if (!customerName || !items || !Array.isArray(items) || items.length === 0 || total === undefined) {
      return res.status(400).json({ error: 'Datos del pedido incompletos' });
    }

    const getCounter = db.prepare("SELECT value FROM settings WHERE key = ?");
    const upsertCounter = db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP"
    );
    const insertOrder = db.prepare(`
      INSERT INTO orders (id, customer_name, total, status, payment_method, mercado_pago_account_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertOrderItem = db.prepare(`
      INSERT INTO order_items (order_id, menu_item_id, name, description, price, category, type, quantity, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const createOrder = db.transaction(() => {
      let row = getCounter.get('order_counter');
      let nextNum;
      if (row) {
        nextNum = parseInt(row.value, 10) + 1;
      } else {
        const maxRow = db.prepare(
          "SELECT MAX(CAST(REPLACE(id, '#', '') AS INTEGER)) AS max_id FROM orders"
        ).get();
        nextNum = (maxRow?.max_id != null ? maxRow.max_id : 0) + 1;
      }
      const orderId = `#${nextNum}`;
      upsertCounter.run('order_counter', String(nextNum));

      insertOrder.run(
        orderId,
        customerName,
        total,
        status || 'pending',
        paymentMethod || 'efectivo',
        mercadoPagoAccountId || null
      );

      for (const item of items) {
        insertOrderItem.run(
          orderId,
          item.menuItem.id,
          item.menuItem.name,
          item.menuItem.description,
          item.menuItem.price,
          item.menuItem.category,
          item.menuItem.type,
          item.quantity,
          item.notes || null
        );
      }
      return orderId;
    });

    const orderId = createOrder();

    // Fetch and return the created order
    const order = db.prepare(`
      SELECT
        o.*,
        GROUP_CONCAT(
          json_object(
            'id', oi.id,
            'menuItem', json_object(
              'id', oi.menu_item_id,
              'name', oi.name,
              'description', oi.description,
              'price', oi.price,
              'category', oi.category,
              'type', oi.type
            ),
            'quantity', oi.quantity,
            'notes', oi.notes
          )
        ) as items_json
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
      WHERE o.id = ?
      GROUP BY o.id
    `).get(orderId);

    const itemsData = order.items_json 
      ? JSON.parse('[' + order.items_json + ']')
      : [];

    const formattedOrder = {
      id: order.id,
      customerName: order.customer_name,
      items: itemsData.map(item => ({
        menuItem: item.menuItem,
        quantity: item.quantity,
        notes: item.notes || undefined
      })),
      total: order.total,
      status: order.status,
      paymentMethod: order.payment_method,
      mercadoPagoAccountId: order.mercado_pago_account_id || undefined,
      createdAt: new Date(order.created_at + 'Z').toISOString()
    };

    res.status(201).json(formattedOrder);
  } catch (error) {
    console.error('Error creating order:', error);
    res.status(500).json({ error: 'Error al crear el pedido' });
  }
});

// Update order status
router.patch('/:id/status', (req, res) => {
  try {
    const id = req.params.id.startsWith('#') ? req.params.id : `#${req.params.id}`;
    const { status } = req.body;

    if (!status || !['pending', 'preparing', 'ready', 'delivered'].includes(status)) {
      return res.status(400).json({ error: 'Estado inválido' });
    }

    const updateOrder = db.prepare(`
      UPDATE orders 
      SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    const result = updateOrder.run(status, id);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    // Fetch and return updated order
    const order = db.prepare(`
      SELECT
        o.*,
        GROUP_CONCAT(
          json_object(
            'id', oi.id,
            'menuItem', json_object(
              'id', oi.menu_item_id,
              'name', oi.name,
              'description', oi.description,
              'price', oi.price,
              'category', oi.category,
              'type', oi.type
            ),
            'quantity', oi.quantity,
            'notes', oi.notes
          )
        ) as items_json
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
      WHERE o.id = ?
      GROUP BY o.id
    `).get(id);

    const items = order.items_json 
      ? JSON.parse('[' + order.items_json + ']')
      : [];

    const formattedOrder = {
      id: order.id,
      customerName: order.customer_name,
      items: items.map(item => ({
        menuItem: item.menuItem,
        quantity: item.quantity,
        notes: item.notes || undefined
      })),
      total: order.total,
      status: order.status,
      paymentMethod: order.payment_method,
      mercadoPagoAccountId: order.mercado_pago_account_id || undefined,
      createdAt: new Date(order.created_at + 'Z').toISOString()
    };

    res.json(formattedOrder);
  } catch (error) {
    console.error('Error updating order:', error);
    res.status(500).json({ error: 'Error al actualizar el pedido' });
  }
});

// Delete order
router.delete('/:id', (req, res) => {
  try {
    const id = req.params.id.startsWith('#') ? req.params.id : `#${req.params.id}`;
    const deleteOrder = db.prepare('DELETE FROM orders WHERE id = ?');
    const result = deleteOrder.run(id);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    res.status(204).send();
  } catch (error) {
    console.error('Error deleting order:', error);
    res.status(500).json({ error: 'Error al eliminar el pedido' });
  }
});

export default router;
