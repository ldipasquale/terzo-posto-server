import { JORNADA_REFERENCE_HOURS } from "./eventWindowAllocation.js";

export const STAFF_JORNADA_KEY = "staff_jornada_amount";
export const STAFF_HOUR_KEY = "staff_hour_amount";

export const STAFF_AREAS = ["cocina", "bar", "limpieza"];

export const STAFF_AREA_CATEGORY = {
  cocina: { area: "cocina", category: "sueldos" },
  bar: { area: "bar", category: "sueldos" },
  limpieza: { area: "mantenimiento", category: "sueldos" },
};

export function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

export function jornadaAmountForHours(rate, hours) {
  return roundMoney((Number(rate) * Number(hours)) / JORNADA_REFERENCE_HOURS);
}

function parseStoredAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? roundMoney(amount) : 0;
}

export async function getStaffPayDefaults(db) {
  const result = await db.query(
    "SELECT key, value FROM settings WHERE key = ANY($1::text[])",
    [[STAFF_JORNADA_KEY, STAFF_HOUR_KEY]],
  );
  const stored = Object.fromEntries(result.rows.map((row) => [row.key, row.value]));
  return {
    jornadaAmount: parseStoredAmount(stored[STAFF_JORNADA_KEY]),
    hourAmount: parseStoredAmount(stored[STAFF_HOUR_KEY]),
  };
}

export function parsePositiveHours(value, label) {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) {
    return { error: `${label} tiene que ser mayor a 0 y hasta 24` };
  }
  return { hours: roundMoney(hours) };
}

export function parseOptionalHours(value) {
  if (value == null || value === "") return { hours: 0 };
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours < 0 || hours > 24) {
    return { error: "Las horas extra tienen que estar entre 0 y 24" };
  }
  return { hours: roundMoney(hours) };
}

export function parseMoney(value, label) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    return { error: `${label} tiene que ser un número mayor o igual a 0` };
  }
  return { amount: roundMoney(amount) };
}

export function formatEmployee(row) {
  return {
    id: row.id,
    name: row.name,
    area: row.area,
    jornadaAmount: Number(row.jornada_amount) || 0,
    hourAmount: Number(row.hour_amount) || 0,
    active: Boolean(Number(row.active)),
    responsibleName: row.responsible_name || undefined,
    pendingAmount: Number(row.pending_amount) || 0,
    pendingShifts: Number(row.pending_shifts) || 0,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : undefined,
  };
}

export function formatShift(row) {
  const jornadaAmount = Number(row.jornada_amount) || 0;
  const overtimeAmount = Number(row.overtime_amount) || 0;
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeName: row.employee_name || undefined,
    area: row.employee_area || undefined,
    date: typeof row.date === "string" ? row.date.slice(0, 10) : row.date_key,
    cashRegisterId: row.cash_register_id || undefined,
    jornadaHours: Number(row.jornada_hours) || 0,
    jornadaAmount,
    overtimeHours: Number(row.overtime_hours) || 0,
    hourAmount: Number(row.hour_amount) || 0,
    overtimeAmount,
    totalAmount: roundMoney(jornadaAmount + overtimeAmount),
    paymentId: row.payment_id || undefined,
    paidDate: row.paid_date ? new Date(row.paid_date).toISOString() : undefined,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : undefined,
  };
}

export function formatStaffPayment(row) {
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeName: row.employee_name || undefined,
    area: row.area || undefined,
    amount: Number(row.amount) || 0,
    accountId: row.account_id,
    paidDate: new Date(row.paid_date).toISOString(),
    shiftIds: Array.isArray(row.shift_ids) ? row.shift_ids : [],
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : undefined,
  };
}
