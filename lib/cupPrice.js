/**
 * Precio unitario depósito vasos (ARS). Alinear con `ui/src/lib/constants.ts`.
 */
export function getCupPrice() {
  const n = Number(process.env.CUP_PRICE);
  return Number.isFinite(n) && n > 0 ? n : 2000;
}
