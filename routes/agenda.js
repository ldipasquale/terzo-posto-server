import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import express from 'express';
import multer from 'multer';
import db from '../database.js';
import { FINANCE_AREA_CATEGORY } from '../lib/financeAreas.js';
import {
  ensureFlyersDir,
  ensureRentalSlug,
  flyersDir,
  loadCatalog,
  loadTicketEmailContext,
  mapTicket,
  newId,
  receiptExtension,
  soldByType,
} from '../lib/eventTickets.js';
import { isValidEmail, sendTicketEmailForRow } from '../lib/ticketEmail.js';
import { resolveTicketTransferAccountId } from '../lib/ticketTransfer.js';
import { getVenueLocation } from '../lib/venueLocation.js';

const flyerUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);
    if (!ok) {
      cb(new Error('Solo se permiten imágenes JPEG, PNG o WebP'));
      return;
    }
    cb(null, true);
  },
});

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

function optionalBodyField(body, key, normalize) {
  const present = Object.prototype.hasOwnProperty.call(body, key);
  return {
    present,
    value: present ? normalize(body[key]) : null,
  };
}

function emptyToNullText(value) {
  if (value == null) return null;
  const t = String(value).trim();
  return t === '' ? null : t;
}

function emptyToNullCount(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
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
  roomId: row.room_id === 'full-space' ? 'full-venue' : row.room_id,
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
  hasTickets:
    row.has_tickets == null ? undefined : Number(row.has_tickets) === 1,
  hasEntradas:
    row.has_entradas == null
      ? Number(row.has_tickets) === 1 ||
        (row.ticket_price != null && Number(row.ticket_price) > 0)
      : Number(row.has_entradas) === 1,
  slug: row.slug || undefined,
  transferAlias: row.transfer_alias || undefined,
  transferHolder: row.transfer_holder || undefined,
  eventDescription: row.event_description || undefined,
  ticketPrice: row.ticket_price != null ? Number(row.ticket_price) : undefined,
  revenueSharePercent:
    row.revenue_share_percent != null
      ? Number(row.revenue_share_percent)
      : undefined,
  roomInsurancePrice:
    row.room_insurance_price != null
      ? Number(row.room_insurance_price)
      : undefined,
  staffCount: row.staff_count != null ? Number(row.staff_count) : undefined,
  staffFood: row.staff_food || undefined,
  staffDrinks: row.staff_drinks || undefined,
  eventTimeline: row.event_timeline || undefined,
  technicalNeeds: row.technical_needs || undefined,
  dateSlots: row.date_slots || undefined,
  createdAt: new Date(row.created_at).toISOString(),
});

function normalizeRoomId(roomId) {
  if (!roomId) return roomId;
  if (roomId === 'full-space') return 'full-venue';
  return roomId;
}

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

function isTicketIncomeType(paymentType) {
  return paymentType === 'tickets' || paymentType === 'ticket_sales';
}

function ticketNetAmount(row) {
  return Math.max(
    0,
    Number(row.quantity) * Number(row.unit_price) -
      (Number(row.discount_amount) || 0),
  );
}

async function loadTicketSalesTotals(client, rentalId) {
  const tickets = await client.query(
    `SELECT quantity, unit_price, discount_amount, payment_method
     FROM event_tickets
     WHERE rental_id = $1 AND status = 'approved'`,
    [rentalId],
  );
  let cash = 0;
  let cashQty = 0;
  let mp = 0;
  let mpQty = 0;
  for (const row of tickets.rows) {
    const amount = ticketNetAmount(row);
    const qty = Number(row.quantity);
    if (row.payment_method === 'efectivo') {
      cash += amount;
      cashQty += qty;
    } else {
      mp += amount;
      mpQty += qty;
    }
  }
  const closed = await client.query(
    `SELECT payment_method, COALESCE(SUM(amount), 0) AS amount
     FROM agenda_payments
     WHERE rental_id = $1 AND payment_type = 'ticket_sales'
     GROUP BY payment_method`,
    [rentalId],
  );
  let closedCash = 0;
  let closedMp = 0;
  for (const row of closed.rows) {
    if (row.payment_method === 'efectivo') closedCash = Number(row.amount);
    if (row.payment_method === 'mercadopago') closedMp = Number(row.amount);
  }
  cash = Math.round(cash);
  mp = Math.round(mp);
  closedCash = Math.round(closedCash);
  closedMp = Math.round(closedMp);
  return {
    cash,
    cashQty,
    mp,
    mpQty,
    closedCash,
    closedMp,
    pendingCash: Math.max(0, cash - closedCash),
    pendingMp: Math.max(0, mp - closedMp),
  };
}

async function insertAgendaPaymentWithFinance(client, rental, p) {
  const paymentId = crypto.randomUUID();
  const txId = crypto.randomUUID();
  const paidDate = p.paidDate || new Date().toISOString();
  const isTickets = isTicketIncomeType(p.paymentType);

  await client.query(
    `INSERT INTO agenda_payments (
      id, rental_id, month, amount, payment_method, mercado_pago_account_id, description, payment_type, paid_date
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      paymentId,
      rental.id,
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
  const txAreaCat = isTickets
    ? FINANCE_AREA_CATEGORY.eventTickets
    : rental.type === 'one-off'
      ? FINANCE_AREA_CATEGORY.eventRental
      : FINANCE_AREA_CATEGORY.workshopRental;
  const eventId = rental.type === 'one-off' ? rental.id : null;

  await client.query(
    `INSERT INTO finance_transactions
    (id, account_id, type, amount, description, source, area, category, reference_id, event_id, date)
    VALUES ($1,$2,'income',$3,$4,'agenda',$5,$6,$7,$8,$9)`,
    [
      txId,
      getFinanceAccountId(p.paymentMethod, p.mercadoPagoAccountId),
      Number(p.amount),
      txDescription,
      txAreaCat.area,
      txAreaCat.category,
      paymentId,
      eventId,
      paidDate,
    ],
  );
  return paymentId;
}

router.get('/rooms', async (_req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM agenda_rooms
       WHERE id NOT IN ('full-venue', 'full-space')
         AND LOWER(TRIM(name)) <> 'espacio completo'
       ORDER BY name ASC`,
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
    const roomId = normalizeRoomId(r?.roomId);
    const personName = String(r?.personName ?? '').trim();
    const requiresResponsible = r?.type !== 'one-off';
    if (
      !r?.type ||
      !String(r?.activityName ?? '').trim() ||
      !roomId ||
      (requiresResponsible && !personName)
    ) {
      return res.status(400).json({ error: 'Datos inválidos de alquiler' });
    }
    if (roomId === 'full-venue') {
      await ensureFullVenueRoom(db);
    }
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO agenda_rentals (
        id, type, person_name, person_phone, activity_name, room_id, notes, finalized,
        schedules, price_per_hour, start_month, end_month, event_type, date, start_time, end_time,
        fixed_price, consumption_credit, has_tickets, ticket_price, revenue_share_percent, room_insurance_price, date_slots,
        staff_count, staff_food, staff_drinks, event_timeline, technical_needs,
        transfer_alias, transfer_holder, event_description, has_entradas
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13, $14, $15, $16,
        $17, $18, $19, $20, $21, $22, $23,
        $24, $25, $26, $27, $28, $29, $30, $31, $32
      )`,
      [
        id,
        r.type,
        personName,
        r.personPhone ?? '',
        r.activityName,
        roomId,
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
        r.roomInsurancePrice ?? null,
        r.dateSlots ? JSON.stringify(r.dateSlots) : null,
        emptyToNullCount(r.staffCount),
        emptyToNullText(r.staffFood),
        emptyToNullText(r.staffDrinks),
        emptyToNullText(r.eventTimeline),
        emptyToNullText(r.technicalNeeds),
        emptyToNullText(r.transferAlias),
        emptyToNullText(r.transferHolder),
        emptyToNullText(r.eventDescription),
        r.hasEntradas == null ? null : r.hasEntradas ? 1 : 0,
      ],
    );
    const created = await db.query(
      'SELECT * FROM agenda_rentals WHERE id = $1',
      [id],
    );
    await ensureRentalSlug(db, created.rows[0]);
    const withSlug = await db.query(
      'SELECT * FROM agenda_rentals WHERE id = $1',
      [id],
    );
    res.status(201).json(mapRental(withSlug.rows[0]));
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
    const roomId = normalizeRoomId(r?.roomId);
    if (roomId === 'full-venue') {
      await ensureFullVenueRoom(db);
    }
    const hasNotes = Object.prototype.hasOwnProperty.call(r, 'notes');
    const notesValue = hasNotes
      ? r.notes == null || String(r.notes).trim() === ''
        ? null
        : String(r.notes).trim()
      : null;
    const staffCountField = optionalBodyField(r, 'staffCount', emptyToNullCount);
    const staffFoodField = optionalBodyField(r, 'staffFood', emptyToNullText);
    const staffDrinksField = optionalBodyField(r, 'staffDrinks', emptyToNullText);
    const eventTimelineField = optionalBodyField(
      r,
      'eventTimeline',
      emptyToNullText,
    );
    const technicalNeedsField = optionalBodyField(
      r,
      'technicalNeeds',
      emptyToNullText,
    );
    const transferAliasField = optionalBodyField(
      r,
      'transferAlias',
      emptyToNullText,
    );
    const transferHolderField = optionalBodyField(
      r,
      'transferHolder',
      emptyToNullText,
    );
    const eventDescriptionField = optionalBodyField(
      r,
      'eventDescription',
      emptyToNullText,
    );
    const result = await db.query(
      `UPDATE agenda_rentals SET
        type = COALESCE($1, type),
        person_name = COALESCE($2, person_name),
        person_phone = COALESCE($3, person_phone),
        activity_name = COALESCE($4, activity_name),
        room_id = COALESCE($5, room_id),
        notes = CASE WHEN $24::boolean THEN $6 ELSE notes END,
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
        room_insurance_price = COALESCE($21, room_insurance_price),
        date_slots = COALESCE($22, date_slots),
        staff_count = CASE WHEN $26::boolean THEN $25 ELSE staff_count END,
        staff_food = CASE WHEN $28::boolean THEN $27 ELSE staff_food END,
        staff_drinks = CASE WHEN $30::boolean THEN $29 ELSE staff_drinks END,
        event_timeline = CASE WHEN $32::boolean THEN $31 ELSE event_timeline END,
        technical_needs = CASE WHEN $34::boolean THEN $33 ELSE technical_needs END,
        transfer_alias = CASE WHEN $36::boolean THEN $35 ELSE transfer_alias END,
        transfer_holder = CASE WHEN $38::boolean THEN $37 ELSE transfer_holder END,
        event_description = CASE WHEN $40::boolean THEN $39 ELSE event_description END,
        has_entradas = COALESCE($41, has_entradas),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $23`,
      [
        r.type ?? null,
        r.personName ?? null,
        personPhoneValue,
        r.activityName ?? null,
        roomId ?? null,
        notesValue,
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
        r.roomInsurancePrice ?? null,
        r.dateSlots ? JSON.stringify(r.dateSlots) : null,
        id,
        hasNotes,
        staffCountField.value,
        staffCountField.present,
        staffFoodField.value,
        staffFoodField.present,
        staffDrinksField.value,
        staffDrinksField.present,
        eventTimelineField.value,
        eventTimelineField.present,
        technicalNeedsField.value,
        technicalNeedsField.present,
        transferAliasField.value,
        transferAliasField.present,
        transferHolderField.value,
        transferHolderField.present,
        eventDescriptionField.value,
        eventDescriptionField.present,
        r.hasEntradas == null ? null : r.hasEntradas ? 1 : 0,
      ],
    );
    if (result.rowCount === 0)
      return res.status(404).json({ error: 'Alquiler no encontrado' });
    const updated = await db.query(
      'SELECT * FROM agenda_rentals WHERE id = $1',
      [id],
    );
    await ensureRentalSlug(db, updated.rows[0]);
    const withSlug = await db.query(
      'SELECT * FROM agenda_rentals WHERE id = $1',
      [id],
    );
    res.json(mapRental(withSlug.rows[0]));
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

    await client.query('BEGIN');
    const paymentId = await insertAgendaPaymentWithFinance(client, rental, p);
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

router.get('/ticket-catalogs', async (_req, res) => {
  try {
    const rentals = await db.query(
      `SELECT r.*
       FROM agenda_rentals r
       WHERE r.type = 'one-off'
         AND (
           r.has_tickets = 1
           OR EXISTS (
             SELECT 1 FROM event_ticket_types t WHERE t.rental_id = r.id
           )
         )
       ORDER BY r.date DESC NULLS LAST, r.created_at DESC`,
    );
    const catalogs = [];
    for (const rental of rentals.rows) {
      catalogs.push(await loadCatalog(db, rental));
    }
    res.json(catalogs);
  } catch (error) {
    console.error('Error fetching ticket catalogs:', error);
    res.status(500).json({ error: 'Error al obtener catálogos de entradas' });
  }
});

router.put('/rentals/:id/ticket-types', async (req, res) => {
  const client = await db.connect();
  try {
    const rentalId = req.params.id;
    const incoming = Array.isArray(req.body?.ticket_types)
      ? req.body.ticket_types
      : [];
    await client.query('BEGIN');
    const rentalResult = await client.query(
      'SELECT * FROM agenda_rentals WHERE id = $1 FOR UPDATE',
      [rentalId],
    );
    const rental = rentalResult.rows[0];
    if (!rental) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Evento no encontrado' });
    }

    const existing = await client.query(
      'SELECT * FROM event_ticket_types WHERE rental_id = $1',
      [rentalId],
    );
    const existingById = new Map(existing.rows.map((row) => [row.id, row]));
    const keepIds = new Set();

    for (const [index, type] of incoming.entries()) {
      const name = String(type?.name || '').trim();
      const price = Number(type?.price);
      const available = Number(type?.available_quantity);
      if (!name || !Number.isFinite(price) || price < 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Tipo de entrada inválido' });
      }
      if (!Number.isInteger(available) || available < 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Cupo inválido' });
      }

      const id = String(type?.id || '').trim() || newId();
      const current = existingById.get(id);
      if (current) {
        const soldResult = await client.query(
          `SELECT COALESCE(SUM(quantity), 0)::int AS sold
           FROM event_tickets
           WHERE ticket_type_id = $1 AND status <> 'rejected'`,
          [id],
        );
        const sold = Number(soldResult.rows[0].sold);
        if (available < sold) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: `El cupo de "${name}" no puede ser menor a las ${sold} vendidas`,
          });
        }
        await client.query(
          `UPDATE event_ticket_types
           SET name = $1, price = $2, available_quantity = $3, position = $4
           WHERE id = $5`,
          [name, price, available, index, id],
        );
        keepIds.add(id);
      } else {
        await client.query(
          `INSERT INTO event_ticket_types (
            id, rental_id, name, price, available_quantity, position
          ) VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, rentalId, name, price, available, index],
        );
        keepIds.add(id);
      }
    }

    for (const row of existing.rows) {
      if (keepIds.has(row.id)) continue;
      const soldResult = await client.query(
        `SELECT COALESCE(SUM(quantity), 0)::int AS sold
         FROM event_tickets
         WHERE ticket_type_id = $1 AND status <> 'rejected'`,
        [row.id],
      );
      if (Number(soldResult.rows[0].sold) > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `No se puede eliminar "${row.name}" porque ya tiene ventas`,
        });
      }
      await client.query('DELETE FROM event_ticket_types WHERE id = $1', [
        row.id,
      ]);
    }

    await ensureRentalSlug(client, {
      ...rental,
      has_tickets: rental.has_tickets ?? 1,
    });
    await client.query('COMMIT');

    const fresh = await db.query('SELECT * FROM agenda_rentals WHERE id = $1', [
      rentalId,
    ]);
    res.json(await loadCatalog(db, fresh.rows[0]));
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error saving ticket types:', error);
    res.status(500).json({ error: 'Error al guardar tipos de entrada' });
  } finally {
    client.release();
  }
});

router.get('/rentals/:id/tickets', async (req, res) => {
  try {
    const status = String(req.query.status || 'all');
    const params = [req.params.id];
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
    res.json(result.rows.map(mapTicket));
  } catch (error) {
    console.error('Error fetching event tickets:', error);
    res.status(500).json({ error: 'Error al obtener entradas' });
  }
});

router.post('/rentals/:id/tickets', async (req, res) => {
  const client = await db.connect();
  try {
    const rentalId = req.params.id;
    const ticketTypeId = String(req.body?.ticket_type_id || '').trim();
    const quantity = Number(req.body?.quantity);
    const buyerName = String(req.body?.buyer_name || '').trim();
    const buyerEmail = String(req.body?.buyer_email || '').trim().toLowerCase();
    const paymentMethod = String(req.body?.payment_method || '');
    const discountAmount = Math.max(0, Number(req.body?.discount_amount) || 0);

    if (!ticketTypeId) {
      return res.status(400).json({ error: 'Elegí el tipo de entrada' });
    }
    if (!Number.isInteger(quantity) || quantity < 1) {
      return res.status(400).json({ error: 'Cantidad inválida' });
    }
    if (!['efectivo', 'mercadopago'].includes(paymentMethod)) {
      return res.status(400).json({ error: 'Elegí el medio de pago' });
    }
    if (buyerEmail && !isValidEmail(buyerEmail)) {
      return res.status(400).json({ error: 'Revisá el mail' });
    }

    await client.query('BEGIN');
    const rentalResult = await client.query(
      'SELECT * FROM agenda_rentals WHERE id = $1 FOR UPDATE',
      [rentalId],
    );
    const rental = rentalResult.rows[0];
    if (!rental || Number(rental.has_tickets) !== 1) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Evento no encontrado' });
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
      return res.status(400).json({ error: 'Tipo de entrada no encontrado' });
    }

    const soldMap = await soldByType(client, rentalId);
    const sold = soldMap.get(type.id) || 0;
    const remaining = Math.max(0, Number(type.available_quantity) - sold);
    if (quantity > remaining) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'No hay cupo suficiente para esa cantidad' });
    }

    const subtotal = Number(type.price) * quantity;
    if (discountAmount > subtotal) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'El descuento no puede superar el total' });
    }
    const unitPrice = Number(type.price);
    const mpAccountId =
      paymentMethod === 'mercadopago'
        ? await resolveTicketTransferAccountId(client, rental)
        : null;

    const ticketId = newId();
    await client.query(
      `INSERT INTO event_tickets (
        id, rental_id, ticket_type_id, quantity, unit_price,
        buyer_name, buyer_phone, buyer_email, receipt_file, status,
        payment_method, mercado_pago_account_id, discount_amount, source,
        purchase_date
      ) VALUES (
        $1,$2,$3,$4,$5,$6,'',$7,NULL,'approved',
        $8,$9,$10,'door', CURRENT_TIMESTAMP
      )`,
      [
        ticketId,
        rentalId,
        type.id,
        quantity,
        unitPrice,
        buyerName,
        buyerEmail,
        paymentMethod,
        mpAccountId,
        discountAmount,
      ],
    );
    await client.query('COMMIT');

    const created = await db.query('SELECT * FROM event_tickets WHERE id = $1', [
      ticketId,
    ]);
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
    res.status(201).json({ ...mapTicket(created.rows[0]), email_sent: emailSent });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error selling door ticket:', error);
    res.status(500).json({ error: 'Error al registrar la venta' });
  } finally {
    client.release();
  }
});

router.post('/rentals/:id/ticket-sales/close', async (req, res) => {
  const client = await db.connect();
  try {
    const rentalId = req.params.id;
    await client.query('BEGIN');
    const rentalResult = await client.query(
      'SELECT * FROM agenda_rentals WHERE id = $1 FOR UPDATE',
      [rentalId],
    );
    const rental = rentalResult.rows[0];
    if (!rental || Number(rental.has_tickets) !== 1) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Evento no encontrado' });
    }

    const mpAccountId = await resolveTicketTransferAccountId(client, rental);
    if (!mpAccountId) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'El alias de este evento no es una cuenta propia',
      });
    }

    const totals = await loadTicketSalesTotals(client, rentalId);
    if (totals.pendingCash <= 0 && totals.pendingMp <= 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'No hay ventas nuevas para registrar' });
    }

    const paidDate = new Date().toISOString();
    const description = `Venta de entradas · ${rental.activity_name}`;
    const paymentIds = [];
    if (totals.pendingCash > 0) {
      paymentIds.push(
        await insertAgendaPaymentWithFinance(client, rental, {
          amount: totals.pendingCash,
          paymentMethod: 'efectivo',
          paymentType: 'ticket_sales',
          description,
          paidDate,
        }),
      );
    }
    if (totals.pendingMp > 0) {
      paymentIds.push(
        await insertAgendaPaymentWithFinance(client, rental, {
          amount: totals.pendingMp,
          paymentMethod: 'mercadopago',
          mercadoPagoAccountId: mpAccountId,
          paymentType: 'ticket_sales',
          description,
          paidDate,
        }),
      );
    }
    await client.query('COMMIT');

    const created = await db.query(
      `SELECT * FROM agenda_payments WHERE id = ANY($1::text[])`,
      [paymentIds],
    );
    res.status(201).json({
      ...totals,
      payments: created.rows.map(mapPayment),
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error closing ticket sales:', error);
    res.status(500).json({ error: 'Error al cerrar la venta de entradas' });
  } finally {
    client.release();
  }
});

const TICKET_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ticketCheckInView(row) {
  return {
    ticket: mapTicket(row),
    event_name: row.activity_name,
    ticket_type_name: row.ticket_type_name,
  };
}

router.post('/tickets/check-in', async (req, res) => {
  try {
    const ticketId = String(req.body?.ticket_id || '').trim();
    if (!TICKET_ID_RE.test(ticketId)) {
      return res.status(409).json({ ok: false, reason: 'invalid_code' });
    }

    const found = await db.query(
      `SELECT t.*, r.activity_name, tt.name AS ticket_type_name
       FROM event_tickets t
       JOIN agenda_rentals r ON r.id = t.rental_id
       JOIN event_ticket_types tt ON tt.id = t.ticket_type_id
       WHERE t.id = $1`,
      [ticketId],
    );
    const row = found.rows[0];
    if (!row) {
      return res.status(409).json({ ok: false, reason: 'not_found' });
    }
    const view = ticketCheckInView(row);
    if (row.status === 'pending') {
      return res.status(409).json({ ok: false, reason: 'pending', ...view });
    }
    if (row.status === 'rejected') {
      return res.status(409).json({ ok: false, reason: 'rejected', ...view });
    }
    if (row.checked_in_at) {
      return res.status(409).json({
        ok: false,
        reason: 'already_checked_in',
        ...view,
      });
    }

    const updated = await db.query(
      `UPDATE event_tickets
       SET checked_in_at = CURRENT_TIMESTAMP
       WHERE id = $1
         AND status = 'approved'
         AND checked_in_at IS NULL
       RETURNING *`,
      [ticketId],
    );
    if (updated.rowCount === 0) {
      return res.status(409).json({
        ok: false,
        reason: 'already_checked_in',
        ...view,
      });
    }

    res.json({
      ok: true,
      ticket: mapTicket(updated.rows[0]),
      event_name: row.activity_name,
      ticket_type_name: row.ticket_type_name,
    });
  } catch (error) {
    console.error('Error checking in ticket:', error);
    res.status(500).json({ error: 'Error al registrar el ingreso' });
  }
});

function removeFlyerFile(fileName) {
  if (!fileName) return;
  const filePath = path.join(flyersDir(), fileName);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

router.post('/rentals/:id/flyer', (req, res) => {
  flyerUpload.single('flyer')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'Flyer inválido' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Subí una imagen de flyer' });
    }
    try {
      const rentalId = req.params.id;
      const current = await db.query(
        'SELECT id, flyer_file FROM agenda_rentals WHERE id = $1',
        [rentalId],
      );
      if (current.rowCount === 0) {
        return res.status(404).json({ error: 'Evento no encontrado' });
      }
      const dir = ensureFlyersDir();
      const flyerFile = `${newId()}.${receiptExtension(req.file.mimetype)}`;
      fs.writeFileSync(path.join(dir, flyerFile), req.file.buffer);
      await db.query(
        'UPDATE agenda_rentals SET flyer_file = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [flyerFile, rentalId],
      );
      removeFlyerFile(current.rows[0].flyer_file);
      const fresh = await db.query('SELECT * FROM agenda_rentals WHERE id = $1', [
        rentalId,
      ]);
      res.json(await loadCatalog(db, fresh.rows[0]));
    } catch (error) {
      console.error('Error uploading flyer:', error);
      res.status(500).json({ error: 'Error al subir el flyer' });
    }
  });
});

router.delete('/rentals/:id/flyer', async (req, res) => {
  try {
    const current = await db.query(
      'SELECT id, flyer_file FROM agenda_rentals WHERE id = $1',
      [req.params.id],
    );
    if (current.rowCount === 0) {
      return res.status(404).json({ error: 'Evento no encontrado' });
    }
    await db.query(
      'UPDATE agenda_rentals SET flyer_file = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
      [req.params.id],
    );
    removeFlyerFile(current.rows[0].flyer_file);
    const fresh = await db.query('SELECT * FROM agenda_rentals WHERE id = $1', [
      req.params.id,
    ]);
    res.json(await loadCatalog(db, fresh.rows[0]));
  } catch (error) {
    console.error('Error deleting flyer:', error);
    res.status(500).json({ error: 'Error al quitar el flyer' });
  }
});

router.patch('/tickets/:id', async (req, res) => {
  try {
    const status = String(req.body?.status || '');
    if (!['pending', 'approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Estado inválido' });
    }
    const result = await db.query(
      'UPDATE event_tickets SET status = $1 WHERE id = $2 RETURNING *',
      [status, req.params.id],
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Entrada no encontrada' });
    }
    res.json(mapTicket(result.rows[0]));
  } catch (error) {
    console.error('Error updating ticket status:', error);
    res.status(500).json({ error: 'Error al actualizar la entrada' });
  }
});

router.post('/tickets/:id/resend-email', async (req, res) => {
  try {
    const row = await loadTicketEmailContext(db, req.params.id);
    if (!row) {
      return res.status(404).json({ error: 'Entrada no encontrada' });
    }
    if (row.status === 'rejected') {
      return res.status(409).json({ error: 'No se puede reenviar una entrada rechazada' });
    }
    if (!row.buyer_email) {
      return res.status(400).json({ error: 'Esta entrada no tiene mail' });
    }
    const sent = await sendTicketEmailForRow(row, await getVenueLocation(db));
    if (!sent) {
      return res.status(502).json({ error: 'No se pudo enviar el mail' });
    }
    res.json({ ok: true });
  } catch (error) {
    console.error('Error resending ticket email:', error);
    res.status(500).json({ error: 'Error al reenviar la entrada' });
  }
});

export default router;
