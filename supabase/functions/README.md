# Supabase Edge Functions — source backups

These are the source backups of the edge functions deployed to the **mrbeanies-prod**
Supabase project (`ihnnipynpdtcbdfbpemq`). Until 2026-07-23 only 3 of the 14 deployed
functions had source in git; the other 11 existed **only** inside Supabase, so a
deletion or overwrite would have been unrecoverable. This directory closes that gap.

## Backup provenance

The 11 functions added on 2026-07-23 were copied **verbatim from the live deployed
source** via the Supabase management API (`get_edge_function`). They were **not**
modified and **not** redeployed — this was a copy-only backup. Each file was scanned
for secrets before commit; all secrets are read from `Deno.env.get(...)` (no hardcoded
tokens/keys).

## Functions (14 total, all `verify_jwt=false` except verify-payment)

| Function | Triggered by | What it does |
|---|---|---|
| `place-order` | customer checkout | validates stock/price, creates order, Telegram new-order alert |
| `delivery-quote` | customer checkout | geocodes address, returns Lalamove-estimate delivery fee (+ surge) |
| `crypto-rate` | customer checkout | current USDT rate for crypto payment |
| `upload-receipt` | customer | stores the payment screenshot in `payment-receipts` |
| `verify-payment` | (jwt) | OCR/amount check on the receipt → marks payment |
| `telegram-webhook` | customer Telegram | `/start` links a chat to an order; `/status` lookup |
| `notify-customer` | dashboard | sends the customer a Telegram status update |
| `update-order` | dashboard | changes order status (admin-gated); Telegram status message |
| `upload-product-image` | dashboard | uploads a product photo to `product-images` |
| `upload-qr-image` | dashboard | uploads a payment QR to `qr-images` |
| `setup-telegram-webhook` | one-time admin | registers/inspects the Telegram webhook |
| `compute-client-intelligence` | admin/cron | recomputes client tiers, churn risk, action tags |
| `telegram-intelligence-alerts` | admin/cron | sends VIP/dormant/churn/summary alerts to the owner |
| `import-sheets-data` | admin | imports client/order history from a spreadsheet |

## Deploying from these backups

These files are the record of record for recovery. To redeploy one, use the Supabase
CLI or the management API — and set the function's secrets first
(`SUPABASE_SERVICE_ROLE_KEY` is provided by the platform; `TELEGRAM_BOT_TOKEN` and
`UPDATE_ORDER_ADMIN_KEY` must be configured under Edge Function Secrets).
