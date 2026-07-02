/* MBG Storefront v2 — Agent Wallet (Phase 2 C2b)
 *
 * Commission wallet for customers who are also agents. Everything is read
 * through two session-scoped RPCs:
 *
 *   get_my_wallet(p_session_token)        → {ok, balance, entries, withdrawals, can_withdraw}
 *   get_my_agent_clients(p_session_token) → {clients: [...]}
 *   request_withdrawal(p_session_token)   → {ok, ...} | {ok:false, reason}
 *
 * FEATURE DETECTION: get_my_wallet returns bare {ok:false} for non-agents and
 * a missing-function error on databases without the wallet schema (prod until
 * go-live). In BOTH cases this module renders nothing — no menu entry, no
 * screen, no trace. The storefront looks identical to today.
 *
 * Integration is a single listener: bottomnav.js announces the account sheet
 * via the 'mbg:accountSheet' event and this module injects its own entry only
 * when the wallet is confirmed available.
 *
 * All amounts are integer centavos; rendered as ₱ with 2 decimals.
 */
// NOTE: utils MUST be imported with the same ?v= specifier index.html uses —
// utils.js holds the overlay stack as module state, and only the instance
// whose installPopstateHandler() ran can close overlays on the back button.
import { sb } from '../core/supabase.js';
import { esc, openOverlay, closeOverlay, showToast } from '../core/utils.js?v=20260520-polish';
import { getSession, onAuthChange } from '../core/auth.js?v=20260520-polish';

let _wallet = null;     // last ok:true payload — null means "no wallet UI"
let _clients = null;    // null = load failed/hide section, [] = none linked

// ── Formatting ────────────────────────────────────────────
function fmtCentavos(c) {
  const n = Number(c) || 0;
  const abs = (Math.abs(n) / 100).toLocaleString('en-PH', {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  });
  return (n < 0 ? '−₱' : '₱') + abs;
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const opts = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('en-PH', opts);
}

// 'commission' → 'Commission', 'manual_adjustment' → 'Manual adjustment'
function typeLabel(t) {
  const s = String(t || 'entry').replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// can_withdraw.reason / request_withdrawal reason → plain words. Unknown
// codes fall through verbatim so a new server rule is never silently hidden.
function reasonText(reason, feeCentavos) {
  switch (reason) {
    case 'insufficient_available_balance':
      return `Available balance must be above the ${fmtCentavos(feeCentavos)} fee.`;
    case 'open_request_exists':
      return 'You already have a withdrawal being processed.';
    case 'denied':
      return 'Withdrawals are not available for this account.';
    default:
      return reason ? String(reason) : 'Withdrawals are not available right now.';
  }
}

// ── Data ──────────────────────────────────────────────────
// null → wallet stays invisible (non-agent, invalid session, or the RPC
// doesn't exist on this database yet).
async function fetchWallet() {
  const token = getSession()?.token;
  if (!token) return null;
  try {
    const { data, error } = await sb().rpc('get_my_wallet', { p_session_token: token });
    if (error || !data || data.ok !== true) return null;
    return data;
  } catch (_) {
    return null;
  }
}

// null → hide the clients section entirely; [] → "no clients yet".
async function fetchClients() {
  const token = getSession()?.token;
  if (!token) return null;
  try {
    const { data, error } = await sb().rpc('get_my_agent_clients', { p_session_token: token });
    if (error) return null;
    return Array.isArray(data?.clients) ? data.clients : [];
  } catch (_) {
    return null;
  }
}

// ── Boot ──────────────────────────────────────────────────
export function initWallet() {
  document.addEventListener('mbg:accountSheet', onAccountSheet);
  onAuthChange((session) => {
    if (session) {
      detect(session.token);
    } else {
      _wallet = null;
      _clients = null;
      closeWalletScreen();
    }
  });
  // Session may already exist when the module boots (e.g. module loaded after
  // a restored login) — detect once immediately as well.
  const existing = getSession();
  if (existing) detect(existing.token);
}

// Only keep the result if the session is still the one we asked about — a
// logout (or re-login) while the RPC was in flight must not leave a stale
// wallet behind.
async function detect(token) {
  const w = await fetchWallet();
  if (getSession()?.token === token) _wallet = w;
}

// Inject the wallet entry into the account sheet — only once detection has
// confirmed this customer is an agent. Otherwise the sheet is untouched.
function onAccountSheet(e) {
  if (!_wallet) return;
  const { sheet, close } = e.detail || {};
  const menu = sheet?.querySelector('.acct-sheet');
  if (!menu || menu.querySelector('[data-act="wallet"]')) return;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'acct-item';
  btn.dataset.act = 'wallet';
  btn.innerHTML = '<span class="acct-ico" aria-hidden="true">💼</span><span>Agent Wallet</span>';
  btn.addEventListener('click', () => {
    close?.();
    openWalletScreen();
  });
  menu.insertBefore(btn, menu.querySelector('.acct-item-danger'));
}

// ── Screen ────────────────────────────────────────────────
export function openWalletScreen() {
  let host = document.getElementById('walletScreen');
  if (!host) {
    host = document.createElement('section');
    host.id = 'walletScreen';
    host.className = 'wallet-screen';
    document.body.appendChild(host);
  }
  host.innerHTML = `
    <div class="wallet-inner">
      <header class="checkout-header">
        <button class="checkout-back" aria-label="Back">←</button>
        <h2>Agent Wallet</h2>
        <span class="checkout-spacer"></span>
      </header>
      <div id="walletBody" class="wal-body"><div class="wal-loading">Loading your wallet…</div></div>
    </div>`;
  host.querySelector('.checkout-back')?.addEventListener('click', closeWalletScreen);

  host.classList.add('open');
  document.body.classList.add('lock-scroll');
  openOverlay('walletScreen', () => closeWalletScreen());
  refreshWallet(host);
}

export function closeWalletScreen() {
  const host = document.getElementById('walletScreen');
  if (!host || !host.classList.contains('open')) return;
  host.classList.remove('open');
  document.body.classList.remove('lock-scroll');
  closeOverlay('walletScreen');
}

async function refreshWallet(host) {
  const body = host.querySelector('#walletBody');
  if (!body) return;
  const [wallet, clients] = await Promise.all([fetchWallet(), fetchClients()]);
  if (wallet) _wallet = wallet;
  _clients = clients;
  if (!body.isConnected) return;
  if (!wallet) {
    body.innerHTML = '<div class="wal-loading">Could not load your wallet. Please try again.</div>';
    return;
  }
  renderWallet(body, wallet, clients);
}

function renderWallet(body, wallet, clients) {
  const bal = wallet.balance || {};
  const cw  = wallet.can_withdraw || {};
  const fee = Number(cw.fee_centavos) || 5000;
  const available = Number(bal.available_centavos) || 0;
  const entries = Array.isArray(wallet.entries) ? wallet.entries : [];
  const withdrawals = Array.isArray(wallet.withdrawals) ? wallet.withdrawals : [];

  // "releases after …" — the soonest pending entry's hold date.
  const nextHold = entries
    .filter(en => en.status === 'pending' && en.hold_until)
    .map(en => new Date(en.hold_until))
    .filter(d => !isNaN(d.getTime()))
    .sort((a, b) => a - b)[0] || null;

  const withdrawHtml = cw.allowed
    ? `<button type="button" class="btn-primary wal-withdraw" id="walWithdrawBtn">
         Withdraw all available: ${esc(fmtCentavos(available))}
       </button>
       <div class="wal-fee-note">${esc(fmtCentavos(fee))} fee — you receive ${esc(fmtCentavos(available - fee))}</div>`
    : `<button type="button" class="btn-primary wal-withdraw" disabled>Withdraw</button>
       <div class="wal-reason">${esc(reasonText(cw.reason, fee))}</div>`;

  body.innerHTML = `
    <div class="wal-balances">
      <div class="wal-card wal-card-main">
        <div class="wal-label">Available</div>
        <div class="wal-amount">${esc(fmtCentavos(available))}</div>
      </div>
      <div class="wal-row">
        <div class="wal-card">
          <div class="wal-label">Pending</div>
          <div class="wal-amount-sm">${esc(fmtCentavos(bal.pending_centavos))}</div>
          ${nextHold ? `<div class="wal-hint">releases after ${esc(fmtDate(nextHold.toISOString()))}</div>` : ''}
        </div>
        <div class="wal-card">
          <div class="wal-label">Released (lifetime)</div>
          <div class="wal-amount-sm">${esc(fmtCentavos(bal.released_centavos))}</div>
        </div>
      </div>
    </div>
    <div class="wal-withdraw-wrap">${withdrawHtml}</div>

    <h3 class="wal-h">Earnings</h3>
    ${renderEntries(entries)}

    <h3 class="wal-h">Withdrawals</h3>
    ${renderWithdrawals(withdrawals)}

    ${clients !== null ? `<h3 class="wal-h">My Clients</h3>${renderClients(clients)}` : ''}
  `;

  body.querySelector('#walWithdrawBtn')?.addEventListener('click', () => {
    confirmWithdrawal(available, fee);
  });
}

function renderEntries(entries) {
  if (!entries.length) return '<div class="wal-empty">No earnings yet.</div>';
  return `<ul class="wal-list">${entries.map(en => `
    <li class="wal-item">
      <div class="wal-item-top">
        <span class="wal-item-title">${esc(typeLabel(en.type))}</span>
        <span class="wal-item-amt">${esc(fmtCentavos(en.amount_centavos))}</span>
      </div>
      <div class="wal-item-sub">
        <span class="wal-chip wal-chip-${esc(en.status || 'pending')}">${esc(en.status || '')}</span>
        <span>${esc(fmtDate(en.created_at))}</span>
        ${en.order_number ? `<span>· Order #${esc(en.order_number)}</span>` : ''}
      </div>
    </li>`).join('')}</ul>`;
}

function renderWithdrawals(withdrawals) {
  if (!withdrawals.length) return '<div class="wal-empty">No withdrawals yet.</div>';
  return `<ul class="wal-list">${withdrawals.map(w => `
    <li class="wal-item">
      <div class="wal-item-top">
        <span class="wal-item-title">${esc(fmtCentavos(w.amount_centavos))}</span>
        <span class="wal-chip wal-chip-${esc(w.status || 'requested')}">${esc(w.status || '')}</span>
      </div>
      <div class="wal-item-sub">
        <span>Requested ${esc(fmtDate(w.requested_at))}</span>
        <span>· ${esc(fmtCentavos(w.fee_centavos))} fee</span>
        ${w.decided_at ? `<span>· Decided ${esc(fmtDate(w.decided_at))}</span>` : ''}
        ${w.payout_rail ? `<span>· ${esc(w.payout_rail)}</span>` : ''}
      </div>
    </li>`).join('')}</ul>`;
}

function renderClients(clients) {
  if (!clients.length) return '<div class="wal-empty">No linked clients yet.</div>';
  return `<ul class="wal-list">${clients.map(c => `
    <li class="wal-item">
      <div class="wal-item-top">
        <span class="wal-item-title">${esc(c.client_name || 'Client')}</span>
        <span class="wal-item-amt">${esc(fmtCentavos(c.commission_centavos))}</span>
      </div>
      <div class="wal-item-sub">
        <span>${esc(String(Number(c.completed_orders) || 0))} completed order${Number(c.completed_orders) === 1 ? '' : 's'}</span>
        ${c.linked_since ? `<span>· since ${esc(fmtDate(c.linked_since))}</span>` : ''}
        <span>· commission earned</span>
      </div>
    </li>`).join('')}</ul>`;
}

// ── Withdraw flow ─────────────────────────────────────────
function confirmWithdrawal(availableCentavos, feeCentavos) {
  let host = document.getElementById('walletConfirm');
  if (!host) {
    host = document.createElement('div');
    host.id = 'walletConfirm';
    host.className = 'modal-backdrop';
    document.body.appendChild(host);
  }
  host.innerHTML = `
    <div class="modal-sheet modal-sheet-sm" role="dialog" aria-label="Confirm withdrawal">
      <div class="modal-handle" aria-hidden="true"></div>
      <div class="wal-confirm">
        <h3>Confirm withdrawal</h3>
        <p>You're withdrawing your full available balance of
           <b>${esc(fmtCentavos(availableCentavos))}</b>.
           A <b>${esc(fmtCentavos(feeCentavos))}</b> processing fee applies —
           you'll receive <b>${esc(fmtCentavos(availableCentavos - feeCentavos))}</b>.</p>
        <button type="button" class="btn-primary" id="walConfirmBtn">
          Withdraw ${esc(fmtCentavos(availableCentavos))}
        </button>
        <button type="button" class="wal-cancel" id="walCancelBtn">Cancel</button>
      </div>
    </div>`;

  const close = () => {
    host.classList.remove('open');
    closeOverlay('walletConfirm');
    setTimeout(() => { if (!host.classList.contains('open')) host.innerHTML = ''; }, 320);
  };

  requestAnimationFrame(() => host.classList.add('open'));
  openOverlay('walletConfirm', close);
  // onclick assignment (not addEventListener): the backdrop element persists
  // across opens, so a listener per open would pile up stale closures.
  host.onclick = (e) => { if (e.target === host) close(); };
  host.querySelector('#walCancelBtn')?.addEventListener('click', close);
  host.querySelector('#walConfirmBtn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Requesting…';
    await submitWithdrawal();
    close();
  });
}

async function submitWithdrawal() {
  const token = getSession()?.token;
  if (!token) { showToast('Please sign in again.'); return; }
  try {
    const { data, error } = await sb().rpc('request_withdrawal', { p_session_token: token });
    if (error) throw error;
    if (data?.ok === true) {
      showToast('Withdrawal requested ✓');
    } else {
      showToast(reasonText(data?.reason, data?.fee_centavos ?? 5000));
    }
  } catch (e) {
    console.warn('[wallet] request_withdrawal failed', e);
    showToast('Could not send the request. Please try again.');
  }
  // Either way, re-read the wallet so the screen reflects the server's truth.
  const host = document.getElementById('walletScreen');
  if (host && host.classList.contains('open')) refreshWallet(host);
}
