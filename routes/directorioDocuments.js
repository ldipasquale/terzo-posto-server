import crypto from 'crypto';
import express from 'express';
import db from '../database.js';

const router = express.Router();

const MAX_DOCUMENT_CHARS = 400_000;
const EMPTY_DOCUMENT = { type: 'doc', content: [{ type: 'paragraph' }] };

function parseDocumentContent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.type !== 'doc') return null;
  if (value.content != null && !Array.isArray(value.content)) return null;
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return null;
  }
  if (!serialized || serialized.length > MAX_DOCUMENT_CHARS) return null;
  return JSON.parse(serialized);
}

function normalizeContent(value) {
  let content = value ?? EMPTY_DOCUMENT;
  if (typeof content === 'string') {
    try {
      content = JSON.parse(content);
    } catch {
      content = EMPTY_DOCUMENT;
    }
  }
  if (!content || content.type !== 'doc') return EMPTY_DOCUMENT;
  return content;
}

function timestamp(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function mapNode(row, { includeContent = false } = {}) {
  const node = {
    id: row.id,
    parentId: row.parent_id || null,
    kind: row.kind,
    title: row.title,
    position: Number(row.position ?? 0),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
  if (includeContent) {
    node.content = row.kind === 'document' ? normalizeContent(row.content) : null;
    node.writeToken = Number(row.write_token ?? 0);
    if (typeof row.applied === 'boolean') node.applied = row.applied;
  }
  return node;
}

function resolveTitle(value, kind, { required = false } = {}) {
  const fallback = kind === 'folder' ? 'Nueva carpeta' : 'Sin título';
  if (value == null || String(value).trim() === '') {
    if (required) return { error: 'El nombre es requerido' };
    return { title: fallback };
  }
  const title = String(value).trim();
  if (title.length > 200) return { error: 'El nombre es demasiado largo' };
  return { title };
}

function descendantIds(rows, id) {
  const children = new Map();
  for (const row of rows) {
    const key = row.parent_id ?? null;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(row.id);
  }
  const out = new Set();
  const stack = [...(children.get(id) ?? [])];
  while (stack.length) {
    const current = stack.pop();
    if (out.has(current)) continue;
    out.add(current);
    stack.push(...(children.get(current) ?? []));
  }
  return out;
}

function orderedSiblings(rows, parentId, excludeId) {
  return rows
    .filter(
      (row) => (row.parent_id ?? null) === parentId && row.id !== excludeId,
    )
    .sort((a, b) => {
      const byPosition = Number(a.position) - Number(b.position);
      if (byPosition !== 0) return byPosition;
      return new Date(a.created_at) - new Date(b.created_at);
    });
}

async function listRows(client = db) {
  const result = await client.query(
    `SELECT id, parent_id, kind, title, position, created_at, updated_at
     FROM directorio_documents
     ORDER BY position ASC, created_at ASC`,
  );
  return result.rows;
}

async function withLock(work) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'LOCK TABLE directorio_documents IN SHARE ROW EXCLUSIVE MODE',
    );
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

router.get('/', async (_req, res) => {
  try {
    const rows = await listRows();
    res.json(rows.map((row) => mapNode(row)));
  } catch (error) {
    console.error('Error listing documents:', error);
    res.status(500).json({ error: 'Error al obtener los documentos' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM directorio_documents WHERE id = $1',
      [req.params.id],
    );
    const row = result.rows[0];
    if (!row) {
      return res.status(404).json({ error: 'No encontramos ese documento' });
    }
    res.json(mapNode(row, { includeContent: true }));
  } catch (error) {
    console.error('Error fetching document:', error);
    res.status(500).json({ error: 'Error al obtener el documento' });
  }
});

router.post('/', async (req, res) => {
  try {
    const kind = req.body?.kind;
    if (kind !== 'folder' && kind !== 'document') {
      return res.status(400).json({ error: 'Tipo de documento inválido' });
    }
    const named = resolveTitle(req.body?.title, kind);
    if (named.error) return res.status(400).json({ error: named.error });
    let parentId = req.body?.parentId ?? null;
    if (parentId === '') parentId = null;

    const created = await withLock(async (client) => {
      if (parentId) {
        const parent = await client.query(
          'SELECT id, kind FROM directorio_documents WHERE id = $1',
          [parentId],
        );
        if (!parent.rows[0]) {
          const error = new Error('No encontramos esa carpeta');
          error.statusCode = 404;
          throw error;
        }
        if (parent.rows[0].kind !== 'folder') {
          const error = new Error('Solo se puede crear dentro de una carpeta');
          error.statusCode = 400;
          throw error;
        }
      }
      const position = await client.query(
        `SELECT COALESCE(MAX(position), -1) + 1 AS next
         FROM directorio_documents
         WHERE parent_id IS NOT DISTINCT FROM $1`,
        [parentId],
      );
      const id = crypto.randomUUID();
      const content = kind === 'document' ? EMPTY_DOCUMENT : null;
      const inserted = await client.query(
        `INSERT INTO directorio_documents
           (id, parent_id, kind, title, content, position)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         RETURNING *`,
        [
          id,
          parentId,
          kind,
          named.title,
          content ? JSON.stringify(content) : null,
          position.rows[0].next,
        ],
      );
      const rows = await listRows(client);
      return {
        node: mapNode(inserted.rows[0], { includeContent: true }),
        nodes: rows.map((row) => mapNode(row)),
      };
    });
    res.status(201).json(created);
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    console.error('Error creating document:', error);
    res.status(500).json({ error: 'Error al crear el documento' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const body = req.body ?? {};
    const hasTitle = Object.prototype.hasOwnProperty.call(body, 'title');
    const hasContent = Object.prototype.hasOwnProperty.call(body, 'content');
    if (!hasTitle && !hasContent) {
      return res.status(400).json({ error: 'Nada para actualizar' });
    }

    const existing = await db.query(
      'SELECT * FROM directorio_documents WHERE id = $1',
      [req.params.id],
    );
    const row = existing.rows[0];
    if (!row) {
      return res.status(404).json({ error: 'No encontramos ese documento' });
    }

    if (hasTitle) {
      const named = resolveTitle(body.title, row.kind, { required: true });
      if (named.error) return res.status(400).json({ error: named.error });
      const saved = await db.query(
        `UPDATE directorio_documents
         SET title = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING *`,
        [row.id, named.title],
      );
      if (!hasContent) {
        return res.json(mapNode(saved.rows[0], { includeContent: true }));
      }
      row.title = named.title;
    }

    if (hasContent) {
      if (row.kind !== 'document') {
        return res
          .status(400)
          .json({ error: 'Las carpetas no tienen contenido' });
      }
      const parsed = parseDocumentContent(body.content);
      if (!parsed) {
        return res.status(400).json({ error: 'El documento no es válido' });
      }
      const writeToken = Number(body.writeToken);
      if (!Number.isInteger(writeToken) || writeToken <= 0) {
        return res.status(400).json({ error: 'No se pudo guardar el documento' });
      }
      const saved = await db.query(
        `UPDATE directorio_documents
         SET content = $2::jsonb,
             write_token = $3,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND write_token < $3
         RETURNING *`,
        [row.id, JSON.stringify(parsed), writeToken],
      );
      if (saved.rows[0]) {
        return res.json(mapNode({ ...saved.rows[0], applied: true }, { includeContent: true }));
      }
      const current = await db.query(
        'SELECT * FROM directorio_documents WHERE id = $1',
        [row.id],
      );
      if (!current.rows[0]) {
        return res.status(404).json({ error: 'No encontramos ese documento' });
      }
      return res.json(
        mapNode({ ...current.rows[0], applied: false }, { includeContent: true }),
      );
    }
  } catch (error) {
    console.error('Error updating document:', error);
    res.status(500).json({ error: 'Error al guardar el documento' });
  }
});

router.post('/:id/move', async (req, res) => {
  try {
    if (!Object.prototype.hasOwnProperty.call(req.body ?? {}, 'parentId')) {
      return res.status(400).json({ error: 'Falta la carpeta de destino' });
    }
    let parentId = req.body.parentId ?? null;
    if (parentId === '') parentId = null;
    const index = Number(req.body?.index);
    if (!Number.isInteger(index) || index < 0) {
      return res.status(400).json({ error: 'La posición no es válida' });
    }

    const nodes = await withLock(async (client) => {
      const rows = await listRows(client);
      const node = rows.find((row) => row.id === req.params.id);
      if (!node) {
        const error = new Error('No encontramos ese documento');
        error.statusCode = 404;
        throw error;
      }
      if (parentId) {
        const parent = rows.find((row) => row.id === parentId);
        if (!parent) {
          const error = new Error('No encontramos esa carpeta');
          error.statusCode = 404;
          throw error;
        }
        if (parent.kind !== 'folder') {
          const error = new Error('Solo se puede mover dentro de una carpeta');
          error.statusCode = 400;
          throw error;
        }
        if (parentId === node.id || descendantIds(rows, node.id).has(parentId)) {
          const error = new Error(
            'No se puede mover una carpeta dentro de sí misma',
          );
          error.statusCode = 400;
          throw error;
        }
      }

      const oldParent = node.parent_id ?? null;
      if (oldParent !== parentId) {
        const oldIds = orderedSiblings(rows, oldParent, node.id).map(
          (row) => row.id,
        );
        for (let i = 0; i < oldIds.length; i += 1) {
          await client.query(
            'UPDATE directorio_documents SET position = $2 WHERE id = $1',
            [oldIds[i], i],
          );
        }
      }

      const siblings = orderedSiblings(rows, parentId, node.id).map(
        (row) => row.id,
      );
      const nextIndex = Math.min(index, siblings.length);
      siblings.splice(nextIndex, 0, node.id);
      for (let i = 0; i < siblings.length; i += 1) {
        if (siblings[i] === node.id) {
          await client.query(
            `UPDATE directorio_documents
             SET parent_id = $2, position = $3, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [node.id, parentId, i],
          );
        } else {
          await client.query(
            'UPDATE directorio_documents SET position = $2 WHERE id = $1',
            [siblings[i], i],
          );
        }
      }

      const updated = await listRows(client);
      return updated.map((row) => mapNode(row));
    });
    res.json(nodes);
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    console.error('Error moving document:', error);
    res.status(500).json({ error: 'Error al mover el documento' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await db.query(
      'DELETE FROM directorio_documents WHERE id = $1',
      [req.params.id],
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'No encontramos ese documento' });
    }
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting document:', error);
    res.status(500).json({ error: 'Error al borrar el documento' });
  }
});

export default router;
