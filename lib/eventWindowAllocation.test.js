import assert from "node:assert/strict";
import test from "node:test";
import {
  allocateCashRegister,
  allocateStaffCosts,
  minuteOnCajaDate,
  sharesAtMinute,
  eventIntervals,
} from "./eventWindowAllocation.js";

const cajaDate = "2026-10-23";

function at(time, day = cajaDate) {
  const [hour, minute] = time.split(":").map(Number);
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date, hour + 3, minute));
}

test("una comanda dentro de un solo evento va entera", () => {
  const allocation = allocateCashRegister({
    cajaDate,
    events: [
      { id: "a", name: "Show", startTime: "21:00", endTime: "23:00" },
      { id: "b", name: "Taller", startTime: "18:00", endTime: "20:00" },
    ],
    orders: [{ createdAt: at("21:30"), total: 10000, cost: 4000 }],
    totalIncome: 10000,
  });
  assert.deepEqual(
    allocation.map((item) => item.income),
    [10000, 0],
  );
  assert.deepEqual(
    allocation.map((item) => item.cost),
    [4000, 0],
  );
});

test("dos eventos en simultáneo se reparten a la mitad", () => {
  const allocation = allocateCashRegister({
    cajaDate,
    events: [
      { id: "a", name: "Show", startTime: "21:00", endTime: "23:00" },
      { id: "b", name: "Feria", startTime: "22:00", endTime: "01:00" },
    ],
    orders: [{ createdAt: at("22:30"), total: 8000, cost: 2000 }],
    totalIncome: 8000,
  });
  assert.deepEqual(
    allocation.map((item) => item.income),
    [4000, 4000],
  );
});

test("fuera de horario va al evento más cercano y un empate se parte", () => {
  const intervals = eventIntervals([
    { id: "a", name: "A", startTime: "18:00", endTime: "20:00" },
    { id: "b", name: "B", startTime: "22:00", endTime: "23:00" },
  ]);
  const nearer = sharesAtMinute(20 * 60 + 30, intervals);
  assert.deepEqual(nearer, [{ eventId: "a", share: 1 }]);
  const tied = sharesAtMinute(21 * 60, intervals);
  assert.equal(tied.length, 2);
  assert.equal(tied[0].share, 0.5);
});

test("un evento que cruza la medianoche incluye la madrugada", () => {
  const next = "2026-10-24";
  const allocation = allocateCashRegister({
    cajaDate,
    events: [{ id: "a", name: "Show", startTime: "21:00", endTime: "02:00" }],
    orders: [{ createdAt: at("01:00", next), total: 5000, cost: 0 }],
    totalIncome: 5000,
  });
  assert.equal(allocation[0].income, 5000);
  assert.equal(minuteOnCajaDate(at("01:00", next), cajaDate), 1440 + 60);
});

test("el personal se reparte por duración", () => {
  const totals = allocateStaffCosts(
    [{ date: cajaDate, jornada_amount: 80000, overtime_amount: 0 }],
    [
      { id: "a", date: cajaDate, start_time: "18:00", end_time: "00:00" },
      { id: "b", date: cajaDate, start_time: "20:00", end_time: "22:00" },
    ],
  );
  assert.equal(totals.get("a"), 60000);
  assert.equal(totals.get("b"), 20000);
});
