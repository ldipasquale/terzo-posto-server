import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePurchaseNoticeInput } from './purchaseNotice.js';

test('con foto el monto y la nota pueden faltar', () => {
  const result = validatePurchaseNoticeInput({
    paymentMethod: 'efectivo',
    amountRaw: '',
    noteRaw: '  ',
    hasImage: true,
    mercadoPagoAccountId: null,
  });
  assert.deepEqual(result.value, {
    paymentMethod: 'efectivo',
    mercadoPagoAccountId: null,
    amount: null,
    note: null,
  });
});

test('sin foto exige monto y nota', () => {
  const missing = validatePurchaseNoticeInput({
    paymentMethod: 'efectivo',
    amountRaw: '',
    noteRaw: 'chino',
    hasImage: false,
  });
  assert.equal(missing.error, 'Sin ticket hace falta el monto');

  const ok = validatePurchaseNoticeInput({
    paymentMethod: 'mercadopago',
    amountRaw: '18500',
    noteRaw: ' 2 leches ',
    hasImage: false,
    mercadoPagoAccountId: 'mp-1',
  });
  assert.equal(ok.value.amount, 18500);
  assert.equal(ok.value.note, '2 leches');
  assert.equal(ok.value.mercadoPagoAccountId, 'mp-1');
});

test('mercado pago sin cuenta no pasa', () => {
  const result = validatePurchaseNoticeInput({
    paymentMethod: 'mercadopago',
    amountRaw: '100',
    noteRaw: 'cafe',
    hasImage: false,
    mercadoPagoAccountId: '  ',
  });
  assert.equal(result.error, 'Cuenta de Mercado Pago requerida');
});
