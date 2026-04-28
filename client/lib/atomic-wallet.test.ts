import { describe, expect, it } from "vitest"
import {
  getAtomicWalletGiftCardDeepLink,
  getAtomicWalletGiftCardWebLink,
  getAtomicWalletGiftCardLink,
  normalizeGiftCardProvider,
  getGiftCardProviderFromSubscription,
} from "./atomic-wallet"

describe("Atomic Wallet gift card deep links", () => {
  it("normalizes provider names for query params", () => {
    expect(normalizeGiftCardProvider("Google Play")).toBe("google_play")
    expect(normalizeGiftCardProvider(" AMAZON ")).toBe("amazon")
    expect(normalizeGiftCardProvider("Visa")).toBe("visa")
    expect(normalizeGiftCardProvider("Steam")).toBe("steam")
  })

  it("generates a mobile deep link with amount and provider", () => {
    expect(getAtomicWalletGiftCardDeepLink(25, "Amazon")).toBe(
      "atomicwallet://buy-gift-card?amount=25&provider=amazon",
    )
  })

  it("generates a web fallback link with amount and provider", () => {
    expect(getAtomicWalletGiftCardWebLink(25, "Amazon")).toBe(
      "https://atomicwallet.io/buy-gift-cards?amount=25&provider=amazon",
    )
  })

  it("infers a gift card provider from subscription metadata", () => {
    expect(getGiftCardProviderFromSubscription({ provider: "Steam" })).toBe("steam")
    expect(getGiftCardProviderFromSubscription({ name: "YouTube Premium" })).toBe("google_play")
    expect(getGiftCardProviderFromSubscription({ category: "Amazon" })).toBe("amazon")
  })

  it("returns null for unknown providers", () => {
    expect(getGiftCardProviderFromSubscription({ provider: "Acme Subscription" })).toBeNull()
    expect(getGiftCardProviderFromSubscription({ name: "Unknown Service" })).toBeNull()
  })

  it("returns a web link on non-browser environments", () => {
    expect(getAtomicWalletGiftCardLink(10, "Visa")).toBe(
      "https://atomicwallet.io/buy-gift-cards?amount=10&provider=visa",
    )
  })
})
