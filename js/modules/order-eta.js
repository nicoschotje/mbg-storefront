/* MBG Storefront v2 — HQ ETA line for the customer Orders view
 *
 * get_my_orders() returns an optional HQ-provided delivery estimate / status
 * message on each order as `eta_message` (+ `eta_updated_at`). HQ sets/clears it
 * from the dashboard via set_order_eta (owner-gated). This helper turns that data
 * into the small highlighted ETA row shown on each order card in tracking.js.
 *
 * Contract — additive and fail-safe by design:
 *   - `eta_message` is owner-entered FREE TEXT → untrusted → always escaped with
 *     the shared esc() before it reaches innerHTML (XSS-safe).
 *   - Renders NOTHING when eta_message is null / empty / whitespace / absent.
 *     Older cached get_my_orders responses (from before the ETA go-live) simply
 *     omit the field; that must degrade to no ETA line — never an empty box, and
 *     never a fabricated ETA.
 */
import { esc, timeAgo } from '../core/utils.js';

// Returns the ETA row HTML for an order, or '' when the order has no usable HQ
// ETA message. Pure/string-only so it is unit-testable without a DOM.
export function etaLineHtml(order) {
  const raw = order && order.eta_message;
  const msg = (typeof raw === 'string') ? raw.trim() : '';
  if (!msg) return '';                       // no ETA → render nothing

  // "updated <relative>" is a light freshness hint, shown only when HQ's
  // timestamp is present (absent on older cached responses → hint omitted).
  const ts = order.eta_updated_at;
  const updated = ts
    ? `<span class="ord-eta-updated">updated ${esc(timeAgo(ts))}</span>`
    : '';

  return `<div class="ord-eta" role="status">
      <span class="ord-eta-icon" aria-hidden="true">🚚</span>
      <div class="ord-eta-main">
        <span class="ord-eta-text">${esc(msg)}</span>
        ${updated}
      </div>
    </div>`;
}
