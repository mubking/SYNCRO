import axios from 'axios';
import { GmailTokenService } from '../src/services/gmail-token-service';
import * as encryption from '../src/utils/encryption';
import { createClient } from '../src/lib/supabase-client';

jest.mock('axios');
jest.mock('../src/lib/supabase-client');
const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedCreateClient = createClient as jest.Mock;

describe('GmailTokenService Security and Lifecycle', () => {
  const mockUserId = 'user-123';
  const rawAccessToken = 'raw-access-token';
  const rawRefreshToken = 'raw-refresh-token';
  const encryptionKey = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = encryptionKey;
    process.env.GOOGLE_CLIENT_ID = 'test-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
  });

  it('should encrypt tokens before saving to database', async () => {
    const encryptedRefresh = encryption.encrypt(rawRefreshToken);

    const updateMock = jest.fn().mockResolvedValue({ error: null });
    const supabaseMock = {
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: { id: 'acc-1', refresh_token: encryptedRefresh }
      }),
      update: updateMock,
    };
    mockedCreateClient.mockReturnValue(supabaseMock);

    mockedAxios.post.mockResolvedValue({
      data: {
        access_token: 'new-raw-access',
        expires_in: 3600
      }
    });

    await GmailTokenService.refreshAccessToken(mockUserId);

    // Verify update was called with encrypted content, not plaintext
    const updateCallArgs = updateMock.mock.calls[0][0];
    expect(updateCallArgs.access_token).not.toBe('new-raw-access');
    expect(updateCallArgs.access_token).toContain(':'); // IV:AuthTag:Cipher format
    
    // Verify we can decrypt it back to the original value
    const decrypted = encryption.decrypt(updateCallArgs.access_token);
    expect(decrypted).toBe('new-raw-access');
  });

  it('should revoke remote tokens and purge local credentials on disconnect', async () => {
    const encryptedRefresh = encryption.encrypt(rawRefreshToken);
    const encryptedAccess = encryption.encrypt(rawAccessToken);

    const updateMock = jest.fn().mockResolvedValue({ error: null });
    const supabaseMock = {
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: { 
          id: 'acc-1', 
          refresh_token: encryptedRefresh,
          access_token: encryptedAccess 
        }
      }),
      update: updateMock,
    };
    mockedCreateClient.mockReturnValue(supabaseMock);
    mockedAxios.post.mockResolvedValue({ status: 200 });

    await GmailTokenService.disconnectGmailAccount(mockUserId);

    // 1. Verify mock network revocation call was made with decrypted token
    expect(mockedAxios.post).toHaveBeenCalledWith(
      expect.stringContaining('revoke?token=' + rawRefreshToken),
      null,
      expect.anything()
    );

    // 2. Verify local database credentials were set to null
    const updateCallArgs = updateMock.mock.calls[0][0];
    expect(updateCallArgs.access_token).toBeNull();
    expect(updateCallArgs.refresh_token).toBeNull();
    expect(updateCallArgs.is_connected).toBe(false);
  });
});