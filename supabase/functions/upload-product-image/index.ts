// upload-product-image — KEEP-as-is port for mrbeanies-prod (P2).
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const { base64, mimeType, folder } = await req.json()
    if (!base64 || !mimeType) {
      return new Response(JSON.stringify({ error: 'base64 and mimeType required' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    const SB = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    const bucket = 'product-images'
    const { data: buckets } = await SB.storage.listBuckets()
    const exists = buckets?.some((b: any) => b.name === bucket)
    if (!exists) {
      await SB.storage.createBucket(bucket, { public: true, fileSizeLimit: 10485760 })
    }

    const binary = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
    const ext = mimeType.split('/')[1]?.replace('jpeg','jpg') || 'jpg'
    const subfolder = folder || 'products'
    const filename = `${subfolder}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`

    const { error: uploadError } = await SB.storage.from(bucket).upload(filename, binary, {
      contentType: mimeType,
      upsert: true
    })

    if (uploadError) throw new Error(uploadError.message)

    const { data: { publicUrl } } = SB.storage.from(bucket).getPublicUrl(filename)

    return new Response(JSON.stringify({ success: true, url: publicUrl }), {
      headers: { ...cors, 'Content-Type': 'application/json' }
    })

  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' }
    })
  }
})
