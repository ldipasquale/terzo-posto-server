# Terzo Posto Backend

Backend server for the Terzo Posto Manager application.

## Setup

1. Install dependencies:
```bash
cd server
npm install
```

2. Start the server:
```bash
npm run dev
```

The server will start on `http://localhost:3001` by default.

## API Endpoints

### Authentication
- `POST /api/auth/login` - Login with email and password

### Orders
- `GET /api/orders` - Get all orders
- `GET /api/orders/:id` - Get order by ID
- `POST /api/orders` - Create new order
- `PATCH /api/orders/:id/status` - Update order status
- `DELETE /api/orders/:id` - Delete order

### Menu
- `GET /api/menu` - Get all menu items
- `GET /api/menu/:id` - Get menu item by ID
- `POST /api/menu` - Create menu item
- `PUT /api/menu/:id` - Update menu item
- `DELETE /api/menu/:id` - Delete menu item

### Settings
- `GET /api/settings/mercado-pago` - Get all Mercado Pago accounts
- `POST /api/settings/mercado-pago` - Create Mercado Pago account
- `PUT /api/settings/mercado-pago/:id` - Update Mercado Pago account
- `DELETE /api/settings/mercado-pago/:id` - Delete Mercado Pago account

## Authentication

All endpoints except `/api/auth/login` require authentication via JWT token in the Authorization header:
```
Authorization: Bearer <token>
```

## Database

The application uses SQLite for data persistence. The database file (`database.sqlite`) is created automatically on first run.

## Environment Variables

- `PORT` - Server port (default: 3001)
- `JWT_SECRET` - Secret key for JWT tokens (default: 'terzo-posto-secret-key-change-in-production')

## Default Credentials

- Email: `terzoposto@gmail.com`
- Password: `958`
