/** Duración de referencia de una jornada, en horas. */
export const JORNADA_REFERENCE_HOURS = 8;

export function argentinaDateKey(date = new Date()) {
  return argentinaParts(date).date;
}

export function argentinaParts(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value ?? "";
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: hour * 60 + Number(get("minute")),
  };
}

export function addCalendarDays(ymd, days) {
  const [year, month, day] = ymd.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day + days));
  const mm = String(utc.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(utc.getUTCDate()).padStart(2, "0");
  return `${utc.getUTCFullYear()}-${mm}-${dd}`;
}

function parseMinutes(value) {
  if (value == null || value === "") return null;
  const [hour, minute] = String(value).slice(0, 5).split(":").map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return hour * 60 + minute;
}

/** Intervalo en minutos desde las 00:00 del día de la caja. El fin puede pasar de 1440. */
export function eventIntervals(events) {
  const intervals = [];
  for (const event of events) {
    const start = parseMinutes(event.startTime);
    const endRaw = parseMinutes(event.endTime);
    if (start == null || endRaw == null) continue;
    const end = endRaw <= start ? endRaw + 1440 : endRaw;
    if (end <= start) continue;
    intervals.push({
      eventId: event.id,
      name: event.name,
      start,
      end,
    });
  }
  return intervals;
}

export function eventDurationHours(event) {
  const [interval] = eventIntervals([event]);
  if (!interval) return 0;
  return (interval.end - interval.start) / 60;
}

export function minuteOnCajaDate(createdAt, cajaDate) {
  const parts = argentinaParts(new Date(createdAt));
  if (parts.date === cajaDate) return parts.minutes;
  if (parts.date === addCalendarDays(cajaDate, 1)) return 1440 + parts.minutes;
  if (parts.date < cajaDate) return parts.minutes - 1440;
  return 2880 + parts.minutes;
}

/** Reparto de un instante: ventana única, partes iguales si hay superposición, o el evento más cercano. */
export function sharesAtMinute(minute, intervals) {
  if (intervals.length === 0) return [];
  const containing = intervals.filter(
    (interval) => minute >= interval.start && minute < interval.end,
  );
  const chosen = containing.length > 0 ? containing : nearestIntervals(minute, intervals);
  const share = 1 / chosen.length;
  return chosen.map((interval) => ({ eventId: interval.eventId, share }));
}

function nearestIntervals(minute, intervals) {
  let best = Infinity;
  const distances = intervals.map((interval) => {
    const distance = minute < interval.start ? interval.start - minute : minute - interval.end;
    if (distance < best) best = distance;
    return distance;
  });
  return intervals.filter((_, index) => distances[index] === best);
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function distribute(total, weights) {
  const safeTotal = roundMoney(total);
  if (weights.length === 0) return [];
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  const amounts = weights.map((weight) =>
    roundMoney(safeTotal * (weightSum > 0 ? weight / weightSum : 1 / weights.length)),
  );
  const drift = roundMoney(safeTotal - amounts.reduce((sum, amount) => sum + amount, 0));
  if (drift !== 0) {
    let index = 0;
    amounts.forEach((amount, i) => {
      if (amount > amounts[index]) index = i;
    });
    amounts[index] = roundMoney(amounts[index] + drift);
  }
  return amounts;
}

/**
 * Reparte ingreso (contado al cierre) y costo de mercadería de las comandas.
 * El ingreso sigue la proporción de las comandas; si no hubo venta, la duración.
 */
export function allocateCashRegister({ cajaDate, events, orders, totalIncome }) {
  const intervals = eventIntervals(events);
  const rows = new Map(
    events.map((event) => [
      event.id,
      {
        eventId: event.id,
        eventName: event.name,
        orderShare: 0,
        cost: 0,
      },
    ]),
  );

  let orderSum = 0;
  for (const order of orders) {
    if (order.status === "cancelled") continue;
    const total = Number(order.total) || 0;
    const cost = Number(order.cost) || 0;
    const minute = minuteOnCajaDate(order.createdAt, cajaDate);
    const shares =
      intervals.length > 0
        ? sharesAtMinute(minute, intervals)
        : events.map((event) => ({ eventId: event.id, share: 1 / events.length }));
    orderSum += total;
    for (const share of shares) {
      const row = rows.get(share.eventId);
      if (!row) continue;
      row.orderShare += total * share.share;
      row.cost += cost * share.share;
    }
  }

  const incomeBase = Number.isFinite(totalIncome) ? Number(totalIncome) : orderSum;
  const durations = events.map((event) => eventDurationHours(event));
  const incomeWeights =
    orderSum > 0
      ? events.map((event) => rows.get(event.id).orderShare)
      : durations;
  const incomes = distribute(incomeBase, incomeWeights);

  return events.map((event, index) => ({
    eventId: event.id,
    eventName: event.name,
    income: incomes[index] ?? 0,
    cost: roundMoney(rows.get(event.id).cost),
  }));
}

export function incomeShares(allocation) {
  const total = allocation.reduce((sum, row) => sum + row.income, 0);
  if (allocation.length === 0) return [];
  if (total <= 0) {
    return allocation.map((row) => ({
      eventId: row.eventId,
      eventName: row.eventName,
      share: 1 / allocation.length,
    }));
  }
  return allocation.map((row) => ({
    eventId: row.eventId,
    eventName: row.eventName,
    share: row.income / total,
  }));
}

export function splitMoney(amount, shares) {
  const amounts = distribute(
    amount,
    shares.map((share) => share.share),
  );
  return shares.flatMap((share, index) => {
    const piece = amounts[index] ?? 0;
    if (piece <= 0) return [];
    return [{ ...share, amount: piece }];
  });
}

/** Costo de personal del día, en proporción a la duración de cada evento. */
export function splitLaborByDuration(amount, events) {
  if (!events.length || !(Number(amount) > 0)) return [];
  const amounts = distribute(
    amount,
    events.map((event) => eventDurationHours(event)),
  );
  return events.map((event, index) => ({
    eventId: event.id,
    amount: amounts[index] ?? 0,
  }));
}

export function allocateStaffCosts(shifts, events) {
  const byDate = new Map();
  for (const event of events) {
    const list = byDate.get(event.date) ?? [];
    list.push(event);
    byDate.set(event.date, list);
  }
  const totals = new Map();
  for (const shift of shifts) {
    const dayEvents = byDate.get(shift.date) ?? [];
    const amount = (Number(shift.jornada_amount) || 0) + (Number(shift.overtime_amount) || 0);
    const parts = splitLaborByDuration(
      amount,
      dayEvents.map((event) => ({
        id: event.id,
        startTime: event.start_time ?? event.startTime,
        endTime: event.end_time ?? event.endTime,
      })),
    );
    for (const part of parts) {
      totals.set(part.eventId, roundMoney((totals.get(part.eventId) || 0) + part.amount));
    }
  }
  return totals;
}
