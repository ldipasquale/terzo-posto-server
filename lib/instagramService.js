/**
 * Métricas de Instagram para el Scorecard.
 *
 * TODO: este token vence el 6 de noviembre de 2026, renovar manualmente
 * o implementar refresh automático (los long-lived tokens duran ~60 días).
 */

import https from 'https';

const GRAPH_API_VERSION = 'v25.0';
const GRAPH_API_BASE = `https://graph.instagram.com/${GRAPH_API_VERSION}`;
const PAGE_LIMIT = 50;
const MAX_PAGES = 10;
const HYDRATE_CONCURRENCY = 6;
const MS_24H = 24 * 60 * 60 * 1000;
const MESSAGE_DETAIL_FIELDS = 'id,created_time,from,message,story,attachments';

export class InstagramNotConfiguredError extends Error {
  constructor() {
    super('Instagram no está configurado (faltan INSTAGRAM_ACCESS_TOKEN o INSTAGRAM_USER_ID)');
    this.name = 'InstagramNotConfiguredError';
    this.statusCode = 503;
  }
}

export class InstagramApiError extends Error {
  constructor(message, statusCode = 502) {
    super(message);
    this.name = 'InstagramApiError';
    this.statusCode = statusCode;
  }
}

function getConfig() {
  const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN?.trim();
  const userId = process.env.INSTAGRAM_USER_ID?.trim();
  if (!accessToken || !userId) {
    throw new InstagramNotConfiguredError();
  }
  return { accessToken, userId };
}

function parseIgTime(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function asData(node) {
  if (!node) return [];
  if (Array.isArray(node)) return node;
  if (Array.isArray(node.data)) return node.data;
  return [];
}

function senderId(message) {
  const id = message?.from?.id;
  return id != null ? String(id) : null;
}

function senderUsername(message) {
  const username = message?.from?.username;
  return username ? String(username).toLowerCase() : null;
}

function classifySender(message, businessIds, businessUsernames) {
  const id = senderId(message);
  const username = senderUsername(message);
  if (id && businessIds.has(id)) return 'business';
  if (username && businessUsernames.has(username)) return 'business';
  if (id || username) return 'client';
  return 'unknown';
}

function withToken(url, accessToken) {
  const next = new URL(url);
  if (!next.searchParams.has('access_token')) {
    next.searchParams.set('access_token', accessToken);
  }
  return next.toString();
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let payload = null;
        try {
          payload = body ? JSON.parse(body) : null;
        } catch {
          payload = null;
        }
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode ?? 0,
          payload,
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => {
      req.destroy(new Error('Timeout al consultar Instagram'));
    });
  });
}

async function igFetch(url, accessToken) {
  let response;
  try {
    response = await httpsGetJson(withToken(url, accessToken));
  } catch (error) {
    throw new InstagramApiError(
      `Error de red al consultar Instagram: ${error instanceof Error ? error.message : 'desconocido'}`,
    );
  }

  const payload = response.payload;
  if (!response.ok || payload?.error) {
    const igMessage = payload?.error?.message || `HTTP ${response.status}`;
    const status = response.status === 429 ? 429 : 502;
    throw new InstagramApiError(`Instagram: ${igMessage}`, status);
  }

  return payload;
}

async function paginateUntil(firstUrl, accessToken, getTimestamp, cutoff) {
  const items = [];
  let url = firstUrl;
  let pages = 0;

  while (url && pages < MAX_PAGES) {
    const payload = await igFetch(url, accessToken);
    const batch = asData(payload);
    let reachedCutoff = false;

    for (const item of batch) {
      const timestamp = getTimestamp(item);
      if (timestamp && timestamp < cutoff) {
        reachedCutoff = true;
        break;
      }
      items.push(item);
    }

    if (reachedCutoff) break;
    url = payload?.paging?.next || null;
    pages += 1;
  }

  return items;
}

async function mapPool(items, mapper, concurrency = HYDRATE_CONCURRENCY) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(items.length, 0)) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

async function fetchMe(accessToken) {
  return igFetch(
    `${GRAPH_API_BASE}/me?fields=id,username`,
    accessToken,
  );
}

function conversationActivityTime(conversation) {
  const updated = parseIgTime(conversation.updated_time);
  if (updated) return updated;
  const messages = asData(conversation.messages);
  const newest = messages
    .map((message) => parseIgTime(message.created_time))
    .filter(Boolean)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  return newest ?? null;
}

async function listConversationsSince(cutoff, accessToken) {
  const rich = new URLSearchParams({
    platform: 'instagram',
    fields: `id,updated_time,participants,messages.limit(20){${MESSAGE_DETAIL_FIELDS}}`,
    limit: String(PAGE_LIMIT),
    access_token: accessToken,
  });
  try {
    return await paginateUntil(
      `${GRAPH_API_BASE}/me/conversations?${rich}`,
      accessToken,
      conversationActivityTime,
      cutoff,
    );
  } catch (error) {
    console.warn(
      '[instagram] listado rico de conversaciones falló, reintento básico:',
      error instanceof Error ? error.message : error,
    );
    const basic = new URLSearchParams({
      platform: 'instagram',
      fields: 'id,updated_time,participants',
      limit: String(PAGE_LIMIT),
      access_token: accessToken,
    });
    return paginateUntil(
      `${GRAPH_API_BASE}/me/conversations?${basic}`,
      accessToken,
      (conversation) => parseIgTime(conversation.updated_time),
      cutoff,
    );
  }
}

async function fetchMessageDetails(messageId, accessToken) {
  const params = new URLSearchParams({
    fields: MESSAGE_DETAIL_FIELDS,
    access_token: accessToken,
  });
  return igFetch(
    `${GRAPH_API_BASE}/${encodeURIComponent(messageId)}?${params}`,
    accessToken,
  );
}

function needsMessageDetails(message) {
  if (!message?.id) return false;
  const hasSender = Boolean(message?.from?.id || message?.from?.username);
  const hasBody = message.message !== undefined || message.story !== undefined;
  return !hasSender || !hasBody;
}

async function hydrateMessageDetails(messages, weekStart, weekEnd, accessToken) {
  const hydrateStart = new Date(weekStart.getTime() - MS_24H);
  const hydrateEnd = new Date(weekEnd.getTime() + MS_24H);
  const missing = messages.filter((message) => {
    if (!needsMessageDetails(message)) return false;
    const created = parseIgTime(message.created_time);
    if (!created) return true;
    return created >= hydrateStart && created <= hydrateEnd;
  });

  if (missing.length === 0) return messages;

  const details = await mapPool(missing.slice(0, 8), (message) =>
    fetchMessageDetails(message.id, accessToken).catch(() => null),
  );
  const byId = new Map(
    details.filter(Boolean).map((message) => [String(message.id), message]),
  );

  return messages.map((message) => {
    const extra = message?.id ? byId.get(String(message.id)) : null;
    if (!extra) return message;
    return {
      ...message,
      created_time: extra.created_time || message.created_time,
      from: extra.from || message.from,
      message: extra.message !== undefined ? extra.message : message.message,
      story: extra.story !== undefined ? extra.story : message.story,
      attachments: extra.attachments || message.attachments,
    };
  });
}

/** Respuesta a una story nuestra o mención/etiqueta en una story ajena. */
export function storyInteractionKind(message) {
  const story = message?.story;
  if (story && typeof story === 'object') {
    if (story.mention) return 'mencion';
    if (story.reply || story.reply_to) return 'respuesta';
    if (story.link || story.id) return 'respuesta';
    if (Object.keys(story).length > 0) return 'story';
  }

  const attachments = asData(message?.attachments);
  const storyAttachment = attachments.some((attachment) => {
    const type = String(attachment.type || attachment.mime_type || '').toLowerCase();
    const name = String(attachment.name || '').toLowerCase();
    return (
      type.includes('story') ||
      name.includes('story_mention') ||
      name.includes('story mention') ||
      name.includes('story reply')
    );
  });
  return storyAttachment ? 'mencion' : null;
}

function messageText(message) {
  return String(message?.message || '').replace(/\s+/g, ' ').trim();
}

function hasRegularMedia(message) {
  return asData(message?.attachments).some(
    (attachment) =>
      attachment.image_data ||
      attachment.video_data ||
      attachment.file_url ||
      attachment.generic_template,
  );
}

/** Consulta real: el cliente escribió o mandó media, y no es interacción de story. */
export function isInquiryMessage(message) {
  if (storyInteractionKind(message)) return false;
  return messageText(message).length > 0 || hasRegularMedia(message);
}

/**
 * Primer mensaje del cliente en el rango que inició o reactivó la conversación,
 * y si Terzo Posto respondió dentro de las 24 hs siguientes.
 */
export function analyzeConversationMessages(
  messages,
  weekStart,
  weekEnd,
  businessIds,
  businessUsernames = new Set(),
) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { skipReason: 'sin_mensajes' };
  }

  const ids = businessIds instanceof Set ? businessIds : new Set([String(businessIds)]);
  const chronological = [...messages].sort((a, b) => {
    const aTime = parseIgTime(a.created_time)?.getTime() ?? 0;
    const bTime = parseIgTime(b.created_time)?.getTime() ?? 0;
    return aTime - bTime;
  });

  const inWeek = chronological.filter((message) => {
    const created = parseIgTime(message.created_time);
    return created && created >= weekStart && created <= weekEnd;
  });

  if (inWeek.length === 0) {
    return { skipReason: 'sin_mensajes_en_la_semana' };
  }

  const unknownInWeek = inWeek.filter(
    (message) => classifySender(message, ids, businessUsernames) === 'unknown',
  ).length;

  const clientInWeek = chronological.filter((message) => {
    const created = parseIgTime(message.created_time);
    if (!created || created < weekStart || created > weekEnd) return false;
    return classifySender(message, ids, businessUsernames) === 'client';
  });
  const storyOnly = clientInWeek.filter((message) => storyInteractionKind(message));
  const trigger = clientInWeek.find((message) => isInquiryMessage(message));

  if (!trigger) {
    let skipReason = 'solo_mensajes_propios';
    if (unknownInWeek === inWeek.length) skipReason = 'mensajes_sin_remitente';
    else if (storyOnly.length > 0 && storyOnly.length === clientInWeek.length) {
      skipReason = 'solo_reacciones_a_stories';
    } else if (clientInWeek.length > 0) {
      skipReason = 'sin_consulta_escrita';
    }
    return {
      skipReason,
      messagesInWeek: inWeek.length,
      unknownInWeek,
      storyInteractions: storyOnly.length,
    };
  }

  const triggerTime = parseIgTime(trigger.created_time);
  const deadline = new Date(triggerTime.getTime() + MS_24H);
  const reply = chronological.find((message) => {
    const created = parseIgTime(message.created_time);
    if (!created || created <= triggerTime) return false;
    return classifySender(message, ids, businessUsernames) === 'business';
  });

  const repliedAt = reply ? parseIgTime(reply.created_time) : null;
  return {
    respondedWithin24h: Boolean(repliedAt && repliedAt <= deadline),
    triggerAt: triggerTime.toISOString(),
    repliedAt: repliedAt ? repliedAt.toISOString() : null,
    clientUsername: senderUsername(trigger),
    triggerPreview: messageText(trigger).slice(0, 80) || '(media)',
    messagesInWeek: inWeek.length,
    unknownInWeek,
    storyInteractions: storyOnly.length,
  };
}

function summarizeRates(results) {
  const counted = results.filter((item) => item.respondedWithin24h != null);
  const total = counted.length;
  const respondedWithin24h = counted.filter((item) => item.respondedWithin24h).length;
  return {
    total,
    respondedWithin24h,
    percentage: total === 0 ? null : (respondedWithin24h / total) * 100,
  };
}

/**
 * Semana actual solamente (el período anterior no se consulta: era lento y poco útil).
 */
async function listMediaSince(cutoff, accessToken) {
  const params = new URLSearchParams({
    fields: 'id,timestamp,caption,permalink,media_type',
    limit: String(PAGE_LIMIT),
    access_token: accessToken,
  });
  return paginateUntil(
    `${GRAPH_API_BASE}/me/media?${params}`,
    accessToken,
    (item) => parseIgTime(item.timestamp),
    cutoff,
  );
}

export async function getScorecardInstagramMetrics(weekStart, weekEnd) {
  const config = getConfig();
  const [meResult, conversationsResult, mediaResult] = await Promise.allSettled([
    fetchMe(config.accessToken),
    listConversationsSince(weekStart, config.accessToken),
    listMediaSince(weekStart, config.accessToken),
  ]);

  const me = meResult.status === 'fulfilled' ? meResult.value : null;
  const conversations =
    conversationsResult.status === 'fulfilled' ? conversationsResult.value : [];
  const media = mediaResult.status === 'fulfilled' ? mediaResult.value : [];
  const fetchErrors = {
    me: meResult.status === 'rejected' ? String(meResult.reason?.message || meResult.reason) : null,
    conversations:
      conversationsResult.status === 'rejected'
        ? String(conversationsResult.reason?.message || conversationsResult.reason)
        : null,
    media:
      mediaResult.status === 'rejected'
        ? String(mediaResult.reason?.message || mediaResult.reason)
        : null,
  };
  for (const [key, message] of Object.entries(fetchErrors)) {
    if (message) console.warn(`[instagram] ${key} falló:`, message);
  }

  const businessIds = new Set(
    [config.userId, me?.id].filter(Boolean).map((id) => String(id)),
  );
  const businessUsernames = new Set(
    [me?.username].filter(Boolean).map((name) => String(name).toLowerCase()),
  );

  const conversationDebug = await mapPool(conversations, async (conversation) => {
    let messages = asData(conversation.messages);
    if (messages.length === 0 && conversation.id) {
      try {
        const payload = await igFetch(
          `${GRAPH_API_BASE}/${encodeURIComponent(conversation.id)}?${new URLSearchParams({
            fields: `messages.limit(20){${MESSAGE_DETAIL_FIELDS}}`,
            access_token: config.accessToken,
          })}`,
          config.accessToken,
        );
        messages = asData(payload?.messages);
      } catch (error) {
        console.warn(
          '[instagram] no se pudieron leer mensajes de',
          conversation.id,
          error instanceof Error ? error.message : error,
        );
      }
    }
    messages = await hydrateMessageDetails(
      messages,
      weekStart,
      weekEnd,
      config.accessToken,
    );
    const analysis = analyzeConversationMessages(
      messages,
      weekStart,
      weekEnd,
      businessIds,
      businessUsernames,
    );
    const other = asData(conversation.participants).find(
      (participant) => !businessIds.has(String(participant.id || '')),
    );

    return {
      id: conversation.id,
      updatedTime: conversation.updated_time || null,
      messageCount: messages.length,
      messagesWithFrom: messages.filter((message) => message?.from?.id || message?.from?.username)
        .length,
      clientUsername: analysis.clientUsername || other?.username || null,
      triggerAt: analysis.triggerAt || null,
      triggerPreview: analysis.triggerPreview || null,
      repliedAt: analysis.repliedAt || null,
      respondedWithin24h: analysis.respondedWithin24h ?? null,
      skipReason: analysis.skipReason || null,
      storyInteractions: analysis.storyInteractions ?? 0,
    };
  });

  const messages = summarizeRates(conversationDebug);

  const postsDebug = media.map((item) => {
    const timestamp = parseIgTime(item.timestamp);
    const inRange = Boolean(timestamp && timestamp >= weekStart && timestamp <= weekEnd);
    return {
      id: item.id,
      timestamp: item.timestamp || null,
      mediaType: item.media_type || null,
      caption: item.caption || null,
      permalink: item.permalink || null,
      inRange,
    };
  });
  const postsInWeek = postsDebug.filter((item) => item.inRange);

  const debug = {
    range: {
      from: weekStart.toISOString(),
      to: weekEnd.toISOString(),
    },
    me: {
      id: me?.id || null,
      username: me?.username || null,
      configuredUserId: config.userId,
    },
    conversationsFetched: conversations.length,
    conversationsCounted: messages.total,
    postsFetched: postsDebug.length,
    postsInWeek: postsInWeek.length,
    fetchErrors,
    conversations: conversationDebug,
    posts: postsDebug,
  };

  console.log('[instagram] scorecard', {
    range: debug.range,
    me: debug.me,
    conversationsFetched: debug.conversationsFetched,
    conversationsCounted: debug.conversationsCounted,
    respondedWithin24h: messages.respondedWithin24h,
    postsFetched: debug.postsFetched,
    postsInWeek: debug.postsInWeek,
  });

  return {
    messages,
    posts: postsInWeek.length,
    debug,
  };
}

export async function getMessageResponseRate(weekStart, weekEnd) {
  const { messages } = await getScorecardInstagramMetrics(weekStart, weekEnd);
  return messages;
}

export async function getPostsCount(weekStart, weekEnd) {
  const { posts } = await getScorecardInstagramMetrics(weekStart, weekEnd);
  return posts;
}
