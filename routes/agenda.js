import crypto from 'crypto';
import express from 'express';
import db from '../database.js';

const router = express.Router();

/** API always exposes agenda dates as YYYY-MM-DD (pg may return Date or ISO string). */
function sqlDateToYmd(value) {
  if (value == null || value === '') return undefined;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const s = String(value);
  return s.includes('T') ? s.slice(0, 10) : s.slice(0, 10);
}

/** Accepts YYYY-MM-DD or ISO datetime; stores as DATE in DB. */
function normalizeIncomingDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const s = String(value);
  return s.includes('T') ? s.slice(0, 10) : s.slice(0, 10);
}

const mapRoom = (row) => ({
  id: row.id,
  name: row.name,
  defaultPricePerHour: Number(row.default_price_per_hour),
  color: row.color,
});

const mapRental = (row) => ({
  id: row.id,
  type: row.type,
  personName: row.person_name,
  personPhone: row.person_phone,
  activityName: row.activity_name,
  roomId: row.room_id,
  notes: row.notes || undefined,
  finalized: Boolean(row.finalized),
  schedules: row.schedules || undefined,
  pricePerHour:
    row.price_per_hour != null ? Number(row.price_per_hour) : undefined,
  startMonth: row.start_month || undefined,
  endMonth: row.end_month || undefined,
  eventType: row.event_type || undefined,
  date: sqlDateToYmd(row.date),
  startTime: row.start_time || undefined,
  endTime: row.end_time || undefined,
  fixedPrice: row.fixed_price != null ? Number(row.fixed_price) : undefined,
  consumptionCredit:
    row.consumption_credit != null ? Number(row.consumption_credit) : undefined,
  hasTickets: row.has_tickets == null ? undefined : Boolean(row.has_tickets),
  ticketPrice: row.ticket_price != null ? Number(row.ticket_price) : undefined,
  revenueSharePercent:
    row.revenue_share_percent != null
      ? Number(row.revenue_share_percent)
      : undefined,
  dateSlots: row.date_slots || undefined,
  createdAt: new Date(row.created_at).toISOString(),
});

const mapPayment = (row) => ({
  id: row.id,
  rentalId: row.rental_id,
  month: row.month || undefined,
  amount: Number(row.amount),
  paymentMethod: row.payment_method,
  mercadoPagoAccountId: row.mercado_pago_account_id || undefined,
  description: row.description || undefined,
  paymentType: row.payment_type || undefined,
  paidDate: new Date(row.paid_date).toISOString(),
});

async function ensureFullVenueRoom(client) {
  await client.query(
    `INSERT INTO agenda_rooms (id, name, default_price_per_hour, color)
     VALUES ('full-venue', 'Lugar completo', 0, 'orange')
     ON CONFLICT (id) DO NOTHING`,
  );
}

function getFinanceAccountId(paymentMethod, mercadoPagoAccountId) {
  if (paymentMethod === 'mercadopago' && mercadoPagoAccountId) {
    return mercadoPagoAccountId;
  }
  return 'efectivo';
}

router.get('/rooms', async (_req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM agenda_rooms ORDER BY name ASC',
    );
    res.json(result.rows.map(mapRoom));
  } catch (error) {
    console.error('Error fetching agenda rooms:', error);
    res.status(500).json({ error: 'Error al obtener salas' });
  }
});

router.post('/rooms', async (req, res) => {
  try {
    const { name, defaultPricePerHour, color } = req.body;
    if (!name || !color || Number(defaultPricePerHour) < 0) {
      return res.status(400).json({ error: 'Datos inválidos de sala' });
    }
    const id = crypto.randomUUID();
    await db.query(
      'INSERT INTO agenda_rooms (id, name, default_price_per_hour, color) VALUES ($1, $2, $3, $4)',
      [id, String(name).trim(), Number(defaultPricePerHour), color],
    );
    const created = await db.query('SELECT * FROM agenda_rooms WHERE id = $1', [
      id,
    ]);
    res.status(201).json(mapRoom(created.rows[0]));
  } catch (error) {
    console.error('Error creating agenda room:', error);
    res.status(500).json({ error: 'Error al crear sala' });
  }
});

router.put('/rooms/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, defaultPricePerHour, color } = req.body;
    const result = await db.query(
      `UPDATE agenda_rooms
       SET
         name = COALESCE($1, name),
         default_price_per_hour = COALESCE($2, default_price_per_hour),
         color = COALESCE($3, color),
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $4`,
      [name ?? null, defaultPricePerHour ?? null, color ?? null, id],
    );
    if (result.rowCount === 0)
      return res.status(404).json({ error: 'Sala no encontrada' });
    const updated = await db.query('SELECT * FROM agenda_rooms WHERE id = $1', [
      id,
    ]);
    res.json(mapRoom(updated.rows[0]));
  } catch (error) {
    console.error('Error updating agenda room:', error);
    res.status(500).json({ error: 'Error al actualizar sala' });
  }
});

router.delete('/rooms/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const hasRentals = await db.query(
      'SELECT 1 FROM agenda_rentals WHERE room_id = $1 LIMIT 1',
      [id],
    );
    if (hasRentals.rows.length > 0) {
      return res
        .status(400)
        .json({
          error: 'No se puede eliminar una sala con alquileres asociados',
        });
    }
    const result = await db.query('DELETE FROM agenda_rooms WHERE id = $1', [
      id,
    ]);
    if (result.rowCount === 0)
      return res.status(404).json({ error: 'Sala no encontrada' });
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting agenda room:', error);
    res.status(500).json({ error: 'Error al eliminar sala' });
  }
});

router.get('/rentals', async (_req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM agenda_rentals ORDER BY created_at DESC',
    );
    res.json(result.rows.map(mapRental));
  } catch (error) {
    console.error('Error fetching agenda rentals:', error);
    res.status(500).json({ error: 'Error al obtener alquileres' });
  }
});

router.post('/rentals', async (req, res) => {
  try {
    const r = req.body;
    if (!r?.type || !r?.personName || !r?.activityName || !r?.roomId) {
      return res.status(400).json({ error: 'Datos inválidos de alquiler' });
    }
    if (r.roomId === 'full-venue') {
      await ensureFullVenueRoom(db);
    }
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO agenda_rentals (
        id, type, person_name, person_phone, activity_name, room_id, notes, finalized,
        schedules, price_per_hour, start_month, end_month, event_type, date, start_time, end_time,
        fixed_price, consumption_credit, has_tickets, ticket_price, revenue_share_percent, date_slots
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13, $14, $15, $16,
        $17, $18, $19, $20, $21, $22
      )`,
      [
        id,
        r.type,
        r.personName,
        r.personPhone ?? '',
        r.activityName,
        r.roomId,
        r.notes ?? null,
        r.finalized ? 1 : 0,
        r.schedules ? JSON.stringify(r.schedules) : null,
        r.pricePerHour ?? null,
        r.startMonth ?? null,
        r.endMonth ?? null,
        r.eventType ?? null,
        normalizeIncomingDate(r.date),
        r.startTime ?? null,
        r.endTime ?? null,
        r.fixedPrice ?? null,
        r.consumptionCredit ?? null,
        r.hasTickets == null ? null : r.hasTickets ? 1 : 0,
        r.ticketPrice ?? null,
        r.revenueSharePercent ?? null,
        r.dateSlots ? JSON.stringify(r.dateSlots) : null,
      ],
    );
    const created = await db.query(
      'SELECT * FROM agenda_rentals WHERE id = $1',
      [id],
    );
    res.status(201).json(mapRental(created.rows[0]));
  } catch (error) {
    console.error('Error creating agenda rental:', error);
    res.status(500).json({ error: 'Error al crear alquiler' });
  }
});

router.put('/rentals/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const r = req.body;
    const hasPersonPhone = Object.prototype.hasOwnProperty.call(
      r,
      'personPhone',
    );
    const personPhoneValue = hasPersonPhone ? (r.personPhone ?? '') : null;
    if (r.roomId === 'full-venue') {
      await ensureFullVenueRoom(db);
    }
    const result = await db.query(
      `UPDATE agenda_rentals SET
        type = COALESCE($1, type),
        person_name = COALESCE($2, person_name),
        person_phone = COALESCE($3, person_phone),
        activity_name = COALESCE($4, activity_name),
        room_id = COALESCE($5, room_id),
        notes = COALESCE($6, notes),
        finalized = COALESCE($7, finalized),
        schedules = COALESCE($8, schedules),
        price_per_hour = COALESCE($9, price_per_hour),
        start_month = COALESCE($10, start_month),
        end_month = COALESCE($11, end_month),
        event_type = COALESCE($12, event_type),
        date = COALESCE($13, date),
        start_time = COALESCE($14, start_time),
        end_time = COALESCE($15, end_time),
        fixed_price = COALESCE($16, fixed_price),
        consumption_credit = COALESCE($17, consumption_credit),
        has_tickets = COALESCE($18, has_tickets),
        ticket_price = COALESCE($19, ticket_price),
        revenue_share_percent = COALESCE($20, revenue_share_percent),
        date_slots = COALESCE($21, date_slots),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $22`,
      [
        r.type ?? null,
        r.personName ?? null,
        personPhoneValue,
        r.activityName ?? null,
        r.roomId ?? null,
        r.notes ?? null,
        r.finalized == null ? null : r.finalized ? 1 : 0,
        r.schedules ? JSON.stringify(r.schedules) : null,
        r.pricePerHour ?? null,
        r.startMonth ?? null,
        r.endMonth ?? null,
        r.eventType ?? null,
        r.date !== undefined ? normalizeIncomingDate(r.date) : null,
        r.startTime ?? null,
        r.endTime ?? null,
        r.fixedPrice ?? null,
        r.consumptionCredit ?? null,
        r.hasTickets == null ? null : r.hasTickets ? 1 : 0,
        r.ticketPrice ?? null,
        r.revenueSharePercent ?? null,
        r.dateSlots ? JSON.stringify(r.dateSlots) : null,
        id,
      ],
    );
    if (result.rowCount === 0)
      return res.status(404).json({ error: 'Alquiler no encontrado' });
    const updated = await db.query(
      'SELECT * FROM agenda_rentals WHERE id = $1',
      [id],
    );
    res.json(mapRental(updated.rows[0]));
  } catch (error) {
    console.error('Error updating agenda rental:', error);
    res.status(500).json({ error: 'Error al actualizar alquiler' });
  }
});

router.delete('/rentals/:id', async (req, res) => {
  try {
    const result = await db.query('DELETE FROM agenda_rentals WHERE id = $1', [
      req.params.id,
    ]);
    if (result.rowCount === 0)
      return res.status(404).json({ error: 'Alquiler no encontrado' });
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting agenda rental:', error);
    res.status(500).json({ error: 'Error al eliminar alquiler' });
  }
});

router.get('/payments', async (_req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM agenda_payments ORDER BY paid_date DESC',
    );
    res.json(result.rows.map(mapPayment));
  } catch (error) {
    console.error('Error fetching agenda payments:', error);
    res.status(500).json({ error: 'Error al obtener pagos' });
  }
});

router.post('/payments', async (req, res) => {
  const client = await db.connect();
  try {
    const p = req.body;
    if (!p?.rentalId || !p?.paymentMethod || Number(p.amount) <= 0) {
      return res.status(400).json({ error: 'Datos inválidos de pago' });
    }

    const rentalResult = await client.query(
      'SELECT * FROM agenda_rentals WHERE id = $1',
      [p.rentalId],
    );
    const rental = rentalResult.rows[0];
    if (!rental)
      return res.status(404).json({ error: 'Alquiler no encontrado' });

    const paymentId = crypto.randomUUID();
    const txId = crypto.randomUUID();
    const paidDate = p.paidDate || new Date().toISOString();
    const isTickets = p.paymentType === 'tickets';

    await client.query('BEGIN');
    await client.query(
      `INSERT INTO agenda_payments (
        id, rental_id, month, amount, payment_method, mercado_pago_account_id, description, payment_type, paid_date
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        paymentId,
        p.rentalId,
        p.month ?? null,
        Number(p.amount),
        p.paymentMethod,
        p.mercadoPagoAccountId ?? null,
        p.description ?? null,
        p.paymentType ?? 'rental',
        paidDate,
      ],
    );

    const baseDesc = `${rental.activity_name} (${rental.person_name})`;
    const txDescription =
      p.description?.trim() ||
      (isTickets
        ? `Entradas ${baseDesc}`
        : `${baseDesc}${p.month ? ` — ${p.month}` : ''}`);
    const txCategory = isTickets
      ? 'eventos'
      : rental.type === 'one-off'
        ? 'eventos'
        : 'agenda';

    await client.query(
      `INSERT INTO finance_transactions
      (id, account_id, type, amount, description, source, category, reference_id, date)
      VALUES ($1,$2,'income',$3,$4,'agenda',$5,$6,$7)`,
      [
        txId,
        getFinanceAccountId(p.paymentMethod, p.mercadoPagoAccountId),
        Number(p.amount),
        txDescription,
        txCategory,
        paymentId,
        paidDate,
      ],
    );
    await client.query('COMMIT');
    const created = await db.query(
      'SELECT * FROM agenda_payments WHERE id = $1',
      [paymentId],
    );
    res.status(201).json(mapPayment(created.rows[0]));
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating agenda payment:', error);
    res.status(500).json({ error: 'Error al registrar pago' });
  } finally {
    client.release();
  }
});

router.delete('/payments/:id', async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "DELETE FROM finance_transactions WHERE source = 'agenda' AND reference_id = $1",
      [req.params.id],
    );
    const result = await client.query(
      'DELETE FROM agenda_payments WHERE id = $1',
      [req.params.id],
    );
    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pago no encontrado' });
    }
    await client.query('COMMIT');
    res.status(204).send();
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error deleting agenda payment:', error);
    res.status(500).json({ error: 'Error al eliminar pago' });
  } finally {
    client.release();
  }
});

export default router;
