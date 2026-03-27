import crypto from 'crypto';
import express from 'express';
import db from '../database.js';

const router = express.Router();

function mapLiquidityAccount(row) {
  const isCash = row.kind === 'cash' || row.id === 'efectivo';
  return {
    id: row.id,
    name: isCash ? 'Efectivo' : `${row.alias} (${row.holder})`,
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

router.post('/transactions', async (req, res) => {
  try {
    const t = req.body;
    if (!t?.accountId || !t?.type || Number(t.amount) <= 0 || !t?.description) {
      return res.status(400).json({ error: 'Datos inválidos de movimiento' });
    }
    const accountId = normalizeAccountId(t.accountId);
    await assertLiquidityAccountExists(accountId);
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO finance_transactions
       (id, account_id, type, amount, description, source, category, reference_id, date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id,
        accountId,
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
    if (error.statusCode === 400) {
      return res.status(400).json({ error: error.message });
    }
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

    const client = await db.connect();
    const id = crypto.randomUUID();
    const txId = crypto.randomUUID();
    const paidDate = p.paidDate || new Date().toISOString();
    try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO finance_fixed_expense_payments
      (id, fixed_expense_id, month, amount, account_id, paid_date)
      VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, p.fixedExpenseId, p.month, Number(p.amount), accountId, paidDate],
    );
    await client.query(
      `INSERT INTO finance_transactions
      (id, account_id, type, amount, description, source, category, reference_id, date)
      VALUES ($1,$2,'expense',$3,$4,'fixed-expense','gasto-fijo',$5,$6)`,
      [txId, accountId, Number(p.amount), `${expense.name} — ${p.month}`, id, paidDate],
    );
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
    console.error('Error creating fixed expense payment:', error);
    res.status(500).json({ error: 'Error al registrar pago' });
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

export default router;
