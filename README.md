# S Creation — global e-commerce store

Storefront for **screationindia.in**: premium polos and tees sold in MOQ quantities, with multi-currency checkout, multiple languages, Stripe + PayPal, and DHL Express.

```
┌────────────── GitHub ──────────────┐        ┌──────────── Cloudflare ────────────┐
│ repo: site/ admin/ content/ worker/ │        │ Worker  api.screationindia.in       │
│ Actions: build static site ─────────┼─pulls──┤  ├ D1   products, orders, settings   │
│ Pages:   screationindia.in  (HTML)  │◀─────── │  ├ R2   product photos, DHL labels  │
└─────────────────────────────────────┘ publish │  ├ Cron daily FX rates              │
       ▲  shopper browser ── cart/checkout ───▶ │  └ Stripe · PayPal · DHL · Resend   │
       └── /admin dashboard ── API ───────────▶ └─────────────────────────────────────┘
```

* **Storefront** (`site/`) — a zero-dependency Node generator that pre-renders every page to static HTML (fast, crawlable, cheap). Hosted on GitHub Pages.
* **API** (`worker/`) — one Cloudflare Worker: catalogue export, live FX, shipping quotes, checkout, payment webhooks, order status, contact form, admin API, image hosting.
* **Dashboard** (`admin/`, served at `/admin/`) — manage products, photos, translations, orders, DHL shipments, settings, and **Publish** (rebuilds the site in ~1–2 min).
* **Shared pricing** (`shared/pricing.js`) — the same code converts and rounds prices in the browser, the build and the Worker, so the price a shopper sees is the price charged.

## What's built

| Area | Details |
|---|---|
| Ordering | Size × colour quantity grid per product, MOQ **per product** (any mix of sizes & colours), live progress bar, volume tiers applied automatically, cart persists in the browser |
| Currencies | Base prices in INR; USD, EUR, GBP, AED, AUD, CAD, SGD (editable). Daily rates (open.er-api.com → frankfurter.app fallback), per-currency markup and "round up to" steps. Visitor currency auto-detected from Cloudflare geo, switchable |
| Languages | English live; German, French, Spanish built in (UI fully translated). Turn on per language in Settings; translate products/pages in the dashboard (optional AI draft via Workers AI). Untranslated pages stay English with canonical → English, so no duplicate content |
| Payments | Stripe Checkout (cards, Apple Pay, Google Pay; signed webhooks + direct session check) and PayPal Orders v2 (redirect + capture, optional verified webhooks). Pluggable: `worker/src/payments/` |
| Shipping | DHL Express MyDHL API live rates at checkout (multi-box packing from product weights), one-click shipment + label + commercial invoice from the order page, tracking emails. Zone-based fallback rates. Pluggable: `worker/src/shipping/` |
| Tax | Per-country rules (seeded: India GST 5% on goods). Exports ship DAP |
| SEO | Static HTML, clean URLs, canonical + hreflang, XML sitemap (with images and language alternates), JSON-LD (Organization, WebSite, ProductGroup with per-colour variants, Offers with MOQ and tier pricing in every currency, BreadcrumbList, FAQPage, CollectionPage), Open Graph/Twitter cards, Google Merchant Center feeds per currency (`/feeds/google-USD.xml`…) |
| AI visibility | `robots.txt` explicitly allows GPTBot, ClaudeBot, PerplexityBot, Google-Extended etc.; `/llms.txt` + `/llms-full.txt` summaries; `/catalog.json` machine-readable catalogue; long-form use cases, specs and FAQs on every product page |
| Customer accounts | Sign up with email/password or **Google**; account area with orders, order detail (size × colour breakdown), **PDF invoice download**, tracking links, "order again", profile, saved addresses (picked at checkout), password change, sign out everywhere. Guest orders appear once the email is verified. Password reset and email verification by email |
| Team access | Multiple dashboard users with roles — **Owner** (everything incl. team), **Manager** (orders, products, settings, publish), **Staff** (orders, messages). Invite by email; sign in with **Google** or a password; optional auto-approve for a Google Workspace domain; disable/remove instantly |
| Order management | Status changes and quick actions, shipping details for any courier (DHL, Blue Dart, Delhivery, FedEx, UPS, Aramex, other + custom URL), **one-click DHL label + commercial invoice**, **GST tax invoice / export invoice PDF** with financial-year numbering (CGST+SGST vs IGST), **packing slip PDF**, edit ship-to address, resend confirmation, shipped emails, timeline, CSV export |
| Dashboard | Dashboard KPIs + setup checklist, orders (filters, search, CSV export, size × colour pick-list, status, tracking, DHL shipment, timeline), product editor (9 tabs incl. photos with in-browser WebP conversion, pricing preview in all currencies, Google preview, translations), enquiries inbox, settings (store, currencies, languages, payments, shipping, tax, content/pages/FAQs/size charts, SEO & analytics, team, raw JSON), publish history |
| Security | PBKDF2 passwords, role checks on every admin API call (read live from the DB), session revocation on password change/disable, OAuth state signing + return-URL allow-list, signed expiring sessions, login rate-limiting, server-side re-pricing of every order, HMAC-signed shipping quotes bound to cart + address, Stripe signature verification, redirect allow-list, CORS allow-list, honeypot on contact form |

## ⚠️ Placeholders to confirm before launch

These are seeded so the site works end-to-end — **replace them in the dashboard**:

* **Prices & tiers** (INR/pc): Aurum 650 · Terra 540 · Gaia 560 · Astra 420 · Luna 450 · Atlas 690, with ~5%/10% breaks at 100/250 pcs.
* **MOQ**: 50 pcs for every product.
* **Weights** (g/pc) and **HS codes** (6105.10 / 6105.20 / 6106.10 / 6109.10) — check them with your customs agent.
* **Fallback shipping zones**: India ₹250 + ₹40/kg; rest of world ₹2,500 + ₹900/kg (only used when DHL has no rate).
* **Ship-from address**: currently Surat 395003. Also needed: the studio address and GSTIN.
* **Policies**: Returns, Terms and Privacy are placeholders. They are hidden from search until you edit them, and Stripe and PayPal require them.
* **Product photos**: an illustrated garment in each colour is shown until you upload photos (Products → Colours & photos).
* **Logo**: the wordmark is in use. Set a logo URL in Settings → Store.
* Open questions from the catalogue work: what "OBT Ready" means and who backs the 200-day warranty (Astra, Luna); Optiknit/GRS confirmation (Terra, Gaia); care for the polyester lines; size chart for Atlas.

## Go-live steps

### 1. GitHub
1. Create a repo (e.g. `s-creation-store`) and push this folder to `main`.
2. **Settings → Pages → Source: GitHub Actions.**
3. **Settings → Secrets and variables → Actions**
   * Variable `API_URL` = `https://api.screationindia.in`
   * Secrets `CLOUDFLARE_API_TOKEN` (template "Edit Cloudflare Workers" + D1 edit) and `CLOUDFLARE_ACCOUNT_ID`.

### 2. Move DNS to Cloudflare
1. Cloudflare → *Add a site* → `screationindia.in` (Free plan).
2. At DomainJerry, replace the nameservers with the two Cloudflare gives you. Propagation usually takes minutes to hours.
3. In Cloudflare DNS, point the site at GitHub Pages. Set these records to **DNS only** (grey cloud) so GitHub can issue the TLS certificate:
   * `A @ → 185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
   * `CNAME www → <your-github-user>.github.io`
4. GitHub → Settings → Pages → Custom domain `screationindia.in` → tick **Enforce HTTPS** once the certificate is ready.
   *(The build writes the `CNAME` file automatically.)*

### 3. Cloudflare backend
```bash
cd worker && npm install
npx wrangler login
npx wrangler d1 create screation           # copy database_id into wrangler.toml
npx wrangler r2 bucket create screation-media
npx wrangler d1 migrations apply screation --remote
# set GITHUB_REPO in wrangler.toml, then secrets:
npx wrangler secret put SESSION_SECRET     # 40+ random chars
npx wrangler secret put SETUP_TOKEN        # one-time, for creating the owner account
npx wrangler secret put GITHUB_TOKEN       # fine-grained PAT on the repo: Contents R/W, Actions R
npx wrangler deploy                        # creates api.screationindia.in automatically
```
Later deploys run automatically from GitHub Actions on every push to `worker/`.

### 4. Google sign-in (customers and team)
1. Go to console.cloud.google.com and create a project, e.g. "S Creation".
2. Open **APIs & Services → OAuth consent screen**, choose *External*, and fill in the app name, support email and the authorized domain `screationindia.in`. Then **Publish app**.
3. Open **Credentials → Create credentials → OAuth client ID** and choose *Web application*.
   * Authorized redirect URI: `https://api.screationindia.in/api/auth/google/callback`
4. Store the client ID and secret as Worker secrets: `npx wrangler secret put GOOGLE_CLIENT_ID` and `npx wrangler secret put GOOGLE_CLIENT_SECRET`.
5. "Continue with Google" now shows on `/account/` and `/admin/`. Team members must be invited first, under Dashboard → Team, with the exact Google email.

### 5. Payments
* **Stripe** — Make sure your Stripe account supports your business in India and has international cards enabled. Then:
  * `wrangler secret put STRIPE_SECRET_KEY`
  * Add a webhook to `https://api.screationindia.in/api/webhooks/stripe` for these events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`.
  * `wrangler secret put STRIPE_WEBHOOK_SECRET`
* **PayPal** — Create a Business account, then a REST app at developer.paypal.com.
  * Set `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`.
  * Optionally add a webhook to `/api/webhooks/paypal` (event `PAYMENT.CAPTURE.COMPLETED`) and set `PAYPAL_WEBHOOK_ID`.
  * Switch the mode from *sandbox* to *live* in Settings → Payments.
  * PayPal can't take INR for cross-border payments, so it is hidden when the shopper's currency is INR.

### 6. DHL Express
Request **MyDHL API** access at developer.dhl.com; it needs a DHL Express account number. Then:
* Set `DHL_API_KEY`, `DHL_API_SECRET` and `DHL_ACCOUNT_NUMBER`.
* Test against DHL's test environment first, which is on by default. When you're ready, untick *Use DHL test environment* and set `DHL_ENV = "live"` in wrangler.toml.
* Fill in the ship-from address and GSTIN under Settings → Shipping.

### 7. Optional
* **Emails (strongly recommended):** sign up at resend.com, verify the domain, then set `RESEND_API_KEY` and add an `EMAIL_FROM` var such as `S Creation <orders@screationindia.in>`.
  * Resend sends order confirmations with the invoice PDF attached, shipping notices, and account emails (verification, password reset).
  * Without it, those emails are skipped.
* **Analytics:** GA4 ID or Cloudflare Web Analytics token (Settings → SEO & analytics).

### 8. First run
1. Open `https://screationindia.in/admin/` and create the owner account with your `SETUP_TOKEN`.
2. Go to **Products** and click **Import the 6 starter products**.
3. Set prices, upload photos and edit the policies.
4. Fill in your GSTIN, legal name and address under **Settings → Accounts & invoices**.
5. Invite your team under **Team**.
6. Click **Publish site**.
7. Check the **Setup checklist** on the dashboard: every line should be green.
8. Submit `https://screationindia.in/sitemap.xml` to Google Search Console and Bing Webmaster Tools. Add `/feeds/google-<CUR>.xml` to Google Merchant Center.

## Day-to-day
* **Edit products, settings or pages, then click Publish.** Exchange-rate price changes go live without publishing.
* **Orders:** when an order is paid, open it and:
  * print the **packing slip**;
  * click **Generate DHL label**, or type in another courier's tracking number. Either way the order is marked shipped and the customer gets an email with the tracking link;
  * download the **tax invoice** whenever you need it. Invoice numbers are assigned at payment as `SC/2026-27/0001` and run in sequence within each financial year.
* **Refunds:** issue them in Stripe or PayPal, then set the order status to *refunded*.
* **Adding a language:** go to Settings → Languages, then Products → Translations. **Auto-translate** writes a draft that you review before publishing.

## Local development
```bash
cd worker && npm install
cp wrangler.toml wrangler.local.toml   # remove the [ai] block and the routes line for local use
printf 'SESSION_SECRET=dev-secret-0123456789abcdef\nSETUP_TOKEN=dev\n' > .dev.vars
npx wrangler d1 migrations apply screation --local -c wrangler.local.toml
npx wrangler dev -c wrangler.local.toml --var API_URL:http://localhost:8787 --var SITE_URL:http://localhost:8080
# new terminal, repo root:
npm run build:local && npx serve dist -l 8080      # site at :8080, dashboard at :8080/admin/
```
Without `API_URL` the build falls back to `content/*.json` (handy for design work).

## Extending
* **Database changes:** add a new numbered file to `worker/migrations/`. The GitHub Action applies it on deploy.
* **Payment gateway** (e.g. Razorpay): add `worker/src/payments/<name>.js` exposing `{ id, configured, supports, create }`, register it in `payments/index.js`, add `settings.payments.<name>`.
* **Courier** (e.g. Shiprocket, Aramex): add `worker/src/shipping/<name>.js` exposing `{ id, configured, rates }` and call it from `shipping/index.js`.
* **New products 7–17**: use Products → New product, or add them to `content/products.json` and run **Import starter products**.
