import express from 'express';
import jwt from 'jsonwebtoken';

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'terzo-posto-secret-key-change-in-production';

// Static credentials
const VALID_EMAIL = 'terzoposto@gmail.com';
const VALID_PASSWORD = '958';

router.post('/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email y contraseña son requeridos' });
  }

  if (email.toLowerCase() !== VALID_EMAIL.toLowerCase()) {
    return res.status(401).json({ error: 'Usuario no encontrado' });
  }

  if (password !== VALID_PASSWORD) {
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }

  // Generate JWT token
  const token = jwt.sign(
    { 
      id: '1', 
      email: VALID_EMAIL, 
      name: 'Terzo Posto' 
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  res.json({
    token,
    user: {
      id: '1',
      email: VALID_EMAIL,
      name: 'Terzo Posto'
    }
  });
});

export default router;
