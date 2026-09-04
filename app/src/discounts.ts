// Discount engine. Behaviour is specified in docs/spec/pricing-discounts.md —
// decisions D-1…D-21, acceptance criteria AC-1…AC-27, and the normative
// calculation order in §3. This module consumes pricing.ts as-is; it does not
// reimplement subtotal, shipping or tier percentage.
//
// MONEY: whole kopecks throughout. Every discount is floored on its own step
// (D-4), so no intermediate fractional value ever exists.

import type { Order, Coupon, LineItem } from "./types.js";
import { lineTotalKopecks, subtotalKopecks, shippingKopecks, tierPercent } from "./pricing.js";

/** Why a specific entered code produced no discount. Machine reason; UI supplies the text. */
export type CouponRejectionReason =
  | "unknown" // no such code in the catalog (D-10)
  | "expired" // now >= expiresAt (D-8, D-9)
  | "duplicate" // code already seen on this order (D-12)
  | "invalid" // corrupt catalog record (D-16, D-20, D-21)
  | "below_minimum" // subtotal does not reach minSubtotalKopecks (D-6)
  | "category_absent"; // no items of the coupon's category in the cart (D-19)

export interface RejectedCoupon {
  /** The code exactly as the customer typed it, so the UI can echo it back. */
  code: string;
  reason: CouponRejectionReason;
}

export interface PriceBreakdown {
  subtotalKopecks: number;
  tierDiscountKopecks: number;
  couponDiscountKopecks: number;
  shippingKopecks: number;
  /** subtotal − tierDiscount − couponDiscount + shipping. Never negative. */
  totalKopecks: number;
  /** Codes that applied, in order of application, normalised. */
  appliedCoupons: string[];
  /** Rejected codes, in the order the customer typed them; `code` stays raw. */
  rejectedCoupons: RejectedCoupon[];
}

/** Case-insensitive, edge-trimmed. Inner whitespace stays significant (D-11). */
function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

/**
 * A coupon `value` is valid only if it is a non-negative integer — and for
 * percent coupons, at most 100 (D-16).
 *
 * Stated as an allow-list on purpose: any comparison against NaN yields false,
 * so a deny-list (`value < 0 || value > 100`) would let NaN through and poison
 * every downstream field.
 */
function isValidValue(coupon: Coupon): boolean {
  if (!Number.isInteger(coupon.value) || coupon.value < 0) return false;
  return coupon.kind !== "percent" || coupon.value <= 100;
}

/**
 * `expiresAt` must denote an unambiguous instant (D-20). Two shapes qualify:
 * date-only (`YYYY-MM-DD`, which the standard reads as UTC) and date-time
 * carrying an offset (`Z` or `±HH:MM`).
 *
 * Date-time without an offset is rejected: `new Date` would read it in the
 * local zone, so the same catalog would price differently per machine.
 */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}[Tt].+([Zz]|[+-]\d{2}:\d{2})$/;

function parseUnambiguousInstant(expiresAt: string): number | null {
  if (typeof expiresAt !== "string") return null;
  if (!DATE_ONLY.test(expiresAt) && !DATE_TIME_WITH_OFFSET.test(expiresAt)) return null;
  const parsed = Date.parse(expiresAt);
  return Number.isNaN(parsed) ? null : parsed;
}

/** A threshold, when present, must be a non-negative integer (D-20). */
function isValidMinSubtotal(coupon: Coupon): boolean {
  if (coupon.minSubtotalKopecks === undefined) return true;
  return Number.isInteger(coupon.minSubtotalKopecks) && coupon.minSubtotalKopecks >= 0;
}

function categorySubtotalKopecks(order: Order, category: LineItem["category"]): number {
  return order.items
    .filter((i) => i.category === category)
    .reduce((sum, i) => sum + lineTotalKopecks(i), 0);
}

/**
 * Prices an order: tier discount off the item subtotal, then coupons in the
 * order the customer typed them, each off the remaining base (D-1, D-3).
 *
 * Pure by contract: it reads no clock and mutates neither argument.
 *
 * @param catalog known coupons; treated as unvalidated external data (D-10, D-16, D-20, D-21)
 * @param now instant to judge expiry against; required, no default (D-9)
 */
export function priceOrder(order: Order, catalog: Coupon[], now: Date): PriceBreakdown {
  // Step 1-3 of the normative order: subtotal, tier discount, running base.
  const subtotal = subtotalKopecks(order);
  const tierDiscount = Math.min(Math.floor((subtotal * tierPercent(order)) / 100), subtotal);
  let base = subtotal - tierDiscount;

  let couponDiscount = 0;
  const appliedCoupons: string[] = [];
  const rejectedCoupons: RejectedCoupon[] = [];
  const seen = new Set<string>();
  const nowMs = now.getTime();

  // Step 4: one pass, in entry order. Checks (б)…(є) run as an early-exit
  // chain — the first that trips decides the reason, the rest never run.
  for (const rawCode of order.coupons) {
    const code = normalizeCode(rawCode);

    // (б) Deduplication counts every code already seen, not just applied ones (D-12).
    if (seen.has(code)) {
      rejectedCoupons.push({ code: rawCode, reason: "duplicate" });
      continue;
    }
    seen.add(code);

    // (в) Catalog lookup normalises both sides; a collision is corrupt data (D-11, D-21).
    const matches = catalog.filter((c) => normalizeCode(c.code) === code);
    if (matches.length === 0) {
      rejectedCoupons.push({ code: rawCode, reason: "unknown" });
      continue;
    }
    if (matches.length > 1) {
      rejectedCoupons.push({ code: rawCode, reason: "invalid" });
      continue;
    }
    const coupon = matches[0]!;

    // (г) Record validity precedes expiry: a corrupt date cannot be compared at all (D-20).
    const expiresAtMs = parseUnambiguousInstant(coupon.expiresAt);
    if (!isValidValue(coupon) || expiresAtMs === null || !isValidMinSubtotal(coupon)) {
      rejectedCoupons.push({ code: rawCode, reason: "invalid" });
      continue;
    }

    // (д) Invalid on or after the expiry instant (D-9).
    if (nowMs >= expiresAtMs) {
      rejectedCoupons.push({ code: rawCode, reason: "expired" });
      continue;
    }

    // (е) The threshold is judged against the ORIGINAL subtotal (D-6).
    if (coupon.minSubtotalKopecks !== undefined && subtotal < coupon.minSubtotalKopecks) {
      rejectedCoupons.push({ code: rawCode, reason: "below_minimum" });
      continue;
    }

    // (є) A category coupon needs items of that category to exist at all (D-19).
    const categoryItems =
      coupon.category === undefined ? null : categorySubtotalKopecks(order, coupon.category);
    if (coupon.category !== undefined && !order.items.some((i) => i.category === coupon.category)) {
      rejectedCoupons.push({ code: rawCode, reason: "category_absent" });
      continue;
    }

    // (ж) Coupon base: category coupons shrink proportionally with the discounts
    // already granted, so the same kopecks are never discounted twice (D-5).
    let couponBase: number;
    if (categoryItems === null) {
      couponBase = base;
    } else if (subtotal === 0) {
      couponBase = 0;
    } else {
      couponBase = Math.floor((categoryItems * base) / subtotal);
    }

    // (з) Discount off that base — then (и) clamped again to the running base.
    // Two clamps in this order: the category limit, then the order limit (D-7, D-13).
    const raw =
      coupon.kind === "percent" ? Math.floor((couponBase * coupon.value) / 100) : Math.min(coupon.value, couponBase);
    const discount = Math.min(raw, base);

    base -= discount;
    couponDiscount += discount;
    // A valid coupon that discounted nothing still counts as applied (D-18).
    appliedCoupons.push(code);
  }

  // Step 5: shipping is added after every discount and is never reduced (D-2).
  const shipping = shippingKopecks(order);
  return {
    subtotalKopecks: subtotal,
    tierDiscountKopecks: tierDiscount,
    couponDiscountKopecks: couponDiscount,
    shippingKopecks: shipping,
    totalKopecks: base + shipping,
    appliedCoupons,
    rejectedCoupons,
  };
}
