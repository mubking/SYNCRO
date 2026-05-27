/**
 * GMAIL OAUTH2 TOKEN LIFECYCLE SERVICE
 * =====================================
 * 1. ENCRYPTION AT REST: To prevent credential exposure during database leaks, all 
 *    tokens are encrypted using the AES-256-GCM authenticated encryption algorithm.
 * 2. AUTOMATIC ROTATION: Access tokens are refreshed using the stored refresh_token. 
 *    Both the refresh_token and new access_token are decrypted for the API call and 
 *    re-encrypted before database persistence.
 * 3. REMOTE REVOCATION: Account disconnection triggers a remote revocation call to 
 *    Google's OAuth2 endpoints to invalidate tokens globally before scrubbing local 
 *    encrypted strings.
 */

import axios from 'axios';
import { encrypt, decrypt } from '../utils/encryption';
import { createClient } from '../lib/supabase-client'; // Internal utility to access DB

export class GmailTokenService {
  /**
   * Uses the stored encrypted refresh token to obtain and persist a new access token.
   */
  static async refreshAccessToken(userId: string): Promise<string> {
    const supabase = createClient();

    // 1. Retrieve the encrypted account record
    const { data: account, error } = await supabase
      .from('email_accounts')
      .select('*')
      .eq('user_id', userId)
      .eq('provider', 'gmail')
      .single();

    if (error || !account || !account.refresh_token) {
      throw new Error('No valid Gmail credentials found for rotation');
    }

    // 2. Decrypt refresh token for the rotation request
    const decryptedRefreshToken = decrypt(account.refresh_token);

    // 3. Request new tokens from Google OAuth2
    const response = await axios.post('https://oauth2.googleapis.com/token', {
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: decryptedRefreshToken,
      grant_type: 'refresh_token',
    });

    const { access_token, refresh_token: newRefreshToken, expires_in } = response.data;

    // 4. Re-encrypt rotated credentials before database update
    const encryptedAccessToken = encrypt(access_token);
    const updateData: any = {
      access_token: encryptedAccessToken,
      token_expires_at: new Date(Date.now() + expires_in * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    };

    if (newRefreshToken) {
      updateData.refresh_token = encrypt(newRefreshToken);
    }

    await supabase
      .from('email_accounts')
      .update(updateData)
      .eq('id', account.id);

    return access_token;
  }

  /**
   * Disconnects a Gmail account by revoking Google tokens and purging local credentials.
   */
  static async disconnectGmailAccount(userId: string): Promise<void> {
    const supabase = createClient();

    const { data: account } = await supabase
      .from('email_accounts')
      .select('*')
      .eq('user_id', userId)
      .eq('provider', 'gmail')
      .single();

    if (!account) return;

    try {
      // 1. Decrypt and Revoke remotely via Google Identity
      // Preference given to refresh_token for full app revocation
      const tokenToRevoke = account.refresh_token 
        ? decrypt(account.refresh_token) 
        : decrypt(account.access_token);
      
      await axios.post(`https://oauth2.googleapis.com/revoke?token=${tokenToRevoke}`, null, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
    } catch (err) {
      // We log but continue scrubbing locally even if revocation fails (e.g. token already expired)
      console.warn('Remote revocation failed, proceeding with local scrubbing:', err);
    }

    // 2. Immediate scrubbing of encrypted credentials from the database
    const { error } = await supabase
      .from('email_accounts')
      .update({
        access_token: null,
        refresh_token: null,
        is_connected: false,
        updated_at: new Date().toISOString(),
      })
      .eq('id', account.id);

    if (error) throw error;
  }
}