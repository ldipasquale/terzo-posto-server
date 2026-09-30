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
  newId,
  saveEventTicketPromos,
  receiptExtension,
  ticketFaceAmount,
  venueTicketCharge,
} from '../lib/eventTickets.js';
import {
  loadTicketCloseWeights,
  saveEventTicketMenuItems,
  splitTicketCloseAmount,
  weightsForTicketPayment,
} from '../lib/ticketMenu.js';
import { sendTicketEmailForRow } from '../lib/ticketEmail.js';
import { resolveTicketTransferAccountId } from '../lib/ticketTransfer.js';
import { getVenueLocation } from '../lib/venueLocation.js';
import {
  checkInTicket,
  listEventTickets,
  sellDoorTicket,
  updateTicketStatus,
} from '../lib/ticketOperations.js';
import {
  normalizeSharePassword,
  readTicketShare,
  saveTicketShare,
  sharePasswordError,
} from '../lib/ticketShare.js';

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

const PARTNERS = ['Lucho', 'Bachi', 'Luli'];

function parseResponsibleName(value) {
  if (value == null) return null;
  const name = String(value).trim();
  if (!name) return '';
  return PARTNERS.includes(name) ? name : undefined;
}

function partnerFromUserName(name) {
  if (!name) return null;
  const normalized = String(name).trim().toLowerCase();
  const exact = PARTNERS.find((p) => p.toLowerCase() === normalized);
  if (exact) return exact;
  return PARTNERS.find((p) => normalized.includes(p.toLowerCase())) ?? null;
}

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
  responsibleName: row.responsible_name || undefined,
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
  ticketSalesClosedAt: row.ticket_sales_closed_at
    ? new Date(row.ticket_sales_closed_at).toISOString()
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

function rentalSharePercent(rental) {
  return rental?.revenue_share_percent == null
    ? 30
    : Number(rental.revenue_share_percent);
}

async function loadVenueTicketCharge(client, rental) {
  const tickets = await client.query(
    `SELECT quantity, unit_price, discount_amount
     FROM event_tickets
     WHERE rental_id = $1 AND status = 'approved'`,
    [rental.id],
  );
  const sold = tickets.rows.reduce(
    (sum, row) => sum + ticketFaceAmount(row),
    0,
  );
  const closed = await client.query(
    `SELECT COALESCE(SUM(amount), 0) AS amount
     FROM agenda_payments
     WHERE rental_id = $1 AND payment_type = 'ticket_sales'`,
    [rental.id],
  );
  return venueTicketCharge({
    sold,
    percent: rentalSharePercent(rental),
    roomInsurance: rental.room_insurance_price,
    alreadyPaid: closed.rows[0]?.amount,
  });
}

async function insertAgendaPaymentWithFinance(client, rental, p) {
  const paymentId = crypto.randomUUID();
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
  const accountId = getFinanceAccountId(p.paymentMethod, p.mercadoPagoAccountId);
  const slices = Array.isArray(p.financeSlices) && p.financeSlices.length
    ? p.financeSlices
    : [{
        amount: Number(p.amount),
        description: txDescription,
        area: txAreaCat.area,
        category: txAreaCat.category,
        referenceId: paymentId,
      }];

  for (const slice of slices) {
    const sliceAmount = Number(slice.amount);
    if (!Number.isFinite(sliceAmount) || sliceAmount <= 0) continue;
    const referenceId = slice.referenceKind
      ? `ticket-menu:${paymentId}:${slice.referenceKind}`
      : slice.referenceId || paymentId;
    await client.query(
      `INSERT INTO finance_transactions
      (id, account_id, type, amount, description, source, area, category, reference_id, event_id, date)
      VALUES ($1,$2,'income',$3,$4,'agenda',$5,$6,$7,$8,$9)`,
      [
        crypto.randomUUID(),
        accountId,
        sliceAmount,
        slice.description,
        slice.area,
        slice.category,
        referenceId,
        eventId,
        paidDate,
      ],
    );
  }
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
    const requiresContact = r?.type !== 'one-off';
    const responsibleParsed = parseResponsibleName(r?.responsibleName);
    if (responsibleParsed === undefined) {
      return res.status(400).json({ error: 'Responsable inválido' });
    }
    const responsibleName =
      responsibleParsed || partnerFromUserName(req.user?.name) || null;
    if (
      !r?.type ||
      !String(r?.activityName ?? '').trim() ||
      !roomId ||
      (requiresContact && !personName)
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
        transfer_alias, transfer_holder, event_description, has_entradas, responsible_name
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13, $14, $15, $16,
        $17, $18, $19, $20, $21, $22, $23,
        $24, $25, $26, $27, $28, $29, $30, $31, $32, $33
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
        responsibleName,
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
    let responsibleNameField = { present: false, value: null };
    if (Object.prototype.hasOwnProperty.call(r, 'responsibleName')) {
      const parsed = parseResponsibleName(r.responsibleName);
      if (parsed === undefined) {
        return res.status(400).json({ error: 'Responsable inválido' });
      }
      responsibleNameField = { present: true, value: parsed || null };
    }
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
        responsible_name = CASE WHEN $43::boolean THEN $42 ELSE responsible_name END,
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
        responsibleNameField.value,
        responsibleNameField.present,
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

const MAX_EVENT_DOCUMENT_CHARS = 400_000;
const EMPTY_EVENT_DOCUMENT = { type: 'doc', content: [{ type: 'paragraph' }] };

function parseEventDocumentContent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.type !== 'doc') return null;
  if (value.content != null && !Array.isArray(value.content)) return null;
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return null;
  }
  if (!serialized || serialized.length > MAX_EVENT_DOCUMENT_CHARS) return null;
  return JSON.parse(serialized);
}

function documentTimestamp(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function loadOneOffEvent(id) {
  const result = await db.query(
    'SELECT id, type, activity_name, date FROM agenda_rentals WHERE id = $1',
    [id],
  );
  const row = result.rows[0];
  if (!row || row.type !== 'one-off') return null;
  return row;
}

function mapEventDocument(rental, row) {
  let content = row?.content ?? EMPTY_EVENT_DOCUMENT;
  if (typeof content === 'string') {
    try {
      content = JSON.parse(content);
    } catch {
      content = EMPTY_EVENT_DOCUMENT;
    }
  }
  if (!content || content.type !== 'doc') content = EMPTY_EVENT_DOCUMENT;
  return {
    rentalId: rental.id,
    activityName: rental.activity_name,
    date: sqlDateToYmd(rental.date),
    content,
    updatedAt: documentTimestamp(row?.updated_at),
  };
}

router.get('/rentals/:id/document', async (req, res) => {
  try {
    const rental = await loadOneOffEvent(req.params.id);
    if (!rental) return res.status(404).json({ error: 'Evento no encontrado' });
    const doc = await db.query(
      'SELECT content, updated_at FROM event_documents WHERE rental_id = $1',
      [rental.id],
    );
    res.json(mapEventDocument(rental, doc.rows[0]));
  } catch (error) {
    console.error('Error fetching event document:', error);
    res.status(500).json({ error: 'Error al obtener el documento' });
  }
});

router.put('/rentals/:id/document', async (req, res) => {
  try {
    const rental = await loadOneOffEvent(req.params.id);
    if (!rental) return res.status(404).json({ error: 'Evento no encontrado' });
    const content = parseEventDocumentContent(req.body?.content);
    if (!content) {
      return res.status(400).json({ error: 'El documento no es válido' });
    }
    const saved = await db.query(
      `INSERT INTO event_documents (rental_id, content, updated_at)
       VALUES ($1, $2::jsonb, CURRENT_TIMESTAMP)
       ON CONFLICT (rental_id) DO UPDATE
       SET content = EXCLUDED.content, updated_at = CURRENT_TIMESTAMP
       RETURNING content, updated_at`,
      [rental.id, JSON.stringify(content)],
    );
    res.json(mapEventDocument(rental, saved.rows[0]));
  } catch (error) {
    console.error('Error saving event document:', error);
    res.status(500).json({ error: 'Error al guardar el documento' });
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
      `DELETE FROM finance_transactions
       WHERE source = 'agenda'
         AND (
           reference_id = $1
           OR reference_id LIKE 'ticket-menu:' || $1 || ':%'
         )`,
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

router.get('/ticket-alerts', async (_req, res) => {
  try {
    const pendingResult = await db.query(
      `SELECT
         r.id AS rental_id,
         r.activity_name,
         r.responsible_name,
         r.date,
         r.start_time,
         r.end_time,
         COUNT(*)::int AS count,
         COALESCE(SUM(t.quantity), 0)::int AS quantity
       FROM event_tickets t
       JOIN agenda_rentals r ON r.id = t.rental_id
       WHERE t.status = 'pending'
       GROUP BY r.id, r.activity_name, r.responsible_name, r.date, r.start_time, r.end_time
       ORDER BY r.date ASC NULLS LAST, r.activity_name ASC`,
    );

    const approvedResult = await db.query(
      `SELECT rental_id, quantity, unit_price, discount_amount
       FROM event_tickets
       WHERE status = 'approved'`,
    );
    const closedResult = await db.query(
      `SELECT rental_id, amount
       FROM agenda_payments
       WHERE payment_type = 'ticket_sales'`,
    );
    const rentalsResult = await db.query(
      `SELECT id, activity_name, responsible_name, date, start_time, end_time,
              revenue_share_percent, room_insurance_price
       FROM agenda_rentals
       WHERE ticket_sales_closed_at IS NULL
         AND (
           has_tickets = 1
           OR id IN (
             SELECT DISTINCT rental_id FROM event_tickets WHERE status = 'approved'
           )
         )`,
    );

    const closedByRental = new Map();
    for (const row of closedResult.rows) {
      closedByRental.set(
        row.rental_id,
        (closedByRental.get(row.rental_id) || 0) + (Number(row.amount) || 0),
      );
    }

    const soldByRental = new Map();
    for (const row of approvedResult.rows) {
      soldByRental.set(
        row.rental_id,
        (soldByRental.get(row.rental_id) || 0) + ticketFaceAmount(row),
      );
    }

    const unclosedTicketSales = [];
    for (const rental of rentalsResult.rows) {
      const charge = venueTicketCharge({
        sold: soldByRental.get(rental.id) || 0,
        percent: rentalSharePercent(rental),
        roomInsurance: rental.room_insurance_price,
        alreadyPaid: closedByRental.get(rental.id) || 0,
      });
      if (charge.pending <= 0) continue;
      unclosedTicketSales.push({
        rentalId: rental.id,
        eventName: rental.activity_name,
        eventDate: sqlDateToYmd(rental.date) || null,
        startTime: rental.start_time || null,
        endTime: rental.end_time || null,
        responsibleName: rental.responsible_name || undefined,
        pendingCash: charge.pending,
        pendingMp: 0,
      });
    }

    res.json({
      pendingTickets: pendingResult.rows.map((row) => ({
        rentalId: row.rental_id,
        eventName: row.activity_name,
        eventDate: sqlDateToYmd(row.date) || null,
        startTime: row.start_time || null,
        endTime: row.end_time || null,
        responsibleName: row.responsible_name || undefined,
        count: Number(row.count) || 0,
        quantity: Number(row.quantity) || 0,
      })),
      unclosedTicketSales,
    });
  } catch (error) {
    console.error('Error fetching ticket alerts:', error);
    res.status(500).json({ error: 'Error al obtener alertas de entradas' });
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

    if (incoming.length > 0) {
      await client.query(
        `UPDATE agenda_rentals
         SET has_tickets = 1, has_entradas = 1
         WHERE id = $1`,
        [rentalId],
      );
    }
    if (
      Object.prototype.hasOwnProperty.call(req.body || {}, 'menu_items') ||
      Object.prototype.hasOwnProperty.call(req.body || {}, 'menu_item_ids')
    ) {
      await saveEventTicketMenuItems(
        client,
        rentalId,
        req.body.menu_items ?? req.body.menu_item_ids,
      );
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'promos')) {
      await saveEventTicketPromos(client, rentalId, req.body.promos);
    }
    await ensureRentalSlug(client, {
      ...rental,
      has_tickets: incoming.length > 0 ? 1 : rental.has_tickets,
    });
    await client.query('COMMIT');

    const fresh = await db.query('SELECT * FROM agenda_rentals WHERE id = $1', [
      rentalId,
    ]);
    res.json(await loadCatalog(db, fresh.rows[0]));
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error saving ticket types:', error);
    if (error.status === 400) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: 'Error al guardar tipos de entrada' });
  } finally {
    client.release();
  }
});

router.get('/rentals/:id/ticket-share', async (req, res) => {
  try {
    const share = await readTicketShare(req.params.id);
    if (!share) {
      return res.status(404).json({ error: 'Evento no encontrado' });
    }
    res.json(share);
  } catch (error) {
    console.error('Error reading ticket share:', error);
    res.status(500).json({ error: 'Error al obtener el link' });
  }
});

router.put('/rentals/:id/ticket-share', async (req, res) => {
  try {
    const password = normalizeSharePassword(req.body?.password);
    const passwordError = sharePasswordError(password);
    if (passwordError) {
      return res.status(400).json({ error: passwordError });
    }
    const share = await saveTicketShare(req.params.id, password);
    if (!share) {
      return res.status(404).json({ error: 'Evento no encontrado' });
    }
    res.json(share);
  } catch (error) {
    console.error('Error saving ticket share:', error);
    res.status(500).json({ error: 'Error al generar el link' });
  }
});

router.get('/rentals/:id/tickets', async (req, res) => {
  try {
    const status = String(req.query.status || 'all');
    res.json(await listEventTickets(req.params.id, status));
  } catch (error) {
    console.error('Error fetching event tickets:', error);
    res.status(500).json({ error: 'Error al obtener entradas' });
  }
});

router.post('/rentals/:id/tickets', async (req, res) => {
  try {
    const result = await sellDoorTicket(req.params.id, req.body);
    res.status(result.status).json(result.body);
  } catch (error) {
    console.error('Error selling door ticket:', error);
    res.status(500).json({ error: 'Error al registrar la venta' });
  }
});

function closeAmount(value) {
  const amount = Math.round(Number(value) || 0);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function parseClosePayments(body) {
  const raw = Array.isArray(body?.payments) ? body.payments : [];
  return raw.flatMap((item) => {
    const amount = closeAmount(item?.amount);
    if (amount <= 0) return [];
    if (item?.payment_method === 'efectivo') {
      return [{ paymentMethod: 'efectivo', amount, mercadoPagoAccountId: null }];
    }
    const accountId = String(item?.mercado_pago_account_id || '').trim();
    if (!accountId) {
      const error = new Error('Elegí la cuenta de Mercado Pago');
      error.status = 400;
      throw error;
    }
    return [{
      paymentMethod: 'mercadopago',
      amount,
      mercadoPagoAccountId: accountId,
    }];
  });
}

router.post('/rentals/:id/ticket-sales/close', async (req, res) => {
  let payments;
  try {
    payments = parseClosePayments(req.body);
  } catch (error) {
    return res.status(error.status || 400).json({
      error: error.message || 'Revisá los medios de pago',
    });
  }

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
    if (rental.ticket_sales_closed_at) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'La venta de entradas ya está cerrada' });
    }

    const mpIds = [
      ...new Set(
        payments
          .filter((payment) => payment.paymentMethod === 'mercadopago')
          .map((payment) => payment.mercadoPagoAccountId),
      ),
    ];
    if (mpIds.length > 0) {
      const accounts = await client.query(
        `SELECT id FROM mercado_pago_accounts
         WHERE id = ANY($1::text[])
           AND active = 1
           AND COALESCE(kind, 'mercadopago') = 'mercadopago'`,
        [mpIds],
      );
      if (accounts.rowCount !== mpIds.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'La cuenta de Mercado Pago no es válida' });
      }
    }

    const charge = await loadVenueTicketCharge(client, rental);
    const paidDate = new Date().toISOString();
    const ticketDescription = `Cobro de entradas · ${rental.activity_name}`;
    // Con el 100% el club cobra entrada y menú: se parte el ingreso.
    // Con otro porcentaje el cobro es solo la parte de las entradas.
    const closeWeights = rentalSharePercent(rental) === 100
      ? await loadTicketCloseWeights(client, rental.id)
      : null;
    const paymentIds = [];
    for (const payment of payments) {
      const parts = closeWeights
        ? splitTicketCloseAmount(
            payment.amount,
            weightsForTicketPayment(closeWeights, payment),
          )
        : { entradas: payment.amount, comida: 0, bebida: 0 };
      const slices = [];
      if (parts.entradas > 0) {
        slices.push({
          amount: parts.entradas,
          description: ticketDescription,
          area: FINANCE_AREA_CATEGORY.eventTickets.area,
          category: FINANCE_AREA_CATEGORY.eventTickets.category,
          referenceId: null,
        });
      }
      if (parts.comida > 0) {
        slices.push({
          amount: parts.comida,
          description: `Venta de comida · ${rental.activity_name}`,
          area: FINANCE_AREA_CATEGORY.buffetFoodIncome.area,
          category: FINANCE_AREA_CATEGORY.buffetFoodIncome.category,
          referenceKind: 'comida',
        });
      }
      if (parts.bebida > 0) {
        slices.push({
          amount: parts.bebida,
          description: `Venta de bebida · ${rental.activity_name}`,
          area: FINANCE_AREA_CATEGORY.buffetDrinkIncome.area,
          category: FINANCE_AREA_CATEGORY.buffetDrinkIncome.category,
          referenceKind: 'bebida',
        });
      }
      paymentIds.push(
        await insertAgendaPaymentWithFinance(client, rental, {
          amount: payment.amount,
          paymentMethod: payment.paymentMethod,
          mercadoPagoAccountId: payment.mercadoPagoAccountId,
          paymentType: 'ticket_sales',
          description:
            parts.entradas > 0
              ? ticketDescription
              : parts.comida > 0 && parts.bebida > 0
                ? `Venta de comida y bebida · ${rental.activity_name}`
                : parts.bebida > 0
                  ? `Venta de bebida · ${rental.activity_name}`
                  : `Venta de comida · ${rental.activity_name}`,
          paidDate,
          financeSlices: slices,
        }),
      );
    }
    await client.query(
      `UPDATE agenda_rentals
       SET ticket_sales_closed_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [rentalId],
    );
    await client.query('COMMIT');

    const created = paymentIds.length
      ? await db.query(
          'SELECT * FROM agenda_payments WHERE id = ANY($1::text[])',
          [paymentIds],
        )
      : { rows: [] };
    res.status(201).json({
      ...charge,
      amount: payments.reduce((sum, payment) => sum + payment.amount, 0),
      salesClosed: true,
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

router.post('/tickets/check-in', async (req, res) => {
  try {
    const result = await checkInTicket(String(req.body?.ticket_id || '').trim());
    res.status(result.status).json(result.body);
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
    const result = await updateTicketStatus(
      req.params.id,
      String(req.body?.status || ''),
    );
    res.status(result.status).json(result.body);
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
