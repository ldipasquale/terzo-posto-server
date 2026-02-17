import pg from 'pg';

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;

const pool = new Pool({
  connectionString: DATABASE_URL,
  // ssl: {
  //   rejectUnauthorized: false,
  // },
});

// Create tables (PostgreSQL DDL)
const CREATE_TABLES = `
  CREATE TABLE IF NOT EXISTS menu_items (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    price DOUBLE PRECISION NOT NULL,
    category TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('comida', 'bebida')),
    available SMALLINT NOT NULL DEFAULT 1,
    popular SMALLINT NOT NULL DEFAULT 0,
    portions INTEGER NOT NULL DEFAULT 1,
    recipe TEXT NOT NULL DEFAULT '[]',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS mercado_pago_accounts (
    id TEXT PRIMARY KEY,
    holder TEXT NOT NULL,
    alias TEXT NOT NULL,
    is_default SMALLINT NOT NULL DEFAULT 0,
    active SMALLINT NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS cash_registers (
    id TEXT PRIMARY KEY,
    date DATE NOT NULL,
    mercado_pago_account_id TEXT NOT NULL REFERENCES mercado_pago_accounts(id),
    event_name TEXT,
    starting_cash DOUBLE PRECISION,
    status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    closed_at TIMESTAMP,
    closing_data JSONB
  );

  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    customer_name TEXT NOT NULL,
    total DOUBLE PRECISION NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'preparing', 'ready', 'delivered')),
    payment_method TEXT NOT NULL CHECK (payment_method IN ('efectivo', 'mercadopago')),
    mercado_pago_account_id TEXT REFERENCES mercado_pago_accounts(id),
    cash_register_id TEXT REFERENCES cash_registers(id),
    discount DOUBLE PRECISION,
    discount_reason TEXT,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id SERIAL PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    menu_item_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    price DOUBLE PRECISION NOT NULL,
    category TEXT NOT NULL,
    type TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    notes TEXT
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS supplies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('purchased', 'composed')),
    unit TEXT CHECK (unit IS NULL OR unit IN ('g', 'ml', 'unidad')),
    purchase_price DOUBLE PRECISION,
    purchase_quantity DOUBLE PRECISION,
    recipe TEXT,
    yield_amount DOUBLE PRECISION,
    yield_unit TEXT CHECK (yield_unit IS NULL OR yield_unit IN ('g', 'ml', 'unidad')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`;

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(CREATE_TABLES);

    // Migrations: add columns if missing (for existing DBs)
    const menuCols = await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'menu_items'",
    );
    const menuColNames = menuCols.rows.map((r) => r.column_name);
    if (!menuColNames.includes('portions')) {
      await client.query(
        'ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS portions INTEGER NOT NULL DEFAULT 1',
      );
    }
    if (!menuColNames.includes('recipe')) {
      await client.query(
        "ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS recipe TEXT NOT NULL DEFAULT '[]'",
      );
    }

    const orderItemsCols = await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'order_items'",
    );
    const oiColNames = orderItemsCols.rows.map((r) => r.column_name);
    const requiredOiCols = ['name', 'description', 'price', 'category', 'type'];
    for (const col of requiredOiCols) {
      if (!oiColNames.includes(col)) {
        const def =
          col === 'name' || col === 'description' || col === 'category'
            ? "TEXT NOT NULL DEFAULT ''"
            : col === 'price'
              ? 'DOUBLE PRECISION NOT NULL DEFAULT 0'
              : col === 'type'
                ? "TEXT NOT NULL DEFAULT 'comida'"
                : '';
        if (!def) continue;
        await client.query(
          `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS ${col} ${def}`,
        );
      }
    }
    if (requiredOiCols.some((c) => !oiColNames.includes(c))) {
      await client.query(`
        UPDATE order_items oi
        SET
          name = m.name,
          description = m.description,
          price = m.price,
          category = m.category,
          type = m.type
        FROM menu_items m
        WHERE oi.menu_item_id = m.id
      `);
    }

    const mpCols = await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'mercado_pago_accounts'",
    );
    const mpColNames = mpCols.rows.map((r) => r.column_name);
    if (!mpColNames.includes('active')) {
      await client.query(
        'ALTER TABLE mercado_pago_accounts ADD COLUMN IF NOT EXISTS active SMALLINT NOT NULL DEFAULT 1',
      );
    }

    const ordersCols = await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'orders'",
    );
    const ordersColNames = ordersCols.rows.map((r) => r.column_name);
    if (!ordersColNames.includes('discount')) {
      await client.query(
        'ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount DOUBLE PRECISION',
      );
    }
    if (!ordersColNames.includes('discount_reason')) {
      await client.query(
        'ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_reason TEXT',
      );
    }
    if (!ordersColNames.includes('notes')) {
      await client.query(
        'ALTER TABLE orders ADD COLUMN IF NOT EXISTS notes TEXT',
      );
    }

    const suppliesExists = (
      await client.query(
        "SELECT 1 FROM information_schema.tables WHERE table_name = 'supplies'",
      )
    ).rows.length > 0;
    if (!suppliesExists) {
      await client.query(`
        CREATE TABLE supplies (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL CHECK (type IN ('purchased', 'composed')),
          unit TEXT CHECK (unit IS NULL OR unit IN ('g', 'ml', 'unidad')),
          purchase_price DOUBLE PRECISION,
          purchase_quantity DOUBLE PRECISION,
          recipe TEXT,
          yield_amount DOUBLE PRECISION,
          yield_unit TEXT CHECK (yield_unit IS NULL OR yield_unit IN ('g', 'ml', 'unidad')),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
    }

    const cashRegistersExists =
      (
        await client.query(
          "SELECT 1 FROM information_schema.tables WHERE table_name = 'cash_registers'",
        )
      ).rows.length > 0;
    if (!cashRegistersExists) {
      await client.query(`
        CREATE TABLE cash_registers (
          id TEXT PRIMARY KEY,
          date DATE NOT NULL,
          mercado_pago_account_id TEXT NOT NULL REFERENCES mercado_pago_accounts(id),
          event_name TEXT,
          starting_cash DOUBLE PRECISION,
          status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          closed_at TIMESTAMP,
          closing_data JSONB
        )
      `);
    }
    if (!ordersColNames.includes('cash_register_id')) {
      await client.query(
        'ALTER TABLE orders ADD COLUMN IF NOT EXISTS cash_register_id TEXT REFERENCES cash_registers(id)',
      );
    }

    // Seed default menu if empty
    const menuCount = await client.query(
      'SELECT COUNT(*)::int AS count FROM menu_items',
    );
    if (menuCount.rows[0].count === 0) {
      const defaultMenuItems = [
        [
          '1',
          'Fernet con coca (500ml)',
          'Fernet Branca',
          9000,
          'bebidas',
          'bebida',
          1,
          0,
          1,
          '[]',
        ],
        [
          '2',
          'Fernet con coca (500ml)',
          'Fernet Branca',
          14000,
          'bebidas',
          'bebida',
          1,
          0,
          1,
          '[]',
        ],
        [
          '3',
          'Gin tonic',
          'Gin Beefeater con limón y agua tónica',
          9000,
          'bebidas',
          'bebida',
          1,
          0,
          1,
          '[]',
        ],
        [
          '4',
          'Vermut',
          'Cinzano con soda',
          8000,
          'bebidas',
          'bebida',
          1,
          0,
          1,
          '[]',
        ],
        [
          '5',
          'Vaso de vino',
          'Malbec',
          7000,
          'bebidas',
          'bebida',
          1,
          0,
          1,
          '[]',
        ],
        [
          '6',
          'Limonada Boston',
          'Con menta y jengibre',
          6000,
          'bebidas',
          'bebida',
          1,
          0,
          1,
          '[]',
        ],
        [
          '7',
          'Empanadas de carne',
          'Dos unidades',
          6000,
          'comida',
          'comida',
          1,
          0,
          2,
          '[]',
        ],
        [
          '8',
          'Fainá',
          'Con pesto, cebolla caramelizada y cherries confitados',
          6000,
          'comida',
          'comida',
          1,
          0,
          1,
          '[]',
        ],
        [
          '9',
          'Croquetas de pescado y salsa blanca',
          'Con mayonesa cítrica y polvo de aceitunas',
          8000,
          'comida',
          'comida',
          1,
          0,
          1,
          '[]',
        ],
        [
          '10',
          'Sanguche de milanesa de pollo',
          'Con lechuga, mayonesa cítrica, pesto y cebolla caramelizada',
          10000,
          'comida',
          'comida',
          1,
          0,
          1,
          '[]',
        ],
      ];
      for (const row of defaultMenuItems) {
        await client.query(
          `INSERT INTO menu_items (id, name, description, price, category, type, available, popular, portions, recipe)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          row,
        );
      }
    }
  } finally {
    client.release();
  }
}

await initDb();

export default pool;
