import assert from "node:assert/strict";
import test from "node:test";
import { allocatePurchaseNet } from "./purchaseSplit.js";

test("sin limpieza reparte igual que comida y bebida", () => {
  const split = allocatePurchaseNet(100, [
    { key: "drink", sub: 25 },
    { key: "cleaning", sub: 0 },
    { key: "food", sub: 75 },
  ]);
  assert.deepEqual(split, { drink: 25, cleaning: 0, food: 75 });
});

test("un ticket mixto se parte en tres y cierra en el neto", () => {
  const split = allocatePurchaseNet(100, [
    { key: "drink", sub: 20 },
    { key: "cleaning", sub: 30 },
    { key: "food", sub: 50 },
  ]);
  assert.equal(split.drink + split.cleaning + split.food, 100);
  assert.equal(split.drink, 20);
  assert.equal(split.cleaning, 30);
  assert.equal(split.food, 50);
});

test("si solo hay limpieza, el neto entero va a limpieza", () => {
  const split = allocatePurchaseNet(80.5, [
    { key: "drink", sub: 0 },
    { key: "cleaning", sub: 40 },
    { key: "food", sub: 0 },
  ]);
  assert.deepEqual(split, { drink: 0, cleaning: 80.5, food: 0 });
});
