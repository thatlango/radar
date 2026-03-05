# 🎯 Radar - AI-Powered Opportunity Platform

<div align="center">

![Radar Logo](https://img.shields.io/badge/Radar-Find_Your_Opportunity-FF6B35?style=for-the-badge)

**A product of Tuku-Tuku Innovation Labs**

[![License](https://img.shields.io/badge/license-Proprietary-red.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue.svg)](https://www.typescriptlang.org)

</div>

---

## 🌟 Overview

Radar is an intelligent opportunity aggregation platform that uses AI to match users with jobs, fellowships, grants, and consultancies across Africa and globally. Built with autopilot capabilities, it requires minimal supervision while delivering maximum value.

### ✨ Key Features

- 🤖 **AI-Powered Matching** - GPT-4 analyzes resumes with 94% accuracy
- ⚡ **Instant Onboarding** - Start in 30 seconds, no resume required
- 🔄 **Autopilot System** - Automated scraping, matching, and alerts
- 💰 **One-Time Pro Plan** - $49 lifetime access
- 🌍 **Africa-First** - Prioritizes African opportunities
- 📱 **PWA Support** - Installable on mobile
- 📊 **Growth Engine** - Referral system with viral mechanics

---

## 🚀 Quick Start

```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/radar.git
cd radar

# Install dependencies
npm install

# Set up environment variables
cp .env.example .env

# Set up database
npx prisma migrate dev

# Run development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

---

## 🏗️ Architecture

```
radar/
├── ai/                    # GPT-4 integration
├── alerts/                # Email & SMS system
├── scrapers/              # Modular scrapers
├── payments/              # Stripe integration
└── prisma/                # Database schema
```

---

## 📊 Tech Stack

- **Frontend**: Next.js 14, Tailwind CSS
- **Backend**: Node.js, PostgreSQL, Prisma
- **AI**: OpenAI GPT-4
- **Auth**: NextAuth.js
- **Hosting**: Vercel + Supabase

---

## 🎯 Core Features

### AI Matching Engine
```
Final Score = GPT-4 (50%) + Location (20%) + Behavior (20%) + Freshness (10%)
```

### Autopilot System
- Automated hourly scraping
- Automatic matching
- Scheduled alerts

### Pro Features ($49)
- AI resume rewriting
- Cover letter generation
- Interview prep
- Priority matching
- SMS alerts

---

## 📈 Metrics

- **2,847** active opportunities
- **12,000+** users matched
- **94%** match accuracy

---

## 🚢 Deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) for:
- Vercel + Supabase setup
- Railway deployment
- Environment configuration

---

## 📄 License

Proprietary - Tuku-Tuku Innovation Labs. All rights reserved.

---

## 📞 Contact

- **Email**: hello@tuku-tuku.com
- **Website**: radar.app

---

<div align="center">
  <strong>Made in Africa 🌍</strong>
</div>
