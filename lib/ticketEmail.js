import fs from 'fs';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';
import QRCode from 'qrcode';
import { ymd } from './eventTickets.js';
import { DEFAULT_VENUE_LOCATION } from './venueLocation.js';

const NAVY = '#00234A';
const ORANGE = '#FD7333';
const CREAM = '#F1ECD9';

const WEEKDAYS = [
  'domingo',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
];
const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

const EMAIL_LOGO_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../assets/email-logo.png',
);

export function isValidEmail(value) {
  const email = String(value || '').trim();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function firstName(fullName) {
  const name = String(fullName || '').trim();
  if (!name || name === 'Puerta' || name === 'Presencial') return '';
  return name.split(/\s+/)[0] || '';
}

function capitalizeFirst(value) {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatClock(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  const twelveHour = trimmed.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
  if (twelveHour) {
    return `${Number(twelveHour[1])}:${twelveHour[2]}${twelveHour[3].toLowerCase()}`;
  }
  const twentyFour = trimmed.match(/^(\d{1,2}):(\d{2})(?::\d{2})?/);
  if (!twentyFour) return null;
  const hour24 = Number(twentyFour[1]);
  const minutes = twentyFour[2];
  const suffix = hour24 >= 12 ? 'pm' : 'am';
  const hour12 = hour24 % 12 || 12;
  return `${hour12}:${minutes}${suffix}`;
}

export function formatEventWhen(date, startTime) {
  const day = ymd(date);
  if (!day) return 'Fecha a confirmar';
  const [year, month, dayNum] = day.split('-').map(Number);
  if (!year || !month || !dayNum) return 'Fecha a confirmar';
  const utc = new Date(Date.UTC(year, month - 1, dayNum, 12, 0, 0));
  const dateLabel = `${capitalizeFirst(WEEKDAYS[utc.getUTCDay()])} ${dayNum} de ${MONTHS[month - 1]}`;
  const clock = formatClock(startTime);
  return clock ? `${dateLabel} · ${clock}` : dateLabel;
}

function venueAddressLine(venue) {
  const place = venue && typeof venue === 'object' ? venue : DEFAULT_VENUE_LOCATION;
  return [place.address, place.city].filter(Boolean).join(', ');
}

function mapsDirectionsUrl(venue) {
  const place = venue && typeof venue === 'object' ? venue : DEFAULT_VENUE_LOCATION;
  const labeled = [place.name, place.address, place.city]
    .filter(Boolean)
    .join(', ');
  const query =
    labeled ||
    (place.lat != null && place.lng != null
      ? `${place.lat},${place.lng}`
      : '');
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(query)}`;
}

function formatArs(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return 'Gratis';
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS',
    maximumFractionDigits: 0,
  }).format(n);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildHtml({
  buyerName,
  eventName,
  when,
  typeName,
  quantity,
  total,
  address,
  directionsUrl,
}) {
  const greeting = firstName(buyerName);
  return `<!DOCTYPE html>
<html lang="es">
  <body style="margin:0;padding:0;background:${NAVY};font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${NAVY};padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:${NAVY};">
            <tr>
              <td style="padding:0 8px 20px;text-align:center;">
                <img src="cid:ticket-logo" width="144" alt="Terzo Posto" style="display:block;margin:0 auto 16px;width:144px;height:auto;border:0;" />
                <h1 style="margin:0;color:${ORANGE};font-size:22px;line-height:1.25;text-transform:uppercase;letter-spacing:0.04em;">${escapeHtml(eventName)}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:0 8px 16px;color:${CREAM};font-size:16px;line-height:1.5;text-align:center;">
                ${greeting ? `${escapeHtml(greeting)}, esta es tu entrada` : 'Esta es tu entrada'}
              </td>
            </tr>
            <tr>
              <td style="padding:0 8px 6px;color:${CREAM};font-size:14px;line-height:1.5;text-align:center;">
                ${escapeHtml(String(quantity))} × ${escapeHtml(typeName)} · ${formatArs(total)}
              </td>
            </tr>
            <tr>
              <td style="padding:0 8px 6px;color:${CREAM};font-size:14px;line-height:1.5;text-align:center;">
                ${escapeHtml(when)}
              </td>
            </tr>
            <tr>
              <td style="padding:0 8px 20px;font-size:14px;line-height:1.5;text-align:center;">
                <a href="${escapeHtml(directionsUrl)}" style="color:${ORANGE};text-decoration:none;">
                  <span style="font-size:15px;line-height:1;">📍</span>
                  ${escapeHtml(address)}
                </a>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:0 8px 20px;text-align:center;">
                <table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:0 auto;background:${ORANGE};border-radius:16px;">
                  <tr>
                    <td style="padding:20px;">
                      <img src="cid:ticket-qr" width="240" height="240" alt="QR de tu entrada" style="display:block;border-radius:12px;background:${CREAM};" />
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:0 8px 8px;color:${CREAM};font-size:14px;letter-spacing:0.04em;text-align:center;">
                Presentá este QR para entrar
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function postResendEmail(apiKey, payload) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.resend.com',
        path: '/emails',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed = {};
          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch {
            parsed = { message: raw };
          }
          if (res.statusCode >= 400) {
            resolve({ error: parsed });
            return;
          }
          resolve({ data: parsed, error: null });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

export async function sendTicketPurchaseEmail({
  to,
  buyerName,
  eventName,
  eventDate,
  eventStartTime,
  typeName,
  quantity,
  unitPrice,
  discountAmount = 0,
  menuTotal = 0,
  ticketId,
  venue,
}) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn(
      'ticket email: RESEND_API_KEY no configurada, no se envió el mail',
    );
    return false;
  }
  if (!isValidEmail(to)) return false;

  const from =
    process.env.RESEND_FROM?.trim() || 'Terzo Posto <entradas@terzoposto.club>';
  const png = await QRCode.toBuffer(ticketId, {
    type: 'png',
    width: 480,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark: NAVY, light: CREAM },
  });
  const attachments = [
    {
      filename: `entrada-${ticketId}.png`,
      content: png.toString('base64'),
      content_id: 'ticket-qr',
    },
  ];
  if (fs.existsSync(EMAIL_LOGO_PATH)) {
    attachments.push({
      filename: 'logo.png',
      content: fs.readFileSync(EMAIL_LOGO_PATH).toString('base64'),
      content_id: 'ticket-logo',
    });
  }
  const place = venue || DEFAULT_VENUE_LOCATION;
  const { error } = await postResendEmail(apiKey, {
    from,
    to: [to.trim()],
    subject: `Entradas · ${eventName} en El Terzo Posto`,
    html: buildHtml({
      buyerName,
      eventName,
      when: formatEventWhen(eventDate, eventStartTime),
      typeName,
      quantity,
      total: Math.max(
        0,
        Number(quantity) * Number(unitPrice) -
          (Number(discountAmount) || 0) +
          (Number(menuTotal) || 0),
      ),
      address: venueAddressLine(place),
      directionsUrl: mapsDirectionsUrl(place),
    }),
    attachments,
  });
  if (error) {
    console.error('ticket email:', error);
    return false;
  }
  return true;
}

export async function sendTicketEmailForRow(row, venue) {
  if (!row) return false;
  return sendTicketPurchaseEmail({
    to: row.buyer_email,
    buyerName: row.buyer_name,
    eventName: row.activity_name,
    eventDate: row.date,
    eventStartTime: row.start_time,
    typeName: row.ticket_type_name,
    quantity: row.quantity,
    unitPrice: Number(row.unit_price),
    discountAmount: Number(row.discount_amount) || 0,
    menuTotal: Number(row.menu_total) || 0,
    ticketId: row.id,
    venue,
  });
}
