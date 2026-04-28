"use client";

import { useState, useCallback, useEffect } from "react";
import { apiGet } from "../lib/api";
import { useUndoManager } from "@/hooks/use-undo-manager";
import type { Subscription as DBSubscription } from "@/lib/supabase/subscriptions";
import {
  createSubscription,
  updateSubscription,
  deleteSubscription as dbDeleteSubscription,
  bulkDeleteSubscriptions,
} from "@/lib/supabase/subscriptions";
import { retryWithBackoff, getErrorMessage } from "@/lib/network-utils";
import { validateSubscriptionData } from "@/lib/validation";
import { checkDuplicate } from "@/lib/subscription-utils";

export interface ToastPayload {
  title: string;
  description: string;
  variant: "success" | "error" | "default" | "warning";
  action?: {
    label: string;
    onClick: () => void;
  };
}

export interface DialogPayload {
  type: string;
  [key: string]: unknown;
}

export interface EmailAccount {
  id: number;
  email: string;
  isPrimary?: boolean;
  [key: string]: unknown;
}

export interface SubscriptionCreatePayload {
  name: string;
  category: string;
  price: number;
  icon?: string;
  renewsIn?: number;
  status?: string;
  color?: string;
  renewalUrl?: string | null;
  tags?: string[];
  isTrial?: boolean;
  trialEndsAt?: string | null;
  priceAfterTrial?: number | null;
}

export interface SubscriptionUpdatePayload {
  name?: string;
  category?: string;
  price?: number;
  icon?: string;
  renewsIn?: number;
  status?: string;
  color?: string;
  renewalUrl?: string | null;
  tags?: string[];
  billingCycle?: string;
  pricingType?: string;
}

export type SubscriptionState = DBSubscription & {
  renewsIn: number;
  renewalUrl: string | null;
  dateAdded: string;
  emailAccountId: number | null;
  lastUsedAt: string | null;
  hasApiKey: boolean;
  isTrial: boolean;
  trialEndsAt: string | null;
  priceAfterTrial: number | null;
  manuallyEdited: boolean;
  editedFields: string[];
  pricingType: string;
  billingCycle: string;
  cancelledAt?: string;
  activeUntil?: string;
  pausedAt?: string;
  resumesAt?: string;
  expiredAt: string | null;
};

function mapDbSubToState(dbSub: Record<string, unknown>): SubscriptionState {
  return {
    id: dbSub.id as number,
    user_id: dbSub.user_id as string | undefined,
    name: dbSub.name as string,
    category: dbSub.category as string,
    price: dbSub.price as number,
    icon: (dbSub.icon as string) || "🔗",
    renews_in: (dbSub.renews_in as number) || null,
    status: dbSub.status as string,
    color: (dbSub.color as string) || "#000000",
    renewal_url: (dbSub.renewal_url as string) || null,
    tags: (dbSub.tags as string[]) || [],
    date_added: dbSub.date_added as string,
    email_account_id: (dbSub.email_account_id as number) || null,
    last_used_at: (dbSub.last_used_at as string) || null,
    has_api_key: (dbSub.has_api_key as boolean) || false,
    is_trial: (dbSub.is_trial as boolean) || false,
    trial_ends_at: (dbSub.trial_ends_at as string) || null,
    price_after_trial: (dbSub.price_after_trial as number) || null,
    source: (dbSub.source as string) || "manual",
    manually_edited: (dbSub.manually_edited as boolean) || false,
    edited_fields: (dbSub.edited_fields as string[]) || [],
    pricing_type: (dbSub.pricing_type as string) || "fixed",
    billing_cycle: (dbSub.billing_cycle as string) || "monthly",
    expired_at: (dbSub.expired_at as string) || null,
    notes: (dbSub.notes as string) || null,
    custom_tag_ids: (dbSub.custom_tag_ids as string[]) || null,
    renewsIn: (dbSub.renews_in as number) || (dbSub.renewsIn as number) || 30,
    renewalUrl: (dbSub.renewal_url as string) || (dbSub.renewalUrl as string) || null,
    dateAdded: (dbSub.date_added as string) || (dbSub.dateAdded as string),
    emailAccountId: (dbSub.email_account_id as number) || (dbSub.emailAccountId as number),
    lastUsedAt: (dbSub.last_used_at as string) || (dbSub.lastUsedAt as string) || null,
    hasApiKey: (dbSub.has_api_key as boolean) || (dbSub.hasApiKey as boolean) || false,
    isTrial: (dbSub.is_trial as boolean) || (dbSub.isTrial as boolean) || false,
    trialEndsAt: (dbSub.trial_ends_at as string) || (dbSub.trialEndsAt as string) || null,
    priceAfterTrial: (dbSub.price_after_trial as number) || (dbSub.priceAfterTrial as number) || null,
    manuallyEdited: (dbSub.manually_edited as boolean) || (dbSub.manuallyEdited as boolean) || false,
    editedFields: (dbSub.edited_fields as string[]) || (dbSub.editedFields as string[]) || [],
    pricingType: (dbSub.pricing_type as string) || (dbSub.pricingType as string) || "fixed",
    billingCycle: (dbSub.billing_cycle as string) || (dbSub.billingCycle as string) || "monthly",
    expiredAt: (dbSub.expired_at as string) || (dbSub.expiredAt as string) || null,
  };
}

interface UseSubscriptionsProps {
  initialSubscriptions: DBSubscription[];
  maxSubscriptions: number;
  emailAccounts: EmailAccount[];
  onToast: (toast: ToastPayload) => void;
  onUpgradePlan: () => void;
  onShowDialog?: (dialog: DialogPayload) => void;
  onDeleteWithUndo?: (subscription: DBSubscription) => void;
}

export function useSubscriptions({
  initialSubscriptions,
  maxSubscriptions,
  emailAccounts,
  onToast,
  onUpgradePlan,
  onShowDialog,
  onDeleteWithUndo,
}: UseSubscriptionsProps) {
  const {
    currentState: subscriptions,
    addToHistory,
    undo,
    redo,
    canUndo,
    canRedo,
  } = useUndoManager<SubscriptionState>(initialSubscriptions as SubscriptionState[]);

  useEffect(() => {
    let mounted = true;
    const fetchSubscriptions = async () => {
      try {
        const data = await apiGet("/api/subscriptions");
        if (!mounted) return;

        const items = (data?.subscriptions || []).map(mapDbSubToState);

        if (items.length > 0) {
          addToHistory(items);
        }
      } catch {
        // ignore - keep initial subscriptions
      }
    };

    fetchSubscriptions();

    return () => {
      mounted = false;
    };
  }, [addToHistory]);

  const [loading, setLoading] = useState(false);
  const [bulkActionLoading, setBulkActionLoading] = useState(false);
  const [selectedSubscriptions, setSelectedSubscriptions] = useState<
    Set<number>
  >(new Set());
  const [selectedSubscription, setSelectedSubscription] = useState<SubscriptionState | null>(null);

  const updateSubscriptions = useCallback(
    (newSubs: SubscriptionState[]) => {
      addToHistory(newSubs);
    },
    [addToHistory]
  );

  const handleAddSubscription = useCallback(
    async (newSub: SubscriptionCreatePayload) => {
      const validation = validateSubscriptionData(newSub);
      if (!validation.isValid) {
        const firstError = Object.values(validation.errors)[0];
        onToast({
          title: "Validation error",
          description: firstError as string,
          variant: "error",
        });
        return;
      }

      if (checkDuplicate(subscriptions, newSub.name)) {
        onToast({
          title: "Duplicate subscription",
          description: `${newSub.name} already exists in your subscriptions`,
          variant: "error",
        });
        return;
      }

      if (subscriptions.length >= maxSubscriptions) {
        onUpgradePlan();
        return;
      }

      setLoading(true);

      try {
        const dbSubscription = await retryWithBackoff(async () => {
          return await createSubscription({
            name: newSub.name,
            category: newSub.category,
            price: newSub.price,
            icon: newSub.icon || "🔗",
            renews_in: newSub.renewsIn || 30,
            status: newSub.status || "active",
            color: newSub.color || "#000000",
            renewal_url: newSub.renewalUrl || null,
            tags: newSub.tags || [],
            date_added: new Date().toISOString(),
            email_account_id:
              emailAccounts.find((acc) => acc.isPrimary)?.id || 1,
            last_used_at: undefined,
            has_api_key: false,
            is_trial: newSub.isTrial || false,
            trial_ends_at: newSub.trialEndsAt || null,
            price_after_trial: newSub.priceAfterTrial || null,
            source: "manual",
            manually_edited: false,
            edited_fields: [],
            pricing_type: "fixed",
            billing_cycle: "monthly",
          });
        });

        const formattedSub: SubscriptionState = {
          id: dbSubscription.id,
          user_id: dbSubscription.user_id,
          name: dbSubscription.name,
          category: dbSubscription.category,
          price: dbSubscription.price,
          icon: dbSubscription.icon,
          renews_in: dbSubscription.renews_in,
          status: dbSubscription.status,
          color: dbSubscription.color,
          renewal_url: dbSubscription.renewal_url,
          tags: dbSubscription.tags,
          date_added: dbSubscription.date_added,
          email_account_id: dbSubscription.email_account_id,
          last_used_at: dbSubscription.last_used_at,
          has_api_key: dbSubscription.has_api_key,
          is_trial: dbSubscription.is_trial,
          trial_ends_at: dbSubscription.trial_ends_at,
          price_after_trial: dbSubscription.price_after_trial,
          source: dbSubscription.source,
          manually_edited: dbSubscription.manually_edited,
          edited_fields: dbSubscription.edited_fields,
          pricing_type: dbSubscription.pricing_type,
          billing_cycle: dbSubscription.billing_cycle,
          expired_at: dbSubscription.expired_at,
          notes: dbSubscription.notes,
          custom_tag_ids: dbSubscription.custom_tag_ids,
          renewsIn: dbSubscription.renews_in,
          renewalUrl: dbSubscription.renewal_url,
          dateAdded: dbSubscription.date_added,
          emailAccountId: dbSubscription.email_account_id,
          lastUsedAt: dbSubscription.last_used_at,
          hasApiKey: dbSubscription.has_api_key,
          isTrial: dbSubscription.is_trial,
          trialEndsAt: dbSubscription.trial_ends_at,
          priceAfterTrial: dbSubscription.price_after_trial,
          manuallyEdited: dbSubscription.manually_edited,
          editedFields: dbSubscription.edited_fields,
          pricingType: dbSubscription.pricing_type,
          billingCycle: dbSubscription.billing_cycle,
          expiredAt: dbSubscription.expired_at,
        };

        const updatedSubs = [...subscriptions, formattedSub];
        updateSubscriptions(updatedSubs);

        onToast({
          title: "Subscription added",
          description: `${newSub.name} has been added to your subscriptions`,
          variant: "success",
          action: {
            label: "Undo",
            onClick: async () => {
              try {
                await dbDeleteSubscription(dbSubscription.id);
                undo();
                onToast({
                  title: "Undone",
                  description: "Subscription addition has been undone",
                  variant: "default",
                });
              } catch {
                onToast({
                  title: "Error",
                  description: "Failed to undo subscription addition",
                  variant: "error",
                });
              }
            },
          },
        });
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        onToast({
          title: "Error",
          description: errorMessage,
          variant: "error",
          action: {
            label: "Retry",
            onClick: () => handleAddSubscription(newSub),
          },
        });
      } finally {
        setLoading(false);
      }
    },
    [
      subscriptions,
      maxSubscriptions,
      emailAccounts,
      updateSubscriptions,
      undo,
      onToast,
      onUpgradePlan,
    ]
  );

  const handleDeleteSubscription = useCallback(
    async (id: number) => {
      const sub = subscriptions.find((s) => s.id === id);
      if (!sub) return;

      let deletedSubToRestore: SubscriptionState | null = null;

      if (onDeleteWithUndo) {
        onDeleteWithUndo(sub);
        deletedSubToRestore = sub;
        const updatedSubs = subscriptions.filter((s) => s.id !== id);
        updateSubscriptions(updatedSubs);

        onToast({
          title: "Subscription deleted",
          description: `${sub.name} has been removed`,
          variant: "success",
          action: {
            label: "Undo",
            onClick: async () => {
              if (deletedSubToRestore) {
                const restoredSubs = [
                  ...subscriptions.filter((existing) => existing.id !== id),
                  deletedSubToRestore,
                ];
                updateSubscriptions(restoredSubs);
                onToast({
                  title: "Restored",
                  description: `${deletedSubToRestore.name} has been restored`,
                  variant: "success",
                });
              }
            },
          },
        });
      } else {
        try {
          await dbDeleteSubscription(id);
          const updatedSubs = subscriptions.filter((s) => s.id !== id);
          updateSubscriptions(updatedSubs);

          onToast({
            title: "Subscription deleted",
            description: `${sub.name} has been removed`,
            variant: "success",
          });
        } catch {
          onToast({
            title: "Error",
            description: "Failed to delete subscription",
            variant: "error",
          });
        }
      }
    },
    [subscriptions, updateSubscriptions, onToast, onDeleteWithUndo]
  );

  const handleEditSubscription = useCallback(
    async (id: number, updates: SubscriptionUpdatePayload) => {
      try {
        const dbUpdates: Partial<DBSubscription> & { manually_edited: boolean } = {
          name: updates.name,
          category: updates.category,
          price: updates.price,
          icon: updates.icon,
          renews_in: updates.renewsIn,
          status: updates.status,
          color: updates.color,
          renewal_url: updates.renewalUrl,
          tags: updates.tags,
          billing_cycle: updates.billingCycle,
          pricing_type: updates.pricingType,
          manually_edited: true,
        };

        await updateSubscription(id, dbUpdates);

        const updatedSubs = subscriptions.map((sub) => {
          if (sub.id !== id) return sub;

          const editedFields = Object.keys(updates).filter(
            (key) =>
              updates[key as keyof SubscriptionUpdatePayload] !== sub[key as keyof SubscriptionState]
          );

          return {
            ...sub,
            ...updates,
            manually_edited: true,
            edited_fields: [
              ...new Set([
                ...(sub.edited_fields || sub.editedFields || []),
                ...editedFields,
              ]),
            ],
            source: sub.source === "auto_detected" ? "manual" : sub.source,
          };
        });

        updateSubscriptions(updatedSubs);
        addToHistory(updatedSubs);

        onToast({
          title: "Subscription updated",
          description: "Your changes have been saved",
          variant: "success",
        });
      } catch {
        onToast({
          title: "Error",
          description: "Failed to update subscription",
          variant: "error",
        });
      }
    },
    [subscriptions, updateSubscriptions, addToHistory, onToast]
  );

  const handleCancelSubscription = useCallback(
    async (id: number) => {
      const sub = subscriptions.find((s) => s.id === id);
      if (!sub) return;

      const daysUntilRenewal = sub.renewsIn ?? sub.renews_in ?? 0;
      const activeUntil = new Date(
        Date.now() + daysUntilRenewal * 24 * 60 * 60 * 1000
      );

      try {
        await updateSubscription(id, {
          status: "cancelled",
          cancelled_at: new Date().toISOString(),
          active_until: activeUntil.toISOString(),
        });

        const updatedSubs = subscriptions.map((s) =>
          s.id === id
            ? {
                ...s,
                status: "cancelled",
                cancelledAt: new Date().toISOString(),
                activeUntil: activeUntil.toISOString(),
              }
            : s
        );

        updateSubscriptions(updatedSubs);
        addToHistory(updatedSubs);

        onToast({
          title: "Subscription cancelled",
          description: "The subscription has been cancelled",
          variant: "success",
        });
      } catch {
        onToast({
          title: "Error",
          description: "Failed to cancel subscription",
          variant: "error",
        });
      }
    },
    [subscriptions, updateSubscriptions, addToHistory, onToast]
  );

  const handlePauseSubscription = useCallback(
    async (id: number, resumeDate?: Date) => {
      const sub = subscriptions.find((s) => s.id === id);
      if (!sub) return;

      try {
        const resumeAt = resumeDate
          ? resumeDate.toISOString()
          : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

        const response = await fetch(`/api/subscriptions/${id}/pause`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ resumeAt, reason: "User requested pause" }),
        });

        if (!response.ok) {
          const err = await response.json();
          throw new Error(err.error || "Failed to pause subscription");
        }

        const updatedSubs = subscriptions.map((s) =>
          s.id === id
            ? {
                ...s,
                status: "paused",
                pausedAt: new Date().toISOString(),
                resumesAt: resumeAt,
              }
            : s
        );

        updateSubscriptions(updatedSubs);
        addToHistory(updatedSubs);

        onToast({
          title: "Subscription paused",
          description: "The subscription has been paused",
          variant: "success",
        });
      } catch (error) {
        onToast({
          title: "Error",
          description: error instanceof Error ? error.message : "Failed to pause subscription",
          variant: "error",
        });
      }
    },
    [subscriptions, updateSubscriptions, addToHistory, onToast]
  );

  const handleResumeSubscription = useCallback(
    async (id: number) => {
      const sub = subscriptions.find((s) => s.id === id);
      if (!sub) return;

      try {
        const response = await fetch(`/api/subscriptions/${id}/resume`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });

        if (!response.ok) {
          const err = await response.json();
          throw new Error(err.error || "Failed to resume subscription");
        }

        const updatedSubs = subscriptions.map((s) =>
          s.id === id
            ? {
                ...s,
                status: "active",
                pausedAt: undefined,
                resumesAt: undefined,
              }
            : s
        );

        updateSubscriptions(updatedSubs);
        addToHistory(updatedSubs);

        onToast({
          title: "Subscription resumed",
          description: "The subscription has been resumed",
          variant: "success",
        });
      } catch (error) {
        onToast({
          title: "Error",
          description: error instanceof Error ? error.message : "Failed to resume subscription",
          variant: "error",
        });
      }
    },
    [subscriptions, updateSubscriptions, addToHistory, onToast]
  );

  const handleToggleSubscriptionSelect = useCallback((id: number) => {
    setSelectedSubscriptions((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return newSet;
    });
  }, []);

  return {
    subscriptions,
    loading,
    bulkActionLoading,
    selectedSubscriptions,
    selectedSubscription,
    canUndo,
    canRedo,
    setSelectedSubscription,
    setBulkActionLoading,
    setSelectedSubscriptions,
    updateSubscriptions,
    addToHistory,
    undo,
    redo,
    handleAddSubscription,
    handleDeleteSubscription,
    handleEditSubscription,
    handleCancelSubscription,
    handlePauseSubscription,
    handleResumeSubscription,
    handleToggleSubscriptionSelect,
  };
}
