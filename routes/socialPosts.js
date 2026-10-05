import crypto from 'crypto';
import express from 'express';
import db from '../database.js';

const router = express.Router();

const FORMATS = ['post', 'carrousel', 'reel', 'historia'];

function storedStatus(value) {
  if (value == null || value === '') return 'idea';
  if (value === 'published') return 'published';
  if (value === 'idea' || value === 'in_production' || value === 'ready') {
    return 'idea';
  }
  return null;
}
const TITLE_MAX = 300;
const TASK_TITLE_MAX = 200;
const TEXT_MAX = 20000;

const RETURNING = `
  id,
  title,
  to_char(publish_date, 'YYYY-MM-DD') AS publish_date,
  publish_time,
  network,
  format,
  status,
  tasks,
  copy_text,
  notes,
  series_id,
  created_at,
  updated_at
`;

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

function parseSeriesId(value) {
  if (value == null || value === '') return null;
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  ) {
    return undefined;
  }
  return value;
}

function parseTime(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    return undefined;
  }
  return value;
}

function mapTasks(value) {
  let raw = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = [];
    }
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => ({
      id: String(item?.id ?? ''),
      title: String(item?.title ?? '').trim(),
      done: Boolean(item?.done),
    }))
    .filter((item) => item.id && item.title);
}

function mapPost(row) {
  return {
    id: row.id,
    title: row.title,
    date: row.publish_date,
    time: row.publish_time || null,
    network: 'instagram',
    format: row.format,
    status: row.status === 'published' ? 'published' : 'idea',
    copy: row.copy_text || '',
    notes: row.notes || '',
    seriesId: row.series_id || null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function load(id) {
  const result = await db.query(
    `SELECT ${RETURNING} FROM social_posts WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

function normalizeTasks(raw) {
  if (!Array.isArray(raw)) return { error: 'Las tareas son inválidas' };
  const tasks = [];
  for (const item of raw) {
    const title = String(item?.title ?? '').trim();
    if (!title) continue;
    if (title.length > TASK_TITLE_MAX) {
      return { error: 'Una tarea es demasiado larga' };
    }
    const id =
      typeof item?.id === 'string' && item.id.trim()
        ? item.id.trim()
        : crypto.randomUUID();
    tasks.push({ id, title, done: Boolean(item?.done) });
  }
  return { tasks };
}

function readText(value, label) {
  if (value == null) return '';
  const text = String(value);
  if (text.length > TEXT_MAX) return { error: `${label} es demasiado largo` };
  return text;
}

async function mutateTasks(id, change) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query(
      'SELECT tasks FROM social_posts WHERE id = $1 FOR UPDATE',
      [id],
    );
    if (!locked.rows[0]) {
      await client.query('ROLLBACK');
      return { error: 'Publicación no encontrada', status: 404 };
    }
    const current = mapTasks(locked.rows[0].tasks);
    const next = change(current);
    if (next.error) {
      await client.query('ROLLBACK');
      return next;
    }
    const saved = await client.query(
      `UPDATE social_posts
       SET tasks = $2::jsonb, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING ${RETURNING}`,
      [id, JSON.stringify(next.tasks)],
    );
    await client.query('COMMIT');
    return { row: saved.rows[0] };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* already aborted */
    }
    throw error;
  } finally {
    client.release();
  }
}

async function migrateLegacyTasks() {
  const posts = await db.query(
    `SELECT id, tasks FROM social_posts WHERE tasks <> '[]'::jsonb`,
  );
  for (const post of posts.rows) {
    const tasks = mapTasks(post.tasks);
    for (const task of tasks) {
      const position = await db.query(
        `SELECT COALESCE(MAX(position), -1) + 1 AS next_position
         FROM directorio_todos
         WHERE done = FALSE`,
      );
      await db.query(
        `INSERT INTO directorio_todos
           (id, title, assignee, done, status, social_post_id, position, completed_at)
         VALUES ($1, $2, 'Luli', $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO NOTHING`,
        [
          task.id,
          task.title,
          task.done,
          task.done ? 'done' : 'pending',
          post.id,
          Number(position.rows[0]?.next_position ?? 0),
          task.done ? new Date() : null,
        ],
      );
    }
    await db.query(`UPDATE social_posts SET tasks = '[]'::jsonb WHERE id = $1`, [
      post.id,
    ]);
  }
}

router.get('/', async (req, res) => {
  try {
    await migrateLegacyTasks();
    const result = await db.query(
      `SELECT ${RETURNING}
       FROM social_posts
       ORDER BY publish_date ASC, publish_time ASC NULLS LAST, title ASC`,
    );
    res.json(result.rows.map(mapPost));
  } catch (error) {
    console.error('Error listing social posts:', error);
    res.status(500).json({ error: 'No se pudieron cargar las publicaciones' });
  }
});

router.post('/', async (req, res) => {
  try {
    const body = req.body ?? {};
    const title = String(body.title ?? '').trim();
    if (!title) return res.status(400).json({ error: 'El título es requerido' });
    if (title.length > TITLE_MAX) {
      return res.status(400).json({ error: 'El título es demasiado largo' });
    }
    const date = parseYmd(body.date);
    if (!date) return res.status(400).json({ error: 'La fecha es inválida' });
    const time = parseTime(body.time);
    if (time === undefined) {
      return res.status(400).json({ error: 'La hora es inválida' });
    }
    if (!FORMATS.includes(body.format)) {
      return res.status(400).json({ error: 'El formato es inválido' });
    }
    const status = storedStatus(body.status ?? 'idea');
    if (!status) {
      return res.status(400).json({ error: 'El estado es inválido' });
    }
    const tasks = normalizeTasks(body.tasks ?? []);
    if (tasks.error) return res.status(400).json({ error: tasks.error });
    const copy = readText(body.copy, 'El copy');
    if (copy.error) return res.status(400).json({ error: copy.error });
    const notes = readText(body.notes, 'Las notas');
    if (notes.error) return res.status(400).json({ error: notes.error });
    const seriesId = parseSeriesId(body.seriesId);
    if (seriesId === undefined) {
      return res.status(400).json({ error: 'La serie es inválida' });
    }

    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO social_posts
         (id, title, publish_date, publish_time, network, format, status, tasks, copy_text, notes, series_id)
       VALUES ($1, $2, $3, $4, 'instagram', $5, $6, $7::jsonb, $8, $9, $10)`,
      [
        id,
        title,
        date,
        time,
        body.format,
        status,
        JSON.stringify(tasks.tasks),
        copy,
        notes,
        seriesId,
      ],
    );
    res.status(201).json(mapPost(await load(id)));
  } catch (error) {
    console.error('Error creating social post:', error);
    res.status(500).json({ error: 'No se pudo crear la publicación' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const existing = await load(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Publicación no encontrada' });
    }
    const body = req.body ?? {};
    const sets = [];
    const values = [];
    const push = (sql, value) => {
      values.push(value);
      sets.push(sql.replace('$?', `$${values.length}`));
    };

    if (body.title !== undefined) {
      const title = String(body.title).trim();
      if (!title) return res.status(400).json({ error: 'El título es requerido' });
      if (title.length > TITLE_MAX) {
        return res.status(400).json({ error: 'El título es demasiado largo' });
      }
      push('title = $?', title);
    }
    if (body.date !== undefined) {
      const date = parseYmd(body.date);
      if (!date) return res.status(400).json({ error: 'La fecha es inválida' });
      push('publish_date = $?', date);
    }
    if (body.time !== undefined) {
      const time = parseTime(body.time);
      if (time === undefined) {
        return res.status(400).json({ error: 'La hora es inválida' });
      }
      push('publish_time = $?', time);
    }
    if (body.format !== undefined) {
      if (!FORMATS.includes(body.format)) {
        return res.status(400).json({ error: 'El formato es inválido' });
      }
      push('format = $?', body.format);
    }
    if (body.status !== undefined) {
      const status = storedStatus(body.status);
      if (!status) {
        return res.status(400).json({ error: 'El estado es inválido' });
      }
      push('status = $?', status);
    }
    if (body.tasks !== undefined) {
      const tasks = normalizeTasks(body.tasks);
      if (tasks.error) return res.status(400).json({ error: tasks.error });
      push('tasks = $?::jsonb', JSON.stringify(tasks.tasks));
    }
    if (body.copy !== undefined) {
      const copy = readText(body.copy, 'El copy');
      if (copy.error) return res.status(400).json({ error: copy.error });
      push('copy_text = $?', copy);
    }
    if (body.notes !== undefined) {
      const notes = readText(body.notes, 'Las notas');
      if (notes.error) return res.status(400).json({ error: notes.error });
      push('notes = $?', notes);
    }

    if (sets.length === 0) return res.json(mapPost(existing));

    values.push(req.params.id);
    await db.query(
      `UPDATE social_posts
       SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP
       WHERE id = $${values.length}`,
      values,
    );
    res.json(mapPost(await load(req.params.id)));
  } catch (error) {
    console.error('Error updating social post:', error);
    res.status(500).json({ error: 'No se pudo guardar la publicación' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const existing = await load(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Publicación no encontrada' });
    }
    if (req.query.scope === 'series' && existing.series_id) {
      await db.query('DELETE FROM social_posts WHERE series_id = $1', [
        existing.series_id,
      ]);
    } else {
      await db.query('DELETE FROM social_posts WHERE id = $1', [req.params.id]);
    }
    res.status(204).end();
  } catch (error) {
    console.error('Error deleting social post:', error);
    res.status(500).json({ error: 'No se pudo borrar la publicación' });
  }
});

router.post('/:id/tasks', async (req, res) => {
  try {
    const title = String(req.body?.title ?? '').trim();
    if (!title) {
      return res.status(400).json({ error: 'La tarea necesita un título' });
    }
    if (title.length > TASK_TITLE_MAX) {
      return res.status(400).json({ error: 'La tarea es demasiado larga' });
    }
    const id =
      typeof req.body?.id === 'string' && req.body.id.trim()
        ? req.body.id.trim()
        : crypto.randomUUID();
    const result = await mutateTasks(req.params.id, (tasks) => {
      if (tasks.some((task) => task.id === id)) {
        return { error: 'La tarea ya existe', status: 400 };
      }
      return { tasks: [...tasks, { id, title, done: false }] };
    });
    if (result.error) {
      return res.status(result.status || 400).json({ error: result.error });
    }
    res.status(201).json(mapPost(result.row));
  } catch (error) {
    console.error('Error adding social task:', error);
    res.status(500).json({ error: 'No se pudo agregar la tarea' });
  }
});

router.patch('/:id/tasks/:taskId', async (req, res) => {
  try {
    const done = Boolean(req.body?.done);
    const result = await mutateTasks(req.params.id, (tasks) => {
      const index = tasks.findIndex((task) => task.id === req.params.taskId);
      if (index < 0) return { error: 'Tarea no encontrada', status: 404 };
      const next = tasks.slice();
      next[index] = { ...next[index], done };
      return { tasks: next };
    });
    if (result.error) {
      return res.status(result.status || 400).json({ error: result.error });
    }
    res.json(mapPost(result.row));
  } catch (error) {
    console.error('Error updating social task:', error);
    res.status(500).json({ error: 'No se pudo actualizar la tarea' });
  }
});

router.delete('/:id/tasks/:taskId', async (req, res) => {
  try {
    const result = await mutateTasks(req.params.id, (tasks) => {
      const next = tasks.filter((task) => task.id !== req.params.taskId);
      if (next.length === tasks.length) {
        return { error: 'Tarea no encontrada', status: 404 };
      }
      return { tasks: next };
    });
    if (result.error) {
      return res.status(result.status || 400).json({ error: result.error });
    }
    res.json(mapPost(result.row));
  } catch (error) {
    console.error('Error deleting social task:', error);
    res.status(500).json({ error: 'No se pudo quitar la tarea' });
  }
});

export default router;
