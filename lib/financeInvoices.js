/**
 * Ingresos de Mercado Pago que superan el umbral de facturación AFIP.
 * El bar (comida + bebida + vasos del mismo cierre y socio) se agrupa en un renglón.
 */
import { issuerProfile } from './arcaInvoice.js';
import { sendIssuedInvoiceEmail } from './invoiceEmail.js';
import { isValidEmail } from './ticketEmail.js';

export const AFIP_INVOICE_THRESHOLD = 50000;

const MONTH_NAMES = [
  'Enero',
  'Febrero',
  'Marzo',
  'Abril',
  'Mayo',
  'Junio',
  'Julio',
  'Agosto',
  'Septiembre',
  'Octubre',
  'Noviembre',
  'Diciembre',
];

export function formatMonthLabel(month) {
  if (!month || typeof month !== 'string') return '';
  const [y, m] = month.split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) {
    return String(month);
  }
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

export function formatDayLabel(value) {
  if (value == null) return '';
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const dd = String(value.getUTCDate()).padStart(2, '0');
    const mm = String(value.getUTCMonth() + 1).padStart(2, '0');
    const yyyy = value.getUTCFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }
  const s = String(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!match) return '';
  return `${match[3]}/${match[2]}/${match[1]}`;
}

function toIso(value) {
  if (!value) return new Date().toISOString();
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

/** DATE de PG llega como UTC midnight; mediodía UTC evita correr el día en AR. */
function toDateIso(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}T12:00:00.000Z`;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  if (match) return `${match[1]}-${match[2]}-${match[3]}T12:00:00.000Z`;
  return toIso(value);
}

function isTicketPayment(paymentType) {
  return paymentType === 'tickets' || paymentType === 'ticket_sales';
}

export function formatBarReason(eventName, registerDate) {
  const name = typeof eventName === 'string' ? eventName.trim() : '';
  if (name) return `Ventas de ${name}`;
  const day = formatDayLabel(registerDate);
  return day ? `Ventas del ${day}` : 'Ventas';
}

export function formatAgendaReason({
  activityName,
  rentalType,
  month,
  paymentType,
}) {
  const name = (activityName || 'Sin nombre').trim() || 'Sin nombre';
  if (isTicketPayment(paymentType)) return `Entradas de ${name}`;
  if (rentalType === 'recurring') {
    const monthLabel = formatMonthLabel(month);
    return monthLabel ? `Pago de ${name} de ${monthLabel}` : `Pago de ${name}`;
  }
  if (rentalType === 'seminar') return `Pago de ${name}`;
  return `Alquiler de ${name}`;
}

const RESTAURANT_ACTIVITY_ID = 561012;

function formatCuit(taxId) {
  const digits = String(taxId || '').replace(/\D/g, '');
  if (digits.length !== 11) return '';
  return `${digits.slice(0, 2)}-${digits.slice(2, 10)}-${digits.slice(10)}`;
}

function orderInvoiceDescription(eventName, registerDate, taxId) {
  const event = typeof eventName === 'string' ? eventName.trim() : '';
  const day = formatDayLabel(registerDate);
  const label = event ? `Venta de ${event}` : day ? `Venta del ${day}` : 'Venta';
  const cuit = formatCuit(taxId);
  return (cuit ? `${label} - ${cuit}` : label).slice(0, 200);
}

/**
 * Una comanda ya facturada no vuelve a sumarse al ingreso del cierre de caja.
 * El efectivo no entra en ese listado.
 */
async function applyInvoicedOrderDeductions(db, rows) {
  const marks = await db.query(
    `SELECT o.id AS order_id,
            o.cash_register_id,
            o.payment_method,
            o.mercado_pago_account_id,
            o.closed_open_account_id,
            m.issued_amount::double precision AS issued_amount
     FROM finance_invoice_marks m
     JOIN orders o ON m.source_key = 'order:' || o.id
     WHERE m.cae IS NOT NULL
       AND COALESCE(m.issued_amount, 0) > 0
       AND o.cash_register_id IS NOT NULL`,
  );
  if (marks.rows.length === 0) return rows;

  const orderIds = marks.rows.map((row) => row.order_id);
  const tabIds = marks.rows
    .map((row) => row.closed_open_account_id)
    .filter(Boolean);
  const payments = await db.query(
    `SELECT order_id, open_account_id, mercado_pago_account_id,
            amount::double precision AS amount
     FROM buffet_payments
     WHERE payment_method = 'mercadopago'
       AND (order_id = ANY($1::text[]) OR open_account_id = ANY($2::text[]))`,
    [orderIds, tabIds.length > 0 ? tabIds : ['__none__']],
  );

  const deductions = new Map();
  const add = (cashRegisterId, accountId, amount) => {
    if (!cashRegisterId || !accountId || !(amount > 0)) return;
    const key = `${cashRegisterId}:${accountId}`;
    deductions.set(key, (deductions.get(key) || 0) + amount);
  };

  for (const row of marks.rows) {
    if (row.payment_method === 'efectivo' || row.payment_method === 'cuenta_abierta') {
      continue;
    }
    const issued = Number(row.issued_amount) || 0;
    if (issued <= 0) continue;

    const orderPays = payments.rows.filter(
      (payment) =>
        payment.order_id === row.order_id && payment.mercado_pago_account_id,
    );
    if (orderPays.length > 0) {
      let left = issued;
      for (const payment of orderPays) {
        const share = Math.min(left, Number(payment.amount) || 0);
        add(row.cash_register_id, payment.mercado_pago_account_id, share);
        left -= share;
      }
      continue;
    }
    if (row.mercado_pago_account_id) {
      add(row.cash_register_id, row.mercado_pago_account_id, issued);
      continue;
    }
    const tabPays = payments.rows.filter(
      (payment) =>
        row.closed_open_account_id &&
        payment.open_account_id === row.closed_open_account_id &&
        payment.mercado_pago_account_id,
    );
    if (tabPays.length === 0) continue;
    const tabTotal = tabPays.reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0);
    let left = issued;
    tabPays.forEach((payment, index) => {
      const raw =
        index === tabPays.length - 1 || tabTotal <= 0
          ? left
          : Math.round(((issued * (Number(payment.amount) || 0)) / tabTotal) * 100) / 100;
      const share = Math.min(left, raw);
      add(row.cash_register_id, payment.mercado_pago_account_id, share);
      left = Math.round((left - share) * 100) / 100;
    });
  }

  if (deductions.size === 0) return rows;
  return rows.flatMap((row) => {
    const deduct = deductions.get(`${row.cash_register_id}:${row.account_id}`) || 0;
    if (deduct <= 0) return [row];
    const next = Math.round((Number(row.amount) - deduct) * 100) / 100;
    if (next < AFIP_INVOICE_THRESHOLD) return [];
    return [{ ...row, amount: next }];
  });
}

const BAR_SQL = `
  SELECT
    split_part(ft.reference_id, ':', 2) AS cash_register_id,
    ft.account_id,
    mp.holder AS partner,
    SUM(ft.amount)::double precision AS amount,
    MAX(ft.date) AS tx_date,
    cr.date AS register_date,
    cr.event_name,
    ev.activity_name AS rental_activity_name
  FROM finance_transactions ft
  JOIN mercado_pago_accounts mp ON mp.id = ft.account_id
  LEFT JOIN cash_registers cr
    ON cr.id = split_part(ft.reference_id, ':', 2)
  LEFT JOIN agenda_rentals ev
    ON ev.id = COALESCE(NULLIF(cr.event_id, ''), ft.event_id)
  WHERE ft.type = 'income'
    AND ft.source = 'buffet'
    AND ft.account_id <> 'efectivo'
    AND COALESCE(mp.kind, 'mercadopago') <> 'cash'
    AND ft.reference_id LIKE 'caja-close:%:mp:%'
  GROUP BY
    split_part(ft.reference_id, ':', 2),
    ft.account_id,
    mp.holder,
    cr.date,
    cr.event_name,
    ev.activity_name
  HAVING SUM(ft.amount) >= $1
`;

const TICKET_MENU_SQL = `
  SELECT
    split_part(ft.reference_id, ':', 2) AS payment_id,
    ft.account_id,
    mp.holder AS partner,
    SUM(ft.amount)::double precision AS amount,
    MAX(ft.date) AS tx_date,
    r.activity_name
  FROM finance_transactions ft
  JOIN mercado_pago_accounts mp ON mp.id = ft.account_id
  JOIN agenda_payments ap ON ap.id = split_part(ft.reference_id, ':', 2)
  JOIN agenda_rentals r ON r.id = ap.rental_id
  WHERE ft.type = 'income'
    AND ft.source = 'agenda'
    AND ft.reference_id LIKE 'ticket-menu:%'
    AND ft.account_id <> 'efectivo'
    AND COALESCE(mp.kind, 'mercadopago') <> 'cash'
  GROUP BY
    split_part(ft.reference_id, ':', 2),
    ft.account_id,
    mp.holder,
    r.activity_name
  HAVING SUM(ft.amount) >= $1
`;

const AGENDA_SQL = `
  SELECT
    ap.id AS payment_id,
    mp.holder AS partner,
    ft.amount::double precision AS amount,
    ft.date AS tx_date,
    r.activity_name,
    r.type AS rental_type,
    ap.month,
    COALESCE(ap.payment_type, 'rental') AS payment_type
  FROM finance_transactions ft
  JOIN agenda_payments ap ON ap.id = ft.reference_id
  JOIN agenda_rentals r ON r.id = ap.rental_id
  JOIN mercado_pago_accounts mp ON mp.id = ft.account_id
  WHERE ft.type = 'income'
    AND ft.source = 'agenda'
    AND ft.account_id <> 'efectivo'
    AND COALESCE(mp.kind, 'mercadopago') <> 'cash'
    AND ft.amount >= $1
`;

export async function listInvoiceItems(db) {
  const [barResult, agendaResult, ticketMenuResult, marksResult] = await Promise.all([
    db.query(BAR_SQL, [AFIP_INVOICE_THRESHOLD]),
    db.query(AGENDA_SQL, [AFIP_INVOICE_THRESHOLD]),
    db.query(TICKET_MENU_SQL, [AFIP_INVOICE_THRESHOLD]),
    db.query(
      `SELECT source_key, invoiced, archived, cae, cae_expiry,
              voucher_number, voucher_type, sales_point, qr,
              issued_amount, issued_description, issued_date,
              receiver_tax_id, receiver_name, receiver_vat_condition,
              partner
       FROM finance_invoice_marks`,
    ),
  ]);

  const markByKey = new Map(
    marksResult.rows.map((row) => [row.source_key, mapInvoiceMark(row)]),
  );

  const barRows = await applyInvoicedOrderDeductions(db, barResult.rows);
  const items = [
    ...barRows.map((row) => {
      const sourceKey = `bar:${row.cash_register_id}:${row.account_id}`;
      const eventName = (row.event_name || row.rental_activity_name || '').trim();
      return invoiceItem(sourceKey, markByKey, {
        partner: row.partner || '—',
        amount: Number(row.amount) || 0,
        reason: formatBarReason(eventName, row.register_date || row.tx_date),
        date: toDateIso(row.register_date || row.tx_date),
      });
    }),
    ...ticketMenuResult.rows.map((row) => {
      const sourceKey = `ticket-menu:${row.payment_id}:${row.account_id}`;
      return invoiceItem(sourceKey, markByKey, {
        partner: row.partner || '—',
        amount: Number(row.amount) || 0,
        reason: formatBarReason(row.activity_name, row.tx_date),
        date: toIso(row.tx_date),
      });
    }),
    ...agendaResult.rows.map((row) => {
      const sourceKey = `agenda:${row.payment_id}`;
      return invoiceItem(sourceKey, markByKey, {
        partner: row.partner || '—',
        amount: Number(row.amount) || 0,
        reason: formatAgendaReason({
          activityName: row.activity_name,
          rentalType: row.rental_type,
          month: row.month,
          paymentType: row.payment_type,
        }),
        date: toIso(row.tx_date),
      });
    }),
  ];

  const known = new Set(items.map((item) => item.sourceKey));
  for (const row of marksResult.rows) {
    const sourceKey = String(row.source_key);
    const standalone =
      sourceKey.startsWith('manual:') || sourceKey.startsWith('order:');
    if (!standalone || known.has(sourceKey)) continue;
    const mark = markByKey.get(row.source_key);
    if (!mark?.invoiced && !mark?.archived) continue;
    const issuedDate = mark.issuedDate;
    items.push(
      invoiceItem(row.source_key, markByKey, {
        partner: row.partner || '—',
        amount: mark.issuedAmount ?? 0,
        reason: mark.issuedDescription || '',
        date: issuedDate ? `${issuedDate}T12:00:00.000Z` : new Date().toISOString(),
      }),
    );
  }

  items.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  return items;
}

export async function setInvoiceMark(db, sourceKey, patch) {
  const hasInvoiced = typeof patch?.invoiced === 'boolean';
  const hasArchived = typeof patch?.archived === 'boolean';
  if (!hasInvoiced && !hasArchived) {
    const err = new Error('Datos inválidos');
    err.statusCode = 400;
    throw err;
  }

  await db.query(
    `INSERT INTO finance_invoice_marks (source_key, invoiced, archived, updated_at)
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
     ON CONFLICT (source_key)
     DO UPDATE SET
       invoiced = CASE WHEN $4 THEN EXCLUDED.invoiced ELSE finance_invoice_marks.invoiced END,
       archived = CASE WHEN $5 THEN EXCLUDED.archived ELSE finance_invoice_marks.archived END,
       cae = CASE WHEN $4 AND EXCLUDED.invoiced = 0 THEN NULL ELSE finance_invoice_marks.cae END,
       cae_expiry = CASE WHEN $4 AND EXCLUDED.invoiced = 0 THEN NULL ELSE finance_invoice_marks.cae_expiry END,
       voucher_number = CASE WHEN $4 AND EXCLUDED.invoiced = 0 THEN NULL ELSE finance_invoice_marks.voucher_number END,
       voucher_type = CASE WHEN $4 AND EXCLUDED.invoiced = 0 THEN NULL ELSE finance_invoice_marks.voucher_type END,
       sales_point = CASE WHEN $4 AND EXCLUDED.invoiced = 0 THEN NULL ELSE finance_invoice_marks.sales_point END,
       qr = CASE WHEN $4 AND EXCLUDED.invoiced = 0 THEN NULL ELSE finance_invoice_marks.qr END,
       issued_amount = CASE WHEN $4 AND EXCLUDED.invoiced = 0 THEN NULL ELSE finance_invoice_marks.issued_amount END,
       issued_description = CASE WHEN $4 AND EXCLUDED.invoiced = 0 THEN NULL ELSE finance_invoice_marks.issued_description END,
       issued_date = CASE WHEN $4 AND EXCLUDED.invoiced = 0 THEN NULL ELSE finance_invoice_marks.issued_date END,
       receiver_tax_id = CASE WHEN $4 AND EXCLUDED.invoiced = 0 THEN NULL ELSE finance_invoice_marks.receiver_tax_id END,
       receiver_name = CASE WHEN $4 AND EXCLUDED.invoiced = 0 THEN NULL ELSE finance_invoice_marks.receiver_name END,
       receiver_vat_condition = CASE WHEN $4 AND EXCLUDED.invoiced = 0 THEN NULL ELSE finance_invoice_marks.receiver_vat_condition END,
       receiver_email = CASE WHEN $4 AND EXCLUDED.invoiced = 0 THEN NULL ELSE finance_invoice_marks.receiver_email END,
       updated_at = CURRENT_TIMESTAMP`,
    [
      sourceKey,
      hasInvoiced && patch.invoiced ? 1 : 0,
      hasArchived && patch.archived ? 1 : 0,
      hasInvoiced,
      hasArchived,
    ],
  );

  const updated = await db.query(
    'SELECT invoiced, archived FROM finance_invoice_marks WHERE source_key = $1',
    [sourceKey],
  );
  const row = updated.rows[0] || {};
  return {
    sourceKey,
    invoiced: Boolean(Number(row.invoiced)),
    archived: Boolean(Number(row.archived)),
  };
}

async function ownedInvoice(db, sourceKey, actorPartner) {
  const { partnerFromName } = await import('./arcaInvoice.js');
  const actor = partnerFromName(actorPartner);
  if (!actor) {
    const err = new Error('Solo un socio puede facturar');
    err.statusCode = 403;
    throw err;
  }

  const items = await listInvoiceItems(db);
  const item = items.find((row) => row.sourceKey === sourceKey);
  if (!item) {
    const err = new Error('No se encontró el ingreso');
    err.statusCode = 404;
    throw err;
  }
  if (partnerFromName(item.partner) !== actor) {
    const err = new Error('Solo podés facturar tus propios ingresos');
    err.statusCode = 403;
    throw err;
  }
  if (item.archived) {
    const err = new Error('El ingreso está archivado');
    err.statusCode = 400;
    throw err;
  }
  if (item.cae) {
    const err = new Error('Esta factura ya fue emitida');
    err.statusCode = 409;
    throw err;
  }
  return { actor, item };
}

function invoiceDraft(body, item) {
  const description =
    body?.description == null
      ? String(item.reason || '').trim().slice(0, 200)
      : String(body.description).trim().slice(0, 200);

  let amountPesos = Number(item.amount);
  if (body?.amount != null && body.amount !== '') {
    const amount = typeof body.amount === 'number' ? body.amount : Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      const err = new Error('El importe no es válido');
      err.statusCode = 400;
      throw err;
    }
    amountPesos = Math.round(amount * 100) / 100;
  }
  if (!Number.isFinite(amountPesos) || amountPesos <= 0) {
    const err = new Error('El importe no es válido');
    err.statusCode = 400;
    throw err;
  }
  return { description, amountPesos };
}

const MANUAL_SOURCE_KEY =
  /^manual:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ORDER_SOURCE_KEY = /^order:#\d+$/;

/** Una comanda se factura siempre con el CUIT de Lucho. */
const ORDER_ISSUER = 'Lucho';

export async function previewBlankInvoice(actorPartner, receiverTaxId) {
  const { partnerFromName, previewMonotributoInvoice } = await import('./arcaInvoice.js');
  const actor = partnerFromName(actorPartner);
  if (!actor) {
    const err = new Error('Solo un socio puede facturar');
    err.statusCode = 403;
    throw err;
  }
  const preview = await previewMonotributoInvoice({
    partner: actor,
    amountPesos: 1,
    reason: '',
    receiverTaxId,
  });
  return { ...preview, sourceKey: null, description: '', amount: 0 };
}

export async function previewInvoiceItem(db, sourceKey, actorPartner, receiverTaxId) {
  const { actor, item } = await ownedInvoice(db, sourceKey, actorPartner);
  const { previewMonotributoInvoice } = await import('./arcaInvoice.js');
  const preview = await previewMonotributoInvoice({
    partner: actor,
    amountPesos: item.amount,
    reason: item.reason,
    receiverTaxId,
  });
  return { sourceKey, ...preview };
}

function parseInvoiceEmail(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const email = String(raw).trim();
  if (!isValidEmail(email)) {
    const err = new Error('El mail no es válido');
    err.statusCode = 400;
    throw err;
  }
  return email;
}

export async function issueInvoiceItem(db, sourceKey, actorPartner, receiverTaxId, draft) {
  const email = parseInvoiceEmail(draft?.email);
  const manual = String(sourceKey).startsWith('manual:');
  const orderInvoice = ORDER_SOURCE_KEY.test(sourceKey);
  let actor;
  let item;
  let description;
  let amountPesos;
  if (orderInvoice) {
    if (!email) {
      const err = new Error('Escribí un mail para enviar la factura');
      err.statusCode = 400;
      throw err;
    }
    const { partnerFromName } = await import('./arcaInvoice.js');
    if (!partnerFromName(actorPartner)) {
      const err = new Error('Solo un socio puede facturar');
      err.statusCode = 403;
      throw err;
    }
    actor = ORDER_ISSUER;
    const existing = await db.query(
      'SELECT cae FROM finance_invoice_marks WHERE source_key = $1',
      [sourceKey],
    );
    if (existing.rows[0]?.cae) {
      const err = new Error('Esta factura ya fue emitida');
      err.statusCode = 409;
      throw err;
    }
    const orderId = sourceKey.slice('order:'.length);
    const orderResult = await db.query(
      `SELECT o.total, cr.event_name, cr.date AS register_date
       FROM orders o
       LEFT JOIN cash_registers cr ON cr.id = o.cash_register_id
       WHERE o.id = $1`,
      [orderId],
    );
    const order = orderResult.rows[0];
    if (!order) {
      const err = new Error('La comanda no existe');
      err.statusCode = 404;
      throw err;
    }
    amountPesos = Math.round(Number(order.total) * 100) / 100;
    if (!Number.isFinite(amountPesos) || amountPesos <= 0) {
      const err = new Error('El importe no es válido');
      err.statusCode = 400;
      throw err;
    }
    description = orderInvoiceDescription(
      order.event_name,
      order.register_date,
      receiverTaxId,
    );
    item = { sourceKey, amount: amountPesos, reason: description, partner: actor };
  } else if (manual) {
    if (!MANUAL_SOURCE_KEY.test(sourceKey)) {
      const err = new Error('Datos inválidos');
      err.statusCode = 400;
      throw err;
    }
    const { partnerFromName } = await import('./arcaInvoice.js');
    actor = partnerFromName(actorPartner);
    if (!actor) {
      const err = new Error('Solo un socio puede facturar');
      err.statusCode = 403;
      throw err;
    }
    const existing = await db.query(
      'SELECT cae FROM finance_invoice_marks WHERE source_key = $1',
      [sourceKey],
    );
    if (existing.rows[0]?.cae) {
      const err = new Error('Esta factura ya fue emitida');
      err.statusCode = 409;
      throw err;
    }
    ({ description, amountPesos } = invoiceDraft(draft, { amount: 0, reason: '' }));
    if (!description) {
      const err = new Error('Escribí una descripción');
      err.statusCode = 400;
      throw err;
    }
    item = { sourceKey };
  } else {
    ({ actor, item } = await ownedInvoice(db, sourceKey, actorPartner));
    ({ description, amountPesos } = invoiceDraft(draft, item));
  }
  const { issueMonotributoInvoice, describeIssueFailure, resolveActivityId, listIssuerActivities } =
    await import('./arcaInvoice.js');
  let activityRaw = draft?.activityId;
  if (orderInvoice) {
    const activities = await listIssuerActivities(actor);
    if (activities.length === 0) {
      activityRaw = null;
    } else if (!activities.some((activity) => activity.id === RESTAURANT_ACTIVITY_ID)) {
      const err = new Error('La actividad de restaurante no está habilitada');
      err.statusCode = 400;
      throw err;
    } else {
      activityRaw = RESTAURANT_ACTIVITY_ID;
    }
  }
  const activityId = await resolveActivityId(actor, activityRaw);

  let factura;
  try {
    factura = await issueMonotributoInvoice({
      partner: actor,
      amountPesos,
      reason: description,
      idempotencyKey: item.sourceKey,
      receiverTaxId,
      activityId,
    });
  } catch (error) {
    if (error?.code === 'ARCA_INPUT_IDEMPOTENCY_MISMATCH') {
      const err = new Error('Este ingreso ya se intentó facturar con otros datos.');
      err.statusCode = 409;
      throw err;
    }
    const err = new Error(error?.message || 'No se pudo emitir la factura');
    err.statusCode = error?.statusCode || 502;
    throw err;
  }

  if (factura.kind !== 'authorized') {
    const err = new Error(describeIssueFailure(factura));
    err.statusCode = factura.kind === 'rejected' ? 422 : 409;
    throw err;
  }

  const voucher = factura.voucher;
  const receiver = factura.receiver ?? {};
  await db.query(
    `INSERT INTO finance_invoice_marks (
       source_key, invoiced, archived, cae, cae_expiry,
       voucher_number, voucher_type, sales_point, qr,
       issued_amount, issued_description, issued_date,
       receiver_tax_id, receiver_name, receiver_vat_condition, receiver_email,
       partner, updated_at
     )
     VALUES ($1, 1, 0, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, CURRENT_TIMESTAMP)
     ON CONFLICT (source_key)
     DO UPDATE SET
       invoiced = 1,
       cae = EXCLUDED.cae,
       cae_expiry = EXCLUDED.cae_expiry,
       voucher_number = EXCLUDED.voucher_number,
       voucher_type = EXCLUDED.voucher_type,
       sales_point = EXCLUDED.sales_point,
       qr = EXCLUDED.qr,
       issued_amount = EXCLUDED.issued_amount,
       issued_description = EXCLUDED.issued_description,
       issued_date = EXCLUDED.issued_date,
       receiver_tax_id = EXCLUDED.receiver_tax_id,
       receiver_name = EXCLUDED.receiver_name,
       receiver_vat_condition = EXCLUDED.receiver_vat_condition,
       receiver_email = EXCLUDED.receiver_email,
       partner = EXCLUDED.partner,
       updated_at = CURRENT_TIMESTAMP`,
    [
      sourceKey,
      voucher.cae,
      voucher.caeExpiry,
      voucher.number,
      voucher.voucherType,
      voucher.salesPoint,
      voucher.qr ?? null,
      amountPesos,
      description,
      voucher.date ?? null,
      receiver.receiverTaxId ?? null,
      receiver.receiverName ?? null,
      receiver.receiverVatCondition ?? null,
      email,
      actor,
    ],
  );

  const refreshed = await listInvoiceItems(db);
  const saved = refreshed.find((row) => row.sourceKey === sourceKey) ?? item;
  if (!email) return saved;

  let emailSent = false;
  try {
    emailSent = await sendIssuedInvoiceEmail(saved, email);
  } catch (error) {
    console.error('invoice email:', error?.message || error);
  }
  return { ...saved, emailSent };
}

function mapInvoiceMark(row) {
  return {
    invoiced: Boolean(Number(row.invoiced)),
    archived: Boolean(Number(row.archived)),
    cae: row.cae || null,
    caeExpiry: row.cae_expiry || null,
    voucherNumber: row.voucher_number == null ? null : Number(row.voucher_number),
    voucherType: row.voucher_type == null ? null : Number(row.voucher_type),
    salesPoint: row.sales_point == null ? null : Number(row.sales_point),
    qr: row.qr || null,
    issuedAmount: row.issued_amount == null ? null : Number(row.issued_amount),
    issuedDescription: row.issued_description || null,
    issuedDate: row.issued_date || null,
    receiverTaxId: row.receiver_tax_id || null,
    receiverName: row.receiver_name || null,
    receiverVatCondition: row.receiver_vat_condition || null,
    partner: row.partner || null,
  };
}

function invoiceItem(sourceKey, markByKey, fields) {
  const mark = markByKey.get(sourceKey);
  return {
    sourceKey,
    ...fields,
    invoiced: mark?.invoiced === true,
    archived: mark?.archived === true,
    cae: mark?.cae ?? null,
    caeExpiry: mark?.caeExpiry ?? null,
    voucherNumber: mark?.voucherNumber ?? null,
    voucherType: mark?.voucherType ?? null,
    salesPoint: mark?.salesPoint ?? null,
    qr: mark?.qr ?? null,
    issuedAmount: mark?.issuedAmount ?? null,
    issuedDescription: mark?.issuedDescription ?? null,
    issuedDate: mark?.issuedDate ?? null,
    receiverTaxId: mark?.receiverTaxId ?? null,
    receiverName: mark?.receiverName ?? null,
    receiverVatCondition: mark?.receiverVatCondition ?? null,
    ...(mark?.cae ? issuerProfile(mark.partner || fields.partner) : null),
  };
}
