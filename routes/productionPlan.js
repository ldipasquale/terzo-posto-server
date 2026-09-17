import express from "express";
import db from "../database.js";

const router = express.Router();

function asObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function sanitizeProductionStep(raw) {
  if (typeof raw === "string") {
    const text = raw.trim().slice(0, 200);
    if (!text) return null;
    return { id: text.toLowerCase(), text };
  }
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim();
  const text = String(raw.text || "").trim().slice(0, 200);
  if (!text) return null;
  return { id: id || text.toLowerCase(), text };
}

function sanitizeDish(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim();
  const name = String(raw.name || "").trim();
  const portions = Number(raw.portions);
  const quantity = Number(raw.quantity);
  if (!id || !name) return null;
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  const recipe = Array.isArray(raw.recipe)
    ? raw.recipe
        .map((line) => {
          const supplyId = String(line?.supplyId || line?.supply_id || "").trim();
          const qty = Number(line?.quantity);
          if (!supplyId || !Number.isFinite(qty) || qty <= 0) return null;
          return { supplyId, quantity: qty };
        })
        .filter(Boolean)
    : [];
  const productionSteps = Array.isArray(raw.productionSteps)
    ? raw.productionSteps.map(sanitizeProductionStep).filter(Boolean)
    : [];
  return {
    id,
    name,
    portions: Number.isFinite(portions) && portions > 0 ? portions : 1,
    quantity: Math.floor(quantity),
    recipe,
    productionSteps,
  };
}

function sanitizeBoolMap(value) {
  const out = {};
  for (const [key, val] of Object.entries(asObject(value))) {
    if (val) out[String(key)] = true;
  }
  return out;
}

function sanitizeExtraTask(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim();
  const text = String(raw.text || "").trim();
  if (!id || !text) return null;
  return {
    id,
    text: text.slice(0, 200),
    done: Boolean(raw.done),
  };
}

function sanitizeTaskOrder(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    const id = String(raw || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= 200) break;
  }
  return out;
}

function rowToPlan(row) {
  const step = Number(row.step);
  return {
    step: step === 2 || step === 3 ? step : 1,
    planView: row.plan_view === "purchases" ? "purchases" : "tasks",
    dishes: Array.isArray(row.dishes)
      ? row.dishes.map(sanitizeDish).filter(Boolean)
      : [],
    haveMap: sanitizeBoolMap(row.have_map),
    doneMap: sanitizeBoolMap(row.done_map),
    extraTasks: Array.isArray(row.extra_tasks)
      ? row.extra_tasks.map(sanitizeExtraTask).filter(Boolean)
      : [],
    taskOrder: sanitizeTaskOrder(row.task_order),
  };
}

router.get("/", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT user_id, step, plan_view, dishes, have_map, done_map, extra_tasks, task_order, updated_at
       FROM production_plans
       WHERE user_id = $1`,
      [req.user.id],
    );
    if (!result.rows[0]) {
      return res.json(null);
    }
    res.json(rowToPlan(result.rows[0]));
  } catch (error) {
    console.error("Error fetching production plan:", error);
    res.status(500).json({ error: "Error al obtener el plan de producción" });
  }
});

router.put("/", async (req, res) => {
  try {
    const stepRaw = Number(req.body?.step);
    const step = stepRaw === 2 || stepRaw === 3 ? stepRaw : 1;
    const planView =
      req.body?.planView === "purchases" ? "purchases" : "tasks";
    const dishes = Array.isArray(req.body?.dishes)
      ? req.body.dishes.map(sanitizeDish).filter(Boolean)
      : [];
    const haveMap = sanitizeBoolMap(req.body?.haveMap);
    const doneMap = sanitizeBoolMap(req.body?.doneMap);
    const extraTasks = Array.isArray(req.body?.extraTasks)
      ? req.body.extraTasks.map(sanitizeExtraTask).filter(Boolean).slice(0, 50)
      : [];
    const taskOrder = sanitizeTaskOrder(req.body?.taskOrder);

    const result = await db.query(
      `INSERT INTO production_plans (user_id, step, plan_view, dishes, have_map, done_map, extra_tasks, task_order, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id) DO UPDATE SET
         step = EXCLUDED.step,
         plan_view = EXCLUDED.plan_view,
         dishes = EXCLUDED.dishes,
         have_map = EXCLUDED.have_map,
         done_map = EXCLUDED.done_map,
         extra_tasks = EXCLUDED.extra_tasks,
         task_order = EXCLUDED.task_order,
         updated_at = CURRENT_TIMESTAMP
       RETURNING user_id, step, plan_view, dishes, have_map, done_map, extra_tasks, task_order, updated_at`,
      [
        req.user.id,
        step,
        planView,
        JSON.stringify(dishes),
        JSON.stringify(haveMap),
        JSON.stringify(doneMap),
        JSON.stringify(extraTasks),
        JSON.stringify(taskOrder),
      ],
    );
    res.json(rowToPlan(result.rows[0]));
  } catch (error) {
    console.error("Error saving production plan:", error);
    res.status(500).json({ error: "Error al guardar el plan de producción" });
  }
});

router.delete("/", async (req, res) => {
  try {
    await db.query("DELETE FROM production_plans WHERE user_id = $1", [
      req.user.id,
    ]);
    res.status(204).send();
  } catch (error) {
    console.error("Error deleting production plan:", error);
    res.status(500).json({ error: "Error al borrar el plan de producción" });
  }
});

export default router;
