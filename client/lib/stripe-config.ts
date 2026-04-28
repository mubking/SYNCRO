import Stripe from "stripe"

/**
 * Centralized Stripe Configuration
 * 
 * Provides a single source of truth for Stripe SDK settings.
 * Using the latest stable API version supported by the Stripe SDK.
 */
export const STRIPE_API_VERSION = "2025-11-17.clover" as const;

export const stripeConfig: Stripe.StripeConfig = {
  apiVersion: STRIPE_API_VERSION,
  typescript: true,
}

/**
 * Initialize a Stripe instance with standard configuration
 */
export const getStripeInstance = (apiKey?: string) => {
  const key = apiKey || process.env.STRIPE_SECRET_KEY
  if (!key) return null
  
  return new Stripe(key, stripeConfig)
}
