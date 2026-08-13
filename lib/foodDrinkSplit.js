/**
 * Proporción comida / bebida a partir de comandas.
 * Los vasos (neto) van aparte: monto fijo, fuera del porcentaje.
 * El ratio comida/bebida se usa para repartir el resto del cierre.
 */

function itemValue(row) {
  const qty = Number(row.quantity) || 0;
  const unit =
    row.promotion_group_id && row.promotion_unit_price != null
      ? Number(row.promotion_unit_price)
      : Number(row.price);
  if (!Number.isFinite(unit) || !Number.isFinite(qty)) return 0;
  return unit * qty;
}

/**
 * @param {Array<{ status: string, discount?: number|null, items: Array<{ type: string, price: number, quantity: number, promotion_group_id?: string|null, promotion_unit_price?: number|null }> }>} orders
 * @returns {{ food: number, drink: number }}
 */
export function computeFoodDrinkSplit(orders) {
  let food = 0;
  let drink = 0;
  for (const order of orders) {
    if (order.status === 'cancelled') continue;
    let orderFood = 0;
    let orderDrink = 0;
    for (const item of order.items || []) {
      const value = itemValue(item);
      if (item.type === 'bebida') orderDrink += value;
      else orderFood += value;
    }
    const gross = orderFood + orderDrink;
    if (gross <= 0) continue;
    const discount = Math.min(Math.max(0, Number(order.discount) || 0), gross);
    const factor = (gross - discount) / gross;
    food += orderFood * factor;
    drink += orderDrink * factor;
  }
  return { food, drink };
}

/**
 * Carga comandas de una caja y calcula food/drink.
 * @returns {Promise<{ food: number, drink: number }>}
 */
export async function getFoodDrinkSplitForCashRegister(client, cashRegisterId) {
  const { rows } = await client.query(
    `SELECT
       o.id AS order_id,
       o.status,
       o.discount,
       oi.type,
       oi.price,
       oi.quantity,
       oi.promotion_group_id,
       oi.promotion_unit_price
     FROM orders o
     LEFT JOIN order_items oi ON oi.order_id = o.id
     WHERE o.cash_register_id = $1`,
    [cashRegisterId],
  );

  const byOrder = new Map();
  for (const row of rows) {
    let order = byOrder.get(row.order_id);
    if (!order) {
      order = {
        status: row.status,
        discount: row.discount,
        items: [],
      };
      byOrder.set(row.order_id, order);
    }
    if (row.type != null) {
      order.items.push({
        type: row.type,
        price: row.price,
        quantity: row.quantity,
        promotion_group_id: row.promotion_group_id,
        promotion_unit_price: row.promotion_unit_price,
      });
    }
  }

  return computeFoodDrinkSplit([...byOrder.values()]);
}

/**
 * Neto de vasos retenidos en la caja (entregas − devoluciones).
 * @returns {Promise<number>}
 */
export async function getCupsNetForCashRegister(client, cashRegisterId) {
  try {
    const { rows } = await client.query(
      `SELECT
         COALESCE(SUM(CASE WHEN type = 'delivery' THEN amount ELSE 0 END), 0)::float
           - COALESCE(SUM(CASE WHEN type = 'return' THEN amount ELSE 0 END), 0)::float
           AS net
       FROM cup_movements
       WHERE cash_register_id = $1`,
      [cashRegisterId],
    );
    const net = Number(rows[0]?.net) || 0;
    return Math.max(0, net);
  } catch {
    return 0;
  }
}

/**
 * food + drink + cups neto (vasos = monto fijo, no peso %).
 * @returns {Promise<{ food: number, drink: number, cups: number }>}
 */
export async function getBuffetCloseSplitForCashRegister(client, cashRegisterId) {
  const [{ food, drink }, cups] = await Promise.all([
    getFoodDrinkSplitForCashRegister(client, cashRegisterId),
    getCupsNetForCashRegister(client, cashRegisterId),
  ]);
  return { food, drink, cups };
}

/**
 * Reparte el neto de vasos (monto fijo) entre varios pagos, proporcional al monto.
 * La suma de lo asignado es min(round(cupsNet), suma de montos).
 * @param {number[]} amounts
 * @param {number} cupsNet
 * @returns {number[]}
 */
export function allocateCupsAcrossAmounts(amounts, cupsNet) {
  const amts = amounts.map((a) => Math.max(0, Number(a) || 0));
  const total = amts.reduce((s, a) => s + a, 0);
  const target = Math.min(
    Math.max(0, Math.round(Number(cupsNet) || 0)),
    Math.round(total),
  );
  if (target <= 0 || total <= 0) return amts.map(() => 0);

  const out = [];
  let allocated = 0;
  for (let i = 0; i < amts.length; i++) {
    let share;
    if (i === amts.length - 1) {
      share = target - allocated;
    } else {
      share = Math.round((amts[i] / total) * target);
    }
    share = Math.max(0, Math.min(amts[i], share));
    out.push(share);
    allocated += share;
  }

  let missing = target - allocated;
  if (missing > 0) {
    for (let i = amts.length - 1; i >= 0 && missing > 0; i--) {
      const room = amts[i] - out[i];
      if (room <= 0) continue;
      const add = Math.min(room, missing);
      out[i] += add;
      missing -= add;
    }
  }
  return out;
}

/**
 * Redondea a múltiplo de $5 (más legible en caja). El otro lado absorbe el resto
 * para que food + drink === total.
 */
function roundFoodKeepSum(foodExact, total) {
  if (!Number.isFinite(total) || total <= 0) return { foodAmount: 0, drinkAmount: 0 };
  if (!Number.isFinite(foodExact) || foodExact <= 0) {
    return { foodAmount: 0, drinkAmount: total };
  }
  if (foodExact >= total) {
    return { foodAmount: total, drinkAmount: 0 };
  }
  let foodAmount = Math.round(foodExact / 5) * 5;
  if (foodAmount > total) foodAmount = Math.round(total / 5) * 5;
  if (foodAmount > total) foodAmount = total;
  if (foodAmount < 0) foodAmount = 0;
  return { foodAmount, drinkAmount: total - foodAmount };
}

/**
 * Reparte `amount` del cierre:
 * 1) vasos = monto fijo (`cups` absoluto para este pago), fuera del %
 * 2) el resto se reparte por proporción comida/bebida, redondeando a $5
 * Si no hay pesos comida/bebida, el resto va a bebida (Bar).
 * @returns {{ foodAmount: number, drinkAmount: number, cupsAmount: number }}
 */
export function splitAmountByFoodDrinkCups(amount, food, drink, cups) {
  if (!Number.isFinite(amount) || amount <= 0) {
    return { foodAmount: 0, drinkAmount: 0, cupsAmount: 0 };
  }
  const cupsAmount = Math.min(
    Math.max(0, Math.round(Number(cups) || 0)),
    amount,
  );
  const remainder = amount - cupsAmount;
  if (remainder <= 0) {
    return { foodAmount: 0, drinkAmount: 0, cupsAmount: amount };
  }

  const foodW = Math.max(0, Number(food) || 0);
  const drinkW = Math.max(0, Number(drink) || 0);
  const w = foodW + drinkW;
  if (w <= 0) {
    return { foodAmount: 0, drinkAmount: remainder, cupsAmount };
  }
  const foodExact = (remainder * foodW) / w;
  const { foodAmount, drinkAmount } = roundFoodKeepSum(foodExact, remainder);
  return { foodAmount, drinkAmount, cupsAmount };
}

/**
 * @deprecated usar splitAmountByFoodDrinkCups
 * @returns {{ foodAmount: number, drinkAmount: number }}
 */
export function splitAmountByFoodDrink(amount, food, drink) {
  const { foodAmount, drinkAmount } = splitAmountByFoodDrinkCups(
    amount,
    food,
    drink,
    0,
  );
  return { foodAmount, drinkAmount };
}
