/* MBG Storefront — Mobile bottom navigation
 * Three tabs: Shop / Cart / Account. The Cart tab is opened by the shared
 * cart trigger (see bindCartTriggers in cart.js); this module wires the
 * Shop scroll-to-grid and the Account slide-up sheet.
 */
import { openOverlay, closeOverlay, showToast } from '../core/utils.js?v=20260520-polish';
import { getSession } from '../core/auth.js?v=20260520-polish';

let _cb = {};

export function initBottomNav(callbacks = {}) {
  _cb = callbacks;
  const nav = document.getElementById('bottomNav');
  if (!nav) return;
  nav.querySelectorAll('.bn-tab').forEach(tab => {
    tab.addEventListener('click', () => onTab(tab.dataset.tab));
  });
}

function onTab(name) {
  if (name === 'shop') {
    _cb.onShop?.();
  } else if (name === 'orders') {
    if (!getSession()) { showToast('Sign in to view your orders'); return; }
    _cb.onOrders?.();
  } else if (name === 'account') {
    if (!getSession()) { showToast('Sign in to view your account'); return; }
    openAccountSheet();
  }
  // 'cart' is handled by the shared cart trigger
}

function openAccountSheet() {
  let host = document.getElementById('accountSheet');
  if (!host) {
    host = document.createElement('div');
    host.id = 'accountSheet';
    host.className = 'modal-backdrop';
    document.body.appendChild(host);
  }
  host.innerHTML = `
    <div class="modal-sheet modal-sheet-sm" role="dialog" aria-label="Account">
      <div class="modal-handle" aria-hidden="true"></div>
      <div class="acct-sheet">
        <h3 class="acct-title">My Account</h3>
        <button type="button" class="acct-item" data-act="orders">
          <span class="acct-ico" aria-hidden="true">📦</span><span>My Orders</span>
        </button>
        <button type="button" class="acct-item acct-item-danger" data-act="signout">
          <span class="acct-ico" aria-hidden="true">↪</span><span>Sign Out</span>
        </button>
      </div>
    </div>`;
  requestAnimationFrame(() => host.classList.add('open'));
  document.body.classList.add('lock-scroll');
  openOverlay('accountSheet', closeAccountSheet);

  host.addEventListener('click', (e) => { if (e.target === host) closeAccountSheet(); });
  host.querySelector('[data-act="orders"]')?.addEventListener('click', () => {
    closeAccountSheet();
    _cb.onOrders?.();
  });
  host.querySelector('[data-act="signout"]')?.addEventListener('click', () => {
    closeAccountSheet();
    _cb.onSignOut?.();
  });

  // Let optional account-area modules (e.g. the agent wallet) add their own
  // entries without this module knowing about them.
  document.dispatchEvent(new CustomEvent('mbg:accountSheet', {
    detail: { sheet: host, close: closeAccountSheet }
  }));
}

function closeAccountSheet() {
  const host = document.getElementById('accountSheet');
  if (!host) return;
  host.classList.remove('open');
  document.body.classList.remove('lock-scroll');
  closeOverlay('accountSheet');
  setTimeout(() => {
    if (host && !host.classList.contains('open')) host.innerHTML = '';
  }, 320);
}
