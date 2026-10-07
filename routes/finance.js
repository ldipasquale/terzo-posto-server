import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import express from 'express';
import multer from 'multer';
import db from '../database.js';
import {
  ensureFixedExpenseReceiptsDir,
  fixedExpenseReceiptsDir,
  isReceiptFileName,
  newId,
  receiptExtension,
} from '../lib/eventTickets.js';
import {
  FINANCE_AREA_CATEGORY,
  canLinkEventToArea,
  isValidAreaCategory,
} from '../lib/financeAreas.js';
import {
  invoiceIssuers,
  listIssuerActivities,
  parseReceiverTaxId,
  partnerFromName,
} from '../lib/arcaInvoice.js';
import {
  issueInvoiceItem,
  listInvoiceItems,
  previewBlankInvoice,
  previewInvoiceItem,
  setInvoiceMark,
} from '../lib/financeInvoices.js';

const router = express.Router();

const PARTNERS = ['Lucho', 'Bachi', 'Luli'];
const RECEIPT_MIMES = ['image/jpeg', 'image/png', 'image/webp'];
const CERTIFICATE_MIMES = [...RECEIPT_MIMES, 'application/pdf'];
const CERTIFICATE_NAME_RE = /^[a-f0-9-]{36}\.(jpe?g|png|webp|pdf)$/i;

function isCertificateFileName(name) {
  return CERTIFICATE_NAME_RE.test(String(name || ''));
}

function certificateExtension(mimetype) {
  if (mimetype === 'application/pdf') return 'pdf';
  return receiptExtension(mimetype);
}

const receiptUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!RECEIPT_MIMES.includes(file.mimetype)) {
      cb(new Error('Solo se permiten imágenes JPEG, PNG o WebP'));
      return;
    }
    cb(null, true);
  },
});

const paymentFilesUpload = receiptUpload.fields([
  { name: 'receipt', maxCount: 1 },
]);

const certificateUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!CERTIFICATE_MIMES.includes(file.mimetype)) {
      cb(new Error('Solo se permiten imágenes JPEG, PNG, WebP o PDF'));
      return;
    }
    cb(null, true);
  },
});

function removeReceiptFile(fileName) {
  if (!fileName || !isCertificateFileName(fileName)) return;
  const filePath = path.join(fixedExpenseReceiptsDir(), fileName);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (error) {
    console.error('Error deleting fixed expense receipt:', error);
  }
}

function parseResponsibleName(value) {
  if (value == null) return null;
  const name = String(value).trim();
  if (!name) return '';
  return PARTNERS.includes(name) ? name : undefined;
}

function mapLiquidityAccount(row) {
  const isCash = row.kind === 'cash' || row.id === 'efectivo';
  return {
    id: row.id,
    name: isCash ? 'Efectivo' : row.holder,
    type: isCash ? 'cash' : 'partner',
    mercadoPagoAccountId: isCash ? undefined : row.id,
  };
}

const mapTransaction = (row) => ({
  id: row.id,
  accountId: row.account_id,
  type: row.type,
  amount: Number(row.amount),
  description: row.description,
  source: row.source,
  area: row.area || undefined,
  category: row.category || undefined,
  eventId: row.event_id || undefined,
  referenceId: row.reference_id || undefined,
  date: new Date(row.date).toISOString(),
  createdAt: new Date(row.created_at).toISOString(),
});

const FIXED_EXPENSE_FREQUENCIES = new Set([
  'monthly',
  'bimonthly',
  'semiannual',
  'annual',
]);

function parseFixedExpenseSchedule(body, required) {
  if (!required && body.frequency == null && body.anchorMonth == null) {
    return null;
  }
  if (!required && body.frequency == null) {
    return { error: 'Frecuencia inválida' };
  }
  const frequency = body.frequency == null || body.frequency === ''
    ? 'monthly'
    : String(body.frequency);
  if (!FIXED_EXPENSE_FREQUENCIES.has(frequency)) {
    return { error: 'Frecuencia inválida' };
  }
  if (frequency === 'monthly') {
    return { frequency, anchorMonth: null };
  }
  const anchorMonth = Number(body.anchorMonth);
  if (!Number.isInteger(anchorMonth) || anchorMonth < 1 || anchorMonth > 12) {
    return { error: 'Elegí el mes de vencimiento' };
  }
  return { frequency, anchorMonth };
}

const mapFixedExpense = (row) => ({
  id: row.id,
  name: row.name,
  amount: Number(row.amount),
  dueDay: Number(row.due_day),
  frequency: row.frequency || 'monthly',
  anchorMonth: row.anchor_month == null ? undefined : Number(row.anchor_month),
  notes: row.notes || undefined,
  responsibleName: row.responsible_name || undefined,
  hasCertificate: Boolean(row.has_certificate),
  active: Boolean(row.active),
  createdAt: new Date(row.created_at).toISOString(),
  latestCertificateId: row.latest_certificate_id || null,
  latestCertificateAt: row.latest_certificate_at
    ? new Date(row.latest_certificate_at).toISOString()
    : null,
});

const mapFixedExpenseCertificate = (row) => ({
  id: row.id,
  fixedExpenseId: row.fixed_expense_id,
  createdAt: new Date(row.created_at).toISOString(),
  url: `/api/finance/fixed-expense-certificates/${row.id}/file`,
});

const FIXED_EXPENSE_SELECT = `
  SELECT expense.*,
    latest.id AS latest_certificate_id,
    latest.created_at AS latest_certificate_at
  FROM finance_fixed_expenses expense
  LEFT JOIN LATERAL (
    SELECT id, created_at
    FROM finance_fixed_expense_certificates
    WHERE fixed_expense_id = expense.id
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  ) latest ON true
`;

async function syncFixedExpenseAmount(client, expenseId) {
  await client.query(
    `UPDATE finance_fixed_expenses AS expense
     SET amount = latest.amount,
         updated_at = CURRENT_TIMESTAMP
     FROM (
       SELECT amount
       FROM finance_fixed_expense_payments
       WHERE fixed_expense_id = $1
       ORDER BY paid_date DESC, id DESC
       LIMIT 1
     ) AS latest
     WHERE expense.id = $1`,
    [expenseId],
  );
}

const mapFixedExpensePayment = (row) => ({
  id: row.id,
  fixedExpenseId: row.fixed_expense_id,
  month: row.month,
  amount: Number(row.amount),
  accountId: row.account_id,
  paidDate: new Date(row.paid_date).toISOString(),
  receiptUrl: row.receipt_file
    ? `/api/finance/fixed-expense-payments/${row.id}/receipt`
    : null,
  certificateUrl: row.certificate_file
    ? `/api/finance/fixed-expense-payments/${row.id}/certificate`
    : null,
});

router.get('/accounts', async (_req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM mercado_pago_accounts
       WHERE active = 1 OR id = 'efectivo'
       ORDER BY CASE WHEN kind = 'cash' OR id = 'efectivo' THEN 0 ELSE 1 END, created_at ASC`,
    );
    res.json(result.rows.map(mapLiquidityAccount));
  } catch (error) {
    console.error('Error fetching finance accounts:', error);
    res.status(500).json({ error: 'Error al obtener cuentas' });
  }
});

router.get('/invoices', async (_req, res) => {
  try {
    const items = await listInvoiceItems(db);
    res.json(items);
  } catch (error) {
    console.error('Error fetching invoices:', error);
    res.status(500).json({ error: 'Error al obtener facturas' });
  }
});

router.get('/invoices/issuers', (_req, res) => {
  res.json(invoiceIssuers());
});

router.get('/invoices/activities', async (req, res) => {
  try {
    const partner = partnerFromName(req.user?.name);
    if (!partner) {
      return res.status(403).json({ error: 'Solo un socio puede facturar' });
    }
    const activities = await listIssuerActivities(partner);
    res.json(activities);
  } catch (error) {
    console.error('Error listing invoice activities:', error);
    res.status(error.statusCode || 500).json({
      error: error.statusCode ? error.message : 'Error al obtener actividades',
    });
  }
});

router.post('/invoices/preview', async (req, res) => {
  try {
    const sourceKey = String(req.body?.sourceKey || '').trim();
    const receiverTaxId = parseReceiverTaxId(req.body?.receiverTaxId);
    const preview = sourceKey
      ? await previewInvoiceItem(db, sourceKey, req.user?.name, receiverTaxId)
      : await previewBlankInvoice(req.user?.name, receiverTaxId);
    res.json(preview);
  } catch (error) {
    console.error('Error previewing invoice:', error);
    res.status(error.statusCode || 500).json({
      error: error.statusCode ? error.message : 'Error al previsualizar la factura',
    });
  }
});

router.post('/invoices/issue', async (req, res) => {
  try {
    const sourceKey = String(req.body?.sourceKey || '').trim();
    if (!sourceKey) {
      return res.status(400).json({ error: 'Datos inválidos' });
    }
    const receiverTaxId = parseReceiverTaxId(req.body?.receiverTaxId);
    const item = await issueInvoiceItem(db, sourceKey, req.user?.name, receiverTaxId, {
      description: req.body?.description,
      amount: req.body?.amount,
      activityId: req.body?.activityId,
      email: req.body?.email,
    });
    res.json(item);
  } catch (error) {
    console.error('Error issuing invoice:', error);
    res.status(error.statusCode || 500).json({
      error: error.statusCode ? error.message : 'Error al emitir la factura',
    });
  }
});

router.patch('/invoices', async (req, res) => {
  try {
    const sourceKey = String(req.body?.sourceKey || '').trim();
    const patch = {};
    if (typeof req.body?.invoiced === 'boolean') patch.invoiced = req.body.invoiced;
    if (typeof req.body?.archived === 'boolean') patch.archived = req.body.archived;
    if (!sourceKey || (patch.invoiced == null && patch.archived == null)) {
      return res.status(400).json({ error: 'Datos inválidos' });
    }
    const updated = await setInvoiceMark(db, sourceKey, patch);
    res.json(updated);
  } catch (error) {
    console.error('Error updating invoice mark:', error);
    res.status(error.statusCode || 500).json({
      error: error.statusCode ? error.message : 'Error al actualizar la factura',
    });
  }
});

router.get('/transactions', async (_req, res) => {
  try {
    const result = await db.query('SELECT * FROM finance_transactions ORDER BY date DESC');
    res.json(result.rows.map(mapTransaction));
  } catch (error) {
    console.error('Error fetching finance transactions:', error);
    res.status(500).json({ error: 'Error al obtener movimientos' });
  }
});

function normalizeAccountId(accountId) {
  if (!accountId || typeof accountId !== 'string') return accountId;
  return accountId.startsWith('mp-') ? accountId.slice(3) : accountId;
}

async function assertLiquidityAccountExists(accountId) {
  const acc = await db.query(
    'SELECT id FROM mercado_pago_accounts WHERE id = $1',
    [accountId],
  );
  if (!acc.rows[0]) {
    const err = new Error('Cuenta inválida o inexistente');
    err.statusCode = 400;
    throw err;
  }
}

/**
 * Valida event_id: solo eventos one-off y áreas linkeables.
 * @returns {Promise<string|null>}
 */
async function resolveEventId(eventId, area) {
  if (eventId == null || eventId === '') return null;
  if (!canLinkEventToArea(area)) {
    const err = new Error(
      'Solo Cocina, Bar, Agenda y Comunicación pueden vincularse a un evento',
    );
    err.statusCode = 400;
    throw err;
  }
  const r = await db.query(
    `SELECT id FROM agenda_rentals WHERE id = $1 AND type = 'one-off'`,
    [eventId],
  );
  if (!r.rows[0]) {
    const err = new Error('Evento no encontrado');
    err.statusCode = 400;
    throw err;
  }
  return eventId;
}

function validateTransactionPayload(t) {
  if (!t?.accountId || !t?.type || Number(t.amount) <= 0 || !t?.description) {
    const err = new Error('Datos inválidos de movimiento');
    err.statusCode = 400;
    throw err;
  }
  if (!['income', 'expense', 'transfer'].includes(t.type)) {
    const err = new Error('Tipo de movimiento inválido');
    err.statusCode = 400;
    throw err;
  }
  const accountId = normalizeAccountId(t.accountId);
  if (t.type === 'transfer') {
    const destId = normalizeAccountId(t.referenceId);
    if (!destId) {
      const err = new Error('Destino de transferencia requerido');
      err.statusCode = 400;
      throw err;
    }
    if (destId === accountId) {
      const err = new Error('El destino debe ser distinto de la cuenta origen');
      err.statusCode = 400;
      throw err;
    }
    return {
      accountId,
      destId,
      area: null,
      category: null,
      referenceId: destId,
      eventIdRaw: null,
    };
  }
  const area = t.area ?? null;
  const category = t.category ?? null;
  if ((t.source || 'manual') === 'manual') {
    if (!isValidAreaCategory(t.type, area, category)) {
      const err = new Error(
        'Área/categoría inválida para el tipo de movimiento',
      );
      err.statusCode = 400;
      throw err;
    }
  }
  return {
    accountId,
    destId: null,
    area,
    category,
    referenceId: t.referenceId ?? null,
    eventIdRaw: t.eventId ?? null,
  };
}

router.post('/transactions', async (req, res) => {
  try {
    const t = req.body;
    let parsed;
    try {
      parsed = validateTransactionPayload(t);
    } catch (e) {
      if (e.statusCode === 400) return res.status(400).json({ error: e.message });
      throw e;
    }
    const { accountId, destId, area, category, referenceId, eventIdRaw } = parsed;
    await assertLiquidityAccountExists(accountId);
    if (destId) await assertLiquidityAccountExists(destId);
    const eventId = await resolveEventId(eventIdRaw, area);
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO finance_transactions
       (id, account_id, type, amount, description, source, area, category, reference_id, event_id, date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id,
        accountId,
        t.type,
        Number(t.amount),
        String(t.description).trim(),
        t.source || 'manual',
        area,
        category,
        referenceId,
        eventId,
        t.date || new Date().toISOString(),
      ],
    );
    const created = await db.query('SELECT * FROM finance_transactions WHERE id = $1', [id]);
    res.status(201).json(mapTransaction(created.rows[0]));
  } catch (error) {
    console.error('Error creating finance transaction:', error);
    if (error.statusCode === 400) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: 'Error al crear movimiento' });
  }
});

router.put('/transactions/:id', async (req, res) => {
  try {
    const t = req.body;
    let parsed;
    try {
      parsed = validateTransactionPayload(t);
    } catch (e) {
      if (e.statusCode === 400) return res.status(400).json({ error: e.message });
      throw e;
    }
    const { accountId, destId, area, category, referenceId, eventIdRaw } = parsed;
    await assertLiquidityAccountExists(accountId);
    if (destId) await assertLiquidityAccountExists(destId);
    const eventId = await resolveEventId(eventIdRaw, area);

    const result = await db.query(
      `UPDATE finance_transactions
       SET account_id = $1,
           type = $2,
           amount = $3,
           description = $4,
           area = $5,
           category = $6,
           reference_id = $7,
           event_id = $8,
           date = $9
       WHERE id = $10
         AND source = 'manual'`,
      [
        accountId,
        t.type,
        Number(t.amount),
        String(t.description).trim(),
        area,
        category,
        referenceId,
        eventId,
        t.date || new Date().toISOString(),
        req.params.id,
      ],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Movimiento no encontrado o no editable' });
    }

    const updated = await db.query('SELECT * FROM finance_transactions WHERE id = $1', [
      req.params.id,
    ]);
    res.json(mapTransaction(updated.rows[0]));
  } catch (error) {
    console.error('Error updating finance transaction:', error);
    if (error.statusCode === 400) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: 'Error al actualizar movimiento' });
  }
});

/** Reasignar área/categoría de cualquier ingreso/egreso (manual o automático). */
router.patch('/transactions/:id/classification', async (req, res) => {
  try {
    const existing = await db.query(
      'SELECT id, type FROM finance_transactions WHERE id = $1',
      [req.params.id],
    );
    const row = existing.rows[0];
    if (!row) {
      return res.status(404).json({ error: 'Movimiento no encontrado' });
    }
    if (row.type !== 'income' && row.type !== 'expense') {
      return res.status(400).json({ error: 'Solo se puede reclasificar ingresos o egresos' });
    }

    const area =
      req.body?.area === undefined || req.body?.area === '' || req.body?.area === null
        ? null
        : req.body.area;
    const category =
      req.body?.category === undefined ||
      req.body?.category === '' ||
      req.body?.category === null
        ? null
        : req.body.category;

    if (area == null) {
      if (category != null) {
        return res.status(400).json({
          error: 'Sin área no admite categoría',
        });
      }
    } else if (!isValidAreaCategory(row.type, area, category)) {
      return res.status(400).json({
        error: 'Área/categoría inválida para el tipo de movimiento',
      });
    }

    let eventId;
    try {
      eventId = await resolveEventId(req.body?.eventId ?? null, area);
    } catch (e) {
      if (e.statusCode === 400) return res.status(400).json({ error: e.message });
      throw e;
    }

    await db.query(
      `UPDATE finance_transactions
       SET area = $1, category = $2, event_id = $3
       WHERE id = $4`,
      [area, category, eventId, req.params.id],
    );

    const updated = await db.query('SELECT * FROM finance_transactions WHERE id = $1', [
      req.params.id,
    ]);
    res.json(mapTransaction(updated.rows[0]));
  } catch (error) {
    console.error('Error updating transaction classification:', error);
    res.status(500).json({ error: 'Error al reclasificar movimiento' });
  }
});

router.delete('/transactions/:id', async (req, res) => {
  try {
    const result = await db.query(
      "DELETE FROM finance_transactions WHERE id = $1 AND source = 'manual'",
      [req.params.id],
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Movimiento no encontrado o no eliminable' });
    }
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting finance transaction:', error);
    res.status(500).json({ error: 'Error al eliminar movimiento' });
  }
});

router.get('/fixed-expenses', async (_req, res) => {
  try {
    const result = await db.query(`${FIXED_EXPENSE_SELECT} ORDER BY expense.created_at DESC`);
    res.json(result.rows.map(mapFixedExpense));
  } catch (error) {
    console.error('Error fetching fixed expenses:', error);
    res.status(500).json({ error: 'Error al obtener gastos fijos' });
  }
});

router.post('/fixed-expenses', async (req, res) => {
  try {
    const e = req.body;
    if (!e?.name || Number(e.amount) <= 0 || Number(e.dueDay) < 1 || Number(e.dueDay) > 31) {
      return res.status(400).json({ error: 'Datos inválidos de gasto fijo' });
    }
    const schedule = parseFixedExpenseSchedule(e, true);
    if (schedule.error) {
      return res.status(400).json({ error: schedule.error });
    }
    const responsibleParsed = parseResponsibleName(e.responsibleName);
    if (responsibleParsed === undefined) {
      return res.status(400).json({ error: 'Responsable inválido' });
    }
    const responsibleName = responsibleParsed || null;
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO finance_fixed_expenses
        (id, name, amount, due_day, frequency, anchor_month, notes, responsible_name, active, has_certificate)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        id,
        String(e.name).trim(),
        Number(e.amount),
        Number(e.dueDay),
        schedule.frequency,
        schedule.anchorMonth,
        e.notes ?? null,
        responsibleName,
        e.active === false ? 0 : 1,
        e.hasCertificate ? 1 : 0,
      ],
    );
    const created = await db.query(`${FIXED_EXPENSE_SELECT} WHERE expense.id = $1`, [id]);
    res.status(201).json(mapFixedExpense(created.rows[0]));
  } catch (error) {
    console.error('Error creating fixed expense:', error);
    res.status(500).json({ error: 'Error al crear gasto fijo' });
  }
});

router.put('/fixed-expenses/:id', async (req, res) => {
  try {
    const e = req.body;
    let responsibleNameArg = null;
    if (e.responsibleName !== undefined) {
      const parsed = parseResponsibleName(e.responsibleName);
      if (parsed === undefined) {
        return res.status(400).json({ error: 'Responsable inválido' });
      }
      responsibleNameArg = parsed;
    }
    const schedule = parseFixedExpenseSchedule(e, false);
    if (schedule?.error) {
      return res.status(400).json({ error: schedule.error });
    }
    const result = await db.query(
      `UPDATE finance_fixed_expenses SET
         name = COALESCE($1, name),
         amount = COALESCE($2, amount),
         due_day = COALESCE($3, due_day),
         notes = COALESCE($4, notes),
         responsible_name = CASE
           WHEN $5::text IS NULL THEN responsible_name
           ELSE NULLIF(BTRIM($5), '')
         END,
         active = COALESCE($6, active),
         frequency = COALESCE($8, frequency),
         anchor_month = CASE
           WHEN $8::text = 'monthly' THEN NULL
           WHEN $8::text IS NOT NULL THEN $9
           ELSE anchor_month
         END,
         has_certificate = COALESCE($10, has_certificate),
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $7`,
      [
        e.name ?? null,
        e.amount ?? null,
        e.dueDay ?? null,
        e.notes ?? null,
        responsibleNameArg,
        e.active == null ? null : e.active ? 1 : 0,
        req.params.id,
        schedule?.frequency ?? null,
        schedule?.anchorMonth ?? null,
        e.hasCertificate == null ? null : e.hasCertificate ? 1 : 0,
      ],
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Gasto fijo no encontrado' });
    const updated = await db.query(`${FIXED_EXPENSE_SELECT} WHERE expense.id = $1`, [req.params.id]);
    res.json(mapFixedExpense(updated.rows[0]));
  } catch (error) {
    console.error('Error updating fixed expense:', error);
    res.status(500).json({ error: 'Error al actualizar gasto fijo' });
  }
});

router.delete('/fixed-expenses/:id', async (req, res) => {
  try {
    const payments = await db.query(
      'SELECT receipt_file, certificate_file FROM finance_fixed_expense_payments WHERE fixed_expense_id = $1',
      [req.params.id],
    );
    const certificates = await db.query(
      'SELECT file FROM finance_fixed_expense_certificates WHERE fixed_expense_id = $1',
      [req.params.id],
    );
    const result = await db.query('DELETE FROM finance_fixed_expenses WHERE id = $1', [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Gasto fijo no encontrado' });
    for (const row of payments.rows) {
      removeReceiptFile(row.receipt_file);
      removeReceiptFile(row.certificate_file);
    }
    for (const row of certificates.rows) {
      removeReceiptFile(row.file);
    }
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting fixed expense:', error);
    res.status(500).json({ error: 'Error al eliminar gasto fijo' });
  }
});

router.get('/fixed-expenses/:id/certificates', async (req, res) => {
  try {
    const expense = await db.query(
      'SELECT id FROM finance_fixed_expenses WHERE id = $1',
      [req.params.id],
    );
    if (expense.rowCount === 0) {
      return res.status(404).json({ error: 'Gasto fijo no encontrado' });
    }
    const result = await db.query(
      `SELECT * FROM finance_fixed_expense_certificates
       WHERE fixed_expense_id = $1
       ORDER BY created_at DESC, id DESC`,
      [req.params.id],
    );
    res.json(result.rows.map(mapFixedExpenseCertificate));
  } catch (error) {
    console.error('Error fetching fixed expense certificates:', error);
    res.status(500).json({ error: 'Error al obtener los certificados' });
  }
});

router.get('/fixed-expense-certificates/:id/file', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT file FROM finance_fixed_expense_certificates WHERE id = $1',
      [req.params.id],
    );
    const fileName = result.rows[0]?.file;
    if (!fileName || !isCertificateFileName(fileName)) {
      return res.status(404).json({ error: 'No se encontró el certificado' });
    }
    const filePath = path.join(fixedExpenseReceiptsDir(), fileName);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'No se encontró el certificado' });
    }
    res.sendFile(filePath);
  } catch (error) {
    console.error('Error fetching fixed expense certificate:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Error al obtener el certificado' });
    }
  }
});

router.post('/fixed-expenses/:id/certificates', (req, res) => {
  certificateUpload.single('certificate')(req, res, async (err) => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? 'El archivo no puede superar 8 MB'
        : err.message || 'Archivo inválido';
      return res.status(400).json({ error: message });
    }
    const certificate = req.file;
    if (!certificate?.size) {
      return res.status(400).json({ error: 'Subí el certificado' });
    }

    let certificateFile = null;
    try {
      const expense = await db.query(
        'SELECT id, has_certificate FROM finance_fixed_expenses WHERE id = $1',
        [req.params.id],
      );
      if (expense.rowCount === 0) {
        return res.status(404).json({ error: 'Gasto fijo no encontrado' });
      }
      if (!expense.rows[0].has_certificate) {
        return res.status(400).json({ error: 'Este gasto no tiene certificado' });
      }

      const dir = ensureFixedExpenseReceiptsDir();
      certificateFile = `${newId()}.${certificateExtension(certificate.mimetype)}`;
      fs.writeFileSync(path.join(dir, certificateFile), certificate.buffer);

      const id = crypto.randomUUID();
      await db.query(
        `INSERT INTO finance_fixed_expense_certificates (id, fixed_expense_id, file)
         VALUES ($1, $2, $3)`,
        [id, req.params.id, certificateFile],
      );
      const created = await db.query(
        'SELECT * FROM finance_fixed_expense_certificates WHERE id = $1',
        [id],
      );
      res.status(201).json(mapFixedExpenseCertificate(created.rows[0]));
    } catch (error) {
      removeReceiptFile(certificateFile);
      console.error('Error uploading fixed expense certificate:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error al guardar el certificado' });
      }
    }
  });
});

router.get('/fixed-expense-payments', async (_req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM finance_fixed_expense_payments ORDER BY paid_date DESC',
    );
    res.json(result.rows.map(mapFixedExpensePayment));
  } catch (error) {
    console.error('Error fetching fixed expense payments:', error);
    res.status(500).json({ error: 'Error al obtener pagos de gastos fijos' });
  }
});

async function sendFixedExpensePaymentFile(req, res, column) {
  const label = column === 'certificate_file' ? 'certificado' : 'comprobante de pago';
  const result = await db.query(
    `SELECT ${column} FROM finance_fixed_expense_payments WHERE id = $1`,
    [req.params.id],
  );
  const fileName = result.rows[0]?.[column];
  if (!fileName || !isReceiptFileName(fileName)) {
    return res.status(404).json({ error: `No se encontró el ${label}` });
  }
  const filePath = path.join(fixedExpenseReceiptsDir(), fileName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: `No se encontró el ${label}` });
  }
  res.sendFile(filePath);
}

router.get('/fixed-expense-payments/:id/receipt', async (req, res) => {
  try {
    await sendFixedExpensePaymentFile(req, res, 'receipt_file');
  } catch (error) {
    console.error('Error fetching fixed expense receipt:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Error al obtener el comprobante de pago' });
    }
  }
});

router.get('/fixed-expense-payments/:id/certificate', async (req, res) => {
  try {
    await sendFixedExpensePaymentFile(req, res, 'certificate_file');
  } catch (error) {
    console.error('Error fetching fixed expense certificate:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Error al obtener el certificado' });
    }
  }
});

router.post('/fixed-expense-payments', (req, res) => {
  paymentFilesUpload(req, res, async (err) => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? 'El archivo no puede superar 8 MB'
        : err.message || 'Archivo inválido';
      return res.status(400).json({ error: message });
    }
    const receipt = req.files?.receipt?.[0];
    if (!receipt?.size) {
      return res.status(400).json({ error: 'Subí el comprobante de pago' });
    }

    let receiptFile = null;
    try {
      const p = req.body;
      if (!p?.fixedExpenseId || !p?.month || Number(p.amount) <= 0 || !p?.accountId) {
        return res.status(400).json({ error: 'Datos inválidos de pago' });
      }
      const accountId = normalizeAccountId(p.accountId);
      try {
        await assertLiquidityAccountExists(accountId);
      } catch (e) {
        if (e.statusCode === 400) return res.status(400).json({ error: e.message });
        throw e;
      }

      const expenseRes = await db.query(
        'SELECT id, name FROM finance_fixed_expenses WHERE id = $1',
        [p.fixedExpenseId],
      );
      const expense = expenseRes.rows[0];
      if (!expense) return res.status(404).json({ error: 'Gasto fijo no encontrado' });

      const dir = ensureFixedExpenseReceiptsDir();
      receiptFile = `${newId()}.${receiptExtension(receipt.mimetype)}`;
      fs.writeFileSync(path.join(dir, receiptFile), receipt.buffer);

      const client = await db.connect();
      const id = crypto.randomUUID();
      const txId = crypto.randomUUID();
      const paidDate = p.paidDate || new Date().toISOString();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO finance_fixed_expense_payments
          (id, fixed_expense_id, month, amount, account_id, paid_date, receipt_file)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            id,
            p.fixedExpenseId,
            p.month,
            Number(p.amount),
            accountId,
            paidDate,
            receiptFile,
          ],
        );
        await client.query(
          `INSERT INTO finance_transactions
          (id, account_id, type, amount, description, source, area, category, reference_id, date)
          VALUES ($1,$2,'expense',$3,$4,'fixed-expense',$5,$6,$7,$8)`,
          [
            txId,
            accountId,
            Number(p.amount),
            `${expense.name} — ${p.month}`,
            FINANCE_AREA_CATEGORY.fixedExpense.area,
            FINANCE_AREA_CATEGORY.fixedExpense.category,
            id,
          paidDate,
        ],
        );
        await syncFixedExpenseAmount(client, p.fixedExpenseId);
        await client.query('COMMIT');
        const created = await db.query(
          'SELECT * FROM finance_fixed_expense_payments WHERE id = $1',
          [id],
        );
        res.status(201).json(mapFixedExpensePayment(created.rows[0]));
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      removeReceiptFile(receiptFile);
      console.error('Error creating fixed expense payment:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error al registrar pago' });
      }
    }
  });
});

router.delete('/fixed-expense-payments/:id', async (req, res) => {
  const client = await db.connect();
  let receiptFile = null;
  let certificateFile = null;
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT fixed_expense_id, receipt_file, certificate_file FROM finance_fixed_expense_payments WHERE id = $1',
      [req.params.id],
    );
    receiptFile = existing.rows[0]?.receipt_file || null;
    certificateFile = existing.rows[0]?.certificate_file || null;
    const expenseId = existing.rows[0]?.fixed_expense_id || null;
    await client.query(
      "DELETE FROM finance_transactions WHERE source = 'fixed-expense' AND reference_id = $1",
      [req.params.id],
    );
    const result = await client.query(
      'DELETE FROM finance_fixed_expense_payments WHERE id = $1',
      [req.params.id],
    );
    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pago no encontrado' });
    }
    if (expenseId) await syncFixedExpenseAmount(client, expenseId);
    await client.query('COMMIT');
    removeReceiptFile(receiptFile);
    removeReceiptFile(certificateFile);
    res.status(204).send();
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error deleting fixed expense payment:', error);
    res.status(500).json({ error: 'Error al eliminar pago' });
  } finally {
    client.release();
  }
});

router.get('/events-profitability', async (req, res) => {
  try {
    const { from, to, eventType } = req.query;
    const params = [];
    const where = ["r.type = 'one-off'"];
    let n = 1;

    if (from) {
      where.push(`r.date >= $${n++}::date`);
      params.push(from);
    }
    if (to) {
      where.push(`r.date <= $${n++}::date`);
      params.push(to);
    }
    if (eventType && eventType !== 'all') {
      where.push(`r.event_type = $${n++}`);
      params.push(eventType);
    }

    const result = await db.query(
      `
      SELECT
        r.id,
        r.activity_name,
        r.event_type,
        r.date,
        COALESCE(pay.rental_income, 0) AS rental_income,
        COALESCE(pay.ticket_income, 0) AS ticket_income,
        cr.id AS cash_register_id,
        COALESCE(buff.buffet_income, 0) AS buffet_income,
        COALESCE(buff.buffet_cost, 0) AS buffet_cost,
        COALESCE(exp.linked_expenses, 0) AS linked_expenses
      FROM agenda_rentals r
      LEFT JOIN (
        SELECT rental_id,
          SUM(CASE WHEN payment_type = 'rental' THEN amount ELSE 0 END) AS rental_income,
          SUM(CASE WHEN payment_type = 'tickets' THEN amount ELSE 0 END) AS ticket_income
        FROM agenda_payments
        GROUP BY rental_id
      ) pay ON pay.rental_id = r.id
      LEFT JOIN cash_registers cr ON cr.event_id = r.id
      LEFT JOIN (
        SELECT
          cr.id AS cash_register_id,
          CASE
            WHEN cr.status = 'closed'
              AND cr.closing_data IS NOT NULL
              AND NULLIF(TRIM(cr.closing_data->>'totalActual'), '') IS NOT NULL
            THEN (NULLIF(TRIM(cr.closing_data->>'totalActual'), ''))::numeric
            ELSE COALESCE(ob.sum_orders, 0)
          END AS buffet_income,
          COALESCE(ob.buffet_cost, 0) AS buffet_cost
        FROM cash_registers cr
        LEFT JOIN (
          SELECT o.cash_register_id,
            SUM(CASE WHEN o.status != 'cancelled' THEN o.total ELSE 0 END) AS sum_orders,
            SUM(
              CASE WHEN o.status != 'cancelled' THEN COALESCE(ic.items_cost, 0) ELSE 0 END
            ) AS buffet_cost
          FROM orders o
          LEFT JOIN (
            SELECT order_id, SUM(unit_cost * quantity) AS items_cost
            FROM order_items
            GROUP BY order_id
          ) ic ON ic.order_id = o.id
          GROUP BY o.cash_register_id
        ) ob ON ob.cash_register_id = cr.id
      ) buff ON buff.cash_register_id = cr.id
      LEFT JOIN (
        SELECT event_id, SUM(amount) AS linked_expenses
        FROM finance_transactions
        WHERE type = 'expense' AND event_id IS NOT NULL
        GROUP BY event_id
      ) exp ON exp.event_id = r.id
      WHERE ${where.join(' AND ')}
      ORDER BY r.date DESC
      `,
      params,
    );

    const toYmd = (v) => {
      if (v == null) return undefined;
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      const s = String(v);
      return s.includes('T') ? s.slice(0, 10) : s.slice(0, 10);
    };

    res.json(
      result.rows.map((row) => {
        const buffetCost = Number(row.buffet_cost);
        const linkedExpenses = Number(row.linked_expenses);
        return {
          id: row.id,
          name: row.activity_name,
          eventType: row.event_type,
          date: toYmd(row.date),
          rentalIncome: Number(row.rental_income),
          buffetIncome: Number(row.buffet_income),
          ticketIncome: Number(row.ticket_income),
          buffetCost,
          linkedExpenses,
          totalCost: buffetCost + linkedExpenses,
          cashRegisterId: row.cash_register_id || undefined,
        };
      }),
    );
  } catch (error) {
    console.error('Error fetching event profitability:', error);
    res.status(500).json({ error: 'Error al obtener reporte de eventos' });
  }
});

function parseJsonArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function getSlotHours(slot) {
  if (!slot?.startTime || !slot?.endTime) return 0;
  const [sh, sm] = String(slot.startTime).split(':').map(Number);
  const [eh, em] = String(slot.endTime).split(':').map(Number);
  if (![sh, sm, eh, em].every(Number.isFinite)) return 0;
  return Math.max(0, eh + em / 60 - (sh + sm / 60));
}

router.get('/workshops-analysis', async (req, res) => {
  try {
    const { from, to } = req.query;
    const params = [];
    const where = [
      "r.type IN ('recurring', 'seminar')",
      "COALESCE(ap.payment_type, 'rental') = 'rental'",
    ];
    let n = 1;

    if (from) {
      where.push(`ap.paid_date::date >= $${n++}::date`);
      params.push(from);
    }
    if (to) {
      where.push(`ap.paid_date::date <= $${n++}::date`);
      params.push(to);
    }

    const result = await db.query(
      `
      SELECT
        ap.amount,
        r.type AS rental_type,
        r.room_id,
        rm.name AS room_name,
        r.schedules,
        r.date_slots
      FROM agenda_payments ap
      JOIN agenda_rentals r ON r.id = ap.rental_id
      LEFT JOIN agenda_rooms rm ON rm.id = r.room_id
      WHERE ${where.join(' AND ')}
      `,
      params,
    );

    const roomMap = new Map();
    const dayMap = new Map();
    [1, 2, 3, 4, 5, 6, 0].forEach((d) => dayMap.set(d, 0));
    let totalIncome = 0;

    for (const row of result.rows) {
      const amount = Number(row.amount) || 0;
      if (amount <= 0) continue;
      totalIncome += amount;

      const roomId = row.room_id || 'sin-sala';
      const roomName = row.room_name || 'Sin sala';
      roomMap.set(
        roomId,
        (roomMap.get(roomId) || { roomId, name: roomName, amount: 0 }),
      );
      roomMap.get(roomId).amount += amount;

      if (row.rental_type === 'recurring') {
        const schedules = parseJsonArray(row.schedules);
        const totalHours = schedules.reduce((s, slot) => s + getSlotHours(slot), 0);
        if (totalHours <= 0) continue;
        for (const slot of schedules) {
          const dow = Number(slot.dayOfWeek);
          if (!dayMap.has(dow)) continue;
          const slotHours = getSlotHours(slot);
          const portion = slotHours / totalHours;
          dayMap.set(dow, (dayMap.get(dow) || 0) + amount * portion);
        }
      } else if (row.rental_type === 'seminar') {
        const dateSlots = parseJsonArray(row.date_slots);
        const totalHours = dateSlots.reduce((s, slot) => s + getSlotHours(slot), 0);
        if (totalHours <= 0) continue;
        for (const slot of dateSlots) {
          const dateStr = String(slot.date || '').slice(0, 10);
          if (!dateStr) continue;
          const d = new Date(`${dateStr}T12:00:00`);
          if (Number.isNaN(d.getTime())) continue;
          const dow = d.getDay();
          if (!dayMap.has(dow)) continue;
          const slotHours = getSlotHours(slot);
          const portion = slotHours / totalHours;
          dayMap.set(dow, (dayMap.get(dow) || 0) + amount * portion);
        }
      }
    }

    const byRoom = Array.from(roomMap.values())
      .map((r) => ({ roomId: r.roomId, name: r.name, amount: Number(r.amount) }))
      .sort((a, b) => b.amount - a.amount);
    const byDay = [1, 2, 3, 4, 5, 6, 0].map((dayOfWeek) => ({
      dayOfWeek,
      amount: Math.round(Number(dayMap.get(dayOfWeek) || 0)),
    }));

    res.json({
      totalIncome: Number(totalIncome),
      byRoom,
      byDay,
    });
  } catch (error) {
    console.error('Error fetching workshops analysis:', error);
    res.status(500).json({ error: 'Error al obtener reporte de talleres' });
  }
});

/** yyyy-MM in [startMonth, endMonth] (lexicographic ok for calendar months) */
function rentalActiveInMonth(startMonth, endMonth, month) {
  if (!startMonth || month < startMonth) return false;
  if (endMonth && month > endMonth) return false;
  return true;
}

router.get('/workshops-projection', async (req, res) => {
  try {
    const month = typeof req.query.month === 'string' ? req.query.month.trim() : '';
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'Parámetro month requerido (YYYY-MM)' });
    }

    const result = await db.query(
      `
      SELECT
        r.type AS rental_type,
        r.room_id,
        rm.name AS room_name,
        r.schedules,
        r.date_slots,
        r.price_per_hour,
        r.fixed_price,
        r.start_month,
        r.end_month
      FROM agenda_rentals r
      LEFT JOIN agenda_rooms rm ON rm.id = r.room_id
      WHERE r.type IN ('recurring', 'seminar')
      `,
    );

    const roomMap = new Map();
    const dayMap = new Map();
    [1, 2, 3, 4, 5, 6, 0].forEach((d) => dayMap.set(d, 0));
    let totalIncome = 0;

    const addAmount = (roomId, roomName, dayOfWeek, amount) => {
      const a = Math.round(Number(amount)) || 0;
      if (a <= 0) return;
      totalIncome += a;
      roomMap.set(
        roomId,
        roomMap.get(roomId) || { roomId, name: roomName, amount: 0 },
      );
      roomMap.get(roomId).amount += a;
      if (dayMap.has(dayOfWeek)) {
        dayMap.set(dayOfWeek, (dayMap.get(dayOfWeek) || 0) + a);
      }
    };

    for (const row of result.rows) {
      const roomId = row.room_id || 'sin-sala';
      const roomName = row.room_name || 'Sin sala';
      const pricePerHour = Number(row.price_per_hour) || 0;
      const fixedPrice = Number(row.fixed_price) || 0;

      if (row.rental_type === 'recurring') {
        if (!rentalActiveInMonth(row.start_month, row.end_month, month)) continue;
        if (!pricePerHour) continue;
        const schedules = parseJsonArray(row.schedules);
        for (const slot of schedules) {
          const hours = getSlotHours(slot);
          if (hours <= 0) continue;
          const slotAmount = Math.round(hours * 4 * pricePerHour);
          const dow = Number(slot.dayOfWeek);
          if (!Number.isFinite(dow)) continue;
          addAmount(roomId, roomName, dow, slotAmount);
        }
      } else if (row.rental_type === 'seminar') {
        const dateSlots = parseJsonArray(row.date_slots);
        if (dateSlots.length === 0) continue;
        const inMonth = dateSlots.filter((slot) => {
          const dateStr = String(slot.date || '').slice(0, 10);
          return dateStr.length >= 7 && dateStr.slice(0, 7) === month;
        });
        if (inMonth.length === 0) continue;

        const totalSessions = dateSlots.length;

        if (fixedPrice > 0 && totalSessions > 0) {
          const perSession = fixedPrice / totalSessions;
          for (const slot of inMonth) {
            const dateStr = String(slot.date || '').slice(0, 10);
            const d = new Date(`${dateStr}T12:00:00`);
            if (Number.isNaN(d.getTime())) continue;
            const dow = d.getDay();
            addAmount(roomId, roomName, dow, perSession);
          }
        } else {
          if (!pricePerHour) continue;
          for (const slot of inMonth) {
            const hours = getSlotHours(slot);
            if (hours <= 0) continue;
            const dateStr = String(slot.date || '').slice(0, 10);
            const d = new Date(`${dateStr}T12:00:00`);
            if (Number.isNaN(d.getTime())) continue;
            const dow = d.getDay();
            addAmount(roomId, roomName, dow, Math.round(hours * pricePerHour));
          }
        }
      }
    }

    const byRoom = Array.from(roomMap.values())
      .map((r) => ({ roomId: r.roomId, name: r.name, amount: Math.round(Number(r.amount)) }))
      .sort((a, b) => b.amount - a.amount);
    const byDay = [1, 2, 3, 4, 5, 6, 0].map((dayOfWeek) => ({
      dayOfWeek,
      amount: Math.round(Number(dayMap.get(dayOfWeek) || 0)),
    }));

    res.json({
      totalIncome: Math.round(totalIncome),
      byRoom,
      byDay,
    });
  } catch (error) {
    console.error('Error fetching workshops projection:', error);
    res.status(500).json({ error: 'Error al obtener proyección de talleres' });
  }
});

export default router;
