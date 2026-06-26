# MBG — Tracked Defects / Security Backlog

Triaged backlog for deliberate, reviewed passes (NOT auto-applied). Seeded
2026-06-26 from the Phase 0 anon-exec security triage + the Supabase advisors.

Status legend: 🔴 open · 🟡 partial / mitigated · ✅ done

---

## P0 — Phase 0 anon-exec triage

### ✅ D-01 — Destructive/admin functions reachable by public anon role
Applied 2026-06-26 (migrations `phase0_anon_exec_security_triage`,
`phase0_anon_exec_revoke_public`; recorded in `db/2026-06-26-phase0-anon-exec-triage.sql`).
Revoked anon+authenticated+PUBLIC EXECUTE on 6 non-client functions, revoked
PUBLIC+authenticated on 16 dashboard functions (anon kept — see D-02), and added
the missing `is_admin()` guard to `toggle_customer_active` + `unlock_store_customer`.
Advisor: 81 → 53 findings, 0 new. See the SQL file for the full verification log.

### 🟡 D-02 — 16 admin functions remain anon-EXECUTABLE by design (gated internally)
**Why open:** the dashboard authenticates as the public **anon** role and proves
admin only via an `x-admin-secret`/`x-admin-token` header checked inside each
function by `is_admin()` (or a PIN/session check). So these MUST keep the anon
EXECUTE grant or the live dashboard breaks — they cannot be revoked without
first re-architecting dashboard auth. They are protected by their internal gate,
but the advisor will still list them as `anon_security_definer_function_executable`:

`delete_order, reset_customer_pin, get_totp_secret, enroll_owner_totp,
consume_totp_recovery_code, verify_owner_pin, verify_sales_pin, is_admin,
validate_admin_session, invalidate_admin_session, delete_store_customer,
toggle_customer_active, unlock_store_customer, get_customer_audit,
list_store_customers, update_customer_address`

**Proper fix (needs owner decision — bigger change):** move the dashboard off the
raw anon role so anon EXECUTE can be revoked entirely. Options:
  (a) Route all admin RPCs through a single authenticated edge function (service_role)
      that verifies the admin session, exposing nothing to anon; OR
  (b) Give the dashboard a real Supabase Auth admin user (the `authenticated` role)
      and grant EXECUTE to `authenticated` instead of `anon`.
Until then, the internal `is_admin()`/PIN/session gate is the control of record.
**Confirmed every function in this list self-checks** (read each body 2026-06-26).

### 🔴 D-03 — `export_customer_data(text)` unwired; anon EXECUTE revoked
Customer self-service GDPR export, session-token gated, but not called by any
client. Anon EXECUTE was revoked (D-01). When a storefront "export my data"
feature is built, re-`GRANT EXECUTE ... TO anon` and wire it.

### 🟡 D-04 — KEEP-list functions still grant EXECUTE to `authenticated`
The 14 storefront-required functions (`place_customer_order`,
`validate_customer_session`, `verify_customer_pin`, `verify_customer_pin_only`,
`create_store_customer`, `login_with_remember_token`, `create_remember_token`,
`revoke_remember_tokens`, `logout_customer_session`, `webauthn_*`,
`header_customer_phone`) were left untouched per the Phase 0 scope. No client
uses the `authenticated` role, so EXECUTE could safely be revoked from
`authenticated` on these too (advisor noise reduction, defence-in-depth). Low risk.

---

## P1 — Other open security-advisor findings (unchanged by Phase 0)

### 🔴 D-05 — `active_sessions` INSERT policy is always-true
Policy `active_sessions_insert_any` has `WITH CHECK (true)` — bypasses RLS for
INSERT. Scope it (e.g. to service_role / a session check). (advisor: `rls_policy_always_true`)

### 🔴 D-06 — 3 further always-true RLS policies
Three more `rls_policy_always_true` findings beyond `active_sessions`. Enumerate
and scope each (UPDATE/DELETE/INSERT with `USING/WITH CHECK (true)`).

### 🔴 D-07 — `customer_remember_tokens` has RLS enabled but NO policy
Functionally service-role-only today, but add an explicit deny/scoped policy +
comment so intent is recorded. (advisor: `rls_enabled_no_policy`)

### 🔴 D-08 — Public storage buckets allow listing (incl. `qr-images`)
4 × `public_bucket_allows_listing`. Restrict object listing; keep only the
required public read on specific paths.

---

## P2 — Performance advisor (low-risk noise; backlog)

### 🔴 D-09 — 147 redundant/duplicate RLS policies
Consolidate duplicate permissive policies per table/role/command.

### 🔴 D-10 — 26 unused indexes
Review and drop after confirming they are not needed for planned queries.

---

## Standing items (from the engineering review)

### 🔴 D-11 — Rotate the Telegram bot token
Standing security note; token currently read from `store_settings`/env in
`place-order` + `notify-customer`. Rotate and update the secret.

### 🔴 D-12 — `update-order` edge function admin key
`update-order` falls back to a hardcoded `'mrg-admin-2026'` key path; ensure the
`UPDATE_ORDER_ADMIN_KEY` secret is set and the `is_admin()` gate is the only path.
(Tracked in the dashboard repo migration notes; mirror here for visibility.)
