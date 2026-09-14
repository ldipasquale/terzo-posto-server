/**
 * Ingresos de Mercado Pago que superan el umbral de facturación AFIP.
 * El bar (comida + bebida + vasos del mismo cierre y socio) se agrupa en un renglón.
 */

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
  const [barResult, agendaResult, marksResult] = await Promise.all([
    db.query(BAR_SQL, [AFIP_INVOICE_THRESHOLD]),
    db.query(AGENDA_SQL, [AFIP_INVOICE_THRESHOLD]),
    db.query('SELECT source_key, invoiced FROM finance_invoice_marks'),
  ]);

  const invoicedByKey = new Map(
    marksResult.rows.map((row) => [
      row.source_key,
      Boolean(Number(row.invoiced)),
    ]),
  );

  const items = [
    ...barResult.rows.map((row) => {
      const sourceKey = `bar:${row.cash_register_id}:${row.account_id}`;
      const eventName = (row.event_name || row.rental_activity_name || '').trim();
      return {
        sourceKey,
        partner: row.partner || '—',
        amount: Number(row.amount) || 0,
        reason: formatBarReason(eventName, row.register_date || row.tx_date),
        date: toDateIso(row.register_date || row.tx_date),
        invoiced: invoicedByKey.get(sourceKey) === true,
      };
    }),
    ...agendaResult.rows.map((row) => {
      const sourceKey = `agenda:${row.payment_id}`;
      return {
        sourceKey,
        partner: row.partner || '—',
        amount: Number(row.amount) || 0,
        reason: formatAgendaReason({
          activityName: row.activity_name,
          rentalType: row.rental_type,
          month: row.month,
          paymentType: row.payment_type,
        }),
        date: toIso(row.tx_date),
        invoiced: invoicedByKey.get(sourceKey) === true,
      };
    }),
  ];

  items.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  return items;
}

export async function setInvoiceMark(db, sourceKey, invoiced) {
  await db.query(
    `INSERT INTO finance_invoice_marks (source_key, invoiced, updated_at)
     VALUES ($1, $2, CURRENT_TIMESTAMP)
     ON CONFLICT (source_key)
     DO UPDATE SET invoiced = EXCLUDED.invoiced, updated_at = CURRENT_TIMESTAMP`,
    [sourceKey, invoiced ? 1 : 0],
  );
  return { sourceKey, invoiced };
}
