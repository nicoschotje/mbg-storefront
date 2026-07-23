# MBG — Tracked Defects / Security Backlog

Triaged backlog for deliberate, reviewed passes (NOT auto-applied). Seeded
2026-06-26 from the Phase 0 anon-exec security triage + the Supabase advisors.

Status legend: 🔴 open · 🟡 partial / mitigated · ✅ done

---

## Phase 2 — frictionless checkout

### 🟠 D-19 — Reference-in-transfer needs a pre-payment order number (two-phase)
M3 ships "amount-first, reference-after": the payment screen shows the exact
amount + payee with copy buttons and scan-to-pay QR; the order **reference
(= order_number)** is shown on the success/status screen *after* placement,
because today the order (and its number) is only created after the customer pays
and uploads the receipt. To have the customer put the order_number IN the
transfer (so OCR matches on reference for the first attempt), the order/number
must exist before payment → a **two-phase order flow** (create at "Proceed to
pay", attach receipt after). That changes the live order lifecycle (receipt-less
"awaiting payment" orders appear in the dashboard queue) and likely needs a small
dashboard-repo change, so it's parked for an explicit owner decision. The
verify-payment reference matcher is already deployed and forward-compatible: it
fires automatically if/when the reference appears on receipts.

### 🟢 D-20 — Amount-embedded QR not available for GCash/Maya P2P
The brief's "amount-pre-embedded QR where the rail supports it" — GCash/Maya
personal (P2P) rails don't expose a reliable amount-prefilled QR from a static
QR image (would need the merchant's QR Ph/EMVCo payload, which we don't hold).
Per the brief's "Path B honest ceiling," M3 uses the existing static payee QR
(scan-to-pay) + a prominent **copy-the-exact-amount** button instead. Revisit if
the owner moves to a QR Ph merchant account.

### 🟡 D-17 — Cross-device payment-method pre-fill
M2 defaults the checkout payment method from a per-account **device-local** cache
(`mbg_last_pay::<customer_id>`). The server-side source of truth
(`store_customers.last_payment_method`, written by `place_customer_order`) is NOT
surfaced to the client, so on a brand-new device the method falls back to the
default until the first order. Surfacing it would mean adding
`last_payment_method` (and `saved_address` consistently) to the login RPC returns
(`verify_customer_pin`, `webauthn_auth_complete`, `login_with_remember_token`) —
deliberately deferred to avoid modifying live auth functions and to keep the
advisor finding count flat. No new advisor finding either way.

### 🟢 D-18 — Quick-confirm needs a complete saved address
The one-line confirm only appears for a logged-in customer who has a saved address
(saved-address.js) with street+barangay+city+province. Otherwise checkout falls
back to the full (pre-filled) form. By design — a partial address can't pass
placement validation. Saved addresses remain device-local (see Phase 1 note in
saved-address.js).

---

## Phase 1 — account ownership & visibility (Milestones 0 + 1)

### 🟢 D-13 (expected, accepted) — +1 advisor finding for `get_my_orders`
The Phase 1 migration adds one new `anon_security_definer_function_executable`
finding for `public.get_my_orders(text, uuid[])` (live advisor 53 → 54). This is
the irreducible minimum: account-scoped order reads require an anon-callable
SECURITY DEFINER RPC, and it is the SAME accepted class as the existing storefront
RPCs — anon-only (PUBLIC/authenticated revoked), `search_path` locked, self-gates
on the session token / order-id capability, returns customer-safe columns only.
Not a regression; reviewed and accepted.

### ✅ D-14 — `orders_anon_cancel_own` removed (2026-07-23)
Applied in `db/2026-07-23-security-pass-d14-d05-d08.sql`. Dropped the phone-header
cancel policy. Confirmed the only cancel path in real use is `cancel_order()`
(SECURITY DEFINER, hard-gated on `is_admin()`) plus `orders_admin_header_all` /
`orders_sales_update`; the storefront has no customer self-cancel UI, so nothing
live depended on the phone policy. After the change the only remaining `orders`
UPDATE policies are `is_admin()`, sales-scope and service_role — a recipient phone
can no longer cancel. If a customer self-cancel is ever built, it must be a
session-token-validating RPC (like `get_my_orders`), never a header policy.

### 🟡 D-15 — Backfill of `order_owner_id` runs at live merge, not yet applied
The conservative backfill (unique normalized-phone match only) is in the migration.
Live dry-run 2026-06-26: 88 orders → 83 attach to a unique owner, 0 ambiguous, 5
left unowned (phones with no registered account). It executes when the migration is
applied to live; verify the post-merge count matches.

### ℹ️ D-16 — Supabase dev-branch migration replay is broken (pre-existing)
Creating a dev branch lands in `MIGRATIONS_FAILED` (production history fails to
replay on a fresh branch at the `create_product_variants` migration; later
migrations incl. Phase 0 don't apply). The Phase 1 DB layer was still validated on
the branch against the present schema (non-variant paths). Worth fixing the history
so future branches provision cleanly, independent of Phase 1.

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

### ✅ D-05 — `active_sessions` always-true INSERT removed (2026-07-23)
Applied in `db/2026-07-23-security-pass-d14-d05-d08.sql`. Dropped
`active_sessions_insert_any`. No legitimate anon writer; service_role + is_admin
policies remain. Anon INSERT now BLOCKED (verified 42501). Advisor 4 → 2 for
`rls_policy_always_true` (see D-06).

### 🟡 D-06 — always-true INSERT: 2 fixed, 2 kept by design (2026-07-23)
The four `rls_policy_always_true` INSERT findings split by whether a live client
legitimately writes the table:
  * **Fixed** — `active_sessions` (D-05) and `auth_audit_log` (`audit_anon_insert`
    dropped). Neither has a direct anon writer; auth RPCs write auth_audit_log as
    SECURITY DEFINER. Both now BLOCKED for anon (verified 42501).
  * **Kept open on purpose** — `activity_log."Allow insert for all"` (client
    best-effort telemetry via `logActivity`) and `restock_notifications.customers_can_subscribe`
    (the "notify me when restocked" form). Both are written by the live storefront as
    anon and are internal append targets (no read leak). Locking them risks a silent
    regression (e.g. the dashboard activity feed) for no data-exposure gain, so they
    stay. This is the residual `rls_policy_always_true` count of 2.

### ✅ D-07 — no-policy tables given explicit service-role policy (2026-07-23)
Applied in `db/2026-07-23-security-pass-d14-d05-d08.sql`. Both `rls_enabled_no_policy`
tables (`customer_remember_tokens` **and** `report_refresh_state`) now carry an explicit
`*_service_only` policy recording intent. Functionally unchanged (already deny-all for
anon/authenticated). Advisor `rls_enabled_no_policy` 2 → 0.

### ✅ D-08 — public bucket listing removed (2026-07-23)
Applied in `db/2026-07-23-security-pass-d14-d05-d08.sql`. Dropped the broad
`Public read <bucket>` SELECT policies on `banners`, `product-images`, `qr-images`,
`store-banners`. Public object URLs (`/object/public/...`) still serve normally —
verified all QR/image columns use that form and the storefront makes no `.list()`
call — so display is unaffected; only list-all-files is removed. Advisor
`public_bucket_allows_listing` 4 → 0.

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

### 🟡 D-12 — `update-order` edge function admin key
The hardcoded `'mrg-admin-2026'` fallback is **gone** from the deployed `update-order`
(v4) — confirmed 2026-07-23 when the function was backed up to git
(`supabase/functions/update-order/index.ts`). Auth is now (a) `x-admin-key` matching the
`UPDATE_ORDER_ADMIN_KEY` secret (requires length ≥ 16), or (b) `is_admin()` via
`x-admin-secret`/`x-admin-token`. Remaining action for the owner: confirm the
`UPDATE_ORDER_ADMIN_KEY` secret is set to a long random value (Path B via `is_admin()`
works regardless), then this closes.

### ℹ️ D-21 — Edge function source backed up to git (2026-07-23)
11 of 14 deployed edge functions previously existed only in Supabase. All 14 now have
verbatim source under `supabase/functions/` (copy-only; not redeployed; secret-scanned).
See `supabase/functions/README.md`.
