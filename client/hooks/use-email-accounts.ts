"use client";

import { useState, useCallback } from "react";
import type { Subscription } from "@/lib/supabase/subscriptions";
import type { Integration, IntegrationStatus } from "@/lib/integration-types";

interface UseEmailAccountsProps {
  initialAccounts: any[];
  subscriptions: Subscription[];
  updateSubscriptions: (subs: Subscription[]) => void;
  addToHistory: (subs: Subscription[]) => void;
  onToast: (toast: any) => void;
}

export function useEmailAccounts({
  initialAccounts,
  subscriptions,
  updateSubscriptions,
  addToHistory,
  onToast,
}: UseEmailAccountsProps) {
  const [emailAccounts, setEmailAccounts] = useState(initialAccounts);
  const [integrations, setIntegrations] = useState<Integration[]>([
    {
      id: 1,
      name: "Gmail",
      type: "Email Integration",
      status: IntegrationStatus.Connected,
      lastSync: "2 minutes ago",
      accounts: initialAccounts.length,
    },
    {
      id: 3,
      name: "Manual tools",
      type: "Self-managed",
      status: IntegrationStatus.Connected,
      lastSync: "2 minutes ago",
      accounts: 0,
    },
  ]);

  const handleAddEmailAccount = useCallback(
    (emailAccountData: any) => {
      const newId =
        emailAccounts.length > 0
          ? Math.max(...emailAccounts.map((acc) => acc.id)) + 1
          : 1;
      setEmailAccounts([...emailAccounts, { ...emailAccountData, id: newId }]);
      setIntegrations(
        integrations.map((int) =>
          int.name === "Gmail"
            ? { ...int, accounts: emailAccounts.length + 1 }
            : int
        )
      );
      onToast({
        title: "Email account added",
        description: `${emailAccountData.email} has been successfully connected.`,
        variant: "success",
      });
    },
    [emailAccounts, integrations, onToast]
  );

  const handleRemoveEmailAccount = useCallback(
    (id: number) => {
      const emailToRemove = emailAccounts.find((acc) => acc.id === id);

      if (!emailToRemove) return;

      // Prevent deletion of primary email
      if (emailToRemove.isPrimary) {
        const otherEmails = emailAccounts.filter((acc) => acc.id !== id);

        if (otherEmails.length === 0) {
          alert(
            "Cannot delete your last email account. You need at least one email to track subscriptions."
          );
          return;
        }

        alert(
          "Cannot delete primary email. Please set another email as primary first."
        );
        return;
      }

      // Mark subscriptions from this email as "source_removed"
      const affectedSubscriptions = subscriptions.filter(
        (sub: any) =>
          (sub as any).emailAccountId === id || sub.email_account_id === id
      );

      if (affectedSubscriptions.length > 0) {
        const confirmDelete = window.confirm(
          `This email has ${affectedSubscriptions.length} subscription(s). These will be marked as "source removed" but kept for your records. Continue?`
        );

        if (!confirmDelete) return;

        // Update subscriptions to mark as source_removed
        const updatedSubs = subscriptions.map((sub: any) =>
          (sub as any).emailAccountId === id || sub.email_account_id === id
            ? {
                ...sub,
                status: "source_removed",
                statusNote: `Email ${
                  emailToRemove.email
                } was disconnected on ${new Date().toLocaleDateString()}`,
              }
            : sub
        );
        updateSubscriptions(updatedSubs);
        addToHistory(updatedSubs);
      }

      setEmailAccounts(emailAccounts.filter((acc) => acc.id !== id));

      // Update integrations count
      setIntegrations(
        integrations.map((int) =>
          int.name === "Gmail"
            ? { ...int, accounts: emailAccounts.length - 1 }
            : int
        )
      );
    },
    [
      emailAccounts,
      subscriptions,
      updateSubscriptions,
      addToHistory,
      integrations,
    ]
  );

  const handleSetPrimaryEmail = useCallback(
    (id: number) => {
      const newPrimary = emailAccounts.find((acc) => acc.id === id);

      if (!newPrimary) return;

      const confirmChange = window.confirm(
        `Set ${newPrimary.email} as your primary email? This will be used for new subscriptions and notifications.`
      );

      if (!confirmChange) return;

      const updatedEmailAccounts = emailAccounts.map((acc) => ({
        ...acc,
        isPrimary: acc.id === id,
      }));
      setEmailAccounts(updatedEmailAccounts);
    },
    [emailAccounts]
  );

  const handleRescanEmail = useCallback(
    (id: number) => {
      setEmailAccounts(
        emailAccounts.map((acc) =>
          acc.id === id ? { ...acc, lastScanned: new Date() } : acc
        )
      );
    },
    [emailAccounts]
  );

  const handleToggleIntegration = useCallback((id: number) => {
    setIntegrations((prev) =>
      prev.map((int) =>
        int.id === id
          ? {
              ...int,
              status:
                int.status === IntegrationStatus.Connected
                  ? IntegrationStatus.Disconnected
                  : IntegrationStatus.Connected,
            }
          : int
      )
    );
  }, []);

  return {
    emailAccounts,
    integrations,
    handleAddEmailAccount,
    handleRemoveEmailAccount,
    handleSetPrimaryEmail,
    handleRescanEmail,
    handleToggleIntegration,
  };
}
