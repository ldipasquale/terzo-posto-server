import express from "express";
import db from "../database.js";
import crypto from "crypto";

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
 * Una transacción de ingreso por cada medio de pago del cierre (monto = actual neto).
 */
async function insertBuffetCloseTransactions(client, cashRegisterId, closingData, eventName) {
  const payments = Array.isArray(closingData?.payments)
    ? closingData.payments
    : [];
  const labelPrefix = eventName ? `Cierre de caja — ${eventName}` : "Cierre de caja";
  const closedAt = new Date().toISOString();

  for (const p of payments) {
    const amount = Number(p.actual);
    if (!Number.isFinite(amount) || amount <= 0) continue;

    const method = p.method;
    if (method === "efectivo") {
      const txId = crypto.randomUUID();
      const desc = `${labelPrefix} — ${p.label || "Efectivo"}`;
      await client.query(
        `INSERT INTO finance_transactions
        (id, account_id, type, amount, description, source, category, reference_id, date)
        VALUES ($1, 'efectivo', 'income', $2, $3, 'buffet', 'buffet', $4, $5)`,
        [
          txId,
          amount,
          desc,
          `caja-close:${cashRegisterId}:efectivo`,
          closedAt,
        ]
      );
    } else if (method && typeof method === "string") {
      await assertMercadoPagoLiquidityAccount(client, method);
      const txId = crypto.randomUUID();
      const desc = `${labelPrefix} — ${p.label || "Mercado Pago"}`;
      await client.query(
        `INSERT INTO finance_transactions
        (id, account_id, type, amount, description, source, category, reference_id, date)
        VALUES ($1, $2, 'income', $3, $4, 'buffet', 'buffet', $5, $6)`,
        [
          txId,
          method,
          amount,
          desc,
          `caja-close:${cashRegisterId}:mp:${method}`,
          closedAt,
        ]
      );
    }
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
    status: row.status,
    closedAt: row.closed_at ? new Date(row.closed_at).toISOString() : undefined,
    closingData: row.closing_data || undefined,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

// GET /api/cash-registers — list with optional dateFrom, dateTo
router.get("/", async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    const whereClauses = [];
    const params = [];
    let n = 1;
    if (dateFrom) {
      whereClauses.push(`created_at >= $${n++}::timestamp`);
      params.push(dateFrom);
    }
    if (dateTo) {
      whereClauses.push(`created_at < ($${n++}::timestamp::date + interval '1 day')`);
      params.push(dateTo);
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
    const { mercadoPagoAccountId, eventId, eventName, startingCash } = req.body;
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

    const id = crypto.randomUUID();
    const now = new Date();
    const date = now.toISOString().split("T")[0];

    await db.query(
      `INSERT INTO cash_registers (id, date, mercado_pago_account_id, event_id, event_name, starting_cash, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'open')`,
      [id, date, mercadoPagoAccountId, eventId || null, eventName || null, startingCash ?? null]
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
      "SELECT id, status, event_name FROM cash_registers WHERE id = $1",
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
      await insertBuffetCloseTransactions(
        client,
        id,
        closingData,
        caja.event_name
      );
      await client.query(
        `UPDATE cash_registers SET status = 'closed', closed_at = $1, closing_data = $2 WHERE id = $3`,
        [now, JSON.stringify(closingData), id]
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
