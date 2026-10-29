import crypto from "crypto";
import express from "express";
import db from "../database.js";
import { EXPENSE_CATEGORIES } from "../lib/financeAreas.js";

const router = express.Router();

const TASK_STATUSES = ["pending", "in_progress", "done"];
const FINANCE_CATEGORIES = EXPENSE_CATEGORIES.obra;

function parseTimestamp(value) {
  if (value == null || value === "") return new Date().toISOString();
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${text}T12:00:00.000-03:00`;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function parseItem(body) {
  const section = String(body?.section || "").trim();
  const name = String(body?.name || "").trim();
  if (!section || !name) return { error: "Rubro e ítem son obligatorios" };
  const quantity = Number(body?.quantity);
  const unitPrice = Number(body?.unitPrice);
  if (!Number.isFinite(quantity) || quantity < 0) {
    return { error: "Cantidad inválida" };
  }
  if (!Number.isFinite(unitPrice) || unitPrice < 0) {
    return { error: "Precio inválido" };
  }
  const financeCategory = String(body?.financeCategory || "");
  if (!FINANCE_CATEGORIES.includes(financeCategory)) {
    return { error: "Categoría inválida" };
  }
  return {
    section,
    name,
    detail: String(body?.detail || "").trim(),
    supplier: String(body?.supplier || "").trim(),
    quantity,
    unitPrice,
    deferred: Boolean(body?.deferred),
    note: String(body?.note || "").trim(),
    financeCategory,
  };
}

function parseOptionalPositiveInt(value) {
  if (value == null || value === "") return { value: null };
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) return { error: true };
  return { value: number };
}

function parseTask(body) {
  const title = String(body?.title || "").trim();
  if (!title) return { error: "El título es obligatorio" };
  const status = String(body?.status || "pending");
  if (!TASK_STATUSES.includes(status)) return { error: "Estado inválido" };

  const duration = parseOptionalPositiveInt(body?.durationDays);
  if (duration.error) return { error: "Duración inválida" };
  const weekStart = parseOptionalPositiveInt(body?.weekStart);
  if (weekStart.error) return { error: "Semana desde inválida" };
  const weekEnd = parseOptionalPositiveInt(body?.weekEnd);
  if (weekEnd.error) return { error: "Semana hasta inválida" };
  if ((weekStart.value == null) !== (weekEnd.value == null)) {
    return { error: "Completá la semana desde y hasta, o dejá las dos vacías" };
  }
  if (
    weekStart.value != null &&
    weekEnd.value != null &&
    weekEnd.value < weekStart.value
  ) {
    return { error: "La semana hasta no puede ser anterior a la desde" };
  }

  const taskNumber = parseOptionalPositiveInt(body?.taskNumber);
  if (taskNumber.error) return { error: "Número de tarea inválido" };

  return {
    title,
    assignee: String(body?.assignee || "").trim(),
    dependsOn: String(body?.dependsOn || "").trim(),
    durationDays: duration.value,
    weekStart: weekStart.value,
    weekEnd: weekEnd.value,
    status,
    note: String(body?.note || "").trim(),
    taskNumber: taskNumber.value,
  };
}

async function parsePurchase(client, body) {
  const amount = Number(body?.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { error: "El monto tiene que ser mayor a cero" };
  }
  const accountId = String(body?.accountId || "").trim();
  if (!accountId) return { error: "Elegí una cuenta" };
  const account = await client.query(
    "SELECT id FROM mercado_pago_accounts WHERE id = $1",
    [accountId],
  );
  if (!account.rows[0]) return { error: "Cuenta inválida" };

  const financeCategory = String(body?.financeCategory || "");
  if (!FINANCE_CATEGORIES.includes(financeCategory)) {
    return { error: "Categoría inválida" };
  }

  let budgetItemId = body?.budgetItemId ? String(body.budgetItemId) : null;
  let itemName = "";
  if (budgetItemId) {
    const item = await client.query(
      "SELECT id, name FROM obra_budget_items WHERE id = $1",
      [budgetItemId],
    );
    if (!item.rows[0]) return { error: "Ítem de presupuesto inválido" };
    itemName = item.rows[0].name;
  }

  const date = parseTimestamp(body?.date);
  if (!date) return { error: "Fecha inválida" };

  return {
    amount,
    accountId,
    financeCategory,
    budgetItemId,
    itemName,
    date,
    supplier: String(body?.supplier || "").trim(),
    note: String(body?.note || "").trim(),
  };
}

function purchaseDescription(purchase) {
  const head = purchase.itemName ? `Obra: ${purchase.itemName}` : "Obra";
  const tail = [purchase.supplier, purchase.note].filter(Boolean);
  return tail.length > 0 ? `${head} — ${tail.join(" — ")}` : head;
}

function mapProject(row) {
  return {
    id: row.id,
    name: row.name,
    startDate: row.start_date,
    endDate: row.end_date,
    notes: row.notes || "",
  };
}

function mapItem(row, spent) {
  const quantity = Number(row.quantity);
  const unitPrice = Number(row.unit_price);
  return {
    id: row.id,
    section: row.section,
    name: row.name,
    detail: row.detail || "",
    supplier: row.supplier || "",
    quantity,
    unitPrice,
    total: quantity * unitPrice,
    deferred: Number(row.deferred) === 1,
    note: row.note || "",
    financeCategory: row.finance_category,
    position: Number(row.position),
    spent,
  };
}

function mapTask(row) {
  return {
    id: row.id,
    taskNumber: row.task_number == null ? null : Number(row.task_number),
    title: row.title,
    assignee: row.assignee || "",
    dependsOn: row.depends_on || "",
    durationDays: row.duration_days == null ? null : Number(row.duration_days),
    weekStart: row.week_start == null ? null : Number(row.week_start),
    weekEnd: row.week_end == null ? null : Number(row.week_end),
    status: row.status,
    note: row.note || "",
    position: Number(row.position),
  };
}

function mapPurchase(row) {
  return {
    id: row.id,
    budgetItemId: row.budget_item_id || null,
    budgetItemName: row.budget_item_name || null,
    date: new Date(row.date).toISOString(),
    supplier: row.supplier || "",
    amount: Number(row.amount),
    accountId: row.account_id,
    financeCategory: row.finance_category,
    note: row.note || "",
  };
}

async function loadProject(client = db) {
  const result = await client.query(
    `SELECT id, name,
            to_char(start_date, 'YYYY-MM-DD') AS start_date,
            to_char(end_date, 'YYYY-MM-DD') AS end_date,
            notes
     FROM obra_projects
     ORDER BY created_at
     LIMIT 1`,
  );
  return result.rows[0] || null;
}

async function loadSnapshot() {
  const project = await loadProject();
  if (!project) return null;
  const [items, tasks, purchases] = await Promise.all([
    db.query(
      `SELECT * FROM obra_budget_items
       WHERE project_id = $1
       ORDER BY position, name`,
      [project.id],
    ),
    db.query(
      `SELECT * FROM obra_tasks
       WHERE project_id = $1
       ORDER BY week_start NULLS LAST, position, title`,
      [project.id],
    ),
    db.query(
      `SELECT p.*, i.name AS budget_item_name
       FROM obra_purchases p
       LEFT JOIN obra_budget_items i ON i.id = p.budget_item_id
       WHERE p.project_id = $1
       ORDER BY p.date DESC, p.created_at DESC`,
      [project.id],
    ),
  ]);
  const spentByItem = new Map();
  for (const row of purchases.rows) {
    if (!row.budget_item_id) continue;
    spentByItem.set(
      row.budget_item_id,
      (spentByItem.get(row.budget_item_id) || 0) + Number(row.amount),
    );
  }
  return {
    project: mapProject(project),
    items: items.rows.map((row) => mapItem(row, spentByItem.get(row.id) || 0)),
    tasks: tasks.rows.map(mapTask),
    purchases: purchases.rows.map(mapPurchase),
  };
}

async function insertFinanceExpense(client, purchaseId, purchase) {
  const id = crypto.randomUUID();
  await client.query(
    `INSERT INTO finance_transactions
     (id, account_id, type, amount, description, source, area, category, reference_id, date)
     VALUES ($1,$2,'expense',$3,$4,'obra','obra',$5,$6,$7)`,
    [
      id,
      purchase.accountId,
      purchase.amount,
      purchaseDescription(purchase),
      purchase.financeCategory,
      purchaseId,
      purchase.date,
    ],
  );
  return id;
}

router.get("/", async (_req, res) => {
  try {
    const snapshot = await loadSnapshot();
    if (!snapshot) return res.status(404).json({ error: "Obra no encontrada" });
    res.json(snapshot);
  } catch (error) {
    console.error("Error fetching obra:", error);
    res.status(500).json({ error: "Error al cargar la obra" });
  }
});

router.patch("/", async (req, res) => {
  try {
    const project = await loadProject();
    if (!project) return res.status(404).json({ error: "Obra no encontrada" });

    const sets = [];
    const values = [];
    if (req.body?.name != null) {
      const name = String(req.body.name).trim();
      if (!name) return res.status(400).json({ error: "El nombre es obligatorio" });
      values.push(name);
      sets.push(`name = $${values.length}`);
    }
    const isoDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || "").trim());
    let nextStart = project.start_date;
    let nextEnd = project.end_date;
    if (req.body?.startDate != null) {
      const startDate = String(req.body.startDate).trim();
      if (!isoDate(startDate)) {
        return res.status(400).json({ error: "Fecha de inicio inválida" });
      }
      nextStart = startDate;
      const [year, month, day] = startDate.split("-").map(Number);
      const endDate = new Date(Date.UTC(year, month - 1, day + 34));
      const endIso = endDate.toISOString().slice(0, 10);
      nextEnd = endIso;
      values.push(startDate);
      sets.push(`start_date = $${values.length}`);
      values.push(endIso);
      sets.push(`end_date = $${values.length}`);
    } else if (req.body?.endDate != null) {
      const endDate = String(req.body.endDate).trim();
      if (!isoDate(endDate)) {
        return res.status(400).json({ error: "Fecha de cierre inválida" });
      }
      nextEnd = endDate;
      values.push(endDate);
      sets.push(`end_date = $${values.length}`);
    }
    if (nextStart && nextEnd && nextEnd < nextStart) {
      return res.status(400).json({
        error: "La fecha de cierre no puede ser anterior al inicio",
      });
    }
    if (req.body?.notes != null) {
      values.push(String(req.body.notes));
      sets.push(`notes = $${values.length}`);
    }
    if (sets.length > 0) {
      values.push(project.id);
      sets.push("updated_at = CURRENT_TIMESTAMP");
      await db.query(
        `UPDATE obra_projects SET ${sets.join(", ")} WHERE id = $${values.length}`,
        values,
      );
    }
    const snapshot = await loadSnapshot();
    res.json(snapshot.project);
  } catch (error) {
    console.error("Error updating obra:", error);
    res.status(500).json({ error: "Error al actualizar la obra" });
  }
});

router.post("/items", async (req, res) => {
  const parsed = parseItem(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  try {
    const project = await loadProject();
    if (!project) return res.status(404).json({ error: "Obra no encontrada" });
    const position = await db.query(
      "SELECT COALESCE(MAX(position), -1) + 1 AS next FROM obra_budget_items WHERE project_id = $1",
      [project.id],
    );
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO obra_budget_items
       (id, project_id, section, name, detail, supplier, quantity, unit_price, deferred, note, finance_category, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        id,
        project.id,
        parsed.section,
        parsed.name,
        parsed.detail,
        parsed.supplier,
        parsed.quantity,
        parsed.unitPrice,
        parsed.deferred ? 1 : 0,
        parsed.note,
        parsed.financeCategory,
        position.rows[0].next,
      ],
    );
    const snapshot = await loadSnapshot();
    res.status(201).json(snapshot.items.find((item) => item.id === id));
  } catch (error) {
    console.error("Error creating obra item:", error);
    res.status(500).json({ error: "Error al crear el ítem" });
  }
});

router.put("/items/:id", async (req, res) => {
  const parsed = parseItem(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  try {
    const result = await db.query(
      `UPDATE obra_budget_items
       SET section = $1,
           name = $2,
           detail = $3,
           supplier = $4,
           quantity = $5,
           unit_price = $6,
           deferred = $7,
           note = $8,
           finance_category = $9,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $10`,
      [
        parsed.section,
        parsed.name,
        parsed.detail,
        parsed.supplier,
        parsed.quantity,
        parsed.unitPrice,
        parsed.deferred ? 1 : 0,
        parsed.note,
        parsed.financeCategory,
        req.params.id,
      ],
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Ítem no encontrado" });
    }
    const snapshot = await loadSnapshot();
    res.json(snapshot.items.find((item) => item.id === req.params.id));
  } catch (error) {
    console.error("Error updating obra item:", error);
    res.status(500).json({ error: "Error al actualizar el ítem" });
  }
});

router.delete("/items/:id", async (req, res) => {
  try {
    const result = await db.query(
      "DELETE FROM obra_budget_items WHERE id = $1",
      [req.params.id],
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Ítem no encontrado" });
    }
    res.status(204).send();
  } catch (error) {
    console.error("Error deleting obra item:", error);
    res.status(500).json({ error: "Error al eliminar el ítem" });
  }
});

router.post("/tasks", async (req, res) => {
  const parsed = parseTask(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  try {
    const project = await loadProject();
    if (!project) return res.status(404).json({ error: "Obra no encontrada" });
    const position = await db.query(
      "SELECT COALESCE(MAX(position), -1) + 1 AS next FROM obra_tasks WHERE project_id = $1",
      [project.id],
    );
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO obra_tasks
       (id, project_id, task_number, title, assignee, depends_on, duration_days, week_start, week_end, status, note, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        id,
        project.id,
        parsed.taskNumber,
        parsed.title,
        parsed.assignee,
        parsed.dependsOn,
        parsed.durationDays,
        parsed.weekStart,
        parsed.weekEnd,
        parsed.status,
        parsed.note,
        position.rows[0].next,
      ],
    );
    const snapshot = await loadSnapshot();
    res.status(201).json(snapshot.tasks.find((task) => task.id === id));
  } catch (error) {
    console.error("Error creating obra task:", error);
    res.status(500).json({ error: "Error al crear la tarea" });
  }
});

router.put("/tasks/order", async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
  if (
    !ids ||
    ids.length < 2 ||
    ids.some((id) => typeof id !== "string" || !id) ||
    new Set(ids).size !== ids.length
  ) {
    return res.status(400).json({ error: "Orden inválido" });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT id, project_id, week_start, position
       FROM obra_tasks
       WHERE id = ANY($1::text[])
       FOR UPDATE`,
      [ids],
    );
    if (result.rows.length !== ids.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Hay tareas que no existen" });
    }
    const projects = new Set(result.rows.map((row) => row.project_id));
    const weekOf = (value) => (value == null ? null : Number(value));
    const week = weekOf(result.rows[0].week_start);
    if (
      projects.size !== 1 ||
      result.rows.some((row) => weekOf(row.week_start) !== week)
    ) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "Solo se reordenan tareas de la misma semana",
      });
    }
    const positions = result.rows
      .map((row) => Number(row.position))
      .sort((a, b) => a - b);
    for (let index = 0; index < ids.length; index += 1) {
      await client.query(
        `UPDATE obra_tasks
         SET position = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [positions[index], ids[index]],
      );
    }
    await client.query("COMMIT");
    res.status(204).send();
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error reordering obra tasks:", error);
    res.status(500).json({ error: "No se pudo reordenar" });
  } finally {
    client.release();
  }
});

router.put("/tasks/:id", async (req, res) => {
  const parsed = parseTask(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  try {
    const result = await db.query(
      `UPDATE obra_tasks
       SET task_number = $1,
           title = $2,
           assignee = $3,
           depends_on = $4,
           duration_days = $5,
           week_start = $6,
           week_end = $7,
           status = $8,
           note = $9,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $10`,
      [
        parsed.taskNumber,
        parsed.title,
        parsed.assignee,
        parsed.dependsOn,
        parsed.durationDays,
        parsed.weekStart,
        parsed.weekEnd,
        parsed.status,
        parsed.note,
        req.params.id,
      ],
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Tarea no encontrada" });
    }
    const snapshot = await loadSnapshot();
    res.json(snapshot.tasks.find((task) => task.id === req.params.id));
  } catch (error) {
    console.error("Error updating obra task:", error);
    res.status(500).json({ error: "Error al actualizar la tarea" });
  }
});

router.delete("/tasks/:id", async (req, res) => {
  try {
    const result = await db.query("DELETE FROM obra_tasks WHERE id = $1", [
      req.params.id,
    ]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Tarea no encontrada" });
    }
    res.status(204).send();
  } catch (error) {
    console.error("Error deleting obra task:", error);
    res.status(500).json({ error: "Error al eliminar la tarea" });
  }
});

router.post("/purchases", async (req, res) => {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const project = await loadProject(client);
    if (!project) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Obra no encontrada" });
    }
    const parsed = await parsePurchase(client, req.body);
    if (parsed.error) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: parsed.error });
    }
    const id = crypto.randomUUID();
    const financeTransactionId = await insertFinanceExpense(client, id, parsed);
    await client.query(
      `INSERT INTO obra_purchases
       (id, project_id, budget_item_id, date, supplier, amount, account_id, finance_category, finance_transaction_id, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        id,
        project.id,
        parsed.budgetItemId,
        parsed.date,
        parsed.supplier,
        parsed.amount,
        parsed.accountId,
        parsed.financeCategory,
        financeTransactionId,
        parsed.note,
      ],
    );
    await client.query("COMMIT");
    const snapshot = await loadSnapshot();
    res.status(201).json(snapshot.purchases.find((purchase) => purchase.id === id));
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error creating obra purchase:", error);
    res.status(500).json({ error: "Error al registrar la compra" });
  } finally {
    client.release();
  }
});

router.put("/purchases/:id", async (req, res) => {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(
      "SELECT * FROM obra_purchases WHERE id = $1",
      [req.params.id],
    );
    if (!current.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Compra no encontrada" });
    }
    const parsed = await parsePurchase(client, req.body);
    if (parsed.error) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: parsed.error });
    }

    let financeTransactionId = current.rows[0].finance_transaction_id;
    if (financeTransactionId) {
      const updated = await client.query(
        `UPDATE finance_transactions
         SET account_id = $1,
             amount = $2,
             description = $3,
             area = 'obra',
             category = $4,
             date = $5
         WHERE id = $6 AND source = 'obra'
         RETURNING id`,
        [
          parsed.accountId,
          parsed.amount,
          purchaseDescription(parsed),
          parsed.financeCategory,
          parsed.date,
          financeTransactionId,
        ],
      );
      if (!updated.rows[0]) financeTransactionId = null;
    }
    if (!financeTransactionId) {
      financeTransactionId = await insertFinanceExpense(
        client,
        req.params.id,
        parsed,
      );
    }

    await client.query(
      `UPDATE obra_purchases
       SET budget_item_id = $1,
           date = $2,
           supplier = $3,
           amount = $4,
           account_id = $5,
           finance_category = $6,
           finance_transaction_id = $7,
           note = $8,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $9`,
      [
        parsed.budgetItemId,
        parsed.date,
        parsed.supplier,
        parsed.amount,
        parsed.accountId,
        parsed.financeCategory,
        financeTransactionId,
        parsed.note,
        req.params.id,
      ],
    );
    await client.query("COMMIT");
    const snapshot = await loadSnapshot();
    res.json(snapshot.purchases.find((purchase) => purchase.id === req.params.id));
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error updating obra purchase:", error);
    res.status(500).json({ error: "Error al actualizar la compra" });
  } finally {
    client.release();
  }
});

router.delete("/purchases/:id", async (req, res) => {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(
      "SELECT id FROM obra_purchases WHERE id = $1",
      [req.params.id],
    );
    if (!current.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Compra no encontrada" });
    }
    await client.query(
      `UPDATE obra_purchases SET finance_transaction_id = NULL WHERE id = $1`,
      [req.params.id],
    );
    await client.query(
      `DELETE FROM finance_transactions WHERE source = 'obra' AND reference_id = $1`,
      [req.params.id],
    );
    await client.query("DELETE FROM obra_purchases WHERE id = $1", [req.params.id]);
    await client.query("COMMIT");
    res.status(204).send();
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error deleting obra purchase:", error);
    res.status(500).json({ error: "Error al eliminar la compra" });
  } finally {
    client.release();
  }
});

export default router;
