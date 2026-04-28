/**
 * Feature Flags Configuration
 * Centralized feature flag management for the application
 */

export interface FeatureFlags {
    paypalEnabled: boolean
    mockPaymentsEnabled: boolean
    stripeEnabled: boolean
}

/**
 * Get feature flags from environment variables
 */
export function getFeatureFlags(): FeatureFlags {
    return {
        // PayPal is enabled if credentials are configured
        paypalEnabled: !!(
            process.env.PAYPAL_CLIENT_ID &&
            process.env.PAYPAL_CLIENT_SECRET
        ),

        // Mock payments only enabled in development or if explicitly enabled
        mockPaymentsEnabled:
            process.env.NODE_ENV === 'development' ||
            process.env.ENABLE_MOCK_PAYMENTS === 'true',

        // Stripe is enabled if API key is configured
        stripeEnabled: !!process.env.STRIPE_SECRET_KEY,
    }
}

/**
 * Get available payment providers based on feature flags
 */
export function getAvailablePaymentProviders(): Array<'stripe' | 'paypal' | 'mock'> {
    const flags = getFeatureFlags()
    const providers: Array<'stripe' | 'paypal' | 'mock'> = []

    if (flags.stripeEnabled) {
        providers.push('stripe')
    }

    if (flags.paypalEnabled) {
        providers.push('paypal')
    }

    if (flags.mockPaymentsEnabled) {
        providers.push('mock')
    }

    return providers
}

/**
 * Check if a payment provider is enabled
 */
export function isPaymentProviderEnabled(provider: 'stripe' | 'paypal' | 'mock'): boolean {
    const flags = getFeatureFlags()

    switch (provider) {
        case 'stripe':
            return flags.stripeEnabled
        case 'paypal':
            return flags.paypalEnabled
        case 'mock':
            return flags.mockPaymentsEnabled
        default:
            return false
    }
}

/**
 * Get default payment provider
 */
export function getDefaultPaymentProvider(): 'stripe' | 'paypal' | 'mock' {
    const flags = getFeatureFlags()

    // Prefer Stripe, then PayPal, then mock
    if (flags.stripeEnabled) return 'stripe'
    if (flags.paypalEnabled) return 'paypal'
    if (flags.mockPaymentsEnabled) return 'mock'

    throw new Error('No payment provider is configured')
}
