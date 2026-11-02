type ThresholdValue = number | string | null | undefined;

function usable(value: ThresholdValue): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * BE-INV-001: the most specific low-stock threshold wins
 * (variant, then product, then the global inventory setting).
 */
export function resolveLowStockThreshold(sources: {
  variant?: ThresholdValue;
  product?: ThresholdValue;
  global?: ThresholdValue;
}): number {
  return (
    usable(sources.variant) ??
    usable(sources.product) ??
    usable(sources.global) ??
    3
  );
}
