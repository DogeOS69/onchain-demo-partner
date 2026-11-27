import { NextRequest, NextResponse } from 'next/server';
import { isAddress, recoverMessageAddress, type Hex } from 'viem';
function config() {
  const environment = process.env.DOGEOS_ENV || 'staging';
  const prefix = environment === 'prod' ? 'DOGEOS_PROD' : 'DOGEOS_STAGING';
  const apiUrl = process.env[`${prefix}_API_URL`];
  const apiKey = process.env[`${prefix}_PARTNER_API_KEY`];
  const questId = process.env[`${prefix}_EXTERNAL_QUEST_ID`];
  return { apiUrl, apiKey, questId, ready: ['staging','prod'].includes(environment) && !!apiUrl && !!apiKey && !!questId };
}
export async function GET() { const { ready, questId } = config(); return NextResponse.json({ ready, questId: ready ? questId : undefined }); }
export async function POST(request: NextRequest) {
  const { ready, apiUrl, apiKey, questId } = config();
  if (!ready) return NextResponse.json({ error: 'This external quest demo has not been configured yet.' }, { status: 503 });
  const origin = request.headers.get('origin');
  const expectedOrigin = process.env.WEB_ORIGIN ?? request.nextUrl.origin;
  if (origin !== expectedOrigin) return NextResponse.json({ error: 'Origin is not allowed.' }, { status: 403 });
  try {
    const text = await request.text();
    if (text.length > 2048) return NextResponse.json({ error: 'Request too large.' }, { status: 413 });
    const { walletAddress, issuedAt, signature } = JSON.parse(text);
    if (!isAddress(walletAddress ?? '') || !Number.isInteger(issuedAt) || Math.abs(Date.now() / 1000 - issuedAt) > 300)
      return NextResponse.json({ error: 'Invalid or expired action.' }, { status: 400 });
    const message = `Complete the external-rule demo\nWallet: ${walletAddress.toLowerCase()}\nOrigin: ${origin}\nQuest: ${questId}\nIssued at: ${issuedAt}`;
    const recovered = await recoverMessageAddress({ message, signature: signature as Hex });
    if (recovered.toLowerCase() !== walletAddress.toLowerCase()) return NextResponse.json({ error: 'Invalid wallet signature.' }, { status: 401 });
    // The signed demo action is the eligibility criterion here. A real partner must also verify its own task completion.
    const upstream = await fetch(`${apiUrl!.replace(/\/$/, '')}/v2/partner-api/quests/${questId}/mark-eligible`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-Partner-API-Key': apiKey! },
      body: JSON.stringify({ walletAddress, metadata: { source: 'partner-demo', markedAt: new Date().toISOString() } }), signal: AbortSignal.timeout(15000),
    });
    if (!upstream.ok) return NextResponse.json({ error: 'DogeOS could not mark this demo action eligible.' }, { status: 502 });
    return NextResponse.json({ marked: true, questId, walletAddress });
  } catch { return NextResponse.json({ error: 'Could not validate or complete this demo action.' }, { status: 400 }); }
}
