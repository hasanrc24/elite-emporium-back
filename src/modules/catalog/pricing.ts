import { money, moneyString } from "../../lib/money.js";

interface PriceVariant {
  regularPrice: string | number;
  salePrice?: string | number | null;
  saleStartsAt?: string | Date | null;
  saleEndsAt?: string | Date | null;
}

export function isSaleActive(variant: PriceVariant, at = new Date()): boolean {
  if (variant.salePrice == null) return false;
  if (variant.saleStartsAt && new Date(variant.saleStartsAt) > at) return false;
  if (variant.saleEndsAt && new Date(variant.saleEndsAt) <= at) return false;
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
