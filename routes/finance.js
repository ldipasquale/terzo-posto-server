import crypto from 'crypto';
import express from 'express';
import db from '../database.js';

const router = express.Router();

const mapAccount = (row) => ({
  id: row.id,
  name: row.name,
  type: row.type,
  mercadoPagoAccountId: row.mercado_pago_account_id || undefined,
});

const mapTransaction = (row) => ({
  id: row.id,
  accountId: row.account_id,
  type: row.type,
  amount: Number(row.amount),
  description: row.description,
  source: row.source,
  category: row.category || undefined,
  referenceId: row.reference_id || undefined,
  date: new Date(row.date).toISOString(),
  createdAt: new Date(row.created_at).toISOString(),
});

const mapFixedExpense = (row) => ({
  id: row.id,
  name: row.name,
  amount: Number(row.amount),
  dueDay: Number(row.due_day),
  notes: row.notes || undefined,
  active: Boolean(row.active),
  createdAt: new Date(row.created_at).toISOString(),
});

const mapFixedExpensePayment = (row) => ({
  id: row.id,
  fixedExpenseId: row.fixed_expense_id,
  month: row.month,
  amount: Number(row.amount),
  accountId: row.account_id,
  paidDate: new Date(row.paid_date).toISOString(),
});

router.get('/accounts', async (_req, res) => {
  try {
    const result = await db.query('SELECT * FROM finance_accounts ORDER BY created_at ASC');
    res.json(result.rows.map(mapAccount));
  } catch (error) {
    console.error('Error fetching finance accounts:', error);
    res.status(500).json({ error: 'Error al obtener cuentas' });
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

router.post('/transactions', async (req, res) => {
  try {
    const t = req.body;
    if (!t?.accountId || !t?.type || Number(t.amount) <= 0 || !t?.description) {
      return res.status(400).json({ error: 'Datos inválidos de movimiento' });
    }
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO finance_transactions
       (id, account_id, type, amount, description, source, category, reference_id, date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id,
        t.accountId,
        t.type,
        Number(t.amount),
        String(t.description).trim(),
        t.source || 'manual',
        t.category ?? null,
        t.referenceId ?? null,
        t.date || new Date().toISOString(),
      ],
    );
    const created = await db.query('SELECT * FROM finance_transactions WHERE id = $1', [id]);
    res.status(201).json(mapTransaction(created.rows[0]));
  } catch (error) {
    console.error('Error creating finance transaction:', error);
    res.status(500).json({ error: 'Error al crear movimiento' });
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
    const result = await db.query('SELECT * FROM finance_fixed_expenses ORDER BY created_at DESC');
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
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO finance_fixed_expenses (id, name, amount, due_day, notes, active)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, String(e.name).trim(), Number(e.amount), Number(e.dueDay), e.notes ?? null, e.active === false ? 0 : 1],
    );
    const created = await db.query('SELECT * FROM finance_fixed_expenses WHERE id = $1', [id]);
    res.status(201).json(mapFixedExpense(created.rows[0]));
  } catch (error) {
    console.error('Error creating fixed expense:', error);
    res.status(500).json({ error: 'Error al crear gasto fijo' });
  }
});

router.put('/fixed-expenses/:id', async (req, res) => {
  try {
    const e = req.body;
    const result = await db.query(
      `UPDATE finance_fixed_expenses SET
         name = COALESCE($1, name),
         amount = COALESCE($2, amount),
         due_day = COALESCE($3, due_day),
         notes = COALESCE($4, notes),
         active = COALESCE($5, active),
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $6`,
      [
        e.name ?? null,
        e.amount ?? null,
        e.dueDay ?? null,
        e.notes ?? null,
        e.active == null ? null : e.active ? 1 : 0,
        req.params.id,
      ],
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Gasto fijo no encontrado' });
    const updated = await db.query('SELECT * FROM finance_fixed_expenses WHERE id = $1', [req.params.id]);
    res.json(mapFixedExpense(updated.rows[0]));
  } catch (error) {
    console.error('Error updating fixed expense:', error);
    res.status(500).json({ error: 'Error al actualizar gasto fijo' });
  }
});

router.delete('/fixed-expenses/:id', async (req, res) => {
  try {
    const result = await db.query('DELETE FROM finance_fixed_expenses WHERE id = $1', [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Gasto fijo no encontrado' });
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting fixed expense:', error);
    res.status(500).json({ error: 'Error al eliminar gasto fijo' });
  }
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

router.post('/fixed-expense-payments', async (req, res) => {
  const client = await db.connect();
  try {
    const p = req.body;
    if (!p?.fixedExpenseId || !p?.month || Number(p.amount) <= 0 || !p?.accountId) {
      return res.status(400).json({ error: 'Datos inválidos de pago' });
    }
    const expenseRes = await client.query(
      'SELECT id, name FROM finance_fixed_expenses WHERE id = $1',
      [p.fixedExpenseId],
    );
    const expense = expenseRes.rows[0];
    if (!expense) return res.status(404).json({ error: 'Gasto fijo no encontrado' });

    const id = crypto.randomUUID();
    const txId = crypto.randomUUID();
    const paidDate = p.paidDate || new Date().toISOString();
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO finance_fixed_expense_payments
      (id, fixed_expense_id, month, amount, account_id, paid_date)
      VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, p.fixedExpenseId, p.month, Number(p.amount), p.accountId, paidDate],
    );
    await client.query(
      `INSERT INTO finance_transactions
      (id, account_id, type, amount, description, source, category, reference_id, date)
      VALUES ($1,$2,'expense',$3,$4,'fixed-expense','gasto-fijo',$5,$6)`,
      [txId, p.accountId, Number(p.amount), `${expense.name} — ${p.month}`, id, paidDate],
    );
    await client.query('COMMIT');
    const created = await db.query(
      'SELECT * FROM finance_fixed_expense_payments WHERE id = $1',
      [id],
    );
    res.status(201).json(mapFixedExpensePayment(created.rows[0]));
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating fixed expense payment:', error);
    res.status(500).json({ error: 'Error al registrar pago' });
  } finally {
    client.release();
  }
});

router.delete('/fixed-expense-payments/:id', async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
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
    await client.query('COMMIT');
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
        COALESCE(SUM(CASE WHEN ap.payment_type = 'rental' THEN ap.amount ELSE 0 END), 0) AS rental_income,
        COALESCE(SUM(CASE WHEN ap.payment_type = 'tickets' THEN ap.amount ELSE 0 END), 0) AS ticket_income,
        COALESCE(cr.id, NULL) AS cash_register_id,
        COALESCE(SUM(CASE WHEN o.status != 'cancelled' THEN o.total ELSE 0 END), 0) AS buffet_income,
        COALESCE(SUM(CASE WHEN o.status != 'cancelled' THEN oi.unit_cost * oi.quantity ELSE 0 END), 0) AS buffet_cost
      FROM agenda_rentals r
      LEFT JOIN agenda_payments ap ON ap.rental_id = r.id
      LEFT JOIN cash_registers cr ON cr.event_id = r.id
      LEFT JOIN orders o ON o.cash_register_id = cr.id
      LEFT JOIN order_items oi ON oi.order_id = o.id
      WHERE ${where.join(' AND ')}
      GROUP BY r.id, r.activity_name, r.event_type, r.date, cr.id
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
      result.rows.map((row) => ({
        id: row.id,
        name: row.activity_name,
        eventType: row.event_type,
        date: toYmd(row.date),
        rentalIncome: Number(row.rental_income),
        buffetIncome: Number(row.buffet_income),
        ticketIncome: Number(row.ticket_income),
        buffetCost: Number(row.buffet_cost),
        cashRegisterId: row.cash_register_id || undefined,
      })),
    );
  } catch (error) {
    console.error('Error fetching event profitability:', error);
    res.status(500).json({ error: 'Error al obtener reporte de eventos' });
  }
});

export default router;
