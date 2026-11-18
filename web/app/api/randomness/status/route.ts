import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const url = process.env.RANDOMNESS_KEEPER_URL;
  if (!url) return NextResponse.json({ error: 'Randomness status is unavailable.' }, { status: 503 });
  try {
    // This upstream exposes public, read-only status. Signing keys stay in EKS.
    const response = await fetch(`${url.replace(/\/$/, '')}/status`, {
      cache: 'no-store', signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error('Keeper status unavailable');
    return NextResponse.json(await response.json(), { headers: { 'cache-control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Unable to reach the randomness keeper.' }, { status: 503 });
  }
}
