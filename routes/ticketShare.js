import express from 'express';
import db from '../database.js';
import { loadCatalog } from '../lib/eventTickets.js';
import {
  checkInTicket,
  listEventTickets,
  sellDoorTicket,
  updateTicketStatus,
} from '../lib/ticketOperations.js';
import {
  authenticateTicketShare,
  clearShareFailures,
  getSharePreview,
  normalizeSharePassword,
  registerShareFailure,
  shareAttemptsBlocked,
  unlockTicketShare,
} from '../lib/ticketShare.js';

const router = express.Router();

router.get('/preview/:token', async (req, res) => {
  try {
    const preview = await getSharePreview(String(req.params.token || ''));
    if (!preview) {
      return res.status(404).json({ error: 'El link no está disponible' });
    }
    res.json(preview);
  } catch (error) {
    console.error('Error loading ticket share preview:', error);
    res.status(500).json({ error: 'Error al abrir el link' });
  }
});

router.post('/session/:token', async (req, res) => {
  const token = String(req.params.token || '');
  try {
    if (shareAttemptsBlocked(token)) {
      return res.status(429).json({
        error: 'Demasiados intentos. Probá de nuevo más tarde.',
      });
    }
    const password = normalizeSharePassword(req.body?.password);
    const result = await unlockTicketShare(token, password);
    if (result.status === 404) {
      return res.status(404).json({ error: 'El link no está disponible' });
    }
    if (result.status === 401) {
      registerShareFailure(token);
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }
    clearShareFailures(token);
    res.json(result.body);
  } catch (error) {
    console.error('Error unlocking ticket share:', error);
    res.status(500).json({ error: 'Error al ingresar' });
  }
});

router.use(authenticateTicketShare);

router.get('/catalog', async (req, res) => {
  try {
    const rental = await db.query('SELECT * FROM agenda_rentals WHERE id = $1', [
      req.ticketShare.rentalId,
    ]);
    if (!rental.rows[0]) {
      return res.status(404).json({ error: 'Evento no encontrado' });
    }
    res.json(await loadCatalog(db, rental.rows[0], { publicView: true }));
  } catch (error) {
    console.error('Error loading shared ticket catalog:', error);
    res.status(500).json({ error: 'Error al obtener las entradas' });
  }
});

router.get('/tickets', async (req, res) => {
  try {
    const status = String(req.query.status || 'all');
    res.json(await listEventTickets(req.ticketShare.rentalId, status));
  } catch (error) {
    console.error('Error listing shared tickets:', error);
    res.status(500).json({ error: 'Error al obtener entradas' });
  }
});

router.post('/tickets', async (req, res) => {
  try {
    const result = await sellDoorTicket(req.ticketShare.rentalId, req.body);
    res.status(result.status).json(result.body);
  } catch (error) {
    console.error('Error selling shared door ticket:', error);
    res.status(500).json({ error: 'Error al registrar la venta' });
  }
});

router.post('/check-in', async (req, res) => {
  try {
    const result = await checkInTicket(String(req.body?.ticket_id || '').trim(), {
      rentalId: req.ticketShare.rentalId,
    });
    res.status(result.status).json(result.body);
  } catch (error) {
    console.error('Error checking in shared ticket:', error);
    res.status(500).json({ error: 'Error al registrar el ingreso' });
  }
});

router.patch('/tickets/:id', async (req, res) => {
  try {
    const result = await updateTicketStatus(
      req.params.id,
      String(req.body?.status || ''),
      { rentalId: req.ticketShare.rentalId },
    );
    res.status(result.status).json(result.body);
  } catch (error) {
    console.error('Error updating shared ticket status:', error);
    res.status(500).json({ error: 'Error al actualizar la entrada' });
  }
});

export default router;
