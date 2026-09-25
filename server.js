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
  attachments: new Map(),      // attachment_id -> {file_name, file_type, data: Buffer}
  log: [],                     // activity log shown in the UI
  // How GET /api/v1/message_threads answers — extranet.api's connect/reconnect check.
  // 'ok' → 200 | '401' / '403' → CHANNEX_CHECK_FAILED | 'network' → socket dropped → NETWORK_DISCONNECTED
  checkMode: 'ok',
};
const CHECK_MODES = ['ok', '401', '403', 'network'];

// A log entry carries structured fields so the UI can show the full URL, request,
// response and auth for every call: { direction, summary, method, url, auth,
// request, status, response, note }. All optional except direction + summary.
function logEvent(rec) {
  state.log.unshift({ id: uuid(), at: new Date().toISOString(), ...rec });
  if (state.log.length > 200) state.log.length = 200;
}

// Convenience for inbound Channex-API calls: auto-captures method/url/auth from req.
function logApi(req, summary, status, extra) {
  const host = req.headers.host ? 'http://' + req.headers.host : '';
  logEvent({
    direction: 'api-in',
    summary,
    method: (req.method || '').toUpperCase(),
    url: host + req.url,
    auth: `user-api-key: ${req.headers['user-api-key'] || '(none)'}` + (API_KEY ? '' : '   (gate off)'),
    request: extra && 'request' in extra ? extra.request : null,
    status,
    response: extra && 'response' in extra ? extra.response : null,
  });
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

function makeReview({ content, guest_name, ota_reservation_id, overall_score,
                      scores, booking_id, channel_id }) {
  const now = channexTime();
  return {
    id: uuid(),
    type: 'review',
    attributes: {
      id: undefined, // filled below to equal top-level id
      content: content || '',
      guest_name: guest_name || null,   // ezMessage resolves the name from the booking's customer
      ota: null,                        // ezMessage takes the OTA (otaCode) from the booking, not from Channex
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
      // property_id is not modelled: ezMessage resolves the hotel from the booking (CRS), never from Channex.
      property: { data: { id: null, type: 'property' } },
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
async function fireMessageWebhook(ezMessageBase, { bookingId, message, messageId, threadId, attachments = [] }) {
  const url = ezMessageBase.replace(/\/+$/, '') + '/channex/push_message';
  const payload = {
    event: 'message',
    payload: {
      id: messageId,
      message,
      meta: null,
      sender: 'guest',
      property_id: null,                // not modelled — ezMessage takes the hotel from the booking
      booking_id: bookingId,
      message_thread_id: threadId,
      live_feed_event_id: uuid(),
      attachments,
      have_attachment: attachments.length > 0,
      ota_message_id: uuid(),
    },
    property_id: null,
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
    logEvent({
      direction: 'webhook-out', summary: `POST ${url} → ${r.status}`,
      method: 'POST', url, auth: 'none (outbound webhook — no user-api-key sent)',
      request: payload, status: r.status, response: text,
    });
    return { ok: r.ok, status: r.status, body: text };
  } catch (e) {
    logEvent({
      direction: 'webhook-out', summary: `POST ${url} → ERROR`,
      method: 'POST', url, auth: 'none (outbound webhook — no user-api-key sent)',
      request: payload, status: 0, response: String(e && e.message || e),
    });
    return { ok: false, status: 0, body: String(e && e.message || e) };
  }
}

// ---------------------------------------------------------------------------
// Fire the review webhook to ezMessage (C1). Channex sends 'review' / 'updated_review';
// ezMessage treats it as a trigger to pull GET /api/v1/reviews, so it only reads the
// event + top-level property_id. We still emit the FULL Channex payload shape (all 23
// fields) so the log is faithful — content/raw_content/reviewer_name are null just like
// the real Channex webhook (that data comes from the GET /reviews resource).
// ---------------------------------------------------------------------------
async function fireReviewWebhook(ezMessageBase, review, event) {
  const url = ezMessageBase.replace(/\/+$/, '') + '/channex/push_review';
  const rel = review.relationships || {};
  const a = review.attributes || {};
  const bookingId = rel.booking && rel.booking.data ? rel.booking.data.id : null;
  const propertyId = rel.property && rel.property.data ? rel.property.data.id : null;
  const channelId = rel.channel && rel.channel.data ? rel.channel.data.id : null;
  const scores = (a.scores || []).map(s => ({ category: s.category, score: s.score }));
  const replyText = typeof a.reply === 'string' ? a.reply : null;
  const payload = {
    event: event || 'review',
    payload: {
      id: review.id,
      reply: replyText,
      content: null,                     // Channex sends null in the webhook; text is on GET /reviews
      channel_id: channelId,
      scores,
      ota: a.ota != null ? a.ota : null,
      property_id: propertyId,
      expired_at: null,
      is_hidden: !!a.is_hidden,
      is_replied: !!a.is_replied,
      ota_overall_score: a.overall_score != null ? a.overall_score : 0,
      ota_reservation_id: a.ota_reservation_id != null ? a.ota_reservation_id : null,
      ota_review_id: null,
      ota_scores: scores,
      overall_score: a.overall_score != null ? a.overall_score : 0,
      raw_content: null,
      received_at: a.received_at || channexTime(),
      reviewer_name: null,               // guest name is resolved by ezMessage from the booking
      booking_id: bookingId,
      live_feed_event_id: uuid(),
      ota_inserted_at: null,
      reply_scheduled_at: null,
      reply_sent_at: null,
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
    logEvent({
      direction: 'webhook-out', summary: `POST ${url} → ${r.status}`,
      method: 'POST', url, auth: 'none (outbound webhook — no user-api-key sent)',
      request: payload, status: r.status, response: text,
    });
    return { ok: r.ok, status: r.status, body: text };
  } catch (e) {
    logEvent({
      direction: 'webhook-out', summary: `POST ${url} → ERROR`,
      method: 'POST', url, auth: 'none (outbound webhook — no user-api-key sent)',
      request: payload, status: 0, response: String(e && e.message || e),
    });
    return { ok: false, status: 0, body: String(e && e.message || e) };
  }
}

// ---------------------------------------------------------------------------
// Reply to a review via the ezMessage EXTRANET (staff reply path). This is a
// DIFFERENT service/URL than the webhooks: extranet.api POST /channex/review/reply
// with { id, content }, where `id` is ezMessage's INTERNAL review id (not the mock/
// Channex id) and the endpoint is authenticated. Done server-side to avoid browser
// CORS. The extranet forwards to customer.api, which then POSTs the reply back to
// this mock's /api/v1/reviews/{id}/reply — so the reply round-trips into the review.
// ---------------------------------------------------------------------------
async function fireExtranetReply(extranetBase, { reviewId, content, authHeader }) {
  const url = extranetBase.replace(/\/+$/, '') + '/channex/review/reply';
  const body = { id: reviewId, content };
  const headers = { 'Content-Type': 'application/json' };
  let authDesc = 'none';
  if (authHeader && authHeader.includes(':')) {
    const i = authHeader.indexOf(':');
    const name = authHeader.slice(0, i).trim();
    const val = authHeader.slice(i + 1).trim();
    if (name && val) {
      headers[name] = val;
      authDesc = `${name}: ${val.length > 28 ? val.slice(0, 28) + '…' : val}`;
    }
  }
  try {
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    let text = ''; try { text = await r.text(); } catch { /* ignore */ }
    logEvent({
      direction: 'extranet-out', summary: `POST ${url} → ${r.status}`,
      method: 'POST', url, auth: authDesc, request: body, status: r.status, response: text,
    });
    return { ok: r.ok, status: r.status, body: text };
  } catch (e) {
    logEvent({
      direction: 'extranet-out', summary: `POST ${url} → ERROR`,
      method: 'POST', url, auth: authDesc, request: body, status: 0, response: String(e && e.message || e),
    });
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
      const out = {
        data: booking.messages.map(m => messageResource(bookingId, m)),
        meta: { limit: 100, page: 1, total: booking.messages.length },
      };
      logApi(req, `GET /api/v1/bookings/${bookingId}/messages → 200 (${booking.messages.length} msgs)`, 200, { response: out });
      return sendJson(res, 200, out);
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
        attachments.push(`attachments/${msgIn.attachment_id}`); // Channex: relative link
      }
      const m = {
        id: uuid(), sender: 'property', message: text || '',
        attachments, inserted_at: now, updated_at: now,
      };
      booking.messages.push(m);
      const out = { data: messageResource(bookingId, m) };
      logApi(req, `POST /api/v1/bookings/${bookingId}/messages → 201 (staff reply)`, 201, { request: body, response: out });
      return sendJson(res, 201, out);
    }
  }

  // GET /api/v1/message_threads — extranet.api's Channex check on OTA connect/reconnect
  // (ChannexConnectionService.checkChannexMessaging). Only the status matters to it:
  // 2xx → OK, 4xx → CHANNEX_CHECK_FAILED, I/O error → NETWORK_DISCONNECTED.
  if (parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'message_threads' && parts.length === 3 && method === 'GET') {
    const mode = state.checkMode;
    if (mode === 'network') {
      logApi(req, 'GET /api/v1/message_threads → connection dropped (simulated network failure)', null,
        { response: null });
      return req.socket.destroy();
    }
    if (mode === '401' || mode === '403') {
      const out = mode === '401'
        ? { errors: { code: 'unauthorized', title: 'Unauthorized' } }
        : { errors: { code: 'forbidden', title: 'Forbidden', detail: 'Messages & Reviews application is not installed' } };
      logApi(req, `GET /api/v1/message_threads → ${mode} (simulated connect-check failure)`, Number(mode), { response: out });
      return sendJson(res, Number(mode), out);
    }
    const page = Math.max(1, parseInt(u.searchParams.get('pagination[page]') || '1', 10) || 1);
    const limit = Math.max(1, parseInt(u.searchParams.get('pagination[limit]') || '10', 10) || 10);
    let all = [...state.bookings.entries()]
      .map(([bookingId, b]) => {
        const last = b.messages[b.messages.length - 1];
        const first = b.messages[0];
        return {
          id: b.thread_id,
          type: 'message_thread',
          attributes: {
            title: 'Guest',
            is_closed: false,
            message_count: b.messages.length,
            provider: 'BookingCom',
            last_message: last ? { message: last.message, sender: last.sender, attachments: last.attachments || [], inserted_at: last.inserted_at } : null,
            last_message_received_at: last ? last.inserted_at : null,
            inserted_at: first ? first.inserted_at : channexTime(),
            updated_at: last ? last.updated_at : channexTime(),
          },
          relationships: {
            property: { data: { id: null, type: 'property' } },
            booking: { data: { id: bookingId, type: 'booking' } },
          },
        };
      })
      .sort((a, b) => (b.attributes.updated_at || '').localeCompare(a.attributes.updated_at || ''));
    const data = all.slice((page - 1) * limit, (page - 1) * limit + limit);
    const out = { data, meta: { limit, page, total: all.length } };
    logApi(req, `GET /api/v1/message_threads → 200 (connect check OK, ${data.length}/${all.length} threads)`, 200, { response: out });
    return sendJson(res, 200, out);
  }

  // POST /api/v1/attachments  ->  { data: { id } }
  if (parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'attachments' && parts.length === 3 && method === 'POST') {
    const body = await readBody(req);
    const a = body.attachment || {};
    const id = uuid();
    state.attachments.set(id, {
      file_name: a.file_name || 'file', file_type: a.file_type || 'application/octet-stream',
      data: Buffer.from(a.file || '', 'base64'),
    });
    const out = { data: { id, type: 'attachment', attributes: { file_name: a.file_name, file_type: a.file_type } } };
    const logged = { attachment: { ...a, file: a.file ? `<${a.file.length} base64 chars>` : a.file } };
    logApi(req, `POST /api/v1/attachments → 201 (${a.file_name || 'file'})`, 201, { request: logged, response: out });
    return sendJson(res, 201, out);
  }

  // GET /api/v1/attachments/:id — download the bytes behind a message's relative attachment link
  // (ezMessage resolves "attachments/<id>" against channex.url, sending user-api-key).
  if (parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'attachments' && parts.length === 4 && method === 'GET') {
    const a = state.attachments.get(parts[3]);
    if (!a) {
      logApi(req, `GET /api/v1/attachments/${parts[3]} → 404`, 404, { response: null });
      return sendJson(res, 404, { errors: { title: 'Not Found' } });
    }
    logApi(req, `GET /api/v1/attachments/${parts[3]} → 200 (${a.file_name}, ${a.data.length} bytes)`, 200,
      { response: `<${a.file_type}, ${a.data.length} bytes>` });
    res.writeHead(200, {
      'Content-Type': a.file_type,
      'Content-Length': a.data.length,
      'Content-Disposition': `attachment; filename="${a.file_name.replace(/"/g, '')}"`,
      ...CORS,
    });
    return res.end(a.data);
  }

  // GET  /api/v1/reviews  (JSON:API pagination: pagination[page]/[limit] default 10).
  // property_id isn't modelled (the mock is one implicit property), so filter[property_id] is ignored.
  if (parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'reviews' && parts.length === 3 && method === 'GET') {
    const page = Math.max(1, parseInt(u.searchParams.get('pagination[page]') || '1', 10) || 1);
    const limit = Math.max(1, parseInt(u.searchParams.get('pagination[limit]') || '10', 10) || 10);
    // stamp attributes.id == top-level id (Channex does this); newest first (state.reviews is unshift-ed)
    const all = state.reviews.map(r => ({ ...r, attributes: { ...r.attributes, id: r.id } }));
    const start = (page - 1) * limit;
    const data = all.slice(start, start + limit);
    const out = { data, meta: { limit, page, total: all.length } };
    logApi(req, `GET /api/v1/reviews?page=${page}&limit=${limit} → 200 (${data.length}/${all.length})`, 200, { response: out });
    return sendJson(res, 200, out);
  }

  // GET  /api/v1/scores/:property_id  and  /api/v1/scores/:property_id/detailed  (C4)
  // Aggregates ALL mock reviews — property_id isn't modelled, so the path id is just echoed back.
  if (parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'scores' && parts[3] && method === 'GET') {
    const propertyId = parts[3];
    const detailed = parts[4] === 'detailed';
    const revs = state.reviews;
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
    const out = { data: { id: attributes.id, type: 'score', attributes, relationships } };
    logApi(req, `GET /api/v1/scores/${propertyId}${detailed ? '/detailed' : ''} → 200 (${count} reviews)`, 200, { response: out });
    return sendJson(res, 200, out);
  }

  // POST /api/v1/reviews/:id/reply
  if (parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'reviews' && parts[4] === 'reply' && method === 'POST') {
    const reviewId = parts[3];
    const body = await readBody(req);
    const replyText = body && body.reply && body.reply.reply;
    let review = state.reviews.find(r => r.id === reviewId);
    let stub = false;
    if (!review) {
      // Lenient: the review may have been created on a previous (now-restarted) mock
      // instance — this server's state is in-memory and resets on restart / Render
      // spin-down — or seeded straight into ezMessage's DB. Real Channex would 404,
      // but for testing we accept the reply anyway and auto-create a stub review so
      // the staff-reply flow (extranet → Channex → save) isn't blocked by lost state.
      review = makeReview({ guest_name: 'Unknown (reply-only)', content: '' });
      review.id = reviewId;
      review.attributes.id = reviewId;
      review.stub = true;
      state.reviews.unshift(review);
      stub = true;
    }
    review.attributes.reply = replyText || '';
    review.attributes.is_replied = true;
    review.attributes.updated_at = channexTime();
    const out = {
      data: {
        id: review.id, type: 'review',
        attributes: { id: review.id, is_hidden: review.attributes.is_hidden, is_replied: true, reply: replyText, updated_at: review.attributes.updated_at },
        relationships: review.relationships,
      },
    };
    logApi(req, `POST /api/v1/reviews/${reviewId}/reply → 200 (staff reply${stub ? ', stub review auto-created' : ''})`, 200, { request: body, response: out });
    return sendJson(res, 200, out);
  }

  // ===== Mock control endpoints (used by the UI, same-origin) =============
  if (parts[0] === 'mock') {
    if (!checkUi(req, res)) return;
    if (parts[1] === 'state' && method === 'GET') {
      const bookings = [...state.bookings.entries()].map(([id, b]) => ({
        booking_id: id, thread_id: b.thread_id, messages: b.messages,
      }));
      return sendJson(res, 200, { bookings, reviews: state.reviews, log: state.log, checkMode: state.checkMode });
    }

    if (parts[1] === 'check-mode' && method === 'POST') {
      const body = await readBody(req);
      if (!CHECK_MODES.includes(body.mode)) {
        return sendJson(res, 400, { error: `mode must be one of ${CHECK_MODES.join(', ')}` });
      }
      state.checkMode = body.mode;
      logEvent({ direction: 'mock', summary: `Connect check (GET /api/v1/message_threads) now answers: ${body.mode}` });
      return sendJson(res, 200, { ok: true, checkMode: state.checkMode });
    }

    if (parts[1] === 'send-message' && method === 'POST') {
      const body = await readBody(req);
      const bookingId = (body.booking_id || '').trim();
      const message = body.message || '';
      const ezMessageBase = (body.ez_message_url || 'http://localhost:8080').trim();
      // Guest attachments: [{ file_name, file_type, data (base64) }] → stored and exposed as relative
      // links "attachments/<id>" (Channex docs: "List of links to Attachments"; message may be empty).
      const files = Array.isArray(body.attachments) ? body.attachments : [];
      if (!bookingId || (!message && !files.length)) {
        return sendJson(res, 400, { error: 'booking_id and a message or attachment are required' });
      }
      const attachments = files.map((f) => {
        const id = uuid();
        state.attachments.set(id, {
          file_name: f.file_name || 'file', file_type: f.file_type || 'application/octet-stream',
          data: Buffer.from(f.data || '', 'base64'),
        });
        return `attachments/${id}`;
      });

      const now = channexTime();
      const b = getBooking(bookingId);
      const m = { id: uuid(), sender: 'guest', message, attachments, inserted_at: now, updated_at: now };
      b.messages.push(m);
      logEvent({
        direction: 'mock', summary: `Guest message queued for booking ${bookingId}`,
        note: message + (files.length ? ` [+${files.length} attachment(s): ${files.map(f => f.file_name).join(', ')}]` : ''),
      });

      const hook = await fireMessageWebhook(ezMessageBase, {
        bookingId, message, messageId: m.id, threadId: b.thread_id, attachments,
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
        logEvent({ direction: 'mock', summary: `Review ${existing.id} updated`, note: `${a.overall_score}/10 — ${a.content || ''}${a.reply ? ' | reply: ' + a.reply : ''}` });
        const webhook = await fireReviewWebhook(ezMessageBase, existing, body.event || 'updated_review');
        return sendJson(res, 200, { ok: true, review: existing, webhook });
      }
      if (!body.booking_id) {
        return sendJson(res, 400, { error: 'booking_id is required' });
      }
      const review = makeReview(body);
      state.reviews.unshift(review);
      logEvent({ direction: 'mock', summary: `Guest review created for booking ${body.booking_id}`, note: `${body.overall_score}/10 — ${body.content || ''}` });
      // C1: notify ezMessage so it pulls the review (mirrors the message flow). event defaults to 'review'.
      const webhook = await fireReviewWebhook(ezMessageBase, review, body.event);
      return sendJson(res, 200, { ok: true, review, webhook });
    }

    if (parts[1] === 'reply-extranet' && method === 'POST') {
      const body = await readBody(req);
      const extranetBase = (body.extranet_url || 'http://localhost:8084/api/v1/ezmessage').trim();
      const reviewId = (body.review_id || '').trim();
      const content = body.content || '';
      if (!reviewId || !content) {
        return sendJson(res, 400, { error: 'review_id (ezMessage internal review id) and content are required' });
      }
      const result = await fireExtranetReply(extranetBase, { reviewId, content, authHeader: (body.auth || '').trim() });
      return sendJson(res, 200, { ok: true, result });
    }

    if (parts[1] === 'reset' && method === 'POST') {
      state.bookings.clear();
      state.reviews.length = 0;
      state.attachments.clear();
      state.log.length = 0;
      logEvent({ direction: 'mock', summary: 'State reset' });
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
