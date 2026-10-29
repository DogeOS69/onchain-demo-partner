import { NextRequest, NextResponse } from "next/server";

/**
 * Demo-side mock of a partner backend. In production, the partner runs
 * their own backend somewhere, validates that the user actually completed
 * the action on their platform, and POSTs to DogeOS's mark-eligible
 * endpoint with their API key. We're collapsing that into a Next.js API
 * route here so the demo is one process to run — but the architecture is
 * the same.
 *
 * Security: the partner API key lives only in server-side env vars and is
 * never sent to the browser. The browser POSTs `{walletAddress}` here,
 * we add the X-Partner-API-Key header on the server, then forward to
 * DogeOS.
 */
export async function POST(request: NextRequest) {
  const env = process.env.DOGEOS_ENV || "staging";
  if (env !== "staging" && env !== "prod") {
    return NextResponse.json(
      { error: "DOGEOS_ENV must be staging or prod." },
      { status: 500 },
    );
  }

  const prefix = env === "prod" ? "DOGEOS_PROD" : "DOGEOS_STAGING";
  const apiUrl = process.env[`${prefix}_API_URL`];
  const apiKey = process.env[`${prefix}_PARTNER_API_KEY`];
  const questId = process.env[`${prefix}_EXTERNAL_QUEST_ID`];

  if (!apiUrl || !apiKey || !questId) {
    return NextResponse.json(
      {
        error: `Demo partner backend isn't configured for ${env}. Set ${prefix}_API_URL, ${prefix}_PARTNER_API_KEY, and ${prefix}_EXTERNAL_QUEST_ID in web/.env.local.`,
      },
      { status: 500 },
    );
  }

  let body: { walletAddress?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be JSON" },
      { status: 400 },
    );
  }

  const walletAddress = body.walletAddress?.trim();
  if (!walletAddress) {
    return NextResponse.json(
      { error: "walletAddress is required" },
      { status: 400 },
    );
  }

  const url = `${apiUrl.replace(/\/$/, "")}/v2/partner-api/quests/${questId}/mark-eligible`;
  const upstream = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Partner-API-Key": apiKey,
    },
    body: JSON.stringify({
      walletAddress,
      // The metadata field is free-form; in a real integration the partner
      // might attach a quiz score, a transaction hash, or an internal user
      // id here so support can correlate later.
      metadata: { source: "onchain-demo", markedAt: new Date().toISOString() },
    }),
  });

  const text = await upstream.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }

  if (!upstream.ok) {
    return NextResponse.json(
      {
        error: "DogeOS rejected the mark-eligible call",
        upstreamStatus: upstream.status,
        upstreamBody: parsed,
      },
      { status: upstream.status },
    );
  }

  return NextResponse.json({
    marked: true,
    questId,
    walletAddress,
    upstream: parsed,
  });
}
