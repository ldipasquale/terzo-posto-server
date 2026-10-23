import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWizLights } from "./wizLights.js";

test("convierte una lámpara vieja en zona con ícono", () => {
  const result = normalizeWizLights({
    zones: [{ id: "bano", name: "Baño", ip: "192.168.100.123" }],
    scenes: [
      {
        id: "evento",
        name: "Evento",
        zones: {
          bano: { on: true, dimming: 40, r: 255, g: 0, b: 0 },
        },
      },
    ],
  });

  assert.equal(result.error, undefined);
  assert.deepEqual(result.data.zones, [
    { id: "bano", name: "Baño", icon: "bath" },
  ]);
  assert.equal(result.data.lamps.length, 1);
  assert.equal(result.data.lamps[0].zoneId, "bano");
  assert.equal(result.data.lamps[0].ip, "192.168.100.123");
  assert.equal(result.data.scenes[0].zones.bano.r, 255);
});

test("guarda varias lámparas en una zona", () => {
  const result = normalizeWizLights({
    zones: [{ id: "patio", name: "Patio", icon: "trees" }],
    lamps: [
      { id: "a", name: "Frente", ip: "192.168.100.20", zoneId: "patio" },
      { id: "b", name: "Fondo", ip: "192.168.100.21", zoneId: "patio" },
    ],
    scenes: [],
  });

  assert.equal(result.error, undefined);
  assert.equal(result.data.lamps.length, 2);
  assert.equal(result.data.zones[0].icon, "trees");
});

test("guarda un efecto dinámico y descarta uno desconocido", () => {
  const saved = normalizeWizLights({
    zones: [{ id: "patio", name: "Patio", icon: "trees" }],
    lamps: [],
    scenes: [
      {
        id: "navidad",
        name: "Navidad",
        zones: {
          patio: { on: true, dimming: 80, r: 0, g: 0, b: 0, effect: 27, speed: 80 },
        },
      },
    ],
  });
  assert.equal(saved.error, undefined);
  assert.equal(saved.data.scenes[0].zones.patio.effect, 27);
  assert.equal(saved.data.scenes[0].zones.patio.speed, 80);

  const dropped = normalizeWizLights({
    zones: [{ id: "patio", name: "Patio", icon: "trees" }],
    lamps: [],
    scenes: [
      {
        id: "navidad",
        name: "Navidad",
        zones: {
          patio: { on: true, dimming: 80, r: 1, g: 2, b: 3, effect: 999 },
        },
      },
    ],
  });
  assert.equal(dropped.data.scenes[0].zones.patio.effect, undefined);
});

test("guarda el color de una lámpara y descarta una que no existe", () => {
  const result = normalizeWizLights({
    zones: [{ id: "bano", name: "Baño", icon: "bath" }],
    lamps: [
      { id: "arriba", name: "Baño", ip: "192.168.100.10", zoneId: "bano" },
      { id: "abajo", name: "Baño abajo", ip: "192.168.100.11", zoneId: "bano" },
    ],
    scenes: [
      {
        id: "abierto",
        name: "Abierto",
        zones: {
          bano: { on: true, dimming: 80, r: 255, g: 180, b: 40 },
        },
        lamps: {
          abajo: { on: false, dimming: 20, r: 0, g: 0, b: 255, effect: 1, speed: 50 },
          fantasma: { on: true, dimming: 10, r: 0, g: 0, b: 0 },
        },
      },
    ],
  });

  assert.equal(result.error, undefined);
  assert.equal(result.data.scenes[0].lamps.abajo.on, false);
  assert.equal(result.data.scenes[0].lamps.abajo.effect, 1);
  assert.equal(result.data.scenes[0].lamps.abajo.speed, 50);
  assert.equal(result.data.scenes[0].lamps.fantasma, undefined);
});

test("rechaza una IP repetida", () => {
  const result = normalizeWizLights({
    zones: [{ id: "patio", name: "Patio", icon: "trees" }],
    lamps: [
      { id: "a", name: "Frente", ip: "192.168.100.20", zoneId: "patio" },
      { id: "b", name: "Fondo", ip: "192.168.100.20", zoneId: "patio" },
    ],
    scenes: [],
  });
  assert.match(result.error, /misma IP/);
});
