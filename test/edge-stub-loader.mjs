// Test-only ESM loader for the place-order EDGE FUNCTION. Redirects its two
// Deno-runtime URL imports to in-memory stubs so the REAL
// supabase/functions/place-order/index.ts can run under Node (with
// --experimental-strip-types). serve() hands the request handler to the test;
// createClient() hands back whatever Supabase mock the current test installed.
const STUBS = {
  serve: `export function serve(h){ globalThis.__edgeHandler = h; }`,
  supabase: `export function createClient(){ return globalThis.__sbMock; }`,
};

export async function resolve(spec, ctx, next) {
  if (spec.startsWith('https://deno.land/std'))          return { url: 'edgestub:serve',    shortCircuit: true };
  if (spec.startsWith('https://esm.sh/@supabase/supabase-js')) return { url: 'edgestub:supabase', shortCircuit: true };
  return next(spec, ctx);
}

export async function load(url, ctx, next) {
  if (url.startsWith('edgestub:')) {
    return { format: 'module', source: STUBS[url.slice('edgestub:'.length)], shortCircuit: true };
  }
  return next(url, ctx);
}
