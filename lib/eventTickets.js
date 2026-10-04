import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getVenueLocation } from './venueLocation.js';
import { resolveTicketTransfer } from './ticketTransfer.js';
import {
  loadEventTicketMenuItems,
  loadMenuSelectionsByTicketIds,
} from './ticketMenu.js';

const RECEIPT_NAME_RE = /^[a-f0-9-]{36}\.(jpe?g|png|webp)$/i;

function dataSubdir(envKey, folder) {
  if (process.env[envKey]) return process.env[envKey];
  if (fs.existsSync('/data')) return `/data/${folder}`;
  return path.resolve(process.cwd(), folder);
}

export function receiptsDir() {
  return dataSubdir('TICKET_RECEIPTS_DIR', 'ticket-receipts');
}

export function flyersDir() {
  return dataSubdir('EVENT_FLYERS_DIR', 'event-flyers');
}

export function userPhotosDir() {
  return dataSubdir('USER_PHOTOS_DIR', 'user-photos');
}

export function fixedExpenseReceiptsDir() {
  return dataSubdir('FIXED_EXPENSE_RECEIPTS_DIR', 'fixed-expense-receipts');
}

export function ensureReceiptsDir() {
  const dir = receiptsDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function ensureFlyersDir() {
  const dir = flyersDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function ensureUserPhotosDir() {
  const dir = userPhotosDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function ensureFixedExpenseReceiptsDir() {
  const dir = fixedExpenseReceiptsDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function isReceiptFileName(name) {
  return RECEIPT_NAME_RE.test(String(name || ''));
}

export function receiptExtension(mimetype) {
  if (mimetype === 'image/png') return 'png';
  if (mimetype === 'image/webp') return 'webp';
  return 'jpg';
}

export function todayYmdBuenosAires() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export function isPublicEventPast(date) {
  const day = ymd(date);
  if (!day) return false;
  return day < todayYmdBuenosAires();
}

export function ymd(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const s = String(value);
  return s.includes('T') ? s.slice(0, 10) : s.slice(0, 10);
}

export function slugify(text) {
  const base = String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || 'evento';
}

export async function uniqueSlug(client, name, date, excludeId = null) {
  const datePart = ymd(date);
  const base = datePart ? `${slugify(name)}-${datePart}` : slugify(name);
  let slug = base;
  let n = 2;
  while (true) {
    const result = excludeId
      ? await client.query(
          'SELECT 1 FROM agenda_rentals WHERE slug = $1 AND id <> $2',
          [slug, excludeId],
        )
      : await client.query('SELECT 1 FROM agenda_rentals WHERE slug = $1', [
          slug,
        ]);
    if (result.rows.length === 0) return slug;
    slug = `${base}-${n}`;
    n += 1;
  }
}

export async function ensureRentalSlug(client, rental) {
  if (!rental) return null;
  if (rental.slug) return rental.slug;
  if (Number(rental.has_tickets) !== 1) return null;
  const slug = await uniqueSlug(
    client,
    rental.activity_name,
    rental.date,
    rental.id,
  );
  await client.query(
    'UPDATE agenda_rentals SET slug = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
    [slug, rental.id],
  );
  return slug;
}

export async function soldByType(client, rentalId) {
  const result = await client.query(
    `SELECT ticket_type_id, COALESCE(SUM(quantity), 0)::int AS sold
     FROM event_tickets
     WHERE rental_id = $1 AND status <> 'rejected'
     GROUP BY ticket_type_id`,
    [rentalId],
  );
  return new Map(result.rows.map((row) => [row.ticket_type_id, Number(row.sold)]));
}

export function mapTicketType(row, sold = 0) {
  return {
    id: row.id,
    name: row.name,
    price: Number(row.price),
    available_quantity: Number(row.available_quantity),
    sold_quantity: Number(sold) || 0,
  };
}

export function mapTicket(row, menuItems = []) {
  return {
    id: row.id,
    event_id: row.rental_id,
    ticket_type_id: row.ticket_type_id,
    quantity: Number(row.quantity),
    unit_price: Number(row.unit_price),
    buyer_name: row.buyer_name,
    buyer_phone: row.buyer_phone,
    buyer_email: row.buyer_email || '',
    receipt_url: row.receipt_file
      ? `/api/public/receipts/${row.receipt_file}`
      : '',
    status: row.status,
    purchase_date: new Date(row.purchase_date).toISOString(),
    checked_in_at: row.checked_in_at
      ? new Date(row.checked_in_at).toISOString()
      : null,
    checked_in_count: Number(row.checked_in_count) || 0,
    payment_method: row.payment_method || null,
    mercado_pago_account_id: row.mercado_pago_account_id || null,
    discount_amount: Number(row.discount_amount) || 0,
    source: row.source === 'door' ? 'door' : 'online',
    menu_items: menuItems,
  };
}

export async function mapTicketsWithMenu(client, rows) {
  const selections = await loadMenuSelectionsByTicketIds(
    client,
    rows.map((row) => row.id),
  );
  return rows.map((row) => mapTicket(row, selections.get(row.id) || []));
}

export async function loadCatalog(client, rental, { publicView = false } = {}) {
  if (!rental) return null;
  const types = await client.query(
    `SELECT * FROM event_ticket_types
     WHERE rental_id = $1
     ORDER BY position ASC, created_at ASC`,
    [rental.id],
  );
  const sold = await soldByType(client, rental.id);
  const catalog = {
    event_id: rental.id,
    slug: rental.slug || null,
    event_name: rental.activity_name,
    event_date: ymd(rental.date),
    event_start_time: rental.start_time || null,
    event_end_time: rental.end_time || null,
    has_tickets: Number(rental.has_tickets) === 1,
    sales_closed: Boolean(rental.ticket_sales_closed_at),
    flyer_url: rental.flyer_file
      ? `/api/public/flyers/${rental.flyer_file}`
      : null,
    description: rental.event_description
      ? String(rental.event_description).trim() || null
      : null,
    ticket_types: types.rows.map((row) =>
      mapTicketType(row, sold.get(row.id) || 0),
    ),
    menu_items: await loadEventTicketMenuItems(client, rental.id, {
      publicView,
    }),
    venue: await getVenueLocation(client),
    transfer: await resolveTicketTransfer(client, rental),
  };
  if (publicView) {
    const promoCount = await client.query(
      'SELECT 1 FROM event_ticket_promos WHERE rental_id = $1 LIMIT 1',
      [rental.id],
    );
    catalog.has_promos = promoCount.rows.length > 0;
  } else {
    catalog.venue_percentage =
      rental.revenue_share_percent != null
        ? Number(rental.revenue_share_percent)
        : 30;
    catalog.promos = await loadEventTicketPromos(client, rental.id);
  }
  return catalog;
}

const PROMO_CODE_RE = /^[A-Z0-9][A-Z0-9-]{1,31}$/;

export function normalizePromoCode(value) {
  return String(value || '').trim().toUpperCase();
}

export function ticketFaceAmount(row) {
  return Math.max(
    0,
    Number(row?.quantity) * Number(row?.unit_price) -
      (Number(row?.discount_amount) || 0),
  );
}

/** Cobro del club: el mayor entre el porcentaje de la venta y el seguro de sala. */
export function venueTicketCharge({
  sold,
  percent,
  roomInsurance,
  alreadyPaid = 0,
}) {
  const totalSold = Math.max(0, Math.round(Number(sold) || 0));
  const sharePercent = Math.min(
    100,
    Math.max(0, Math.round(Number(percent) || 0)),
  );
  const insurance = Math.max(0, Math.round(Number(roomInsurance) || 0));
  const share = Math.round((totalSold * sharePercent) / 100);
  const due = Math.max(share, insurance);
  const paid = Math.max(0, Math.round(Number(alreadyPaid) || 0));
  return {
    sold: totalSold,
    percent: sharePercent,
    roomInsurance: insurance,
    share,
    due,
    alreadyPaid: paid,
    pending: Math.max(0, due - paid),
  };
}

export function promoDiscountAmount(subtotal, percent) {
  const base = Math.max(0, Math.round(Number(subtotal) || 0));
  const pct = Math.round(Number(percent) || 0);
  if (base <= 0 || pct <= 0) return 0;
  return Math.min(base, Math.round((base * pct) / 100));
}

export function allocatePromoDiscount(lineTotals, discount) {
  const totals = lineTotals.map((n) => Math.max(0, Math.round(Number(n) || 0)));
  const subtotal = totals.reduce((sum, n) => sum + n, 0);
  const amount = Math.min(subtotal, Math.max(0, Math.round(Number(discount) || 0)));
  if (amount <= 0 || subtotal <= 0) return totals.map(() => 0);
  let left = amount;
  return totals.map((lineTotal, index) => {
    if (left <= 0 || lineTotal <= 0) return 0;
    if (index === totals.length - 1) return Math.min(lineTotal, left);
    const share = Math.min(
      lineTotal,
      left,
      Math.floor((lineTotal / subtotal) * amount),
    );
    left -= share;
    return share;
  });
}

export async function loadEventTicketPromos(client, rentalId) {
  const result = await client.query(
    `SELECT id, code, percent FROM event_ticket_promos
     WHERE rental_id = $1
     ORDER BY position ASC, created_at ASC`,
    [rentalId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    code: row.code,
    percent: Number(row.percent),
  }));
}

export async function findEventTicketPromo(client, rentalId, code) {
  const normalized = normalizePromoCode(code);
  if (!normalized) return null;
  const result = await client.query(
    `SELECT id, code, percent FROM event_ticket_promos
     WHERE rental_id = $1 AND lower(code) = lower($2)
     LIMIT 1`,
    [rentalId, normalized],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { id: row.id, code: row.code, percent: Number(row.percent) };
}

export async function saveEventTicketPromos(client, rentalId, promos) {
  if (!Array.isArray(promos)) {
    const error = new Error('Las promociones no son válidas');
    error.status = 400;
    throw error;
  }
  const seen = new Set();
  const rows = [];
  for (const promo of promos) {
    const code = normalizePromoCode(promo?.code);
    const percent = Math.round(Number(promo?.percent));
    if (!code) {
      const error = new Error('Cada promoción necesita un código');
      error.status = 400;
      throw error;
    }
    if (!PROMO_CODE_RE.test(code)) {
      const error = new Error(
        `El código "${code}" tiene que tener entre 2 y 32 letras o números`,
      );
      error.status = 400;
      throw error;
    }
    if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
      const error = new Error(
        `El descuento de ${code} tiene que ser entre 1% y 100%`,
      );
      error.status = 400;
      throw error;
    }
    if (seen.has(code)) {
      const error = new Error(`El código ${code} está repetido`);
      error.status = 400;
      throw error;
    }
    seen.add(code);
    rows.push({
      id:
        typeof promo?.id === 'string' && promo.id.trim()
          ? promo.id.trim()
          : newId(),
      code,
      percent,
    });
  }
  await client.query('DELETE FROM event_ticket_promos WHERE rental_id = $1', [
    rentalId,
  ]);
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    await client.query(
      `INSERT INTO event_ticket_promos (id, rental_id, code, percent, position)
       VALUES ($1, $2, $3, $4, $5)`,
      [row.id, rentalId, row.code, row.percent, i],
    );
  }
}

export function phoneDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

export function isReasonableArPhone(value) {
  const digits = phoneDigits(value);
  return digits.length >= 8 && digits.length <= 15;
}

const TICKET_EMAIL_SELECT = `SELECT t.*, r.activity_name, r.date, r.start_time,
            tt.name AS ticket_type_name,
            COALESCE((
              SELECT SUM(s.price * s.quantity)
              FROM event_ticket_menu_selections s
              WHERE s.ticket_id = t.id
            ), 0) AS menu_total
     FROM event_tickets t
     JOIN agenda_rentals r ON r.id = t.rental_id
     JOIN event_ticket_types tt ON tt.id = t.ticket_type_id`;

export async function loadTicketEmailContext(client, ticketId) {
  const found = await client.query(
    `${TICKET_EMAIL_SELECT} WHERE t.id = $1`,
    [ticketId],
  );
  return found.rows[0] || null;
}

export async function loadTicketEmailContexts(client, ticketIds) {
  if (!ticketIds.length) return [];
  const found = await client.query(
    `${TICKET_EMAIL_SELECT} WHERE t.id = ANY($1::text[])`,
    [ticketIds],
  );
  const byId = new Map(found.rows.map((row) => [row.id, row]));
  return ticketIds.map((id) => byId.get(id)).filter(Boolean);
}

export function newId() {
  return crypto.randomUUID();
}
