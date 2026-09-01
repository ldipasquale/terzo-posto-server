import crypto from 'crypto';
import express from 'express';
import db from '../database.js';

const router = express.Router();

const PARTNERS = ['Lucho', 'Bachi', 'Luli'];
const ROCK_STATUSES = ['on-track', 'off-track'];

function sqlDateToYmd(value) {
  if (value == null || value === '') return undefined;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const s = String(value);
  return s.includes('T') ? s.slice(0, 10) : s.slice(0, 10);
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === '') return [];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function mapRock(row) {
  return {
    id: row.id,
    title: row.title,
    owner: row.owner,
    quarter: row.quarter,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function mapTodo(row) {
  return {
    id: row.id,
    title: row.title,
    assignee: row.assignee,
    done: Boolean(row.done),
    meetingId: row.meeting_id || undefined,
    position: Number(row.position ?? 0),
    createdAt: new Date(row.created_at).toISOString(),
    completedAt: row.completed_at
      ? new Date(row.completed_at).toISOString()
      : undefined,
  };
}

function mapMeeting(row) {
  return {
    id: row.id,
    date: sqlDateToYmd(row.date),
    rating: Number(row.rating),
    rockIds: parseJsonArray(row.rock_ids).map(String),
    issues: parseJsonArray(row.issues).map((i) => ({
      id: String(i.id),
      title: String(i.title ?? ''),
      resolved: Boolean(i.resolved),
    })),
    todoIds: parseJsonArray(row.todo_ids).map(String),
    headlines: row.headlines || '',
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function mapManualMetric(row) {
  const completed = parseJsonArray(row.completed_item_ids).map(String);
  return {
    metricId: row.metric_id,
    weekStart: sqlDateToYmd(row.week_start),
    value: Number(row.value),
    total: row.total != null ? Number(row.total) : undefined,
    completedItemIds: completed.length ? completed : undefined,
  };
}

async function fetchAll() {
  const [rocks, todos, meetings, metrics] = await Promise.all([
    db.query('SELECT * FROM directorio_rocks ORDER BY created_at ASC'),
    db.query(
      'SELECT * FROM directorio_todos ORDER BY done ASC, position ASC, created_at ASC',
    ),
    db.query('SELECT * FROM directorio_meetings ORDER BY date DESC, created_at DESC'),
    db.query(
      'SELECT * FROM directorio_manual_metrics ORDER BY week_start DESC, metric_id ASC',
    ),
  ]);
  return {
    rocks: rocks.rows.map(mapRock),
    todos: todos.rows.map(mapTodo),
    meetings: meetings.rows.map(mapMeeting),
    manualMetrics: metrics.rows.map(mapManualMetric),
  };
}

router.get('/', async (req, res) => {
  try {
    res.json(await fetchAll());
  } catch (error) {
    console.error('Error fetching directorio:', error);
    res.status(500).json({ error: 'Error al obtener el directorio' });
  }
});

router.post('/rocks', async (req, res) => {
  try {
    const { title, owner, quarter, status } = req.body ?? {};
    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'El título es requerido' });
    }
    if (!PARTNERS.includes(owner)) {
      return res.status(400).json({ error: 'Responsable inválido' });
    }
    if (!quarter || typeof quarter !== 'string') {
      return res.status(400).json({ error: 'El trimestre es requerido' });
    }
    const rockStatus = ROCK_STATUSES.includes(status) ? status : 'on-track';
    const id = crypto.randomUUID();
    const result = await db.query(
      `INSERT INTO directorio_rocks (id, title, owner, quarter, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [id, title.trim(), owner, quarter.trim(), rockStatus],
    );
    res.status(201).json(mapRock(result.rows[0]));
  } catch (error) {
    console.error('Error creating rock:', error);
    res.status(500).json({ error: 'Error al crear el rock' });
  }
});

router.put('/rocks/:id', async (req, res) => {
  try {
    const existing = await db.query(
      'SELECT * FROM directorio_rocks WHERE id = $1',
      [req.params.id],
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Rock no encontrado' });
    }
    const current = existing.rows[0];
    const title =
      req.body.title != null ? String(req.body.title).trim() : current.title;
    if (!title) {
      return res.status(400).json({ error: 'El título es requerido' });
    }
    const owner =
      req.body.owner != null ? req.body.owner : current.owner;
    if (!PARTNERS.includes(owner)) {
      return res.status(400).json({ error: 'Responsable inválido' });
    }
    const quarter =
      req.body.quarter != null
        ? String(req.body.quarter).trim()
        : current.quarter;
    const status =
      req.body.status != null ? req.body.status : current.status;
    if (!ROCK_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Estado inválido' });
    }
    const result = await db.query(
      `UPDATE directorio_rocks
       SET title = $1, owner = $2, quarter = $3, status = $4
       WHERE id = $5
       RETURNING *`,
      [title, owner, quarter, status, req.params.id],
    );
    res.json(mapRock(result.rows[0]));
  } catch (error) {
    console.error('Error updating rock:', error);
    res.status(500).json({ error: 'Error al actualizar el rock' });
  }
});

router.delete('/rocks/:id', async (req, res) => {
  try {
    const result = await db.query('DELETE FROM directorio_rocks WHERE id = $1', [
      req.params.id,
    ]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Rock no encontrado' });
    }
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting rock:', error);
    res.status(500).json({ error: 'Error al eliminar el rock' });
  }
});

router.post('/todos', async (req, res) => {
  try {
    const { title, assignee, done, meetingId } = req.body ?? {};
    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'El título es requerido' });
    }
    if (!PARTNERS.includes(assignee)) {
      return res.status(400).json({ error: 'Responsable inválido' });
    }
    const id = crypto.randomUUID();
    const posResult = await db.query(
      `SELECT COALESCE(MAX(position), -1) + 1 AS next_position
       FROM directorio_todos
       WHERE done = FALSE`,
    );
    const position = Number(posResult.rows[0]?.next_position ?? 0);
    const isDone = Boolean(done);
    const result = await db.query(
      `INSERT INTO directorio_todos (id, title, assignee, done, meeting_id, position, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        id,
        title.trim(),
        assignee,
        isDone,
        meetingId || null,
        position,
        isDone ? new Date() : null,
      ],
    );
    res.status(201).json(mapTodo(result.rows[0]));
  } catch (error) {
    console.error('Error creating todo:', error);
    res.status(500).json({ error: 'Error al crear el to-do' });
  }
});

router.put('/todos/reorder', async (req, res) => {
  try {
    const orderedIds = req.body?.orderedIds;
    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      return res.status(400).json({ error: 'orderedIds es requerido' });
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < orderedIds.length; i++) {
        await client.query(
          `UPDATE directorio_todos
           SET position = $1
           WHERE id = $2 AND done = FALSE`,
          [i, String(orderedIds[i])],
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    res.json({ ok: true });
  } catch (error) {
    console.error('Error reordering todos:', error);
    res.status(500).json({ error: 'Error al reordenar los to-dos' });
  }
});

router.put('/todos/:id', async (req, res) => {
  try {
    const existing = await db.query(
      'SELECT * FROM directorio_todos WHERE id = $1',
      [req.params.id],
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'To-do no encontrado' });
    }
    const current = existing.rows[0];
    const title =
      req.body.title != null ? String(req.body.title).trim() : current.title;
    if (!title) {
      return res.status(400).json({ error: 'El título es requerido' });
    }
    const assignee =
      req.body.assignee != null ? req.body.assignee : current.assignee;
    if (!PARTNERS.includes(assignee)) {
      return res.status(400).json({ error: 'Responsable inválido' });
    }
    const done =
      req.body.done != null ? Boolean(req.body.done) : Boolean(current.done);
    const meetingId =
      req.body.meetingId !== undefined
        ? req.body.meetingId || null
        : current.meeting_id;
    const doneChanged = Boolean(current.done) !== done;
    const completedAt = done
      ? doneChanged || !current.completed_at
        ? new Date()
        : current.completed_at
      : null;
    const result = await db.query(
      `UPDATE directorio_todos
       SET title = $1, assignee = $2, done = $3, meeting_id = $4, completed_at = $5
       WHERE id = $6
       RETURNING *`,
      [title, assignee, done, meetingId, completedAt, req.params.id],
    );
    res.json(mapTodo(result.rows[0]));
  } catch (error) {
    console.error('Error updating todo:', error);
    res.status(500).json({ error: 'Error al actualizar el to-do' });
  }
});

router.delete('/todos/:id', async (req, res) => {
  try {
    const result = await db.query('DELETE FROM directorio_todos WHERE id = $1', [
      req.params.id,
    ]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'To-do no encontrado' });
    }
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting todo:', error);
    res.status(500).json({ error: 'Error al eliminar el to-do' });
  }
});

router.post('/meetings', async (req, res) => {
  try {
    const { date, rating, rockIds, issues, todoIds, headlines } = req.body ?? {};
    const dateYmd = sqlDateToYmd(date);
    if (!dateYmd) {
      return res.status(400).json({ error: 'La fecha es requerida' });
    }
    const ratingNum = Number(rating);
    if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 10) {
      return res.status(400).json({ error: 'La nota debe ser un entero de 1 a 10' });
    }
    const id = crypto.randomUUID();
    const result = await db.query(
      `INSERT INTO directorio_meetings
         (id, date, rating, rock_ids, issues, todo_ids, headlines)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7)
       RETURNING *`,
      [
        id,
        dateYmd,
        ratingNum,
        JSON.stringify(Array.isArray(rockIds) ? rockIds.map(String) : []),
        JSON.stringify(
          Array.isArray(issues)
            ? issues.map((i) => ({
                id: String(i.id || crypto.randomUUID()),
                title: String(i.title ?? '').trim(),
                resolved: Boolean(i.resolved),
              }))
            : [],
        ),
        JSON.stringify(Array.isArray(todoIds) ? todoIds.map(String) : []),
        headlines != null ? String(headlines) : '',
      ],
    );
    res.status(201).json(mapMeeting(result.rows[0]));
  } catch (error) {
    console.error('Error creating meeting:', error);
    res.status(500).json({ error: 'Error al registrar la reunión' });
  }
});

router.put('/manual-metrics', async (req, res) => {
  try {
    const entries = Array.isArray(req.body) ? req.body : [];
    if (entries.length === 0) {
      return res.status(400).json({ error: 'No hay métricas para guardar' });
    }

    const saved = [];
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      for (const entry of entries) {
        const metricId = entry.metricId != null ? String(entry.metricId) : '';
        const weekStart = sqlDateToYmd(entry.weekStart);
        const value = Number(entry.value);
        if (!metricId || !weekStart || Number.isNaN(value)) {
          const err = new Error('Métrica inválida');
          err.statusCode = 400;
          throw err;
        }
        const total =
          entry.total == null || entry.total === ''
            ? null
            : Number(entry.total);
        const completed = Array.isArray(entry.completedItemIds)
          ? entry.completedItemIds.map(String)
          : null;
        const result = await client.query(
          `INSERT INTO directorio_manual_metrics
             (metric_id, week_start, value, total, completed_item_ids, updated_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, CURRENT_TIMESTAMP)
           ON CONFLICT (metric_id, week_start) DO UPDATE SET
             value = EXCLUDED.value,
             total = EXCLUDED.total,
             completed_item_ids = EXCLUDED.completed_item_ids,
             updated_at = CURRENT_TIMESTAMP
           RETURNING *`,
          [
            metricId,
            weekStart,
            value,
            Number.isFinite(total) ? total : null,
            completed ? JSON.stringify(completed) : null,
          ],
        );
        saved.push(mapManualMetric(result.rows[0]));
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    res.json(saved);
  } catch (error) {
    if (error.statusCode === 400) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Error upserting manual metrics:', error);
    res.status(500).json({ error: 'Error al guardar las métricas' });
  }
});

export default router;
