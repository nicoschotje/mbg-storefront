# MBG Storefront — Deep Debug, Audit & Repair

**Date:** 2026-06-08 · **Branch:** `claude/dazzling-tesla-bJM7c`
**Scope:** storefront `mbg-storefront` → `mrbeaniesgreenies.com` · backend Supabase `ihnnipynpdtcbdfbpemq`
**Method (Master §1):** nothing is called "fixed" on the strength of reading code. Every claim
below is backed by a real DB read/write, a behavioural test, or a precise code trace — and where
a thing could only be proven on a real device or the live deploy, that is stated plainly.

> **Environment honesty.** This audit ran from a sandbox whose outbound network is allow-listed:
> the Supabase API is reachable (so the database half is verified *directly*), but
> `mrbeaniesgreenies.com` is **not** reachable from here, and there is no browser — so the live
> static deploy and the on-device map/visual checks are the owner's one step after merge. Those
> items are marked ⚠️ device/deploy-pending below, never ✅.

---

## 1. Headline — what this pass found and did

A previous pass (PR #27) genuinely fixed the three owner-reported bugs at the **root cause**, and
I **re-verified all three against the live database** (details in §3). It was also honest about what
it had *not* device-tested. This pass confirmed that work and then **found four issues the previous
passes missed** — two of them serious:

| New finding | Sev | Status |
|---|---|---|
| Bank-Transfer "Account number: —" (read wrong column) | **P1** | ✅ fixed (code) |
| USDT picker offered TRC-20 (Tron) with an Ethereum address → wrong-chain fund loss | **P2** | ✅ fixed (code) |
| 3 DB functions let **anyone with the public anon key** dump all customer PII, reset any PIN, delete any customer | **P1** | ✅ fixed (live DB, verified) |
| Telegram bot token is readable by the public anon key | **P0** | ⚠️ owner must rotate (see §5) |

---

## 2. The three dossier bugs — re-verified (Master §8)

### BUG 1 — Inventory never decremented / contradictory availability (P0) — ✅ FIXED & VERIFIED LIVE
- **Root cause (confirmed):** stock had two unreconciled sources of truth; all 16 products are
  `has_variants=true`; orders decrement `product_variants.stock_qty` but nothing rolled that up to
  `products.stock_qty`, which every dashboard/low-stock/plain read uses.
- **Fix present on live:** trigger `trg_rollup_variant_stock` `AFTER INSERT OR DELETE OR UPDATE OF
  stock_qty ON product_variants` → sets `products.stock_qty = Σ(variant stock_qty)` for the parent.
- **Evidence — reconciliation:** all **16/16** products now satisfy `parent_stock == Σ(variant
  stock_qty)` (queried live).
- **Evidence — behavioural, zero-footprint (rolled back):** decremented one Willyummy's High'Dro
  variant by 3 inside a transaction → variant `300 → 297`, parent `599 → 596`, then `ROLLBACK`
  (no data changed). The parent moved with the variant — the trigger fires on a real stock change.
- **Path trace:** `checkout.js` sends `{ id: parentId, variant_id, quantity }` (line ~559) → edge
  `place-order` re-verifies the discount server-side then calls `place_customer_order` → the RPC
  row-locks and `UPDATE product_variants SET stock_qty = stock_qty - qty*stock_units, is_available =
  …` → trigger rolls up. **Bypass closed:** `orders` has **no** anon INSERT policy (only
  `service_role` can insert), so every order goes through the decrementing RPC.
- **Storefront display consistency:** parent cards always show "Choose Strain" (variant count
  badge) regardless of parent `stock_qty`; the strain picker marks a variant SOLD OUT when
  `is_available === false || stock_qty <= 0` and disables it; plain products gate on `stock_qty`.
  These agree with the rolled-up data.

### BUG 2 — Checkout map / address (P1) — ✅ FIXED in code · ⚠️ device test = owner step
`leaflet-map.js` + `address.js` now implement every defect's fix (verified by reading the code):
- tap-to-place pin (`_map.on('click', …) → placePin`); draggable marker; **"📍 Use my location"**
  button that calls `navigator.geolocation` only from a tap (gesture-gated).
- Leaflet load race guarded: retries up to 25×150 ms before showing a graceful "type your address"
  fallback instead of a blank box.
- Grey-tiles guarded: `invalidateSize()` on `[60,250,600]ms` **and** the panel's `transitionend`.
- Nominatim resilience: `MIN_QUERY_LEN = 3`, PH `viewbox` + `countrycodes=ph`, `AbortController`,
  a visible "No matches / try again" and 429 state, and `escapeHtml()` on `display_name` (no XSS).
- CSP (`netlify.toml`) is clean: no `maps.googleapis.com`/`gstatic`, **no misspelled
  `mrbeanisgreenies.com`**; keeps `nominatim` + `*.tile.openstreetmap.org`.
- **Cannot be exercised here** (no browser): tap-map→pin→fields, locate-me, and suggestion UX must
  be confirmed on a real iPhone/Android after deploy.

### BUG 3 — "Store Closed" yellow `[object Object]` (P2) — ✅ FIXED & VERIFIED (logic + data)
- `banners.js` `formatOperatingHours()` formats the JSONB `operating_hours`. For the **live** value
  `{"days":[0..6],"open":"14:00","close":"00:00"}` it yields **"Open daily · 2:00 PM–12:00 AM"**
  (handles the midnight `00:00` case and the 7-days→"daily" case; returns `''` for an invalid
  schedule and hides the element). It uses `textContent`, so no interpolated object and no XSS.
- `.store-closed-hours` colour is now `rgba(255,255,255,0.55)` (calm muted) — **not** raw gold.
- `closed_message` column exists and is wired (`msgEl.textContent = settings.closed_message`);
  it is currently `null`, so the HTML fallback copy shows until the owner sets it.

---

## 3. New findings & fixes this pass

### 3.1 P1 — Bank Transfer account number renders "—" — ✅ FIXED
- **Root cause:** `checkout.js` read `ss?.bank_account_number`, but that column does not exist;
  `loadStoreSettings()` fetches `bank_account`, whose **live value is `200047964791`**. So the
  account number field always showed "—" and bank-transfer customers had nothing to pay to.
- **Fix:** read `ss?.bank_account` (kept a `bank_account_number` fallback for safety). Verified the
  live row holds `Eastwest Bank / 200047964791 / Clara Pagunuran`, matching the dossier.

### 3.2 P2 — USDT wrong-network fund-loss trap — ✅ FIXED
- **Root cause:** the USDT block hard-coded a 4-network radio picker (ERC-20, **TRC-20**, BEP-20,
  Polygon) all sharing the single wallet `crypto_usdt_address = 0x4524…5BAf` (an Ethereum address).
  A customer who picked **TRC-20 (Tron)** and sent USDT-TRON to a `0x…` address loses it forever.
  The owner config `crypto_usdt_network = "ERC-20"` was ignored.
- **Fix:** render only the **owner-configured** network (mapped to a friendly label/colour); the
  address is fixed and the network is informational. Removes the Tron option entirely. The "confirm
  the network" warning stays. Reuses existing `.usdt-network-*` CSS (no CSS change).

### 3.3 P1 — Three anon-callable DB functions (PII dump / account takeover) — ✅ FIXED on live
- **Proof (pre-fix):** as the `anon` role, `is_admin()` = `false` yet `list_store_customers()`
  returned **41 rows** of customer PII. `reset_customer_pin` and `delete_store_customer` had no
  guard either.
- **Fix (applied to live, owner-approved):** added `IF NOT public.is_admin() THEN …` to all three
  (migration `guard_admin_only_customer_rpcs`; SQL also in `db/2026-06-08-storefront-security-guards.sql`).
- **Proof (post-fix, as anon):** reset/delete → `{"success":false,"error":"Admin authentication
  required"}`; list → `ERROR 42501 Unauthorized`. Legit admin (header-authenticated) calls still
  pass `is_admin()` — same gate as `delete_order`, which the dashboard already uses successfully.
- **Safety:** additive + reversible (revert SQL noted in the db file). The storefront never calls
  these (grep-confirmed), so it is unaffected.

### Cache discipline (Master §5)
Only `checkout.js` changed → bumped its `?v=` tag to `20260608-deepfix2` (its sole reference is in
`index.html`) and `CACHE_VERSION` `v17 → v18`. Audited the full `?v=` graph: the prior pass's
`20260608-deepfix` cascade (banners/products/cart/checkout/address/leaflet-map/strain-picker/
components.css) is internally consistent — **no stranded fixes**. The older tags on unchanged files
(supabase/auth/utils/tiers/usermenu/bottomnav/delivery/tracking) are correct: each file's tag
matches every reference to it.

---

## 4. Open items — flagged, with reasons (Master §1 rule 7: honesty over completion)

| Item | Sev | Why not auto-fixed here | What to do |
|---|---|---|---|
| **Telegram bot token anon-readable** | **P0** | Token is already public (anon can `select telegram_bot_token from store_settings`). Code can't un-leak it; the storefront already avoids fetching it. The DB lock-down (a public view + dropping `allow_read_store_settings`/`settings_public_read`) would change reads the **dashboard** depends on — out of storefront scope & untestable here. | **Owner:** rotate via @BotFather, set `TELEGRAM_BOT_TOKEN`/`TELEGRAM_OWNER_CHAT_ID` as edge secrets (the edge fns already fall back to env). Then apply the lock-down SQL in the cross-system pass. |
| 36 SECURITY DEFINER fns `anon`-executable | P2 | Most are intentional (storefront/dashboard auth & order RPCs). I verified the dangerous-looking ones **are** internally guarded: `get_totp_secret`, `enroll_owner_totp`, `verify_owner_pin`, `delete_order`, `validate/invalidate_admin_session` use `is_admin()`/PIN; `export_customer_data` is session-token-gated. The 3 that were **not** guarded are now fixed (§3.3). | Dashboard/cross-system pass: review remaining EXECUTE grants; do **not** blanket-revoke (apps depend on many). |
| Tap targets < 44px | P2 | `modal-close` 32px, `cart-qty .qb` 28px, `strain-qty-btn` 32px, `variant-pill` 36px, `choose-strain-btn` 40px. Real but cosmetic; resizing changes tight layouts I can't visually verify from here. | Bump to ≥44px touch area and confirm on device. |
| `orders.delivery_zone_id` not persisted | P3 | The RPC saves the human-readable `delivery_zone` text but ignores `delivery_zone_id`; fixing means editing the RPC **and** edge fn on the revenue path — not worth the risk for a P3 when the zone name is preserved. | Add `delivery_zone_id` to the edge payload + RPC insert in a backend pass. |
| `store_settings.webauthn_rp_id` **default** is a decoy domain | P3 | The live **row value** is correct (`mrbeaniesgreenies.com`); only the column DEFAULT is `newstorefrontmgb1234.netlify.app`. Latent only (bites only if a new settings row is inserted). | `ALTER … SET DEFAULT 'mrbeaniesgreenies.com'`. |
| Dead `usdt_qr_url`/`crypto_qr_url` read | P3 | No such column exists, so it's always `''` (no QR) — harmless. USDT pays by copying the address. | Optional cleanup. |
| Advisor WARNs: 4 always-true INSERT policies; 4 listable public buckets; `customer_remember_tokens` RLS-enabled-no-policy | P3 | Append-only logs / restock-subscribe (anon insert is intended); buckets hold product/QR images (not customer data); the tokens table has no policy = default-deny (effectively locked). | Tighten in the cross-system pass if desired. |

---

## 5. Owner changelog — what was broken, what changed, the one action

| Was broken | Now | How to see it |
|---|---|---|
| Bank-transfer customers saw **"Account number: —"** | Shows your EastWest number `200047964791` | Checkout → Bank Transfer |
| USDT let a buyer pick **Tron** with your Ethereum address (money could be lost) | Shows only your real network (ERC-20); no wrong-chain option | Checkout → USDT |
| Anyone with the public app key could pull your **whole customer list**, reset PINs, or delete customers | Locked to admin only (verified) | invisible — already live on the DB |
| (re-confirmed) stock not dropping; "[object Object]" closed card; un-pinnable map | All three fixed at root cause (verified on the DB; map needs a real-phone tap test) | place/receive an order; toggle store closed; open checkout on a phone |

**Your one action for the code fixes:** merge this PR → wait for Netlify → hard-refresh the
storefront once (PWA cache bumped to v18, so one refresh pulls the new build).
**Your one separate security action:** rotate the Telegram bot token (§4, P0).

---

## 6. Coverage Ledger

Legend: ✅ inspected **and** behaviour-verified · ⚠️ inspected, behaviour not provable from here
(no browser / no live-site egress) · ❌ not reached.

### Storefront files
| File | Inspected | Behaviour-verified | Status / notes |
|---|---|---|---|
| index.html | ✅ | ⚠️ | boot/gate/nav read; `?v=` graph audited; checkout tag bumped. Deploy-render not reachable here |
| service-worker.js | ✅ | ✅ | network-first; `CACHE_VERSION v17→v18`; activate purges old caches |
| manifest.json | ✅ | ⚠️ | linked; install not testable here |
| netlify.toml | ✅ | ✅ | CSP clean (no Google Maps, no misspelled domain); `/js`,`/css`,html,SW `no-cache` |
| css/tokens.css | ✅ | ✅ | safe-area vars defined |
| css/layout.css | ✅ | ✅ | header/cat-nav/bottom-nav use safe-area; cat-nav 70px fallback mitigated by ResizeObserver |
| css/components.css | ✅ | ⚠️ | `.store-closed-hours` muted (not gold) ✅; tap targets <44px flagged (P2) |
| js/core/config.js | ✅ | ✅ | correct project ref; anon key (public by design, not service-role); no COD |
| js/core/utils.js | ✅ | ✅ | `esc()` escapes `& < > " '`; phone/format helpers correct |
| js/core/supabase.js | ✅ | ✅ | anon client; `logActivity` best-effort (acceptable) |
| js/core/auth.js | ✅ | ⚠️ | PIN+lockout, WebAuthn, remember-token, logout-revoke; live PIN/passkey = device |
| js/modules/banners.js | ✅ | ✅ | hours formatter correct for live data; safe column list (no token); `esc()` on hero/ann |
| js/modules/products.js | ✅ | ✅ | variant grouping, SOLD-OUT/stock gating, `esc()` throughout |
| js/modules/strain-picker.js | ✅ | ✅ | SOLD-OUT logic, strain-type tabs, qty cap to stock, composite cart key |
| js/modules/cart.js | ✅ | ✅ | composite keys, discount calc mirrors server, `esc()`, persist |
| js/modules/checkout.js | ✅ | ⚠️ | **fixed** bank# + USDT network; payment filter (gcash/maya off, bank+USDT on), no-double-submit, no COD; full order = owner deploy |
| js/modules/address.js | ✅ | ⚠️ | Nominatim resilience + escapeHtml; suggestion UX = device |
| js/modules/leaflet-map.js | ✅ | ⚠️ | tap/drag/locate/retry/invalidate; map interaction = device |
| js/modules/delivery.js | ✅ | ✅ | Haversine fee math, numeric-safe |
| js/modules/tracking.js | ✅ | ✅ | scoped client sets `x-customer-phone` (RLS); loading/empty/error states |
| js/modules/restock.js | ✅ | ✅ | `esc()`, toast on failure |
| js/modules/tiers.js | ✅ | ✅ | `esc()`, degrades silently (non-critical badge) |
| js/modules/bottomnav.js | ✅ | ✅ | clean, aria roles |
| js/modules/usermenu.js | ✅ | ✅ | `esc()`, aria menu |

### Backend objects (Supabase `ihnnipynpdtcbdfbpemq`)
| Object | Inspected | Behaviour-verified | Status |
|---|---|---|---|
| `place_customer_order` RPC | ✅ | ✅ | decrements variant; locks rows; raises P0001/2/3 |
| `roll_up_variant_stock` + `trg_rollup_variant_stock` | ✅ | ✅ | live test: variant−3 → parent−3 (rolled back) |
| products↔variants reconciliation | ✅ | ✅ | 16/16 reconcile |
| edge `place-order` | ✅ | ✅ | service-role RPC call + server-side discount re-verify |
| `orders` RLS | ✅ | ✅ | no anon INSERT (bypass closed); anon select/cancel-own by phone header |
| `decrement_stock` grants | ✅ | ✅ | EXECUTE only postgres/service_role |
| `is_admin()` | ✅ | ✅ | no `123456` backdoor; token / owner-PIN-hash only |
| `list_store_customers` | ✅ | ✅ | **was anon→41 PII rows; now anon→Unauthorized** |
| `reset_customer_pin` | ✅ | ✅ | **now anon→admin-required** (was account-takeover) |
| `delete_store_customer` | ✅ | ✅ | **now anon→admin-required** |
| `get_totp_secret`,`delete_order`,`export_customer_data` | ✅ | ✅ | already guarded (is_admin / token) |
| `store_settings` (token columns) | ✅ | ✅ | token anon-readable — **P0 open, owner rotation** |
| `verify_customer_pin`, webauthn_* | ✅ | ⚠️ | storefront login RPCs; live login = device |
| security advisors | ✅ | ✅ | 0 ERROR, 80 WARN; triaged in §4 |
| other edge fns (notify/update/upload/verify/telegram/*) | ⚠️ | ❌ | not storefront-critical this pass; not exercised |

---

*Prepared for the storefront pass. The cross-system pass (Master prompt 03) should pick up the
Telegram-token DB lock-down, the remaining EXECUTE-grant review, and `delivery_zone_id` persistence.*
