#!/usr/bin/env node
/**
 * Seed a sample review (and, implicitly, its /scores data) into the mock Channex,
 * anchored to a REAL booking id, then let ezMessage pull + ingest it.
 *
 * Reviews are PULL-based: the mock's POST /mock/reviews stores the review AND fires the
 * `review` webhook to ezMessage; ezMessage then calls back GET /api/v1/reviews on the mock
 * and ingests. /scores needs no separate seeding — the mock computes GET /scores/:propertyId
 * from the reviews you seed for that same property_id.
 *
 * PREREQUISITES (why "real booking id"): ezMessage only ingests a review whose booking it can
 * resolve. It looks the booking up by external_booking_id in its own DB (and, failing that,
 * hydrates from CRS over gRPC — not available against the mock). So the booking must already
 * exist in the target environment's DB, and its OTA must be (a) connected+active in
 * cms_ota_property and (b) review-capable in cms-ota (bit review=4). Use a booking that
 * already satisfies that in the env you are testing.
 *
 * Usage (flags or env vars):
 *   node seed-review.js \
 *     --booking <external_booking_id> \      (required) real booking id, = review.booking_id
 *     --property <channex_property_id> \     (required) Channex property UUID; groups /scores
 *     --ez http://localhost:8080/api/v1/ezmessage \   ezMessage customer.api base (webhook target)
 *     --mock http://localhost:4000 \         mock base
 *     --score 8.6 \                          overall_score
 *     --ota BookingCom \                     Channex OTA display name (attributes.ota)
 *     --guest "Nguyen Van A" \               guest_name
 *     --content "Phòng sạch, nhân viên thân thiện" \
 *     --scores clean=9,location=8,staff=9 \  per-category ratings
 *     --update <review_id>                   update an existing review (fires updated_review, tests C7)
 *
 * All flags have env-var equivalents: BOOKING, PROPERTY, EZ_URL, MOCK_URL, SCORE, OTA, GUEST,
 * CONTENT, SCORES, UPDATE_ID.
 */

function arg(name, envName, def) {
  const i = process.argv.indexOf('--' + name);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  if (envName && process.env[envName]) return process.env[envName];
  return def;
}

const bookingId  = arg('booking', 'BOOKING');
const propertyId = arg('property', 'PROPERTY');
const ezUrl      = arg('ez', 'EZ_URL', 'http://localhost:8080/api/v1/ezmessage');
const mockUrl    = arg('mock', 'MOCK_URL', 'http://localhost:4000').replace(/\/+$/, '');
const score      = arg('score', 'SCORE', '8.6');
const ota        = arg('ota', 'OTA', 'BookingCom');
const guest      = arg('guest', 'GUEST', 'Sample Guest');
const content    = arg('content', 'CONTENT', 'Sample review content');
const updateId   = arg('update', 'UPDATE_ID');
const scoresRaw  = arg('scores', 'SCORES', 'clean=9,location=8,staff=9');

const scores = scoresRaw.split(',').filter(Boolean).map(pair => {
  const [category, s] = pair.split('=');
  return { category: category.trim(), score: Number(s) };
});

if (!updateId && (!bookingId || !propertyId)) {
  console.error('ERROR: --booking and --property are required (or set BOOKING / PROPERTY).');
  console.error('Run with --update <review_id> to mutate an existing review instead.');
  process.exit(1);
}

const body = updateId
  ? { id: updateId, overall_score: Number(score), content, scores, event: 'updated_review', ez_message_url: ezUrl }
  : { booking_id: bookingId, property_id: propertyId, overall_score: Number(score),
      ota, guest_name: guest, content, scores, ez_message_url: ezUrl };

(async () => {
  const url = mockUrl + '/mock/reviews';
  console.log(`POST ${url}`);
  console.log(JSON.stringify(body, null, 2));
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    console.log(`\n→ mock ${r.status}`);
    console.log(text);
    // The mock also fired the review webhook to ezMessage; its response is in `webhook` above.
    if (r.ok) {
      let reviewId = null;
      try { reviewId = JSON.parse(text).review.id; } catch { /* ignore */ }
      console.log('\nVerify in extranet:');
      console.log(`  POST ${ezUrl}/channex/review/get-all   body: {"propertyId":"<ezCloud hotelId>"}`);
      if (reviewId) console.log(`  GET  ${ezUrl}/channex/review/detail?id=${reviewId}  (note: this is the Channex review id; ezMessage stores its own row id)`);
      console.log(`  GET  ${ezUrl}/channex/review/scores?hotelId=<ezCloud hotelId>`);
    }
  } catch (e) {
    console.error('Request failed:', e && e.message || e);
    process.exit(1);
  }
})();
