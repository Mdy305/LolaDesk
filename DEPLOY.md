# Deploy LolaDesk — Git + Vercel

This folder is deploy-ready. No build step. Follow these once and every future change auto-deploys.

## ⚠️ Before you start

You pasted an Anthropic key and a Telnyx key into a chat earlier. **Rotate both now** if you haven't:
- Anthropic: console.anthropic.com → Settings → API Keys → revoke + create new
- Telnyx: portal → Auth → API Keys → regenerate

Never put a real key in the code or the repo. They go in Vercel env vars only (step 3).

---

## 1. Push to GitHub

From inside the `loladesk-app` folder:

```bash
git init
git add .
git commit -m "LolaDesk — AI front desk for salons"
git branch -M main
```

Create an empty repo on github.com (call it `loladesk`), then:

```bash
git remote add origin https://github.com/YOUR_USERNAME/loladesk.git
git push -u origin main
```

> If git asks you to authenticate, use a GitHub personal access token as the password, or run `gh auth login` first with the GitHub CLI.

---

## 2. Deploy to Vercel

**Easiest — through the dashboard:**
1. Go to vercel.com → **Add New → Project**
2. **Import** your `loladesk` GitHub repo
3. Framework preset: **Other** (it's a static site — Vercel detects this automatically)
4. Click **Deploy**

That's it. You get a live URL like `loladesk.vercel.app` in ~30 seconds.

**Or from the terminal:**
```bash
npm i -g vercel
vercel          # links + deploys a preview
vercel --prod   # deploys to production
```

---

## 3. Add your API key (so Lola's brain works)

In Vercel → your project → **Settings → Environment Variables**, add:

| Name | Value | Environments |
|------|-------|--------------|
| `ANTHROPIC_API_KEY` | your **new** sk-ant-… key | Production, Preview, Development |

Then **redeploy** (Deployments → ⋯ → Redeploy) so the function picks it up.

The dashboard already calls `/api/lola`, which reads this env var server-side. The key never touches the browser.

---

## 4. Point your domain (optional)

In Vercel → **Settings → Domains**, add `loladesk.com`. Vercel gives you the DNS records to paste into your domain registrar. SSL is automatic.

---

## What's live after deploy

| URL | Page |
|-----|------|
| `loladesk.com/` | Marketing landing page |
| `loladesk.com/start` | Onboarding wizard |
| `loladesk.com/dashboard` | The dashboard |
| `loladesk.com/api/lola` | AI proxy (serverless function) |

---

## Routine after first setup

Every time you change a file:
```bash
git add .
git commit -m "what changed"
git push
```
Vercel auto-deploys within seconds. Pull requests get their own preview URLs.

---

## Telnyx voice/SMS (when you build it)

The Telnyx webhook handler will live at `/api/telnyx.js` as another serverless function, reading `TELNYX_API_KEY` from the same env var settings. Add that key the same way as step 3 when you're ready to wire up phone calls.
