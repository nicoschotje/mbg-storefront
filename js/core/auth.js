/* MBG Storefront v2 — Auth (PIN + WebAuthn)
 * Uses RPCs from old storefront:
 *   verify_customer_pin, validate_customer_session,
 *   webauthn_auth_challenge, webauthn_auth_complete,
 *   webauthn_register_challenge, webauthn_register_complete,
 *   create_remember_token, login_with_remember_token,
 *   revoke_remember_tokens, logout_customer_session
 */

import { sb, logActivity } from './supabase.js';
import { showToast, esc, normalisePhone, isValidPHPhone, bufferToBase64url, base64urlToBuffer, isInAppBrowser } from './utils.js';
import { LOGIN_FAIL_LIMIT, LOGIN_LOCKOUT_MS, PIN_MIN_LENGTH, PIN_MAX_LENGTH } from './config.js';

let _session = null;
let _phone = null;
let _failCount = 0;
let _lockedUntil = 0;
const subscribers = [];

export function getSession()       { return _session; }
export function getAuthPhone()     { return _phone; }
export function isAuthenticated()  { return !!_session; }

export function onAuthChange(fn) {
  subscribers.push(fn);
  return () => {
    const i = subscribers.indexOf(fn);
    if (i >= 0) subscribers.splice(i, 1);
  };
}

function emit() {
  subscribers.forEach(fn => { try { fn(_session, _phone); } catch(_){} });
}

// ── Login UI binding ──────────────────────────────────────
// Pass DOM ids; the function wires up handlers and renders error states.
export function bindLoginScreen({ phoneInputId, pinInputId, submitBtnId, biometricBtnId, errorElId, onLoggedIn }) {
  const phoneEl  = document.getElementById(phoneInputId);
  const pinEl    = document.getElementById(pinInputId);
  const submit   = document.getElementById(submitBtnId);
  const bio      = biometricBtnId ? document.getElementById(biometricBtnId) : null;
  const errEl    = document.getElementById(errorElId);

  const showErr = (msg) => {
    if (!errEl) return;
    errEl.textContent = msg;
    errEl.classList.add('show');
  };
  const hideErr = () => { if (errEl) errEl.classList.remove('show'); };

  // Pre-fill phone from last login
  try {
    const saved = localStorage.getItem('mg_auth_phone');
    if (saved && phoneEl && !phoneEl.value) phoneEl.value = saved;
  } catch(_) {}

  // Hide biometric button if browser doesn't support WebAuthn or in-app
  if (bio) {
    if (!window.PublicKeyCredential || isInAppBrowser()) {
      bio.style.display = 'none';
    }
  }

  submit?.addEventListener('click', async (ev) => {
    ev.preventDefault();
    hideErr();

    if (Date.now() < _lockedUntil) {
      const secs = Math.ceil((_lockedUntil - Date.now())/1000);
      const mins = Math.ceil(secs/60);
      showErr(`Too many attempts. Try again in ${mins>1?mins+' min':secs+'s'}.`);
      return;
    }

    const phone = normalisePhone(phoneEl?.value?.trim() || '');
    const pin   = (pinEl?.value || '').trim();

    if (!phone) { showErr('Please enter your phone number.'); return; }
    if (!isValidPHPhone(phone)) {
      // Tell the user *what's* wrong with their number rather than the
      // generic "valid Philippine number" — that's the message that
      // tripped real customers whose phone was actually fine.
      showErr('That doesn’t look like a Philippine mobile. Use 09XX XXX XXXX or +63 9XX XXX XXXX.');
      return;
    }
    if (pin.length < PIN_MIN_LENGTH || pin.length > PIN_MAX_LENGTH) {
      showErr(`PIN must be ${PIN_MIN_LENGTH}–${PIN_MAX_LENGTH} digits.`); return;
    }

    submit.disabled = true;
    submit.dataset.label = submit.textContent;
    submit.innerHTML = '<span class="spinner"></span> Verifying…';

    try {
      const { data, error } = await sb().rpc('verify_customer_pin', {
        p_phone: phone,
        p_pin: pin,
        p_device_info: (navigator.userAgent || '').slice(0, 120),
        p_ip_address: null
      });
      if (error) throw error;

      if (!data?.success) {
        _failCount++;
        if (_failCount >= LOGIN_FAIL_LIMIT) {
          _lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
          _failCount = 0;
        }
        showErr(data?.error || 'Wrong PIN. Try again.');
        return;
      }

      _setSession(data, phone);

      // Clear PIN from DOM immediately
      if (pinEl) pinEl.value = '';

      onLoggedIn?.(_session);
    } catch(e) {
      console.error('[auth] PIN login error', e);
      showErr('Login failed. Please try again.');
    } finally {
      submit.disabled = false;
      submit.textContent = submit.dataset.label || 'Sign in';
    }
  });

  // Biometric (WebAuthn) login
  bio?.addEventListener('click', async () => {
    hideErr();
    const phone = normalisePhone(phoneEl?.value?.trim() || '');
    if (!phone) { showErr('Enter your phone number first.'); return; }
    if (!window.PublicKeyCredential) {
      showErr('Biometric not supported in this browser. Use PIN instead.');
      return;
    }

    bio.disabled = true;
    try {
      const { data: ch, error: chErr } = await sb().rpc('webauthn_auth_challenge', { p_phone: phone });
      if (chErr) throw chErr;
      if (!ch?.success) {
        showErr(ch?.error || 'No biometric registered for this number. Sign in with PIN first.');
        return;
      }

      const allowCredentials = (ch.credentials || []).map(c => ({
        type: 'public-key',
        id: base64urlToBuffer(c.credential_id),
        transports: c.transports || ['internal']
      }));

      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge: base64urlToBuffer(ch.challenge),
          rpId: ch.rp_id,
          allowCredentials,
          userVerification: 'required',
          timeout: 60000
        }
      });

      const credentialId = bufferToBase64url(assertion.rawId);
      const signCount = new DataView(assertion.response.authenticatorData.slice(33, 37)).getUint32(0);

      const { data: authRes, error: authErr } = await sb().rpc('webauthn_auth_complete', {
        p_phone: phone,
        p_challenge: ch.challenge,
        p_credential_id: credentialId,
        p_sign_count: signCount,
        p_device_info: (navigator.userAgent || '').slice(0, 120),
        p_ip_address: null
      });
      if (authErr) throw authErr;
      if (!authRes?.success) { showErr(authRes?.error || 'Biometric failed.'); return; }

      _setSession(authRes, phone);
      onLoggedIn?.(_session);
    } catch(e) {
      console.error('[auth] WebAuthn login error', e);
      if (e.name === 'NotAllowedError') {
        showErr('Biometric cancelled. Use PIN instead.');
      } else {
        showErr('Biometric login failed. Try PIN.');
      }
    } finally {
      bio.disabled = false;
    }
  });
}

function _setSession(data, phone) {
  _session = {
    token:         data.session_token,
    customer_id:   data.customer_id,
    display_name:  data.display_name,
    phone:         data.phone || phone,
    saved_address: data.saved_address || null,
    expires_at:    data.expires_at,
    has_webauthn:  !!data.has_webauthn
  };
  _phone = phone;
  _failCount = 0;
  _lockedUntil = 0;

  try { sessionStorage.setItem('mg_session_token', _session.token); } catch(_) {}
  try { sessionStorage.setItem('mg_pin_hash', _session.customer_id || phone); } catch(_) {}
  try { localStorage.setItem('mg_auth_phone', phone); } catch(_) {}

  logActivity('login', { customer_id: _session.customer_id, has_webauthn: _session.has_webauthn });
  emit();
}

// Try to silently restore a session via remember-me token on app boot
export async function tryRestoreSession() {
  let token = null;
  try { token = localStorage.getItem('mg_remember_token'); } catch(_) {}
  if (!token) return null;

  try {
    // RPC signature: login_with_remember_token(p_token, p_device_info, p_ip_address)
    const { data, error } = await sb().rpc('login_with_remember_token', {
      p_token: token,
      p_device_info: (navigator.userAgent || '').slice(0, 120),
      p_ip_address: null
    });
    if (error || !data?.success) {
      // Bad/expired remember token — clean it up so we don't loop on boot
      try { localStorage.removeItem('mg_remember_token'); } catch(_) {}
      return null;
    }
    // RPC returns `phone`; fall back to localStorage for older deploys
    let restoredPhone = data.phone || '';
    if (!restoredPhone) {
      try { restoredPhone = localStorage.getItem('mg_auth_phone') || ''; } catch(_) {}
    }
    _setSession(data, restoredPhone);
    return _session;
  } catch(e) {
    console.warn('[auth] tryRestoreSession failed', e);
    return null;
  }
}

// Validate an existing session token (e.g. on resume)
export async function validateSession() {
  const t = _session?.token;
  if (!t) return false;
  try {
    // validate_customer_session returns { valid: bool, ... } — not { success }
    const { data, error } = await sb().rpc('validate_customer_session', { p_token: t });
    if (error || !data?.valid) { logout(); return false; }
    return true;
  } catch(_) { return false; }
}

// Optional: register WebAuthn credential after first PIN login
export async function registerBiometric() {
  if (!_session) { showToast('Please sign in first.'); return false; }
  if (!window.PublicKeyCredential) { showToast('Biometric not supported here.'); return false; }
  if (isInAppBrowser()) {
    showToast('Open in Safari/Chrome to enable Face ID.');
    return false;
  }

  try {
    const { data: reg, error: regErr } = await sb().rpc('webauthn_register_challenge', {
      p_session_token: _session.token
    });
    if (regErr) throw regErr;
    if (!reg?.success) throw new Error(reg?.error || 'register_challenge_failed');

    const userIdBytes = new Uint8Array(16);
    const hex = String(reg.customer_id || '').replace(/-/g, '');
    for (let i = 0; i < 16; i++) userIdBytes[i] = parseInt(hex.substr(i*2, 2), 16) || 0;

    const credential = await navigator.credentials.create({
      publicKey: {
        challenge: base64urlToBuffer(reg.challenge),
        rp:   { id: reg.rp_id, name: reg.rp_name || "Mr. Beanie's Greenies" },
        user: { id: userIdBytes, name: _phone, displayName: reg.display_name || _phone },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required',
          residentKey: 'preferred'
        },
        attestation: 'none',
        timeout: 60000
      }
    });

    const credentialId = bufferToBase64url(credential.rawId);
    const publicKey = bufferToBase64url(
      credential.response.getPublicKey
        ? credential.response.getPublicKey()
        : credential.response.attestationObject
    );

    let deviceName = 'Device';
    if (/iPhone|iPad/.test(navigator.userAgent)) deviceName = 'iPhone (Face ID)';
    else if (/Android/.test(navigator.userAgent))  deviceName = 'Android (Fingerprint)';
    else if (/Macintosh/.test(navigator.userAgent))deviceName = 'Mac (Touch ID)';

    const { data: done, error: doneErr } = await sb().rpc('webauthn_register_complete', {
      p_session_token: _session.token,
      p_challenge: reg.challenge,
      p_credential_id: credentialId,
      p_public_key: publicKey,
      p_device_name: deviceName,
      p_transports: ['internal']
    });
    if (doneErr) throw doneErr;
    if (!done?.success) throw new Error(done?.error || 'register_complete_failed');

    _session.has_webauthn = true;
    showToast('Biometric enabled.');
    return true;
  } catch(e) {
    console.warn('[auth] registerBiometric failed', e);
    showToast('Could not enable biometric.');
    return false;
  }
}

// Optional: enable a remember-me token for in-app browsers
export async function enableRememberMe() {
  if (!_session) return false;
  try {
    // RPC signature: create_remember_token(p_session_token, p_device_info)
    // RPC returns: { success, remember_token, expires_days }
    const { data, error } = await sb().rpc('create_remember_token', {
      p_session_token: _session.token,
      p_device_info: (navigator.userAgent || '').slice(0, 120)
    });
    if (error || !data?.success || !data?.remember_token) return false;
    try { localStorage.setItem('mg_remember_token', data.remember_token); } catch(_) {}
    return true;
  } catch(e) {
    console.warn('[auth] enableRememberMe failed', e);
    return false;
  }
}

export async function logout() {
  const t = _session?.token;
  _session = null;
  _phone = null;
  try { sessionStorage.removeItem('mg_session_token'); } catch(_) {}
  try { sessionStorage.removeItem('mg_pin_hash'); } catch(_) {}
  if (t) {
    try {
      await Promise.allSettled([
        sb().rpc('logout_customer_session', { p_token: t }),
        sb().rpc('revoke_remember_tokens', { p_session_token: t })
      ]);
    } catch(_) {}
  }
  try { localStorage.removeItem('mg_remember_token'); } catch(_) {}
  emit();
}

