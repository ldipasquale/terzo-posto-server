import crypto from 'crypto';

export const MAX_TICKET_MENU_QTY = 20;
export const TICKET_MENU_ORDER_NOTES = 'Pagado con la entrada';

export function ticketMenuTotalSql(ticketIdExpr) {
  return `COALESCE((
    SELECT SUM(s.price * s.quantity)
    FROM event_ticket_menu_selections s
    WHERE s.ticket_id = ${ticketIdExpr}
  ), 0)`;
}

export function ticketNetAmount(row) {
  return Math.max(
    0,
    Number(row.quantity) * Number(row.unit_price) -
      (Number(row.discount_amount) || 0) +
      (Number(row.menu_total) || 0),
  );
}

export function ticketMenuTotal(items) {
  return (items || []).reduce(
    (sum, item) => sum + Number(item.price) * Number(item.quantity),
    0,
  );
}

export function mapPublicMenuItem(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    price: Number(row.price),
    category: row.category,
    type: row.type,
  };
}

export function mapTicketMenuSelection(row) {
  return {
    menu_item_id: row.menu_item_id,
    name: row.name,
    description: row.description || '',
    price: Number(row.price),
    category: row.category,
    type: row.type,
    quantity: Number(row.quantity),
  };
}

export async function loadEventTicketMenuItems(
  client,
  rentalId,
  { publicView = false } = {},
) {
  const result = await client.query(
    `SELECT m.id, m.name, m.description, m.price, m.category, m.type
     FROM event_ticket_menu_items e
     JOIN menu_items m ON m.id = e.menu_item_id
     WHERE e.rental_id = $1
       ${publicView ? 'AND m.available = 1 AND m.archived = 0' : 'AND m.archived = 0'}
     ORDER BY e.position ASC, m.name ASC`,
    [rentalId],
  );
  return result.rows.map(mapPublicMenuItem);
}

export async function saveEventTicketMenuItems(client, rentalId, menuItemIds) {
  const ids = [
    ...new Set(
      (Array.isArray(menuItemIds) ? menuItemIds : [])
        .map((id) => String(id || '').trim())
        .filter(Boolean),
    ),
  ];
  await client.query(
    'DELETE FROM event_ticket_menu_items WHERE rental_id = $1',
    [rentalId],
  );
  if (ids.length === 0) return;
  const existing = await client.query(
    `SELECT id FROM menu_items WHERE id = ANY($1::text[]) AND archived = 0`,
    [ids],
  );
  const allowed = new Set(existing.rows.map((row) => row.id));
  const ordered = ids.filter((id) => allowed.has(id));
  for (const [index, id] of ordered.entries()) {
    await client.query(
      `INSERT INTO event_ticket_menu_items (rental_id, menu_item_id, position)
       VALUES ($1, $2, $3)`,
      [rentalId, id, index],
    );
  }
}

export function parseTicketMenuSelections(raw) {
  let parsed = raw;
  if (raw == null || raw === '') return { items: [] };
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { error: 'Menú inválido' };
    }
  }
  if (!Array.isArray(parsed)) return { error: 'Menú inválido' };
  const items = [];
  for (const row of parsed) {
    const menuItemId = String(row?.menu_item_id || row?.id || '').trim();
    const quantity = Number(row?.quantity);
    if (!menuItemId) continue;
    if (!Number.isInteger(quantity) || quantity < 1) {
      return { error: 'Cantidad de menú inválida' };
    }
    if (quantity > MAX_TICKET_MENU_QTY) {
      return { error: `Máximo ${MAX_TICKET_MENU_QTY} unidades por producto` };
    }
    items.push({ menu_item_id: menuItemId, quantity });
  }
  return { items };
}

export async function resolveTicketMenuSelections(client, rentalId, requested) {
  if (!requested.length) return { selections: [], total: 0 };
  const allowed = await client.query(
    `SELECT m.id, m.name, m.description, m.price, m.category, m.type
     FROM event_ticket_menu_items e
     JOIN menu_items m ON m.id = e.menu_item_id
     WHERE e.rental_id = $1
       AND m.available = 1
       AND m.archived = 0
       AND m.id = ANY($2::text[])`,
    [rentalId, requested.map((row) => row.menu_item_id)],
  );
  const byId = new Map(allowed.rows.map((row) => [row.id, row]));
  const selections = [];
  let total = 0;
  for (const req of requested) {
    const item = byId.get(req.menu_item_id);
    if (!item) {
      return { error: 'Hay productos del menú que ya no están disponibles' };
    }
    const price = Number(item.price);
    selections.push({
      menu_item_id: item.id,
      name: item.name,
      description: item.description || '',
      price,
      category: item.category,
      type: item.type,
      quantity: req.quantity,
    });
    total += price * req.quantity;
  }
  return { selections, total };
}

export async function insertTicketMenuSelections(client, ticketId, selections) {
  for (const item of selections) {
    await client.query(
      `INSERT INTO event_ticket_menu_selections (
         id, ticket_id, menu_item_id, name, description, price, category, type, quantity
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        crypto.randomUUID(),
        ticketId,
        item.menu_item_id,
        item.name,
        item.description,
        item.price,
        item.category,
        item.type,
        item.quantity,
      ],
    );
  }
}

export async function loadMenuSelectionsByTicketIds(client, ticketIds) {
  const map = new Map();
  if (!ticketIds.length) return map;
  const result = await client.query(
    `SELECT * FROM event_ticket_menu_selections
     WHERE ticket_id = ANY($1::text[])
     ORDER BY created_at ASC`,
    [ticketIds],
  );
  for (const row of result.rows) {
    const list = map.get(row.ticket_id) || [];
    list.push(mapTicketMenuSelection(row));
    map.set(row.ticket_id, list);
  }
  return map;
}

async function nextOrderId(client) {
  const row = (
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
      (maxRow.rows[0]?.max_id != null ? Number(maxRow.rows[0].max_id) : 0) + 1;
  }
  await client.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
    ['order_counter', String(nextNum)],
  );
  return `#${nextNum}`;
}

export async function createBuffetOrderFromTicket(
  client,
  { cashRegisterId, ticketId, buyerName, selections },
) {
  if (!selections.length) return null;
  const existing = await client.query(
    'SELECT id FROM orders WHERE event_ticket_id = $1',
    [ticketId],
  );
  if (existing.rows[0]) return existing.rows[0].id;

  const { getUnitCostsForMenuItemIds } = await import('./menuItemCost.js');
  const unitCostMap = await getUnitCostsForMenuItemIds(
    selections.map((item) => item.menu_item_id),
  );
  const orderId = await nextOrderId(client);
  const total = ticketMenuTotal(selections);

  await client.query(
    `INSERT INTO orders (
       id, customer_name, total, status, payment_method, mercado_pago_account_id,
       cash_register_id, notes, cups_delivered, event_ticket_id
     ) VALUES ($1,$2,$3,'pending','mercadopago',NULL,$4,$5,0,$6)`,
    [
      orderId,
      buyerName,
      total,
      cashRegisterId,
      TICKET_MENU_ORDER_NOTES,
      ticketId,
    ],
  );

  for (const item of selections) {
    const unitCost = unitCostMap.get(item.menu_item_id) ?? null;
    const qty = Math.max(1, Math.floor(Number(item.quantity) || 1));
    const type = item.type;
    const rowsToInsert = type === 'comida' ? qty : 1;
    const quantityPerRow = type === 'comida' ? 1 : qty;
    for (let i = 0; i < rowsToInsert; i += 1) {
      await client.query(
        `INSERT INTO order_items (
           order_id, menu_item_id, name, description, price, category, type,
           quantity, notes, unit_cost, is_delivered, created_at, delivered_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9,false,CURRENT_TIMESTAMP,NULL)`,
        [
          orderId,
          item.menu_item_id,
          item.name,
          item.description,
          item.price,
          item.category,
          type,
          quantityPerRow,
          unitCost,
        ],
      );
    }
  }
  return orderId;
}

export async function fulfillTicketMenuOrdersForCaja(
  client,
  cashRegisterId,
  eventId,
) {
  if (!eventId) return 0;
  const tickets = await client.query(
    `SELECT t.id, t.buyer_name
     FROM event_tickets t
     WHERE t.rental_id = $1
       AND t.status = 'approved'
       AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.event_ticket_id = t.id)
       AND EXISTS (
         SELECT 1 FROM event_ticket_menu_selections s WHERE s.ticket_id = t.id
       )`,
    [eventId],
  );
  if (tickets.rows.length === 0) return 0;
  const selectionsMap = await loadMenuSelectionsByTicketIds(
    client,
    tickets.rows.map((ticket) => ticket.id),
  );
  let created = 0;
  for (const ticket of tickets.rows) {
    const selections = selectionsMap.get(ticket.id) || [];
    if (!selections.length) continue;
    await createBuffetOrderFromTicket(client, {
      cashRegisterId,
      ticketId: ticket.id,
      buyerName: ticket.buyer_name,
      selections,
    });
    created += 1;
  }
  return created;
}

export async function fulfillTicketMenuOrderIfCajaOpen(client, ticketId) {
  const ticket = await client.query(
    `SELECT id, rental_id, buyer_name, status FROM event_tickets WHERE id = $1`,
    [ticketId],
  );
  const row = ticket.rows[0];
  if (!row || row.status !== 'approved') return null;
  const caja = await client.query(
    `SELECT id FROM cash_registers
     WHERE status = 'open' AND event_id = $1
     LIMIT 1`,
    [row.rental_id],
  );
  if (!caja.rows[0]) return null;
  const selectionsMap = await loadMenuSelectionsByTicketIds(client, [ticketId]);
  const selections = selectionsMap.get(ticketId) || [];
  if (!selections.length) return null;
  return createBuffetOrderFromTicket(client, {
    cashRegisterId: caja.rows[0].id,
    ticketId,
    buyerName: row.buyer_name,
    selections,
  });
}

export async function revertPendingTicketMenuOrder(client, ticketId) {
  await client.query(
    `DELETE FROM orders WHERE event_ticket_id = $1 AND status = 'pending'`,
    [ticketId],
  );
}
