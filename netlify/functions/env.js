// Runtime env injection for the storefront.
// Exposes the public Google Maps client key to the browser as a global.
// The key is a public client-side key — it is locked down by HTTP-referrer
// (domain) restrictions in Google Cloud Console, not by secrecy — so it is
// safe to serve it inline here rather than baking it into committed source.
exports.handler = async () => {
  const key = process.env.GOOGLE_MAPS_API_KEY || '';
  if (!key) {
    console.warn('[env] GOOGLE_MAPS_API_KEY is not set — serving empty key');
  }
  const body = 'window.__MBG_ENV__ = { GOOGLE_MAPS_API_KEY: '
    + JSON.stringify(key) + ' };';
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/javascript',
      'Cache-Control': 'no-store',
    },
    body,
  };
};
