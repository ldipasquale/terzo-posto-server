import express from 'express';
import {
  getMessageResponseRate,
  getPostsCount,
  getScorecardInstagramMetrics,
  InstagramApiError,
  InstagramNotConfiguredError,
} from '../lib/instagramService.js';

const router = express.Router();

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function parseWeekRange(query) {
  const from = typeof query.from === 'string' ? query.from : '';
  const to = typeof query.to === 'string' ? query.to : '';
  if (!YMD.test(from) || !YMD.test(to)) {
    return { error: 'Parámetros from y to son requeridos (YYYY-MM-DD)' };
  }
  // Semana del club en hora de Argentina (UTC-3, sin DST).
  const weekStart = new Date(`${from}T00:00:00-03:00`);
  const weekEnd = new Date(`${to}T23:59:59.999-03:00`);
  if (Number.isNaN(weekStart.getTime()) || Number.isNaN(weekEnd.getTime())) {
    return { error: 'Rango de fechas inválido' };
  }
  if (weekEnd < weekStart) {
    return { error: 'to no puede ser anterior a from' };
  }
  return { weekStart, weekEnd };
}

function sendInstagramError(res, error) {
  if (
    error instanceof InstagramNotConfiguredError ||
    error instanceof InstagramApiError
  ) {
    return res.status(error.statusCode).json({ error: error.message });
  }
  console.error('Error Instagram:', error);
  return res.status(502).json({ error: 'No se pudo consultar Instagram' });
}

router.get('/scorecard', async (req, res) => {
  const range = parseWeekRange(req.query);
  if (range.error) {
    return res.status(400).json({ error: range.error });
  }
  try {
    const metrics = await getScorecardInstagramMetrics(
      range.weekStart,
      range.weekEnd,
    );
    res.json(metrics);
  } catch (error) {
    sendInstagramError(res, error);
  }
});

router.get('/messages', async (req, res) => {
  const range = parseWeekRange(req.query);
  if (range.error) {
    return res.status(400).json({ error: range.error });
  }
  try {
    const metrics = await getMessageResponseRate(range.weekStart, range.weekEnd);
    res.json(metrics);
  } catch (error) {
    sendInstagramError(res, error);
  }
});

router.get('/posts', async (req, res) => {
  const range = parseWeekRange(req.query);
  if (range.error) {
    return res.status(400).json({ error: range.error });
  }
  try {
    const count = await getPostsCount(range.weekStart, range.weekEnd);
    res.json({ count });
  } catch (error) {
    sendInstagramError(res, error);
  }
});

export default router;
