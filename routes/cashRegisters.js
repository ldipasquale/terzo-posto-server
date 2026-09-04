import express from "express";
import db from "../database.js";
import crypto from "crypto";
import { FINANCE_AREA_CATEGORY } from "../lib/financeAreas.js";
import {
  allocateCupsAcrossAmounts,
  getBuffetCloseSplitForCashRegister,
  splitAmountByFoodDrinkCups,
} from "../lib/foodDrinkSplit.js";
import { normalizeOpeningChecklistRecord } from "../lib/openingChecklist.js";

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
  eventName,
  eventId = null,
) {
  const payments = Array.isArray(closingData?.payments)
    ? closingData.payments
    : [];
  const labelPrefix = eventName ? `Cierre de caja — ${eventName}` : "Cierre de caja";
  const closedAt = new Date().toISOString();
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
    if (!Number.isFinite(amount) || amount <= 0) return;
    await client.query(
      `INSERT INTO finance_transactions
      (id, account_id, type, amount, description, source, area, category, reference_id, event_id, date)
      VALUES ($1, $2, 'income', $3, $4, 'buffet', $5, $6, $7, $8, $9)`,
      [
        crypto.randomUUID(),
        accountId,
        amount,
        description,
        areaCat.area,
        areaCat.category,
        referenceId,
        eventId,
        closedAt,
      ],
    );
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
      description: `${labelPrefix} — ${payLabel} (comida)`,
      areaCat: FINANCE_AREA_CATEGORY.buffetFoodIncome,
      referenceId: `${baseRef}:comida`,
    });
    await insertPart({
      accountId,
      amount: drinkAmount,
      description: `${labelPrefix} — ${payLabel} (bebida)`,
      areaCat: FINANCE_AREA_CATEGORY.buffetDrinkIncome,
      referenceId: `${baseRef}:bebida`,
    });
    await insertPart({
      accountId,
      amount: cupsAmount,
      description: `${labelPrefix} — ${payLabel} (vasos)`,
      areaCat: FINANCE_AREA_CATEGORY.buffetCupsIncome,
      referenceId: `${baseRef}:vasos`,
    });
  }
}

function formatCashRegister(row) {
  return {
    id: row.id,
    date: row.date,
    mercadoPagoAccountId: row.mercado_pago_account_id,
    eventId: row.event_id || undefined,
    eventName: row.event_name || undefined,
    startingCash: row.starting_cash != null ? Number(row.starting_cash) : undefined,
    mpStartingBalance:
      row.mp_starting_balance != null && Number.isFinite(Number(row.mp_starting_balance))
        ? Number(row.mp_starting_balance)
        : undefined,
    status: row.status,
    closedAt: row.closed_at ? new Date(row.closed_at).toISOString() : undefined,
    closingData: row.closing_data || undefined,
    openingChecklist:
      row.opening_checklist &&
      typeof row.opening_checklist === "object" &&
      Array.isArray(row.opening_checklist.items)
        ? row.opening_checklist
        : undefined,
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
      eventId,
      eventName,
      startingCash,
      mpStartingBalance,
      openingChecklist,
    } = req.body;
    if (!mercadoPagoAccountId) {
      return res.status(400).json({ error: "Cuenta de Mercado Pago es requerida" });
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

    let mpStartingBalanceDb = null;
    if (mpStartingBalance != null && mpStartingBalance !== "") {
      const n = Number(mpStartingBalance);
      if (!Number.isFinite(n) || n < 0) {
        return res.status(400).json({
          error: "mpStartingBalance debe ser un número mayor o igual a 0",
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
    const now = new Date();
    const date = now.toISOString().split("T")[0];

    await db.query(
      `INSERT INTO cash_registers (id, date, mercado_pago_account_id, event_id, event_name, starting_cash, mp_starting_balance, status, opening_checklist)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8)`,
      [
        id,
        date,
        mercadoPagoAccountId,
        eventId || null,
        eventName || null,
        startingCash ?? null,
        mpStartingBalanceDb,
        normalizedChecklist.record
          ? JSON.stringify(normalizedChecklist.record)
          : null,
      ]
    );

    const result = await db.query("SELECT * FROM cash_registers WHERE id = $1", [id]);
    res.status(201).json(formatCashRegister(result.rows[0]));
  } catch (error) {
    console.error("Error opening cash register:", error);
    res.status(500).json({ error: "Error al abrir la caja" });
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
    res.json(formatCashRegister(row));
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
      "SELECT id, status, event_name, event_id FROM cash_registers WHERE id = $1",
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
      const mergedClosingData = {
        ...closingData,
        cupsSummary,
      };
      await insertBuffetCloseTransactions(
        client,
        id,
        mergedClosingData,
        caja.event_name,
        caja.event_id || null,
      );
      await client.query(
        `UPDATE cash_registers SET status = 'closed', closed_at = $1, closing_data = $2 WHERE id = $3`,
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

export default router;
