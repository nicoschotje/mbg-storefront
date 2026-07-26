/* Headless-drive stub for @supabase/supabase-js@2/+esm.
 *
 * Served by the harness IN PLACE of the jsDelivr ESM module (route
 * interception), so the real app boots with zero network / zero database.
 * Fixtures live on window.__MBG_FIX (installed via addInitScript by the
 * harness); every from()/rpc() answers from that registry.
 *
 * Builder contract (see js/ call sites): every chain method returns the
 * builder; the builder is await-able (then) and resolves { data, error }.
 */

export function createClient(_url, _key, _opts) {
  const FIX = () => (window.__MBG_FIX || { tables: {}, rpcs: {} });

  function tableBuilder(table) {
    const state = { table, single: false, filters: [] };
    const b = {
      select() { return b; },
      insert(row) { state.insert = row; return b; },
      eq(col, val) { state.filters.push([col, val]); return b; },
      order() { return b; },
      limit() { return b; },
      single() { state.single = true; return b; },
      maybeSingle() { state.single = true; return b; },
      then(resolve, reject) {
        try {
          let rows = FIX().tables[state.table];
          rows = (typeof rows === 'function') ? rows(state) : rows;
          if (rows == null) rows = [];
          if (state.insert) { resolve({ data: state.insert, error: null }); return; }
          for (const [col, val] of state.filters) {
            rows = rows.filter(r => r[col] === val);
          }
          const data = state.single ? (rows[0] ?? null) : rows;
          resolve({ data, error: null });
        } catch (e) {
          if (reject) reject(e); else resolve({ data: null, error: { message: String(e) } });
        }
      },
    };
    return b;
  }

  return {
    from: (table) => tableBuilder(table),
    rpc: async (name, args) => {
      const fn = FIX().rpcs[name];
      if (!fn) return { data: null, error: { message: `stub: no rpc ${name}` } };
      const data = (typeof fn === 'function') ? fn(args) : fn;
      return { data, error: null };
    },
    channel: () => {
      const ch = { on: () => ch, subscribe: () => ch, unsubscribe: () => ch };
      return ch;
    },
  };
}

export default { createClient };
