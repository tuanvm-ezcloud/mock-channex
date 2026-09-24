# Mock Channex

A minimal stand-in for the [Channex.io](https://docs.channex.io) API + admin UI, scoped to the
only two things **ezMessage** integrates with: guest **messages** and **reviews**. Everything
unrelated (ARI, rates, bookings sync, channel management, etc.) is removed.

It behaves like Channex, so it exercises the real ezMessage code paths — no real Channex needed.

## Why it's a server and not a plain `.html` file

Channex's message flow is **pull-based**:

1. A guest sends a message → Channex fires a lightweight **webhook** to ezMessage
   (`POST /channex/push_message`) — the webhook only carries a trigger, not the real content.
2. ezMessage then **calls back** to Channex (`GET /api/v1/bookings/{id}/messages`) to pull the
   actual messages.

Reviews are pulled the same way (`GET /api/v1/reviews`), and staff replies are POSTed back
(`POST /api/v1/bookings/{id}/messages`, `POST /api/v1/reviews/{id}/reply`).

A browser-only page can fire the webhook but can't answer those callbacks. So the mock has to
**be** the Channex API that `channex.url` points at. It's still "a page" — you just open it in a
browser — but it's backed by a tiny zero-dependency Node server.

## Run

```bash
node server.js
# or a custom port:
# PORT=5000 node server.js
```

Then open <http://localhost:4000>.

## Point ezMessage at the mock

In `ezone.messageai.customer.api/src/main/resources/application.properties`:

```properties
channex.url=http://localhost:4000/api/v1/
channex.api-key=anything
```

Restart `customer.api`. (The mock accepts **any** `user-api-key` and shows the received value in
its activity log, so you can confirm ezMessage is actually sending it.)

## Testing messages

1. In the UI **Connection** panel, set **ezMessage URL** (default `http://localhost:8080`) and the
   **property_id**.
2. **Messages** tab → enter a **Booking ID** that already exists in ezMessage (or is resolvable by
   its CRS gRPC — otherwise ezMessage returns `BOOKING_NOT_FOUND`), type a message, **Send**.
3. The mock stores the guest message, fires the `message` webhook, and ezMessage calls back to pull
   it. Watch both in the **Activity log** (click a row for the payload).
4. Reply from ezMessage's staff UI → it POSTs back here → the reply shows on the right of the
   **Conversation thread** (sender `property`).

## Testing reviews

1. **Reviews** tab → fill booking id, property id, guest, score, category scores, content →
   **Create review**.
2. Trigger the pull from ezMessage (`GET /channex/review/get-list`). ezMessage calls
   `GET /api/v1/reviews` here and ingests it.
3. Reply from ezMessage → `POST /api/v1/reviews/{id}/reply` lands here; the review flips to
   **REPLIED** and shows the staff reply.

## Endpoints implemented (Channex-compatible)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET`  | `/api/v1/bookings/{id}/messages` | ezMessage pulls the thread |
| `POST` | `/api/v1/bookings/{id}/messages` | staff reply from ezMessage (`{message:{message}}` or `{message:{attachment_id}}`) |
| `POST` | `/api/v1/attachments` | returns `{data:{id}}` |
| `GET`  | `/api/v1/reviews` | ezMessage pulls reviews |
| `POST` | `/api/v1/reviews/{id}/reply` | staff review reply (`{reply:{reply}}`) |
| `GET`  | `/api/v1/message_threads` | extranet.api's Channex check on OTA connect / reconnect |

**OTA connect check.** When staff connect (or reconnect) Booking.com / Expedia / Airbnb, extranet.api
(`ChannexConnectionService.checkChannexMessaging`) calls `GET {channex.url}message_threads` with
`user-api-key`, so point **extranet.api**'s `channex.url` at the mock too. It only looks at the outcome:
2xx → OK, 4xx → `CHANNEX_CHECK_FAILED`, I/O error → `NETWORK_DISCONNECTED`. The expanded **Connection**
panel has a dropdown to pick what the mock answers (200 / 401 / 403 / drop the connection), also settable
via `POST /mock/check-mode {"mode":"ok"|"401"|"403"|"network"}`. The CRS-mapping step of connect is
separate (gRPC) and isn't affected by the mock.

Plus the webhook it **sends**: `POST {ezMessageUrl}/channex/push_message` with
`{event:"message", payload:{booking_id, message, sender:"guest", ...}, property_id, user_id, timestamp}`.

Mock-control endpoints used by the UI (same origin): `GET /mock/state`, `POST /mock/send-message`,
`POST /mock/reviews`, `POST /mock/reply-extranet`, `POST /mock/check-mode`, `POST /mock/reset`.

Review endpoints also honour `GET /api/v1/reviews?filter[property_id]=…&pagination[page]=…&pagination[limit]=…`
(hotel-aware pull; a property id starting with `noapp` returns 403 to simulate the missing "Messages &
Reviews" app), and `GET /api/v1/scores/{id}` / `…/detailed`. `POST /mock/reviews` with an existing `id`
**updates** that review and fires `updated_review` (default event); otherwise it creates one and fires `review`.

## Bidirectional review-flow verification

`node verify-review-flow.js` runs an automated PASS/FAIL check of the whole review flow in
**both directions** — it spawns the mock and an ezMessage stand-in that mirrors the exact ingest/reply
decisions of `ReviewIngestService` / `ReviewWebhookService` / extranet `ReviewService`, then asserts:
inbound `review`+`updated_review` (pull, upsert, C5/C6 fields, B1 property, C7 change-detect & OTA-reply
sync), B3 connection gate, C9 `filter[property_id]` scoping, C8 403 skip, outbound reply push-then-persist
(C3, incl. the no-local-write-on-failure case), and the outbound→inbound round-trip. (The real Spring
services can't boot here — they need MariaDB/Redis/gRPC — so this verifies the HTTP contract + logic, and
the Java compiles clean against these same decisions.)

## Deploy online (so dev/UAT ezMessage can reach it)

When the ezMessage under test lives elsewhere, the mock needs a public HTTPS URL. It's a
**stateful, long-running** server that both receives *and initiates* HTTP calls, so host it as
a container/VM — **not** on a serverless platform (Vercel/Netlify won't work).

Both directions must have a route:
- the ezMessage under test must be reachable from the mock (it fires the
  `push_message` / `push_review` webhooks to ezMessage), **and**
- the mock must be reachable from ezMessage (the pull-back GETs + staff-reply POSTs).

A public cloud host therefore only works when the ezMessage under test is itself
internet-reachable. If ezMessage is internal-only (e.g. `10.x`), run the mock **inside** that
network instead (a small VM, or Cloudflare-tunnel it from a machine on the VPN).

### Render (free, Docker) — recommended
A Blueprint (`render.yaml`) and `Dockerfile` are included. In Render: **New → Blueprint** and
pick this repo, or create a **Web Service** manually with **Runtime** Docker, **Plan** Free
(the repo root is the app — leave Root Directory blank). Render injects `$PORT` (the server honours it) and gives you
`https://<name>.onrender.com`. Then wire both ends:
- in the deployed mock's UI, set the **ezMessage URL** field to your UAT customer.api base
  incl. its context path, e.g. `https://<uat-host>/api/v1/ezmessage`
- set UAT's `channex.url=https://<name>.onrender.com/api/v1/` and restart customer.api.

Free-tier caveat: the service **spins down after ~15 min idle** — the next request cold-starts
(~1 min) and **in-memory threads/reviews reset**. Fine for on-demand testing.

### Koyeb (free, Docker) — alternative
Create a Web Service from this repo, Dockerfile build, work dir `mock-channex`, free instance.
Same URL wiring. One small always-on instance (no spin-down).

### Any VM, with Docker
```bash
docker build -t mock-channex .
docker run -p 4000:4000 mock-channex
```

### ⚠️ Security when public
Left open, anyone with the URL can drive the UI *and* read what UAT posts to the mock (staff
replies can carry guest names / PII). Lock a public deploy down with these env vars (all
**off by default**, so local dev is unaffected):

| Env var | Gate | Notes |
| --- | --- | --- |
| `MOCK_API_KEY` | `/api/v1/*` — ezMessage's callbacks | Incoming `user-api-key` must equal it, else `401` (same as real Channex). **Set it to the same value as ezMessage's `channex.api-key`.** |
| `MOCK_UI_PASSWORD` | The UI (`/`) + `/mock/*` control endpoints | HTTP Basic auth. The browser prompts once on page load, then reuses it. |
| `MOCK_UI_USER` | — | Basic-auth username (default `admin`). |

`GET /healthz` stays public so platform health checks pass. Example:
```bash
MOCK_API_KEY=s3cr3t-key MOCK_UI_PASSWORD=hunter2 node server.js
# ezMessage: channex.api-key=s3cr3t-key ; UI login: admin / hunter2
```
Still: tear the instance down when finished, and don't point it at data that matters.

## Notes / limitations

- State is **in-memory** — it resets when you restart the process (use **Reset mock** in the UI to
  clear without restarting).
- Guest messages use sender `"guest"`; staff replies are stored as `"property"` — matching Channex.
  ezMessage only ingests `"guest"` messages on pull (it already has its own copy of staff replies).
- Timestamps use Channex's format `YYYY-MM-DDTHH:mm:ss.SSSSSS` (no `Z`), which ezMessage's review
  parser (`LocalDateTime.parse`) requires.
- Inbound attachments are acknowledged but ezMessage v1 does not ingest them (documented in the OTA
  plan); staff outbound attachments via `attachment_id` are shown as a placeholder bubble.
- **Review reply is lenient:** `POST /api/v1/reviews/{id}/reply` accepts a reply even for a review
  the mock doesn't hold (state is in-memory and resets on restart / Render spin-down, and never
  includes reviews seeded straight into ezMessage's DB). It returns `200` and auto-creates a stub
  review so the staff-reply flow isn't blocked by lost state. Real Channex would `404` here.
