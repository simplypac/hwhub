# Homework Hub

All your IB homework from ManageBac, Kognity, K12net, Padlet, Google Classroom, WhatsApp and school email in one list. Students make an account, connect their platforms once, and new assignments show up by themselves.

No dependencies: plain Node.js (22.13 or newer) with its built-in SQLite. `npm start` and it runs.

## How each platform gets in

The app never asks for school passwords. Storing them would make the app a target, breaks the platforms' rules, and breaks the moment the school turns on two-step login. Instead it uses the ways each platform already shares data:

| Platform | How it connects | Automatic? |
|---|---|---|
| ManageBac | Private calendar link (Calendar → Subscribe). Checked every 30 min. Moved deadlines update, deleted tasks disappear. | Yes |
| Kognity, K12net, Padlet, Classroom, Teams | Their notification emails, through **email forwarding** or **Connect Gmail** | Yes |
| Any page (Kognity assignment list, K12net homework page…) | **Browser extension**: one click sends the visible page, using the session the student is already signed in to | One click |
| WhatsApp, teacher messages | **Paste** into the app | One paste |

The same assignment often arrives several ways (ManageBac calendar + Kognity email + the extension). The app matches them by title, subject, due time and link, and keeps one entry. The calendar is trusted most for dates, emails fill in gaps, and anything the student edits by hand is never overwritten. A task the student deletes stays deleted.

## Run it on your computer

```bash
npm start          # http://localhost:3000
npm test           # 30 tests: accounts, security, syncing, Turkish emails, merging
```

Without any keys you get accounts, ManageBac, pasting and the extension, with the rule-based readers (English and Turkish). Add the optional keys below to turn on the rest.

## Put it online

It needs a host that keeps a disk between restarts (the database is one file). Railway is the easiest:

1. Put this folder in a GitHub repo.
2. On railway.app: New Project → Deploy from GitHub repo.
3. Add a **Volume** to the service, mounted at `/data`.
4. Variables: `NODE_ENV=production`, `DB_FILE=/data/hub.db`, `SECRET_KEY=<long random string>`, `APP_URL=https://<your railway domain>` (plus the optional ones below).
5. Settings → Networking → Generate Domain. Open it, make an account.

Render (with a paid disk) and Fly.io (with a volume) work the same way. The `Dockerfile` works anywhere that runs containers.

Make a secret with: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`. Never change `SECRET_KEY` after launch, or saved calendar links and Gmail connections stop working.

## Turn on AI reading (recommended)

Set `ANTHROPIC_API_KEY` (from console.anthropic.com). Emails, pasted messages and pages are then read by Claude (Haiku by default, change with `AI_MODEL`), which handles messy wording, several tasks in one message, and Turkish. Without it the rule-based readers still work but are weaker, especially for the browser extension. Each student is limited to 60 AI reads an hour.

## Turn on email forwarding (for Kognity, K12net, Padlet)

Every student gets a private address like `x7k2m9qd4tzp@yourdomain.com`. They set a Gmail filter once, and every notification from those platforms flows in. The app even catches Gmail's forwarding confirmation code and shows it on screen, so setup takes about two minutes.

You need a domain (about $10 a year) and a service that turns incoming email into a web request. The free option is Cloudflare:

1. Add the domain to Cloudflare. Open **Email → Email Routing** and enable it (Cloudflare adds the DNS records).
2. **Workers**: create a Worker, paste in `deploy/cloudflare-email-worker.js`, and add two variables: `HUB_URL` (your app's address) and `INBOUND_SECRET`.
3. Back in Email Routing → Routing rules → **Catch-all** → action "Send to a Worker" → your Worker.
4. On the app server set `INBOUND_DOMAIN=yourdomain.com` and the same `INBOUND_SECRET`.

Other services work too. Point their inbound webhook at `https://<app>/api/inbound/email?secret=<INBOUND_SECRET>`:
- **Postmark** inbound (JSON) is supported as is, and it passes the real recipient.
- Anything that can POST the raw email (`Content-Type: message/rfc822`) with an `X-Envelope-To` header.

Note: some school Google Workspace accounts don't allow automatic forwarding to outside addresses. Students can still forward single emails by hand, or use Connect Gmail or the extension.

## Turn on "Connect Gmail"

1. console.cloud.google.com → new project → **APIs & Services → Library** → enable **Gmail API**.
2. **OAuth consent screen**: External, fill in the app name and your email. Add the scope `.../auth/gmail.readonly`. Keep it in **Testing** and add each student's Gmail as a **test user** (up to 100).
3. **Credentials → Create OAuth client ID → Web application**. Authorized redirect URI: `https://<your app>/api/connect/google/callback`.
4. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` on the server.

Gmail read access is a "restricted" permission. Going beyond 100 users means Google's verification and a paid security review, which is why email forwarding is the main path. Also, school-managed Google accounts may block outside apps completely.

The app only searches for emails from the school platforms or with homework words in the subject (`ödev`, `teslim`, `assignment`, `due`...), reads at most 40 new ones per check, and can't send or delete anything.

## Browser extension

In `extension/` (also downloadable from the app: Settings → Browser extension).

1. Unzip, go to `chrome://extensions`, turn on Developer mode, Load unpacked.
2. In the app, create an extension key and paste it with the app address into the extension.
3. Open a page that lists assignments (e.g. Kognity's assignment page), click the extension.

It only reads the page when clicked (`activeTab` permission), and its key can only add assignments, nothing else. Publishing to the Chrome Web Store later costs a one-time $5.

## Security and privacy

- Passwords: scrypt hashing with a salt per user. Login is rate limited (10 tries per 15 minutes per address and per email).
- Sessions: random tokens in HttpOnly, SameSite cookies (Secure on https). Only a hash of the token is stored. Changing the password signs out other devices.
- Every write needs a custom header and a matching Origin, which blocks cross-site request forgery. Strict Content-Security-Policy, no third-party scripts.
- ManageBac links and Google tokens are encrypted (AES-256-GCM) with `SECRET_KEY`.
- The ManageBac fetcher only talks to managebac.com hosts, with size and time limits.
- Students can delete their account in Settings, which deletes all their data and revokes Gmail access.
- Every student only ever sees their own data (tested).

If other students use it, you're handling their school email, and in Turkey KVKK (the personal data law) applies. Keep a short privacy note that says what's collected (the list above) and that deleting the account deletes everything. Many users will be under 18, so for a school-wide launch, getting the school's OK first is the safe move.

## Known limits

- Notification email formats for Kognity, K12net and Padlet differ between schools. The readers were built from typical formats. Forward a few real ones and check Settings → Recent activity: it shows what was added or ignored for every email, which makes tuning easy.
- Outlook/Microsoft 365 accounts connect through forwarding (a rule), not a sign-in button.
- No push notifications yet. The app refreshes every minute while it's open.

## Project layout

```
server/            Node server (no dependencies)
  app.js           API: accounts, assignments, connections, inbound email, extension
  sync/            ManageBac calendar, email parser, Gmail, matching/merging, scheduler
  dates.js         Finds due dates in English and Turkish text
  ai.js            Optional Claude reading
public/            The app (installable on a phone: Share → Add to Home Screen)
extension/         Chrome/Edge extension
deploy/            Cloudflare Email Worker
test/              node --test
```
