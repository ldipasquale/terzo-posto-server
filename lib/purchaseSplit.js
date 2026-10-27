/**
 * Reparte el neto de una compra según el subtotal de cada rubro.
 * Un rubro en cero no recibe monto. El último rubro con peso se queda
 * con el resto, para que la suma cierre en centavos.
 * Orden esperado: bebida, limpieza, comida.
 */
export function allocatePurchaseNet(net, weights) {
  const amounts = {};
  for (const weight of weights) amounts[weight.key] = 0;

  const total = Number(net);
  if (!Number.isFinite(total) || total <= 0) return amounts;

  const positive = weights.filter((weight) => Number(weight.sub) > 0);
  if (positive.length === 0) return amounts;
  if (positive.length === 1) {
    amounts[positive[0].key] = Math.round(total * 100) / 100;
    return amounts;
  }

  const base = positive.reduce((sum, weight) => sum + Number(weight.sub), 0);
  let allocated = 0;
  for (let i = 0; i < positive.length - 1; i++) {
    const amount = Math.round(((total * Number(positive[i].sub)) / base) * 100) / 100;
    amounts[positive[i].key] = amount;
    allocated += amount;
  }
  const last = positive[positive.length - 1];
  amounts[last.key] = Math.round((total - allocated) * 100) / 100;
  return amounts;
}
