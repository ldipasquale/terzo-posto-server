import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import authRoutes from './routes/auth.js';
import ordersRoutes from './routes/orders.js';
import menuRoutes from './routes/menu.js';
import settingsRoutes from './routes/settings.js';
import cashRegistersRoutes from './routes/cashRegisters.js';
import { authenticateToken } from './middleware/auth.js';

console.log('BOOTING...');
console.log('PORT =', process.env.PORT);
const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// // Public routes
// app.use('/api/auth', authRoutes);

// // Protected routes
// app.use('/api/orders', authenticateToken, ordersRoutes);
// app.use('/api/menu', authenticateToken, menuRoutes);
// app.use('/api/settings', authenticateToken, settingsRoutes);
// app.use('/api/cash-registers', authenticateToken, cashRegistersRoutes);

// Error handling
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
