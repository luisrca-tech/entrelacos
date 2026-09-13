export function smsUsageProgress(
  consumed: number,
  monthlyLimit: number | null,
): number | null {
  if (monthlyLimit === null) return null;
  if (monthlyLimit === 0) return 100;
  return Math.min(100, (consumed / monthlyLimit) * 100);
}
