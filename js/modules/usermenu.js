/* MBG Storefront v2 — User badge + account dropdown
 * Shows the logged-in customer's name (or phone) in the header as a small
 * badge. Tapping it opens a menu with two actions: My Orders + Sign Out.
 * Reads the existing auth session — it never makes its own Supabase call.
 */
import { esc } from '../core/utils.js?v=20260520-polish';
import { getSession, getAuthPhone, logout } from '../core/auth.js?v=20260520-polish';

let _menuEl = null;
let _globalsBound = false;

function badgeLabel(session) {
  const name = (session?.display_name || '').trim();
  if (name) return name;
  return session?.phone || getAuthPhone() || 'Account';
}

function closeDropdown() {
  const dd  = document.getElementById('userDropdown');
  const btn = document.getElementById('userBadgeBtn');
  if (dd)  dd.hidden = true;
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

// Outside-tap and Escape close the menu. Bound once, not per render.
function bindGlobals() {
  if (_globalsBound) return;
  _globalsBound = true;
  document.addEventListener('click', (e) => {
    if (_menuEl && !_menuEl.contains(e.target)) closeDropdown();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDropdown();
  });
}

export function renderUserMenu(targetEl, { onOrders } = {}) {
  if (!targetEl) return;
  _menuEl = targetEl;

  const session = getSession();
  if (!session) {
    targetEl.hidden = true;
    targetEl.innerHTML = '';
    return;
  }

  targetEl.hidden = false;
  targetEl.innerHTML = `
    <button type="button" class="user-badge" id="userBadgeBtn" aria-haspopup="true" aria-expanded="false">
      <span class="user-badge-dot" aria-hidden="true"></span>
      <span class="user-badge-label">${esc(badgeLabel(session))}</span>
      <svg class="user-badge-caret" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
    </button>
    <div class="user-dropdown" id="userDropdown" role="menu" hidden>
      <button type="button" class="user-dropdown-item" id="userMenuOrders" role="menuitem">My Orders</button>
      <button type="button" class="user-dropdown-item user-dropdown-danger" id="userMenuSignout" role="menuitem">Sign Out</button>
    </div>`;

  const btn      = targetEl.querySelector('#userBadgeBtn');
  const dropdown = targetEl.querySelector('#userDropdown');

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = dropdown.hidden;
    dropdown.hidden = !willOpen;
    btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    if (willOpen) {
      // Let optional account-area modules (e.g. the agent wallet) add their
      // own entries — same contract as the bottom-nav sheet's mbg:accountSheet.
      document.dispatchEvent(new CustomEvent('mbg:userMenu', {
        detail: { menu: dropdown, close: closeDropdown }
      }));
    }
  });

  targetEl.querySelector('#userMenuOrders').addEventListener('click', () => {
    closeDropdown();
    onOrders?.();
  });

  targetEl.querySelector('#userMenuSignout').addEventListener('click', async () => {
    closeDropdown();
    await logout();
    location.reload();
  });

  bindGlobals();
}
