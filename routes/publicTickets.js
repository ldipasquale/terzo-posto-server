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
  loadCatalog,
  loadTicketEmailContext,
  mapTicketsWithMenu,
  newId,
  phoneDigits,
  receiptExtension,
  receiptsDir,
  userPhotosDir,
} from '../lib/eventTickets.js';
import {
  isValidEmail,
  sendTicketEmailForRow,
} from '../lib/ticketEmail.js';
import { getVenueLocation } from '../lib/venueLocation.js';
import {
  fulfillTicketMenuOrderIfCajaOpen,
  insertTicketMenuSelections,
  parseTicketMenuSelections,
  resolveTicketMenuSelections,
} from '../lib/ticketMenu.js';

const router = express.Router();

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

router.post('/events/:slug/tickets/lookup', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const phone = String(req.body?.phone || '').trim();
    if (!isValidEmail(email) || !isReasonableArPhone(phone)) {
      return res.status(400).json({
        error: 'Ingresá el mail y el teléfono de la compra',
      });
    }

    const rentalResult = await db.query(
      'SELECT id FROM agenda_rentals WHERE slug = $1 AND has_tickets = 1',
      [req.params.slug],
    );
    const rental = rentalResult.rows[0];
    if (!rental) {
      return res.status(404).json({ error: 'Evento no encontrado' });
    }

    const digits = phoneDigits(phone);
    const found = await db.query(
      `SELECT t.*, tt.name AS ticket_type_name
       FROM event_tickets t
       JOIN event_ticket_types tt ON tt.id = t.ticket_type_id
       WHERE t.rental_id = $1
         AND t.status <> 'rejected'
         AND lower(t.buyer_email) = $2
         AND (
           regexp_replace(t.buyer_phone, '[^0-9]', '', 'g') = $3
           OR (
             length(regexp_replace(t.buyer_phone, '[^0-9]', '', 'g')) >= 8
             AND right(regexp_replace(t.buyer_phone, '[^0-9]', '', 'g'), 10)
               = right($3, 10)
           )
         )
       ORDER BY t.purchase_date DESC`,
      [rental.id, email, digits],
    );

    if (found.rowCount === 0) {
      return res.status(404).json({
        error: 'No encontramos una entrada con esos datos',
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
      const ticketTypeId = String(req.body?.ticket_type_id || '').trim();
      const buyerName = String(req.body?.buyer_name || '').trim();
      const buyerPhone = String(req.body?.buyer_phone || '').trim();
      const buyerEmail = String(req.body?.buyer_email || '').trim().toLowerCase();
      const quantity = Number(req.body?.quantity);
      if (
        !ticketTypeId ||
        !buyerName ||
        !isReasonableArPhone(buyerPhone) ||
        !isValidEmail(buyerEmail)
      ) {
        return res.status(400).json({ error: 'Datos del comprador inválidos' });
      }
      if (!Number.isInteger(quantity) || quantity < 1) {
        return res.status(400).json({ error: 'Cantidad inválida' });
      }

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
      if (isPublicEventPast(rental.date)) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'La venta de entradas para este evento ya cerró',
        });
      }

      const typeResult = await client.query(
        `SELECT * FROM event_ticket_types
         WHERE id = $1 AND rental_id = $2
         FOR UPDATE`,
        [ticketTypeId, rental.id],
      );
      const type = typeResult.rows[0];
      if (!type) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Tipo de entrada no encontrado' });
      }

      const unitPrice = Number(type.price);
      const parsedMenu = parseTicketMenuSelections(req.body?.menu_items);
      if (parsedMenu.error) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: parsedMenu.error });
      }
      const resolvedMenu = await resolveTicketMenuSelections(
        client,
        rental.id,
        parsedMenu.items,
      );
      if (resolvedMenu.error) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: resolvedMenu.error });
      }
      const extrasTotal = resolvedMenu.total || 0;
      const grandTotal = unitPrice * quantity + extrasTotal;
      const isFree = grandTotal <= 0;
      if (!isFree && !req.file) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Subí el comprobante de transferencia' });
      }

      const soldResult = await client.query(
        `SELECT COALESCE(SUM(quantity), 0)::int AS sold
         FROM event_tickets
         WHERE ticket_type_id = $1 AND status <> 'rejected'`,
        [type.id],
      );
      const sold = Number(soldResult.rows[0].sold);
      const remaining = Math.max(0, Number(type.available_quantity) - sold);
      if (quantity > remaining) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'No hay cupo suficiente para esa cantidad' });
      }

      const catalog = await loadCatalog(client, rental, { publicView: true });
      const available = catalog.ticket_types.filter(
        (t) => t.available_quantity - t.sold_quantity > 0,
      );
      if (available.length > 1) {
        const minPrice = Math.min(...available.map((t) => t.price));
        if (Number(type.price) > minPrice) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: 'Por ahora solo se venden las entradas más baratas',
          });
        }
      }

      let receiptFile = null;
      if (!isFree && req.file) {
        const dir = ensureReceiptsDir();
        receiptFile = `${newId()}.${receiptExtension(req.file.mimetype)}`;
        fs.writeFileSync(path.join(dir, receiptFile), req.file.buffer);
      }

      const ticketId = newId();
      await client.query(
        `INSERT INTO event_tickets (
          id, rental_id, ticket_type_id, quantity, unit_price,
          buyer_name, buyer_phone, buyer_email, receipt_file, status, purchase_date
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, CURRENT_TIMESTAMP)`,
        [
          ticketId,
          rental.id,
          type.id,
          quantity,
          unitPrice,
          buyerName,
          buyerPhone,
          buyerEmail,
          receiptFile,
          isFree ? 'approved' : 'pending',
        ],
      );
      await insertTicketMenuSelections(
        client,
        ticketId,
        resolvedMenu.selections || [],
      );
      if (isFree) {
        await fulfillTicketMenuOrderIfCajaOpen(client, ticketId);
      }
      await client.query('COMMIT');

      const created = await db.query('SELECT * FROM event_tickets WHERE id = $1', [
        ticketId,
      ]);
      const [ticket] = await mapTicketsWithMenu(db, created.rows);
      try {
        const emailRow = await loadTicketEmailContext(db, ticketId);
        await sendTicketEmailForRow(emailRow, await getVenueLocation(db));
      } catch (emailError) {
        console.error('ticket email:', emailError);
      }
      res.status(201).json(ticket);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('public ticket:', error);
      res.status(500).json({ error: 'Error al registrar la compra' });
    } finally {
      client.release();
    }
  });
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
