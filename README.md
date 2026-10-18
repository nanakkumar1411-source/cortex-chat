# Cortex

A smart AI assistant website that runs on free tiers: **Google Gemini 3.8 Flash** for answers, **Supabase** for accounts, and **Vercel** for hosting.

## What it does

- **Accounts:** email sign-up with a verification email, **Continue with Google**, and password reset. Chats are saved to each account and sync across devices.
- **Daily limits:** each person gets 100 messages a day and admins get 1,000. Limits reset at midnight Eastern time. You can change all of these.
- **Smart model use:** Gemini 3.8 Flash first. A reserve of it is kept for admins. Free backups (Flash-Lite, then Groq's GPT-OSS 120B and Qwen) take over automatically when a model runs out.
- **Six modes:** Casual, Research, Fun, Creative, Code and Tutor.
- **You choose the sources:** Google Search, Academic & journals, Government & official, Trusted news, Reference & docs. **Research mode uses credible sources only.**
- **Every answer ends with "Sources used":** each website with a type badge, your files, and the searches that were run.
- **Neurons:** small checkers that review answers on their own:
  - **Fact** verifies the key facts with Google Search.
  - **Logic** re-runs math and code.
  - **Coverage** makes sure every part of the question was answered.
  - If a neuron finds a mistake, Cortex **rewrites the answer with the fix automatically**, and you can still view the original.
- **Files and voice:** images, PDFs, text and code files (click, drag and drop, or paste), plus voice input. Also edit, regenerate, stop, light and dark themes, and a phone layout.
- **Keys stay on the server.** Your API keys never reach the browser.

---

## Setup (about 30 minutes, all free)

You'll create five free accounts: Google AI Studio, Groq (optional), Supabase, GitHub and Vercel. Keep a notes file open to paste keys into as you go.

### 1. Gemini API key (required)
1. Go to <https://aistudio.google.com/apikey> and sign in with Google.
2. Click **Create API key** and copy it. → **`GEMINI_API_KEY`**

### 2. Groq API key (optional, adds free backup models)
1. Go to <https://console.groq.com/keys> and sign up. You don't need a card.
2. Click **Create API Key** and copy it. → **`GROQ_API_KEY`**

### 3. Supabase (accounts, saved chats, limits)
1. Go to <https://supabase.com>, sign up, and click **New project**. Pick any name and password, and the region closest to you (East US).
2. When it's ready, open **SQL Editor → New query**, paste everything from **`supabase/setup.sql`**, and click **Run**. You should see "Success".
3. Open **Project Settings → API Keys** (or **Settings → API** on older dashboards) and copy:
   - **Project URL** (looks like `https://abcd1234.supabase.co`) → **`SUPABASE_URL`**
   - **anon / publishable** key → **`SUPABASE_ANON_KEY`**
   - **service_role / secret** key → **`SUPABASE_SERVICE_ROLE_KEY`**. ⚠️ Keep this one secret and never put it in the code.
4. Open **Authentication → Sign In / Providers → Email**. Make sure **Email** is enabled and **Confirm email** is on, so people must verify their address.

### 4. Google sign-in
1. Go to <https://console.cloud.google.com>, create a project (for example "Cortex"), and open **APIs & Services → OAuth consent screen**. Choose **External**, fill in the app name (Cortex) and your email, then save.
2. Go to **APIs & Services → Credentials → Create credentials → OAuth client ID**.
   - Application type: **Web application**
   - **Authorized redirect URIs:** add `https://YOUR-PROJECT.supabase.co/auth/v1/callback`, using your Supabase Project URL from step 3.
3. Copy the **Client ID** and **Client secret**.
4. In Supabase, open **Authentication → Sign In / Providers → Google**, turn it on, paste both values, and save.

### 5. Put the code on GitHub
1. On <https://github.com>, click **New repository** and name it `cortex-chat`.
2. Click **uploading an existing file** and drag in **all** the files and folders: `index.html`, `package.json`, `README.md`, `.gitignore`, and the `api`, `lib` and `supabase` folders. Keep the folders as folders.
3. Click **Commit changes**.

### 6. Deploy on Vercel
1. Go to <https://vercel.com/new>, sign in with GitHub, pick `cortex-chat`, and click **Import**.
2. Leave **Framework Preset** as **Other**. There is no build step.
3. Open **Environment Variables** and add:

   | Name | Value |
   |---|---|
   | `GEMINI_API_KEY` | from step 1 |
   | `GROQ_API_KEY` | from step 2 (optional) |
   | `SUPABASE_URL` | from step 3 |
   | `SUPABASE_ANON_KEY` | from step 3 |
   | `SUPABASE_SERVICE_ROLE_KEY` | from step 3 |
   | `ADMIN_EMAILS` | `nanak.kumar1411@gmail.com:1000` |
   | `DAILY_LIMIT` | `100` |

4. Click **Deploy**. You'll get a web address like `https://cortex-chat-xyz.vercel.app`.

### 7. Connect the web address to Supabase (important)
In Supabase, open **Authentication → URL Configuration**:
- **Site URL:** your Vercel address, for example `https://cortex-chat-xyz.vercel.app`
- **Redirect URLs:** add `https://cortex-chat-xyz.vercel.app/**`

Without this step, verification emails and Google sign-in send people to the wrong place.

**Done.** Open your site, create an account with nanak.kumar1411@gmail.com, and you'll see "0 of 1000 today · admin" in the bottom-left corner.

---

## Settings you can change (Vercel → Settings → Environment Variables, then Redeploy)

| Variable | Default | What it does |
|---|---|---|
| `DAILY_LIMIT` | `100` | Messages per person per day |
| `ADMIN_EMAILS` | none | Comma-separated `email:limit` pairs, e.g. `a@x.com:1000, b@y.com:300`. Admins can also use the reserved Gemini share. |
| `CAP_FLASH` / `RESERVE_FLASH` | `1500` / `1000` | Site-wide daily Gemini 3.8 Flash uses, and how many are kept for admins |
| `CAP_LITE` / `RESERVE_LITE` | `1500` / `500` | Same for Flash-Lite |
| `CAP_GROQ_1` / `CAP_GROQ_2` | `1000` | Daily uses for the Groq backups |
| `MODEL_FLASH`, `MODEL_LITE`, `MODEL_GROQ_1`, `MODEL_GROQ_2` | built in | Swap in a different model ID when newer ones come out |
| `ACCESS_CODE` | none | Only used if you skip Supabase: a shared password for the whole site |

The caps should roughly match your real free limits. Check them at <https://aistudio.google.com> (Rate limits) and <https://console.groq.com/settings/limits>.

## Good to know

- **Verification emails:** Supabase's built-in email sender is for testing and only sends a few emails per hour. Before sharing the site widely, connect a free email service under **Authentication → Emails → SMTP Settings**. [Resend](https://resend.com) is free for 3,000 emails a month.
- **Free Supabase projects pause after a week with no activity.** Opening the site, or clicking **Restore** in Supabase, wakes them up.
- **What neurons count toward:** neuron checks don't count against anyone's daily message number, but they do use the site's model capacity. By default they run in Research, Code and Tutor modes. Each person can choose Auto, Always or Off in the Mode menu.
- **How "credible sources only" works:** Research mode tells the model to rely only on the chosen source types, steers its searches toward them, and removes every other result from the source list. A model can't be completely blocked from a website, so for anything important, still glance at the linked sources. The credible domain lists are in `lib/sources.js`, where you can edit them.
- **Privacy:** on Gemini's free tier, Google may use prompts to improve its products. Tell users not to paste sensitive information.
- **Uploads:** Vercel accepts requests up to about 4.5 MB. Images are shrunk automatically, and PDFs should be under 2.5 MB. Groq backups can only read text.

## Project layout

```
index.html           the whole interface: sign-in, chat, neurons, sources
api/chat.js          answers: sign-in check, daily limit, model choice and backups, streaming, sources
api/neuron.js        the Fact, Logic and Coverage checkers
api/config.js        tells the page whether sign-in is on and which models exist
api/usage.js         today's usage for the signed-in person
lib/auth.js          Supabase sign-in checks, limits, signed neuron results
lib/llm.js           model list, shared capacity and reserves, Gemini and Groq requests
lib/sources.js       source types and the credible domain lists
supabase/setup.sql   database tables and functions (run once in Supabase)
```
