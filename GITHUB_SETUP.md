# 🚀 GitHub Setup Guide for Radar

## Step-by-Step Instructions to Push to GitHub

### 1️⃣ Create GitHub Repository

1. Go to [https://github.com/new](https://github.com/new)
2. Repository name: `radar`
3. Description: "AI-powered opportunity platform for Africa"
4. **Choose**: Private (recommended) or Public
5. **DO NOT** initialize with README, .gitignore, or license (we already have these)
6. Click "Create repository"

### 2️⃣ Configure Git (if not already done)

```bash
# Set your GitHub username
git config --global user.name "Your Name"

# Set your GitHub email
git config --global user.email "your-email@example.com"
```

### 3️⃣ Push to GitHub

Copy the commands from your new GitHub repository page, they will look like:

```bash
# Navigate to the project directory
cd radar-github

# Add GitHub as remote origin
git remote add origin https://github.com/YOUR_USERNAME/radar.git

# Push to GitHub
git push -u origin main
```

**OR** if you prefer SSH:

```bash
git remote add origin git@github.com:YOUR_USERNAME/radar.git
git push -u origin main
```

### 4️⃣ Verify Upload

1. Refresh your GitHub repository page
2. You should see all files including:
   - ✅ README.md
   - ✅ LICENSE
   - ✅ CONTRIBUTING.md
   - ✅ ai/, alerts/, scrapers/ directories
   - ✅ prisma/schema.prisma
   - ✅ package.json

---

## 📁 What's Included

Your repository now contains:

```
radar/
├── .gitignore              ✅ Ignores node_modules, .env, etc.
├── README.md               ✅ GitHub-optimized with badges
├── LICENSE                 ✅ Proprietary license
├── CONTRIBUTING.md         ✅ Contribution guidelines
├── DEPLOYMENT.md           ✅ Full deployment guide
├── package.json            ✅ All dependencies
├── .env.example           ✅ Environment template
├── ai/                     ✅ AI matching & Pro features
├── alerts/                 ✅ Email & SMS system
├── scrapers/               ✅ Modular scraper system
├── payments/               ✅ Stripe integration
├── prisma/                 ✅ Database schema
└── public/                 ✅ Improved UI demo
```

---

## 🔐 Security: Protecting Sensitive Files

### Files Already Ignored (in .gitignore):

- ✅ `.env` - Never commit API keys
- ✅ `node_modules/` - Too large for Git
- ✅ `.env*.local` - Local environment files
- ✅ Build artifacts

### Before You Push:

**CRITICAL**: Never commit these to GitHub:
- ❌ API keys (OpenAI, Stripe, Twilio)
- ❌ Database credentials
- ❌ Secret tokens
- ❌ Private keys

All sensitive data should be in `.env` files which are gitignored.

---

## 🌐 Setting Up GitHub Pages (Optional Demo)

If you want to showcase the UI:

1. Go to repository Settings → Pages
2. Source: Deploy from branch
3. Branch: `main` → `/public`
4. Your demo will be at: `https://YOUR_USERNAME.github.io/radar/`

---

## 🔄 Making Updates

After making changes:

```bash
# Stage changes
git add .

# Commit with message
git commit -m "feat: add new feature"

# Push to GitHub
git push origin main
```

---

## 🤝 Collaborating with Team

### Add Collaborators:
1. Repository Settings → Collaborators
2. Add team members by username/email

### Branch Strategy:
```bash
# Create feature branch
git checkout -b feature/new-scraper

# Work on your feature
# ...

# Commit changes
git add .
git commit -m "feat: add new scraper for XYZ"

# Push branch
git push origin feature/new-scraper

# Create Pull Request on GitHub
```

---

## 📊 Setting Up GitHub Actions (CI/CD)

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy Radar

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
      - run: npm ci
      - run: npm test
      - run: npm run build
```

---

## 🏷️ Creating Releases

```bash
# Tag a version
git tag -a v1.0.0 -m "Initial release"

# Push tags
git push origin v1.0.0

# Or push all tags
git push --tags
```

On GitHub:
1. Go to Releases → Create new release
2. Choose tag: v1.0.0
3. Title: "Radar v1.0.0 - Initial Launch"
4. Add release notes
5. Publish release

---

## 🔍 GitHub Repository Settings

### Recommended Settings:

1. **General**:
   - ✅ Allow merge commits
   - ✅ Allow squash merging
   - ✅ Automatically delete head branches

2. **Branches**:
   - Add branch protection rule for `main`:
     - ✅ Require pull request reviews
     - ✅ Require status checks to pass
     - ✅ Require branches to be up to date

3. **Security**:
   - ✅ Enable Dependabot alerts
   - ✅ Enable secret scanning

---

## 🆘 Troubleshooting

### "Permission denied" error:
```bash
# Use HTTPS instead of SSH
git remote set-url origin https://github.com/YOUR_USERNAME/radar.git
```

### "Authentication failed":
1. Generate Personal Access Token:
   - GitHub Settings → Developer settings → Personal access tokens
   - Generate new token (classic)
   - Select scopes: `repo`
2. Use token as password when prompted

### "Large files" error:
```bash
# Remove large files from history
git rm --cached large-file.zip
git commit -m "Remove large file"
```

---

## 📞 Need Help?

- **GitHub Docs**: [https://docs.github.com](https://docs.github.com)
- **Git Basics**: [https://git-scm.com/doc](https://git-scm.com/doc)
- **Email**: hello@tuku-tuku.com

---

## ✅ Next Steps

After pushing to GitHub:

1. ✅ Set up Vercel deployment (connect GitHub repo)
2. ✅ Configure environment variables in Vercel
3. ✅ Set up Supabase database
4. ✅ Add collaborators
5. ✅ Enable GitHub Actions
6. ✅ Set up project board for task tracking

---

**Your repository is ready to deploy! 🚀**
