export interface BudgetAlert {
    level: "critical" | "warning";
    message: string;
    percentage: string;
}

export function checkBudgetAlerts(
    totalSpend: number,
    budgetLimit: number
): BudgetAlert | null {
    const percentage = (totalSpend / budgetLimit) * 100;

    if (percentage >= 100) {
        return {
            level: "critical",
            message: `You've exceeded your $${budgetLimit} budget by $${(
                totalSpend - budgetLimit
            ).toFixed(2)}`,
            percentage: percentage.toFixed(0),
        };
    } else if (percentage >= 80) {
        return {
            level: "warning",
            message: `You've used ${percentage.toFixed(
                0
            )}% of your $${budgetLimit} budget`,
            percentage: percentage.toFixed(0),
        };
    }

    return null;
}

/** Returns true + overage if adding `newMonthlyAmount` would exceed the budget. */
export function wouldExceedBudget(
    currentTotal: number,
    newMonthlyAmount: number,
    budgetLimit: number
): { exceeds: boolean; newTotal: number; overage: number } {
    const newTotal = currentTotal + newMonthlyAmount;
    return {
        exceeds: newTotal > budgetLimit,
        newTotal,
        overage: Math.max(0, newTotal - budgetLimit),
    };
}

/** Annual projection message. */
export function annualProjection(
    monthlyTotal: number,
    annualBudget: number
): string | null {
    const projected = monthlyTotal * 12;
    if (projected <= annualBudget) return null;
    return `At your current rate, you'll spend $${projected.toFixed(0)} on subscriptions this year — $${(projected - annualBudget).toFixed(0)} over your $${annualBudget} annual budget.`;
}
