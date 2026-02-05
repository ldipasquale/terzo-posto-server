import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const db = new Database(join(__dirname, 'database.sqlite'));

// Enable foreign keys
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  -- Menu items table
  CREATE TABLE IF NOT EXISTS menu_items (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    price REAL NOT NULL,
    category TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('comida', 'bebida')),
    available INTEGER NOT NULL DEFAULT 1,
    popular INTEGER NOT NULL DEFAULT 0,
    portions INTEGER NOT NULL DEFAULT 1,
    recipe TEXT NOT NULL DEFAULT '[]',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Orders table
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    customer_name TEXT NOT NULL,
    total REAL NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'preparing', 'ready', 'delivered')),
    payment_method TEXT NOT NULL CHECK(payment_method IN ('efectivo', 'mercadopago')),
    mercado_pago_account_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (mercado_pago_account_id) REFERENCES mercado_pago_accounts(id)
  );

  -- Order items table (stores snapshots of menu items at order time)
  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL,
    menu_item_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    price REAL NOT NULL,
    category TEXT NOT NULL,
    type TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    notes TEXT,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
  );

  -- Mercado Pago accounts table
  CREATE TABLE IF NOT EXISTS mercado_pago_accounts (
    id TEXT PRIMARY KEY,
    holder TEXT NOT NULL,
    alias TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Settings table (for future use)
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Migration: add portions and recipe columns if they don't exist (existing DBs)
const menuTableInfo = db.prepare("PRAGMA table_info(menu_items)").all();
const hasPortions = menuTableInfo.some((col) => col.name === 'portions');
const hasRecipe = menuTableInfo.some((col) => col.name === 'recipe');
if (!hasPortions) {
  db.exec('ALTER TABLE menu_items ADD COLUMN portions INTEGER NOT NULL DEFAULT 1');
}
if (!hasRecipe) {
  db.exec("ALTER TABLE menu_items ADD COLUMN recipe TEXT NOT NULL DEFAULT '[]'");
}

// Migration: add snapshot columns to order_items table
const orderItemsTableInfo = db.prepare("PRAGMA table_info(order_items)").all();
const hasName = orderItemsTableInfo.some((col) => col.name === 'name');
const hasDescription = orderItemsTableInfo.some((col) => col.name === 'description');
const hasPrice = orderItemsTableInfo.some((col) => col.name === 'price');
const hasCategory = orderItemsTableInfo.some((col) => col.name === 'category');
const hasType = orderItemsTableInfo.some((col) => col.name === 'type');

if (!hasName || !hasDescription || !hasPrice || !hasCategory || !hasType) {
  // For existing databases, we need to migrate data from menu_items
  // First add the columns if they don't exist
  if (!hasName) db.exec("ALTER TABLE order_items ADD COLUMN name TEXT NOT NULL DEFAULT ''");
  if (!hasDescription) db.exec("ALTER TABLE order_items ADD COLUMN description TEXT NOT NULL DEFAULT ''");
  if (!hasPrice) db.exec("ALTER TABLE order_items ADD COLUMN price REAL NOT NULL DEFAULT 0");
  if (!hasCategory) db.exec("ALTER TABLE order_items ADD COLUMN category TEXT NOT NULL DEFAULT ''");
  if (!hasType) db.exec("ALTER TABLE order_items ADD COLUMN type TEXT NOT NULL DEFAULT 'comida'");

  // Populate the new columns from menu_items for existing records
  db.exec(`
    UPDATE order_items
    SET
      name = (SELECT name FROM menu_items WHERE id = order_items.menu_item_id),
      description = (SELECT description FROM menu_items WHERE id = order_items.menu_item_id),
      price = (SELECT price FROM menu_items WHERE id = order_items.menu_item_id),
      category = (SELECT category FROM menu_items WHERE id = order_items.menu_item_id),
      type = (SELECT type FROM menu_items WHERE id = order_items.menu_item_id)
    WHERE menu_item_id IN (SELECT id FROM menu_items)
  `);
}

// Initialize default menu items if table is empty
const menuCount = db.prepare('SELECT COUNT(*) as count FROM menu_items').get();
if (menuCount.count === 0) {
  const insertMenu = db.prepare(`
    INSERT INTO menu_items (id, name, description, price, category, type, available, popular, portions, recipe)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const defaultMenuItems = [
    ['1', 'Pizza Margherita', 'Tomates frescos, mozzarella, albahaca', 18.00, 'Principales', 'comida', 1, 1, 1, '[]'],
    ['2', 'Ensalada César', 'Lechuga romana, parmesano, crutones, aderezo césar', 14.00, 'Entradas', 'comida', 1, 0, 1, '[]'],
    ['3', 'Salmón a la Plancha', 'Salmón atlántico, vegetales de temporada, mantequilla de limón', 32.00, 'Principales', 'comida', 1, 1, 1, '[]'],
    ['4', 'Pasta Carbonara', 'Espagueti, panceta, huevo, parmesano', 22.00, 'Principales', 'comida', 1, 0, 4, '[]'],
    ['5', 'Tiramisú', 'Postre italiano clásico con mascarpone', 9.00, 'Postres', 'comida', 1, 0, 8, '[]'],
    ['6', 'Bistec de Res', 'Corte premium 12oz, mantequilla de hierbas, papas asadas', 48.00, 'Principales', 'comida', 0, 0, 1, '[]'],
    ['7', 'Papas Trufadas', 'Papas a mano, aceite de trufa, parmesano', 12.00, 'Acompañamientos', 'comida', 1, 0, 1, '[]'],
    ['8', 'Risotto de Hongos', 'Arroz arborio, hongos silvestres, vino blanco', 24.00, 'Principales', 'comida', 1, 0, 1, '[]'],
    ['9', 'Vino de la Casa', 'Tinto o blanco, por copa', 10.00, 'Bebidas', 'bebida', 1, 0, 1, '[]'],
    ['10', 'Volcán de Chocolate', 'Pastel de chocolate caliente con helado de vainilla', 11.00, 'Postres', 'comida', 1, 1, 1, '[]'],
    ['11', 'Cerveza Artesanal', 'Selección de cervezas locales', 8.00, 'Bebidas', 'bebida', 1, 0, 1, '[]'],
    ['12', 'Margarita', 'Tequila, triple sec, limón fresco', 12.00, 'Bebidas', 'bebida', 1, 1, 1, '[]'],
    ['13', 'Mojito', 'Ron, menta, limón, agua mineral', 11.00, 'Bebidas', 'bebida', 1, 0, 1, '[]'],
    ['14', 'Café Americano', 'Café recién molido', 4.00, 'Bebidas', 'bebida', 1, 0, 1, '[]'],
  ];

  const insertMany = db.transaction((items) => {
    for (const item of items) {
      insertMenu.run(...item);
    }
  });

  insertMany(defaultMenuItems);
}

export default db;
