import express from "express";
import db from "../database.js";
import crypto from "crypto";
import { FINANCE_AREA_CATEGORY } from "../lib/financeAreas.js";
import {
  allocateCupsAcrossAmounts,
  getBuffetCloseSplitForCashRegister,
  splitAmountByFoodDrinkCups,
} from "../lib/foodDrinkSplit.js";
import {
  isOpeningChecklistComplete,
  normalizeOpeningChecklistRecord,
} from "../lib/openingChecklist.js";
import { fulfillTicketMenuOrdersForCaja } from "../lib/ticketMenu.js";
import {
  allocateCashRegister,
  argentinaDateKey,
  incomeShares,
  splitMoney,
} from "../lib/eventWindowAllocation.js";
import { listCashRegisterShifts, replaceCashRegisterShifts } from "./employees.js";

const router = express.Router();

async function assertMercadoPagoLiquidityAccount(client, mercadoPagoAccountId) {
  const mp = await client.query(
    "SELECT id FROM mercado_pago_accounts WHERE id = $1 AND id != 'efectivo'",
    [mercadoPagoAccountId],
  );
  if (!mp.rows[0]) {
    const err = new Error("Cuenta de Mercado Pago no encontrada");
    err.statusCode = 400;
    throw err;
  }
}

/**
 * Agregados de vasos retornables para una caja (cup_movements).
 * Si la tabla no existe aún, devuelve ceros.
 */
async function getCupSummaryForCashRegister(client, cashRegisterId) {
  try {
    const r = await client.query(
      `SELECT
        COALESCE(SUM(CASE WHEN type = 'delivery' THEN quantity ELSE 0 END), 0)::int AS delivered,
        COALESCE(SUM(CASE WHEN type = 'return' THEN quantity ELSE 0 END), 0)::int AS returned,
        COALESCE(SUM(CASE WHEN type = 'delivery' THEN amount ELSE 0 END), 0)::float AS delivery_amount,
        COALESCE(SUM(CASE WHEN type = 'return' THEN amount ELSE 0 END), 0)::float AS return_amount
       FROM cup_movements WHERE cash_register_id = $1`,
      [cashRegisterId],
    );
    const row = r.rows[0];
    const delivered = Number(row.delivered) || 0;
    const returned = Number(row.returned) || 0;
    return {
      delivered,
      returned,
      netNotReturned: Math.max(0, delivered - returned),
      deliveryAmountTotal: Number(row.delivery_amount) || 0,
      returnAmountTotal: Number(row.return_amount) || 0,
    };
  } catch {
    return {
      delivered: 0,
      returned: 0,
      netNotReturned: 0,
      deliveryAmountTotal: 0,
      returnAmountTotal: 0,
    };
  }
}

/**
 * Ingresos del cierre: por cada medio de pago, tres movimientos (comida/bebida/vasos).
 * Vasos = neto fijo (fuera del %); el resto se reparte comida/bebida según comandas.
 * reference_id: caja-close:<id>:efectivo|mp:<mpId>:comida|bebida|vasos
 */
async function insertBuffetCloseTransactions(
  client,
  cashRegisterId,
  closingData,
  shares,
) {
  const payments = Array.isArray(closingData?.payments)
    ? closingData.payments
    : [];
  const closedAt = new Date().toISOString();
  const eventShares = shares.length > 0 ? shares : [{ eventId: null, eventName: "", share: 1 }];
  const { food, drink, cups } = await getBuffetCloseSplitForCashRegister(
    client,
    cashRegisterId,
  );

  const insertPart = async ({
    accountId,
    amount,
    description,
    areaCat,
    referenceId,
  }) => {
    const pieces = splitMoney(amount, eventShares);
    for (const piece of pieces) {
      const label = piece.eventName
        ? `Cierre de caja — ${piece.eventName}`
        : "Cierre de caja";
      await client.query(
        `INSERT INTO finance_transactions
        (id, account_id, type, amount, description, source, area, category, reference_id, event_id, date)
        VALUES ($1, $2, 'income', $3, $4, 'buffet', $5, $6, $7, $8, $9)`,
        [
          crypto.randomUUID(),
          accountId,
          piece.amount,
          `${label} — ${description}`,
          areaCat.area,
          areaCat.category,
          `${referenceId}:${piece.eventId || "dia"}`,
          piece.eventId,
          closedAt,
        ],
      );
    }
  };

  /** @type {Array<{ amount: number, accountId: string, paymentRef: string, payLabel: string }>} */
  const eligible = [];
  for (const p of payments) {
    const amount = Number(p.actual);
    if (!Number.isFinite(amount) || amount <= 0) continue;

    const method = p.method;
    let accountId;
    let paymentRef;
    let payLabel;

    if (method === "efectivo") {
      accountId = "efectivo";
      paymentRef = "efectivo";
      payLabel = p.label || "Efectivo";
    } else if (method && typeof method === "string") {
      await assertMercadoPagoLiquidityAccount(client, method);
      accountId = method;
      paymentRef = `mp:${method}`;
      payLabel = p.label || "Mercado Pago";
    } else {
      continue;
    }

    eligible.push({ amount, accountId, paymentRef, payLabel });
  }

  const cupsShares = allocateCupsAcrossAmounts(
    eligible.map((e) => e.amount),
    cups,
  );

  for (let i = 0; i < eligible.length; i++) {
    const { amount, accountId, paymentRef, payLabel } = eligible[i];
    const { foodAmount, drinkAmount, cupsAmount } = splitAmountByFoodDrinkCups(
      amount,
      food,
      drink,
      cupsShares[i],
    );
    const baseRef = `caja-close:${cashRegisterId}:${paymentRef}`;

    await insertPart({
      accountId,
      amount: foodAmount,
      description: `${payLabel} (comida)`,
      areaCat: FINANCE_AREA_CATEGORY.buffetFoodIncome,
      referenceId: `${baseRef}:comida`,
    });
    await insertPart({
      accountId,
      amount: drinkAmount,
      description: `${payLabel} (bebida)`,
      areaCat: FINANCE_AREA_CATEGORY.buffetDrinkIncome,
      referenceId: `${baseRef}:bebida`,
    });
    await insertPart({
      accountId,
      amount: cupsAmount,
      description: `${payLabel} (vasos)`,
      areaCat: FINANCE_AREA_CATEGORY.buffetCupsIncome,
      referenceId: `${baseRef}:vasos`,
    });
  }
}

function formatOpeningChecklist(raw) {
  const normalized = normalizeOpeningChecklistRecord(raw ?? null);
  return normalized.record ?? undefined;
}

function parseMpOpeningBalances(raw, activeIds, selectedAccountId) {
  if (!Array.isArray(raw)) {
    return { error: "Hay que cargar el saldo inicial de cada cuenta de Mercado Pago" };
  }
  if (activeIds.length === 0) {
    return { error: "No hay cuentas de Mercado Pago activas" };
  }
  const byId = new Map();
  for (const item of raw) {
    const accountId = item?.accountId;
    const startingBalance = Number(item?.startingBalance);
    if (typeof accountId !== "string" || !accountId) {
      return { error: "Hay que cargar el saldo inicial de cada cuenta de Mercado Pago" };
    }
    if (byId.has(accountId)) {
      return { error: "Hay una cuenta de Mercado Pago repetida" };
    }
    if (!Number.isFinite(startingBalance) || startingBalance < 0) {
      return { error: "El saldo inicial tiene que ser un número mayor o igual a 0" };
    }
    byId.set(accountId, startingBalance);
  }
  const missing = activeIds.filter((id) => !byId.has(id));
  const extra = [...byId.keys()].filter((id) => !activeIds.includes(id));
  if (missing.length > 0 || extra.length > 0) {
    return { error: "Hay que cargar el saldo inicial de cada cuenta activa" };
  }
  if (!byId.has(selectedAccountId)) {
    return { error: "Elegí la cuenta de Mercado Pago del día" };
  }
  return {
    balances: activeIds.map((accountId) => ({
      accountId,
      startingBalance: byId.get(accountId),
    })),
    selectedBalance: byId.get(selectedAccountId),
  };
}

function formatMpOpeningBalances(raw) {
  if (!Array.isArray(raw)) return undefined;
  const balances = raw.flatMap((item) => {
    const startingBalance = Number(item?.startingBalance);
    if (typeof item?.accountId !== "string" || !Number.isFinite(startingBalance)) {
      return [];
    }
    return [{ accountId: item.accountId, startingBalance }];
  });
  return balances.length > 0 ? balances : undefined;
}

function formatDayEvents(raw) {
  if (!Array.isArray(raw)) return undefined;
  const events = raw.flatMap((item) => {
    if (!item || typeof item.id !== "string" || !item.id) return [];
    const name = String(item.name ?? "").trim();
    if (!name) return [];
    return [{
      id: item.id,
      name,
      startTime: item.startTime || undefined,
      endTime: item.endTime || undefined,
    }];
  });
  return events.length > 0 ? events : undefined;
}

function formatCashRegister(row) {
  return {
    id: row.id,
    date: row.date,
    mercadoPagoAccountId: row.mercado_pago_account_id,
    eventId: row.event_id || undefined,
    eventName: row.event_name || undefined,
    dayEvents: formatDayEvents(row.day_events),
    startingCash: row.starting_cash != null ? Number(row.starting_cash) : undefined,
    mpStartingBalance:
      row.mp_starting_balance != null && Number.isFinite(Number(row.mp_starting_balance))
        ? Number(row.mp_starting_balance)
        : undefined,
    mpOpeningBalances: formatMpOpeningBalances(row.mp_opening_balances),
    status: row.status,
    closedAt: row.closed_at ? new Date(row.closed_at).toISOString() : undefined,
    closingData: row.closing_data || undefined,
    openingChecklist: formatOpeningChecklist(row.opening_checklist),
    kitchenOpen: Boolean(Number(row.kitchen_open)),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

// GET /api/cash-registers — list with optional dateFrom, dateTo
// Incluye cajas abiertas en el rango (created_at) o cerradas en el rango (closed_at),
// para que el historial / gráficos vean cierres aunque se hubieran abierto antes.
router.get("/", async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    const whereClauses = [];
    const params = [];
    let n = 1;
    if (dateFrom && dateTo) {
      whereClauses.push(`(
        (created_at >= $${n}::timestamp AND created_at < ($${n + 1}::timestamp::date + interval '1 day'))
        OR
        (closed_at IS NOT NULL AND closed_at >= $${n}::timestamp AND closed_at < ($${n + 1}::timestamp::date + interval '1 day'))
      )`);
      params.push(dateFrom, dateTo);
      n += 2;
    } else {
      if (dateFrom) {
        whereClauses.push(`created_at >= $${n++}::timestamp`);
        params.push(dateFrom);
      }
      if (dateTo) {
        whereClauses.push(`created_at < ($${n++}::timestamp::date + interval '1 day')`);
        params.push(dateTo);
      }
    }
    const where = whereClauses.length ? "WHERE " + whereClauses.join(" AND ") : "";
    const result = await db.query(
      `SELECT * FROM cash_registers ${where} ORDER BY created_at DESC`,
      params
    );
    res.json(result.rows.map(formatCashRegister));
  } catch (error) {
    console.error("Error fetching cash registers:", error);
    res.status(500).json({ error: "Error al obtener las cajas" });
  }
});

// GET /api/cash-registers/current — open cash register or null
router.get("/current", async (req, res) => {
  try {
    const result = await db.query(
      "SELECT * FROM cash_registers WHERE status = 'open' ORDER BY created_at DESC LIMIT 1"
    );
    const row = result.rows[0];
    if (!row) {
      return res.json(null);
    }
    res.json(formatCashRegister(row));
  } catch (error) {
    console.error("Error fetching current cash register:", error);
    res.status(500).json({ error: "Error al obtener la caja actual" });
  }
});

// POST /api/cash-registers — open a new cash register
router.post("/", async (req, res) => {
  try {
    const {
      mercadoPagoAccountId,
      startingCash,
      mpStartingBalance,
      mpOpeningBalances,
      openingChecklist,
    } = req.body;
    if (!mercadoPagoAccountId) {
      return res.status(400).json({ error: "Elegí la cuenta de Mercado Pago del día" });
    }
    if (mercadoPagoAccountId === "efectivo") {
      return res.status(400).json({
        error: "La caja debe asociarse a una cuenta de Mercado Pago (no efectivo)",
      });
    }

    const existing = await db.query(
      "SELECT id FROM cash_registers WHERE status = 'open' LIMIT 1"
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: "Ya hay una caja abierta" });
    }

    const cashNumber = Number(startingCash);
    if (startingCash == null || startingCash === "" || !Number.isFinite(cashNumber) || cashNumber < 0) {
      return res.status(400).json({
        error: "El cambio inicial es requerido",
      });
    }

    const activeAccounts = await db.query(
      `SELECT id FROM mercado_pago_accounts
       WHERE id != 'efectivo'
         AND COALESCE(kind, 'mercadopago') = 'mercadopago'
         AND active = 1
       ORDER BY holder, alias`,
    );
    const activeIds = activeAccounts.rows.map((row) => row.id);
    const parsedOpening = parseMpOpeningBalances(mpOpeningBalances, activeIds, mercadoPagoAccountId);
    if (parsedOpening.error) {
      return res.status(400).json({ error: parsedOpening.error });
    }

    let mpStartingBalanceDb = parsedOpening.selectedBalance;
    if (mpStartingBalance != null && mpStartingBalance !== "") {
      const n = Number(mpStartingBalance);
      if (!Number.isFinite(n) || n < 0 || Math.abs(n - parsedOpening.selectedBalance) > 0.001) {
        return res.status(400).json({
          error: "El saldo de la cuenta del día no coincide",
        });
      }
      mpStartingBalanceDb = n;
    }

    const normalizedChecklist = normalizeOpeningChecklistRecord(
      openingChecklist ?? null,
    );
    if (normalizedChecklist.error) {
      return res.status(400).json({ error: normalizedChecklist.error });
    }

    const id = crypto.randomUUID();
    const date = argentinaDateKey(new Date());
    const client = await db.connect();

    try {
      await client.query("BEGIN");
      const eventsResult = await client.query(
        `SELECT id, activity_name, start_time, end_time
         FROM agenda_rentals
         WHERE type = 'one-off' AND date = $1::date
         ORDER BY start_time NULLS LAST, activity_name`,
        [date],
      );
      if (eventsResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "No se puede abrir la caja: no hay eventos hoy",
        });
      }
      const dayEvents = eventsResult.rows.map((event) => ({
        id: event.id,
        name: event.activity_name,
        startTime: event.start_time || null,
        endTime: event.end_time || null,
      }));
      await client.query(
        `INSERT INTO cash_registers (id, date, mercado_pago_account_id, event_id, event_name, day_events, starting_cash, mp_starting_balance, mp_opening_balances, status, opening_checklist)
         VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, $8, 'open', $9)`,
        [
          id,
          date,
          mercadoPagoAccountId,
          dayEvents.map((event) => event.name).join(" · "),
          JSON.stringify(dayEvents),
          cashNumber,
          mpStartingBalanceDb,
          JSON.stringify(parsedOpening.balances),
          normalizedChecklist.record
            ? JSON.stringify(normalizedChecklist.record)
            : null,
        ]
      );
      for (const event of dayEvents) {
        await fulfillTicketMenuOrdersForCaja(client, id, event.id);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const result = await db.query("SELECT * FROM cash_registers WHERE id = $1", [id]);
    res.status(201).json(formatCashRegister(result.rows[0]));
  } catch (error) {
    console.error("Error opening cash register:", error);
    res.status(500).json({ error: "Error al abrir la caja" });
  }
});

// PATCH /api/cash-registers/:id/opening-checklist — completar checklist pendiente
router.patch("/:id/opening-checklist", async (req, res) => {
  try {
    const { id } = req.params;
    const normalizedChecklist = normalizeOpeningChecklistRecord(req.body ?? null);
    if (normalizedChecklist.error) {
      return res.status(400).json({ error: normalizedChecklist.error });
    }
    if (!isOpeningChecklistComplete(normalizedChecklist.record)) {
      return res.status(400).json({
        error: "Hay que completar el checklist de apertura",
      });
    }

    const check = await db.query(
      "SELECT id, status, opening_checklist FROM cash_registers WHERE id = $1",
      [id],
    );
    const caja = check.rows[0];
    if (!caja) {
      return res.status(404).json({ error: "Caja no encontrada" });
    }
    if (caja.status !== "open") {
      return res.status(400).json({ error: "La caja no está abierta" });
    }
    if (isOpeningChecklistComplete(caja.opening_checklist)) {
      return res.status(400).json({
        error: "Esta caja ya tiene un checklist de apertura",
      });
    }

    await db.query(
      "UPDATE cash_registers SET opening_checklist = $1 WHERE id = $2",
      [JSON.stringify(normalizedChecklist.record), id],
    );

    const result = await db.query("SELECT * FROM cash_registers WHERE id = $1", [
      id,
    ]);
    res.json(formatCashRegister(result.rows[0]));
  } catch (error) {
    console.error("Error saving opening checklist:", error);
    res.status(500).json({ error: "Error al guardar el checklist de apertura" });
  }
});

// GET /api/cash-registers/:id
router.get("/:id", async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM cash_registers WHERE id = $1", [
      req.params.id,
    ]);
    const row = result.rows[0];
    if (!row) {
      return res.status(404).json({ error: "Caja no encontrada" });
    }
    const formatted = formatCashRegister(row);
    formatted.staff = await listCashRegisterShifts(db, req.params.id);
    res.json(formatted);
  } catch (error) {
    console.error("Error fetching cash register:", error);
    res.status(500).json({ error: "Error al obtener la caja" });
  }
});

// PATCH /api/cash-registers/:id/close — close with closing data
router.patch("/:id/close", async (req, res) => {
  try {
    const { id } = req.params;
    const closingData = req.body;
    if (!closingData || typeof closingData !== "object") {
      return res.status(400).json({ error: "Datos de cierre requeridos" });
    }

    const check = await db.query(
      `SELECT id, status, event_name, event_id, day_events, to_char(date, 'YYYY-MM-DD') AS date
       FROM cash_registers WHERE id = $1`,
      [id]
    );
    const caja = check.rows[0];
    if (!caja) {
      return res.status(404).json({ error: "Caja no encontrada" });
    }
    if (caja.status === "closed") {
      return res.status(400).json({ error: "La caja ya está cerrada" });
    }

    const now = new Date().toISOString();
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const cupsSummary = await getCupSummaryForCashRegister(client, id);
      const { staff, ...closingRest } = closingData;
      const dayEvents = Array.isArray(caja.day_events) ? caja.day_events : [];
      const events = dayEvents.length > 0
        ? dayEvents.map((event) => ({
            id: event.id,
            name: event.name,
            startTime: event.startTime,
            endTime: event.endTime,
          }))
        : caja.event_id
          ? [{ id: caja.event_id, name: caja.event_name || "Evento", startTime: null, endTime: null }]
          : [];
      const orders = await client.query(
        `SELECT o.status, o.total, o.created_at,
           COALESCE(ic.items_cost, 0) AS cost
         FROM orders o
         LEFT JOIN (
           SELECT order_id, SUM(unit_cost * quantity) AS items_cost
           FROM order_items
           GROUP BY order_id
         ) ic ON ic.order_id = o.id
         WHERE o.cash_register_id = $1`,
        [id],
      );
      const totalActual = Number(closingRest.totalActual);
      const eventAllocation = events.length
        ? allocateCashRegister({
            cajaDate: caja.date,
            events,
            orders: orders.rows.map((order) => ({
              status: order.status,
              total: Number(order.total) || 0,
              cost: Number(order.cost) || 0,
              createdAt: order.created_at,
            })),
            totalIncome: Number.isFinite(totalActual) ? totalActual : undefined,
          })
        : [];
      const mergedClosingData = {
        ...closingRest,
        cupsSummary,
        ...(eventAllocation.length > 0 ? { eventAllocation } : {}),
      };
      await insertBuffetCloseTransactions(
        client,
        id,
        mergedClosingData,
        incomeShares(eventAllocation),
      );
      await replaceCashRegisterShifts(client, id, caja.date, Array.isArray(staff) ? staff : []);
      await client.query(
        `UPDATE cash_registers
         SET status = 'closed', closed_at = $1, closing_data = $2, kitchen_open = 0
         WHERE id = $3`,
        [now, JSON.stringify(mergedClosingData), id]
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    const result = await db.query("SELECT * FROM cash_registers WHERE id = $1", [id]);
    res.json(formatCashRegister(result.rows[0]));
  } catch (error) {
    console.error("Error closing cash register:", error);
    if (error.statusCode === 400) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: "Error al cerrar la caja" });
  }
});

async function applyFoodAvailability(client, availableFoodItemIds) {
  if (!Array.isArray(availableFoodItemIds)) {
    const err = new Error("Seleccioná los platos disponibles");
    err.statusCode = 400;
    throw err;
  }
  const ids = [
    ...new Set(
      availableFoodItemIds
        .map((id) => (id == null ? "" : String(id).trim()))
        .filter(Boolean),
    ),
  ];

  if (ids.length > 0) {
    const found = await client.query(
      `SELECT id FROM menu_items
       WHERE id = ANY($1::text[]) AND type = 'comida' AND archived = 0
         AND requires_kitchen = 1`,
      [ids],
    );
    if (found.rows.length !== ids.length) {
      const err = new Error("Uno o más platos no existen o no son de cocina");
      err.statusCode = 400;
      throw err;
    }
  }

  await client.query(
    `UPDATE menu_items
     SET available = 0, updated_at = CURRENT_TIMESTAMP
     WHERE type = 'comida' AND archived = 0 AND requires_kitchen = 1`,
  );
  if (ids.length > 0) {
    await client.query(
      `UPDATE menu_items
       SET available = 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = ANY($1::text[])`,
      [ids],
    );
  }
}

// PATCH /api/cash-registers/:id/kitchen — abrir/cerrar cocina y menú de comida
router.patch("/:id/kitchen", async (req, res) => {
  try {
    const { id } = req.params;
    const { open, availableFoodItemIds } = req.body ?? {};
    if (typeof open !== "boolean") {
      return res.status(400).json({ error: "open debe ser true o false" });
    }

    const check = await db.query(
      "SELECT id, status FROM cash_registers WHERE id = $1",
      [id],
    );
    const caja = check.rows[0];
    if (!caja) {
      return res.status(404).json({ error: "Caja no encontrada" });
    }
    if (caja.status !== "open") {
      return res.status(400).json({ error: "La caja no está abierta" });
    }

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE cash_registers SET kitchen_open = $1 WHERE id = $2",
        [open ? 1 : 0, id],
      );
      if (open) {
        await applyFoodAvailability(client, availableFoodItemIds);
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    const result = await db.query("SELECT * FROM cash_registers WHERE id = $1", [
      id,
    ]);
    res.json(formatCashRegister(result.rows[0]));
  } catch (error) {
    console.error("Error updating kitchen:", error);
    if (error.statusCode === 400) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: "Error al actualizar la cocina" });
  }
});

export default router;
