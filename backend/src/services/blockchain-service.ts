import logger from "../config/logger";
import { supabase } from "../config/database";
import { NotificationPayload } from "../types/reminder";
import {
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { rpc as SorobanRpc } from "@stellar/stellar-sdk";
import { createClient, RedisClientType } from "redis";
import { secretProvider } from "./secret-provider";
import {
  getBlockchainFlags,
  resolveStellarNetwork,
} from "../../../shared/blockchain-flags";
import { EXTERNAL_SERVICE_POLICIES } from "../config/external-services";

export type PayloadVersion = '1.0';

export interface SubscriptionEventPayload {
  subscriptionId: string;
  operation: string;
  subscriptionName: string;
  price: string | number;
  billingCycle: string;
  status: string;
  timestamp: string;
}

export interface ReminderEventPayload {
  subscriptionId: string;
  subscriptionName: string;
  reminderType: string;
  renewalDate: string;
  daysBefore: number;
  price: string | number;
  billingCycle: string;
  deliveryChannels: string[];
  timestamp: string;
}

export interface GiftCardEventPayload {
  subscriptionId: string;
  giftCardHash: string;
  provider: string;
  eventType: string;
  timestamp: string;
}

export interface DLQPayload<T = unknown> {
  version: PayloadVersion;
  eventType: string;
  payload: T;
  failedAt: string;
  errorReason: string;
  retryCount: number;
  contractAddress?: string | null;
  rpcUrl?: string;
}

export interface BlockchainLogEntry {
  user_id: string;
  event_type: string;
  event_data: Record<string, any>;
}

/**
 * Blockchain logging service for reminder events
 * This service writes reminder events to on-chain logs via Soroban contracts
 */
export class BlockchainService {
  private contractAddress: string | null;
  private rpcUrl: string;
  private networkPassphrase: string;
  private redisClient: RedisClientType | null = null;
  private readonly policy = EXTERNAL_SERVICE_POLICIES.stellar_rpc;

  constructor() {
    this.contractAddress = process.env.SOROBAN_CONTRACT_ADDRESS || null;

    const flags = getBlockchainFlags();
    const network = resolveStellarNetwork();

    // Resolve RPC URL — never silently fall back to testnet in production.
    const configuredRpc = process.env.SOROBAN_RPC_URL;
    if (!configuredRpc && flags.isProduction) {
      throw new Error(
        "[blockchain] SOROBAN_RPC_URL must be explicitly set in production. " +
          "Refusing to fall back to the testnet RPC endpoint.",
      );
    }
    this.rpcUrl = configuredRpc || "https://soroban-testnet.stellar.org";

    // Resolve network passphrase — never silently use testnet passphrase in production.
    const configuredPassphrase = process.env.STELLAR_NETWORK_PASSPHRASE;
    if (!configuredPassphrase && flags.isProduction) {
      throw new Error(
        "[blockchain] STELLAR_NETWORK_PASSPHRASE must be explicitly set in production. " +
          "Refusing to fall back to the testnet network passphrase.",
      );
    }
    this.networkPassphrase =
      configuredPassphrase ||
      (network === "mainnet"
        ? Networks.PUBLIC
        : network === "futurenet"
          ? Networks.FUTURENET
          : Networks.TESTNET);

    if (!this.contractAddress) {
      logger.warn(
        "Blockchain contract address not configured. Events will be logged to database only.",
      );
    }

    if (!flags.blockchainEnabled) {
      logger.warn(
        "ENABLE_BLOCKCHAIN=false — on-chain writes are disabled. " +
          "All events will be logged to the database only.",
      );
    }

    // Initialize optional Redis client for DLQ if REDIS_URL present
    const redisUrl = process.env.REDIS_URL;
    if (redisUrl) {
      try {
        this.redisClient = createClient({ url: redisUrl });
        // Connect lazily; fire-and-forget
        this.redisClient.connect().catch((err) => {
          logger.warn("Redis DLQ connection failed; DLQ disabled:", err);
          this.redisClient = null;
        });
      } catch (err) {
        logger.warn("Redis DLQ initialization failed; DLQ disabled:", err);
        this.redisClient = null;
      }
    }
  }

  /**
   * Log reminder event to blockchain and database
   */
  async logReminderEvent(
    userId: string,
    payload: NotificationPayload,
    deliveryChannels: string[],
  ): Promise<{ success: boolean; transactionHash?: string; error?: string }> {
    const eventData = {
      subscriptionId: payload.subscription.id,
      subscriptionName: payload.subscription.name,
      reminderType: payload.reminderType,
      renewalDate: payload.renewalDate,
      daysBefore: payload.daysBefore,
      price: payload.subscription.price,
      billingCycle: payload.subscription.billing_cycle,
      deliveryChannels,
      timestamp: new Date().toISOString(),
    };

    // First, log to database
    try {
      const { data: dbLog, error: dbError } = await supabase
        .from("blockchain_logs")
        .insert({
          user_id: userId,
          event_type: "reminder_sent",
          event_data: eventData,
          status: "pending",
        })
        .select()
        .single();

      if (dbError) {
        logger.error("Failed to log event to database:", dbError);
        throw dbError;
      }

      logger.info("Event logged to database", { logId: dbLog.id });

      // If contract address is configured, attempt to write to blockchain
      if (this.contractAddress) {
        try {
          const result = await this.writeToBlockchain(eventData);

          // Update database log with transaction hash
          if (result.transactionHash) {
            await supabase
              .from("blockchain_logs")
              .update({
                transaction_hash: result.transactionHash,
                status: "confirmed",
                updated_at: new Date().toISOString(),
              })
              .eq("id", dbLog.id);

            logger.info("Event written to blockchain", {
              logId: dbLog.id,
              transactionHash: result.transactionHash,
            });
          }

          return {
            success: true,
            transactionHash: result.transactionHash,
          };
        } catch (blockchainError) {
          // Log blockchain error but don't fail the operation
          const errorMessage =
            blockchainError instanceof Error
              ? blockchainError.message
              : String(blockchainError);

          logger.error("Failed to write to blockchain:", errorMessage);

          // Update database log with error
          await supabase
            .from("blockchain_logs")
            .update({
              status: "failed",
              error_message: errorMessage,
              updated_at: new Date().toISOString(),
            })
            .eq("id", dbLog.id);

          // Still return success since database logging succeeded
          return {
            success: true,
            error: errorMessage,
          };
        }
      }

      // If no contract address, just log to database
      return {
        success: true,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error("Failed to log reminder event:", errorMessage);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Write event data to Soroban contract
   */
  private async writeToBlockchain(
    eventData: ReminderEventPayload,
  ): Promise<{ transactionHash: string }> {
    return this.invokeContractWithRetry("log_reminder", this.encodeReminderArgs(eventData));
  }

  /**
   * Get blockchain log entries for a user
   */
  async getUserLogs(userId: string, limit: number = 100) {
    const { data, error } = await supabase
      .from("blockchain_logs")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      logger.error("Failed to fetch blockchain logs:", error);
      throw error;
    }

    return data;
  }

  /**
   * Sync subscription operation to blockchain
   * Handles create, update, and delete operations
   */
  async syncSubscription(
    userId: string,
    subscriptionId: string,
    operation:  "create" | "update" | "delete" | "cancel" | "pause" | "unpause",
    subscriptionData: any,
  ): Promise<{ success: boolean; transactionHash?: string; error?: string }> {
    const eventData = {
      subscriptionId,
      operation,
      subscriptionName: subscriptionData.name,
      price: subscriptionData.price,
      billingCycle: subscriptionData.billing_cycle,
      status: subscriptionData.status,
      timestamp: new Date().toISOString(),
    };

    // First, log to database
    try {
      const { data: dbLog, error: dbError } = await supabase
        .from("blockchain_logs")
        .insert({
          user_id: userId,
          event_type: `subscription_${operation}`,
          event_data: eventData,
          status: "pending",
        })
        .select()
        .single();

      if (dbError) {
        logger.error("Failed to log subscription event to database:", dbError);
        throw dbError;
      }

      logger.info("Subscription event logged to database", {
        logId: dbLog.id,
        operation,
        subscriptionId,
      });

      // If contract address is configured, attempt to write to blockchain
      if (this.contractAddress) {
        try {
          const result = await this.writeSubscriptionToBlockchain(
            operation,
            eventData,
          );

          // Update database log with transaction hash
          if (result.transactionHash) {
            await supabase
              .from("blockchain_logs")
              .update({
                transaction_hash: result.transactionHash,
                status: "confirmed",
                updated_at: new Date().toISOString(),
              })
              .eq("id", dbLog.id);

            logger.info("Subscription event written to blockchain", {
              logId: dbLog.id,
              transactionHash: result.transactionHash,
              operation,
            });
          }

          return {
            success: true,
            transactionHash: result.transactionHash,
          };
        } catch (blockchainError) {
          // Log blockchain error but don't fail the operation
          const errorMessage =
            blockchainError instanceof Error
              ? blockchainError.message
              : String(blockchainError);

          logger.error(
            "Failed to write subscription to blockchain:",
            errorMessage,
          );

          // Update database log with error
          await supabase
            .from("blockchain_logs")
            .update({
              status: "failed",
              error_message: errorMessage,
              updated_at: new Date().toISOString(),
            })
            .eq("id", dbLog.id);

          // Still return success since database logging succeeded
          return {
            success: true,
            error: errorMessage,
          };
        }
      }

      // If no contract address, just log to database
      return {
        success: true,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error("Failed to sync subscription event:", errorMessage);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Write subscription operation to Soroban contract
   */
  private async writeSubscriptionToBlockchain(
    operation: "create" | "update" | "delete" | "cancel" | "pause" | "unpause",
    eventData: SubscriptionEventPayload,
  ): Promise<{ transactionHash: string }> {
    const method = `subscription_${operation}`;
    return this.invokeContractWithRetry(method, this.encodeSubscriptionArgs(eventData));
  }

  /**
   * Log gift card attachment to blockchain and database
   */
  async logGiftCardAttached(
    userId: string,
    subscriptionId: string,
    giftCardHash: string,
    provider: string
  ): Promise<{ success: boolean; transactionHash?: string; error?: string }> {
    const eventData = {
      subscriptionId,
      giftCardHash,
      provider,
      eventType: 'gift_card_attached',
      timestamp: new Date().toISOString(),
    };

    try {
      const { data: dbLog, error: dbError } = await supabase
        .from('blockchain_logs')
        .insert({
          user_id: userId,
          event_type: 'gift_card_attached',
          event_data: eventData,
          status: 'pending',
        })
        .select()
        .single();

      if (dbError) {
        logger.error('Failed to log gift card event to database:', dbError);
        throw dbError;
      }

      if (this.contractAddress) {
        try {
          const result = await this.writeGiftCardToBlockchain(eventData);

          if (result.transactionHash) {
            await supabase
              .from('blockchain_logs')
              .update({
                transaction_hash: result.transactionHash,
                status: 'confirmed',
                updated_at: new Date().toISOString(),
              })
              .eq('id', dbLog.id);
          }

          return {
            success: true,
            transactionHash: result.transactionHash,
          };
        } catch (blockchainError) {
          const errorMessage =
            blockchainError instanceof Error
              ? blockchainError.message
              : String(blockchainError);
          logger.error('Failed to write gift card to blockchain:', errorMessage);
          await supabase
            .from('blockchain_logs')
            .update({
              status: 'failed',
              error_message: errorMessage,
              updated_at: new Date().toISOString(),
            })
            .eq('id', dbLog.id);
          return {
            success: true,
            error: errorMessage,
          };
        }
      }

      return { success: true };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error('Failed to log gift card event:', errorMessage);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  private async writeGiftCardToBlockchain(
    eventData: GiftCardEventPayload
  ): Promise<{ transactionHash: string }> {
    return this.invokeContractWithRetry("gift_card_attached", this.encodeGiftCardArgs(eventData));
  }

  /**
   * Core Soroban invocation with retry & optional DLQ
   */
  private async invokeContractWithRetry(
    method: string,
    args: xdr.ScVal[],
  ): Promise<{ transactionHash: string }> {
    if (!this.contractAddress) {
      throw new Error("SOROBAN_CONTRACT_ADDRESS not configured");
    }

    // Honour the ENABLE_BLOCKCHAIN master switch
    const flags = getBlockchainFlags();
    if (!flags.blockchainEnabled) {
      throw new Error(
        `[blockchain] On-chain write for "${method}" was blocked: ` +
          "ENABLE_BLOCKCHAIN is set to false.",
      );
    }

    const rpc = new SorobanRpc.Server(this.rpcUrl);
    
    // Fetch secret from provider
    const secret = await secretProvider.getSecret("STELLAR_SECRET_KEY");
    if (!secret) {
      throw new Error("STELLAR_SECRET_KEY not configured");
    }
    
    const sourceKeypair = Keypair.fromSecret(secret);
    const contract = new Contract(this.contractAddress);

    let lastErr: unknown = null;
    const { maxAttempts = 3, initialDelay = 500, multiplier = 2 } = this.policy.retryPolicy;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const account = await rpc.getAccount(sourceKeypair.publicKey());
        const tx = new TransactionBuilder(account, {
          fee: "100",
          networkPassphrase: this.networkPassphrase,
        })
          .addOperation(contract.call(method, ...args))
          .setTimeout(Math.floor(this.policy.timeoutMs / 1000))
          .build();

        const sim = await rpc.simulateTransaction(tx);
        if (SorobanRpc.Api.isSimulationError(sim)) {
          throw new Error(`Simulation failed: ${sim.error}`);
        }

        const assembled = SorobanRpc.assembleTransaction(tx, sim).build();
        assembled.sign(sourceKeypair);

        const send = await rpc.sendTransaction(assembled);
        if (send.status === "ERROR") {
          throw new Error(`Send failed: ${send.errorResult}`);
        }

        // Wait for confirmation
        const getTx = await rpc.getTransaction(send.hash);
        if (getTx.status === "NOT_FOUND") {
          // brief wait+retry fetch
          await this.sleep(initialDelay);
        }

        return { transactionHash: send.hash };
      } catch (err) {
        lastErr = err;
        const delay = Math.min(initialDelay * Math.pow(multiplier, attempt), this.policy.retryPolicy.maxDelay || 30000);
        logger.warn(
          `Soroban tx attempt ${attempt + 1}/${maxAttempts} failed for method ${method}: ${
            err instanceof Error ? err.message : String(err)
          } — retrying in ${delay}ms`,
        );
        await this.sleep(delay);
      }
    }

    // After all retries failed, enqueue to DLQ if available
    await this.enqueueDeadLetter({
      version: '1.0',
      eventType: method,
      payload: this.previewArgs(args),
      failedAt: new Date().toISOString(),
      errorReason: lastErr instanceof Error ? lastErr.message : String(lastErr),
      retryCount: maxAttempts,
      contractAddress: this.contractAddress,
      rpcUrl: this.rpcUrl,
    });

    throw new Error(
      `Soroban transaction failed after ${maxAttempts} attempts: ${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }`,
    );
  }

  private encodeReminderArgs(eventData: ReminderEventPayload): xdr.ScVal[] {
    return [
      xdr.ScVal.scvString(eventData.subscriptionId),
      xdr.ScVal.scvString(eventData.subscriptionName ?? ""),
      xdr.ScVal.scvString(eventData.reminderType ?? ""),
      xdr.ScVal.scvString(String(eventData.renewalDate ?? "")),
      xdr.ScVal.scvVec(
        (eventData.deliveryChannels ?? []).map((c: string) =>
          xdr.ScVal.scvString(c),
        ),
      ),
      xdr.ScVal.scvString(eventData.billingCycle ?? ""),
      xdr.ScVal.scvString(eventData.timestamp ?? new Date().toISOString()),
    ];
  }

  private encodeSubscriptionArgs(eventData: SubscriptionEventPayload): xdr.ScVal[] {
    return [
      xdr.ScVal.scvString(eventData.subscriptionId),
      xdr.ScVal.scvString(eventData.operation ?? ""),
      xdr.ScVal.scvString(eventData.subscriptionName ?? ""),
      xdr.ScVal.scvString(String(eventData.price ?? "")),
      xdr.ScVal.scvString(eventData.billingCycle ?? ""),
      xdr.ScVal.scvString(eventData.status ?? ""),
      xdr.ScVal.scvString(eventData.timestamp ?? new Date().toISOString()),
    ];
  }

  private encodeGiftCardArgs(eventData: GiftCardEventPayload): xdr.ScVal[] {
    return [
      xdr.ScVal.scvString(eventData.subscriptionId),
      xdr.ScVal.scvString(eventData.giftCardHash),
      xdr.ScVal.scvString(eventData.provider ?? ""),
      xdr.ScVal.scvString(eventData.timestamp ?? new Date().toISOString()),
    ];
  }

  private async enqueueDeadLetter<T>(payload: DLQPayload<T>): Promise<void> {
    const dlqKey = "dlq:blockchain_tx";
    try {
      if (this.redisClient) {
        await this.redisClient.lPush(dlqKey, JSON.stringify(payload));
        logger.error("Enqueued to DLQ (Redis) for blockchain tx", { dlqKey });
        return;
      }
    } catch (err) {
      logger.warn("Failed to push to Redis DLQ, will fallback to DB flag:", err);
    }

    try {
      // Fallback: write to a DB log row for observability; consumers could reprocess later
      await supabase.from("blockchain_logs").insert({
        user_id: "system",
        event_type: "blockchain_dead_letter",
        event_data: payload,
        status: "dead_letter",
      });
      logger.error("Recorded blockchain dead letter in database");
    } catch (dbErr) {
      logger.error("Failed to record dead letter in database:", dbErr);
    }
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private previewArgs(args: xdr.ScVal[]): string {
    try {
      // Provide a light-weight, non-sensitive preview
      return JSON.stringify(
        args.map((a) => a.switch().name),
      );
    } catch {
      return "[unavailable]";
    }
  }
}

export const blockchainService = new BlockchainService();
