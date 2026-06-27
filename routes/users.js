import express from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import db from '../database.js';
import { ALL_PERMISSIONS, parsePermissionsJson } from '../lib/userPermissions.js';
import { requireAdminMiddleware } from '../middleware/requirePermission.js';

const router = express.Router();

function formatUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    active: Boolean(row.active),
    isAdmin: Boolean(row.is_admin),
    permissions: parsePermissionsJson(row.permissions),
    defaultMercadoPagoAccountId: row.default_mercado_pago_account_id || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizePermissions(permissions) {
  if (permissions === undefined || permissions === null) {
    return { permissions: [] };
  }
  if (!Array.isArray(permissions)) {
    return { error: 'permissions debe ser un arreglo' };
  }
  const normalized = [...new Set(permissions.map(String))].filter((p) =>
    ALL_PERMISSIONS.includes(p),
  );
  return { permissions: normalized };
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

router.use(requireAdminMiddleware);

router.get('/', async (_req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, email, active, is_admin, permissions,
              default_mercado_pago_account_id, created_at, updated_at
       FROM app_users
       ORDER BY name ASC, email ASC`,
    );
    res.json(result.rows.map(formatUser));
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Error al obtener usuarios' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, email, password, active, isAdmin, permissions } = req.body;
    const normalizedEmail = normalizeEmail(email);

    if (!name?.trim() || !normalizedEmail || !password) {
      return res
        .status(400)
        .json({ error: 'Nombre, email y contraseña son requeridos' });
    }
    if (password.length < 4) {
      return res
        .status(400)
        .json({ error: 'La contraseña debe tener al menos 4 caracteres' });
    }

    const permResult = normalizePermissions(permissions);
    if (permResult.error) {
      return res.status(400).json({ error: permResult.error });
    }

    const existing = await db.query(
      'SELECT id FROM app_users WHERE LOWER(email) = LOWER($1) LIMIT 1',
      [normalizedEmail],
    );
    if (existing.rows[0]) {
      return res.status(400).json({ error: 'Ya existe un usuario con ese email' });
    }

    const id = `user-${crypto.randomUUID()}`;
    const passwordHash = await bcrypt.hash(password, 10);
    const adminFlag = isAdmin ? 1 : 0;
    const activeFlag = active === false ? 0 : 1;

    await db.query(
      `INSERT INTO app_users
         (id, name, email, password_hash, active, is_admin, permissions, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        id,
        name.trim(),
        normalizedEmail,
        passwordHash,
        activeFlag,
        adminFlag,
        JSON.stringify(adminFlag ? [] : permResult.permissions),
      ],
    );

    const created = await db.query(
      `SELECT id, name, email, active, is_admin, permissions,
              default_mercado_pago_account_id, created_at, updated_at
       FROM app_users WHERE id = $1`,
      [id],
    );
    res.status(201).json(formatUser(created.rows[0]));
  } catch (error) {
    console.error('Error creating user:', error);
    res.status(500).json({ error: 'Error al crear usuario' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, password, active, isAdmin, permissions } = req.body;

    const existing = await db.query(
      `SELECT id, name, email, active, is_admin, permissions,
              default_mercado_pago_account_id, created_at, updated_at
       FROM app_users WHERE id = $1`,
      [id],
    );
    if (!existing.rows[0]) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const permResult = normalizePermissions(permissions);
    if (permResult.error) {
      return res.status(400).json({ error: permResult.error });
    }

    const normalizedEmail = email ? normalizeEmail(email) : existing.rows[0].email;
    if (!name?.trim()) {
      return res.status(400).json({ error: 'El nombre es requerido' });
    }

    const emailConflict = await db.query(
      'SELECT id FROM app_users WHERE LOWER(email) = LOWER($1) AND id != $2 LIMIT 1',
      [normalizedEmail, id],
    );
    if (emailConflict.rows[0]) {
      return res.status(400).json({ error: 'Ya existe otro usuario con ese email' });
    }

    if (req.user?.id === id && isAdmin === false) {
      return res
        .status(400)
        .json({ error: 'No podés quitarte el rol de administrador' });
    }
    if (req.user?.id === id && active === false) {
      return res
        .status(400)
        .json({ error: 'No podés desactivar tu propia cuenta' });
    }

    const adminFlag = isAdmin ? 1 : 0;
    const activeFlag = active === false ? 0 : 1;
    const nextPermissions = adminFlag ? [] : permResult.permissions;

    let passwordHash = null;
    if (password) {
      if (password.length < 4) {
        return res
          .status(400)
          .json({ error: 'La contraseña debe tener al menos 4 caracteres' });
      }
      passwordHash = await bcrypt.hash(password, 10);
    }

    if (passwordHash) {
      await db.query(
        `UPDATE app_users
         SET name = $1,
             email = $2,
             password_hash = $3,
             active = $4,
             is_admin = $5,
             permissions = $6::jsonb,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $7`,
        [
          name.trim(),
          normalizedEmail,
          passwordHash,
          activeFlag,
          adminFlag,
          JSON.stringify(nextPermissions),
          id,
        ],
      );
    } else {
      await db.query(
        `UPDATE app_users
         SET name = $1,
             email = $2,
             active = $3,
             is_admin = $4,
             permissions = $5::jsonb,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $6`,
        [
          name.trim(),
          normalizedEmail,
          activeFlag,
          adminFlag,
          JSON.stringify(nextPermissions),
          id,
        ],
      );
    }

    const updated = await db.query(
      `SELECT id, name, email, active, is_admin, permissions,
              default_mercado_pago_account_id, created_at, updated_at
       FROM app_users WHERE id = $1`,
      [id],
    );
    res.json(formatUser(updated.rows[0]));
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({ error: 'Error al actualizar usuario' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (req.user?.id === id) {
      return res.status(400).json({ error: 'No podés eliminar tu propia cuenta' });
    }

    const result = await db.query(
      'DELETE FROM app_users WHERE id = $1 RETURNING id',
      [id],
    );
    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    res.status(204).send();
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ error: 'Error al eliminar usuario' });
  }
});

export default router;
