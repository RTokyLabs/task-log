# RT Task Log

A personal daily task log with progress tracking. It runs in any browser (MacBook, Windows laptop, Android phone) and keeps your tasks in sync across all of them. It needs no Claude account. Only you can sign in.

**How it's built**

| Part | Service | Cost |
|---|---|---|
| Website (HTML, CSS, JS) | GitHub Pages | Free |
| Database and sign-in | Supabase (Postgres + Auth) | Free tier |

```
task-log/
├── index.html            page structure and sign-in screen
├── app.js                app logic (views, rules, syncing)
├── styles.css            design (light and dark)
├── config.js             ← you paste your Supabase URL and key here
├── manifest.webmanifest  lets phones install it as an app
├── icons/                app icons
└── supabase/schema.sql   database table and security rules (run once)
```

---

## Setup (about 20 minutes, one time only)

### 1. Create the database (Supabase)

1. Go to **supabase.com** and choose **Sign in with GitHub**.
2. Click **New project**.
   - **Name:** `task-log`
   - **Database password:** use a generator and save it in your password manager. The app never uses it.
   - **Region:** **Southeast Asia (Singapore)**, which is closest to Indonesia.
3. Wait about a minute for the project to finish starting.
4. Open **SQL Editor** in the left sidebar, then **New query**. Paste the whole of `supabase/schema.sql` and click **Run**. You should see "Success. No rows returned".

### 2. Create your login and lock out everyone else

1. Go to **Authentication → Users → Add user → Create new user**.
2. Enter your email and a strong password, and tick **Auto Confirm User**.
3. Go to **Authentication → Sign In / Providers** (on some versions this is under **Settings**). Turn **off** "Allow new users to sign up" and save.
   This step matters. Without it, a stranger who finds your site could create their own account. They still couldn't see your tasks, but they could use up your free quota.

### 3. Connect the app to the database

1. Go to **Project Settings → API Keys**, or use the **Connect** button at the top of the dashboard.
2. Copy the **Project URL** (for example `https://abcd1234.supabase.co`).
3. Copy the **anon / publishable** key, which is the public one.
4. Open `config.js` and paste both values between the quotes.

> ⚠️ Never use the **service_role / secret** key. That key skips all the security rules. The anon key is safe to make public because the database only answers to you once you're signed in.

### 4. Put the website online (GitHub Pages)

1. On github.com, click **New repository**.
   - **Name:** `task-log`
   - **Visibility:** **Public**. Free GitHub accounts can only publish public repositories to Pages. Your *tasks* stay private. Only the app's code is visible.
2. Click **uploading an existing file** and drag in **everything inside this folder**: `index.html`, `app.js`, `styles.css`, `config.js`, `manifest.webmanifest`, the `icons` folder, and the `.nojekyll` file.
   The `supabase` folder and this README are optional.
   On a Mac, press **⌘ + Shift + .** in Finder to show the hidden `.nojekyll` file.
3. Click **Commit changes**.
4. Go to **Settings → Pages**. Under **Build and deployment**, choose **Deploy from a branch**, then **main** and **/ (root)**, and click **Save**.
5. After 1–2 minutes your app is live at:
   **`https://<your-github-username>.github.io/task-log/`**

### 5. Open it on each device

Open the link and sign in once on each device. You stay signed in after that.

| Device | Make it one tap away |
|---|---|
| **Android (Chrome)** | ⋮ menu → **Add to Home screen** (or **Install app**). It opens full-screen like a normal app. |
| **MacBook (Safari)** | **File → Add to Dock**. In Chrome, use ⋮ → **Cast, save, and share → Install page as app**. |
| **Windows (Chrome or Edge)** | Edge: **⋯ → Apps → Install this site as an app**. Chrome: **⋮ → Cast, save, and share → Install page as app**. |

---

## Day-to-day use

- **Add a task:** type in the box at the top and press Enter. It goes on the day you're viewing.
- **Change status:** click the circle. It goes To do → In progress → Done.
- **Track progress:** drag the slider. Moving it above 0% starts the task, and 100% marks it Done.
- **Edit details:** click a task's name to change notes, due date, priority, category, the day it's logged for, or Blocked status. You can delete from here too, with a confirmation step.
- **Carry-over:** unfinished tasks from earlier days appear under **Carried over** on today's view.
- **Open tasks tab:** shows everything unfinished, grouped as Overdue, Due this week and Later, plus a 14-day completion chart.
- **Syncing:** each change saves immediately. Other devices pick it up when you switch back to them, or within a minute. The "Synced hh:mm" line at the bottom shows the last successful save.

## Things to know

- **You need to be online.** If you lose the connection, the app says so and the change is not saved. When you're back online it reloads the list from the database.
- **Supabase free tier:** Supabase pauses free projects after a period with no activity (currently about a week). Using the app regularly keeps it active. If it does pause, sign in at supabase.com and click **Restore project**. Your data is kept.
- **Backups:** the free tier has no downloadable backups. Every so often, open **Table Editor → tasks → Export → CSV** in Supabase to keep a copy.
- **Forgot your password:** reset it in Supabase under **Authentication → Users → … → Reset password**, or delete the user and create it again. Tasks belong to the user ID, so recreating the user disconnects you from your old tasks.

## Making changes later

Edit a file on GitHub (open it and click the pencil icon), then commit. GitHub Pages republishes within about a minute.

## Security summary

- **Sign-in:** email and password through Supabase Auth, with new sign-ups switched off.
- **Data access:** Postgres Row Level Security lets each signed-in user read and write only their own rows. Signed-out requests are refused, even with the public key.
- **Data rules:** the database itself checks that titles aren't blank, sets length limits, allows only valid status and priority values, keeps progress between 0 and 100, and enforces that a task is Done exactly when its progress is 100%.
- **Browser protections:** a Content-Security-Policy limits the page to scripts from itself and jsDelivr. The Supabase library is pinned to version 2.80.0 with an integrity hash, so a tampered copy won't load. Task text is always escaped before it's shown.

## What was tested

- **Database:** the schema runs (and re-runs safely) on Postgres 16 with a stand-in for Supabase's auth. Tests confirmed per-user isolation, blocked access for signed-out requests, rejection of attempts to write rows for another user, and the Done ⇔ 100% rule.
- **App:** 24 browser tests ran against a mock backend. They covered setup and sign-in screens, the wrong-password message, adding, status cycling, progress-to-Done, editing, delete confirmation, carry-over, the Open tasks view, a failed-save message with reload, HTML escaping, phone-width layout and sign-out.
- **Integrity hash:** the real supabase-js 2.80.0 file was loaded and passed the integrity check.
- **Not tested:** a live Supabase project. Run through setup steps 1–4 and add one task as a final check.
