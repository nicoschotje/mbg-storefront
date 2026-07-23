# The simplified workflow — what to do from now on

## The problem with today's workflow

Current chain, per change:

> Owner describes requirement → ChatGPT writes a brief → owner sends it to dev →
> dev pastes it into Claude → Claude replies → dev copies reply to owner →
> owner pastes reply into ChatGPT for explanation → owner gives GO → Claude executes.

That is **six copy-paste hops and two humans acting as clipboards** before any work
starts. Every hop loses context, adds hours of latency, and the translator (ChatGPT)
explains a Claude answer it didn't produce, about a codebase it cannot see. The dev's
skill is wasted on forwarding text.

## The new workflow — 3 steps instead of 8

**Cut every middleman out of the loop. Talk to Claude Code directly.**

Claude Code sees the real repository, the real database and the real deploys, and can
explain itself in plain language — the ChatGPT translation layer exists only because the
relay made Claude feel far away. It isn't.

1. **Owner describes the requirement to Claude Code in his own words** — plain language,
   like texting the dev. No prompt engineering; Claude asks if something is unclear.
   Where: claude.ai/code (works in the browser and on the phone), on the
   `mbg-storefront` (or `mbg-dashboard`) repository.
2. **Claude replies with a plain-language plan**: what it will change, what it will not
   touch, and how we'll know it worked (the acceptance criteria). Owner reads it — it is
   written for a non-technical reader — and says **GO** or corrects it.
3. **Claude builds, tests, opens the PR and reports back** with evidence (what was run,
   what happened, link to the live result). Merge → auto-deploy → Claude verifies on
   mrbeaniesgreenies.com.

Roles after the change:
- **ChatGPT: out of the build loop.** No more brief-writing, no more explaining Claude's
  answers. (Optional: second opinion on product/business questions — never as relay.)
- **The dev: reviewer, not clipboard.** He reviews PRs and flags concerns — real
  engineering judgement instead of forwarding messages.
- **Owner: decision-maker.** Describes what he wants, approves plans, gives GO, checks
  the live result.

## Rules that keep it safe

- ONE active Claude Code session per repository. Stop the old one before starting a new
  one — cloud sessions keep running server-side when the window closes.
- No GO, no execution: Claude states the plan and acceptance criteria first; building
  starts only after the owner's GO (matches the current "go signal" habit, minus the relay).
- DONE means: deployed, core flows clicked through on the live site, failure paths
  handled, no secrets committed — evidence stated in plain language. "It runs in the
  demo" is not done.

## Why this is strictly better

| | Old relay | Direct |
|---|---|---|
| Hops per change | 8 | 3 |
| Humans copy-pasting | 2 | 0 |
| Context loss | every hop | none — Claude sees repo + DB + deploys |
| Latency to start | hours/days | minutes |
| Dev's role | clipboard | reviewer |
| Single-person dependency | high (dev in every loop) | low (owner can ship alone) |
