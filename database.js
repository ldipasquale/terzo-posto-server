import Database from "better-sqlite3";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const db = new Database(join(__dirname, "database.sqlite"));

// Enable foreign keys
db.pragma("foreign_keys = ON");

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
const hasPortions = menuTableInfo.some((col) => col.name === "portions");
const hasRecipe = menuTableInfo.some((col) => col.name === "recipe");
if (!hasPortions) {
  db.exec(
    "ALTER TABLE menu_items ADD COLUMN portions INTEGER NOT NULL DEFAULT 1",
  );
}
if (!hasRecipe) {
  db.exec(
    "ALTER TABLE menu_items ADD COLUMN recipe TEXT NOT NULL DEFAULT '[]'",
  );
}

// Migration: add snapshot columns to order_items table
const orderItemsTableInfo = db.prepare("PRAGMA table_info(order_items)").all();
const hasName = orderItemsTableInfo.some((col) => col.name === "name");
const hasDescription = orderItemsTableInfo.some(
  (col) => col.name === "description",
);
const hasPrice = orderItemsTableInfo.some((col) => col.name === "price");
const hasCategory = orderItemsTableInfo.some((col) => col.name === "category");
const hasType = orderItemsTableInfo.some((col) => col.name === "type");

if (!hasName || !hasDescription || !hasPrice || !hasCategory || !hasType) {
  // For existing databases, we need to migrate data from menu_items
  // First add the columns if they don't exist
  if (!hasName)
    db.exec("ALTER TABLE order_items ADD COLUMN name TEXT NOT NULL DEFAULT ''");
  if (!hasDescription)
    db.exec(
      "ALTER TABLE order_items ADD COLUMN description TEXT NOT NULL DEFAULT ''",
    );
  if (!hasPrice)
    db.exec("ALTER TABLE order_items ADD COLUMN price REAL NOT NULL DEFAULT 0");
  if (!hasCategory)
    db.exec(
      "ALTER TABLE order_items ADD COLUMN category TEXT NOT NULL DEFAULT ''",
    );
  if (!hasType)
    db.exec(
      "ALTER TABLE order_items ADD COLUMN type TEXT NOT NULL DEFAULT 'comida'",
    );

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
const menuCount = db.prepare("SELECT COUNT(*) as count FROM menu_items").get();
if (menuCount.count === 0) {
  const insertMenu = db.prepare(`
    INSERT INTO menu_items (id, name, description, price, category, type, available, popular, portions, recipe)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const defaultMenuItems = [
    // bebidas
    [
      "1",
      "Fernet con coca (500ml)",
      "Fernet Branca",
      9000,
      "bebidas",
      "bebida",
      1,
      0,
      1,
      "[]",
    ],
    [
      "2",
      "Fernet con coca (500ml)",
      "Fernet Branca",
      14000,
      "bebidas",
      "bebida",
      1,
      0,
      1,
      "[]",
    ],
    [
      "3",
      "Gin tonic",
      "Gin Beefeater con limón y agua tónica",
      9000,
      "bebidas",
      "bebida",
      1,
      0,
      1,
      "[]",
    ],
    [
      "4",
      "Vermut",
      "Cinzano con soda",
      8000,
      "bebidas",
      "bebida",
      1,
      0,
      1,
      "[]",
    ],
    ["5", "Vaso de vino", "Malbec", 7000, "bebidas", "bebida", 1, 0, 1, "[]"],
    [
      "6",
      "Limonada Boston",
      "Con menta y jengibre",
      6000,
      "bebidas",
      "bebida",
      1,
      0,
      1,
      "[]",
    ],

    // comida
    [
      "7",
      "Empanadas de carne",
      "Dos unidades",
      6000,
      "comida",
      "comida",
      1,
      0,
      2,
      "[]",
    ],
    [
      "8",
      "Fainá",
      "Con pesto, cebolla caramelizada y cherries confitados",
      6000,
      "comida",
      "comida",
      1,
      0,
      1,
      "[]",
    ],
    [
      "9",
      "Croquetas de pescado y salsa blanca",
      "Con mayonesa cítrica y polvo de aceitunas",
      8000,
      "comida",
      "comida",
      1,
      0,
      1,
      "[]",
    ],
    [
      "10",
      "Sanguche de milanesa de pollo",
      "Con lechuga, mayonesa cítrica, pesto y cebolla caramelizada",
      10000,
      "comida",
      "comida",
      1,
      0,
      1,
      "[]",
    ],
  ];

  const insertMany = db.transaction((items) => {
    for (const item of items) {
      insertMenu.run(...item);
    }
  });

  insertMany(defaultMenuItems);
}

export default db;
