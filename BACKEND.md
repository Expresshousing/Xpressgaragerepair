# Xpress backend (customer accounts, quotes, live chat, staff dashboard)

Run it (Node 22+, no npm install needed):

    cd xpress-portal
    node build.mjs                               # rebuild pages into dist/
    ADMIN_PASSWORD='pick-a-long-password' PORT=4190 node server.mjs

- Website: http://localhost:4190/
- Customers: /account/ (sign up, sign in, quotes, appointments, details, password)
- Staff: /admin/ (live chat, quotes, schedule, customers, team). First visit asks for the setup key (ADMIN_PASSWORD) to create the owner account; after that everyone signs in with their own email + password.
- Data: data/xpress.db (SQLite) and data/uploads/ (customer photos). Back up both. Never commit them.

## What exists
- Quote form (Contact page) saves to the database, shows a reference number and invites the customer to create an account. Earlier quotes/chats with the same email attach to the account automatically.
- Live chat widget on every page (customers or guests). Shows Online/Away from business hours (Mon–Sat 7–7 ET, `chatState()` in server.mjs) and a staff on/off switch. Always offers the 24-hour phone number.
- Staff update a quote's status / amount / appointment; the customer sees it in their account timeline.
- Customer profile (address, door notes), private staff notes per customer, job history.

## Next sections (not built yet; need outside accounts)
1. (done) Email + SMS alerts.
2. (done) Password reset and email verification.
3. (done) Card payments via Stripe Checkout, deposits and invoices.
4. (done) Booking calendar.
5. (done) Photo upload, review requests, maintenance reminders.
6. (done) Staff logins per person. Hosting guide and backups are done (see HOSTING.md).

## Alerts (built)
Copy `.env.example` to `.env`, fill it in, then run `node --env-file=.env server.mjs`. The startup line shows which channels are ON.
- Staff (email / text / Slack-Discord-Zapier webhook): new quote (urgent ones flagged), new chat, further chat messages (max one alert per chat per 5 min).
- Customers (email): request received with account link, quote ready / appointment scheduled / completed / cancelled, and "Xpress replied" when a chat reply may have been missed (max one per chat per 15 min).
- A failed alert is logged and never blocks the customer. Set `CUSTOMER_EMAILS=off` to alert staff only.
- Resend needs a verified sending domain; Twilio texts to US numbers need an approved (10DLC / toll-free) sender.

## Password reset (built)
"Forgot your password?" on the sign-in form → emailed link (valid 1 hour, single use) → choose a new password → signed in. Resetting signs the account out of every other device. The "forgot" reply is identical whether or not the email has an account. Without email set up, the link is printed in the server log instead (handy for testing). Reset emails send whenever Resend is configured, even with `CUSTOMER_EMAILS=off`.

## Booking calendar (built)
- Customers pick a day + 2-hour arrival window (8–10, 10–12, 12–2, 2–4) on the quote form (optional) and can reschedule from their account. Times show in the business's local zone (Eastern for PA/NJ, Central for LA).
- Capacity is per state and per window ("crews"): defaults PA 2, NJ 1, LA 1. A full window shows as full; two people can't take the last spot (checked on the server at the moment of booking).
- Staff → **Schedule** tab: next 3 weeks of bookings, crews per window, days we take bookings (default Mon–Sat), minimum notice (default 3 h, so same-day only while there's time), and days off/holidays. Staff can also set or move a slot on any quote (can override capacity); confirming a quote ("scheduled") fills in the customer-facing appointment text automatically.
- A customer's rescheduling moves a scheduled job back to "reviewing" and alerts staff to confirm the new time.
- Customers get an "Add to calendar" (.ics) file; a reminder email goes out the day before a scheduled appointment (needs Resend). Emergencies still go by phone: online booking is for planned work.
- Not built: technician assignment/routing, per-window hours for Saturdays, deposits at booking (see Payments).

## Photo uploads (built)
- Quote form: optional "Photos of the problem" (up to 8). Phone photos are shrunk in the browser to 1600px JPEG before sending. Signed-in customers can add or remove photos on any open request from their account.
- Safety: the real file type is checked from the file's first bytes (JPG, PNG, WebP, HEIC only); anything else is refused even if renamed .jpg. 8 MB max each, 8 per request. Files get random names, are stored outside the public website folder (`data/uploads/`) and are served only to the customer who owns the request or to signed-in staff, with headers that stop them running as pages.
- Guests (no account yet) can attach photos for 24 hours after sending the quote, using a one-time token the quote form handles automatically.
- Staff see thumbnails in the quote and a 📷 count in the list, plus one alert per batch of photos. HEIC (iPhone) photos upload fine but most browsers can't preview them; staff get a download link.
- Not built: photo captions, video, automatic cleanup of photos for old/closed requests.

## Card payments (built)
- Staff open a quote → **Payments** → "Request payment" (deposit or payment, $1 to $50,000). The customer is emailed and sees **Pay $X securely** in their account. Staff can also record cash / check / card-in-person payments, or void an unpaid request. The quote list shows "$ due" / "$ paid".
- Payment happens on **Stripe's own checkout page**: card numbers never reach this server. The amount always comes from the invoice saved by staff, never from the browser.
- Paid status is confirmed two ways: Stripe's signed webhook (`/api/stripe/webhook`; forged, old or wrong-amount calls are rejected) and a direct check with Stripe when the customer returns to their account. Marking paid is idempotent, so replays never double count.
- Staff and customer both get an email when a payment lands (customer email doubles as a receipt; turn on Stripe's own receipts in the Stripe dashboard too).
- Without Stripe keys, invoices still work for offline payments and customers see "call us to pay".
- To go live: create a Stripe account, add the two keys in `.env`, add the webhook endpoint in Stripe, and test with a `sk_test_` key and Stripe's test card 4242 4242 4242 4242 first. Refunds: use the Refund button in the dashboard (sent through Stripe), or refund in Stripe and the `charge.refunded` webhook mirrors it here (add that event to your webhook endpoint).
- Not built: tax, saved cards, true PDF files (receipts are print-ready pages: Print > Save as PDF), partial-capture or disputes handling.

## Payment extras (built)
- **Due dates and payment plans:** staff can set a due date, or split a total into 2 to 6 installments every week / 2 weeks / month. Each installment is its own invoice the customer pays separately; the account shows "Payment plan" with what's paid and due.
- **Reminders (automatic, by email):** with a due date: 3 days before, on the due date, and 3 days overdue. Without one: 3 and 7 days after the request. Each stage sends once. Needs Resend. Reminders stop when an invoice is paid or voided.
- **Refunds:** full or partial. Card refunds go through Stripe from the staff Refund button; refunds made inside Stripe sync back via the `charge.refunded` webhook. The refunded total only goes up and is capped at the amount paid, so nothing double counts. Cash/check refunds are recorded as such. Customer is emailed.
- **Receipts and invoices:** customers get a printable Invoice (unpaid) or Receipt (paid, with refunds shown) from their account; staff open the same from the dashboard. Use the Print / Save as PDF button.

## Staff logins (built)
- **First run:** open `/admin/`, enter the setup key (your `ADMIN_PASSWORD`) and create the owner account. Setup can only run once; after that `ADMIN_PASSWORD` no longer signs anyone in.
- **Roles:** *Owner* can do everything plus refunds, availability/schedule settings and managing the team. *Staff* can run chats, quotes, the schedule view, customers, and request/record payments.
- **Team tab (owners):** add people (a temporary password is shown once; they must choose their own at first sign-in), change roles, deactivate (signs them out instantly) or reset passwords. You can't demote or deactivate yourself, so you can't lock everyone out.
- **Safety:** passwords 10+ characters, stored hashed; sessions last 12 hours in a same-site-only cookie; repeated failed sign-ins are throttled (per address and per email); cross-site write requests are refused.
- **Accountability:** every sign-in, quote change, payment action, refund, settings change and team change is logged with who did it (Team tab > Recent activity). Quotes can be assigned to a person ("Only mine" filter). Chat replies show the staff member's first name to the customer.
- **Locked out?** On the server run: `STAFF_PASSWORD='a-long-password' node manage-staff.mjs reset-password you@email.com` (or `create-owner`, `list`).
- Trade-off to know: the sign-in throttle is per email, so someone hammering an email can temporarily block that person for ~15 minutes. They can't get in; the owner can reset via the CLI if it matters.

## Review requests and maintenance reminders (built)
- **Automatic:** when staff mark a job *completed*, a review email goes out after `REVIEW_DELAY_HOURS` (default 4). The link opens a private star-rating page (no login) with an optional comment. If there's no answer after 5 days, one gentle reminder, then it stops.
- **Fair-reviews policy:** *every* customer is offered your Google review link after rating, whatever the rating (Google forbids showing the link only to happy customers). Low ratings (3 or less) additionally alert staff as "UNHAPPY CUSTOMER" so you can call and make it right. Set `REVIEW_GOOGLE_URL` to switch the Google button on.
- **Other ways to rate:** customers can rate completed jobs from their account (and change it); staff can email a request now or copy the link (to text it) from the quote.
- **Reviews tab (staff):** average rating, responses, response rate, low ratings, clicks to Google, and every comment.
- **Maintenance reminders:** about `MAINTENANCE_MONTHS` (default 12) after a completed job, one email invites a yearly check-up with a link that opens the quote form pre-filled. Skipped if the customer has already booked something in the last 6 months.
- **Unsubscribe:** review follow-ups and maintenance emails carry a one-click unsubscribe link and the standard List-Unsubscribe header; customers can also toggle it in their account. Quote, appointment, payment and chat emails are unaffected (they're about work the customer asked for). Unsubscribed customers still can submit a rating if they open a link themselves.
- Needs Resend for the emails. Without it, the review link is printed in the server log and staff can copy links from the dashboard.
- Not built: SMS review requests (needs Twilio consent/10DLC), pulling Google reviews back in.

## Going live (built)
- **HOSTING.md** is the step-by-step guide: server, domain, HTTPS (Caddy), always-on service, `.env`, connecting Stripe/Resend/Twilio, daily backups with restore, a pre-launch test checklist, and updating.
- Production support added to the app: `HOST` (bind address), `TRUST_PROXY=1` (real visitor addresses behind the proxy, so rate limits work per person), `/healthz` for uptime monitors, clean shutdown, `SITE_URL` used when building pages (canonical links, sitemap, robots.txt) and in emails.
- `backup.mjs` makes consistent backups of the database and photos while the site runs (keeps the newest 14) and restores them; `deploy/` holds the systemd service, Caddyfile and `update.sh`.
- The privacy notice and quote form wording were updated to match what the system now stores. Have the notice legally reviewed before launch.

## Reviews on the website (built)
- A **Customer Reviews** section appears on the home and About pages. It stays hidden until there is something real to show.
- **Consent first:** on the review page and in their account, customers can tick "You may show my comment on the Xpress website, with my first name, last initial and town". Nothing public happens without it.
- **You choose what appears:** Staff > Reviews > tick **On website** (only for reviews with a written comment and consent). Words are shown exactly as written; you can't edit them. Any rating may be shown, including low ones; you decide, but the average below is always honest.
- **Honest average:** the star average and count use *every* rating received, not just the displayed ones (shown once there are 3+ ratings), with a note saying so. This avoids the "only showing the good ones" problem regulators and review sites object to.
- **Stays accurate:** if a customer edits their comment/rating or withdraws consent, the review comes off the site until you approve it again. Unticking removes it within about a minute.
- **Safe:** only first name + last initial, town and service are exposed (never email, phone or address). Text is inserted as plain text, so nothing a customer writes can run as code.
- No review "structured data" is added: Google doesn't give rich results for a business's own reviews of itself, and marking it up wrongly can be penalised.

## Project review: fixes and tests (done)
Run everything with `npm test` (site checks + a full end-to-end run of the backend against a throwaway database with fake Stripe and email services: 29 checks).
- **Email verification (security fix):** before, anyone could sign up with another person's email and instantly see that person's earlier quotes, invoices and chats. Now an account sees only what it created (or "claimed" with the one-time proof its browser got when it sent the quote) until the email is confirmed by the emailed link. If the link is opened in a browser that isn't signed in to that account, the person must choose a password, which locks out whoever created the account. A password reset also proves the email.
- **No account leaks:** sending a quote no longer reveals whether an email has an account, and no longer attaches the quote to someone else's account.
- **Double charge prevented:** a second click on "Pay" reuses the open Stripe checkout instead of making another; if a second payment still happens, staff get an "ACTION: duplicate payment" alert.
- **Review links:** every link issued for a job keeps working (copying a link no longer kills the emailed one).
- **Hardening:** per-email limits on quotes and chats (stops email-bombing someone), changing a password signs out other devices, sign-in/limit tables can't grow without bound, database indexes, crash-safe error handling, and a warning if proxy mode is on while the server is reachable directly.
- **Booking picker** now always follows the state the quote is actually sent for.
- **Startup bug:** found by the new test: a brand-new database crashed on first start (an index referred to a table created later). Fixed.
- Settings for testing/hosting: `AUTO_VERIFY=1` (local testing only: skips email checks), `DATA_DIR` (where the database and photos live).
