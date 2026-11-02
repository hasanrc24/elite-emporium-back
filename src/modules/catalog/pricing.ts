import { money, moneyString } from "../../lib/money.js";

interface PriceVariant {
  regularPrice: string | number;
  salePrice?: string | number | null;
  saleStartsAt?: string | Date | null;
  saleEndsAt?: string | Date | null;
}

function instant(value: string | Date): number {
  return new Date(value).getTime();
}

/**
 * A sale applies from `saleStartsAt` (inclusive) until `saleEndsAt`
 * (exclusive), both UTC instants, and only while it is below the regular
 * price. An unparseable schedule bound disables the sale instead of
 * silently discounting forever.
 */
export function isSaleActive(variant: PriceVariant, at = new Date()): boolean {
  if (variant.salePrice == null || variant.salePrice === "") return false;
  const now = at.getTime();
  if (variant.saleStartsAt) {
    const starts = instant(variant.saleStartsAt);
    if (Number.isNaN(starts) || starts > now) return false;
  }
  if (variant.saleEndsAt) {
    const ends = instant(variant.saleEndsAt);
    if (Number.isNaN(ends) || ends <= now) return false;
  }
  return money(variant.salePrice).lessThan(money(variant.regularPrice));
}

export function effectivePrice(variant: PriceVariant, at = new Date()) {
  return money(
    isSaleActive(variant, at) ? variant.salePrice : variant.regularPrice,
  );
}

export function priceDto(variant: PriceVariant, at = new Date()) {
  const onSale = isSaleActive(variant, at);
  return {
    regularPrice: moneyString(variant.regularPrice),
    salePrice: onSale ? moneyString(variant.salePrice) : null,
    price: moneyString(effectivePrice(variant, at)),
    onSale,
    saleStartsAt: variant.saleStartsAt || null,
    saleEndsAt: variant.saleEndsAt || null,
  };
}
