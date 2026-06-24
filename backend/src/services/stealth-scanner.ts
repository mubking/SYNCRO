/**
 * Stealth payment scanner service
 * Identifies stealth payments in Stellar transactions by scanning memo fields
 */

import logger from '../config/logger';
import { supabase } from '../config/database';
import { isStealthMemo, decodeStealthMemo } from '../../../shared/stealth-derive';

export interface StealthPaymentRecord {
  transactionHash: string;
  ephemeralPubkey: string;
  recipientAddress: string;
  amount: number;
  asset: string;
  timestamp: string;
  ledger: number;
}

export class StealthScanner {
  /**
   * Scan transaction for stealth payment pattern
   * @param tx - Stellar transaction object
   * @param recipientAddress - Expected recipient address
   * @returns Stealth payment data if matched, null otherwise
   */
  scanTransactionForStealth(
    tx: any,
    recipientAddress: string
  ): StealthPaymentRecord | null {
    if (!tx.memo) {
      return null;
    }

    const memoType = tx.memo.type || 'text';
    const memoValue = tx.memo.value;

    // Check if memo matches stealth pattern (32-byte return memo)
    if (!isStealthMemo(memoType, memoValue)) {
      return null;
    }

    try {
      const ephemeralPubkey = decodeStealthMemo(memoValue);

      // Extract payment details from transaction operations
      const paymentOp = this.extractPaymentOperation(tx, recipientAddress);
      if (!paymentOp) {
        logger.warn('Stealth memo found but no matching payment operation', {
          transactionHash: tx.hash,
          recipientAddress,
        });
        return null;
      }

      return {
        transactionHash: tx.hash,
        ephemeralPubkey,
        recipientAddress,
        amount: paymentOp.amount,
        asset: paymentOp.asset,
        timestamp: tx.created_at || new Date().toISOString(),
        ledger: tx.ledger || 0,
      };
    } catch (error) {
      logger.error('Error scanning transaction for stealth payment:', {
        transactionHash: tx.hash,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Scan multiple transactions for stealth payments
   * @param transactions - Array of Stellar transactions
   * @param recipientAddress - Expected recipient address
   * @returns Array of stealth payment records
   */
  scanTransactionsForStealth(
    transactions: any[],
    recipientAddress: string
  ): StealthPaymentRecord[] {
    return transactions
      .map((tx) => this.scanTransactionForStealth(tx, recipientAddress))
      .filter((record): record is StealthPaymentRecord => record !== null);
  }

  /**
   * Store detected stealth payment in database
   * @param record - Stealth payment record
   * @param userId - User ID for record association
   */
  async storeStealthPayment(
    record: StealthPaymentRecord,
    userId: string
  ): Promise<void> {
    try {
      const { error } = await supabase.from('stealth_payments').insert({
        user_id: userId,
        transaction_hash: record.transactionHash,
        ephemeral_pubkey: record.ephemeralPubkey,
        recipient_address: record.recipientAddress,
        amount: record.amount,
        asset: record.asset,
        timestamp: record.timestamp,
        ledger: record.ledger,
        detected_at: new Date().toISOString(),
      });

      if (error) {
        logger.error('Failed to store stealth payment record:', error);
        throw error;
      }

      logger.info('Stealth payment recorded', {
        userId,
        transactionHash: record.transactionHash,
        ephemeralPubkey: record.ephemeralPubkey,
      });
    } catch (error) {
      logger.error('Error storing stealth payment:', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Extract payment operation from transaction targeting recipient
   * @param tx - Stellar transaction object
   * @param recipientAddress - Expected recipient address
   * @returns Payment operation details or null
   */
  private extractPaymentOperation(
    tx: any,
    recipientAddress: string
  ): { amount: number; asset: string } | null {
    if (!tx.operations || !Array.isArray(tx.operations)) {
      return null;
    }

    for (const op of tx.operations) {
      // Check payment operation
      if (op.type === 'payment' && op.destination === recipientAddress) {
        return {
          amount: parseFloat(op.amount),
          asset: op.asset_type === 'native' ? 'XLM' : op.asset_code,
        };
      }

      // Check path_payment_strict_receive operation
      if (
        op.type === 'path_payment_strict_receive' &&
        op.destination === recipientAddress
      ) {
        return {
          amount: parseFloat(op.destination_amount),
          asset: op.destination_asset_type === 'native'
            ? 'XLM'
            : op.destination_asset_code,
        };
      }
    }

    return null;
  }

  /**
   * Get stealth payments for a user
   * @param userId - User ID
   * @param limit - Number of records to fetch
   * @returns Array of stealth payment records
   */
  async getUserStealthPayments(
    userId: string,
    limit: number = 100
  ): Promise<StealthPaymentRecord[]> {
    try {
      const { data, error } = await supabase
        .from('stealth_payments')
        .select('*')
        .eq('user_id', userId)
        .order('detected_at', { ascending: false })
        .limit(limit);

      if (error) {
        logger.error('Failed to fetch stealth payments:', error);
        throw error;
      }

      return (data || []).map((record: any) => ({
        transactionHash: record.transaction_hash,
        ephemeralPubkey: record.ephemeral_pubkey,
        recipientAddress: record.recipient_address,
        amount: record.amount,
        asset: record.asset,
        timestamp: record.timestamp,
        ledger: record.ledger,
      }));
    } catch (error) {
      logger.error('Error fetching stealth payments:', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

export const stealthScanner = new StealthScanner();
