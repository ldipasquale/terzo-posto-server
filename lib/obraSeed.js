/**
 * Presupuesto y Gantt de la remodelación (planilla v03, 21-10-2026).
 * Se inserta una sola vez, si todavía no hay una obra.
 */

const PROJECT_ID = "remodelacion-2026";

const PROJECT_NOTES =
  "Puntos que conviene agregar al alcance: confirmar recorrido y altura de desagüe antes de picar; verificar capacidad del tablero y puesta a tierra; probar sanitaria y electricidad antes de tapar; proteger madera/granito/cerámicos durante la obra; dejar acceso a fuentes LED y llaves de corte; hacer prueba final con equipos conectados.";

const BUDGET_ITEMS = [
  ["obra-item-01", "Barra y carpintería", "Barra", "Materiales (caño)", "", 1, 300000, "materiales", ""],
  ["obra-item-02", "Barra y carpintería", "Tapa de cedro", "Mano de obra", "", 1, 220000, "mano-de-obra", ""],
  ["obra-item-03", "Barra y carpintería", "Colocación estantería", "Ménsulas", "", 1, 60000, "mano-de-obra", ""],
  ["obra-item-04", "Barra y carpintería", "Barrita (de guatambú)", "Guatambú + cetol", "", 1, 180000, "materiales", ""],
  ["obra-item-05", "Barra y carpintería", "Mueble copero", "Guatambú/fenólico + cetol", "", 1, 120000, "materiales", ""],
  ["obra-item-06", "Marmolería", "Mesada barra de trabajo", "Mesada de granito (gris mara)", "Guillermo Melgar Marmolero", 1, 600000, "materiales", ""],
  ["obra-item-07", "Sanitaria", "Bacha", "Bacha de re.bajado", "@re.bajado", 1, 330000, "materiales", ""],
  ["obra-item-08", "Sanitaria", "Materiales sanitarios", "Materiales para llevar agua y desagüe", "", 1, 90000, "materiales", ""],
  ["obra-item-09", "Revestimientos y pintura", "Cerámicos", "Tipo subway, terminación brillante color bordó", "a definir", 1, 900000, "materiales", ""],
  ["obra-item-10", "Revestimientos y pintura", "Placa cementicia", "", "", 3, 60000, "materiales", ""],
  ["obra-item-11", "Revestimientos y pintura", "Colocación de cerámicos", "", "Gabriel albañil", 1, 315000, "mano-de-obra", "Consultar a hermano de Tebi"],
  ["obra-item-12", "Revestimientos y pintura", "Pintura", "Mano de obra", "Gabriel albañil", 1, 300000, "mano-de-obra", ""],
  ["obra-item-13", "Revestimientos y pintura", "Pintura", "Tacho de pintura", "", 1, 200000, "materiales", ""],
  ["obra-item-14", "Electricidad", "Materiales eléctricos", "Cables, tomas, cajas, teclas", "", 1, 150000, "materiales", ""],
  ["obra-item-15", "Electricidad", "Colocación de 4 colgantes", "", "Electricista", 1, 0, "mano-de-obra", "A cotizar si no lo hacemos nosotros"],
  ["obra-item-16", "Iluminación", "Iluminación", "", "Ejército de Salvación", 1, 200000, "materiales", ""],
  ["obra-item-17", "Mobiliario salón", "Sillas", "Tipo Thonet", "@re.bajado", 14, 58000, "equipamiento", ""],
  ["obra-item-18", "Mobiliario salón", "Banquetas", "", "@re.bajado", 5, 30000, "equipamiento", ""],
  ["obra-item-19", "Mobiliario salón", "Tapas de mesas cuadradas", "", "@re.bajado", 5, 5000, "equipamiento", ""],
  ["obra-item-20", "Mobiliario salón", "Mesas redondas", "", "Nelson Equipamientos", 2, 60000, "equipamiento", ""],
  ["obra-item-21", "Mobiliario salón", "Fenólico + cetol", "", "Maderera", 0, 60000, "materiales", ""],
  ["obra-item-22", "Equipamiento cocina", "Heladera bajo mesada", "", "Gran Fuego", 1, 590000, "equipamiento", "Ver producto"],
  ["obra-item-23", "Equipamiento cocina", "Bandejas GN", "GNs 1/2 de 15/20 cm de profundidad", "", 3, 100000, "equipamiento", ""],
];

/** [id, number|null, title, assignee, dependsOn, duration|null, weekStart|null, weekEnd|null] */
const TASKS = [
  ["obra-task-01", 1, "Comprar cerámicos", "Terzo", "", 1, 1, 1],
  ["obra-task-02", null, "Buscar maderas por Oliden", "Terzo", "", 1, 1, 1],
  ["obra-task-03", 2, "Encargar mesada de granito", "Terzo", "", 1, 1, 1],
  ["obra-task-04", 3, "Comprar materiales sanitarios", "Lucho", "", 1, 1, 1],
  ["obra-task-05", 4, "Comprar sillas, mesas redondas, tapas de mesas, bacha en re.bajado", "Terzo", "", 1, 1, 1],
  ["obra-task-06", 5, "Pasar caño al baño y dejar instalación sanitaria lista para la colocación de la bacha", "Bachi y Fede", "5", 3, 1, 1],
  ["obra-task-07", null, "Llevar maderas al carpintero", "", "", 1, 1, 1],
  ["obra-task-08", 6, "Llevar electricidad hasta la ubicación de la barra", "Lucho", "", 2, 1, 1],
  ["obra-task-09", 7, "Llevar electricidad hasta las ubicaciones de las lámparas colgantes", "Lucho", "2, 4", 1, 1, 1],
  ["obra-task-10", 8, "Colocar cerámicos en la barrita del pasaplatos", "Albañil", "4", 1, 2, 2],
  ["obra-task-11", 9, "Pintar salón", "Pintor", "10–11", 3, 2, 2],
  ["obra-task-12", 10, "Fabricar estructura de hierro de barra", "Bachi y Tani", "1–2", 7, 2, 3],
  ["obra-task-13", 11, "Instalar estructura de hierro", "Bachi y Tani", "12–13", 2, 3, 3],
  ["obra-task-14", 12, "Pasar cables por el interior de barra y colocar tomacorrientes", "Bachi y Lucho", "7–8, 14", 2, 3, 3],
  ["obra-task-15", 13, "Tomar plantilla de granito con la base instalada y medidas verificadas", "Marmolero", "14", 1, 3, 3],
  ["obra-task-16", 14, "Fabricar mesada de granito", "Marmolero", "16", 1, 3, 4],
  ["obra-task-17", 15, "Colocar y sellar mesada de granito", "Marmolero", "17", 1, 4, 4],
  ["obra-task-18", 16, "Colocar cerámicos en el frente de la barra", "Albañil", "14", 3, 4, 4],
  ["obra-task-19", 17, "Instalar barrita en L frente al pase de cocina", "Bachi", "12, 1", 1, 3, 3],
  ["obra-task-20", 18, "Colgar estantería de madera con anclajes adecuados al muro", "Bachi y Fede", "12, 7", 1, 3, 3],
  ["obra-task-21", 19, "Instalar luces LED en la estantería", "Bachi", "", 2, null, null],
  ["obra-task-22", 20, "Colocar 3–4 colgantes y 4 luces de pared y hacer conexión eléctrica", "Electricista", "7, 12", 2, 4, 4],
  ["obra-task-23", 21, "Cambiar cortina de lugar", "Bachi", "", null, null, null],
  ["obra-task-24", 22, "Recibir y colocar mesas, sillas y banquetas; verificar circulaciones", "ClaraRod + Terzo", "3, 18–23", 1, 5, 5],
  ["obra-task-25", 23, "Conectar bacha, heladeras y electrodomésticos; probar agua, desagüe, tomas y luces", "Terzo", "6, 8, 15, 18, 22–24", 1, 5, 5],
  ["obra-task-26", 24, "Sellados finales, retoques de pintura, limpieza de obra y revisión de pendientes", "Clara Rod", "19–25", 2, 5, 5],
];

export async function seedObraIfEmpty(client) {
  const existing = await client.query("SELECT 1 FROM obra_projects LIMIT 1");
  if (existing.rowCount > 0) return;

  await client.query("BEGIN");
  try {
    await client.query(
      `INSERT INTO obra_projects (id, name, start_date, end_date, notes)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        PROJECT_ID,
        "Remodelación Julián Álvarez 958",
        "2026-10-26",
        "2026-11-29",
        PROJECT_NOTES,
      ],
    );

    for (let index = 0; index < BUDGET_ITEMS.length; index += 1) {
      const [id, section, name, detail, supplier, quantity, unitPrice, category, note] =
        BUDGET_ITEMS[index];
      await client.query(
        `INSERT INTO obra_budget_items
         (id, project_id, section, name, detail, supplier, quantity, unit_price, deferred, note, finance_category, position)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$10,$11)`,
        [
          id,
          PROJECT_ID,
          section,
          name,
          detail,
          supplier,
          quantity,
          unitPrice,
          note,
          category,
          index,
        ],
      );
    }

    for (let index = 0; index < TASKS.length; index += 1) {
      const [id, taskNumber, title, assignee, dependsOn, durationDays, weekStart, weekEnd] =
        TASKS[index];
      await client.query(
        `INSERT INTO obra_tasks
         (id, project_id, task_number, title, assignee, depends_on, duration_days, week_start, week_end, status, position)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10)`,
        [
          id,
          PROJECT_ID,
          taskNumber,
          title,
          assignee,
          dependsOn,
          durationDays,
          weekStart,
          weekEnd,
          index,
        ],
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
