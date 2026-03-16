# Radar Platform - Complete Deployment Guide

## 🚀 Quick Start (Local Development)

### Prerequisites
```bash
Node.js 20+ 
PostgreSQL 15+
Git
```

### Step 1: Clone and Install
```bash
git clone https://github.com/tuku-tuku/radar.git
cd radar
npm install
```

### Step 2: Database Setup
```bash
# Start PostgreSQL (or use Supabase)
createdb radar

# Copy environment variables
cp .env.example .env

# Edit .env with your database URL
DATABASE_URL="postgresql://user:password@localhost:5432/radar"

# Run migrations
npx prisma migrate dev
npx prisma generate

# Seed database with test data
npm run prisma:seed
```

### Step 3: Configure Services

#### OpenAI
1. Get API key from https://platform.openai.com
2. Add to `.env`: `OPENAI_API_KEY="sk-..."`

#### Stripe
1. Create account at https://stripe.com
2. Get test keys from Dashboard
3. Add to `.env`:
```
STRIPE_SECRET_KEY="sk_test_..."
STRIPE_PUBLISHABLE_KEY="pk_test_..."
```

#### Google OAuth
1. Go to https://console.cloud.google.com
2. Create OAuth 2.0 credentials
3. Add to `.env`:
```
GOOGLE_CLIENT_ID="..."
GOOGLE_CLIENT_SECRET="..."
```

### Step 4: Run Development Server
```bash
npm run dev
```

Open http://localhost:3000

---

## 🌐 Production Deployment

### Option 1: Vercel + Supabase (Recommended)

#### 1. Database (Supabase)
```bash
# Create project at supabase.com
# Get connection string
DATABASE_URL="postgresql://postgres:[password]@[host]:5432/postgres"

# Run migrations
npx prisma migrate deploy
```

#### 2. Frontend (Vercel)
```bash
# Install Vercel CLI
npm i -g vercel

# Deploy
vercel --prod

# Add environment variables in Vercel dashboard
```

#### 3. Background Jobs (Vercel Cron)
Create `vercel.json`:
```json
{
  "crons": [
    {
      "path": "/api/cron/scrapers",
      "schedule": "0 * * * *"
    },
    {
      "path": "/api/cron/alerts",
      "schedule": "0 8 * * *"
    }
  ]
}
```

### Option 2: Railway (Backend + DB)

#### 1. Deploy Database
```bash
railway login
railway init
railway add postgresql

# Get DATABASE_URL from dashboard
```

#### 2. Deploy Application
```bash
# Push to Railway
railway up

# Add environment variables
railway variables:set OPENAI_API_KEY=...
```

#### 3. Run Migrations
```bash
railway run npx prisma migrate deploy
```


### Option 4: Netlify (Static Landing Page)

This repository currently deploys the landing page as a **static site** from `public/`.

1. Connect repo to Netlify.
2. Build command: `npm run build:static`
3. Publish directory: `public`
4. Node version: `20`

`netlify.toml` already includes these defaults, so most projects can deploy without dashboard overrides.

### Option 3: AWS/GCP (Enterprise Scale)

#### Architecture:
- **Frontend**: CloudFront + S3
- **API**: ECS/EKS containers
- **Database**: RDS PostgreSQL
- **Cache**: ElastiCache Redis
- **Jobs**: Lambda functions
- **Queue**: SQS

---

## 🔐 Security Checklist

### Before Production:
- [ ] Change all default secrets
- [ ] Enable HTTPS only
- [ ] Configure CORS properly
- [ ] Set up rate limiting
- [ ] Enable SQL injection protection
- [ ] Configure CSP headers
- [ ] Set up monitoring (Sentry)
- [ ] Enable database backups
- [ ] Configure firewall rules
- [ ] Set up DDoS protection (Cloudflare)

### Environment Variables:
```bash
# NEVER commit .env to git
echo ".env" >> .gitignore

# Use different keys for production
NEXTAUTH_SECRET="production-secret-here"
JWT_SECRET="different-production-secret"
```

---

## 📊 Monitoring Setup

### 1. Error Tracking (Sentry)
```bash
npm install @sentry/nextjs

# Add to .env
SENTRY_DSN="https://...@sentry.io/..."
```

### 2. Analytics (PostHog)
```bash
# Already installed
NEXT_PUBLIC_POSTHOG_KEY="phc_..."
```

### 3. Uptime Monitoring
- Use UptimeRobot or Pingdom
- Monitor endpoints:
  - `/api/health`
  - `/api/scrapers/health`

### 4. Database Monitoring
```sql
-- Create monitoring views
CREATE VIEW active_users AS
SELECT COUNT(*) FROM users WHERE last_login_at > NOW() - INTERVAL '7 days';

CREATE VIEW scraper_health AS
SELECT name, last_run, error_count FROM scraper_sources WHERE active = true;
```

---

## 🔄 CI/CD Pipeline

### GitHub Actions
Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node
        uses: actions/setup-node@v3
        with:
          node-version: '20'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Run tests
        run: npm test
      
      - name: Build
        run: npm run build
      
      - name: Deploy to Vercel
        run: vercel --prod --token ${{ secrets.VERCEL_TOKEN }}
        env:
          VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
          VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}
```

---

## 🧪 Testing

### Unit Tests
```bash
npm test
```

### Integration Tests
```bash
npm run test:integration
```

### E2E Tests
```bash
npm run test:e2e
```

---

## 📈 Scaling Strategy

### Phase 1: 0-1K Users
- **Infrastructure**: Vercel free + Supabase free
- **Cost**: $0/month
- **Database**: Shared PostgreSQL
- **Jobs**: Vercel cron

### Phase 2: 1K-10K Users
- **Infrastructure**: Vercel Pro + Supabase Pro
- **Cost**: ~$40/month
- **Database**: Dedicated PostgreSQL
- **Jobs**: Separate worker dyno
- **Cache**: Redis for search results

### Phase 3: 10K-100K Users
- **Infrastructure**: Enterprise hosting
- **Cost**: $500-1000/month
- **Database**: Multi-region PostgreSQL
- **Jobs**: Kubernetes pods
- **Cache**: Redis cluster
- **CDN**: CloudFront/Cloudflare

### Phase 4: 100K+ Users
- **Infrastructure**: Full AWS/GCP
- **Cost**: $5000+/month
- **Database**: Aurora PostgreSQL with read replicas
- **Jobs**: Lambda/Cloud Functions
- **Cache**: Redis cluster with sharding
- **CDN**: Multi-region
- **Load Balancer**: Application Load Balancer

---

## 🔧 Maintenance

### Daily Tasks (Automated)
- ✅ Run scrapers
- ✅ Send alerts
- ✅ Generate matches
- ✅ Backup database

### Weekly Tasks
- Review scraper health
- Check error logs
- Monitor conversion rates
- Update opportunity quality scores

### Monthly Tasks
- Database optimization
- Update dependencies
- Review security patches
- Analyze user feedback

---

## 🐛 Troubleshooting

### Scraper Failures
```bash
# Check scraper logs
railway logs --tail

# Test individual scraper
npm run scraper:test linkedin

# Reset error count
npm run scraper:reset <sourceId>
```

### Database Issues
```bash
# Check connections
SELECT count(*) FROM pg_stat_activity;

# Kill long-running queries
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE state = 'active' AND now() - query_start > interval '5 minutes';

# Vacuum database
VACUUM ANALYZE;
```

### Performance Issues
```bash
# Check slow queries
SELECT * FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 10;

# Add indexes
CREATE INDEX CONCURRENTLY idx_opportunities_created_at ON opportunities(created_at DESC);

# Enable query caching
# Add Redis and cache frequent queries
```

---

## 📞 Support

### Emergency Contacts
- **Technical**: tech@tuku-tuku.com
- **Business**: hello@tuku-tuku.com
- **On-call**: +254-XXX-XXXXXX

### Resources
- **Documentation**: https://docs.radar.app
- **Status Page**: https://status.radar.app
- **Slack**: tuku-tuku.slack.com #radar-tech

---

## 📄 License

Proprietary - Tuku-Tuku Innovation Labs

All rights reserved. Unauthorized copying, distribution, or use of this software is strictly prohibited.
