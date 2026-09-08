import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import db from '../database.js';
import { parsePermissionsJson } from '../lib/userPermissions.js';
import { authenticateToken } from '../middleware/auth.js';
import { formatUser } from './users.js';

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'terzo-posto-secret-key-change-in-production';

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email y contraseña son requeridos' });
  }

  try {
    const result = await db.query(
      `SELECT id, name, email, password_hash, default_mercado_pago_account_id,
              active, is_admin, permissions, photo_file
       FROM app_users
       WHERE LOWER(email) = LOWER($1)
       LIMIT 1`,
      [email],
    );
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: 'Usuario no encontrado' });
    }
    if (!user.active) {
      return res.status(401).json({ error: 'Usuario inactivo' });
    }

    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }

    const tokenPayload = {
      id: user.id,
      email: user.email,
      name: user.name,
      defaultMercadoPagoAccountId: user.default_mercado_pago_account_id || undefined,
      isAdmin: Boolean(user.is_admin),
      permissions: parsePermissionsJson(user.permissions),
      photoUrl: user.photo_file
        ? `/api/public/user-photos/${user.photo_file}`
        : null,
    };

    const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      token,
      user: tokenPayload,
    });
  } catch (error) {
    console.error('Error in /auth/login:', error);
    return res.status(500).json({ error: 'Error al iniciar sesión' });
  }
});

router.get('/me', authenticateToken, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, email, active, is_admin, permissions,
              default_mercado_pago_account_id, photo_file, created_at, updated_at
       FROM app_users WHERE id = $1`,
      [req.user.id],
    );
    const row = result.rows[0];
    if (!row || !row.active) {
      return res.status(401).json({ error: 'Usuario no encontrado' });
    }
    res.json(formatUser(row));
  } catch (error) {
    console.error('Error in /auth/me:', error);
    return res.status(500).json({ error: 'Error al obtener el usuario' });
  }
});

export default router;
