/**
 * Calls OpenAI vision API to extract purchase line items from a receipt image.
 * Returns plain objects; supply matching happens on the client.
 */

const ALLOWED_UNITS = new Set(['g', 'ml', 'unidad']);

const SYSTEM_PROMPT = `Sos un asistente que lee tickets/facturas de compra de insumos (Argentina, español).
Devolvé SOLO un JSON válido con esta forma exacta (sin markdown):
{
  "provider": string | null,
  "notes": string | null,
  "items": [
    {
      "productName": string,
      "quantity": number,
      "presentationQuantity": number,
      "unit": "g" | "ml" | "unidad",
      "unitPrice": number,
      "lineTotal": number | null
    }
  ]
}

Reglas CRÍTICAS (el sistema guarda "Precio" = monto por línea de compra cuando quantity es 1, o precio por unidad de compra cuando quantity > 1):

1) Verdulería / balanza: "2,180 kg @ 1500$/kg" y el total de esa línea es 3270:
   - quantity = 1 (un pesaje; NUNCA pongas el peso en quantity).
   - presentationQuantity = gramos (2180).
   - unit = "g".
   - lineTotal = 3270 (importe total de la fila, columna derecha).
   - unitPrice = 3270 (igual a lineTotal si quantity es 1). NO uses 1500 (eso es precio por kg).

2) "4 U @ 2000$/U" total 8000: quantity=4, presentationQuantity=1, unit="unidad", lineTotal=8000, unitPrice=2000.

3) Siempre incluí lineTotal cuando figure el subtotal de la línea en el ticket.

4) Si quantity > 1 y todas las unidades valen lo mismo: unitPrice = lineTotal / quantity.

5) Gramos para peso, ml para líquidos.

6) quantity entero >= 1.

7) productName: texto del producto como en el ticket (mayúsculas ok).

8) Si no hay productos claros, items: [].`;

function coerceNumber(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = v.trim().replace(/\s/g, '').replace(',', '.');
    const n = Number(t);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const productName = String(raw.productName ?? raw.name ?? '').trim();
  if (!productName) return null;

  let unit = String(raw.unit ?? 'unidad').toLowerCase();
  if (!ALLOWED_UNITS.has(unit)) unit = 'unidad';

  let quantity = coerceNumber(raw.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) quantity = 1;

  // Model sometimes puts kg weight in quantity (e.g. 2.18); move to grams + quantity 1
  if (
    unit === 'g' &&
    quantity > 0 &&
    quantity < 200 &&
    quantity !== Math.floor(quantity)
  ) {
    const grams = Math.round(quantity * 1000);
    if (grams >= 10 && grams <= 500000) {
      quantity = 1;
      raw.presentationQuantity = grams;
    }
  }

  quantity = Math.max(1, Math.round(quantity));

  let presentationQuantity = coerceNumber(raw.presentationQuantity);
  if (!Number.isFinite(presentationQuantity) || presentationQuantity <= 0) {
    presentationQuantity = 1;
  }

  const lineTotal = coerceNumber(raw.lineTotal);

  let unitPrice = coerceNumber(raw.unitPrice);
  if (!Number.isFinite(unitPrice) || unitPrice < 0) unitPrice = 0;

  if (Number.isFinite(lineTotal) && lineTotal > 0 && quantity >= 1) {
    unitPrice = Math.round((lineTotal / quantity) * 100) / 100;
  }

  return {
    productName,
    quantity,
    presentationQuantity,
    unit,
    unitPrice,
  };
}

function validateAndNormalizePayload(parsed) {
  const provider =
    parsed.provider != null && String(parsed.provider).trim()
      ? String(parsed.provider).trim()
      : null;
  const notes =
    parsed.notes != null && String(parsed.notes).trim()
      ? String(parsed.notes).trim()
      : null;

  const rawItems = Array.isArray(parsed.items) ? parsed.items : [];
  const items = [];
  for (const r of rawItems) {
    const n = normalizeItem(r);
    if (n) items.push(n);
  }

  return { provider, notes, items };
}

export async function parsePurchaseTicketImage(buffer, mimeType) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const err = new Error('OPENAI_API_KEY no configurada');
    err.statusCode = 503;
    throw err;
  }

  const model = process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini';
  const base64 = buffer.toString('base64');
  const dataUrl = `data:${mimeType};base64,${base64}`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Extraé los productos del ticket y devolvé el JSON definido. Para cada línea incluí lineTotal (subtotal de la fila). En pesajes por kg, unitPrice debe ser el total de la línea si quantity es 1, no el precio por kg.',
            },
            {
              type: 'image_url',
              image_url: { url: dataUrl, detail: 'high' },
            },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error('OpenAI error:', res.status, text);
    const err = new Error('No se pudo analizar el ticket');
    err.statusCode = 502;
    throw err;
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') {
    const err = new Error('Respuesta inválida del servicio de análisis');
    err.statusCode = 502;
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    const err = new Error('No se pudo interpretar el ticket');
    err.statusCode = 422;
    throw err;
  }

  return validateAndNormalizePayload(parsed);
}
