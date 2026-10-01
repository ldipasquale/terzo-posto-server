import https from 'https';
import QRCode from 'qrcode';
import { isValidEmail } from './ticketEmail.js';

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

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDay(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  return match ? `${match[3]}/${match[2]}/${match[1]}` : '';
}

function formatCuit(taxId) {
  const digits = String(taxId || '').replace(/\D/g, '');
  if (digits.length !== 11) return digits;
  return `${digits.slice(0, 2)}-${digits.slice(2, 10)}-${digits.slice(10)}`;
}

function formatMoney(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  return amount.toLocaleString('es-AR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function voucherClass(voucherType) {
  if (voucherType === 11 || voucherType === 12 || voucherType === 13) return 'C';
  if (voucherType === 6 || voucherType === 7 || voucherType === 8) return 'B';
  if (voucherType === 1 || voucherType === 2 || voucherType === 3) return 'A';
  return '';
}

function voucherNumber(salesPoint, number) {
  if (salesPoint == null || number == null) return '';
  return `${String(salesPoint).padStart(5, '0')}-${String(number).padStart(8, '0')}`;
}

function invoiceHtml(invoice, money) {
  const number = voucherNumber(invoice.salesPoint, invoice.voucherNumber);
  const letter = voucherClass(invoice.voucherType);
  const description = invoice.issuedDescription || invoice.reason || '—';
  const receiver = invoice.receiverTaxId
    ? [
        `<p style="margin:0 0 4px;"><strong>CUIT: </strong>${escapeHtml(formatCuit(invoice.receiverTaxId))}</p>`,
        invoice.receiverName
          ? `<p style="margin:0 0 4px;"><strong>Razón social: </strong>${escapeHtml(invoice.receiverName)}</p>`
          : '',
        invoice.receiverVatCondition
          ? `<p style="margin:0;"><strong>Condición de IVA: </strong>${escapeHtml(invoice.receiverVatCondition)}</p>`
          : '',
      ].join('')
    : '<p style="margin:0;"><strong>Receptor: </strong>Consumidor final</p>';

  return `<!DOCTYPE html>
<html lang="es">
<body style="margin:0;padding:24px;background:#f4f4f5;font-family:Georgia,serif;color:#171717;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e5e5e5;border-radius:6px;">
    <tr>
      <td style="padding:24px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="vertical-align:top;">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="width:56px;border:1px solid #d4d4d4;border-radius:6px;text-align:center;padding:8px 0;">
                    <div style="font-size:24px;font-weight:700;line-height:1;">${escapeHtml(letter || '—')}</div>
                    <div style="margin-top:4px;font-size:10px;color:#737373;">Cód. ${escapeHtml(invoice.voucherType ?? '—')}</div>
                  </td>
                  <td style="padding-left:16px;vertical-align:top;">
                    <div style="font-size:18px;font-weight:700;">${escapeHtml(invoice.legalName || invoice.partner || '')}</div>
                    ${invoice.address ? `<div style="margin-top:4px;font-size:14px;color:#525252;">${escapeHtml(invoice.address)}</div>` : ''}
                    ${invoice.issuerCondition ? `<div style="margin-top:2px;font-size:14px;color:#525252;">${escapeHtml(invoice.issuerCondition)}</div>` : ''}
                  </td>
                </tr>
              </table>
            </td>
            <td style="vertical-align:top;text-align:right;font-size:14px;">
              <div style="font-size:24px;font-weight:700;line-height:1;">Factura</div>
              ${number ? `<p style="margin:12px 0 0;"><strong>Nº </strong>${escapeHtml(number)}</p>` : ''}
              <p style="margin:4px 0 0;"><strong>Fecha: </strong>${escapeHtml(formatDay(invoice.issuedDate) || '—')}</p>
              ${invoice.taxId ? `<p style="margin:4px 0 0;"><strong>CUIT: </strong>${escapeHtml(formatCuit(invoice.taxId))}</p>` : ''}
            </td>
          </tr>
        </table>

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;border-top:1px solid #e5e5e5;">
          <tr>
            <td style="padding-top:16px;vertical-align:top;">
              ${invoice.qr ? '<img src="cid:invoice-qr" width="112" height="112" alt="Código QR del comprobante" />' : ''}
            </td>
            <td style="padding-top:16px;vertical-align:top;text-align:right;font-size:14px;">
              <p style="margin:0;"><strong>CAE: </strong>${escapeHtml(invoice.cae || '')}</p>
              <p style="margin:4px 0 0;"><strong>Vencimiento CAE: </strong>${escapeHtml(formatDay(invoice.caeExpiry) || '—')}</p>
            </td>
          </tr>
        </table>

        <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e5e5;font-size:14px;">
          ${receiver}
        </div>

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;font-size:14px;border-collapse:collapse;">
          <tr>
            <th style="padding:8px 0;border-bottom:1px solid #d4d4d4;text-align:left;">Descripción</th>
            <th style="padding:8px 0;border-bottom:1px solid #d4d4d4;text-align:right;">Cant.</th>
            <th style="padding:8px 0;border-bottom:1px solid #d4d4d4;text-align:right;">Precio unit.</th>
            <th style="padding:8px 0;border-bottom:1px solid #d4d4d4;text-align:right;">Subtotal</th>
          </tr>
          <tr>
            <td style="padding:8px 12px 8px 0;border-bottom:1px solid #f5f5f5;">${escapeHtml(description)}</td>
            <td style="padding:8px 0;border-bottom:1px solid #f5f5f5;text-align:right;">1</td>
            <td style="padding:8px 0;border-bottom:1px solid #f5f5f5;text-align:right;">${escapeHtml(money)}</td>
            <td style="padding:8px 0;border-bottom:1px solid #f5f5f5;text-align:right;">${escapeHtml(money)}</td>
          </tr>
        </table>

        <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:16px;margin-left:auto;font-size:14px;">
          <tr>
            <td style="padding:2px 16px 2px 0;">Subtotal</td>
            <td style="padding:2px 0;text-align:right;">$${escapeHtml(money)}</td>
          </tr>
          <tr>
            <td style="padding:2px 16px 2px 0;font-size:16px;font-weight:700;">Total</td>
            <td style="padding:2px 0;text-align:right;font-size:16px;font-weight:700;">$${escapeHtml(money)}</td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export async function sendIssuedInvoiceEmail(invoice, to) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('invoice email: RESEND_API_KEY no configurada, no se envió el mail');
    return false;
  }
  if (!isValidEmail(to)) return false;

  const from =
    process.env.RESEND_FROM?.trim() || 'Terzo Posto <entradas@terzoposto.club>';
  const amount = invoice.issuedAmount ?? invoice.amount;
  const money = formatMoney(amount);
  const number = voucherNumber(invoice.salesPoint, invoice.voucherNumber);
  const subject = number ? `Factura ${number}` : 'Factura';
  const attachments = [];
  if (invoice.qr) {
    const png = await QRCode.toBuffer(invoice.qr, {
      type: 'png',
      width: 336,
      margin: 1,
      errorCorrectionLevel: 'M',
    });
    attachments.push({
      filename: 'factura-qr.png',
      content: png.toString('base64'),
      content_id: 'invoice-qr',
    });
  }

  const text = [
    subject,
    invoice.legalName || invoice.partner || '',
    invoice.issuedDescription || invoice.reason || '',
    `Total: $${money}`,
    invoice.cae ? `CAE: ${invoice.cae}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const { error } = await postResendEmail(apiKey, {
    from,
    to: [String(to).trim()],
    subject,
    html: invoiceHtml(invoice, money),
    text,
    ...(attachments.length ? { attachments } : {}),
  });
  if (error) {
    console.error('invoice email:', error.message || error.name || 'no se pudo enviar');
    return false;
  }
  return true;
}
