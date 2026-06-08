# What I changed — in plain English

**Date:** 8 June 2026

This was a full check-up of the whole shop (every screen and button), plus a look at the
database behind it. Here's what I found and did, with no jargon.

## The one thing YOU need to do to see the changes
After this update goes live, on your phone: **fully close the MBG app/tab and open it again once**
(or, if you installed it to your home screen, open it once and let it refresh). You only have to do
this once. From then on it updates by itself.

## What was broken, and what I fixed in the app
1. **The "Back" button (Android) and swipe-back weren't closing pop-ups** (product pages, the cart,
   checkout). I fixed how the app loads its files so this works again. This same fix makes sure your
   customers always get the newest version of the shop after one refresh.
2. **Bank Transfer was missing the account number.** The payment screen said "Account number: —".
   It was looking in the wrong place in the database. Now it shows your EastWest account number.
3. **Tidied the security settings** of the site and removed leftovers from the old Google maps system
   we no longer use.

## Important things I found that need YOUR action (I could not safely do these for you on the live shop)
1. **🔴 Your Telegram bot password (token) was visible to anyone who looked.** It was being sent to
   every visitor's phone. **Please treat it as leaked:** open @BotFather in Telegram and tap
   "Revoke token" to get a new one, then give the new token to whoever manages your Supabase/dashboard
   so they can store it the safe way. I've already stopped the *shop* from sending it out, and written
   the exact database command to lock it down, but the password itself must be changed by you because
   it's already been exposed.
2. **✅ Face ID / Fingerprint login — FIXED.** It was broken on the live site because of a one-letter
   typo in a setting (`mrbeanisgreenies.com`, missing an "e"). With your go-ahead I corrected it in
   both places: the website security settings (in this update) and the live database value (already
   applied). PIN login was never affected. Anyone who wants Face ID login just sets it up once more.
3. **🟠 Order totals are trusted from the customer's phone.** In theory someone tech-savvy could send
   an order that says it costs ₱1. Your current process actually catches this — they still have to
   upload a real payment screenshot and you confirm it — so it's low risk. The proper backend fix
   needs to be tested on a copy of the database first, so I've written it up rather than risking your
   live checkout.

## What I checked and found to be working correctly (no change needed)
- Payments show **only Bank Transfer and USDT** (GCash/Maya are correctly hidden; there is **no**
  Cash-on-Delivery anywhere).
- Stock can't be oversold; the "Place Order" button can't be double-tapped into two orders.
- Discounts (including the Flowers promo) are double-checked by the server.
- Delivery areas (Luzon ₱1,200 / Visayas ₱1,500 / Mindanao ₱1,500) work.
- No customer data is exposed on the page, and there's no dangerous "admin password" hidden in the
  website code.

The full technical detail is in **STOREFRONT-AUDIT.md**.
