import crypto from 'crypto';

const AMOUNT_TOLERANCE = 0.02;

/**
 * @param {unknown} payments
 * @param {number} expectedTotal
 * @returns {{ error: string } | { payments: Array<{ amount: number, paymentMethod: 'efectivo' | 'mercadopago', mercadoPagoAccountId: string | null }> }}
 */
export function parseSplitPayments(payments, expectedTotal) {
  const total = Number(expectedTotal);
  if (!Number.isFinite(total) || total <= 0) {
    return { error: 'El pago mixto requiere un total mayor a 0' };
  }
  if (!Array.isArray(payments) || payments.length !== 2) {
    return {
      error: 'El pago mixto requiere una parte en efectivo y una en Mercado Pago',
    };
  }

  const cash = payments.find((p) => p?.paymentMethod === 'efectivo');
  const mp = payments.find((p) => p?.paymentMethod === 'mercadopago');
  if (!cash || !mp) {
    return {
      error: 'El pago mixto requiere una parte en efectivo y una en Mercado Pago',
    };
  }

  const cashAmount = Number(cash.amount);
  const mpAmount = Number(mp.amount);
  if (
    !Number.isFinite(cashAmount) ||
    !Number.isFinite(mpAmount) ||
    cashAmount <= 0 ||
    mpAmount <= 0
  ) {
    return { error: 'Cada medio de pago debe tener un monto mayor a 0' };
  }

  if (Math.abs(cashAmount + mpAmount - total) > AMOUNT_TOLERANCE) {
    return { error: 'La suma de los pagos no coincide con el total a cobrar' };
  }

  const mercadoPagoAccountId =
    typeof mp.mercadoPagoAccountId === 'string'
      ? mp.mercadoPagoAccountId.trim()
      : '';
  if (!mercadoPagoAccountId || mercadoPagoAccountId === 'efectivo') {
    return { error: 'mercadoPagoAccountId requerido para la parte de Mercado Pago' };
  }

  return {
    payments: [
      {
        amount: cashAmount,
        paymentMethod: 'efectivo',
        mercadoPagoAccountId: null,
      },
      {
        amount: mpAmount,
        paymentMethod: 'mercadopago',
        mercadoPagoAccountId,
      },
    ],
  };
}

export function formatPaymentRow(row) {
  return {
    id: row.id,
    amount: Number(row.amount),
    paymentMethod: row.payment_method,
    mercadoPagoAccountId: row.mercado_pago_account_id || undefined,
  };
}

/**
 * @param {import('pg').PoolClient} client
 * @param {{ orderId?: string | null, openAccountId?: string | null, payments: Array<{ amount: number, paymentMethod: string, mercadoPagoAccountId?: string | null }> }} args
 */
export async function insertBuffetPayments(client, { orderId, openAccountId, payments }) {
  const hasOrder = Boolean(orderId);
  const hasAccount = Boolean(openAccountId);
  if (hasOrder === hasAccount) {
    throw new Error('insertBuffetPayments requiere orderId o openAccountId');
  }

  for (const p of payments) {
    await client.query(
      `INSERT INTO buffet_payments (
         id, order_id, open_account_id, amount, payment_method, mercado_pago_account_id
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        crypto.randomUUID(),
        hasOrder ? orderId : null,
        hasAccount ? openAccountId : null,
        p.amount,
        p.paymentMethod,
        p.paymentMethod === 'mercadopago' ? p.mercadoPagoAccountId || null : null,
      ],
    );
  }
}
