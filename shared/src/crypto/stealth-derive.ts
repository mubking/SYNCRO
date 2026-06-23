import { createHmac } from "crypto";

/**
 * Derives a deterministic stealth address for a subscription.
 *
 * Address = HMAC-SHA256(meta_address, `${subscriptionId}:${index}`)
 *
 * Properties:
 * - Same inputs always produce the same address (deterministic).
 * - Different indices produce different addresses (no collisions across subscriptions).
 * - On wallet recovery, iterate index 0..N to regenerate all addresses.
 *
 * @param metaAddress - The user's stealth meta-address (wallet-level secret).
 * @param subscriptionId - The subscription's unique identifier.
 * @param index - The per-subscription derivation index (starts at 0).
 * @returns A hex-encoded 32-byte stealth address string.
 */
export function deriveStealthAddress(
  metaAddress: string,
  subscriptionId: string,
  index: number,
): string {
  if (index < 0 || !Number.isInteger(index)) {
    throw new RangeError(`stealth_index must be a non-negative integer, got ${index}`);
  }
  return createHmac("sha256", metaAddress)
    .update(`${subscriptionId}:${index}`)
    .digest("hex");
}
