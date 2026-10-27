import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import express from 'express';
import multer from 'multer';
import db from '../database.js';
import {
  ensurePurchaseNoticesDir,
  isReceiptFileName,
  purchaseNoticesDir,
  receiptExtension,
} from '../lib/eventTickets.js';
import { validatePurchaseNoticeInput } from '../lib/purchaseNotice.js';

const router = express.Router();

const IMAGE_MIME = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);

const noticeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!IMAGE_MIME.has(String(file.mimetype || '').toLowerCase())) {
      cb(new Error('Solo se permiten imágenes JPEG, PNG o WebP'));
      return;
    }
    cb(null, true);
  },
});

function uploadSingle(req, res, next) {
  noticeUpload.single('image')(req, res, (err) => {
    if (err) {
      const msg =
        err.code === 'LIMIT_FILE_SIZE'
          ? 'La imagen supera el tamaño máximo (12 MB)'
          : err.message || 'Error al subir la imagen';
      return res.status(400).json({ error: msg });
    }
    next();
  });
}

function mapNotice(row) {
  return {
    id: row.id,
    createdAt: new Date(row.created_at).toISOString(),
    authorName: row.author_name,
    paymentMethod: row.payment_method,
    mercadoPagoAccountId: row.mercado_pago_account_id || undefined,
    amount: row.amount == null ? null : Number(row.amount),
    note: row.note || undefined,
    hasImage: Boolean(row.image_file),
  };
}

function removeNoticeImage(fileName) {
  if (!fileName || !isReceiptFileName(fileName)) return;
  fs.rmSync(path.join(purchaseNoticesDir(), fileName), { force: true });
}

router.get('/', async (_req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM purchase_notices ORDER BY created_at ASC`,
    );
    res.json(result.rows.map(mapNotice));
  } catch (error) {
    console.error('Error fetching purchase notices:', error);
    res.status(500).json({ error: 'Error al obtener avisos' });
  }
});

router.post('/', uploadSingle, async (req, res) => {
  const parsed = validatePurchaseNoticeInput({
    paymentMethod: req.body?.paymentMethod,
    amountRaw: req.body?.amount,
    noteRaw: req.body?.note,
    hasImage: Boolean(req.file?.buffer),
    mercadoPagoAccountId: req.body?.mercadoPagoAccountId,
  });
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }

  const notice = parsed.value;
  if (notice.paymentMethod === 'mercadopago') {
    const account = await db.query(
      `SELECT id FROM mercado_pago_accounts
       WHERE id = $1 AND id <> 'efectivo' AND COALESCE(active, 1) = 1
         AND COALESCE(kind, 'mercadopago') = 'mercadopago'`,
      [notice.mercadoPagoAccountId],
    );
    if (account.rows.length === 0) {
      return res.status(400).json({ error: 'Cuenta de pago inválida' });
    }
  }

  const id = crypto.randomUUID();
  let imageFile = null;
  if (req.file?.buffer) {
    const dir = ensurePurchaseNoticesDir();
    imageFile = `${id}.${receiptExtension(req.file.mimetype)}`;
    fs.writeFileSync(path.join(dir, imageFile), req.file.buffer);
  }

  try {
    const authorName = String(req.user?.name || '').trim() || 'Alguien';
    const created = await db.query(
      `INSERT INTO purchase_notices
        (id, created_by, author_name, payment_method, mercado_pago_account_id, amount, note, image_file)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        id,
        req.user?.id || null,
        authorName,
        notice.paymentMethod,
        notice.mercadoPagoAccountId,
        notice.amount,
        notice.note,
        imageFile,
      ],
    );
    res.status(201).json(mapNotice(created.rows[0]));
  } catch (error) {
    removeNoticeImage(imageFile);
    console.error('Error creating purchase notice:', error);
    res.status(500).json({ error: 'Error al guardar el aviso' });
  }
});

router.get('/:id/image', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT image_file FROM purchase_notices WHERE id = $1',
      [req.params.id],
    );
    const fileName = result.rows[0]?.image_file;
    if (!fileName || !isReceiptFileName(fileName)) {
      return res.status(404).json({ error: 'Foto no encontrada' });
    }
    const filePath = path.join(purchaseNoticesDir(), fileName);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Foto no encontrada' });
    }
    res.sendFile(filePath);
  } catch (error) {
    console.error('Error reading purchase notice image:', error);
    res.status(500).json({ error: 'Error al leer la foto' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await db.query(
      'DELETE FROM purchase_notices WHERE id = $1 RETURNING image_file',
      [req.params.id],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Aviso no encontrado' });
    }
    removeNoticeImage(result.rows[0].image_file);
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting purchase notice:', error);
    res.status(500).json({ error: 'Error al descartar el aviso' });
  }
});

export default router;
