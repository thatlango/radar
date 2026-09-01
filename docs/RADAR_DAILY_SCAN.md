# Radar Daily Scan

Radar turns the opportunity-search workflows used by Tuku-Tuku into a reusable product for individuals and organisations.

## User journey

1. Sign in with Tuku.
2. Tell Radar **what I am looking for** in normal language.
3. Add skills/domains manually or upload a PDF/TXT CV/profile.
4. Choose whether the profile represents an **individual**, **firm**, or **both**.
5. Firms can explicitly say they **can recruit/contract specialists**. Radar then treats missing domain expertise as a recruitable gap while still enforcing hard corporate eligibility constraints.
6. Choose preferred opportunity types, countries/regions and remote preference.
7. Configure the morning brief for **08:00 or 09:00 local time** and choose **email, WhatsApp, or both**.
8. Set a minimum fit score and minimum days remaining before deadline.
9. Radar stays quiet when there is nothing new that clears the saved thresholds.

## Scan presets

Radar ships with three built-in scan profiles that encode the existing Tuku opportunity-search workflows:

- **Consulting & implementation opportunities** — firm-level consulting, technical assistance, programme design/implementation, research, capacity building, institutional strengthening, private sector/MSME, innovation, digital transformation, MEL, frameworks, rosters and consortium opportunities.
- **Strong-fit roles & individual consultancies** — programme management, enterprise/MSME, innovation ecosystems, livelihoods, partnerships, MEL/learning, digital transformation and youth employment.
- **Innovation & entrepreneurship** — innovation ecosystems, accelerators, incubators, venture support, business advisory, investment readiness and enterprise growth.

The shared scan runs all presets. Individual users can choose a preferred preset; Radar also adds limited personalized discovery queries based on their `whatLookingFor` text and skills.

## Source policy

LinkedIn is a primary discovery channel, together with Opportunity Desk and Global South Opportunities. Radar also searches/targets official and development-sector sources including UNGM, ReliefWeb, GIZ, World Bank/IFC, AfDB, Enabel, Mercy Corps, TechnoServe, SNV, Swisscontact, Save the Children, Oxfam, UNDP, UNICEF, ILO, UNIDO, IUCN, NITA-U, PPDA Uganda, DevNetJobs, DevelopmentAid, Devex, Assortis, dgMarket and other tender aggregators.

The cross-source scan is implemented through a web-search API so Radar does not depend on brittle HTML scraping for every site. Set one of:

- `BRAVE_SEARCH_API_KEY` (preferred), or
- `SERPER_API_KEY`.

A dedicated LinkedIn jobs API is optional. If it is not configured, LinkedIn is still searched via the cross-source discovery layer.

## Scheduling

The scheduler process (`npm run alerts:start`) performs two jobs:

- refreshes the shared opportunity pool every four hours;
- checks hourly for users whose chosen local delivery time is due.

A user brief is sent at 08:00 or 09:00 in the timezone stored in their profile. `lastSent` prevents duplicate sends on the same local day.

The scheduler must run as a separate long-running process/container in production. `compose.prod.yml` includes the `scheduler` service.

## Matching

Radar combines:

- free-text search intent;
- parsed/manual skills;
- industries/domains;
- profile type (individual / firm / both);
- firm ability to recruit specialists;
- opportunity type preferences;
- geography/remote preferences;
- deadline runway;
- freshness;
- interaction history;
- Tuku AI analysis when configured.

Batch matching is routed through Tuku Core AI (`TUKU_AI_INTEGRATION_KEY`) rather than a separate public model dependency.

## CV ingestion and privacy

The current implementation accepts PDF and TXT CV/profile files up to 5 MB. Radar extracts text and stores the extracted text in the user profile for matching. The raw uploaded file is not persisted by this API. Users can delete the stored CV text from their profile.

Tuku AI may extract skills and industry/domain labels from the CV. The extraction prompt explicitly forbids inventing experience.

## Daily brief delivery

### Email

Configure:

- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE` (`true`/`false`)
- `SMTP_USER`
- `SMTP_PASS`
- `RADAR_ALERT_FROM` (e.g. `Radar by Tuku-Tuku <radar@tukutuku.org>`)

### WhatsApp

Current transport uses Twilio WhatsApp. Configure:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_WHATSAPP_FROM` — plain E.164 sender number, e.g. `+14155238886` (do not prefix it with `whatsapp:` in the env value).

User phone numbers should be stored in international E.164 format.

The delivery layer is intentionally isolated so it can later be swapped to Tuku Core Notifications / Meta WhatsApp Cloud API without changing matching or scan logic.

## Core production environment

At minimum:

```env
DATABASE_URL=postgresql://...
TUKU_CORE_INTERNAL_URL=https://core.tukutuku.org
TUKU_CORE_BROWSER_URL=https://core.tukutuku.org
TUKU_AI_INTEGRATION_KEY=...
RADAR_REDIRECT_URI=https://radar.tukutuku.org/auth/tuku/callback

# Discovery: at least one
BRAVE_SEARCH_API_KEY=...
# SERPER_API_KEY=...

# Email
SMTP_HOST=...
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=...
SMTP_PASS=...
RADAR_ALERT_FROM=Radar by Tuku-Tuku <radar@tukutuku.org>

# WhatsApp (only required for WhatsApp briefs)
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_WHATSAPP_FROM=+...
```

Optional discovery tuning:

```env
RADAR_DISCOVERY_MAX_QUERIES=24
RADAR_DISCOVERY_MAX_RESULTS=180
RADAR_LINKEDIN_KEYWORDS=...
RADAR_LINKEDIN_LOCATIONS=Uganda,Kenya,Rwanda,Tanzania,Ethiopia,Africa,Remote
RADAR_LINKEDIN_LIMIT=50
```

## Deployment

After updating the production checkout/image:

```bash
npm ci
npx prisma generate
npm run prisma:deploy
```

For Docker Compose deployments:

```bash
docker compose --env-file /opt/tuku/secrets/radar.env -f compose.prod.yml build
docker compose --env-file /opt/tuku/secrets/radar.env -f compose.prod.yml up -d
```

Verify both `radar-api` and `radar-scheduler` are running. Then test:

- `/health`
- `/ready`
- Tuku sign-in
- CV upload
- profile save
- daily brief preview
- one test email
- one test WhatsApp (if enabled)
- one manual scan via `npm run scraper:run` in a safe environment.

## Deliberate product behavior

- No duplicate daily brief when nothing new qualifies.
- Unknown/unstated eligibility is not invented.
- Missing sector expertise can be shown as a specialist gap for firms that allow recruitment.
- Hard eligibility requirements remain hard constraints.
- Source URLs are preserved so the user can inspect the original posting.
- Discovery sources and personalized ranking are separate: Radar builds a shared opportunity pool, then ranks that pool per user.
