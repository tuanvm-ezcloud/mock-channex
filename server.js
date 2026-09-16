/**
 * Mock Channex — a minimal stand-in for the Channex.io API + admin UI,
 * scoped to the two features ezMessage integrates with: guest MESSAGES and REVIEWS.
 *
 * Why a server (and not just a static HTML file):
 * Channex's message flow is PULL-based. When a guest sends a message Channex only
 * fires a lightweight webhook trigger to ezMessage (POST /channex/push_message);
 * ezMessage then calls BACK to Channex (GET /api/v1/bookings/{id}/messages) to pull
 * the real content. Reviews are pulled the same way (GET /api/v1/reviews) and staff
 * replies are POSTed back to Channex. So the mock must *be* the API that
 * `channex.url` points at — a browser-only page cannot answer those callbacks.
 *
 * Zero dependencies — Node 18+ built-ins only (http, fs, crypto, global fetch).
 *
 *   node server.js            # starts on http://localhost:4000
 *   PORT=5000 node server.js  # custom port
 *
 * Point ezMessage's customer.api at it (application.properties):
 *   channex.url=http://localhost:4000/api/v1/
 *   channex.api-key=<anything — the mock accepts any key and shows it in the log>
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 4000;
const INDEX = path.join(__dirname, 'index.html');

// ---------------------------------------------------------------------------
// Optional auth (for public/shared deploys). All OFF by default so local dev
// is unaffected — set the env vars only when you expose the mock.
//   MOCK_API_KEY      gate on /api/v1/* — incoming `user-api-key` must equal it
//                     (this is the value you also set as ezMessage's channex.api-key).
//   MOCK_UI_USER      Basic-auth username for the UI + /mock/* (default "admin").
//   MOCK_UI_PASSWORD  Basic-auth password for the UI + /mock/* — empty = UI open.
// `/healthz` is always public so platform health checks pass.
// ---------------------------------------------------------------------------
const API_KEY = process.env.MOCK_API_KEY || '';
const UI_USER = process.env.MOCK_UI_USER || 'admin';
const UI_PASSWORD = process.env.MOCK_UI_PASSWORD || '';

const uuid = () => crypto.randomUUID();

// Channex timestamp format: ISO local date-time, 6 fractional digits, NO 'Z'.
// (ezMessage parses reviews with strict LocalDateTime.parse, which rejects a 'Z'.)
function channexTime(d = new Date()) {
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}000`;
}

// ---------------------------------------------------------------------------
// In-memory state (resets when the process restarts).
// ---------------------------------------------------------------------------
const state = {
  // bookingId -> { thread_id, messages: [ {id, sender, message, attachments, inserted_at, updated_at} ] }
  bookings: new Map(),
  reviews: [],                 // Channex review objects (see makeReview)
  attachments: new Map(),      // attachment_id -> {file_name, file_type}
  log: [],                     // activity log shown in the UI
};

function logEvent(direction, summary, detail) {
  state.log.unshift({
    id: uuid(),
    at: new Date().toISOString(),
    direction,               // 'webhook-out' | 'api-in' | 'mock'
    summary,
    detail: detail || null,
  });
  if (state.log.length > 200) state.log.length = 200;
}

function getBooking(bookingId) {
  if (!state.bookings.has(bookingId)) {
    state.bookings.set(bookingId, { thread_id: uuid(), messages: [] });
  }
  return state.bookings.get(bookingId);
}

// ---------------------------------------------------------------------------
// Channex JSON:API shapes
// ---------------------------------------------------------------------------
function messageResource(bookingId, m) {
  return {
    id: m.id,
    type: 'message',
    attributes: {
      message: m.message,
      attachments: m.attachments || [],
      sender: m.sender,                 // "guest" | "property"
      inserted_at: m.inserted_at,
      updated_at: m.updated_at,
    },
    relationships: {
      message_thread: {
        data: { id: getBooking(bookingId).thread_id, type: 'message_thread' },
      },
      booking: { data: { id: bookingId, type: 'booking' } },
    },
  };
}

function makeReview({ content, guest_name, ota, ota_reservation_id, overall_score,
                      scores, booking_id, property_id, channel_id }) {
  const now = channexTime();
  return {
    id: uuid(),
    type: 'review',
    attributes: {
      id: undefined, // filled below to equal top-level id
      content: content || '',
      guest_name: guest_name || 'Guest',
      ota: ota || 'BookingCom',
      ota_reservation_id: ota_reservation_id || '',
      overall_score: Number(overall_score) || 0,
      is_hidden: false,
      is_replied: false,
      received_at: now,
      inserted_at: now,
      updated_at: now,
      reply: null,
      scores: (scores || []).map(s => ({ category: s.category, score: Number(s.score) })),
    },
    relationships: {
      booking: { data: { id: booking_id, type: 'booking' } },
      channel: { data: { id: channel_id || uuid(), type: 'channel' } },
      property: { data: { id: property_id, type: 'property' } },
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, user-api-key, Authorization',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch { resolve({ __raw: data }); }
    });
  });
}

// Channex-style API-key gate for /api/v1/* (real Channex 401s on a bad key too).
// Off when MOCK_API_KEY is unset. ezMessage sends channex.api-key as `user-api-key`.
function checkApiKey(res, apiKey) {
  if (!API_KEY || apiKey === API_KEY) return true;
  sendJson(res, 401, { errors: { title: 'Unauthorized', detail: 'Invalid user-api-key' } });
  return false;
}

// HTTP Basic auth for the human-facing UI + /mock/* control endpoints.
// Off when MOCK_UI_PASSWORD is unset. Once the browser authenticates the page
// load, it auto-attaches the credentials to same-origin /mock/* fetches.
function checkUi(req, res) {
  if (!UI_PASSWORD) return true;
  const h = req.headers['authorization'] || '';
  if (h.startsWith('Basic ')) {
    const [user, pass] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
    if (user === UI_USER && pass === UI_PASSWORD) return true;
  }
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="Mock Channex", charset="UTF-8"',
    'Content-Type': 'text/plain', ...CORS,
  });
  res.end('Authentication required');
  return false;
}

// ---------------------------------------------------------------------------
// Fire the message webhook to ezMessage (server-side, so no browser CORS issue).
// ---------------------------------------------------------------------------
async function fireMessageWebhook(ezMessageBase, { bookingId, message, propertyId, messageId, threadId }) {
  const url = ezMessageBase.replace(/\/+$/, '') + '/channex/push_message';
  const payload = {
    event: 'message',
    payload: {
      id: messageId,
      message,
      meta: null,
      sender: 'guest',
      property_id: propertyId || null,
      booking_id: bookingId,
      message_thread_id: threadId,
      live_feed_event_id: uuid(),
      attachments: [],
      have_attachment: false,
      ota_message_id: uuid(),
    },
    property_id: propertyId || null,
    user_id: null,
    timestamp: channexTime() + 'Z',
  };
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    let text = '';
    try { text = await r.text(); } catch { /* ignore */ }
    logEvent('webhook-out', `POST ${url} → ${r.status}`,
      `payload:\n${JSON.stringify(payload, null, 2)}\n\nresponse (${r.status}):\n${text}`);
    return { ok: r.ok, status: r.status, body: text };
  } catch (e) {
    logEvent('webhook-out', `POST ${url} → ERROR`, String(e && e.message || e));
    return { ok: false, status: 0, body: String(e && e.message || e) };
  }
}

// ---------------------------------------------------------------------------
// Fire the review webhook to ezMessage (C1). Channex sends 'review' / 'updated_review';
// ezMessage treats it as a trigger to pull GET /api/v1/reviews, so the payload is minimal.
// ---------------------------------------------------------------------------
async function fireReviewWebhook(ezMessageBase, review, event) {
  const url = ezMessageBase.replace(/\/+$/, '') + '/channex/push_review';
  const rel = review.relationships || {};
  const bookingId = rel.booking && rel.booking.data ? rel.booking.data.id : null;
  const propertyId = rel.property && rel.property.data ? rel.property.data.id : null;
  const payload = {
    event: event || 'review',
    payload: {
      id: review.id,
      booking_id: bookingId,
      property_id: propertyId,
      overall_score: review.attributes ? review.attributes.overall_score : 0,
      ota: review.attributes ? review.attributes.ota : null,
      is_hidden: false,
      is_replied: false,
      received_at: channexTime(),
    },
    property_id: propertyId,
    user_id: null,
    timestamp: channexTime() + 'Z',
  };
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    let text = '';
    try { text = await r.text(); } catch { /* ignore */ }
    logEvent('webhook-out', `POST ${url} → ${r.status}`,
      `payload:\n${JSON.stringify(payload, null, 2)}\n\nresponse (${r.status}):\n${text}`);
    return { ok: r.ok, status: r.status, body: text };
  } catch (e) {
    logEvent('webhook-out', `POST ${url} → ERROR`, String(e && e.message || e));
    return { ok: false, status: 0, body: String(e && e.message || e) };
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const parts = u.pathname.split('/').filter(Boolean);
  const method = req.method.toUpperCase();

  if (method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  // ---- Health check (always public, so platform probes pass under auth) ---
  if (method === 'GET' && u.pathname === '/healthz') {
    return sendJson(res, 200, { status: 'ok' });
  }

  // ---- UI ----------------------------------------------------------------
  if (method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
    if (!checkUi(req, res)) return;
    fs.readFile(INDEX, (err, buf) => {
      if (err) { res.writeHead(500); return res.end('index.html not found'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...CORS });
      res.end(buf);
    });
    return;
  }

  const apiKey = req.headers['user-api-key'] || null;

  // API-key gate for everything under /api/v1/* (ezMessage's callbacks).
  if (parts[0] === 'api' && !checkApiKey(res, apiKey)) return;

  // ===== Channex API (what ezMessage calls back to) =======================
  // GET  /api/v1/bookings/:id/messages
  // POST /api/v1/bookings/:id/messages
  if (parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'bookings' && parts[4] === 'messages') {
    const bookingId = parts[3];
    const booking = getBooking(bookingId);

    if (method === 'GET') {
      logEvent('api-in', `GET /api/v1/bookings/${bookingId}/messages → 200 (${booking.messages.length} msgs)`,
        `user-api-key: ${apiKey || '(none)'}`);
      return sendJson(res, 200, {
        data: booking.messages.map(m => messageResource(bookingId, m)),
        meta: { limit: 100, page: 1, total: booking.messages.length },
      });
    }

    if (method === 'POST') {
      // ezMessage staff reply lands here: { message: { message } } or { message: { attachment_id } }
      const body = await readBody(req);
      const msgIn = body.message || {};
      const now = channexTime();
      let text = msgIn.message;
      const attachments = [];
      if (!text && msgIn.attachment_id) {
        const a = state.attachments.get(msgIn.attachment_id);
        text = a ? `[attachment: ${a.file_name}]` : '[attachment]';
        attachments.push({ id: msgIn.attachment_id, ...(a || {}) });
      }
      const m = {
        id: uuid(), sender: 'property', message: text || '',
        attachments, inserted_at: now, updated_at: now,
      };
      booking.messages.push(m);
      logEvent('api-in', `POST /api/v1/bookings/${bookingId}/messages → 201 (staff reply)`,
        `user-api-key: ${apiKey || '(none)'}\nbody:\n${JSON.stringify(body, null, 2)}`);
      return sendJson(res, 201, { data: messageResource(bookingId, m) });
    }
  }

  // POST /api/v1/attachments  ->  { data: { id } }
  if (parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'attachments' && parts.length === 3 && method === 'POST') {
    const body = await readBody(req);
    const a = body.attachment || {};
    const id = uuid();
    state.attachments.set(id, { file_name: a.file_name || 'file', file_type: a.file_type || 'application/octet-stream' });
    logEvent('api-in', `POST /api/v1/attachments → 201 (${a.file_name || 'file'})`, `user-api-key: ${apiKey || '(none)'}`);
    return sendJson(res, 201, { data: { id, type: 'attachment', attributes: { file_name: a.file_name, file_type: a.file_type } } });
  }

  // GET  /api/v1/reviews  (JSON:API pagination: pagination[page]/[limit] default 10; filter[property_id] = C9)
  if (parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'reviews' && parts.length === 3 && method === 'GET') {
    const page = Math.max(1, parseInt(u.searchParams.get('pagination[page]') || '1', 10) || 1);
    const limit = Math.max(1, parseInt(u.searchParams.get('pagination[limit]') || '10', 10) || 10);
    const propFilter = u.searchParams.get('filter[property_id]');
    // C8 sim: a property whose id starts with "noapp" has no Messages & Reviews app → Channex 403.
    if (propFilter && propFilter.startsWith('noapp')) {
      logEvent('api-in', `GET /api/v1/reviews filter[property_id]=${propFilter} → 403 (app not installed)`, `user-api-key: ${apiKey || '(none)'}`);
      return sendJson(res, 403, { errors: { title: 'Forbidden', detail: 'Messages & Reviews application is not installed' } });
    }
    // stamp attributes.id == top-level id (Channex does this); newest first (state.reviews is unshift-ed)
    let all = state.reviews.map(r => ({ ...r, attributes: { ...r.attributes, id: r.id } }));
    if (propFilter) {
      all = all.filter(r => r.relationships && r.relationships.property && r.relationships.property.data
        && r.relationships.property.data.id === propFilter);
    }
    const start = (page - 1) * limit;
    const data = all.slice(start, start + limit);
    logEvent('api-in', `GET /api/v1/reviews?page=${page}&limit=${limit}${propFilter ? ' filter[property_id]=' + propFilter : ''} → 200 (${data.length}/${all.length})`, `user-api-key: ${apiKey || '(none)'}`);
    return sendJson(res, 200, { data, meta: { limit, page, total: all.length } });
  }

  // GET  /api/v1/scores/:property_id  and  /api/v1/scores/:property_id/detailed  (C4)
  if (parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'scores' && parts[3] && method === 'GET') {
    const propertyId = parts[3];
    const detailed = parts[4] === 'detailed';
    const revs = state.reviews.filter(r => r.relationships && r.relationships.property
      && r.relationships.property.data && r.relationships.property.data.id === propertyId);
    const count = revs.length;
    const avg = arr => arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 100) / 100 : 0;
    const overall = avg(revs.map(r => r.attributes.overall_score || 0));
    // per-category aggregate from each review's scores[]
    const cats = {};
    revs.forEach(r => (r.attributes.scores || []).forEach(s => {
      (cats[s.category] = cats[s.category] || []).push(s.score);
    }));
    const scores = {};
    Object.keys(cats).forEach(c => { scores[c] = { count: cats[c].length, score: avg(cats[c]) }; });
    const attributes = { id: uuid(), count, overall_score: overall, scores };
    const relationships = { property: { data: { id: propertyId, type: 'property', title: 'Mock Property' } } };
    if (detailed) {
      // one OTA breakdown per distinct ota, keyed by channel id
      const byOta = {};
      revs.forEach(r => { const o = r.attributes.ota || 'BookingCom'; (byOta[o] = byOta[o] || []).push(r); });
      relationships.ota_scores = Object.keys(byOta).map(o => ({
        data: {
          id: uuid(), type: 'ota_score',
          attributes: {
            channel_id: uuid(), ota: o, count: byOta[o].length,
            overall_score: avg(byOta[o].map(r => r.attributes.overall_score || 0)), scores,
          },
        },
      }));
    }
    logEvent('api-in', `GET /api/v1/scores/${propertyId}${detailed ? '/detailed' : ''} → 200 (${count} reviews)`, `user-api-key: ${apiKey || '(none)'}`);
    return sendJson(res, 200, { data: { id: attributes.id, type: 'score', attributes, relationships } });
  }

  // POST /api/v1/reviews/:id/reply
  if (parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'reviews' && parts[4] === 'reply' && method === 'POST') {
    const reviewId = parts[3];
    const body = await readBody(req);
    const replyText = body && body.reply && body.reply.reply;
    const review = state.reviews.find(r => r.id === reviewId);
    if (!review) {
      logEvent('api-in', `POST /api/v1/reviews/${reviewId}/reply → 404 (unknown review)`, JSON.stringify(body));
      return sendJson(res, 404, { errors: { title: 'Not Found' } });
    }
    review.attributes.reply = replyText || '';
    review.attributes.is_replied = true;
    review.attributes.updated_at = channexTime();
    logEvent('api-in', `POST /api/v1/reviews/${reviewId}/reply → 200 (staff reply)`,
      `user-api-key: ${apiKey || '(none)'}\nreply: ${replyText}`);
    return sendJson(res, 200, {
      data: {
        id: review.id, type: 'review',
        attributes: { id: review.id, is_hidden: review.attributes.is_hidden, is_replied: true, reply: replyText, updated_at: review.attributes.updated_at },
        relationships: review.relationships,
      },
    });
  }

  // ===== Mock control endpoints (used by the UI, same-origin) =============
  if (parts[0] === 'mock') {
    if (!checkUi(req, res)) return;
    if (parts[1] === 'state' && method === 'GET') {
      const bookings = [...state.bookings.entries()].map(([id, b]) => ({
        booking_id: id, thread_id: b.thread_id, messages: b.messages,
      }));
      return sendJson(res, 200, { bookings, reviews: state.reviews, log: state.log });
    }

    if (parts[1] === 'send-message' && method === 'POST') {
      const body = await readBody(req);
      const bookingId = (body.booking_id || '').trim();
      const message = body.message || '';
      const ezMessageBase = (body.ez_message_url || 'http://localhost:8080').trim();
      const propertyId = (body.property_id || '').trim() || null;
      if (!bookingId || !message) return sendJson(res, 400, { error: 'booking_id and message are required' });

      const now = channexTime();
      const b = getBooking(bookingId);
      const m = { id: uuid(), sender: 'guest', message, attachments: [], inserted_at: now, updated_at: now };
      b.messages.push(m);
      logEvent('mock', `Guest message queued for booking ${bookingId}`, message);

      const hook = await fireMessageWebhook(ezMessageBase, {
        bookingId, message, propertyId, messageId: m.id, threadId: b.thread_id,
      });
      return sendJson(res, 200, { ok: true, message: m, webhook: hook });
    }

    if (parts[1] === 'reviews' && method === 'POST') {
      const body = await readBody(req);
      const ezMessageBase = (body.ez_message_url || 'http://localhost:8080').trim();
      // C7 test path: if `id` matches an existing review, UPDATE it (mutate the fields given, bump
      // updated_at) and fire 'updated_review' by default — so ezMessage's upsert can be exercised.
      const existing = body.id ? state.reviews.find(r => r.id === body.id) : null;
      if (existing) {
        const a = existing.attributes;
        if (body.content !== undefined) a.content = body.content;
        if (body.overall_score !== undefined) a.overall_score = Number(body.overall_score) || 0;
        if (body.scores !== undefined) a.scores = (body.scores || []).map(s => ({ category: s.category, score: Number(s.score) }));
        if (body.reply !== undefined) { a.reply = body.reply; a.is_replied = !!body.reply; }
        if (body.is_hidden !== undefined) a.is_hidden = !!body.is_hidden;
        a.updated_at = channexTime();
        logEvent('mock', `Review ${existing.id} updated`, `${a.overall_score}/10 — ${a.content || ''}${a.reply ? ' | reply: ' + a.reply : ''}`);
        const webhook = await fireReviewWebhook(ezMessageBase, existing, body.event || 'updated_review');
        return sendJson(res, 200, { ok: true, review: existing, webhook });
      }
      if (!body.booking_id || !body.property_id) {
        return sendJson(res, 400, { error: 'booking_id and property_id are required' });
      }
      const review = makeReview(body);
      state.reviews.unshift(review);
      logEvent('mock', `Guest review created for booking ${body.booking_id}`, `${body.overall_score}/10 — ${body.content || ''}`);
      // C1: notify ezMessage so it pulls the review (mirrors the message flow). event defaults to 'review'.
      const webhook = await fireReviewWebhook(ezMessageBase, review, body.event);
      return sendJson(res, 200, { ok: true, review, webhook });
    }

    if (parts[1] === 'reset' && method === 'POST') {
      state.bookings.clear();
      state.reviews.length = 0;
      state.attachments.clear();
      state.log.length = 0;
      logEvent('mock', 'State reset', null);
      return sendJson(res, 200, { ok: true });
    }
  }

  // Fallback
  sendJson(res, 404, { error: 'Not found', method, path: u.pathname });
});

server.listen(PORT, () => {
  const base = `http://localhost:${PORT}`;
  console.log('');
  console.log('  Mock Channex running');
  console.log('  ---------------------------------------------------------');
  console.log(`  UI                 : ${base}/`);
  console.log(`  Channex API base   : ${base}/api/v1/`);
  console.log('');
  console.log('  Point ezMessage customer.api at the mock:');
  console.log(`      channex.url=${base}/api/v1/`);
  console.log('      channex.api-key=<any value>');
  console.log('');
  console.log('  Guest-message webhook is fired to the "ezMessage URL"');
  console.log('  set in the UI (default http://localhost:8080).');
  console.log('  ---------------------------------------------------------');
  console.log(`  Auth: /api/v1/* ${API_KEY ? 'REQUIRES user-api-key' : 'OPEN (set MOCK_API_KEY)'}`
    + `  |  UI ${UI_PASSWORD ? `Basic-auth as "${UI_USER}"` : 'OPEN (set MOCK_UI_PASSWORD)'}`);
  console.log('  ---------------------------------------------------------');
});
