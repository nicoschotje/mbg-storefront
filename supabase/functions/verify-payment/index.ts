// MBG — verify-payment edge function
// Phase 2 M3: OCR auto-match now considers amount AND reference (= order_number).
// Amount remains the primary signal (verified when detected ≈ expected). The
// order reference is used (a) to recover a verify when the amount parser misses
// but the exact expected amount + our reference are both present on the receipt,
// and (b) to raise confidence. expected_reference (= order_number) and
// expected_amount continue to be written to payment_verifications.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const OCR_API_KEY  = Deno.env.get('OCR_SPACE_API_KEY') || 'helloworld';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    const form = await req.formData();
    const orderRef      = String(form.get('order_ref') || '').trim();
    const paymentMethod = String(form.get('payment_method') || 'gcash').trim().toLowerCase();
    const file = form.get('file') as File | null;

    if (!orderRef) return err('Missing order_ref', 400);
    if (!file)     return err('Missing file', 400);
    if (file.size > 10 * 1024 * 1024) return err('File too large (max 10 MB)', 400);

    const isUUID = /^[0-9a-f-]{36}$/i.test(orderRef);
    const { data: order, error: orderErr } = await admin
      .from('orders').select('id, order_number, total').eq(isUUID ? 'id' : 'order_number', orderRef).maybeSingle();
    if (orderErr || !order) return err(`Order not found: ${orderRef}`, 404);

    const methodMap: Record<string,string> = { maya:'paymaya', bank:'bank_transfer', crypto:'usdt', usdc:'usdt' };
    const normMethod = methodMap[paymentMethod] || paymentMethod;

    const ext  = file.type.includes('png') ? 'png' : file.type.includes('webp') ? 'webp' : 'jpg';
    const path = `${order.id}/${Date.now()}.${ext}`;
    const bytes = await file.arrayBuffer();

    const { error: upErr } = await admin.storage.from('payment-screenshots')
      .upload(path, bytes, { contentType: file.type, upsert: false });
    if (upErr) return err(`Upload failed: ${upErr.message}`, 500);

    const { data: signed } = await admin.storage.from('payment-screenshots').createSignedUrl(path, 604800);
    const screenshotUrl = signed?.signedUrl || path;

    const ocrForm = new FormData();
    ocrForm.append('apikey', OCR_API_KEY);
    ocrForm.append('language', 'eng');
    ocrForm.append('isOverlayRequired', 'false');
    ocrForm.append('detectOrientation', 'true');
    ocrForm.append('scale', 'true');
    ocrForm.append('OCREngine', '2');
    ocrForm.append('file', new Blob([bytes], { type: file.type }), `receipt.${ext}`);

    let ocrText = ''; let ocrConf = 0;
    try {
      const ocrRes  = await fetch('https://api.ocr.space/parse/image', { method: 'POST', body: ocrForm });
      const ocrData = await ocrRes.json();
      ocrText = ocrData?.ParsedResults?.[0]?.ParsedText || '';
      ocrConf = ocrText ? 80 : 40;
    } catch(e) { console.error('[verify-payment] OCR error', e); }

    const detected = parseOCR(ocrText);
    const expected = Number(order.total);
    const refMatched = referenceMatches(ocrText, order.order_number);

    let status = 'manual_review'; let mismatch: string | null = null;
    if (detected.amount !== null && Math.abs(detected.amount - expected) <= 0.50) {
      status = 'verified';
    } else if (detected.amount !== null) {
      status = 'mismatch';
      mismatch = `Expected ₱${expected.toFixed(2)}, detected ₱${detected.amount.toFixed(2)}`;
    } else if (refMatched && amountAppears(ocrText, expected)) {
      // Amount parser missed it, but the order reference AND the exact expected
      // amount are both present on the receipt → confident enough to auto-verify.
      status = 'verified';
    } else {
      mismatch = refMatched
        ? 'Order reference matched but the amount could not be read — please confirm'
        : 'Could not extract amount from screenshot';
    }
    // Amount + reference together is the strongest signal — reflect that in confidence.
    if (refMatched && ocrText) ocrConf = Math.max(ocrConf, 90);

    await admin.from('payment_verifications').insert({
      order_id: order.id, payment_method: normMethod,
      expected_amount: expected, expected_reference: order.order_number,
      detected_amount: detected.amount, detected_currency: 'PHP',
      detected_reference: detected.reference, detected_recipient: detected.recipient,
      detected_timestamp: detected.timestamp,
      screenshot_url: screenshotUrl, ocr_text_full: ocrText.slice(0, 4000),
      ocr_confidence: ocrConf, ocr_provider: 'ocr.space',
      status, mismatch_reason: mismatch,
      verified_at: status === 'verified' ? new Date().toISOString() : null,
    });

    if (status === 'verified') {
      // Do NOT write receipt_url here. The order already holds the permanent
      // public payment-receipts URL set at checkout by the upload-receipt
      // function. The signed payment-screenshots URL above expires after
      // 7 days, so writing it would silently break the dashboard's receipt
      // image a week after the order. Only flag the payment as paid.
      await admin.from('orders').update({ payment_status: 'paid' }).eq('id', order.id);
    }

    return new Response(JSON.stringify({
      status, order_number: order.order_number,
      expected_amount: expected, detected_amount: detected.amount,
      detected_reference: detected.reference, reference_matched: refMatched,
      mismatch_reason: mismatch, screenshot_url: screenshotUrl,
    }), { headers: { ...CORS, 'Content-Type': 'application/json' }, status: 200 });

  } catch(e: any) {
    console.error('[verify-payment] unhandled', e);
    return err(e.message || 'Internal error', 500);
  }
});

// True when the order reference (order_number, e.g. "MG-357") appears on the
// receipt: either as the joined alphanumeric form ("MG357") anywhere, or as the
// numeric part ("357") as a standalone token (so it doesn't match a substring
// of a long transaction id).
function referenceMatches(text: string, orderNumber: string): boolean {
  if (!text || !orderNumber) return false;
  const norm = (s: string) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const full = norm(orderNumber);
  if (full.length >= 4 && norm(text).includes(full)) return true;
  const digits = (String(orderNumber).match(/\d+/g) || []).join('');
  if (digits.length >= 3 && new RegExp('(^|[^0-9])' + digits + '([^0-9]|$)').test(String(text))) return true;
  return false;
}

// True when the exact expected amount (e.g. 555.00 / 555) appears in the text.
function amountAppears(text: string, expected: number): boolean {
  const t = String(text).replace(/,/g, '');
  const twodp = expected.toFixed(2);
  const whole = Math.round(expected).toString();
  return t.includes(twodp) || new RegExp('(^|[^0-9])' + whole + '([^0-9]|$)').test(t);
}

function parseOCR(text: string) {
  const t = text.replace(/,/g,'').replace(/\s+/g,' ');
  let amount: number | null = null;
  for (const p of [/(?:PHP|₱|Php)\s*([\d]+(?:\.\d{1,2})?)/i,/Amount[:\s]+([\d]+(?:\.\d{1,2})?)/i,/Total[:\s]+([\d]+(?:\.\d{1,2})?)/i,/Paid[:\s]+([\d]+(?:\.\d{1,2})?)/i,/You\s+(?:paid|sent)[:\s]+([\d]+(?:\.\d{1,2})?)/i,/([\d]{3,6}\.\d{2})/]) {
    const m = t.match(p); if (m) { amount = parseFloat(m[1]); break; }
  }
  let reference: string | null = null;
  for (const p of [/Ref(?:erence)?(?:\s*No\.?)?[:\s]+([A-Z0-9]{8,})/i,/Transaction\s+(?:ID|No)[:\s]+([A-Z0-9]{8,})/i,/\b([0-9]{10,16})\b/]) {
    const m = t.match(p); if (m) { reference = m[1]; break; }
  }
  let recipient: string | null = null;
  for (const p of [/To[:\s]+([A-Z][A-Za-z\s]{3,30})/,/Paid\s+to[:\s]+([A-Z][A-Za-z\s]{3,30})/i]) {
    const m = t.match(p); if (m) { recipient = m[1].trim(); break; }
  }
  let timestamp: string | null = null;
  for (const p of [/(\d{1,2}\/\d{1,2}\/\d{2,4}\s+\d{1,2}:\d{2}(?:\s*[APap][Mm])?)/,(/(\w+ \d{1,2},\s*\d{4}\s+\d{1,2}:\d{2}(?:\s*[APap][Mm])?)/)]) {
    const m = t.match(p); if (m) { timestamp = m[1]; break; }
  }
  return { amount, reference, recipient, timestamp };
}

function err(msg: string, status = 400) {
  return new Response(JSON.stringify({ error: msg }), { headers: { ...CORS, 'Content-Type': 'application/json' }, status });
}
