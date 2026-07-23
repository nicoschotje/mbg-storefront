// upload-receipt — KEEP-as-is port for mrbeanies-prod (P2).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const contentType = req.headers.get('content-type') || ''

    let fileBytes: Uint8Array
    let mimeType: string
    let ext: string

    if (contentType.includes('multipart/form-data')) {
      const formData = await req.formData()
      const file = formData.get('file') as File | null
      if (!file) throw new Error('No file in form data')
      const arrayBuf = await file.arrayBuffer()
      fileBytes = new Uint8Array(arrayBuf)
      mimeType = file.type || 'image/jpeg'
      ext = mimeType.split('/')[1]?.split('+')[0] || 'jpg'
    } else {
      const body = await req.json()
      if (!body.base64 || !body.mimeType) throw new Error('base64 and mimeType required')
      fileBytes = Uint8Array.from(atob(body.base64), (c) => c.charCodeAt(0))
      mimeType = body.mimeType
      ext = mimeType.split('/')[1]?.split('+')[0] || 'jpg'
    }

    const path = `receipts/${Date.now()}.${ext}`

    const { error } = await supabase.storage
      .from('payment-receipts')
      .upload(path, fileBytes, { contentType: mimeType, upsert: false })

    if (error) throw error

    const { data: { publicUrl } } = supabase.storage
      .from('payment-receipts')
      .getPublicUrl(path)

    return new Response(
      JSON.stringify({ success: true, url: publicUrl }),
      { headers: { ...cors, 'Content-Type': 'application/json' } }
    )
  } catch (err: any) {
    console.error('upload-receipt error:', err.message)
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } }
    )
  }
})
