import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateOrderQuantities,
  parsePortionLimitMap,
  portionShortageMessage,
} from "./portionLimit.js";

test("sin tope es un mapa vacío", () => {
  assert.equal(parsePortionLimitMap(null, ["a"]).size, 0);
  assert.equal(parsePortionLimitMap(undefined, ["a"]).size, 0);
  assert.equal(parsePortionLimitMap({}, ["a"]).size, 0);
});

test("acepta un entero para un plato tildado", () => {
  const limits = parsePortionLimitMap({ empanadas: 3, flan: "" }, [
    "empanadas",
    "flan",
  ]);
  assert.equal(limits.get("empanadas"), 3);
  assert.equal(limits.has("flan"), false);
});

test("rechaza un tope en un plato destildado", () => {
  assert.throws(
    () => parsePortionLimitMap({ empanadas: 3 }, []),
    /solo para platos disponibles/,
  );
});

test("rechaza cero y números fuera de rango", () => {
  assert.throws(
    () => parsePortionLimitMap({ empanadas: 0 }, ["empanadas"]),
    /entre 1 y 999/,
  );
  assert.throws(
    () => parsePortionLimitMap({ empanadas: 1000 }, ["empanadas"]),
    /entre 1 y 999/,
  );
});

test("suma cantidades del mismo plato en la comanda", () => {
  const qty = aggregateOrderQuantities([
    { menuItem: { id: "empanadas" }, quantity: 2 },
    { menuItem: { id: "empanadas" }, quantity: 1 },
    { menuItem: { id: "agua" }, quantity: 1 },
  ]);
  assert.equal(qty.get("empanadas"), 3);
  assert.equal(qty.get("agua"), 1);
});

test("el mensaje dice cuántas quedan", () => {
  assert.equal(
    portionShortageMessage([{ name: "Empanadas", remaining: 0 }]),
    "Empanadas está agotado",
  );
  assert.equal(
    portionShortageMessage([{ name: "Empanadas", remaining: 1 }]),
    "Empanadas: queda 1",
  );
  assert.equal(
    portionShortageMessage([{ name: "Empanadas", remaining: 3 }]),
    "Empanadas: quedan 3",
  );
});
