import { timingSafeEqual } from 'node:crypto';

// Optional on the existing private Railway network; required in the AWS deployment.
export function authorizedServiceRequest(value, expected) {
  if (!expected) return true;
  if (typeof value !== 'string') return false;
  const actual = Buffer.from(value);
  const token = Buffer.from(expected);
  return actual.length === token.length && timingSafeEqual(actual, token);
}
