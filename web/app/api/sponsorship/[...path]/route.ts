import { NextRequest, NextResponse } from 'next/server';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
async function handle(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const route = path.join('/');
  const allowed = request.method === 'GET' ? /^(config|operations\/[0-9a-f-]{36})$/ : /^(prepare|submit)$/;
  if (!allowed.test(route)) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  const origin = request.headers.get('origin');
  if (request.method === 'POST' && origin && origin !== request.nextUrl.origin && origin !== process.env.WEB_ORIGIN)
    return NextResponse.json({ error: 'Origin is not allowed.' }, { status: 403 });
  if (!process.env.SPONSOR_API_URL) return NextResponse.json({ error: 'Sponsorship is unavailable.' }, { status: 503 });
  try {
    let body: string | undefined;
    if (request.method === 'POST') {
      if (!request.headers.get('content-type')?.startsWith('application/json')) return NextResponse.json({ error: 'JSON is required.' }, { status: 415 });
      if (Number(request.headers.get('content-length') ?? 0) > 2048) return NextResponse.json({ error: 'Request too large.' }, { status: 413 });
      body = await request.text();
      if (new TextEncoder().encode(body).length > 2048) return NextResponse.json({ error: 'Request too large.' }, { status: 413 });
    }
    const upstream = await fetch(`${process.env.SPONSOR_API_URL.replace(/\/$/, '')}/${route}`, {
      method: request.method, headers: { 'content-type': 'application/json' }, body, cache: 'no-store', signal: AbortSignal.timeout(55000),
    });
    return NextResponse.json(await upstream.json(), { status: upstream.status, headers: { 'cache-control': 'no-store' } });
  } catch { return NextResponse.json({ error: 'Unable to reach the sponsor. Check this operation again before retrying.' }, { status: 503 }); }
}
export const GET = handle;
export const POST = handle;
