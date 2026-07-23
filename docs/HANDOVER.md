# MBG — Technical Handover & Environment Replication

**Date:** 2026-07-23 · **Prepared from:** live inspection of the `mbg-storefront` repository, the Supabase organization, the Netlify team, and the GitHub account `nicoschotje`.

**Legend:**
- ✅ **VERIFIED** — read directly from the live system while writing this document.
- ⚠️ **OWNER INPUT NEEDED** — exists only on the iMac or inside a personal account; cannot be read remotely. Listed in `docs/OPEN-QUESTIONS.md`.

---

## 0. The most important finding — read this first

**The iMac is not the single point of failure. The accounts are.**

This project has almost no local footprint. There is no build step, no local database, no
local secrets file. Everything that matters lives in cloud services:

| What | Where it lives | Machine-dependent? |
|---|---|---|
| Source code | GitHub `nicoschotje/mbg-storefront` + `mbg-dashboard` | No |
| Hosting + deploys | Netlify (auto-deploy from `main`) | No |
| Database, auth, edge functions | Supabase `mrbeanies-prod` | No |
| CI (tests + syntax checks) | GitHub Actions | No |
| AI coding sessions | Claude Code (cloud sessions) | No |
| Domain | `mrbeaniesgreenies.com` registrar ⚠️ | No |

A stolen or dead iMac costs at most one afternoon of reinstalling tools. A lost **account**
(GitHub, Supabase, Netlify, domain registrar, Telegram bot, Anthropic) is the real disaster.
Section 12/13 therefore focus on account recovery, not machine recovery.

---

## 1. Hardware / workstation

⚠️ **OWNER INPUT NEEDED** — the iMac's specs cannot be read remotely. Run this one command
on the iMac and paste the output into this section:

```bash
sw_vers && uname -m && sysctl -n hw.memsize machdep.cpu.brand_string && df -h / && echo $SHELL
```

**What actually matters for replication (verified from the project itself):**
- Any Mac (Apple Silicon or Intel) works. The project is a static site; there is no
  native compilation, no Docker requirement, no RAM-heavy tooling.
- Minimum toolchain: a browser, Git, and Node.js ≥ 22.7 (only for running tests — the
  site itself needs no Node at all). ✅ VERIFIED from `.github/workflows/ci.yml`.

---

## 2. Installed applications

Only three tools are **required** to develop this project. Everything else on the iMac is
convenience.

| Tool | Purpose | Install on a new Mac | Version | Login needed |
|---|---|---|---|---|
| **Git** | version control | ships with Xcode CLT: `xcode-select --install` | any recent | GitHub auth (see §7) |
| **Node.js** | run the unit tests locally | `brew install node` (or nodejs.org LTS) | **≥ 22.7** ✅ (CI pins 22; ES-module detection in `.js` files requires ≥ 22.7) | no |
| **Homebrew** | installs the above | script at brew.sh | latest | no |

**Explicitly NOT required** (verified — no trace in the repo or deploy pipeline):
package manager lockfiles (there is no `package.json`), pnpm, Bun, Docker, Python,
PostgreSQL client tools, Supabase CLI, Netlify CLI. Deploys happen via git push, not CLI.

**Optional but used in practice** ⚠️ OWNER INPUT NEEDED to confirm which of these are
actually installed/used on the iMac and with which accounts: Cursor, VS Code, Claude
Code CLI, GitHub Desktop, ChatGPT desktop app.

---

## 3. Browser setup

⚠️ **OWNER INPUT NEEDED** entirely — browser profiles, extensions, bookmarks and pinned
tabs exist only on the iMac. See `docs/OPEN-QUESTIONS.md` §3.

**What a replacement machine minimally needs (derived from the workflow):**
- Logged-in tabs: github.com, app.netlify.com, supabase.com/dashboard, claude.ai, chatgpt.com.
- The storefront is tested against real mobile viewports: use browser dev-tools device
  emulation (it is a mobile-first PWA that also runs inside Telegram).
- Staging is reached by URL parameter, not a separate build: `?env=staging` on any
  storefront URL points the app at the staging Supabase project. ✅ VERIFIED in `js/core/config.js`.

---

## 4. MCP servers

⚠️ **OWNER INPUT NEEDED for the iMac's local config.** MCP configuration is per-machine
(`~/.claude.json` / project `.mcp.json`) and per claude.ai workspace. Nothing in this repo
configures any MCP server, so the iMac's list must be exported by hand:
on the iMac run `claude mcp list` and paste the output into `docs/OPEN-QUESTIONS.md`.

**Verified from this cloud session** (these are connected to the Claude account today and
are the ones that matter for this project): GitHub, Supabase, Netlify. Each authenticates
by OAuth login to the respective account — no tokens to copy between machines; on a new
machine you re-run the OAuth flow, you do not migrate secrets.

---

## 5. Claude configuration

- **Werkwijze skill** ✅ VERIFIED: a `werkwijze` skill (Mr. BeaNico's standing rules —
  role, communication, prioritization, engineering standards, phase plan) is installed in
  the Claude Code environment (`~/.claude/skills/werkwijze/`). This is the behavioural
  contract every session runs under. **Action:** its content should be committed to a
  private repo so it survives account/machine changes — today it lives only in the
  Claude environment. ⚠️
- **Claude.ai projects / memory / artifacts:** ⚠️ OWNER INPUT NEEDED — these live in the
  claude.ai account, are not exportable via API from here, and must be inventoried by
  hand (open claude.ai → Projects → screenshot/copy each project's instructions).
- **Standing session rule** ✅ (from werkwijze): ONE active Claude Code session per
  repository, always. Cloud sessions keep running server-side when the window closes —
  stop the old session before starting a new one.

## 6. ChatGPT configuration

⚠️ **OWNER INPUT NEEDED** entirely (projects, memories, custom instructions, connected
apps). Note: under the simplified workflow in `docs/WORKFLOW-SIMPLIFIED.md`, ChatGPT is
removed from the build loop, so this inventory is low priority — document it only if
ChatGPT remains in use for non-build tasks.

---

## 7. GitHub

**Account:** `nicoschotje` ✅ VERIFIED.

**The two repos that make up MBG** ✅ VERIFIED:

| Repo | Purpose | Deploys to |
|---|---|---|
| `mbg-storefront` (public) | customer-facing PWA (this repo) | Netlify `mbg-storefront-prod` → **mrbeaniesgreenies.com** |
| `mbg-dashboard` (public) | owner/admin dashboard | Netlify `mbg-dashboard-prod` |

Both target the same Supabase backend (`mrbeanies-prod`). Legacy/experimental MBG repos
also exist (`mbg-os`, `mbg-os-demo`, `mbg-supabase`, `mrbeanie-greenies`, `mbg-test-control`,
`mbg-network-demo`, …) — they are NOT part of the production system.

**This repo, verified:**
- Default branch `main`; feature branches → PR → merge → auto-deploy.
- **CI** (`.github/workflows/ci.yml`): on every push/PR, GitHub Actions syntax-checks all
  JS with Node 22 and runs the unit tests (`node --import ./test/register.mjs ./test/run-tests.mjs`).
- **No GitHub secrets, no environment variables in Actions** — CI needs none. ✅
- Repo is **public**; the committed Supabase anon keys in `js/core/config.js` are public
  by design (access is enforced by Row-Level Security, see §8/§12).

⚠️ OWNER INPUT NEEDED: GitHub account 2FA method + recovery codes location; whether the
dev has collaborator access under his own account or shares credentials (must be the former).

---

## 8. Supabase

**Organization** ✅ VERIFIED: slug `qkghibzzknbdzgqbhfty`, 13 projects, of which MBG uses:

| Project | Ref | Region | Status | Role |
|---|---|---|---|---|
| **mrbeanies-prod** | `ihnnipynpdtcbdfbpemq` | ap-northeast-1 | ACTIVE | production backend for storefront + dashboard |
| **mrbeanies-staging** | `oyyaivofnjltrnnnszrf` | ap-northeast-1 | ACTIVE | staging; storefront reaches it via `?env=staging` |

(Other active projects — `rpms-prod`, `rpms-jen` — belong to a different product line.)

**Production database** ✅ VERIFIED (2026-07-23):
- Postgres 17 · **77 tables in `public`, RLS enabled on every single one.**
- **121 named migrations** applied via the Supabase migration system (from
  `p1_01_extensions_sequence_utils` 2026-05-15 through `report_refresh_automation`
  2026-07-23). The migration history in Supabase **is the source of truth for schema**.
- The repo's `db/*.sql` files are point-in-time working scripts, not the full schema.
- Architecture highlights (from live table comments): append-only WORM financial ledger
  (`ledger_entries`, integer centavos, corrections as reversal rows), nightly
  self-audit (`reconcile_runs`), health watchdog with Telegram alerting (`health_runs`,
  `health_alerts`, `health_config`), agent/commission system, and the Phase-3
  multi-operator branch network (operators, settlements, payables, routing audit).

**Edge functions** ✅ VERIFIED — 14 deployed and ACTIVE on prod:
`place-order`, `verify-payment` (JWT-verified), `delivery-quote`, `crypto-rate`,
`update-order`, `notify-customer`, `upload-receipt`, `upload-product-image`,
`upload-qr-image`, `telegram-webhook`, `setup-telegram-webhook`,
`telegram-intelligence-alerts`, `compute-client-intelligence`, `import-sheets-data`.

> 🔴 **Resilience gap (verified):** only **3** of the 14 edge functions have source in
> this repo (`supabase/functions/place-order|verify-payment|crypto-rate`). The other 11
> exist only as deployed code in Supabase. If one is broken or must be redeployed, its
> source must first be recovered (Supabase dashboard → Edge Functions → view source, or
> check `mbg-dashboard`). **Recommendation:** pull all 14 into git in a dedicated pass.

**Secrets** ✅ VERIFIED design:
- Anon keys: committed on purpose; safe because of RLS.
- `service_role` key: exists in the Supabase dashboard (Settings → API). **Never in git,
  never in prompts.** Edge functions get it injected automatically by Supabase.
- Telegram bot token + chat id: stored **in the database** (`health_config` table,
  service-role-only, deliberately unseeded in git) — populated manually post-deploy.
- ⚠️ OWNER INPUT NEEDED: which email owns the Supabase org; Telegram bot's BotFather
  account; whether any other function secrets are set (Dashboard → Edge Functions → Secrets).

**Migration workflow** (as practiced): schema changes are applied through the Supabase
migration system by Claude (MCP `apply_migration`) or the SQL editor, phase-planned and
named. Local Supabase CLI development is **not** part of the current workflow.

---

## 9. Netlify

**Team** ✅ VERIFIED: 66 sites on the account. The two production sites:

| Site | ID | Domain | Repo |
|---|---|---|---|
| **mbg-storefront-prod** | `06f194dc-49bb-4a1f-aa71-a747255101a8` | **https://mrbeaniesgreenies.com** | this repo, branch `main` |
| **mbg-dashboard-prod** | `8fe332e0-4966-4911-8313-0ced2e8c6911` | ⚠️ confirm | `mbg-dashboard` |

**Storefront deploy config** ✅ VERIFIED:
- Build command: **none**. Publish directory: `.` (repo root as-is). Deploy = git push to
  `main`; live in ~30 s.
- **Zero Netlify environment variables** for this site — everything is in the repo.
- All headers/caching/CSP/redirects live in `netlify.toml` (SPA redirect to
  `/index.html`; `no-cache` on JS/CSS/HTML/service-worker so cache-version bumps reach
  customers; strict CSP allowing Supabase, Telegram, CoinGecko, OpenStreetMap).
- No Netlify Functions, no forms, no scheduled jobs on this site. Password protection: off.
- ⚠️ OWNER INPUT NEEDED: where `mrbeaniesgreenies.com` is registered (registrar login is
  a single point of failure — if DNS is lost, the store is offline regardless of Netlify).

---

## 10. Local development workflow

✅ VERIFIED against repo reality:

1. **Get the code:** `git clone https://github.com/nicoschotje/mbg-storefront.git`
2. **Run locally:** any static server from the repo root, e.g. `python3 -m http.server 8000`
   or `npx serve .` → open `http://localhost:8000`. Add `?env=staging` to hit staging data.
3. **Branch:** `git checkout -b fix/<topic>` — never commit straight to `main`.
4. **Test:** `node --import ./test/register.mjs ./test/run-tests.mjs`
   (exercises real cart/address/orders/delivery/USDT-pricing logic under Node).
5. **Syntax check** (same as CI): `node --check <file>` per JS file.
6. **Ship:** push branch → open PR → CI must be green → merge to `main` → Netlify
   auto-deploys → **verify on https://mrbeaniesgreenies.com** (hard-refresh; the
   service worker cache version must have bumped if JS changed — `CACHE_VERSION` in
   `service-worker.js`).
7. **Rollback:** Netlify dashboard → Deploys → pick previous deploy → "Publish deploy"
   (instant), then fix forward in git.

**No linter and no type checker are configured** (vanilla JS, no build). CI = syntax
check + unit tests. That is the whole quality gate; anything more is done by review.

---

## 11. AI workflow

The **current** multi-hop workflow (owner → ChatGPT → dev → Claude → back) and its
replacement are documented in **`docs/WORKFLOW-SIMPLIFIED.md`** — that file is the
instruction to follow from now on. Summary of the target state:

- **Claude Code (cloud)** is the only build tool: it reads/writes the repo, runs tests,
  applies Supabase migrations via MCP, opens PRs, and explains itself in plain language.
- **Claude chat** is for decisions, reviews and direction; heavy build work goes to
  Claude Code (werkwijze rule).
- **ChatGPT** is removed from the build loop (no more prompt-relay); optional for
  second-opinion product thinking only.
- Model choice (per werkwijze, verified 2026-07-04): Opus 4.8 for routine coding/debugging;
  Fable 5 for long multi-step autonomous work with full context up front.
- Engineering standards, definition of DONE, and verification duties are defined in the
  werkwijze and apply to every AI session.

---

## 12. Security

✅ VERIFIED posture:
- **RLS on all 77 production tables**; money paths are SECURITY DEFINER RPCs; the ledger
  and audit tables are WORM (update/delete blocked by triggers).
- Public repo contains **only** public-by-design values (anon keys). No service keys,
  no bot tokens, no private keys in git history spot-checks.
- CSP, HSTS, frame-ancestors and permissions policy are enforced at the edge via
  `netlify.toml`.
- A tracked security backlog exists: `DEFECTS.md` (this repo) — triaged, not auto-applied.

**Never commit:** `service_role` keys, Telegram bot tokens, session tokens, customer PII,
receipts. Secrets live in: Supabase dashboard (service keys, function secrets) and the
`health_config` DB row (Telegram) — nowhere else.

⚠️ OWNER INPUT NEEDED (see OPEN-QUESTIONS): password manager in use, 2FA methods and
recovery-code storage for GitHub/Supabase/Netlify/Anthropic/registrar/Telegram, and a
key-rotation owner. **Recommendation:** one password manager (e.g. 1Password) holding
all account logins + recovery codes + the service-role key, shared with exactly one
trusted second person. That single step removes most of the single-person dependency.

---

## 13. Backup & disaster recovery

| Loss | Recovery | Verified? |
|---|---|---|
| **iMac lost/broken** | New Mac → follow `docs/NEW-MACHINE-CHECKLIST.md` (≈ 1 afternoon). Nothing unique is on the machine. | ✅ (nothing machine-bound found) |
| **Corrupted local clone** | Delete folder, re-clone. `main` on GitHub is truth. | ✅ |
| **Deleted repo** | GitHub soft-deletes ≤ 90 days (Settings → Deleted repositories). Also: every dev clone is a full copy. ⚠️ Consider a second remote/mirror for belt-and-braces. | partially |
| **Broken deploy** | Netlify → publish previous deploy (instant rollback). | ✅ mechanism exists |
| **Database disaster** | Supabase daily backups on paid plans ⚠️ confirm plan/PITR in dashboard (Settings → Database → Backups). Schema is replayable from the 121 migrations; **data** is not — backups are the only data safety net. | ⚠️ must verify |
| **Expired/lost tokens** | All integrations are OAuth re-logins (GitHub/Netlify/Supabase/Claude). Telegram: re-issue via BotFather, update `health_config` row + re-run `setup-telegram-webhook`. | ✅ design |
| **Lost account access** | Only survivable if 2FA recovery codes are stored outside the iMac. ⚠️ TOP PRIORITY: verify recovery codes for all five core accounts exist in a password manager. | ⚠️ must verify |

---

## 14. Reproducibility checklist

See **`docs/NEW-MACHINE-CHECKLIST.md`** — a click-level, zero-assumed-knowledge list from
unboxing a MacBook to a verified production deploy.

## 15. Open questions

Everything marked ⚠️ above is consolidated in **`docs/OPEN-QUESTIONS.md`** with the exact
command or click-path to answer each one. Until those are answered, this handover is
~80% complete: the entire cloud/production side is verified; the iMac-local and
account-credential side needs the owner's 30 minutes.
