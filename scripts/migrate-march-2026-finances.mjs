/**
 * One-off migration: saldo inicial + movimientos marzo 2026 desde Excel.
 * Run: cd server && node scripts/migrate-march-2026-finances.mjs
 *
 * Idempotencia: borra movimientos con descripción que contiene "[migración marzo 2026]"
 * y saldos iniciales "Saldo inicial — migración Excel", luego inserta de nuevo.
 */
import crypto from "crypto";
import "dotenv/config";
import pg from "pg";

const MIGRATION_TAG = "[migración marzo 2026]";

const ACCOUNTS = {
  Luli: "1771724007935",
  Lucho: "1771724000149",
  Bachi: "1771114904621",
  Caja: "efectivo",
};

/** @typedef {{ nombre: string; cat: string; sub?: string; pago: string; monto: number; fecha: string; evento?: string; skip?: boolean }} Row */

/** @type {Row[]} */
const ROWS = [
  { nombre: "mercadolibre luces", cat: "Insumos", pago: "Lucho", monto: 116_500, fecha: "2026-03-03" },
  { nombre: "alquiler sala de ensayo manuel", cat: "Ingresos", pago: "Bachi", monto: -30_000, fecha: "2026-03-05" },
  { nombre: "uber dosis", cat: "", pago: "Bachi", monto: 4_800, fecha: "2026-03-05" },
  { nombre: "fotos", cat: "", pago: "Luli", monto: 27_000, fecha: "2026-03-05" },
  { nombre: "electrcidad", cat: "Obra", pago: "Luli", monto: 36_800, fecha: "2026-03-05" },
  { nombre: "SAI FERRETERIA", cat: "Obra", pago: "Luli", monto: 8_870, fecha: "2026-03-05" },
  { nombre: "galponas birras", cat: "Ingresos", pago: "Luli", monto: -42_000, fecha: "2026-03-05" },
  { nombre: "Ferreteria", cat: "Obra", pago: "Bachi", monto: 4_800, fecha: "2026-03-02" },
  { nombre: "Ferreteria", cat: "Obra", pago: "Bachi", monto: 5_500, fecha: "2026-03-02" },
  { nombre: "Pollo y meri pago mensual cine con pure", cat: "Ingresos", pago: "Bachi", monto: -24_000, fecha: "2026-03-02" },
  { nombre: "entradas cine con pure 3/3", cat: "Ingresos", pago: "Bachi", monto: -12_000, fecha: "2026-03-03" },
  { nombre: "venta birra cine con pure", cat: "Ingresos", pago: "Bachi", monto: -24_000, fecha: "2026-03-03" },
  { nombre: "alquiler sala martu konga", cat: "Ingresos", pago: "Luli", monto: -108_000, fecha: "2026-03-05" },
  { nombre: "ingreso alquiler videoclip 26/04", cat: "Ingresos", pago: "Luli", monto: -63_000, fecha: "2026-03-05" },
  { nombre: "electricista matriculdo 1/2", cat: "", pago: "Lucho", monto: 225_000, fecha: "2026-03-06" },
  { nombre: "carniceria", cat: "", pago: "Lucho", monto: 65_500, fecha: "2026-03-06" },
  { nombre: "verduleria", cat: "", pago: "Lucho", monto: 41_100, fecha: "2026-03-06" },
  { nombre: "ferreteria", cat: "", pago: "Lucho", monto: 6_650, fecha: "2026-03-06" },
  { nombre: "devolución aplique", cat: "", pago: "Lucho", monto: -59_412, fecha: "2026-03-06" },
  { nombre: "apliques de luces ml", cat: "", pago: "Lucho", monto: 265_910, fecha: "2026-03-06" },
  { nombre: "una birra que me transfirieron", cat: "Ingresos", pago: "Bachi", monto: -6_000, fecha: "2026-03-06", evento: "6/3 - Cadaver exquisito" },
  { nombre: "Hielo evento trotti", cat: "Insumos", sub: "Hielo", pago: "Luli", monto: 15_000, fecha: "2026-03-07", evento: "7/3 - Trotti" },
  { nombre: "vasos plástico", cat: "Insumos", sub: "Papelera", pago: "Luli", monto: 11_630, fecha: "2026-03-07" },
  { nombre: "ingreso EFT Cadaver exquisito", cat: "Ingresos", pago: "Caja", monto: -93_500, fecha: "2026-03-07", evento: "6/3 - Cadaver exquisito" },
  { nombre: "ingreso MP Luli Cadaver exquisito", cat: "Ingresos", pago: "Luli", monto: -570_000, fecha: "2026-03-07", evento: "6/3 - Cadaver exquisito" },
  { nombre: "Compra alcohol", cat: "Insumos", sub: "Bebida", pago: "Caja", monto: 495_250, fecha: "2026-03-07" },
  { nombre: "Ingreso MP fecha trotti entradas + alquiler", cat: "Ingresos", pago: "Luli", monto: -261_000, fecha: "2026-03-09", evento: "7/3 - Trotti" },
  { nombre: "ingreso mp trotti", cat: "Ingresos", pago: "Lucho", monto: -646_500, fecha: "2026-03-09", evento: "7/3 - Trotti" },
  { nombre: "ingreso ft trotti", cat: "Ingresos", pago: "Caja", monto: 209_500, fecha: "2026-03-09", evento: "7/3 - Trotti" },
  { nombre: "verdulería", cat: "Mercadería", pago: "Lucho", monto: 24_248, fecha: "2026-03-09", evento: "7/3 - Trotti" },
  { nombre: "chino", cat: "Mercadería", pago: "Lucho", monto: 9_800, fecha: "2026-03-09", evento: "7/3 - Trotti" },
  { nombre: "compra articulos de limpieza/dispensers/etc", cat: "Insumos", pago: "Bachi", monto: 181_858, fecha: "2026-03-09" },
  { nombre: "herrajes", cat: "Obra", pago: "Lucho", monto: 27_000, fecha: "2026-03-10" },
  { nombre: "casa electricidad", cat: "Obra", pago: "Lucho", monto: 51_200, fecha: "2026-03-10" },
  { nombre: "alquiler sala musica manuel", cat: "Ingresos", pago: "Bachi", monto: -30_000, fecha: "2026-03-10" },
  { nombre: "arreglo vidrio", cat: "Obra", pago: "Bachi", monto: 65_000, fecha: "2026-03-10" },
  { nombre: "Cine con pure 10/3 ENTRADAS", cat: "Ingresos", pago: "Bachi", monto: -28_000, fecha: "2026-03-10" },
  { nombre: "Cine con pure 10/3 BIRRA", cat: "Ingresos", pago: "Bachi", monto: -12_000, fecha: "2026-03-10" },
  { nombre: "pack mensual Geri cine con pure", cat: "Ingresos", pago: "Bachi", monto: -12_000, fecha: "2026-03-10" },
  { nombre: "coto carne y cosas", cat: "", pago: "Lucho", monto: 121_464, fecha: "2026-03-11" },
  { nombre: "pablo chocca ruidos", cat: "", pago: "Lucho", monto: 208_000, fecha: "2026-03-11" },
  { nombre: "verdulería", cat: "", pago: "Lucho", monto: 50_770, fecha: "2026-03-11" },
  { nombre: "Electricista matriculado", cat: "", pago: "Luli", monto: 225_000, fecha: "2026-03-11" },
  { nombre: "pechugas", cat: "", pago: "Caja", monto: 23_000, fecha: "2026-03-11" },
  { nombre: "pescadería", cat: "", pago: "Caja", monto: 26_750, fecha: "2026-03-11" },
  { nombre: "pago ana alquiler", cat: "Ingresos", pago: "Bachi", monto: -40_000, fecha: "2026-03-12", evento: "6/3 - Cadaver exquisito" },
  { nombre: "DL clean (limpieza cosas)", cat: "Insumos", sub: "Papelera", pago: "Luli", monto: 47_200, fecha: "2026-03-13" },
  { nombre: "ingresos MP viernes 13/3", cat: "Ingresos", pago: "Bachi", monto: -410_000, fecha: "2026-03-13" },
  { nombre: "Verduleria", cat: "Insumos", sub: "Comida", pago: "Luli", monto: 30_000, fecha: "2026-03-14" },
  { nombre: "el puente", cat: "", pago: "Lucho", monto: 26_546, fecha: "2026-03-14" },
  { nombre: "jueves talleres comida", cat: "Insumos", pago: "Lucho", monto: -94_000, fecha: "2026-03-14" },
  { nombre: "jueves talleres comida", cat: "Insumos", pago: "Caja", monto: -16_000, fecha: "2026-03-14" },
  { nombre: "carniceria empanadas", cat: "Insumos", pago: "Lucho", monto: 90_000, fecha: "2026-03-14" },
  { nombre: "verduleria", cat: "Insumos", pago: "Lucho", monto: 11_800, fecha: "2026-03-14" },
  { nombre: "chino", cat: "Insumos", pago: "Lucho", monto: 7_500, fecha: "2026-03-14" },
  { nombre: "verduleria", cat: "Insumos", pago: "Lucho", monto: 4_535, fecha: "2026-03-14" },
  { nombre: "ingreso ajedrez", cat: "Ingresos", pago: "Lucho", monto: -425_500, fecha: "2026-03-14" },
  { nombre: "melvin entradas", cat: "Ingresos", pago: "Lucho", monto: -140_000, fecha: "2026-03-14" },
  { nombre: "ajustar cuentas lucho", cat: "", pago: "Lucho", monto: 290_668, fecha: "2026-03-14", skip: true },
  { nombre: "ajustar cuentas lucho", cat: "", pago: "Lucho", monto: -290_668, fecha: "2026-03-14", skip: true },
  { nombre: "ajustar cuentas lucho", cat: "", pago: "Lucho", monto: 95_215, fecha: "2026-03-14", skip: true },
  { nombre: "ajustar cuentas lucho", cat: "", pago: "Lucho", monto: -95_215, fecha: "2026-03-14", skip: true },
  { nombre: "hielo", cat: "Insumos", pago: "Bachi", monto: 7_500, fecha: "2026-03-14" },
  { nombre: "cumpleaños Juan Tucat  seña EFT", cat: "Ingresos", pago: "Caja", monto: -100_000, fecha: "2026-03-15" },
  { nombre: "cumpleaños Juan Tucat  seña MP", cat: "Ingresos", pago: "Luli", monto: -75_000, fecha: "2026-03-16" },
  { nombre: "ana y delfi proyeccion alquiler sala", cat: "Ingresos", pago: "Bachi", monto: -40_000, fecha: "2026-03-16" },
  { nombre: "comida nos verdura", cat: "", pago: "Lucho", monto: 11_000, fecha: "2026-03-16" },
  { nombre: "comida nos pechuga", cat: "", pago: "Lucho", monto: 12_082, fecha: "2026-03-16" },
  { nombre: "marcos para fotos", cat: "Obra", pago: "Luli", monto: 52_996, fecha: "2026-03-17" },
  { nombre: "AYSA", cat: "Gasto fijo", pago: "Luli", monto: 42_877, fecha: "2026-03-17" },
  { nombre: "edesur", cat: "Gasto fijo", pago: "Luli", monto: 87_444, fecha: "2026-03-17" },
  { nombre: "ABL", cat: "Gasto fijo", pago: "Luli", monto: 122_669, fecha: "2026-03-17" },
  { nombre: "Alquiler sala Fede Pezet x 2 martes", cat: "Ingresos", pago: "Luli", monto: -108_000, fecha: "2026-03-17" },
  { nombre: "papelera (vasos, bolsas)", cat: "Mercadería", sub: "Papelera", pago: "Luli", monto: 64_000, fecha: "2026-03-17" },
  { nombre: "pelotitas de ping pong, sahumerios, pincel", cat: "", pago: "Luli", monto: 8_100, fecha: "2026-03-17" },
  { nombre: "verduleria", cat: "Mercadería", sub: "Comida", pago: "Luli", monto: 20_210, fecha: "2026-03-17" },
  { nombre: "ingresos entradas cine con pure 17/3", cat: "Ingresos", pago: "Bachi", monto: -24_000, fecha: "2026-03-17" },
  { nombre: "ingresos bebida cine con pure 17/3", cat: "Ingresos", pago: "Bachi", monto: -30_000, fecha: "2026-03-17" },
  { nombre: "alquiler sala musica manuel", cat: "Ingresos", pago: "Bachi", monto: -40_000, fecha: "2026-03-17" },
  { nombre: "ingreso guido chiosone 20 de marzo", cat: "Ingresos", pago: "Bachi", monto: -36_000, fecha: "2026-03-17" },
  { nombre: "ingreso noche perudo", cat: "Ingresos", pago: "Bachi", monto: -160_000, fecha: "2026-03-17" },
  { nombre: "ingreso noche perudo", cat: "Ingresos", pago: "Caja", monto: -37_000, fecha: "2026-03-17" },
  { nombre: "remate (seguro causioN)", cat: "", pago: "Lucho", monto: 100_000, fecha: "2026-03-18" },
  { nombre: "alquiler sala musica manuel", cat: "Ingresos", pago: "Bachi", monto: -30_000, fecha: "2026-03-19" },
  { nombre: "hielo", cat: "Insumos", pago: "Bachi", monto: 30_000, fecha: "2026-03-20" },
  { nombre: "chino", cat: "", pago: "Lucho", monto: 1_000, fecha: "2026-03-20" },
  { nombre: "verduleria", cat: "", pago: "Lucho", monto: 4_200, fecha: "2026-03-20" },
  { nombre: "remate (mesa y platos)", cat: "", pago: "Lucho", monto: 440_322, fecha: "2026-03-20" },
  { nombre: "verduleria", cat: "", pago: "Lucho", monto: 2_153, fecha: "2026-03-21" },
  { nombre: "chino", cat: "", pago: "Lucho", monto: 5_700, fecha: "2026-03-21" },
  { nombre: "verduleria", cat: "", pago: "Lucho", monto: 5_500, fecha: "2026-03-21" },
  { nombre: "adt marzo", cat: "Gasto fijo", pago: "Lucho", monto: 78_391, fecha: "2026-03-23" },
  { nombre: "compra ml varios", cat: "Insumos", pago: "Bachi", monto: 260_000, fecha: "2026-03-23" },
  { nombre: "electricidad", cat: "", pago: "Lucho", monto: 5_600, fecha: "2026-03-23" },
  { nombre: "luces phillips", cat: "", pago: "Lucho", monto: 69_781, fecha: "2026-03-23" },
  { nombre: "alquiler Sol Tobias", cat: "Ingresos", pago: "Bachi", monto: -350_000, fecha: "2026-03-25" },
  { nombre: "compra paneles y cortinas", cat: "Decoración", pago: "Bachi", monto: 200_000, fecha: "2026-03-25" },
  { nombre: "tornillos y trabapuertas", cat: "Obra", pago: "Bachi", monto: 2_800, fecha: "2026-03-25" },
  { nombre: "sillas y banquitos", cat: "Decoración", pago: "Lucho", monto: 100_000, fecha: "2026-03-26" },
  { nombre: "gasista", cat: "Obra", pago: "Bachi", monto: 145_000, fecha: "2026-03-26" },
  { nombre: "bicarbonato", cat: "", pago: "Bachi", monto: 8_000, fecha: "2026-03-26" },
  { nombre: "fede pezet alquiler", cat: "Ingresos", pago: "Bachi", monto: -54_000, fecha: "2026-03-27" },
  { nombre: "Alquiler sala de ensayo musica", cat: "Ingresos", pago: "Bachi", monto: -30_000, fecha: "2026-03-27" },
];

/** Saldos al 1/3 previos a los movimientos de marzo (todos ingreso salvo type explícito). */
const INITIAL_BALANCES = [
  { holder: "Luli", accountId: ACCOUNTS.Luli, amount: 13_440 },
  { holder: "Lucho", accountId: ACCOUNTS.Lucho, amount: 413_200 },
  { holder: "Bachi", accountId: ACCOUNTS.Bachi, amount: 1_110_384 },
  { holder: "Caja (efectivo)", accountId: ACCOUNTS.Caja, amount: 554_660 },
];

/**
 * @param {Row} row
 * @returns {{ type: 'income' | 'expense'; amount: number }}
 */
function typeAndAmount(row) {
  const abs = Math.abs(row.monto);
  if (row.cat === "Ingresos") {
    return { type: "income", amount: abs };
  }
  if (row.monto < 0) {
    return { type: "income", amount: abs };
  }
  return { type: "expense", amount: abs };
}

/**
 * @param {Row} row
 * @param {{ type: string; amount: number }} ta
 */
function categoryFor(row, ta) {
  const n = row.nombre.toLowerCase();
  const text = `${row.nombre} ${row.evento || ""}`.toLowerCase();
  const cat = row.cat.trim();
  const sub = (row.sub || "").toLowerCase();

  if (n.includes("jueves talleres comida") && ta.type === "income") {
    return "talleres-puntuales";
  }

  if (ta.type === "income") {
    if (/galponas|ingresos mp viernes/.test(n) && !/cine/.test(n)) return "buffet";
    if (/venta birra/.test(n) && /cine/.test(n)) return "eventos";
    if (/venta birra/.test(n)) return "buffet";
    if (
      /alquiler|sala|ensayo|música|musica|manuel|martu|fede|pezet|pack mensual|videoclip|tobias|\bsol\b/.test(
        n,
      )
    ) {
      return "agenda";
    }
    if (
      /cine|entradas|trotti|cadaver|perudo|ajedrez|melvin|cumpleaños|seña|guido|ana y delfi|noche perudo|birra que|pago ana|proyeccion/.test(
        text,
      )
    ) {
      return "eventos";
    }
    return "otros";
  }

  if (cat === "Gasto fijo") return "gasto-fijo";
  if (cat === "Obra") return "obra";
  if (cat === "Decoración") return "equipamiento";
  if (cat === "Insumos") {
    if (sub.includes("bebida")) return "insumos-bebida";
    if (sub.includes("hielo")) return "insumos-bebida";
    if (sub.includes("papelera") || sub.includes("limpieza")) return "insumos-higiene";
    if (sub.includes("comida")) return "insumos-comida";
    if (/hielo/i.test(row.nombre)) return "insumos-bebida";
    return "insumos-comida";
  }
  if (cat === "Mercadería") {
    if (sub.includes("papelera")) return "insumos-higiene";
    if (sub.includes("comida")) return "insumos-comida";
    return "insumos-comida";
  }

  if (/electric|gasista|ferreter|vidrio|marcos para fotos|herrajes|casa electric|luces phillips|tornillo/i.test(n)) {
    return "obra";
  }
  if (/carnic|verdul|chino|coto|comida nos|pechugas|pescad|empanada|pollo/i.test(n)) {
    return "insumos-comida";
  }
  if (/papelera|dl clean|limpieza|bicarbonato/i.test(n)) return "insumos-higiene";
  if (/alcohol|bebida|hielo/i.test(n)) return "insumos-bebida";
  if (/compra ml|ml varios/i.test(n)) return "equipamiento";

  return "otros";
}

function accountIdForPago(pago) {
  const key = (pago || "").trim();
  if (!key) return ACCOUNTS.Caja;
  const normalized = key.toLowerCase();
  if (normalized === "caja") return ACCOUNTS.Caja;
  if (normalized === "luli") return ACCOUNTS.Luli;
  if (normalized === "lucho") return ACCOUNTS.Lucho;
  if (normalized === "bachi") return ACCOUNTS.Bachi;
  throw new Error(`Pagó desconocido: "${pago}"`);
}

function buildDescription(row) {
  let d = row.nombre.trim();
  if (row.evento) d += ` — ${row.evento.trim()}`;
  return `${d} ${MIGRATION_TAG}`;
}

/** Saldos finales por cuenta si se aplicara saldo inicial + filas del Excel (sin escribir DB). */
function computeProjectedBalances() {
  const balances = {};
  for (const ib of INITIAL_BALANCES) {
    const isExpense = ib.type === "expense";
    const delta = isExpense ? -ib.amount : ib.amount;
    balances[ib.accountId] = (balances[ib.accountId] || 0) + delta;
  }
  for (const row of ROWS) {
    if (row.skip) continue;
    const ta = typeAndAmount(row);
    const aid = accountIdForPago(row.pago);
    const delta = ta.type === "income" ? ta.amount : -ta.amount;
    balances[aid] = (balances[aid] || 0) + delta;
  }
  return balances;
}

const ACCOUNT_LABEL = {
  [ACCOUNTS.Luli]: "Luli",
  [ACCOUNTS.Lucho]: "Lucho",
  [ACCOUNTS.Bachi]: "Bachi",
  [ACCOUNTS.Caja]: "Caja (efectivo)",
};

if (process.argv.includes("--preview-balances")) {
  const b = computeProjectedBalances();
  let total = 0;
  console.log("Proyección: saldo inicial + movimientos marzo (sin ajustes de cuenta Lucho)\n");
  for (const id of [ACCOUNTS.Luli, ACCOUNTS.Lucho, ACCOUNTS.Bachi, ACCOUNTS.Caja]) {
    const v = b[id] ?? 0;
    total += v;
    console.log(`${ACCOUNT_LABEL[id]}: $${v.toLocaleString("es-AR")}`);
  }
  console.log(`\nTotal (suma de cuentas): $${total.toLocaleString("es-AR")}`);
  process.exit(0);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL no definido");
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: url });
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `DELETE FROM finance_transactions WHERE description LIKE $1`,
      [`%${MIGRATION_TAG}%`],
    );
    await client.query(
      `DELETE FROM finance_transactions WHERE description LIKE 'Saldo inicial — migración Excel%'`,
    );

    const initialDate = new Date("2026-03-01T12:00:00.000Z").toISOString();

    for (const ib of INITIAL_BALANCES) {
      const id = crypto.randomUUID();
      const txType = ib.type === "expense" ? "expense" : "income";
      await client.query(
        `INSERT INTO finance_transactions
         (id, account_id, type, amount, description, source, category, reference_id, date)
         VALUES ($1,$2,$3,$4,$5,'manual','otros',NULL,$6)`,
        [
          id,
          ib.accountId,
          txType,
          ib.amount,
          `Saldo inicial — migración Excel (${ib.holder})`,
          initialDate,
        ],
      );
    }

    for (const row of ROWS) {
      if (row.skip) continue;
      const ta = typeAndAmount(row);
      const category = categoryFor(row, ta);
      const accountId = accountIdForPago(row.pago);
      const id = crypto.randomUUID();
      const date = new Date(`${row.fecha}T15:00:00.000Z`).toISOString();

      await client.query(
        `INSERT INTO finance_transactions
         (id, account_id, type, amount, description, source, category, reference_id, date)
         VALUES ($1,$2,$3,$4,$5,'manual',$6,NULL,$7)`,
        [id, accountId, ta.type, ta.amount, buildDescription(row), category, date],
      );
    }

    await client.query("COMMIT");
    console.log(
      `OK: ${INITIAL_BALANCES.length} saldos iniciales + ${ROWS.filter((r) => !r.skip).length} movimientos marzo.`,
    );
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
