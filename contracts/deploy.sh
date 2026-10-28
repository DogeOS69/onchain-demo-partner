#!/usr/bin/env bash
# Deploys the EventEmitter demo contract and writes the address
# to deployments/<chainId>.json. Re-runs are safe (re-deploys a fresh
# instance; existing file gets overwritten).
#
# Usage:
#   ./deploy.sh                            # uses .env in this dir
#   ./deploy.sh anvil                      # uses local anvil at 127.0.0.1:8545
#
# Required env (from .env):
#   DOGEOS_RPC_URL
#   DEPLOYER_PRIVATE_KEY

set -euo pipefail

cd "$(dirname "$0")"

if [[ -f .env ]]; then
    set -a; source .env; set +a
fi

NETWORK="${1:-dogeos}"
case "$NETWORK" in
    anvil)
        : "${DEPLOYER_PRIVATE_KEY:=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
        RPC_URL="http://127.0.0.1:8545"
        ;;
    dogeos)
        : "${DOGEOS_RPC_URL:?DOGEOS_RPC_URL not set; copy .env.example to .env and fill it in}"
        : "${DEPLOYER_PRIVATE_KEY:?DEPLOYER_PRIVATE_KEY not set}"
        RPC_URL="$DOGEOS_RPC_URL"
        ;;
    *)
        echo "Unknown network: $NETWORK (use 'anvil' or 'dogeos')" >&2
        exit 1
        ;;
esac

export DEPLOYER_PRIVATE_KEY

echo "==> Building..."
forge build --quiet

echo "==> Deploying to $NETWORK ($RPC_URL)..."
OUTPUT=$(forge script script/Deploy.s.sol:Deploy \
    --rpc-url "$RPC_URL" \
    --broadcast \
    --skip-simulation \
    2>&1)

echo "$OUTPUT"

extract() {
    echo "$OUTPUT" | grep -E "^\s*$1=" | tail -1 | sed -E "s/.*$1=\s*//" | tr -d ' '
}

CHAIN_ID=$(extract CHAIN_ID)
DEPLOYER=$(extract DEPLOYER)
EVENT_EMITTER_ADDRESS=$(extract EVENT_EMITTER_ADDRESS)

if [[ -z "$EVENT_EMITTER_ADDRESS" ]]; then
    echo "ERROR: failed to parse deploy output. Check forge log above." >&2
    exit 1
fi

mkdir -p deployments
OUT_FILE="deployments/${CHAIN_ID}.json"
cat > "$OUT_FILE" <<JSON
{
  "chainId": ${CHAIN_ID},
  "network": "${NETWORK}",
  "rpcUrl": "${RPC_URL}",
  "deployer": "${DEPLOYER}",
  "contracts": {
    "EventEmitter": "${EVENT_EMITTER_ADDRESS}"
  }
}
JSON

echo
echo "==> Wrote $OUT_FILE:"
cat "$OUT_FILE"
echo
echo "Next: copy this address into web/.env.local as NEXT_PUBLIC_EVENT_EMITTER_ADDRESS"
