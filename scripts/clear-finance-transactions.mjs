/**
 * Borra todos los movimientos del libro (finance_transactions).
 * Los pagos de agenda / gastos fijos en sus tablas no se tocan: si los tenés cargados,
 * el libro va a quedar desalineado hasta que borres esos pagos o vuelvas a cargar movimientos.
 *
 * Run: cd server && node scripts/clear-finance-transactions.mjs
 */
import "dotenv/config";
import pg from "pg";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL no definido");
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: url });
  try {
    const r = await pool.query("DELETE FROM finance_transactions RETURNING id");
    console.log(`Listo: se eliminaron ${r.rowCount} movimientos.`);
  } finally {
    await pool.end();
  }
}

main();
