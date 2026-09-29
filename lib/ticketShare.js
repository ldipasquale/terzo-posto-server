import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import db from '../database.js';

const JWT_SECRET =
  process.env.JWT_SECRET || 'terzo-posto-secret-key-change-in-production';

export const TICKET_SHARE_JWT_SECRET = `${JWT_SECRET}:ticket-share`;

const MIN_PASSWORD_LENGTH = 4;
const MAX_PASSWORD_LENGTH = 72;
const SHARE_TOKEN_BYTES = 24;

const failures = new Map();

export function newShareToken() {
  return crypto.randomBytes(SHARE_TOKEN_BYTES).toString('base64url');
}

export function normalizeSharePassword(value) {
  return String(value || '').trim();
}

export function sharePasswordError(password) {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return 'La contraseña tiene que tener al menos 4 caracteres';
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return 'La contraseña es demasiado larga';
  }
  return null;
}

export async function readTicketShare(rentalId) {
  const result = await db.query(
    `SELECT id, ticket_share_token
     FROM agenda_rentals
     WHERE id = $1`,
    [rentalId],
  );
  const rental = result.rows[0];
  if (!rental) return null;
  const token = rental.ticket_share_token || null;
  return { enabled: Boolean(token), token };
}

export async function saveTicketShare(rentalId, password) {
  const existing = await db.query(
    `SELECT id, ticket_share_token
     FROM agenda_rentals
     WHERE id = $1`,
    [rentalId],
  );
  if (!existing.rows[0]) return null;
  const token = existing.rows[0].ticket_share_token || newShareToken();
  const passwordHash = await bcrypt.hash(password, 10);
  const updated = await db.query(
    `UPDATE agenda_rentals
     SET ticket_share_token = $2,
         ticket_share_password_hash = $3,
         ticket_share_version = COALESCE(ticket_share_version, 0) + 1,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING ticket_share_token`,
    [rentalId, token, passwordHash],
  );
  return {
    enabled: true,
    token: updated.rows[0].ticket_share_token,
  };
}

export async function getSharePreview(token) {
  const result = await db.query(
    `SELECT activity_name
     FROM agenda_rentals
     WHERE ticket_share_token = $1
       AND ticket_share_password_hash IS NOT NULL`,
    [token],
  );
  const rental = result.rows[0];
  if (!rental) return null;
  return { event_name: rental.activity_name };
}

function failureEntry(token) {
  const now = Date.now();
  const current = failures.get(token);
  if (!current || current.resetAt < now) {
    const fresh = { count: 0, resetAt: now + 15 * 60 * 1000 };
    failures.set(token, fresh);
    return fresh;
  }
  return current;
}

export function shareAttemptsBlocked(token) {
  return failureEntry(token).count >= 8;
}

export function registerShareFailure(token) {
  failureEntry(token).count += 1;
}

export function clearShareFailures(token) {
  failures.delete(token);
}

export async function unlockTicketShare(token, password) {
  const result = await db.query(
    `SELECT id, activity_name, ticket_share_token, ticket_share_password_hash,
            ticket_share_version
     FROM agenda_rentals
     WHERE ticket_share_token = $1`,
    [token],
  );
  const rental = result.rows[0];
  if (!rental?.ticket_share_password_hash) return { status: 404 };
  const matches = await bcrypt.compare(
    password,
    rental.ticket_share_password_hash,
  );
  if (!matches) return { status: 401 };
  const accessToken = jwt.sign(
    {
      scope: 'ticket-share',
      rentalId: rental.id,
      shareToken: rental.ticket_share_token,
      version: Number(rental.ticket_share_version) || 0,
    },
    TICKET_SHARE_JWT_SECRET,
    { expiresIn: '12h' },
  );
  return {
    status: 200,
    body: {
      access_token: accessToken,
      event_name: rental.activity_name,
      rental_id: rental.id,
    },
  };
}

export function authenticateTicketShare(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) {
    return res.status(401).json({ error: 'Tenés que ingresar la contraseña' });
  }

  jwt.verify(token, TICKET_SHARE_JWT_SECRET, async (err, payload) => {
    if (err || payload?.scope !== 'ticket-share' || !payload.rentalId) {
      return res
        .status(401)
        .json({ error: 'La sesión expiró. Volvé a ingresar la contraseña.' });
    }
    try {
      const result = await db.query(
        `SELECT id, activity_name, ticket_share_token, ticket_share_version
         FROM agenda_rentals
         WHERE id = $1`,
        [payload.rentalId],
      );
      const rental = result.rows[0];
      if (
        !rental ||
        rental.ticket_share_token !== payload.shareToken ||
        Number(rental.ticket_share_version) !== Number(payload.version)
      ) {
        return res.status(401).json({
          error: 'La sesión expiró. Volvé a ingresar la contraseña.',
        });
      }
      req.ticketShare = {
        rentalId: rental.id,
        eventName: rental.activity_name,
      };
      next();
    } catch (error) {
      console.error('Error validating ticket share:', error);
      res.status(500).json({ error: 'Error al validar el acceso' });
    }
  });
}
