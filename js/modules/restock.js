/* MBG Storefront v2 — Restock notifications */
import { sb } from '../core/supabase.js?v=20260608-audit';
import { esc, normalisePhone, isValidPHPhone, openOverlay, closeOverlay, showToast } from '../core/utils.js?v=20260608-audit';
import { getAuthPhone } from '../core/auth.js?v=20260608-audit';

export function openRestockModal(product) {
  let host = document.getElementById('restockModal');
  if (!host) {
    host = document.createElement('div');
    host.id = 'restockModal';
    host.className = 'modal-backdrop';
    document.body.appendChild(host);
  }
  const prefill = getAuthPhone() || '';
  host.innerHTML = `
    <div class="modal-sheet modal-sheet-sm" role="dialog" aria-label="Notify me">
      <div class="modal-handle" aria-hidden="true"></div>
      <button class="modal-close" aria-label="Close">×</button>
      <div class="modal-body">
        <h2 class="modal-title">Notify me when back</h2>
        <p class="modal-desc">We&rsquo;ll text you the moment <b>${esc(product.name)}</b> is restocked.</p>
        <label class="field">
          <span>Phone number</span>
          <input id="rsPhone" type="tel" inputmode="tel" placeholder="+63 9XX XXX XXXX" value="${esc(prefill)}"/>
        </label>
        <button id="rsSubmit" class="btn-primary" type="button">Notify me</button>
      </div>
    </div>`;
  requestAnimationFrame(() => host.classList.add('open'));
  openOverlay('restockModal', closeRestockModal);

  const close = () => closeRestockModal();
  host.addEventListener('click', e => { if (e.target === host) close(); });
  host.querySelector('.modal-close')?.addEventListener('click', close);
  host.querySelector('#rsSubmit')?.addEventListener('click', async () => {
    const phone = normalisePhone(host.querySelector('#rsPhone').value.trim());
    if (!isValidPHPhone(phone)) { showToast('Enter a valid PH mobile number'); return; }
    const btn = host.querySelector('#rsSubmit');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      // Schema: restock_notifications(product_id uuid, name text, contact text, contact_type text)
      // — NOT product_name / phone (legacy column names from old storefront)
      const { error } = await sb().from('restock_notifications').insert({
        product_id:   product.id,
        name:         product.name,
        contact:      phone,
        contact_type: 'phone'
      });
      if (error) throw error;
      showToast(`We'll let you know when ${product.name} is back.`);
      close();
    } catch(e) {
      console.error('[restock] insert failed', e);
      showToast('Could not save your request.');
    } finally {
      btn.disabled = false; btn.textContent = 'Notify me';
    }
  });
}

export function closeRestockModal() {
  const host = document.getElementById('restockModal');
  if (!host) return;
  host.classList.remove('open');
  closeOverlay('restockModal');
  setTimeout(() => { if (host && !host.classList.contains('open')) host.innerHTML = ''; }, 280);
}

