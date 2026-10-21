import express from "express";
import crypto from "crypto";
import db from "../database.js";
import { requirePermission } from "../middleware/requirePermission.js";
import { PERMISSIONS } from "../lib/userPermissions.js";
import {
  STAFF_AREAS,
  STAFF_AREA_CATEGORY,
  formatEmployee,
  formatShift,
  formatStaffPayment,
  getStaffPayDefaults,
  jornadaAmountForHours,
  parseMoney,
  parseOptionalHours,
  parsePositiveHours,
  roundMoney,
} from "../lib/staffPay.js";

const router = express.Router();
const requireFinance = requirePermission(PERMISSIONS.FINANZAS);
const PARTNERS = ["Lucho", "Bachi", "Luli"];

function parseResponsibleName(value) {
  if (value == null) return null;
  const name = String(value).trim();
  if (!name) return "";
  return PARTNERS.includes(name) ? name : undefined;
}

const SHIFT_SELECT = `
  SELECT
    s.*,
    to_char(s.date, 'YYYY-MM-DD') AS date_key,
    e.name AS employee_name,
    e.area AS employee_area,
    p.id AS payment_id,
    p.paid_date
  FROM staff_shifts s
  JOIN employees e ON e.id = s.employee_id
  LEFT JOIN staff_payment_shifts sps ON sps.shift_id = s.id
  LEFT JOIN staff_payments p ON p.id = sps.payment_id
`;

function dateKey(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  return value;
}

async function readShiftBody(body, employee, { requireDate = true } = {}) {
  const hours = parsePositiveHours(body?.jornadaHours, "Las horas de jornada");
  if (hours.error) return hours;
  const overtime = parseOptionalHours(body?.overtimeHours);
  if (overtime.error) return overtime;
  const amount =
    body?.jornadaAmount == null || body.jornadaAmount === ""
      ? { amount: jornadaAmountForHours(employee.jornada_amount, hours.hours) }
      : parseMoney(body.jornadaAmount, "El valor de la jornada");
  if (amount.error) return amount;
  let date;
  if (requireDate || body?.date != null) {
    date = dateKey(body?.date);
    if (!date) return { error: "La fecha de la jornada es inválida" };
  }
  return {
    date,
    jornadaHours: hours.hours,
    jornadaAmount: amount.amount,
    overtimeHours: overtime.hours,
    hourAmount: roundMoney(employee.hour_amount),
    overtimeAmount: roundMoney(overtime.hours * Number(employee.hour_amount)),
  };
}

router.get("/", async (req, res) => {
  try {
    const activeOnly = req.query.active === "1" || req.query.active === "true";
    const result = await db.query(
      `SELECT
         e.*,
         COALESCE(SUM(s.jornada_amount + s.overtime_amount) FILTER (WHERE sps.shift_id IS NULL), 0) AS pending_amount,
         COUNT(s.id) FILTER (WHERE sps.shift_id IS NULL)::int AS pending_shifts
       FROM employees e
       LEFT JOIN staff_shifts s ON s.employee_id = e.id
       LEFT JOIN staff_payment_shifts sps ON sps.shift_id = s.id
       ${activeOnly ? "WHERE e.active = 1" : ""}
       GROUP BY e.id
       ORDER BY e.active DESC, e.name`,
    );
    res.json(result.rows.map(formatEmployee));
  } catch (error) {
    console.error("Error fetching employees:", error);
    res.status(500).json({ error: "Error al obtener los empleados" });
  }
});

router.get("/payments", requireFinance, async (req, res) => {
  try {
    const params = [];
    const where = [];
    if (req.query.employeeId) {
      params.push(req.query.employeeId);
      where.push(`p.employee_id = $${params.length}`);
    }
    const result = await db.query(
      `SELECT
         p.*,
         e.name AS employee_name,
         e.area,
         COALESCE(
           (SELECT json_agg(sps.shift_id) FROM staff_payment_shifts sps WHERE sps.payment_id = p.id),
           '[]'::json
         ) AS shift_ids
       FROM staff_payments p
       JOIN employees e ON e.id = p.employee_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY p.paid_date DESC`,
      params,
    );
    res.json(result.rows.map(formatStaffPayment));
  } catch (error) {
    console.error("Error fetching staff payments:", error);
    res.status(500).json({ error: "Error al obtener los pagos" });
  }
});

router.post("/", requireFinance, async (req, res) => {
  try {
    const name = String(req.body?.name ?? "").trim();
    const area = req.body?.area;
    if (!name) return res.status(400).json({ error: "El nombre es requerido" });
    if (!STAFF_AREAS.includes(area)) {
      return res.status(400).json({ error: "Elegí si es de cocina, bar o limpieza" });
    }
    const defaults = await getStaffPayDefaults(db);
    const jornada =
      req.body?.jornadaAmount == null || req.body.jornadaAmount === ""
        ? { amount: defaults.jornadaAmount }
        : parseMoney(req.body.jornadaAmount, "El valor de la jornada");
    if (jornada.error) return res.status(400).json({ error: jornada.error });
    const hour =
      req.body?.hourAmount == null || req.body.hourAmount === ""
        ? { amount: defaults.hourAmount }
        : parseMoney(req.body.hourAmount, "El valor de la hora");
    if (hour.error) return res.status(400).json({ error: hour.error });
    const responsibleName = parseResponsibleName(req.body?.responsibleName);
    if (!responsibleName) {
      return res.status(400).json({ error: "Elegí un responsable" });
    }

    const id = crypto.randomUUID();
    const result = await db.query(
      `INSERT INTO employees (id, name, area, jornada_amount, hour_amount, responsible_name)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *, 0::float AS pending_amount, 0::int AS pending_shifts`,
      [id, name, area, jornada.amount, hour.amount, responsibleName],
    );
    res.status(201).json(formatEmployee(result.rows[0]));
  } catch (error) {
    console.error("Error creating employee:", error);
    res.status(500).json({ error: "Error al crear el empleado" });
  }
});

router.get("/:id", requireFinance, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT
         e.*,
         COALESCE(SUM(s.jornada_amount + s.overtime_amount) FILTER (WHERE sps.shift_id IS NULL), 0) AS pending_amount,
         COUNT(s.id) FILTER (WHERE sps.shift_id IS NULL)::int AS pending_shifts
       FROM employees e
       LEFT JOIN staff_shifts s ON s.employee_id = e.id
       LEFT JOIN staff_payment_shifts sps ON sps.shift_id = s.id
       WHERE e.id = $1
       GROUP BY e.id`,
      [req.params.id],
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Empleado no encontrado" });
    res.json(formatEmployee(result.rows[0]));
  } catch (error) {
    console.error("Error fetching employee:", error);
    res.status(500).json({ error: "Error al obtener el empleado" });
  }
});

router.patch("/:id", requireFinance, async (req, res) => {
  try {
    const current = await db.query("SELECT * FROM employees WHERE id = $1", [req.params.id]);
    const employee = current.rows[0];
    if (!employee) return res.status(404).json({ error: "Empleado no encontrado" });

    const name =
      req.body?.name == null ? employee.name : String(req.body.name).trim();
    if (!name) return res.status(400).json({ error: "El nombre es requerido" });
    const area = req.body?.area == null ? employee.area : req.body.area;
    if (!STAFF_AREAS.includes(area)) {
      return res.status(400).json({ error: "Elegí si es de cocina, bar o limpieza" });
    }
    const jornada =
      req.body?.jornadaAmount == null
        ? { amount: Number(employee.jornada_amount) }
        : parseMoney(req.body.jornadaAmount, "El valor de la jornada");
    if (jornada.error) return res.status(400).json({ error: jornada.error });
    const hour =
      req.body?.hourAmount == null
        ? { amount: Number(employee.hour_amount) }
        : parseMoney(req.body.hourAmount, "El valor de la hora");
    if (hour.error) return res.status(400).json({ error: hour.error });
    const active =
      req.body?.active == null ? Number(employee.active) : req.body.active ? 1 : 0;
    let responsibleName = employee.responsible_name;
    if (req.body?.responsibleName !== undefined) {
      const parsed = parseResponsibleName(req.body.responsibleName);
      if (!parsed) return res.status(400).json({ error: "Elegí un responsable" });
      responsibleName = parsed;
    }

    const result = await db.query(
      `UPDATE employees
       SET name = $1, area = $2, jornada_amount = $3, hour_amount = $4, active = $5,
           responsible_name = $6, updated_at = CURRENT_TIMESTAMP
       WHERE id = $7
       RETURNING *`,
      [name, area, jornada.amount, hour.amount, active, responsibleName, req.params.id],
    );
    const pending = await db.query(
      `SELECT
         COALESCE(SUM(s.jornada_amount + s.overtime_amount) FILTER (WHERE sps.shift_id IS NULL), 0) AS pending_amount,
         COUNT(s.id) FILTER (WHERE sps.shift_id IS NULL)::int AS pending_shifts
       FROM staff_shifts s
       LEFT JOIN staff_payment_shifts sps ON sps.shift_id = s.id
       WHERE s.employee_id = $1`,
      [req.params.id],
    );
    res.json(formatEmployee({ ...result.rows[0], ...pending.rows[0] }));
  } catch (error) {
    console.error("Error updating employee:", error);
    res.status(500).json({ error: "Error al actualizar el empleado" });
  }
});

router.delete("/:id", requireFinance, async (req, res) => {
  try {
    const used = await db.query(
      "SELECT 1 FROM staff_shifts WHERE employee_id = $1 LIMIT 1",
      [req.params.id],
    );
    if (used.rows.length > 0) {
      return res.status(400).json({
        error: "Este empleado tiene jornadas. Archivalo en lugar de eliminarlo",
      });
    }
    const result = await db.query("DELETE FROM employees WHERE id = $1", [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: "Empleado no encontrado" });
    res.status(204).send();
  } catch (error) {
    console.error("Error deleting employee:", error);
    res.status(500).json({ error: "Error al eliminar el empleado" });
  }
});

router.get("/:id/shifts", requireFinance, async (req, res) => {
  try {
    const result = await db.query(
      `${SHIFT_SELECT} WHERE s.employee_id = $1 ORDER BY s.date DESC, s.created_at DESC`,
      [req.params.id],
    );
    res.json(result.rows.map(formatShift));
  } catch (error) {
    console.error("Error fetching shifts:", error);
    res.status(500).json({ error: "Error al obtener las jornadas" });
  }
});

router.post("/:id/shifts", requireFinance, async (req, res) => {
  try {
    const employee = await db.query("SELECT * FROM employees WHERE id = $1", [req.params.id]);
    if (!employee.rows[0]) return res.status(404).json({ error: "Empleado no encontrado" });
    const parsed = await readShiftBody(req.body, employee.rows[0]);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO staff_shifts (
         id, employee_id, date, jornada_hours, jornada_amount, overtime_hours, hour_amount, overtime_amount
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        req.params.id,
        parsed.date,
        parsed.jornadaHours,
        parsed.jornadaAmount,
        parsed.overtimeHours,
        parsed.hourAmount,
        parsed.overtimeAmount,
      ],
    );
    const result = await db.query(`${SHIFT_SELECT} WHERE s.id = $1`, [id]);
    res.status(201).json(formatShift(result.rows[0]));
  } catch (error) {
    console.error("Error creating shift:", error);
    res.status(500).json({ error: "Error al cargar la jornada" });
  }
});

router.patch("/:id/shifts/:shiftId", requireFinance, async (req, res) => {
  try {
    const current = await db.query(
      `${SHIFT_SELECT} WHERE s.id = $1 AND s.employee_id = $2`,
      [req.params.shiftId, req.params.id],
    );
    const shift = current.rows[0];
    if (!shift) return res.status(404).json({ error: "Jornada no encontrada" });
    if (shift.payment_id) {
      return res.status(400).json({ error: "Esta jornada ya está pagada" });
    }
    const employee = await db.query("SELECT * FROM employees WHERE id = $1", [req.params.id]);
    const parsed = await readShiftBody(
      {
        date: req.body?.date ?? shift.date_key,
        jornadaHours: req.body?.jornadaHours ?? shift.jornada_hours,
        jornadaAmount: req.body?.jornadaAmount ?? shift.jornada_amount,
        overtimeHours: req.body?.overtimeHours ?? shift.overtime_hours,
      },
      employee.rows[0],
    );
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    await db.query(
      `UPDATE staff_shifts
       SET date = $1, jornada_hours = $2, jornada_amount = $3, overtime_hours = $4,
           hour_amount = $5, overtime_amount = $6
       WHERE id = $7`,
      [
        parsed.date,
        parsed.jornadaHours,
        parsed.jornadaAmount,
        parsed.overtimeHours,
        parsed.hourAmount,
        parsed.overtimeAmount,
        req.params.shiftId,
      ],
    );
    const result = await db.query(`${SHIFT_SELECT} WHERE s.id = $1`, [req.params.shiftId]);
    res.json(formatShift(result.rows[0]));
  } catch (error) {
    console.error("Error updating shift:", error);
    res.status(500).json({ error: "Error al actualizar la jornada" });
  }
});

router.delete("/:id/shifts/:shiftId", requireFinance, async (req, res) => {
  try {
    const current = await db.query(
      `${SHIFT_SELECT} WHERE s.id = $1 AND s.employee_id = $2`,
      [req.params.shiftId, req.params.id],
    );
    const shift = current.rows[0];
    if (!shift) return res.status(404).json({ error: "Jornada no encontrada" });
    if (shift.payment_id) {
      return res.status(400).json({ error: "Esta jornada ya está pagada" });
    }
    await db.query("DELETE FROM staff_shifts WHERE id = $1", [req.params.shiftId]);
    res.status(204).send();
  } catch (error) {
    console.error("Error deleting shift:", error);
    res.status(500).json({ error: "Error al eliminar la jornada" });
  }
});

router.post("/:id/payments", requireFinance, async (req, res) => {
  const client = await db.connect();
  try {
    const employee = await client.query("SELECT * FROM employees WHERE id = $1", [req.params.id]);
    if (!employee.rows[0]) {
      return res.status(404).json({ error: "Empleado no encontrado" });
    }
    const shiftIds = [...new Set((req.body?.shiftIds ?? []).map((id) => String(id)).filter(Boolean))];
    if (shiftIds.length === 0) {
      return res.status(400).json({ error: "Elegí al menos una jornada" });
    }
    const accountId = String(req.body?.accountId ?? "").trim();
    if (!accountId) return res.status(400).json({ error: "Indicá de qué cuenta sale el pago" });
    const account = await client.query(
      "SELECT id FROM mercado_pago_accounts WHERE id = $1",
      [accountId],
    );
    if (!account.rows[0]) return res.status(400).json({ error: "La cuenta no existe" });

    const shifts = await client.query(
      `SELECT s.id, s.jornada_amount, s.overtime_amount
       FROM staff_shifts s
       LEFT JOIN staff_payment_shifts sps ON sps.shift_id = s.id
       WHERE s.employee_id = $1 AND s.id = ANY($2::text[]) AND sps.shift_id IS NULL`,
      [req.params.id, shiftIds],
    );
    if (shifts.rows.length !== shiftIds.length) {
      return res.status(400).json({ error: "Hay jornadas que no se pueden pagar" });
    }
    const amount = roundMoney(
      shifts.rows.reduce(
        (sum, shift) => sum + Number(shift.jornada_amount) + Number(shift.overtime_amount),
        0,
      ),
    );
    if (amount <= 0) return res.status(400).json({ error: "El pago tiene que ser mayor a 0" });

    const paidDate = req.body?.paidDate ? new Date(req.body.paidDate) : new Date();
    if (Number.isNaN(paidDate.getTime())) {
      return res.status(400).json({ error: "La fecha de pago es inválida" });
    }

    const person = employee.rows[0];
    const category = STAFF_AREA_CATEGORY[person.area];
    const paymentId = crypto.randomUUID();
    const transactionId = crypto.randomUUID();

    await client.query("BEGIN");
    await client.query(
      `INSERT INTO staff_payments (id, employee_id, amount, account_id, paid_date)
       VALUES ($1, $2, $3, $4, $5)`,
      [paymentId, person.id, amount, accountId, paidDate.toISOString()],
    );
    for (const shiftId of shiftIds) {
      await client.query(
        "INSERT INTO staff_payment_shifts (payment_id, shift_id) VALUES ($1, $2)",
        [paymentId, shiftId],
      );
    }
    await client.query(
      `INSERT INTO finance_transactions
       (id, account_id, type, amount, description, source, area, category, reference_id, date)
       VALUES ($1, $2, 'expense', $3, $4, 'staff', $5, $6, $7, $8)`,
      [
        transactionId,
        accountId,
        amount,
        `Sueldo — ${person.name}`,
        category.area,
        category.category,
        paymentId,
        paidDate.toISOString(),
      ],
    );
    await client.query("COMMIT");

    const result = await db.query(
      `SELECT p.*, e.name AS employee_name, e.area, $2::json AS shift_ids
       FROM staff_payments p
       JOIN employees e ON e.id = p.employee_id
       WHERE p.id = $1`,
      [paymentId, JSON.stringify(shiftIds)],
    );
    res.status(201).json(formatStaffPayment(result.rows[0]));
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error creating staff payment:", error);
    res.status(500).json({ error: "Error al registrar el pago" });
  } finally {
    client.release();
  }
});

router.delete("/payments/:paymentId", requireFinance, async (req, res) => {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "DELETE FROM finance_transactions WHERE source = 'staff' AND reference_id = $1",
      [req.params.paymentId],
    );
    const result = await client.query("DELETE FROM staff_payments WHERE id = $1", [
      req.params.paymentId,
    ]);
    if (result.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Pago no encontrado" });
    }
    await client.query("COMMIT");
    res.status(204).send();
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error deleting staff payment:", error);
    res.status(500).json({ error: "Error al anular el pago" });
  } finally {
    client.release();
  }
});

export async function listCashRegisterShifts(queryable, cashRegisterId) {
  const result = await queryable.query(
    `${SHIFT_SELECT} WHERE s.cash_register_id = $1 ORDER BY e.name`,
    [cashRegisterId],
  );
  return result.rows.map(formatShift);
}

export async function replaceCashRegisterShifts(client, cashRegisterId, cajaDate, entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    await client.query(
      `DELETE FROM staff_shifts s
       WHERE s.cash_register_id = $1
         AND NOT EXISTS (SELECT 1 FROM staff_payment_shifts sps WHERE sps.shift_id = s.id)`,
      [cashRegisterId],
    );
    return;
  }
  const ids = [...new Set(entries.map((entry) => entry.employeeId))];
  if (ids.length !== entries.length) {
    const err = new Error("Hay un empleado repetido en el cierre");
    err.statusCode = 400;
    throw err;
  }
  const employees = await client.query(
    "SELECT * FROM employees WHERE id = ANY($1::text[]) AND active = 1",
    [ids],
  );
  if (employees.rows.length !== ids.length) {
    const err = new Error("Hay un empleado que no está activo");
    err.statusCode = 400;
    throw err;
  }
  if (employees.rows.some((row) => row.area !== "cocina" && row.area !== "bar")) {
    const err = new Error("En el cierre solo se anotan cocina y bar");
    err.statusCode = 400;
    throw err;
  }
  const byId = new Map(employees.rows.map((row) => [row.id, row]));
  const paid = await client.query(
    `SELECT 1
     FROM staff_shifts s
     JOIN staff_payment_shifts sps ON sps.shift_id = s.id
     WHERE s.cash_register_id = $1
     LIMIT 1`,
    [cashRegisterId],
  );
  if (paid.rows.length > 0) {
    const err = new Error("Esta caja ya tiene jornadas pagadas");
    err.statusCode = 400;
    throw err;
  }
  await client.query("DELETE FROM staff_shifts WHERE cash_register_id = $1", [cashRegisterId]);
  for (const entry of entries) {
    const employee = byId.get(entry.employeeId);
    const parsed = await readShiftBody(
      { ...entry, date: cajaDate },
      employee,
    );
    if (parsed.error) {
      const err = new Error(parsed.error);
      err.statusCode = 400;
      throw err;
    }
    await client.query(
      `INSERT INTO staff_shifts (
         id, employee_id, date, cash_register_id, jornada_hours, jornada_amount,
         overtime_hours, hour_amount, overtime_amount
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        crypto.randomUUID(),
        employee.id,
        cajaDate,
        cashRegisterId,
        parsed.jornadaHours,
        parsed.jornadaAmount,
        parsed.overtimeHours,
        parsed.hourAmount,
        parsed.overtimeAmount,
      ],
    );
  }
}

export default router;
