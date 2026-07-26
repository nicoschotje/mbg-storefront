// delivery-quote — Lalamove estimate-mode quote.
//
// Pulled into version control as part of claude/delivery-eta-fixes:
// adds store_settings.delivery_rate_multiplier (surge) to the final fee
// so the dashboard's Surge Multiplier setting actually takes effect.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'MrGreeniesStore/1.0 (delivery-quote)';

// Lalamove motorcycle rate card (estimate mode, no API key needed)
const BASE_FEE = 79;      // first 3 km
const BASE_KM  = 3;
const PER_KM   = 16;
const MAX_KM   = 30;
const TORTUOSITY = 1.35; // road distance ≈ straight-line × 1.35

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) *
            Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function calcFee(straightKm: number): { fee: number; km: string; breakdown: string } {
  const km = Math.round(straightKm * TORTUOSITY * 10) / 10;
  let fee: number;
  if (km <= BASE_KM) {
    fee = BASE_FEE;
  } else {
    fee = BASE_FEE + Math.ceil((km - BASE_KM) * PER_KM);
  }
  const breakdown = km <= BASE_KM
    ? `₱${BASE_FEE} base (within ${BASE_KM} km)`
    : `₱${BASE_FEE} base + ${(km - BASE_KM).toFixed(1)} km × ₱${PER_KM}/km`;
  return { fee, km: km.toFixed(1), breakdown };
}

async function geocodeAddress(street: string, barangay: string, city: string, zip: string): Promise<{ lat: number; lon: number } | null> {
  const queries = [
    [street, barangay, city, 'Philippines'].filter(Boolean).join(', '),
    [street, city, 'Philippines'].filter(Boolean).join(', '),
    [barangay, city, 'Metro Manila', 'Philippines'].filter(Boolean).join(', '),
    [city, 'Metro Manila', 'Philippines'].filter(Boolean).join(', '),
  ];

  for (const q of queries) {
    if (!q || q.length < 5) continue;
    const params = new URLSearchParams({
      q, format: 'json', limit: '3',
      countrycodes: 'ph', bounded: '1',
      viewbox: '120.90,14.35,121.20,14.80',
    });
    try {
      const res = await fetch(`${NOMINATIM_URL}?${params}`, { headers: { 'User-Agent': USER_AGENT } });
      const results = await res.json();
      if (results.length > 0) {
        return { lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon) };
      }
    } catch (_) { /* try next */ }
    await new Promise(r => setTimeout(r, 1100));
  }
  return null;
}

Deno.serve(async (req: Request) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };

  if (req.method === 'OPTIONS') return new Response('ok', { headers });

  try {
    const body = await req.json();
    if (body.probe) return new Response(JSON.stringify({ ok: true }), { headers });

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );
    // Single select pulls store origin + surge multiplier.
    const { data: ss } = await supabase.from('store_settings')
      .select('store_lat, store_lng, delivery_rate_multiplier')
      .limit(1).single();
    const originLat  = parseFloat(ss?.store_lat ?? '14.6007');
    const originLng  = parseFloat(ss?.store_lng ?? '121.0827');
    const multiplier = Number(ss?.delivery_rate_multiplier ?? 1) || 1;

    const street   = (body.destination_street   || '').trim();
    const barangay = (body.destination_barangay  || '').trim();
    const city     = (body.destination_city      || '').trim();
    const zip      = (body.destination_zip       || '').trim();

    const resolvedCity = city ||
      (body.destination_address || '').split(',').map((s: string) => s.trim())
        .find((p: string) => /city|municipality/i.test(p)) || '';

    if (!resolvedCity) {
      return new Response(JSON.stringify({ fee: null, error: 'City / Municipality is required for delivery estimate.' }), { headers });
    }

    const coords = await geocodeAddress(street, barangay, resolvedCity, zip);
    if (!coords) {
      return new Response(JSON.stringify({ fee: null, error: 'Could not locate address. Please check the spelling or select your delivery zone manually.' }), { headers });
    }

    const straightKm = haversineKm(originLat, originLng, coords.lat, coords.lon);
    if (straightKm > MAX_KM * TORTUOSITY) {
      return new Response(JSON.stringify({ fee: null, error: `Address is outside our ${MAX_KM} km delivery range. Please contact us for provincial delivery.` }), { headers });
    }

    const raw = calcFee(straightKm);
    // Apply surge multiplier (1.0 means no change). Ceiling so the customer-
    // facing fee is an integer peso amount even after multiplication.
    const fee = Math.ceil(raw.fee * multiplier);
    const breakdown = multiplier !== 1
      ? `${raw.breakdown} × ×${multiplier} surge → ₱${fee}`
      : raw.breakdown;

    return new Response(JSON.stringify({
      fee,
      km: raw.km,
      breakdown,
      multiplier,
      raw_fee: raw.fee,
      mode: 'estimate',
      provider: 'lalamove_estimate',
    }), { headers });

  } catch (_err) {
    return new Response(JSON.stringify({ fee: null, error: 'Server error. Please select delivery zone manually.' }), { headers });
  }
});
