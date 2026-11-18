# Deployment and hosting

## Current state

The demo is **not hosted**. Free hosting that fits this app is limited, and paid hosting needs a payment card issued outside Syria (Syrian cards don't work with foreign providers, and Stripe still lists Syria as restricted). Everything below is ready for when you choose a host.

## Mock mode — no hosting needed

The default build runs entirely in the browser on mock data (see [architecture](architecture.md#mock-mode)), so showing the demo needs no server at all:

- **One file.** `pnpm build:offline` produces `apps/web/dist-offline/natija-demo.html`. Send it or copy it to a USB stick; it opens with a double-click and works offline (tested in Chrome and Edge). Each person's browser keeps its own copy of the data.
- **Static hosting.** `pnpm build` produces static files in `apps/web/dist`, which any static host serves: GitHub Pages (free for a public repository) or Cloudflare Pages' free plan, for example. Both need an account you create yourself. Set the host's fallback to `index.html` so links like `/orders` load the app.

Everything below is for the real backend (API + PostgreSQL), needed once several people must share one lab's data.

## Option 0 — run it and share it from your PC (free)

1. `pnpm seed:demo` then `pnpm start` (serves everything on http://localhost:4310).
2. To show it to someone remotely, a free Cloudflare quick tunnel gives a temporary HTTPS address with no account: install `cloudflared`, then run `cloudflared tunnel --url http://localhost:4310`. The address changes each time and works only while your PC runs. Set `PUBLIC_URL` to that address so patient links and QR codes point to it.

## Option 1 — free cloud demo (Render, with limits)

Render's free web service sleeps after 15 minutes idle (first request then takes ~1 minute), has 512 MB RAM and a free PostgreSQL that is **deleted after 30 days**. Natija fits because reports are printed by the browser (no server-side Chromium).

- Create a free PostgreSQL and a web service from this repository (Docker, `infra/Dockerfile`).
- Environment: `DATABASE_URL` and `APP_DATABASE_URL` = Render's internal connection string (Render's user can't create roles; the app then runs as the table owner, and row-level security still applies because it is forced), `APP_SECRET`, `PUBLIC_URL=https://<service>.onrender.com`, `TRUST_PROXY=true`.
- After the first deploy: open a shell and run `pnpm seed:demo`.

Access from Syria (late 2026): Render sign-up and deploys work. DigitalOcean, Railway, Neon and Netlify block Syrian users.

## Option 2 — one small server (recommended for a pilot)

A Hetzner Cloud server in Germany (CX23, 2 vCPU / 4 GB, about €6–7 a month with backups; or CPX12 if CX plans can't be created) runs everything with Docker Compose:

```bash
git clone <repo> natija && cd natija
cp infra/.env.production.example infra/.env     # set DOMAIN and the three secrets
docker compose -f infra/docker-compose.yml --env-file infra/.env up -d --build
docker compose -f infra/docker-compose.yml --env-file infra/.env run --rm app pnpm seed:demo   # demo data
```

Caddy obtains the HTTPS certificate for `DOMAIN` automatically. Point the domain's A record at the server first. Suggested domain: `natijalab.com` (available at the time of writing, ~$10–11 a year for .com).

Health: `GET /health/live`, `GET /health/ready` (database). Add an external uptime check.

### Backups and restore

The `backup` service writes `pg_dump -Fc` files nightly to the `backups` volume and keeps 14 days. Copy them off the server (object storage) for an off-site copy. Restore:

```bash
docker compose -f infra/docker-compose.yml --env-file infra/.env exec -T db pg_restore -U postgres -d natija --clean --if-exists < natija-YYYYMMDD-HHMMSS.dump
```

Test a restore monthly.

### Updating

`git pull && docker compose … up -d --build`. Migrations run automatically when the app container starts.

## Where patient data may live

Syria's Law No. 12 of 2024 on electronic personal data took effect on 1 January 2025 and is reported to be under review. A Ministry of Communications circular of 15 April 2025 asks bodies without their own data centre to store collected personal data with the National Authority for IT Services. Whether this covers a private lab platform is unclear; get a Syrian legal opinion before storing real patients. The same Docker build runs in a Syrian data centre or on a lab's own server.

## Messaging

- **WhatsApp**: Meta's WhatsApp Business Platform doesn't serve Syrian businesses or deliver to users in Syria, so delivery is a one-click send from the desk's own WhatsApp (a `wa.me` link with the report link prefilled).
- **SMS**: Twilio stopped delivering to Syria in September 2025; Telnyx, LINK Mobility and Clickatell publish Syrian routes (registered sender name needed); local bulk SMS from Syriatel (and Zain, replacing MTN in 2027) comes through business contracts. Add an adapter in `apps/api/src/services/outbox.ts`.
- **Email**: Brevo accepted Syrian sign-ups in late 2026; Resend has no sanctions clause.
