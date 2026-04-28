/**
 * PayPal Payment Service
 * Implements PayPal Orders API v2 for payment processing
 * 
 * @see https://developer.paypal.com/docs/api/orders/v2/
 */

export interface PayPalConfig {
    clientId: string
    clientSecret: string
    mode: 'sandbox' | 'live'
}

export interface PayPalOrderResponse {
    id: string
    status: string
    links: Array<{
        href: string
        rel: string
        method: string
    }>
}

export interface PayPalCaptureResponse {
    id: string
    status: string
    purchase_units: Array<{
        payments: {
            captures: Array<{
                id: string
                status: string
                amount: {
                    currency_code: string
                    value: string
                }
            }>
        }
    }>
}

export class PayPalService {
    private clientId: string
    private clientSecret: string
    private baseUrl: string
    private accessToken: string | null = null
    private tokenExpiry: number = 0

    constructor(config: PayPalConfig) {
        this.clientId = config.clientId
        this.clientSecret = config.clientSecret
        this.baseUrl = config.mode === 'live'
            ? 'https://api-m.paypal.com'
            : 'https://api-m.sandbox.paypal.com'
    }

    /**
     * Get OAuth access token for PayPal API
     */
    private async getAccessToken(): Promise<string> {
        // Return cached token if still valid
        if (this.accessToken && Date.now() < this.tokenExpiry) {
            return this.accessToken
        }

        try {
            const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')

            const response = await fetch(`${this.baseUrl}/v1/oauth2/token`, {
                method: 'POST',
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: 'grant_type=client_credentials',
            })

            if (!response.ok) {
                const error = await response.text()
                throw new Error(`PayPal auth failed: ${error}`)
            }

            const data = await response.json()
            this.accessToken = data.access_token
            // Set expiry to 5 minutes before actual expiry for safety
            this.tokenExpiry = Date.now() + ((data.expires_in - 300) * 1000)

            return this.accessToken
        } catch (error) {
            console.error('[PayPalService] Failed to get access token:', error)
            throw new Error('Failed to authenticate with PayPal')
        }
    }

    /**
     * Create a PayPal order
     */
    async createOrder(
        amount: number,
        currency: string = 'USD',
        metadata: {
            userId: string
            planName: string
            returnUrl: string
            cancelUrl: string
        }
    ): Promise<PayPalOrderResponse> {
        try {
            const accessToken = await this.getAccessToken()

            const orderData = {
                intent: 'CAPTURE',
                purchase_units: [
                    {
                        amount: {
                            currency_code: currency.toUpperCase(),
                            value: amount.toFixed(2),
                        },
                        description: `${metadata.planName} subscription`,
                        custom_id: metadata.userId,
                    },
                ],
                application_context: {
                    return_url: metadata.returnUrl,
                    cancel_url: metadata.cancelUrl,
                    brand_name: 'SYNCRO',
                    user_action: 'PAY_NOW',
                },
            }

            const response = await fetch(`${this.baseUrl}/v2/checkout/orders`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(orderData),
            })

            if (!response.ok) {
                const error = await response.json()
                console.error('[PayPalService] Order creation failed:', error)
                throw new Error(`PayPal order creation failed: ${error.message || 'Unknown error'}`)
            }

            const order = await response.json()
            console.log('[PayPalService] Order created successfully:', order.id)

            return order
        } catch (error) {
            console.error('[PayPalService] createOrder error:', error)
            throw error
        }
    }

    /**
     * Capture payment for an approved order
     */
    async captureOrder(orderId: string): Promise<PayPalCaptureResponse> {
        try {
            const accessToken = await this.getAccessToken()

            const response = await fetch(`${this.baseUrl}/v2/checkout/orders/${orderId}/capture`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                },
            })

            if (!response.ok) {
                const error = await response.json()
                console.error('[PayPalService] Capture failed:', error)
                throw new Error(`PayPal capture failed: ${error.message || 'Unknown error'}`)
            }

            const capture = await response.json()
            console.log('[PayPalService] Payment captured successfully:', capture.id)

            return capture
        } catch (error) {
            console.error('[PayPalService] captureOrder error:', error)
            throw error
        }
    }

    /**
     * Get order details
     */
    async getOrder(orderId: string): Promise<PayPalOrderResponse> {
        try {
            const accessToken = await this.getAccessToken()

            const response = await fetch(`${this.baseUrl}/v2/checkout/orders/${orderId}`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                },
            })

            if (!response.ok) {
                const error = await response.json()
                throw new Error(`Failed to get order: ${error.message || 'Unknown error'}`)
            }

            return await response.json()
        } catch (error) {
            console.error('[PayPalService] getOrder error:', error)
            throw error
        }
    }

    /**
     * Refund a captured payment
     */
    async refundCapture(captureId: string, amount?: number, currency?: string): Promise<any> {
        try {
            const accessToken = await this.getAccessToken()

            const refundData: any = {}
            if (amount && currency) {
                refundData.amount = {
                    currency_code: currency.toUpperCase(),
                    value: amount.toFixed(2),
                }
            }

            const response = await fetch(
                `${this.baseUrl}/v2/payments/captures/${captureId}/refund`,
                {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(refundData),
                }
            )

            if (!response.ok) {
                const error = await response.json()
                console.error('[PayPalService] Refund failed:', error)
                throw new Error(`PayPal refund failed: ${error.message || 'Unknown error'}`)
            }

            const refund = await response.json()
            console.log('[PayPalService] Refund processed successfully:', refund.id)

            return refund
        } catch (error) {
            console.error('[PayPalService] refundCapture error:', error)
            throw error
        }
    }
}

/**
 * Get PayPal service instance
 */
export function getPayPalService(): PayPalService | null {
    const clientId = process.env.PAYPAL_CLIENT_ID
    const clientSecret = process.env.PAYPAL_CLIENT_SECRET
    const mode = (process.env.PAYPAL_MODE || 'sandbox') as 'sandbox' | 'live'

    if (!clientId || !clientSecret) {
        console.warn('[PayPalService] PayPal credentials not configured')
        return null
    }

    return new PayPalService({
        clientId,
        clientSecret,
        mode,
    })
}
