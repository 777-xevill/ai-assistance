# AI Assistance: an AI sales and support assistant for any business (SaaS)

Businesses sign up, describe what they sell, connect their channels, and an AI assistant answers their customers
around the clock. It replies on **WhatsApp, Messenger, Instagram, Telegram and a website chat widget**. It
understands **text, product photos and voice messages**, answers from the business's own catalog and knowledge
base, and moves each customer toward a sale:

- **Shops**: recommend products, then collect name, phone, address, delivery area and payment method, and place the order.
- **Salons, clinics, agencies, real estate, education**: qualify the lead, check availability and book the appointment.
- **Hand-off to a person**: when a customer is angry, asks for a human, or hits a rule the business set. The AI then pauses itself.
- **Follow-ups**: messages quiet leads within the 24-hour messaging window.
- **Reports for the owner**: daily and weekly reports with hot leads, best sellers and questions the AI couldn't answer, plus instant email alerts for orders, bookings and hand-offs.

**No passwords are ever shared.** Facebook Pages, Instagram and WhatsApp connect through Meta's official login
windows (Facebook Login for Business and WhatsApp Embedded Signup). Telegram uses a bot token from @BotFather.
The website widget is one `<script>` tag. All tokens are encrypted at rest (AES-256-GCM).

## Quick start (local)

Requirements: **Node.js 24+**. No database install is needed: an embedded Postgres (PGlite) is used when `DATABASE_URL` is empty.

```bash
npm install
cp .env.example .env          # then set GROQ_API_KEY (free) and SUPERADMIN_EMAILS (for the admin console)
npm run seed                  # optional: demo account with "Nova Fashion" and "Glow Salon & Spa"
npm run dev                   # API on :3000, dashboard on http://localhost:5173
```

Demo login after seeding: `demo@example.com` / `demo12345`. Open **Test chat** to talk to the assistant as a customer.

- Get a free Groq key (no card) at <https://console.groq.com/keys> and paste it as `GROQ_API_KEY` in `.env`. It powers chat, photo understanding and voice messages.
- No key yet? Set `AI_MOCK=true` to try the whole product with canned replies.
- `npm run seed` needs the dev server stopped when you use the embedded database, because PGlite allows one process at a time.

## Production

```bash
npm run build                 # builds the dashboard into web/dist
npm start                     # one Node process serves the API, webhooks, widget and dashboard
```

| Setting | What to do |
|---|---|
| `DATABASE_URL` | Point it at a real PostgreSQL server (Neon, Supabase, RDS…). Migrations run on start. |
| `SECRET_KEY` | 32+ random characters. **Never change it later**: it encrypts the stored channel tokens. |
| `APP_URL` | Your public HTTPS URL. Leave `WEB_URL` empty. |
| `SMTP_URL`, `MAIL_FROM` | Needed for reports, alerts, invites and password resets. |
| `STT_API_KEY` | An OpenAI-compatible speech-to-text provider, needed for **voice messages** (Groq's Whisper is fast and cheap). |
| `SUPERADMIN_EMAILS` | Your own email, so you get the **Admin console** at `/admin`: every business, plan, trial, status, usage and AI cost, plus failed background jobs. |

Media uploads are stored in `DATA_DIR/media`. Put that directory on a persistent volume.

## Onboarding clients yourself

You don't need anything from a client: no documents, no passwords, no verification. Sign in as a super admin (`SUPERADMIN_EMAILS`), open **Admin console → Add a client**, and enter a business name and type.

- The business is created under your account, with its chat link ready. Click **Set up their assistant** to fill in the catalog, FAQs and personality for them (the same onboarding wizard a client would use), then send them the chat link.
- If the client also wants to see their own dashboard, tick **Also give the client their own login** (or use **Give login** on any row later). Their email is only a login name; a password is generated and shown once, with a **Copy message for the client** button. **Login → Set a new password** resets it.
- Set `SIGNUPS_ENABLED=false` to run invite-only: strangers can't create accounts, only the clients you add. Emails in `SUPERADMIN_EMAILS` can still sign up, so you can create your own account first.
- Businesses you manage show as "managed by you" in the list; owner and report emails then go to your address. Add the client's address under *Reports → Email & alerts* if they should get the reports.

## Connecting channels

**Nothing needs to be connected to start.** Every business gets a public **chat link and QR code** the moment it signs up (`/chat/<key>`). Customers open it in any browser (no login, no app), so the business just shares it on its Facebook Page, Instagram bio, WhatsApp status, Google profile, posters and receipts. This works without any Meta approval. Connecting the messaging apps below is optional.

| Channel | How a business connects |
|---|---|
| **Chat link / QR code** | Nothing to do. Copy the link or download the QR from *Channels*. |
| **Facebook, Instagram, WhatsApp via ManyChat** | The business connects its Page/Instagram/WhatsApp inside ManyChat (Meta-approved, needs ManyChat Pro) and pastes ManyChat's API key. Then, in ManyChat's Default Reply, add an *External Request* to the URL shown under **Setup steps**. **No Meta app, App Review or business verification on your side.** |
| Messenger and Instagram | **Connect** → Facebook login window → pick Pages. Needs your Meta app: see [docs/META_SETUP.md](docs/META_SETUP.md). |
| WhatsApp | **Connect** → WhatsApp Embedded Signup → pick or verify a number. Needs Meta Tech Provider status: see [docs/META_SETUP.md](docs/META_SETUP.md). |
| Telegram | Paste the bot token from @BotFather. The webhook is set automatically. |
| Website | Copy the `<script>` snippet into the site, or open the built-in preview page. |

Meta channels need **App Review** (Advanced Access) and **Business Verification** before businesses outside
your own app roles can connect. Plan a few days to a couple of weeks for this.

## How the AI works

- **Providers** (`AI_PROVIDER`):
  - **Groq** (free tier): chat and tools run on `openai/gpt-oss-120b`. Photos are routed automatically to `qwen/qwen3.8-27b`, which can see images. Voice uses Whisper (`whisper-large-v3-turbo`). One `GROQ_API_KEY` covers all three. Free-tier limits are tight (requests and tokens per minute and per day): the app waits and retries on rate limits, but a busy business will outgrow them. Check your limits at <https://console.groq.com/settings/limits>.
  - **Claude** (paid): set `ANTHROPIC_API_KEY` and `AI_PROVIDER=anthropic`. `AI_MODEL` defaults to `claude-opus-5-5` with adaptive thinking and server-side fallbacks. For lower cost use `claude-sonnet-5-5` or `claude-haiku-5-5`, and/or `AI_EFFORT=low`.
  - Claude is the stronger choice for long sales conversations and Bangla/Banglish. Switching is one line in `.env`; no data changes.
- **Grounding**: the assistant works through tools instead of guessing. It can search the catalog, look up items, search FAQs, quote and create orders, check availability and book, send product photos, save customer details, update the lead stage, request a human, and log unanswered questions.
  - Unanswered questions show up under **Knowledge → Unanswered questions**, so the business can fill the gap in one click.
- **Prompt caching** (Claude): each business's instructions and catalog summary are cached and only rebuilt when they change, which keeps the cost per reply low.
- **Natural replies**:
  - The assistant waits for customers who send several short messages in a row, then answers them together.
  - It shows typing indicators and splits long answers into chat-sized bubbles.
  - It mirrors the customer's language, including mixes such as Banglish.
- **Honesty**: the assistant presents itself under the business's chosen name. If asked, it says it is a virtual assistant. It never invents prices, stock or policies.
- **Usage limits**: each plan has a monthly AI-reply quota. Past it, messages still arrive in the inbox for the team to answer.

## Billing

Plans live in `server/src/lib/plans.ts`. The prices and limits there are **placeholders**.

Payment collection is not wired up. A business owner can request a plan from *Settings → Plan & usage*, which
emails the super admins, and the plan is then assigned in the Admin console. Add Stripe or your local gateway
(SSLCommerz, bKash and so on) when you're ready.

## Project layout

```
server/   Express 5 API, webhooks, job queue (Postgres), AI agent, channel adapters
  src/ai/         prompt, tools, agent loop
  src/channels/   Messenger / Instagram / WhatsApp / Telegram / web chat adapters
  src/jobs/       reply debounce, media processing, follow-ups, scheduled reports
  src/routes/     REST API used by the dashboard, plus webhooks and widget endpoints
  public/widget.js  website chat widget
web/      React dashboard (Vite, Tailwind, TanStack Query)
docs/     Meta setup guide
```

## Scripts

| Command | |
|---|---|
| `npm run dev` | API and dashboard with reload |
| `npm run build` / `npm start` | Production build and serve |
| `npm test` | Server test suite (unit and end-to-end, runs on an embedded database with mock AI) |
| `npm run typecheck` | TypeScript checks for server and web |
| `npm run seed` | Demo data |
| `npm run db:generate` | New SQL migration after changing `server/src/db/schema.ts` |
