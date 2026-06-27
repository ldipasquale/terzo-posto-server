import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import authRoutes from './routes/auth.js';
import ordersRoutes from './routes/orders.js';
import menuRoutes from './routes/menu.js';
import settingsRoutes from './routes/settings.js';
import cashRegistersRoutes from './routes/cashRegisters.js';
import suppliesRoutes from './routes/supplies.js';
import openAccountsRoutes from './routes/openAccounts.js';
import agendaRoutes from './routes/agenda.js';
import financeRoutes from './routes/finance.js';
import purchasesRoutes from './routes/purchases.js';
import cupsRoutes from './routes/cups.js';
import promotionsRoutes from './routes/promotions.js';
import usersRoutes from './routes/users.js';
import { authenticateToken } from './middleware/auth.js';
import {
  requireAnyPermission,
} from './middleware/requirePermission.js';
import { PERMISSIONS } from './lib/userPermissions.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Public routes
app.use('/api/auth', authRoutes);

// Protected routes
app.use('/api/users', authenticateToken, usersRoutes);
app.use(
  '/api/orders',
  authenticateToken,
  requireAnyPermission(PERMISSIONS.COMANDAS),
  ordersRoutes,
);
app.use(
  '/api/menu',
  authenticateToken,
  requireAnyPermission(PERMISSIONS.COMANDAS, PERMISSIONS.BUFFET_GESTION),
  menuRoutes,
);
app.use('/api/settings', authenticateToken, settingsRoutes);
app.use(
  '/api/cash-registers',
  authenticateToken,
  requireAnyPermission(PERMISSIONS.COMANDAS),
  cashRegistersRoutes,
);
app.use(
  '/api/supplies',
  authenticateToken,
  requireAnyPermission(PERMISSIONS.BUFFET_GESTION),
  suppliesRoutes,
);
app.use(
  '/api/open-accounts',
  authenticateToken,
  requireAnyPermission(PERMISSIONS.COMANDAS),
  openAccountsRoutes,
);
app.use(
  '/api/agenda',
  authenticateToken,
  requireAnyPermission(PERMISSIONS.AGENDA),
  agendaRoutes,
);
app.use(
  '/api/finance',
  authenticateToken,
  requireAnyPermission(PERMISSIONS.FINANZAS),
  financeRoutes,
);
app.use(
  '/api/purchases',
  authenticateToken,
  requireAnyPermission(PERMISSIONS.BUFFET_GESTION),
  purchasesRoutes,
);
app.use(
  '/api/cups',
  authenticateToken,
  requireAnyPermission(PERMISSIONS.COMANDAS),
  cupsRoutes,
);
app.use(
  '/api/promotions',
  authenticateToken,
  requireAnyPermission(PERMISSIONS.COMANDAS, PERMISSIONS.BUFFET_GESTION),
  promotionsRoutes,
);

// Error handling
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
