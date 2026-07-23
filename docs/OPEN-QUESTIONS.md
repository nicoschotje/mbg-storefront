# Open questions — owner/dev input needed to finish the handover

Everything below cannot be read remotely and was deliberately **not guessed**.
Answer inline (edit this file) or hand the answers to Claude Code to fold into
`docs/HANDOVER.md`. Estimated total effort: ~30 minutes at the iMac.
Numbers refer to the matching HANDOVER.md sections.

## §1 Hardware (2 min)
- [ ] On the iMac, run in Terminal and paste the output here:
  `sw_vers && uname -m && sysctl -n hw.memsize machdep.cpu.brand_string && df -h / && echo $SHELL`

## §2 Installed applications (5 min)
- [ ] Which editors/tools are actually used? (Cursor / VS Code / GitHub Desktop /
      Claude Code CLI / other) and are any settings in them non-default?
- [ ] Paste output of: `brew list --versions | sort` and `node --version && git --version`

## §3 Browser (5 min)
- [ ] Which browser + profile is used for development?
- [ ] Extensions that matter for the work (if any)?
- [ ] Bookmarks/pinned tabs that are part of the daily routine?

## §4 MCP servers on the iMac (3 min)
- [ ] Run `claude mcp list` on the iMac (in a project folder and in home) and paste output.

## §5 Claude account (5 min)
- [ ] List claude.ai Projects in use + copy each project's custom instructions.
- [ ] Where is the werkwijze skill backed up outside the Claude environment?
      (If nowhere: say so, and it will be committed to a private repo.)

## §6 ChatGPT account (only if ChatGPT stays in use) (5 min)
- [ ] Custom instructions / memories / projects worth keeping? Connected apps?

## §7 GitHub (2 min)
- [ ] Which email owns `nicoschotje`? 2FA method? Where are the recovery codes?
- [ ] Does the dev have his own collaborator account (yes/no)?

## §8 Supabase (3 min)
- [ ] Which email owns the Supabase organization? 2FA + recovery codes location?
- [ ] Plan level, and is Point-in-Time Recovery / daily backup enabled on
      `mrbeanies-prod`? (Dashboard → Project Settings → Database → Backups — paste what it says.)
- [ ] Any secrets set under Edge Functions → Secrets besides the auto-injected ones?
- [ ] Which Telegram account (BotFather) owns the MBG bot?

## §9 Netlify + domain (3 min)
- [ ] Which email owns the Netlify team? 2FA + recovery codes location?
- [ ] Where is `mrbeaniesgreenies.com` registered (registrar + owning account)?
      Auto-renew on? Card on file valid?
- [ ] Custom domain on the dashboard site (`mbg-dashboard-prod`) — which URL do you use?

## §12 Security (2 min)
- [ ] Which password manager is in use, and does a second trusted person have
      emergency access to it?
- [ ] Confirm recovery codes for GitHub / Supabase / Netlify / Anthropic / registrar
      are stored in it (tick each).

## Known gaps already identified (no question — just decisions to schedule)
- 🔴 11 of 14 deployed Supabase edge functions have no source in git → schedule a
  "pull edge functions into repo" pass (HANDOVER §8).
- ⚠️ Werkwijze skill exists only inside the Claude environment → commit to a private repo.
- ⚠️ Database backups unverified → check PITR/backup setting (§8 above) before relying on it.
