import crypto from 'crypto';
import express from 'express';
import db from '../database.js';

const router = express.Router();

const PARTNERS = ['Lucho', 'Bachi', 'Luli'];
const ROCK_STATUSES = ['on-track', 'off-track'];
const TODO_STATUSES = ['pending', 'blocked', 'future', 'done'];

function normalizeTodoState(body, current) {
  const doneProvided = body?.done != null;
  const statusProvided = body?.status != null;
  let done = doneProvided ? Boolean(body.done) : Boolean(current?.done);
  let status = statusProvided
    ? String(body.status)
    : (current?.status ?? (done ? 'done' : 'pending'));

  if (!TODO_STATUSES.includes(status)) {
    return { error: 'Estado inválido' };
  }

  if (done || status === 'done') {
    done = true;
    status = 'done';
  } else {
    done = false;
  }

  let blockedReason = null;
  if (status === 'blocked') {
    const raw =
      body?.blockedReason !== undefined
        ? body.blockedReason
        : current?.blocked_reason;
    blockedReason = raw != null ? String(raw).trim() : '';
    if (!blockedReason) {
      return { error: 'El motivo del bloqueo es requerido' };
    }
  }

  return { done, status, blockedReason };
}

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

const TODO_SELECT = `
  SELECT t.*, r.activity_name AS event_name
  FROM directorio_todos t
  LEFT JOIN agenda_rentals r ON r.id = t.event_id
`;

function mapTodo(row) {
  const done = Boolean(row.done);
  const status = row.status || (done ? 'done' : 'pending');
  return {
    id: row.id,
    title: row.title,
    assignee: row.assignee,
    done,
    status,
    blockedReason: row.blocked_reason || undefined,
    note: row.note || undefined,
    meetingId: row.meeting_id || undefined,
    eventId: row.event_id || undefined,
    eventName: row.event_name || undefined,
    position: Number(row.position ?? 0),
    createdAt: new Date(row.created_at).toISOString(),
    completedAt: row.completed_at
      ? new Date(row.completed_at).toISOString()
      : undefined,
  };
}

async function loadTodo(id) {
  const result = await db.query(`${TODO_SELECT} WHERE t.id = $1`, [id]);
  return result.rows[0];
}

async function resolveEventId(raw) {
  if (raw == null || raw === '') return { eventId: null };
  const eventId = String(raw);
  const found = await db.query('SELECT id FROM agenda_rentals WHERE id = $1', [
    eventId,
  ]);
  if (found.rows.length === 0) return { error: 'Evento no encontrado' };
  return { eventId };
}

function parseYmd(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return value;
}

function mapOpenIssue(row) {
  return {
    id: row.id,
    title: row.title,
    resolved: Boolean(row.resolved),
    sourceDate: row.source_date ? sqlDateToYmd(row.source_date) : null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function snapshotIssue(issue) {
  return {
    id: String(issue.id || crypto.randomUUID()),
    title: String(issue.title ?? '').trim(),
    resolved: Boolean(issue.resolved),
    sourceDate: issue.sourceDate ? String(issue.sourceDate) : null,
  };
}

function mapDailyMeeting(row, dateFallback) {
  if (!row) return { date: dateFallback, notes: '', updatedAt: null };
  return {
    date: sqlDateToYmd(row.date),
    notes: row.notes || '',
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
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
      sourceDate: i.sourceDate ? String(i.sourceDate) : null,
    })),
    todoIds: parseJsonArray(row.todo_ids).map(String),
    headlines: row.headlines || '',
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function partnerFromUserName(name) {
  const normalized = String(name || '').trim().toLowerCase();
  if (!normalized) return null;
  const exact = PARTNERS.find((partner) => partner.toLowerCase() === normalized);
  if (exact) return { partner: exact, exact: true };
  const partial = PARTNERS.find((partner) => normalized.includes(partner.toLowerCase()));
  return partial ? { partner: partial, exact: false } : null;
}

async function fetchPartnerPhotos() {
  const result = await db.query(
    'SELECT name, photo_file FROM app_users WHERE active = 1',
  );
  const chosen = new Map();
  for (const row of result.rows) {
    const match = partnerFromUserName(row.name);
    if (!match) continue;
    const current = chosen.get(match.partner);
    if (current && current.exact && !match.exact) continue;
    chosen.set(match.partner, {
      exact: match.exact,
      photoUrl: row.photo_file
        ? `/api/public/user-photos/${row.photo_file}`
        : null,
    });
  }
  return PARTNERS.map((name) => ({
    name,
    photoUrl: chosen.get(name)?.photoUrl ?? null,
  }));
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
  const [rocks, todos, meetings, metrics, partners] = await Promise.all([
    db.query('SELECT * FROM directorio_rocks ORDER BY created_at ASC'),
    db.query(
      `${TODO_SELECT} ORDER BY t.done ASC, t.position ASC, t.created_at ASC`,
    ),
    db.query('SELECT * FROM directorio_meetings ORDER BY date DESC, created_at DESC'),
    db.query(
      'SELECT * FROM directorio_manual_metrics ORDER BY week_start DESC, metric_id ASC',
    ),
    fetchPartnerPhotos(),
  ]);
  return {
    rocks: rocks.rows.map(mapRock),
    todos: todos.rows.map(mapTodo),
    meetings: meetings.rows.map(mapMeeting),
    manualMetrics: metrics.rows.map(mapManualMetric),
    partners,
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
    const { title, assignee, meetingId } = req.body ?? {};
    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'El título es requerido' });
    }
    if (!PARTNERS.includes(assignee)) {
      return res.status(400).json({ error: 'Responsable inválido' });
    }
    const normalized = normalizeTodoState(req.body ?? {}, null);
    if (normalized.error) {
      return res.status(400).json({ error: normalized.error });
    }
    const id = crypto.randomUUID();
    const posResult = await db.query(
      `SELECT COALESCE(MAX(position), -1) + 1 AS next_position
       FROM directorio_todos
       WHERE done = FALSE`,
    );
    const position = Number(posResult.rows[0]?.next_position ?? 0);
    const note =
      req.body.note != null ? String(req.body.note).trim() || null : null;
    const event = await resolveEventId(req.body.eventId);
    if (event.error) {
      return res.status(400).json({ error: event.error });
    }
    await db.query(
      `INSERT INTO directorio_todos
         (id, title, assignee, done, status, blocked_reason, note, meeting_id, event_id, position, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        id,
        title.trim(),
        assignee,
        normalized.done,
        normalized.status,
        normalized.blockedReason,
        note,
        meetingId || null,
        event.eventId,
        position,
        normalized.done ? new Date() : null,
      ],
    );
    res.status(201).json(mapTodo(await loadTodo(id)));
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
           WHERE id = $2`,
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
    const normalized = normalizeTodoState(req.body ?? {}, current);
    if (normalized.error) {
      return res.status(400).json({ error: normalized.error });
    }
    const meetingId =
      req.body.meetingId !== undefined
        ? req.body.meetingId || null
        : current.meeting_id;
    const doneChanged = Boolean(current.done) !== normalized.done;
    const completedAt = normalized.done
      ? doneChanged || !current.completed_at
        ? new Date()
        : current.completed_at
      : null;
    const note =
      req.body.note !== undefined
        ? String(req.body.note).trim() || null
        : current.note ?? null;
    let eventId = current.event_id;
    if (req.body.eventId !== undefined) {
      const event = await resolveEventId(req.body.eventId);
      if (event.error) {
        return res.status(400).json({ error: event.error });
      }
      eventId = event.eventId;
    }
    await db.query(
      `UPDATE directorio_todos
       SET title = $1, assignee = $2, done = $3, status = $4, blocked_reason = $5,
           note = $6, meeting_id = $7, event_id = $8, completed_at = $9
       WHERE id = $10`,
      [
        title,
        assignee,
        normalized.done,
        normalized.status,
        normalized.blockedReason,
        note,
        meetingId,
        eventId,
        completedAt,
        req.params.id,
      ],
    );
    res.json(mapTodo(await loadTodo(req.params.id)));
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

router.get('/daily-meetings', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM directorio_daily_meetings
       ORDER BY date DESC, created_at DESC`,
    );
    res.json(result.rows.map((row) => mapDailyMeeting(row)));
  } catch (error) {
    console.error('Error listing daily meetings:', error);
    res.status(500).json({ error: 'Error al obtener las reuniones diarias' });
  }
});

router.get('/daily-meetings/:date', async (req, res) => {
  try {
    const date = parseYmd(req.params.date);
    if (!date) {
      return res.status(400).json({ error: 'La fecha no es válida' });
    }
    const result = await db.query(
      'SELECT * FROM directorio_daily_meetings WHERE date = $1',
      [date],
    );
    res.json(mapDailyMeeting(result.rows[0], date));
  } catch (error) {
    console.error('Error fetching daily meeting:', error);
    res.status(500).json({ error: 'Error al obtener la reunión diaria' });
  }
});

router.put('/daily-meetings/:date', async (req, res) => {
  try {
    const date = parseYmd(req.params.date);
    if (!date) {
      return res.status(400).json({ error: 'La fecha no es válida' });
    }
    if (typeof req.body?.notes !== 'string') {
      return res.status(400).json({ error: 'La nota es requerida' });
    }
    const id = crypto.randomUUID();
    const result = await db.query(
      `INSERT INTO directorio_daily_meetings (id, date, notes)
       VALUES ($1, $2, $3)
       ON CONFLICT (date) DO UPDATE SET
         notes = EXCLUDED.notes,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [id, date, req.body.notes],
    );
    res.json(mapDailyMeeting(result.rows[0], date));
  } catch (error) {
    console.error('Error saving daily meeting:', error);
    res.status(500).json({ error: 'Error al guardar la reunión diaria' });
  }
});

router.get('/open-issues', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM directorio_open_issues
       ORDER BY created_at ASC, id ASC`,
    );
    res.json(result.rows.map(mapOpenIssue));
  } catch (error) {
    console.error('Error listing open issues:', error);
    res.status(500).json({ error: 'Error al obtener los issues' });
  }
});

router.post('/open-issues', async (req, res) => {
  try {
    const title = String(req.body?.title ?? '').trim();
    if (!title) {
      return res.status(400).json({ error: 'El issue es requerido' });
    }
    const sourceDate =
      req.body?.sourceDate == null || req.body.sourceDate === ''
        ? null
        : parseYmd(req.body.sourceDate);
    if (req.body?.sourceDate && !sourceDate) {
      return res.status(400).json({ error: 'La fecha no es válida' });
    }
    const id = crypto.randomUUID();
    const result = await db.query(
      `INSERT INTO directorio_open_issues (id, title, source_date)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [id, title, sourceDate],
    );
    res.status(201).json(mapOpenIssue(result.rows[0]));
  } catch (error) {
    console.error('Error creating open issue:', error);
    res.status(500).json({ error: 'Error al guardar el issue' });
  }
});

router.patch('/open-issues/:id', async (req, res) => {
  try {
    const current = await db.query(
      'SELECT * FROM directorio_open_issues WHERE id = $1',
      [req.params.id],
    );
    if (current.rows.length === 0) {
      return res.status(404).json({ error: 'Issue no encontrado' });
    }
    const row = current.rows[0];
    const title =
      req.body?.title !== undefined ? String(req.body.title).trim() : row.title;
    if (!title) {
      return res.status(400).json({ error: 'El issue es requerido' });
    }
    const resolved =
      req.body?.resolved !== undefined ? Boolean(req.body.resolved) : row.resolved;
    const result = await db.query(
      `UPDATE directorio_open_issues
       SET title = $2, resolved = $3
       WHERE id = $1
       RETURNING *`,
      [req.params.id, title, resolved],
    );
    res.json(mapOpenIssue(result.rows[0]));
  } catch (error) {
    console.error('Error updating open issue:', error);
    res.status(500).json({ error: 'Error al actualizar el issue' });
  }
});

router.delete('/open-issues/:id', async (req, res) => {
  try {
    const result = await db.query(
      'DELETE FROM directorio_open_issues WHERE id = $1',
      [req.params.id],
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Issue no encontrado' });
    }
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting open issue:', error);
    res.status(500).json({ error: 'Error al eliminar el issue' });
  }
});

router.post('/meetings', async (req, res) => {
  const client = await db.connect();
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

    await client.query('BEGIN');
    const open = await client.query(
      `SELECT * FROM directorio_open_issues
       ORDER BY created_at ASC, id ASC`,
    );
    const snapshot =
      open.rows.length > 0
        ? open.rows.map(mapOpenIssue).map(snapshotIssue)
        : Array.isArray(issues)
          ? issues.map(snapshotIssue).filter((issue) => issue.title)
          : [];
    const id = crypto.randomUUID();
    const result = await client.query(
      `INSERT INTO directorio_meetings
         (id, date, rating, rock_ids, issues, todo_ids, headlines)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7)
       RETURNING *`,
      [
        id,
        dateYmd,
        ratingNum,
        JSON.stringify(Array.isArray(rockIds) ? rockIds.map(String) : []),
        JSON.stringify(snapshot),
        JSON.stringify(Array.isArray(todoIds) ? todoIds.map(String) : []),
        headlines != null ? String(headlines) : '',
      ],
    );
    await client.query('DELETE FROM directorio_open_issues WHERE resolved = TRUE');
    await client.query('COMMIT');
    res.status(201).json(mapMeeting(result.rows[0]));
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* la transacción puede no haber empezado */
    }
    console.error('Error creating meeting:', error);
    res.status(500).json({ error: 'Error al registrar la reunión' });
  } finally {
    client.release();
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
