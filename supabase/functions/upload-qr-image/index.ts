// upload-qr-image — KEEP-as-is port for mrbeanies-prod (P2).
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPA_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BUCKET = 'qr-images';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { base64, mimeType } = await req.json();
    if (!base64 || !mimeType) {
      return new Response(JSON.stringify({ error: 'base64 and mimeType required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const admin = createClient(SUPA_URL, SERVICE_KEY);

    const { data: buckets } = await admin.storage.listBuckets();
    const exists = buckets?.some(b => b.name === BUCKET);
    if (!exists) {
      await admin.storage.createBucket(BUCKET, { public: true, fileSizeLimit: 2097152 });
    } else {
      await admin.storage.updateBucket(BUCKET, { public: true });
    }

    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const ext = mimeType.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
    const filename = `qr-${Date.now()}.${ext}`;

    const { error: upErr } = await admin.storage
      .from(BUCKET)
      .upload(filename, bytes, { contentType: mimeType, upsert: true });

    if (upErr) {
      return new Response(JSON.stringify({ error: upErr.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const { data: { publicUrl } } = admin.storage.from(BUCKET).getPublicUrl(filename);

    return new Response(JSON.stringify({ url: publicUrl }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
