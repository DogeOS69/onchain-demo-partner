export const BEACON_HASH = '04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3';
export const PUBLIC_KEY = '07e1d1d335df83fa98462005690372c643340060d205306a9aa8106b6bd0b3820557ec32c2ad488e4d4f6008f89a346f18492092ccc0d594610de2732c8b808f0095685ae3a85ba243747b1b2f426049010f6b73a0cf1d389351d5aaaa1047f6297d3a4f9749b33eb2d904c9d9ebf17224150ddd7abd7567a9bec6c74480ee0b';
export const RELAYS = ['https://api.drand.sh', 'https://api2.drand.sh', 'https://api3.drand.sh'];
export function publicKeyToEvm(key) {
  if (!/^[a-fA-F0-9]{256}$/.test(key)) throw new Error('Invalid evmnet public key');
  const c = key.match(/.{64}/g).map(s => BigInt(`0x${s}`));
  return [c[1], c[0], c[3], c[2]];
}
export function signatureToEvm(signature) {
  if (!/^[a-fA-F0-9]{128}$/.test(signature)) throw new Error('Invalid evmnet signature encoding');
  return signature.match(/.{64}/g).map(s => BigInt(`0x${s}`));
}
async function getFromRelays(suffix, validate) {
  const errors = [];
  for (const relay of RELAYS) {
    try {
      const response = await fetch(`${relay}/v2/beacons/${BEACON_HASH}/${suffix}`, { signal: AbortSignal.timeout(7000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      validate(data);
      return data;
    } catch (error) { errors.push(`${new URL(relay).hostname}: ${error.message}`); }
  }
  throw new Error(`drand relays unavailable or invalid (${errors.join('; ')})`);
}
export async function fetchInfo() {
  return getFromRelays('info', info => {
    if (info.chain_hash !== BEACON_HASH || info.period !== 3 || info.genesis_time !== 1727521075 || info.scheme !== 'bls-bn254-unchained-on-g1') throw new Error('Unexpected beacon parameters');
    if (info.public_key !== PUBLIC_KEY) throw new Error('Unexpected beacon public key');
    publicKeyToEvm(info.public_key);
  });
}
export async function fetchRound(round) {
  const expected = Number(round);
  if (!Number.isSafeInteger(expected) || expected <= 0) throw new Error('Invalid round number');
  return getFromRelays(`rounds/${expected}`, data => {
    if (Number(data.round) !== expected) throw new Error('Relay returned a different round');
    signatureToEvm(data.signature);
  });
}
