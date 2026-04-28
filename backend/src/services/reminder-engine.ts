import logger from '../config/logger';
import { supabase } from '../config/database';
import { emailService } from './email-service';
import { pushService, PushSubscription } from './push-service';
import { blockchainService } from './blockchain-service';
import {
  ReminderSchedule,
  Subscription,
  UserProfile,
  NotificationPayload,
  NotificationDelivery,
} from '../types/reminder';
import { calculateBackoffDelay } from '../utils/retry';
import { userPreferenceService } from './user-preference-service';
import { notificationPreferenceService } from './notification-preference-service';
import { reminderSettingsService } from './reminder-settings-service';
import { quietHoursService } from './quiet-hours-service';
import { delayedNotificationService } from './delayed-notification-service';
import { analyticsService } from './analytics-service';

export interface ReminderEngineOptions {
  defaultDaysBefore?: number[];
  maxRetryAttempts?: number;
}

export class ReminderEngine {
  private defaultDaysBefore: number[];
  private maxRetryAttempts: number;

  constructor(options: ReminderEngineOptions = {}) {
    this.defaultDaysBefore = options.defaultDaysBefore || [7, 3, 1];
    this.maxRetryAttempts = options.maxRetryAttempts || 3;
  }

  // ---------------------------------------------------------------------------
  // Public methods
  // ---------------------------------------------------------------------------

  /**
   * Process pending reminders for a given date
   */
  async processReminders(targetDate: Date = new Date()): Promise<void> {
    const dateString = targetDate.toISOString().split('T')[0];

    logger.info(`Processing reminders for date: ${dateString}`);

    try {
      const { data: reminders, error } = await supabase
        .from('reminder_schedules')
        .select('*')
        .eq('reminder_date', dateString)
        .eq('status', 'pending');

      if (error) {
        logger.error('Failed to fetch reminders:', error);
        throw error;
      }

      if (!reminders || reminders.length === 0) {
        logger.info(`No pending reminders found for ${dateString}`);
        return;
      }

      logger.info(`Found ${reminders.length} reminders to process`);

      for (const reminder of reminders) {
        try {
          await this.processReminder(reminder);
        } catch (error) {
          logger.error(`Failed to process reminder ${reminder.id}:`, error);
        }
      }
    } catch (error) {
      logger.error('Error processing reminders:', error);
      throw error;
    }
  }

  /**
   * Process delayed notifications that are ready to be sent
   */
  async processDelayedNotifications(): Promise<void> {
    logger.info('Processing delayed notifications');

    try {
      const delayedNotifications = await delayedNotificationService.getPendingDelayedNotifications();

      if (delayedNotifications.length === 0) {
        logger.info('No delayed notifications ready to be sent');
        return;
      }

      logger.info(`Found ${delayedNotifications.length} delayed notifications to process`);

      for (const delayedNotification of delayedNotifications) {
        try {
          // Check if it's an appropriate time to send delayed notifications
          const userPreferences = await userPreferenceService.getPreferences(delayedNotification.user_id);
          
          if (!quietHoursService.isAppropriateTimeForDelayedNotifications(userPreferences)) {
            logger.debug(`Skipping delayed notification ${delayedNotification.id} - not appropriate time`);
            continue;
          }

          // Send the delayed notification
          await this.sendDelayedNotification(delayedNotification);
          
          // Mark as sent
          await delayedNotificationService.markDelayedNotificationAsSent(delayedNotification.id);
          
          logger.info(`Delayed notification ${delayedNotification.id} sent successfully`);
        } catch (error) {
          logger.error(`Failed to process delayed notification ${delayedNotification.id}:`, error);
        }
      }
    } catch (error) {
      logger.error('Error processing delayed notifications:', error);
      throw error;
    }
  }

  /**
   * Check for insufficient wallet balance for prepaid users
   */
  async checkInsufficientBalance(): Promise<void> {
    logger.info('Checking for insufficient wallet balance');

    try {
      // Get all users with budgets
      const { data: budgets, error } = await supabase
        .from('monthly_budgets')
        .select('user_id, budget_limit')
        .is('category', null); // Overall budget

      if (error) {
        logger.error('Failed to fetch budgets:', error);
        throw error;
      }

      if (!budgets || budgets.length === 0) {
        logger.info('No users with budgets found');
        return;
      }

      for (const budget of budgets) {
        try {
          await this.checkUserInsufficientBalance(budget.user_id, budget.budget_limit);
        } catch (error) {
          logger.error(`Failed to check balance for user ${budget.user_id}:`, error);
        }
      }
    } catch (error) {
      logger.error('Error checking insufficient balance:', error);
      throw error;
    }
  }

  /**
   * Check insufficient balance for a specific user
   */
  private async checkUserInsufficientBalance(userId: string, budgetLimit: number): Promise<void> {
    // Get analytics summary to get current spend
    const summary = await analyticsService.getSummary(userId);
    const remainingBalance = budgetLimit - summary.budget_status.current_spend;

    if (remainingBalance <= 0) {
      // Already over budget, perhaps already alerted
      return;
    }

    // Get active subscriptions
    const { data: subscriptions, error } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'active');

    if (error) {
      logger.error('Failed to fetch subscriptions:', error);
      throw error;
    }

    if (!subscriptions || subscriptions.length === 0) {
      return;
    }

    const userProfile = await this.getUserProfile(userId);
    if (!userProfile) {
      logger.warn(`User profile ${userId} not found`);
      return;
    }

    const preferences = await userPreferenceService.getPreferences(userId);

    for (const sub of subscriptions) {
      if (sub.price > remainingBalance) {
        // Send critical alert
        const payload: NotificationPayload = {
          title: 'Insufficient Wallet Balance',
          body: `Wallet balance ($${remainingBalance.toFixed(2)}) is insufficient for ${sub.name} ($${sub.price.toFixed(2)}).`,
          subscription: sub as Subscription,
          reminderType: 'renewal',
          daysBefore: 0,
          renewalDate: sub.next_billing_date || new Date().toISOString(),
          priority: 'critical',
        };

        // Send directly without delivery records
        const deliveryChannels = preferences.notification_channels;

        // Email delivery
        if (deliveryChannels.includes('email') && preferences.email_opt_ins.reminders) {
          await emailService.sendReminderEmail(
            userProfile.email,
            payload,
            { maxAttempts: this.maxRetryAttempts },
          );
        }

        // Push delivery
        if (deliveryChannels.includes('push')) {
          const pushSubscription = await this.getPushSubscription(userId);
          if (pushSubscription) {
            await pushService.sendPushNotification(
              pushSubscription,
              payload,
              { maxAttempts: this.maxRetryAttempts },
            );
          }
        }

        logger.info(`Sent insufficient balance alert for user ${userId}, subscription ${sub.name}`);
      }
    }
  }

  /**
   * Send a delayed notification
   */
  private async sendDelayedNotification(delayedNotification: any): Promise<void> {
    const payload = delayedNotification.notification_payload;
    const userPreferences = await userPreferenceService.getPreferences(delayedNotification.user_id);
    
    // Get user profile for email
    const userProfile = await this.getUserProfile(delayedNotification.user_id);
    if (!userProfile) {
      throw new Error('User profile not found');
    }

    const deliveryChannels = userPreferences.notification_channels;

    // Email delivery
    if (deliveryChannels.includes('email') && userPreferences.email_opt_ins.reminders) {
      await emailService.sendReminderEmail(userProfile.email, payload, { maxAttempts: 1 });
    }

    // Push delivery
    if (deliveryChannels.includes('push')) {
      const pushSubscription = await this.getPushSubscription(delayedNotification.user_id);
      if (pushSubscription) {
        await pushService.sendPushNotification(pushSubscription, payload, { maxAttempts: 1 });
      }
    }
  }

  /**
   * Process failed deliveries that need retry
   */
  async processRetries(): Promise<void> {
    const now = new Date().toISOString();

    logger.info('Processing delivery retries');

    try {
      const { data: deliveries, error } = await supabase
        .from('notification_deliveries')
        .select('*, reminder_schedules!inner(*)')
        .eq('status', 'retrying')
        .lte('next_retry_at', now)
        .lt('attempt_count', this.maxRetryAttempts);

      if (error) {
        logger.error('Failed to fetch retry deliveries:', error);
        throw error;
      }

      if (!deliveries || deliveries.length === 0) {
        logger.info('No deliveries need retry');
        return;
      }

      logger.info(`Found ${deliveries.length} deliveries to retry`);

      for (const delivery of deliveries) {
        try {
          await this.retryDelivery(
            delivery as NotificationDelivery & { reminder_schedules: ReminderSchedule },
          );
        } catch (error) {
          logger.error(`Failed to retry delivery ${delivery.id}:`, error);
        }
      }
    } catch (error) {
      logger.error('Error processing retries:', error);
      throw error;
    }
  }

  /**
   * Schedule reminders for subscriptions with upcoming renewals.
   * Respects per-subscription notification preferences with fallback
   * to user global settings and engine defaults.
   */
  async scheduleReminders(daysBefore: number[] = this.defaultDaysBefore): Promise<void> {
    logger.info(`Scheduling reminders, engine defaults: ${daysBefore.join(', ')}`);

    try {
      const { data: subscriptions, error } = await supabase
        .from('subscriptions')
        .select('*')
        .eq('status', 'active')
        .not('active_until', 'is', null)
        .gt('active_until', new Date().toISOString());

      if (error) {
        logger.error('Failed to fetch subscriptions:', error);
        throw error;
      }

      if (!subscriptions || subscriptions.length === 0) {
        logger.info('No active subscriptions with future renewal dates');
        return;
      }

      logger.info(`Found ${subscriptions.length} subscriptions to schedule reminders for`);

      for (const subscription of subscriptions) {
        if (!subscription.active_until) continue;

        // Resolve preferences: per-subscription → user global → engine default
        const resolvedPrefs = await this.getNotificationPreferences(
          subscription.id,
          subscription.user_id,
        );

        // Skip entirely if muted or snoozed
        if (resolvedPrefs.muted) {
          logger.debug(`Skipping reminders for muted subscription ${subscription.id}`);
          continue;
        }

        const renewalDate = new Date(subscription.active_until);
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        for (const days of resolvedPrefs.reminder_days_before) {
          const reminderDate = new Date(renewalDate);
          reminderDate.setDate(reminderDate.getDate() - days);
          reminderDate.setHours(0, 0, 0, 0);

          if (reminderDate >= today) {
            const { data: existing } = await supabase
              .from('reminder_schedules')
              .select('id')
              .eq('subscription_id', subscription.id)
              .eq('days_before', days)
              .eq('status', 'pending')
              .single();

            if (!existing) {
              await supabase.from('reminder_schedules').insert({
                subscription_id: subscription.id,
                user_id: subscription.user_id,
                reminder_date: reminderDate.toISOString().split('T')[0],
                reminder_type: 'renewal',
                days_before: days,
                status: 'pending',
              });

              logger.debug(
                `Scheduled reminder for subscription ${subscription.id} (${days} days before)`,
              );
            }
          }
        }
      }

      logger.info('Reminder scheduling completed');
    } catch (error) {
      logger.error('Error scheduling reminders:', error);
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  /**
   * Process a single reminder
   */
  private async processReminder(reminder: ReminderSchedule): Promise<void> {
    logger.info(`Processing reminder ${reminder.id} for subscription ${reminder.subscription_id}`);

    try {
      const subscription = await this.getSubscription(reminder.subscription_id);
      if (!subscription) {
        logger.warn(`Subscription ${reminder.subscription_id} not found`);
        await this.markReminderAsFailed(reminder.id, 'Subscription not found');
        return;
      }

      if (subscription.status === 'paused') {
        logger.info(`Skipping reminder ${reminder.id} — subscription ${reminder.subscription_id} is paused`);
        await this.markReminderAsFailed(reminder.id, 'Subscription is paused');
        return;
      }

      const userProfile = await this.getUserProfile(reminder.user_id);
      if (!userProfile) {
        logger.warn(`User profile ${reminder.user_id} not found`);
        await this.markReminderAsFailed(reminder.id, 'User profile not found');
        return;
      }

      const renewalDate = reminder.reminder_type === 'trial_expiry'
        ? (subscription.trial_ends_at || new Date().toISOString())
        : (subscription.active_until || new Date().toISOString());
      const payload: NotificationPayload = {
        title: `${subscription.name} Renewal Reminder`,
        body: `${subscription.name} will renew in ${reminder.days_before} day${reminder.days_before > 1 ? 's' : ''}`,
        subscription,
        reminderType: reminder.reminder_type,
        daysBefore: reminder.days_before,
        renewalDate,
      };

      // Determine notification priority
      payload.priority = quietHoursService.determineNotificationPriority(payload);

      const preferences = await userPreferenceService.getPreferences(reminder.user_id);
      
      // Check quiet hours
      const quietHoursCheck = quietHoursService.shouldSendDuringQuietHours(preferences, payload);
      
      if (quietHoursCheck.shouldDelay) {
        // Store notification for later delivery
        await delayedNotificationService.storeDelayedNotification(
          reminder.user_id,
          reminder.id,
          payload,
          quietHoursCheck.delayUntil!,
          payload.priority!,
          quietHoursCheck.reason
        );
        
        // Mark reminder as sent (it's scheduled for later)
        await supabase
          .from('reminder_schedules')
          .update({
            status: 'sent',
            updated_at: new Date().toISOString(),
          })
          .eq('id', reminder.id);
          
        logger.info(`Reminder ${reminder.id} delayed due to quiet hours until ${quietHoursCheck.delayUntil?.toISOString()}`);
        return;
      }

      const deliveryChannels = preferences.notification_channels;
      const deliveries: NotificationDelivery[] = [];

      // Email delivery
      if (deliveryChannels.includes('email') && preferences.email_opt_ins.reminders) {
        const emailDelivery = await this.createDeliveryRecord(
          reminder.id,
          reminder.user_id,
          'email',
        );
        deliveries.push(emailDelivery);

        const emailResult = await emailService.sendReminderEmail(
          userProfile.email,
          payload,
          { maxAttempts: this.maxRetryAttempts },
        );

        await this.updateDeliveryRecord(
          emailDelivery.id,
          emailResult.success ? 'sent' : 'failed',
          emailResult.error,
          emailResult.metadata,
        );
      }

      // Push delivery
      if (deliveryChannels.includes('push')) {
        const pushSubscription = await this.getPushSubscription(reminder.user_id);
        if (pushSubscription) {
          const pushDelivery = await this.createDeliveryRecord(
            reminder.id,
            reminder.user_id,
            'push',
          );
          deliveries.push(pushDelivery);

          const pushResult = await pushService.sendPushNotification(
            pushSubscription,
            payload,
            { maxAttempts: this.maxRetryAttempts },
          );

          await this.updateDeliveryRecord(
            pushDelivery.id,
            pushResult.success ? 'sent' : 'failed',
            pushResult.error,
            pushResult.metadata,
          );

          // Clean up stale push subscription on permanent failure (410/404)
          if (!pushResult.success && pushResult.metadata?.retryable === false) {
            await this.removeStalePushSubscription(reminder.user_id);
          }
        } else {
          logger.debug(
            `No push subscription found for user ${reminder.user_id}, skipping push delivery`,
          );
        }
      }

      await blockchainService.logReminderEvent(
        reminder.user_id,
        payload,
        deliveryChannels,
      );

      const hasSuccess = deliveries.some(
        (d) => d.status === 'sent' || d.status === 'retrying',
      );

      await supabase
        .from('reminder_schedules')
        .update({
          status: hasSuccess ? 'sent' : 'failed',
          updated_at: new Date().toISOString(),
        })
        .eq('id', reminder.id);

      logger.info(`Reminder ${reminder.id} processed successfully`);
    } catch (error) {
      logger.error(`Error processing reminder ${reminder.id}:`, error);
      await this.markReminderAsFailed(reminder.id, String(error));
      throw error;
    }
  }

  /**
   * Retry a failed delivery
   */
  private async retryDelivery(
    delivery: NotificationDelivery & { reminder_schedules: ReminderSchedule },
  ): Promise<void> {
    const reminder = delivery.reminder_schedules;
    const newAttemptCount = delivery.attempt_count + 1;

    logger.info(
      `Retrying delivery ${delivery.id} (attempt ${newAttemptCount}/${this.maxRetryAttempts})`,
    );

    try {
      const subscription = await this.getSubscription(reminder.subscription_id);
      const userProfile = await this.getUserProfile(delivery.user_id);

      if (!subscription || !userProfile) {
        await this.markDeliveryAsFailed(delivery.id, 'Subscription or user not found');
        return;
      }

      const renewalDate = subscription.active_until || new Date().toISOString();
      const payload: NotificationPayload = {
        title: `${subscription.name} Renewal Reminder`,
        body: `${subscription.name} will renew in ${reminder.days_before} day${reminder.days_before > 1 ? 's' : ''}`,
        subscription,
        reminderType: reminder.reminder_type,
        daysBefore: reminder.days_before,
        renewalDate,
      };

      let result: { success: boolean; error?: string; metadata?: Record<string, any> };

      if (delivery.channel === 'email') {
        result = await emailService.sendReminderEmail(userProfile.email, payload, {
          maxAttempts: 1,
        });
      } else if (delivery.channel === 'push') {
        const pushSubscription = await this.getPushSubscription(delivery.user_id);
        if (!pushSubscription) {
          await this.markDeliveryAsFailed(delivery.id, 'Push subscription not found');
          return;
        }
        result = await pushService.sendPushNotification(pushSubscription, payload, {
          maxAttempts: 1,
        });

        // Clean up stale subscription on permanent failure
        if (!result.success && result.metadata?.retryable === false) {
          await this.removeStalePushSubscription(delivery.user_id);
        }
      } else {
        await this.markDeliveryAsFailed(delivery.id, `Unknown channel: ${delivery.channel}`);
        return;
      }

      if (result.success) {
        await supabase
          .from('notification_deliveries')
          .update({
            status: 'sent',
            attempt_count: newAttemptCount,
            last_attempt_at: new Date().toISOString(),
            next_retry_at: null,
            error_message: null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', delivery.id);
      } else {
        const delay = calculateBackoffDelay(newAttemptCount);
        const nextRetryAt = new Date(Date.now() + delay);

        if (newAttemptCount >= this.maxRetryAttempts) {
          await this.markDeliveryAsFailed(delivery.id, result.error || 'Max attempts reached');
        } else {
          await supabase
            .from('notification_deliveries')
            .update({
              status: 'retrying',
              attempt_count: newAttemptCount,
              last_attempt_at: new Date().toISOString(),
              next_retry_at: nextRetryAt.toISOString(),
              error_message: result.error || null,
              updated_at: new Date().toISOString(),
            })
            .eq('id', delivery.id);
        }
      }
    } catch (error) {
      logger.error(`Error retrying delivery ${delivery.id}:`, error);
      await this.markDeliveryAsFailed(delivery.id, String(error));
    }
  }

  // Trial reminder windows (days before trial ends)
  private static readonly TRIAL_REMINDER_DAYS = [14, 7, 3, 1, 0];

  /**
   * Schedule trial-specific reminders for active trial subscriptions.
   * Uses more aggressive windows than regular renewals.
   * Credit-card-required trials get the full 14-day early warning.
   */
  async scheduleTrialReminders(): Promise<void> {
    logger.info('Scheduling trial reminders');

    try {
      const { data: trials, error } = await supabase
        .from('subscriptions')
        .select('*')
        .eq('is_trial', true)
        .in('status', ['active'])
        .not('trial_ends_at', 'is', null)
        .gt('trial_ends_at', new Date().toISOString());

      if (error) throw error;
      if (!trials || trials.length === 0) {
        logger.info('No active trials to schedule reminders for');
        return;
      }

      logger.info(`Found ${trials.length} active trials`);

      for (const sub of trials) {
        const trialEnd = new Date(sub.trial_ends_at);
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // Credit-card-required trials get all windows; others skip the 14-day one
        const windows = sub.credit_card_required
          ? ReminderEngine.TRIAL_REMINDER_DAYS
          : ReminderEngine.TRIAL_REMINDER_DAYS.filter((d) => d !== 14);

        for (const days of windows) {
          const reminderDate = new Date(trialEnd);
          reminderDate.setDate(reminderDate.getDate() - days);
          reminderDate.setHours(0, 0, 0, 0);

          if (reminderDate >= today) {
            const { data: existing } = await supabase
              .from('reminder_schedules')
              .select('id')
              .eq('subscription_id', sub.id)
              .eq('reminder_type', 'trial_expiry')
              .eq('days_before', days)
              .eq('status', 'pending')
              .single();

            if (!existing) {
              await supabase.from('reminder_schedules').insert({
                subscription_id: sub.id,
                user_id: sub.user_id,
                reminder_date: reminderDate.toISOString().split('T')[0],
                reminder_type: 'trial_expiry',
                days_before: days,
                status: 'pending',
              });
              logger.debug(`Scheduled trial reminder for ${sub.id} (${days} days before)`);
            }
          }
        }
      }

      logger.info('Trial reminder scheduling completed');
    } catch (error) {
      logger.error('Error scheduling trial reminders:', error);
      throw error;
    }
  }

  /**
   * Resolve the effective notification preferences for a subscription.
   * Priority: per-subscription override → user global settings → engine defaults
   */
  private async getNotificationPreferences(
    subscriptionId: string,
    userId: string,
  ): Promise<{
    reminder_days_before: number[];
    channels: string[];
    muted: boolean;
  }> {
    // 1. Per-subscription override
    try {
      const override = await notificationPreferenceService.getPreferences(subscriptionId);
      if (override) {
        return {
          reminder_days_before: override.reminder_days_before,
          channels: override.channels,
          muted: override.muted,
        };
      }
    } catch (err) {
      logger.warn(
        `Could not fetch subscription-level prefs for ${subscriptionId}, falling back:`,
        err,
      );
    }

    // 2. User global settings
    try {
      const userPrefs = await userPreferenceService.getPreferences(userId);
      const reminderSettings = await reminderSettingsService.getSettings(userId);
      return {
        reminder_days_before: reminderSettings.reminder_days_before,
        channels: userPrefs.notification_channels ?? ['email'],
        muted: false,
      };
    } catch (err) {
      logger.warn(
        `Could not fetch user-level prefs for ${userId}, using engine defaults:`,
        err,
      );
    }

    // 3. Engine defaults
    return {
      reminder_days_before: this.defaultDaysBefore,
      channels: ['email'],
      muted: false,
    };
  }

  private async getSubscription(id: string): Promise<Subscription | null> {
    const { data, error } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !data) return null;
    return data as Subscription;
  }

  private async getUserProfile(userId: string): Promise<UserProfile | null> {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (error || !data) return null;

    let email = data.email || '';

    try {
      const { data: authUser, error: authError } = await supabase.auth.admin.getUserById(userId);
      if (!authError && authUser?.user?.email) {
        email = authUser.user.email;
      }
    } catch (authErr) {
      logger.warn(`Could not fetch email from auth.users for user ${userId}:`, authErr);
    }

    if (!email) {
      const { data: emailAccount } = await supabase
        .from('email_accounts')
        .select('email')
        .eq('user_id', userId)
        .eq('is_connected', true)
        .limit(1)
        .single();

      if (emailAccount) {
        email = emailAccount.email;
      }
    }

    if (!email) {
      logger.error(`No email found for user ${userId}`);
      return null;
    }

    return {
      id: data.id,
      email,
      full_name: data.full_name || data.display_name || null,
      timezone: data.timezone || 'UTC',
      currency: data.currency || 'USD',
    };
  }

  /**
   * Fetch the most recently created push subscription for a user.
   * Returns null if the user has no active push subscription.
   */
  private async getPushSubscription(userId: string): Promise<PushSubscription | null> {
    try {
      const { data, error } = await supabase
        .from('push_subscriptions')
        .select('endpoint, p256dh, auth')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (error) {
        if (error.code === 'PGRST116') return null;
        logger.error(`Error fetching push subscription for user ${userId}:`, error);
        return null;
      }

      if (!data) return null;

      return {
        endpoint: data.endpoint,
        keys: {
          p256dh: data.p256dh,
          auth: data.auth,
        },
      };
    } catch (err) {
      logger.error(`Unexpected error fetching push subscription for user ${userId}:`, err);
      return null;
    }
  }

  /**
   * Remove all push subscriptions for a user when the browser reports
   * the subscription is gone (HTTP 410/404).
   */
  private async removeStalePushSubscription(userId: string): Promise<void> {
    try {
      const { error } = await supabase
        .from('push_subscriptions')
        .delete()
        .eq('user_id', userId);

      if (error) {
        logger.warn(`Failed to remove stale push subscriptions for user ${userId}:`, error);
      } else {
        logger.info(`Removed stale push subscriptions for user ${userId}`);
      }
    } catch (err) {
      logger.error(`Unexpected error removing stale push subscriptions for user ${userId}:`, err);
    }
  }

  private async createDeliveryRecord(
    reminderScheduleId: string,
    userId: string,
    channel: 'email' | 'push',
  ): Promise<NotificationDelivery> {
    const { data, error } = await supabase
      .from('notification_deliveries')
      .insert({
        reminder_schedule_id: reminderScheduleId,
        user_id: userId,
        channel,
        status: 'pending',
        attempt_count: 0,
        max_attempts: this.maxRetryAttempts,
      })
      .select()
      .single();

    if (error) throw error;
    return data as NotificationDelivery;
  }

  private async updateDeliveryRecord(
    deliveryId: string,
    status: 'sent' | 'failed' | 'retrying',
    errorMessage: string | undefined,
    metadata: Record<string, any> | undefined,
  ): Promise<void> {
    const updateData: any = {
      status,
      attempt_count: 1,
      last_attempt_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    if (errorMessage) updateData.error_message = errorMessage;
    if (metadata) updateData.metadata = metadata;

    if (status === 'retrying') {
      const delay = calculateBackoffDelay(1);
      updateData.next_retry_at = new Date(Date.now() + delay).toISOString();
    }

    const { error } = await supabase
      .from('notification_deliveries')
      .update(updateData)
      .eq('id', deliveryId);

    if (error) throw error;
  }

  private async markReminderAsFailed(reminderId: string, reason: string): Promise<void> {
    await supabase
      .from('reminder_schedules')
      .update({
        status: 'failed',
        updated_at: new Date().toISOString(),
      })
      .eq('id', reminderId);

    logger.warn(`Marked reminder ${reminderId} as failed: ${reason}`);
  }

  private async markDeliveryAsFailed(deliveryId: string, reason: string): Promise<void> {
    await supabase
      .from('notification_deliveries')
      .update({
        status: 'failed',
        error_message: reason,
        updated_at: new Date().toISOString(),
      })
      .eq('id', deliveryId);

    logger.warn(`Marked delivery ${deliveryId} as failed: ${reason}`);
  }
}

export const reminderEngine = new ReminderEngine();