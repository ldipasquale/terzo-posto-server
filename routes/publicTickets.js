import fs from 'fs';
import path from 'path';
import express from 'express';
import multer from 'multer';
import db from '../database.js';
import {
  ensureReceiptsDir,
  flyersDir,
  isReceiptFileName,
  isPublicEventPast,
  isReasonableArPhone,
  isRegistrationMode,
  allocatePromoDiscount,
  findEventTicketPromo,
  loadCatalog,
  loadTicketEmailContexts,
  mapTicketsWithMenu,
  newId,
  promoDiscountAmount,
  phoneDigits,
  phoneMatchSql,
  receiptExtension,
  receiptsDir,
  todayYmdBuenosAires,
  userPhotosDir,
  ymd,
} from '../lib/eventTickets.js';
import {
  isValidEmail,
  sendTicketEmailForRows,
} from '../lib/ticketEmail.js';
import { getVenueLocation } from '../lib/venueLocation.js';
import {
  fulfillTicketMenuOrderIfCajaOpen,
  insertTicketMenuSelections,
  parseTicketMenuSelections,
  resolveTicketMenuSelections,
  revertPendingTicketMenuOrder,
} from '../lib/ticketMenu.js';

const router = express.Router();

function parsePurchaseLines(body) {
  if (body?.lines != null && String(body.lines).trim() !== '') {
    let parsed;
    try {
      parsed = JSON.parse(String(body.lines));
    } catch {
      return { error: 'Selección de entradas inválida' };
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return { error: 'Elegí al menos una entrada' };
    }
    const lines = [];
    const seen = new Set();
    for (const item of parsed) {
      const ticketTypeId = String(item?.ticket_type_id || '').trim();
      const quantity = Number(item?.quantity);
      if (!ticketTypeId || seen.has(ticketTypeId)) {
        return { error: 'Selección de entradas inválida' };
      }
      if (!Number.isInteger(quantity) || quantity < 1) {
        return { error: 'Cantidad inválida' };
      }
      seen.add(ticketTypeId);
      lines.push({ ticketTypeId, quantity });
    }
    return { lines };
  }

  const ticketTypeId = String(body?.ticket_type_id || '').trim();
  const quantity = Number(body?.quantity);
  if (!ticketTypeId) return { error: 'Elegí al menos una entrada' };
  if (!Number.isInteger(quantity) || quantity < 1) {
    return { error: 'Cantidad inválida' };
  }
  return { lines: [{ ticketTypeId, quantity }] };
}

function mapRecoveredTicket(row) {
  return {
    id: row.id,
    event_id: row.rental_id,
    ticket_type_id: row.ticket_type_id,
    ticket_type_name: row.ticket_type_name,
    quantity: Number(row.quantity),
    unit_price: Number(row.unit_price),
    buyer_name: row.buyer_name,
    buyer_phone: "",
    receipt_url: "",
    status: row.status,
    purchase_date: new Date(row.purchase_date).toISOString(),
    checked_in_at: row.checked_in_at
      ? new Date(row.checked_in_at).toISOString()
      : null,
    checked_in_count: Number(row.checked_in_count) || 0,
  };
}

const receiptUpload = multer({
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

function mapPublicListing(row) {
  return {
    slug: row.slug,
    event_name: row.activity_name,
    event_date: ymd(row.date),
    event_start_time: row.start_time || null,
    event_type: row.event_type || null,
    description: row.event_description
      ? String(row.event_description).trim() || null
      : null,
    flyer_url: row.flyer_file ? `/api/public/flyers/${row.flyer_file}` : null,
    from_price: row.from_price == null ? null : Number(row.from_price),
    sold_out: row.sold_out === true,
    listing_mode: row.ticket_listing_mode === 'inscripcion' ? 'inscripcion' : 'entradas',
    bg_color: row.ticket_bg_color || null,
    accent_color: row.ticket_accent_color || null,
  };
}

router.get('/events', async (req, res) => {
  try {
    const today = todayYmdBuenosAires();
    const [venue, result] = await Promise.all([
      getVenueLocation(db),
      db.query(
        `SELECT
           r.id,
           r.slug,
           r.activity_name,
           r.date,
           r.start_time,
           r.event_type,
           r.event_description,
           r.flyer_file,
           r.ticket_listing_mode,
           r.ticket_bg_color,
           r.ticket_accent_color,
           MIN(tt.price) FILTER (
             WHERE tt.available_quantity > COALESCE(sold.sold, 0)
           ) AS from_price,
           COALESCE(
             BOOL_AND(tt.available_quantity <= COALESCE(sold.sold, 0)),
             FALSE
           ) AS sold_out
         FROM agenda_rentals r
         JOIN event_ticket_types tt ON tt.rental_id = r.id
         LEFT JOIN (
           SELECT ticket_type_id, COALESCE(SUM(quantity), 0)::int AS sold
           FROM event_tickets
           WHERE status <> 'rejected'
           GROUP BY ticket_type_id
         ) sold ON sold.ticket_type_id = tt.id
         WHERE r.has_tickets = 1
           AND NULLIF(BTRIM(r.slug), '') IS NOT NULL
           AND r.ticket_sales_closed_at IS NULL
           AND (r.date IS NULL OR r.date >= $1::date)
         GROUP BY r.id
         ORDER BY r.date ASC NULLS LAST, r.start_time ASC NULLS LAST, r.activity_name ASC`,
        [today],
      ),
    ]);
    res.json({
      venue,
      events: result.rows.map(mapPublicListing),
    });
  } catch (error) {
    console.error('public events:', error);
    res.status(500).json({ error: 'Error al obtener la agenda' });
  }
});

router.get('/events/:slug', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM agenda_rentals WHERE slug = $1',
      [req.params.slug],
    );
    const rental = result.rows[0];
    if (!rental || Number(rental.has_tickets) !== 1) {
      return res.status(404).json({ error: 'Evento no encontrado' });
    }
    const catalog = await loadCatalog(db, rental, { publicView: true });
    if (!catalog.ticket_types.length) {
      return res.status(404).json({ error: 'Evento no encontrado' });
    }
    res.json(catalog);
  } catch (error) {
    console.error('public event:', error);
    res.status(500).json({ error: 'Error al obtener el evento' });
  }
});

router.post('/events/:slug/promo', async (req, res) => {
  try {
    const rentalResult = await db.query(
      'SELECT id FROM agenda_rentals WHERE slug = $1 AND has_tickets = 1',
      [req.params.slug],
    );
    const rental = rentalResult.rows[0];
    if (!rental) {
      return res.status(404).json({ error: 'Evento no encontrado' });
    }
    const promo = await findEventTicketPromo(db, rental.id, req.body?.code);
    if (!promo) {
      return res.status(404).json({ error: 'Ese código no es válido' });
    }
    res.json({ code: promo.code, percent: promo.percent });
  } catch (error) {
    console.error('public promo:', error);
    res.status(500).json({ error: 'No se pudo validar el código' });
  }
});

router.post('/events/:slug/tickets/lookup', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const phone = String(req.body?.phone || '').trim();
    const rentalResult = await db.query(
      'SELECT id, ticket_listing_mode FROM agenda_rentals WHERE slug = $1 AND has_tickets = 1',
      [req.params.slug],
    );
    const rental = rentalResult.rows[0];
    if (!rental) {
      return res.status(404).json({ error: 'Evento no encontrado' });
    }
    const registration = isRegistrationMode(rental);
    if (registration) {
      if (!isReasonableArPhone(phone)) {
        return res.status(400).json({ error: 'Ingresá tu teléfono' });
      }
    } else if (!isValidEmail(email) || !isReasonableArPhone(phone)) {
      return res.status(400).json({
        error: 'Ingresá el mail y el teléfono de la compra',
      });
    }

    const digits = phoneDigits(phone);
    const found = await db.query(
      registration
        ? `SELECT t.*, tt.name AS ticket_type_name
           FROM event_tickets t
           JOIN event_ticket_types tt ON tt.id = t.ticket_type_id
           WHERE t.rental_id = $1
             AND t.status <> 'rejected'
             AND ${phoneMatchSql('t.buyer_phone', '$2')}
           ORDER BY t.purchase_date DESC`
        : `SELECT t.*, tt.name AS ticket_type_name
           FROM event_tickets t
           JOIN event_ticket_types tt ON tt.id = t.ticket_type_id
           WHERE t.rental_id = $1
             AND t.status <> 'rejected'
             AND lower(t.buyer_email) = $2
             AND ${phoneMatchSql('t.buyer_phone', '$3')}
           ORDER BY t.purchase_date DESC`,
      registration ? [rental.id, digits] : [rental.id, email, digits],
    );

    if (found.rowCount === 0) {
      return res.status(404).json({
        error: registration
          ? 'No encontramos una anotación con ese teléfono'
          : 'No encontramos una entrada con esos datos',
      });
    }

    res.json({ tickets: found.rows.map(mapRecoveredTicket) });
  } catch (error) {
    console.error('public ticket lookup:', error);
    res.status(500).json({ error: 'Error al buscar la entrada' });
  }
});

router.post('/events/:slug/tickets', (req, res) => {
  receiptUpload.single('receipt')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'Comprobante inválido' });
    }
    const client = await db.connect();
    try {
      const buyerName = String(req.body?.buyer_name || '').trim();
      const buyerPhone = String(req.body?.buyer_phone || '').trim();
      const buyerEmail = String(req.body?.buyer_email || '').trim().toLowerCase();
      const parsedLines = parsePurchaseLines(req.body);
      if (parsedLines.error) {
        return res.status(400).json({ error: parsedLines.error });
      }
      if (!buyerName || !isReasonableArPhone(buyerPhone)) {
        return res.status(400).json({ error: 'Datos del comprador inválidos' });
      }
      if (buyerEmail && !isValidEmail(buyerEmail)) {
        return res.status(400).json({ error: 'Revisá el email' });
      }
      const lines = parsedLines.lines;

      await client.query('BEGIN');
      const rentalResult = await client.query(
        'SELECT * FROM agenda_rentals WHERE slug = $1 FOR UPDATE',
        [req.params.slug],
      );
      const rental = rentalResult.rows[0];
      if (!rental || Number(rental.has_tickets) !== 1) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Evento no encontrado' });
      }
      const registration = isRegistrationMode(rental);
      if (!registration && !isValidEmail(buyerEmail)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Datos del comprador inválidos' });
      }
      if (registration && (lines.length !== 1 || lines[0].quantity !== 1)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Anotate de a una persona' });
      }
      if (rental.ticket_sales_closed_at || isPublicEventPast(rental.date)) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: registration
            ? 'La inscripción para este evento ya cerró'
            : 'La venta de entradas para este evento ya cerró',
        });
      }
      if (registration) {
        const duplicate = await client.query(
          `SELECT 1 FROM event_tickets t
           WHERE t.rental_id = $1
             AND t.status <> 'rejected'
             AND ${phoneMatchSql('t.buyer_phone', '$2')}
           LIMIT 1`,
          [rental.id, phoneDigits(buyerPhone)],
        );
        if (duplicate.rowCount > 0) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: 'Este teléfono ya está anotado',
          });
        }
      }

      const typeIds = lines.map((line) => line.ticketTypeId).sort();
      const typeResult = await client.query(
        `SELECT * FROM event_ticket_types
         WHERE rental_id = $1 AND id = ANY($2::text[])
         ORDER BY id
         FOR UPDATE`,
        [rental.id, typeIds],
      );
      const typeById = new Map(typeResult.rows.map((row) => [row.id, row]));
      if (typeById.size !== lines.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Tipo de entrada no encontrado' });
      }

      const parsedMenu = parseTicketMenuSelections(req.body?.menu_items);
      if (parsedMenu.error) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: parsedMenu.error });
      }
      if (registration && parsedMenu.items.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Esta anotación no lleva menú' });
      }
      const resolvedMenu = registration
        ? { total: 0, selections: [] }
        : await resolveTicketMenuSelections(
            client,
            rental.id,
            parsedMenu.items,
          );
      if (resolvedMenu.error) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: resolvedMenu.error });
      }
      const soldResult = await client.query(
        `SELECT ticket_type_id, COALESCE(SUM(quantity), 0)::int AS sold
         FROM event_tickets
         WHERE ticket_type_id = ANY($1::text[]) AND status <> 'rejected'
         GROUP BY ticket_type_id`,
        [typeIds],
      );
      const soldById = new Map(
        soldResult.rows.map((row) => [row.ticket_type_id, Number(row.sold)]),
      );
      const pricedLines = [];
      for (const line of lines) {
        const type = typeById.get(line.ticketTypeId);
        const sold = soldById.get(type.id) || 0;
        const remaining = Math.max(0, Number(type.available_quantity) - sold);
        if (line.quantity > remaining) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: registration
              ? 'No quedan lugares'
              : `No hay cupo suficiente para ${type.name}`,
          });
        }
        pricedLines.push({
          type,
          quantity: line.quantity,
          unitPrice: Number(type.price),
        });
      }

      const extrasTotal = resolvedMenu.total || 0;
      const promoCode = String(req.body?.promo_code || '').trim();
      let promo = null;
      if (promoCode) {
        promo = await findEventTicketPromo(client, rental.id, promoCode);
        if (!promo) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Ese código no es válido' });
        }
      }
      const ticketsTotal = pricedLines.reduce(
        (sum, line) => sum + line.unitPrice * line.quantity,
        0,
      );
      const discount = promo
        ? promoDiscountAmount(ticketsTotal, promo.percent)
        : 0;
      const discountShares = allocatePromoDiscount(
        pricedLines.map((line) => line.unitPrice * line.quantity),
        discount,
      );
      const grandTotal = ticketsTotal - discount + extrasTotal;
      const isFree = grandTotal <= 0;
      if (!isFree && !req.file) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Subí el comprobante de transferencia' });
      }

      let receiptFile = null;
      if (!isFree && req.file) {
        const dir = ensureReceiptsDir();
        receiptFile = `${newId()}.${receiptExtension(req.file.mimetype)}`;
        fs.writeFileSync(path.join(dir, receiptFile), req.file.buffer);
      }

      const ticketIds = [];
      const purchaseId = newId();
      for (let index = 0; index < pricedLines.length; index += 1) {
        const line = pricedLines[index];
        const ticketId = newId();
        ticketIds.push(ticketId);
        await client.query(
          `INSERT INTO event_tickets (
            id, rental_id, ticket_type_id, quantity, unit_price, discount_amount,
            buyer_name, buyer_phone, buyer_email, receipt_file, status,
            purchase_id, purchase_date
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, CURRENT_TIMESTAMP)`,
          [
            ticketId,
            rental.id,
            line.type.id,
            line.quantity,
            line.unitPrice,
            discountShares[index] || 0,
            buyerName,
            buyerPhone,
            buyerEmail || null,
            receiptFile,
            isFree ? 'approved' : 'pending',
            purchaseId,
          ],
        );
      }
      await insertTicketMenuSelections(
        client,
        ticketIds[0],
        resolvedMenu.selections || [],
      );
      if (isFree) {
        await fulfillTicketMenuOrderIfCajaOpen(client, ticketIds[0]);
      }
      await client.query('COMMIT');

      const created = await db.query(
        `SELECT t.*, tt.name AS ticket_type_name
         FROM event_tickets t
         JOIN event_ticket_types tt ON tt.id = t.ticket_type_id
         WHERE t.id = ANY($1::text[])`,
        [ticketIds],
      );
      const byId = new Map(created.rows.map((row) => [row.id, row]));
      const ordered = ticketIds.map((id) => byId.get(id)).filter(Boolean);
      const tickets = (await mapTicketsWithMenu(db, ordered)).map((ticket, index) => ({
        ...ticket,
        ticket_type_name: ordered[index]?.ticket_type_name,
      }));
      try {
        const emailRows = await loadTicketEmailContexts(db, ticketIds);
        await sendTicketEmailForRows(emailRows, await getVenueLocation(db));
      } catch (emailError) {
        console.error('ticket email:', emailError);
      }
      res.status(201).json({ tickets });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('public ticket:', error);
      res.status(500).json({ error: 'No se pudo completar la compra' });
    } finally {
      client.release();
    }
  });
});

router.post('/events/:slug/registrations/cancel', async (req, res) => {
  const phone = String(req.body?.phone || '').trim();
  if (!isReasonableArPhone(phone)) {
    return res.status(400).json({ error: 'Ingresá tu teléfono' });
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const rentalResult = await client.query(
      'SELECT * FROM agenda_rentals WHERE slug = $1 FOR UPDATE',
      [req.params.slug],
    );
    const rental = rentalResult.rows[0];
    if (!rental || Number(rental.has_tickets) !== 1 || !isRegistrationMode(rental)) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Evento no encontrado' });
    }
    const found = await client.query(
      `SELECT t.*
       FROM event_tickets t
       WHERE t.rental_id = $1
         AND t.status <> 'rejected'
         AND ${phoneMatchSql('t.buyer_phone', '$2')}
       ORDER BY t.purchase_date DESC
       LIMIT 1
       FOR UPDATE`,
      [rental.id, phoneDigits(phone)],
    );
    const ticket = found.rows[0];
    if (!ticket) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        error: 'No encontramos una anotación con ese teléfono',
      });
    }
    if (ticket.checked_in_at || Number(ticket.checked_in_count) > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Ya figurás como presente',
      });
    }
    const updated = await client.query(
      `UPDATE event_tickets
       SET status = 'rejected'
       WHERE id = $1
       RETURNING *`,
      [ticket.id],
    );
    await revertPendingTicketMenuOrder(client, ticket.id);
    await client.query('COMMIT');
    res.json({
      ok: true,
      buyer_name: updated.rows[0]?.buyer_name || ticket.buyer_name,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('cancel registration:', error);
    res.status(500).json({ error: 'No se pudo liberar el lugar' });
  } finally {
    client.release();
  }
});

router.get('/flyers/:fileId', (req, res) => {
  const fileId = req.params.fileId;
  if (!isReceiptFileName(fileId)) {
    return res.status(404).json({ error: 'Flyer no encontrado' });
  }
  const filePath = path.join(flyersDir(), fileId);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Flyer no encontrado' });
  }
  res.sendFile(filePath);
});

router.get('/user-photos/:fileId', (req, res) => {
  const fileId = req.params.fileId;
  if (!isReceiptFileName(fileId)) {
    return res.status(404).json({ error: 'Foto no encontrada' });
  }
  const filePath = path.join(userPhotosDir(), fileId);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Foto no encontrada' });
  }
  res.sendFile(filePath);
});

router.get('/receipts/:fileId', (req, res) => {
  const fileId = req.params.fileId;
  if (!isReceiptFileName(fileId)) {
    return res.status(404).json({ error: 'Comprobante no encontrado' });
  }
  const filePath = path.join(receiptsDir(), fileId);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Comprobante no encontrado' });
  }
  res.sendFile(filePath);
});

export default router;
