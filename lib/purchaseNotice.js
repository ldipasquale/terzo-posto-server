export function validatePurchaseNoticeInput({
  paymentMethod,
  amountRaw,
  noteRaw,
  hasImage,
  mercadoPagoAccountId,
}) {
  if (!['efectivo', 'mercadopago'].includes(paymentMethod)) {
    return { error: 'Medio de pago inválido' };
  }
  if (
    paymentMethod === 'mercadopago' &&
    !String(mercadoPagoAccountId || '').trim()
  ) {
    return { error: 'Cuenta de Mercado Pago requerida' };
  }

  const note = String(noteRaw || '').trim();
  let amount = null;
  if (amountRaw != null && String(amountRaw).trim() !== '') {
    const parsed = Number(amountRaw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return { error: 'Monto inválido' };
    }
    amount = parsed;
  }

  if (!hasImage) {
    if (!note) return { error: 'Sin ticket hace falta una nota' };
    if (!(amount > 0)) return { error: 'Sin ticket hace falta el monto' };
  }

  return {
    value: {
      paymentMethod,
      mercadoPagoAccountId:
        paymentMethod === 'mercadopago'
          ? String(mercadoPagoAccountId).trim()
          : null,
      amount,
      note: note || null,
    },
  };
}
