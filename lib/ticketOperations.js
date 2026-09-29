import db from '../database.js';
import {
  loadTicketEmailContext,
  mapTicket,
  mapTicketsWithMenu,
  newId,
  soldByType,
} from './eventTickets.js';
import {
  fulfillTicketMenuOrderIfCajaOpen,
  revertPendingTicketMenuOrder,
} from './ticketMenu.js';
import { isValidEmail, sendTicketEmailForRow } from './ticketEmail.js';
import { resolveTicketTransferAccountId } from './ticketTransfer.js';
import { getVenueLocation } from './venueLocation.js';

export async function listEventTickets(rentalId, status) {
  const params = [rentalId];
  let sql = `SELECT * FROM event_tickets WHERE rental_id = $1`;
  if (['pending', 'approved', 'rejected'].includes(status)) {
    sql += ' AND status = $2';
    params.push(status);
  } else if (status === 'checked_in') {
    sql += ' AND checked_in_at IS NOT NULL';
  }
  sql +=
    status === 'checked_in'
      ? ' ORDER BY checked_in_at DESC'
      : ' ORDER BY purchase_date DESC';
  const result = await db.query(sql, params);
  return mapTicketsWithMenu(db, result.rows);
}

export async function sellDoorTicket(rentalId, body) {
  const ticketTypeId = String(body?.ticket_type_id || '').trim();
  const quantity = Number(body?.quantity);
  const buyerName = String(body?.buyer_name || '').trim();
  const buyerEmail = String(body?.buyer_email || '').trim().toLowerCase();
  const paymentMethod = String(body?.payment_method || '');
  const discountAmount = Math.max(0, Number(body?.discount_amount) || 0);

  if (!ticketTypeId) {
    return { status: 400, body: { error: 'Elegí el tipo de entrada' } };
  }
  if (!Number.isInteger(quantity) || quantity < 1) {
    return { status: 400, body: { error: 'Cantidad inválida' } };
  }
  if (paymentMethod && !['efectivo', 'mercadopago'].includes(paymentMethod)) {
    return { status: 400, body: { error: 'Elegí el medio de pago' } };
  }
  if (buyerEmail && !isValidEmail(buyerEmail)) {
    return { status: 400, body: { error: 'Revisá el mail' } };
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const rentalResult = await client.query(
      'SELECT * FROM agenda_rentals WHERE id = $1 FOR UPDATE',
      [rentalId],
    );
    const rental = rentalResult.rows[0];
    if (!rental || Number(rental.has_tickets) !== 1) {
      await client.query('ROLLBACK');
      return { status: 404, body: { error: 'Evento no encontrado' } };
    }
    if (rental.ticket_sales_closed_at) {
      await client.query('ROLLBACK');
      return {
        status: 409,
        body: { error: 'La venta de entradas está cerrada' },
      };
    }

    const typeResult = await client.query(
      `SELECT * FROM event_ticket_types
       WHERE id = $1 AND rental_id = $2
       FOR UPDATE`,
      [ticketTypeId, rentalId],
    );
    const type = typeResult.rows[0];
    if (!type) {
      await client.query('ROLLBACK');
      return { status: 400, body: { error: 'Tipo de entrada no encontrado' } };
    }

    const soldMap = await soldByType(client, rentalId);
    const sold = soldMap.get(type.id) || 0;
    const remaining = Math.max(0, Number(type.available_quantity) - sold);
    if (quantity > remaining) {
      await client.query('ROLLBACK');
      return {
        status: 409,
        body: { error: 'No hay cupo suficiente para esa cantidad' },
      };
    }

    const subtotal = Number(type.price) * quantity;
    if (discountAmount > subtotal) {
      await client.query('ROLLBACK');
      return {
        status: 400,
        body: { error: 'El descuento no puede superar el total' },
      };
    }
    const unitPrice = Number(type.price);
    const isFree = Number.isFinite(unitPrice) && unitPrice <= 0;
    if (!isFree && !['efectivo', 'mercadopago'].includes(paymentMethod)) {
      await client.query('ROLLBACK');
      return { status: 400, body: { error: 'Elegí el medio de pago' } };
    }
    const storedPayment = isFree ? null : paymentMethod;
    const mpAccountId =
      storedPayment === 'mercadopago'
        ? await resolveTicketTransferAccountId(client, rental)
        : null;

    const ticketId = newId();
    await client.query(
      `INSERT INTO event_tickets (
        id, rental_id, ticket_type_id, quantity, unit_price,
        buyer_name, buyer_phone, buyer_email, receipt_file, status,
        payment_method, mercado_pago_account_id, discount_amount, source,
        purchase_id, purchase_date
      ) VALUES (
        $1,$2,$3,$4,$5,$6,'',$7,NULL,'approved',
        $8,$9,$10,'door',$1, CURRENT_TIMESTAMP
      )`,
      [
        ticketId,
        rentalId,
        type.id,
        quantity,
        unitPrice,
        buyerName,
        buyerEmail,
        storedPayment,
        mpAccountId,
        isFree ? 0 : discountAmount,
      ],
    );
    await client.query('COMMIT');

    const created = await db.query('SELECT * FROM event_tickets WHERE id = $1', [
      ticketId,
    ]);
    const [ticket] = await mapTicketsWithMenu(db, created.rows);
    let emailSent = false;
    if (buyerEmail) {
      try {
        const emailRow = await loadTicketEmailContext(db, ticketId);
        emailSent = await sendTicketEmailForRow(
          emailRow,
          await getVenueLocation(db),
        );
      } catch (emailError) {
        console.error('door ticket email:', emailError);
      }
    }
    return { status: 201, body: { ...ticket, email_sent: emailSent } };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function updateTicketStatus(ticketId, status, { rentalId } = {}) {
  if (!['pending', 'approved', 'rejected'].includes(status)) {
    return { status: 400, body: { error: 'Estado inválido' } };
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const params = [status, ticketId];
    let sql = 'UPDATE event_tickets SET status = $1 WHERE id = $2';
    if (rentalId) {
      sql += ' AND rental_id = $3';
      params.push(rentalId);
    }
    sql += ' RETURNING *';
    const result = await client.query(sql, params);
    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return { status: 404, body: { error: 'Entrada no encontrada' } };
    }
    if (status === 'approved') {
      await fulfillTicketMenuOrderIfCajaOpen(client, ticketId);
    } else if (status === 'rejected') {
      await revertPendingTicketMenuOrder(client, ticketId);
    }
    await client.query('COMMIT');
    const [ticket] = await mapTicketsWithMenu(db, result.rows);
    return { status: 200, body: ticket };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const TICKET_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ticketCheckInView(row) {
  return {
    ticket: mapTicket(row),
    event_name: row.activity_name,
    ticket_type_name: row.ticket_type_name,
  };
}

function purchaseCheckInTotals(rows) {
  return rows.reduce(
    (totals, item) => ({
      quantity: totals.quantity + Number(item.quantity),
      checkedIn: totals.checkedIn + (Number(item.checked_in_count) || 0),
    }),
    { quantity: 0, checkedIn: 0 },
  );
}

function latestCheckedInRow(rows, fallback) {
  return (
    rows.reduce((best, item) => {
      if (!item.checked_in_at) return best;
      if (!best?.checked_in_at) return item;
      return new Date(item.checked_in_at) > new Date(best.checked_in_at)
        ? item
        : best;
    }, null) || fallback
  );
}

export async function checkInTicket(ticketId, { rentalId } = {}) {
  if (!TICKET_ID_RE.test(ticketId)) {
    return { status: 409, body: { ok: false, reason: 'invalid_code' } };
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const peek = await client.query(
      `SELECT id, purchase_id, status, rental_id
       FROM event_tickets
       WHERE id = $1`,
      [ticketId],
    );
    const peeked = peek.rows[0];
    if (!peeked || (rentalId && peeked.rental_id !== rentalId)) {
      await client.query('ROLLBACK');
      return {
        status: 409,
        body: {
          ok: false,
          reason: peeked && rentalId ? 'wrong_event' : 'not_found',
        },
      };
    }

    const purchaseId = peeked.purchase_id || peeked.id;
    const group = await client.query(
      `SELECT t.*, r.activity_name, tt.name AS ticket_type_name
       FROM event_tickets t
       JOIN agenda_rentals r ON r.id = t.rental_id
       JOIN event_ticket_types tt ON tt.id = t.ticket_type_id
       WHERE (t.purchase_id = $1 OR t.id = $2)
         AND ($3::text IS NULL OR t.rental_id = $3)
       ORDER BY t.id ASC
       FOR UPDATE OF t`,
      [purchaseId, ticketId, rentalId || null],
    );
    const scanned = group.rows.find((item) => item.id === ticketId);
    if (!scanned) {
      await client.query('ROLLBACK');
      return { status: 409, body: { ok: false, reason: 'not_found' } };
    }
    if (scanned.status === 'pending') {
      await client.query('ROLLBACK');
      return {
        status: 409,
        body: { ok: false, reason: 'pending', ...ticketCheckInView(scanned) },
      };
    }
    if (scanned.status === 'rejected') {
      await client.query('ROLLBACK');
      return {
        status: 409,
        body: { ok: false, reason: 'rejected', ...ticketCheckInView(scanned) },
      };
    }

    const approved = group.rows
      .filter((item) => item.status === 'approved')
      .sort((a, b) => {
        const byTime =
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        if (byTime !== 0) return byTime;
        return String(a.id).localeCompare(String(b.id));
      });
    const totals = purchaseCheckInTotals(approved);
    const next = [
      ...approved.filter((item) => item.id === ticketId),
      ...approved.filter((item) => item.id !== ticketId),
    ].find(
      (item) => (Number(item.checked_in_count) || 0) < Number(item.quantity),
    );
    if (!next) {
      await client.query('ROLLBACK');
      return {
        status: 409,
        body: {
          ok: false,
          reason: 'already_checked_in',
          ...ticketCheckInView(latestCheckedInRow(approved, scanned)),
          purchase_checked_in: totals.checkedIn,
          purchase_quantity: totals.quantity,
        },
      };
    }

    const updated = await client.query(
      `UPDATE event_tickets
       SET checked_in_count = checked_in_count + 1,
           checked_in_at = COALESCE(checked_in_at, CURRENT_TIMESTAMP)
       WHERE id = $1
         AND status = 'approved'
         AND checked_in_count < quantity
         AND ($2::text IS NULL OR rental_id = $2)
       RETURNING *`,
      [next.id, rentalId || null],
    );
    if (updated.rowCount === 0) {
      await client.query('ROLLBACK');
      return {
        status: 409,
        body: {
          ok: false,
          reason: 'already_checked_in',
          ...ticketCheckInView(next),
          purchase_checked_in: totals.checkedIn,
          purchase_quantity: totals.quantity,
        },
      };
    }

    await client.query('COMMIT');
    return {
      status: 200,
      body: {
        ok: true,
        ticket: mapTicket(updated.rows[0]),
        event_name: next.activity_name,
        ticket_type_name: next.ticket_type_name,
        admitted_quantity: 1,
        purchase_checked_in: totals.checkedIn + 1,
        purchase_quantity: totals.quantity,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
