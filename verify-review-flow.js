/*
 * verify-review-flow.js — bidirectional Review-flow verification against the mock Channex.
 *
 * WHY a stand-in instead of the real ezMessage: customer.api/extranet.api need MariaDB, Redis and
 * internal gRPC (CRS/ez_admin) that are not reachable from this box, so the Spring apps can't boot here.
 * This harness drives the SAME HTTP contract and mirrors the SAME ingest/reply DECISIONS the Java makes
 * (ReviewWebhookService + ReviewService.syncReviewsForProperty + ReviewIngestService.upsertReview, and
 * extranet ReviewService.replyReview / C3), against the REAL mock, and asserts the end state.
 *
 * Run:  node mock-channex/verify-review-flow.js       (spawns the mock on :4000, stand-in on :8090)
 */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const MOCK = 'http://localhost:4000';
const EZ_BASE = 'http://localhost:8090';
const HDR = { 'Content-Type': 'application/json', 'user-api-key': 'test-key' };

// ---- in-memory "ezMessage DB" -------------------------------------------------
const db = { reviews: new Map(), bookings: new Map(), lastIngest: [] };
const seedBooking = (extId, o) => db.bookings.set(extId, o); // {propertyId(ezCloud), otaCode, connected}

// Mirrors ReviewIngestService.applyChannexAttributes (C4/C5/C6)
function applyAttrs(r, rv) {
  const a = rv.attributes;
  r.guestName = a.guest_name;
  r.otaName = a.ota;
  r.otaReservationId = a.ota_reservation_id;
  r.receivedAt = a.received_at;
  r.isReplied = a.is_replied;
  r.tags = a.tags && a.tags.length ? a.tags.join(',') : null;
  r.expiredAt = a.expired_at || null;
  r.channexPropertyId = rv.relationships?.property?.data?.id || null;
}
// Mirrors syncRatings / syncGuestComment / syncReplyComment (C7)
function syncChildren(r, a) {
  r.ratings = {};
  (a.scores || []).forEach(s => { r.ratings[s.category] = s.score; });
  r.guestComment = a.content;                 // isProperty=false
  const reply = typeof a.reply === 'string' ? a.reply.trim() : null;
  if (reply) r.replyComment = reply;          // isProperty=true; empty leaves local reply intact (C3)
}

// Mirrors ReviewIngestService.upsertReview (B3 gate + C7 upsert keyed on externalReviewCode).
function upsert(rv) {
  const code = rv.id;
  const a = rv.attributes;
  const bookingId = rv.relationships?.booking?.data?.id;
  if (!bookingId) return { code, skipped: 'no-booking' };
  const booking = db.bookings.get(bookingId);
  if (!booking) return { code, skipped: 'no-booking-record' };            // (Java would gRPC-hydrate)
  if (!booking.connected) return { code, skipped: 'gate-not-connected' }; // B3
  const existing = db.reviews.get(code);
  if (existing) {
    if (existing.otaUpdatedAt && a.updated_at
        && new Date(a.updated_at) <= new Date(existing.otaUpdatedAt)) {
      return { code, skipped: 'unchanged' };                              // C7 change-detect
    }
    existing.overallScore = a.overall_score;
    existing.isHidden = a.is_hidden;
    existing.otaUpdatedAt = a.updated_at;
    applyAttrs(existing, rv);
    syncChildren(existing, a);
    return { code, updated: true };
  }
  const r = {
    code, propertyId: booking.propertyId, otaCode: booking.otaCode,
    overallScore: a.overall_score, isHidden: a.is_hidden, otaUpdatedAt: a.updated_at,
    ratings: {}, guestComment: null, replyComment: null,
  };
  applyAttrs(r, rv);
  syncChildren(r, a);
  db.reviews.set(code, r);
  return { code, inserted: true };
}

// Mirrors ReviewService.runSync. The webhook's property_id is null (not modelled by the mock), so this
// is the account-wide pull; filter[property_id] / the C8 403 path aren't exercised.
async function pullAndIngest(channexPropertyId) {
  let page = 1; const limit = 100; const results = [];
  while (true) {
    let url = `${MOCK}/api/v1/reviews?pagination%5Bpage%5D=${page}&pagination%5Blimit%5D=${limit}`;
    if (channexPropertyId) url += `&filter%5Bproperty_id%5D=${encodeURIComponent(channexPropertyId)}`;
    const resp = await fetch(url, { headers: HDR });
    if (resp.status === 403) return { app403: true, results };  // C8
    const j = await resp.json();
    if (!j.data || j.data.length === 0) break;
    for (const rv of j.data) results.push(upsert(rv));
    if (!j.meta || page * limit >= j.meta.total) break;
    page++;
  }
  db.lastIngest = results;
  return { results };
}

// Mirrors ReviewWebhookService.handle (C1: event filter + hotel-aware trigger).
async function handleWebhook(body) {
  const event = body && body.event;
  if (event !== 'review' && event !== 'updated_review') return { ignored: event };
  return pullAndIngest(body.property_id);
}

// Mirrors extranet ReviewService.replyReview (C3 push-then-persist).
async function replyToReview(reviewCode, text, headers = HDR) {
  const resp = await fetch(`${MOCK}/api/v1/reviews/${reviewCode}/reply`, {
    method: 'POST', headers, body: JSON.stringify({ reply: { reply: text } }),
  });
  if (!resp.ok) return { error: `push failed ${resp.status}` };   // C3: DON'T persist local
  const r = db.reviews.get(reviewCode);
  if (r) { r.replyComment = text; r.isReplied = true; }
  return { ok: true };
}

// ---- mock control helpers -----------------------------------------------------
const createReview = (b) => fetch(`${MOCK}/mock/reviews`, { method: 'POST', headers: HDR, body: JSON.stringify({ ...b, ez_message_url: EZ_BASE }) }).then(r => r.json());
const reset = () => fetch(`${MOCK}/mock/reset`, { method: 'POST', headers: HDR }).then(r => r.json());

// ---- assertions ---------------------------------------------------------------
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? '  → ' + detail : ''}`); }
}

async function main() {
  // 1) start the mock
  // API-key gate ON so a wrong key can simulate a failed push (the reply endpoint is lenient on unknown ids).
  const mock = spawn('node', [path.join(__dirname, 'server.js')], {
    stdio: 'ignore', env: { ...process.env, MOCK_API_KEY: HDR['user-api-key'] },
  });
  // 2) start the ezMessage stand-in webhook receiver
  const srv = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/channex/push_review') {
      let b = ''; req.on('data', c => b += c).on('end', async () => {
        let body = {}; try { body = JSON.parse(b); } catch {}
        const r = await handleWebhook(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ responseCode: 0, data: 'ok', ingest: r }));
      });
    } else { res.writeHead(404); res.end(); }
  }).listen(8090);
  await waitFor(`${MOCK}/mock/state`);

  try {
    // ===================== INBOUND (Channex → ezMessage) =====================
    console.log('\n── INBOUND: review + updated_review, pull, upsert ──');
    await reset();
    seedBooking('BK-INB', { propertyId: 'ez-hotel-1', otaCode: 'BDC', connected: true });

    const created = await createReview({
      booking_id: 'BK-INB', overall_score: 8, guest_name: 'Alice',
      ota_reservation_id: 'RES-77', content: 'Lovely stay',
      scores: [{ category: 'clean', score: 8 }, { category: 'location', score: 9 }],
    });
    const code = created.review.id;
    const r1 = db.reviews.get(code);
    check('review ingested (webhook → pull → insert)', !!r1);
    check('overall score stored', r1 && r1.overallScore === 8, r1 && `${r1.overallScore}`);
    check('guest content stored', r1 && r1.guestComment === 'Lovely stay');
    check('ratings stored (clean+location)', r1 && r1.ratings.clean === 8 && r1.ratings.location === 9);
    check('C5 fields stored (guestName/otaName/reservationId/receivedAt)',
      r1 && r1.guestName === 'Alice' && r1.otaName === null && r1.otaReservationId === 'RES-77' && !!r1.receivedAt);
    check('channexPropertyId is null (mock does not model property_id)', r1 && r1.channexPropertyId === null, r1 && r1.channexPropertyId);
    check('B1 ezCloud propertyId from booking (not Channex id)', r1 && r1.propertyId === 'ez-hotel-1');
    const insertedUpdatedAt = r1 && r1.otaUpdatedAt;

    // idempotent re-pull (no mock change) → C7 change-detect skip
    await pullAndIngest(null);
    check('idempotent re-pull → skipped (otaUpdatedAt unchanged)',
      db.lastIngest.some(x => x.code === code && x.skipped === 'unchanged'));

    // updated_review: change score + add OTA reply
    await new Promise(r => setTimeout(r, 1100)); // ensure updated_at strictly newer
    await createReview({ id: code, overall_score: 5, content: 'Edited: was ok', reply: 'Thanks Alice!' });
    const r2 = db.reviews.get(code);
    check('updated_review applied (score 8→5)', r2 && r2.overallScore === 5, r2 && `${r2.overallScore}`);
    check('updated content applied', r2 && r2.guestComment === 'Edited: was ok');
    check('otaUpdatedAt advanced', r2 && r2.otaUpdatedAt !== insertedUpdatedAt);
    check('OTA-side reply synced into replyComment (C7)', r2 && r2.replyComment === 'Thanks Alice!');

    // B3 gate: review for a booking whose channel is NOT connected → skipped
    console.log('\n── INBOUND: B3 connection gate ──');
    seedBooking('BK-OFF', { propertyId: 'ez-hotel-1', otaCode: 'BDC', connected: false });
    const off = await createReview({ booking_id: 'BK-OFF', overall_score: 7, content: 'x' });
    check('review for disconnected channel is NOT ingested (B3)',
      db.lastIngest.some(x => x.skipped === 'gate-not-connected') && !db.reviews.has(off.review.id));

    // ===================== OUTBOUND (ezMessage → Channex) =====================
    console.log('\n── OUTBOUND: staff reply push-then-persist (C3) ──');
    await reset(); db.reviews.clear();
    seedBooking('BK-OUT', { propertyId: 'ez-hotel-2', otaCode: 'BDC', connected: true });
    const c = await createReview({ booking_id: 'BK-OUT', overall_score: 7, content: 'fine' });
    const outCode = c.review.id;
    const ok = await replyToReview(outCode, 'Cảm ơn quý khách!');
    check('reply push succeeded', ok.ok === true);
    check('local reply comment persisted after push OK (C3)', db.reviews.get(outCode).replyComment === 'Cảm ơn quý khách!');
    const state = await fetch(`${MOCK}/mock/state`).then(r => r.json());
    const mockReview = state.reviews.find(r => r.id === outCode);
    check('reply reached Channex (mock attributes.reply + is_replied)',
      mockReview && mockReview.attributes.reply === 'Cảm ơn quý khách!' && mockReview.attributes.is_replied === true);

    // C3: push FAILS (wrong user-api-key → mock 401) → must NOT persist locally
    const before = JSON.stringify([...db.reviews.entries()]);
    const failRes = await replyToReview(outCode, 'ghost', { ...HDR, 'user-api-key': 'wrong-key' });
    check('reply push failure returns error', !!failRes.error, failRes.error);
    check('no local write on push failure (C3 push-then-persist)', JSON.stringify([...db.reviews.entries()]) === before);

    // ===================== ROUND-TRIP =====================
    console.log('\n── ROUND-TRIP: outbound reply then inbound updated_review reflects it ──');
    // reply already on the mock for outCode; now fire updated_review → inbound pull sees attributes.reply
    db.reviews.get(outCode).replyComment = null; // pretend local reply was lost
    await new Promise(r => setTimeout(r, 1100));
    await createReview({ id: outCode, reply: 'Cảm ơn quý khách!' }); // re-emits updated_review
    check('inbound updated_review re-syncs reply (self-heal, C7)',
      db.reviews.get(outCode).replyComment === 'Cảm ơn quý khách!');
  } finally {
    srv.close();
    mock.kill();
  }

  console.log(`\n──────────── ${fail === 0 ? 'ALL PASS' : 'FAILURES'} : ${pass} passed, ${fail} failed ────────────`);
  process.exit(fail === 0 ? 0 : 1);
}

async function waitFor(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('mock did not start');
}

main().catch(e => { console.error(e); process.exit(1); });
