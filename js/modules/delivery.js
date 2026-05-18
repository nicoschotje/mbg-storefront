/* MBG Storefront v2 — Distance-based delivery calculator
 *
 * Replaces flat-rate zone pricing. The fee is derived from the real
 * road-ish distance between the store pickup point and the customer's
 * selected address coordinates.
 *
 *   base_fare         = ₱55 (fixed)
 *   distance_km       = Haversine(store, customer)
 *   estimated_minutes = (distance_km / 30) * 60   (30 km/h avg speed)
 *   raw_fare          = base_fare + distance_km*15 + estimated_minutes*2
 *   final_fare        = ceil(raw_fare * surge_multiplier)
 *   minimum           = base_fare (never charge below ₱55)
 *
 * Zero dependencies — pure math, safe to import anywhere.
 *
 * Self-check (Store 14.6007,121.0827 → QC 14.6490,121.0273):
 *   distance ≈ 8.0 km, estMin ≈ 16, raw ≈ 55 + 120 + 32 ≈ 207.6,
 *   ×1 surge → ceil ≈ ₱208  (×2.5 surge → ₱519).
 * Store → Cebu (10.2929,123.9004): distance ≈ 568 km (provincial, very far).
 */

const BASE_FARE = 55;          // PHP, fixed
const PER_KM = 15;             // PHP per km
const PER_MINUTE = 2;          // PHP per estimated minute
const AVG_SPEED_KMH = 30;      // assumed average delivery speed
const VALID_SURGE = [1, 1.5, 2, 2.5, 3];

// Great-circle distance between two lat/lng points, in kilometres.
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371; // Earth radius, km
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Calculate the delivery fee.
 * @param {object} args
 * @param {number} args.storeLat
 * @param {number} args.storeLng
 * @param {number|null} args.customerLat   null if no suggestion was picked
 * @param {number|null} args.customerLng
 * @param {number} args.subtotal
 * @param {number} args.surgeMultiplier    store_settings.delivery_rate_multiplier
 * @param {number} args.freeDeliveryMin    store_settings.free_delivery_min
 * @param {number} args.fallbackFee        store_settings.delivery_fee (flat rate)
 * @returns {{ fee:number, distanceKm:number, label:string }}
 */
export function calculateDelivery({
  storeLat, storeLng, customerLat, customerLng,
  subtotal, surgeMultiplier, freeDeliveryMin, fallbackFee
}) {
  const surge = VALID_SURGE.includes(Number(surgeMultiplier))
    ? Number(surgeMultiplier)
    : 1;
  const freeMin = Number(freeDeliveryMin) || 0;
  const sub = Number(subtotal) || 0;
  const qualifiesFree = freeMin > 0 && sub >= freeMin;

  const hasCoords =
    Number.isFinite(customerLat) && Number.isFinite(customerLng) &&
    Number.isFinite(storeLat) && Number.isFinite(storeLng);

  // ── Fallback: no customer coords → flat-rate fee from store_settings ──
  if (!hasCoords) {
    const flat = Math.max(0, Number(fallbackFee) || 0);
    if (qualifiesFree) {
      return { fee: 0, distanceKm: 0, label: 'Free delivery' };
    }
    return {
      fee: flat,
      distanceKm: 0,
      label: `₱${flat} (estimated)`
    };
  }

  // ── Distance-based calculation ──
  const distanceKm = haversineKm(storeLat, storeLng, customerLat, customerLng);
  const estimatedMinutes = (distanceKm / AVG_SPEED_KMH) * 60;
  const rawFare = BASE_FARE + distanceKm * PER_KM + estimatedMinutes * PER_MINUTE;
  let fee = Math.ceil(rawFare * surge);
  if (fee < BASE_FARE) fee = BASE_FARE; // never below base fare

  const roundedKm = Math.round(distanceKm * 10) / 10;

  if (qualifiesFree) {
    return { fee: 0, distanceKm: roundedKm, label: 'Free delivery' };
  }
  return {
    fee,
    distanceKm: roundedKm,
    label: `₱${fee} · ${roundedKm} km`
  };
}
