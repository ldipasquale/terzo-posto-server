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
  if (!publicView) {
    catalog.venue_percentage =
      rental.revenue_share_percent != null
        ? Number(rental.revenue_share_percent)
        : 30;
  }
  return catalog;
}

export function phoneDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

export function isReasonableArPhone(value) {
  const digits = phoneDigits(value);
  return digits.length >= 8 && digits.length <= 15;
}

export async function loadTicketEmailContext(client, ticketId) {
  const found = await client.query(
    `SELECT t.*, r.activity_name, r.date, r.start_time,
            tt.name AS ticket_type_name,
            COALESCE((
              SELECT SUM(s.price * s.quantity)
              FROM event_ticket_menu_selections s
              WHERE s.ticket_id = t.id
            ), 0) AS menu_total
     FROM event_tickets t
     JOIN agenda_rentals r ON r.id = t.rental_id
     JOIN event_ticket_types tt ON tt.id = t.ticket_type_id
     WHERE t.id = $1`,
    [ticketId],
  );
  return found.rows[0] || null;
}

export function newId() {
  return crypto.randomUUID();
}
