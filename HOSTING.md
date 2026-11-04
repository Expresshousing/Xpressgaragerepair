# Putting Xpress live: the hosting guide

This takes you from "works on my Mac" to a real website at your own domain, with HTTPS (the padlock), automatic restarts, daily backups, and every feature working (quotes, accounts, chat, bookings, photos, payments, reviews).

**Time:** about 1 to 2 hours the first time. **You will need:** a credit card for the server and domain, and willingness to copy-paste commands. If you'd rather not, a freelance developer or IT person can do this from this guide in an hour or two. Give them this file.

> **Honest note:** I built and tested every piece on a Mac (health check, backups and restore, proxy handling, the site build for your domain). I could not test on a real internet server or with your real Stripe / Resend / Twilio accounts, so use the **test checklist in step 11** before telling customers.

---

## 0. The big picture

```
Customer's browser --HTTPS--> Caddy (free HTTPS) --> the Xpress app (Node) --> data/ (database + photos)
                                                         |--> Stripe (cards)  |--> Resend (email)  |--> Twilio (texts)
```

- One small server runs everything. Your customer data lives in **one folder (`data/`)**, which is what gets backed up.
- **Why not Vercel / Netlify / GitHub Pages?** Those host static pages or short-lived functions. This app needs an always-running program and a disk that keeps files (database and customer photos). A small **VPS** (a rented mini-computer) is the simplest fit.
- Hosts with persistent disks (Fly.io, Render, Railway) can work too, but need extra setup; the steps below assume a plain Ubuntu VPS.

**Typical costs** (check current prices): a small VPS is usually in the single-digit to low-teens dollars per month; a domain about $10 to $20 per year; Resend, Stripe and Twilio have usage-based pricing (Stripe takes a percentage of each card payment; Twilio charges per text).

---

## 1. Pick the server

Any of DigitalOcean, Hetzner, Vultr or Linode works. Choose:

- **Ubuntu 24.04 LTS**, **1 to 2 GB RAM**, 25 GB+ disk
- A region near your customers (US East for Pennsylvania/New Jersey)
- **SSH key login** (the provider walks you through adding one), not a password
- Turn on the provider's **automatic backups/snapshots** if offered (a cheap second safety net)

Write down the server's **IP address**.

## 2. Domain and DNS

1. Buy your domain (or use the one you own), e.g. `xpressgaragedoors.com`.
2. In the domain's DNS settings, add two records pointing to your server IP:

| Type | Name | Value |
|---|---|---|
| A | `@` (the bare domain) | your server IP |
| A | `www` | your server IP |

DNS can take minutes to a few hours. **HTTPS setup (step 7) only works once these records are live.**

## 3. Prepare the server

Connect from Terminal on your Mac: `ssh root@YOUR.SERVER.IP`. Then run these in order.

```bash
# update everything, and keep it updating security fixes by itself
apt update && apt -y upgrade
apt -y install unattended-upgrades ufw curl ca-certificates gnupg
dpkg-reconfigure -plow unattended-upgrades    # choose "Yes"

# firewall: only SSH and web traffic
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable

# a normal user that will run the site (no admin rights)
adduser --disabled-password --gecos "" xpress
mkdir -p /opt/xpress && chown xpress:xpress /opt/xpress
```

Install **Node.js 24** (the app needs Node 22.13 or newer). On Ubuntu:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt -y install nodejs
node -v          # should print v24.x
```

(If that command has changed, follow the Linux instructions on nodesource.com or nodejs.org.)

## 4. Upload the website

On **your Mac**, from the folder that contains `xpress-portal`:

```bash
rsync -av --exclude data --exclude backups --exclude .env --exclude node_modules \
  xpress-portal/ root@YOUR.SERVER.IP:/opt/xpress/xpress-portal/
```

Back on the server, give the `xpress` user ownership:

```bash
chown -R xpress:xpress /opt/xpress
```

## 5. Settings (`.env`)

On the server:

```bash
cd /opt/xpress/xpress-portal
cp .env.example .env
openssl rand -base64 24          # prints a strong random value: copy it for ADMIN_PASSWORD
nano .env                        # fill in, Ctrl+O Enter to save, Ctrl+X to exit
chown xpress:xpress .env && chmod 600 .env
```

Set at least these (the rest can wait; **never** set `AUTO_VERIFY` on a live site, it is for local testing only; each feature switches on when its lines are filled in):

```ini
PORT=4190
HOST=127.0.0.1                    # only Caddy may talk to the app directly
TRUST_PROXY=1                     # lets the app see each visitor's real address
SITE_URL=https://your-domain.com  # no trailing slash. Used in emails and the pages' addresses
ADMIN_PASSWORD=<the random value you generated>   # the one-time "setup key" for your owner account
```

## 6. Build the pages and start the app

```bash
cd /opt/xpress/xpress-portal
sudo -u xpress bash -c 'set -a; . ./.env; set +a; node build.mjs | tail -1; node verify.mjs | head -2'
cp deploy/xpress.service /etc/systemd/system/xpress.service
systemctl daemon-reload && systemctl enable --now xpress
systemctl status xpress --no-pager        # should say "active (running)"
curl http://127.0.0.1:4190/healthz        # should print: ok
```

Building with `SITE_URL` set makes the pages' canonical links, sitemap and robots.txt use **your** domain (the build otherwise uses a temporary preview address).

If something looks wrong: `journalctl -u xpress -n 50 --no-pager` shows what the app printed.

## 7. HTTPS with Caddy

Caddy gets and renews the HTTPS certificate on its own.

```bash
# install (official steps; if they've changed see caddyserver.com/docs/install)
apt -y install debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt -y install caddy

# use our config, with YOUR domain swapped in
cd /opt/xpress/xpress-portal
sed 's/your-domain.com/xpressgaragedoors.com/g' deploy/Caddyfile > /etc/caddy/Caddyfile     # <- put your real domain
systemctl reload caddy
```

Open `https://your-domain.com` in a browser. You should see the site with a padlock. (If not: DNS may not have spread yet, wait and `systemctl reload caddy` again; `journalctl -u caddy -n 30 --no-pager` explains why.)

## 8. Create your owner account

Go to `https://your-domain.com/admin/`. The first time it asks for the **setup key**: that's the `ADMIN_PASSWORD` from `.env`. Enter your name, email and a strong password. That's your owner login. Then use **Team** to add each staff member (they get a temporary password and choose their own).

After setup, `ADMIN_PASSWORD` no longer signs anyone in. Keep it somewhere safe; it's only for first-time setup.

## 9. Connect the outside services

Put each service's keys in `.env`, then `systemctl restart xpress`. Check the first lines of `journalctl -u xpress -n 20` to see which channels say **ON**.

**Email: Resend** (resend.com). Add and verify your domain; they show DNS records (SPF/DKIM) to add at your domain host. Strongly recommended: also add a DMARC record so your emails land in inboxes, not spam. Set `RESEND_API_KEY`, `ALERT_EMAIL_FROM` (an address on your verified domain), `ALERT_EMAIL_TO` (who gets staff alerts), `ALERT_REPLY_TO`. Quote confirmations, appointment emails, receipts, reminders, password resets and review requests all depend on this.

**Cards: Stripe** (stripe.com). Create an account and **start with Test mode**.
1. Developers > API keys: put the secret key in `STRIPE_SECRET_KEY` (`sk_test_...` for testing).
2. Developers > Webhooks > add endpoint `https://your-domain.com/api/stripe/webhook`, events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded`. Copy its signing secret into `STRIPE_WEBHOOK_SECRET`.
3. Test with card `4242 4242 4242 4242` (any future date, any CVC). When happy, switch to the live key and a live webhook.
4. In Stripe's settings turn on customer email receipts.

**Texts: Twilio** (optional; staff alerts only). US texting requires registering your business (10DLC or toll-free verification), which can take days. Email and the webhook alerts work without it.

**Google reviews:** in your Google Business Profile, get your "ask for reviews" link and set `REVIEW_GOOGLE_URL`.

## 10. Backups (do not skip this)

Your customers' accounts, quotes, chats, payments and photos live in `data/`. If the server is lost and you have no backup, **they are gone.**

**Daily automatic backup** (as the `xpress` user):

```bash
sudo -u xpress crontab -e
```
Add this line (runs at 3:15 am, keeps the newest 14 in `backups/`):
```
15 3 * * * cd /opt/xpress/xpress-portal && /usr/bin/node backup.mjs >> backups/backup.log 2>&1
```

**Copy backups off the server** (a backup on the same machine does not survive losing the machine). Two simple options:
- `rclone` to Backblaze B2, Google Drive, S3 or similar (`rclone copy /opt/xpress/xpress-portal/backups remote:xpress-backups`), run from cron after the backup line; or
- `rsync` to another computer you control. Keep the destination private: these files contain customer data.

**Restore** (practice once, now, on a spare server or your Mac):
```bash
systemctl stop xpress
cd /opt/xpress/xpress-portal && sudo -u xpress node backup.mjs restore backups/xpress-YYYY-MM-DD-HHMMSS.tar.gz
systemctl start xpress
```
Restore moves the current `data/` aside (it never deletes it) before putting the backup in place.

## 11. Test everything before announcing it

Do this on the real domain, in Stripe **test mode**:

- [ ] `https://your-domain.com` loads with a padlock; `http://` redirects to `https://`; `www` redirects to the bare domain
- [ ] Submit a real-looking **quote** (with a photo and a booking window) → confirmation appears, owner gets the alert email/text
- [ ] The customer receives their confirmation email (check spam). If not: Resend domain verification/DNS
- [ ] **Create an account** with that email; the quote is there and a "confirm your email" message arrives. Confirm it (the banner disappears). Try **Forgot password**
- [ ] **Chat**: send a message from the website, reply from `/admin/`, see it in the widget
- [ ] In `/admin/`: change the quote status, set a price → the customer sees it and gets an email
- [ ] **Payment**: request a $1 deposit, pay it with the Stripe test card, see "Paid" and the receipt; try a refund
- [ ] Mark a job **completed** → after the delay, a review email arrives; rate it; unsubscribe link works
- [ ] Add a staff account; sign in as them; confirm they can't see **Team** or refund
- [ ] Open the site on a **phone** (quote form, chat, account)
- [ ] Take a backup, then do the restore practice from step 10
- [ ] Confirm the contact email on the site is correct (it currently reads `info@xpressgaragedoorservics.com`; check the spelling is really yours)

Then switch Stripe to live keys, restart, and make one real $1 payment yourself (and refund it).

## 12. Keeping it running

- **Is it up?** Add `https://your-domain.com/healthz` to a free uptime monitor (UptimeRobot, Better Stack). It texts/emails you if the site goes down.
- **See what's happening:** `journalctl -u xpress -f` (live log; Ctrl+C to stop).
- **Update the site** (after changing files on your Mac): run the `rsync` from step 4 again, then on the server `cd /opt/xpress/xpress-portal && bash deploy/update.sh`. It backs up, rebuilds, restarts and confirms the site is healthy.
- **Server updates:** security fixes install automatically (step 3). Reboot occasionally: `reboot` (the site restarts itself).
- **Changing a setting:** edit `.env`, then `systemctl restart xpress`.

## 13. What to know about security

Already built in: hashed passwords, per-person staff accounts with roles and an activity log, throttled sign-ins, same-site cookies (marked Secure over HTTPS), file-type checks on uploads, signed payment webhooks, no card numbers on your server.

Your part: keep `.env` private (never email it or put it in a shared folder), use SSH keys, keep backups private, remove staff accounts when people leave (Team > Deactivate), and use strong passwords.

**Privacy notice:** the site's `/privacy/` page now describes what the system stores (accounts, quotes, photos, chat, payments, emails). It is a plain-language starting point, **not legal advice**. Have it reviewed, and add your own retention/deletion policy, before launch. Also check any sales-tax, licensing or text-message consent rules that apply in PA, NJ and LA.

## Quick reference

| I want to... | Command (on the server) |
|---|---|
| See if the site is running | `systemctl status xpress` |
| Restart it | `systemctl restart xpress` |
| Read the log | `journalctl -u xpress -n 100 --no-pager` |
| Is it healthy? | `curl http://127.0.0.1:4190/healthz` |
| Back up now | `cd /opt/xpress/xpress-portal && sudo -u xpress node backup.mjs` |
| Lost owner access | `cd /opt/xpress/xpress-portal && sudo -u xpress env STAFF_PASSWORD='a-long-password' node manage-staff.mjs reset-password you@email.com` |
