import crypto from 'crypto';
import express from 'express';
import db from '../database.js';

const router = express.Router();

function mapPurchase(row) {
  const items = Array.isArray(row.items_json)
    ? row.items_json
    : row.items_json
      ? JSON.parse(row.items_json)
      : [];
  return {
    id: row.id,
    date: new Date(row.date).toISOString(),
    items: items.map((it) => ({
      supplyId: it.supplyId,
      supplyName: it.supplyName,
      quantity: Number(it.quantity),
      presentationQuantity:
        it.presentationQuantity == null
          ? Number(it.quantity)
          : Number(it.presentationQuantity),
      unit: it.unit || undefined,
      unitPrice: Number(it.unitPrice),
      previousPrice:
        it.previousPrice == null ? null : Number(it.previousPrice),
    })),
    subtotal: Number(row.subtotal),
    discount: Number(row.discount),
    total: Number(row.total),
    paymentMethod: row.payment_method,
    mercadoPagoAccountId: row.mercado_pago_account_id || undefined,
    category: row.category,
    provider: row.provider || '',
    notes: row.notes || undefined,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

const purchaseSelect = `
  SELECT
    p.*,
    (
      SELECT COALESCE(
        json_agg(
          json_build_object(
            'supplyId', pi.supply_id,
            'supplyName', pi.supply_name,
            'quantity', pi.quantity,
            'presentationQuantity', pi.presentation_quantity,
            'unit', pi.presentation_unit,
            'unitPrice', pi.unit_price,
            'previousPrice', pi.previous_price
          )
          ORDER BY pi.id ASC
        ),
        '[]'::json
      )
      FROM buffet_purchase_items pi
      WHERE pi.purchase_id = p.id
    ) AS items_json
  FROM buffet_purchases p
`;

router.get('/', async (_req, res) => {
  try {
    const result = await db.query(`${purchaseSelect} ORDER BY p.date DESC, p.created_at DESC`);
    res.json(result.rows.map(mapPurchase));
  } catch (error) {
    console.error('Error fetching purchases:', error);
    res.status(500).json({ error: 'Error al obtener compras' });
  }
});

router.post('/', async (req, res) => {
  const client = await db.connect();
  try {
    const p = req.body;
    if (!Array.isArray(p?.items) || p.items.length === 0) {
      return res.status(400).json({ error: 'La compra debe tener al menos un ítem' });
    }
    if (!p?.paymentMethod || !['efectivo', 'mercadopago'].includes(p.paymentMethod)) {
      return res.status(400).json({ error: 'Medio de pago inválido' });
    }
    if (!p?.category || !['comida', 'bebida'].includes(p.category)) {
      return res.status(400).json({ error: 'Categoría inválida' });
    }

    const id = crypto.randomUUID();
    const date = p.date || new Date().toISOString();
    const subtotal = Number(p.subtotal) || 0;
    const discount = Number(p.discount) || 0;
    const total = Number(p.total) || Math.max(0, subtotal - discount);
    const provider = String(p.provider || '').trim();
    const notes = p.notes ? String(p.notes).trim() : null;

    await client.query('BEGIN');
    await client.query(
      `INSERT INTO buffet_purchases
      (id, date, subtotal, discount, total, payment_method, mercado_pago_account_id, category, provider, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        id,
        date,
        subtotal,
        discount,
        total,
        p.paymentMethod,
        p.paymentMethod === 'mercadopago' ? p.mercadoPagoAccountId ?? null : null,
        p.category,
        provider || null,
        notes,
      ],
    );

    for (const item of p.items) {
      if (!item?.supplyId || Number(item.quantity) <= 0 || Number(item.unitPrice) < 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Ítem de compra inválido' });
      }
      const presentationQuantity =
        item.presentationQuantity == null
          ? Number(item.quantity)
          : Number(item.presentationQuantity);
      const unit =
        item.unit == null || ['g', 'ml', 'unidad'].includes(item.unit)
          ? item.unit ?? null
          : null;
      await client.query(
        `INSERT INTO buffet_purchase_items
        (purchase_id, supply_id, supply_name, quantity, presentation_quantity, presentation_unit, unit_price, unit_price_per_unit, previous_price)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          id,
          String(item.supplyId),
          String(item.supplyName || ''),
          Number(item.quantity),
          presentationQuantity,
          unit,
          Number(item.unitPrice),
          Number(item.unitPrice),
          item.previousPrice == null ? null : Number(item.previousPrice),
        ],
      );
    }

    await client.query('COMMIT');
    const created = await db.query(`${purchaseSelect} WHERE p.id = $1`, [id]);
    res.status(201).json(mapPurchase(created.rows[0]));
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating purchase:', error);
    res.status(500).json({ error: 'Error al crear compra' });
  } finally {
    client.release();
  }
});

export default router;
