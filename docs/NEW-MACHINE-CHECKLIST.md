# New MacBook → productive on MBG — click-level checklist

Goal: from a brand-new MacBook to "I made a change, tests passed, it's live on
mrbeaniesgreenies.com" without asking anyone anything. Time: ± one afternoon.

Prerequisite: access to the password manager holding the account logins (see
`docs/OPEN-QUESTIONS.md` §12 — this is the one thing a new machine cannot bootstrap itself).

## A. Base tools (Terminal)

- [ ] Open **Terminal** (Cmd+Space → "Terminal").
- [ ] Install Apple's command-line tools (includes Git): `xcode-select --install` → click Install.
- [ ] Install Homebrew: paste the one-line installer from https://brew.sh and follow the prompts
      (on Apple Silicon it ends with two `eval` lines to paste — do that).
- [ ] Install Node.js: `brew install node`
- [ ] Verify: `git --version` and `node --version` → Node must be **22.7 or higher**.

## B. Accounts (browser)

Log in — from the password manager, never by memory — to:

- [ ] github.com (account `nicoschotje`, or your own collaborator account) — complete 2FA.
- [ ] app.netlify.com — confirm you can see site **mbg-storefront-prod**.
- [ ] supabase.com/dashboard — confirm you can see project **mrbeanies-prod**.
- [ ] claude.ai — the account that carries the Claude Code sessions and the werkwijze.
- [ ] Authenticate git to GitHub: `brew install gh && gh auth login` → GitHub.com → HTTPS →
      Login with a web browser → follow the code. (Alternative: GitHub Desktop.)

## C. The code

- [ ] `mkdir -p ~/dev && cd ~/dev`
- [ ] `git clone https://github.com/nicoschotje/mbg-storefront.git`
- [ ] `git clone https://github.com/nicoschotje/mbg-dashboard.git`
- [ ] Verify: `cd mbg-storefront && git log --oneline -3` shows recent commits.

## D. Prove the environment works (no changes yet)

- [ ] Run the unit tests: `node --import ./test/register.mjs ./test/run-tests.mjs`
      → must end with all ✓ and no error.
- [ ] Run the site locally: `python3 -m http.server 8000` → open
      http://localhost:8000 → the storefront renders and products load (it talks to the
      real prod Supabase via the committed anon key; read-only browsing is safe).
- [ ] Staging check: open http://localhost:8000/?env=staging → still renders (now
      against `mrbeanies-staging`).

## E. Prove you can ship (end-to-end dry run)

- [ ] `git checkout -b test/new-machine-<yourname>`
- [ ] Make a trivial safe change (e.g. add a line to this checklist file).
- [ ] `git add -A && git commit -m "test: new machine dry run" && git push -u origin HEAD`
- [ ] On github.com open the pull request → wait for the **CI check to go green**.
- [ ] Merge the PR → open https://app.netlify.com → mbg-storefront-prod → Deploys →
      watch the deploy finish (~30 s).
- [ ] Open https://mrbeaniesgreenies.com — hard refresh (Cmd+Shift+R) — site is up.
- [ ] Netlify → Deploys: confirm you can see the **"Publish deploy"** button on the
      previous deploy — that is the rollback. Don't click it; just know where it is.

## F. AI tooling

- [ ] Claude Code: either use the cloud version at claude.ai/code (nothing to install) or
      install the CLI: `npm install -g @anthropic-ai/claude-code` → run `claude` in the
      repo folder → log in.
- [ ] Confirm the **werkwijze** rules are active (ask Claude: "what is our werkwijze?").
      If not: restore the skill from its backup location (see OPEN-QUESTIONS §5).
- [ ] Rule that prevents chaos: **ONE active Claude Code session per repository.** Stop
      the old session before starting a new one (cloud sessions keep running when the
      window closes).

## G. Done-criteria for this checklist

- [ ] Tests pass locally.
- [ ] A PR went from branch → green CI → merge → live production deploy → verified in
      the browser.
- [ ] You know where rollback lives in Netlify.
- [ ] Claude Code answers with the werkwijze rules.

If every box is ticked, the new machine is a full replacement. Nothing else from the old
iMac is required to develop and ship MBG.
