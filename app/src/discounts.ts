// Discount engine. Behaviour is specified in docs/spec/pricing-discounts.md вЂ”
// decisions D-1вЂ¦D-21, acceptance criteria AC-1вЂ¦AC-27, and the normative
// calculation order in В§3. This module consumes pricing.ts as-is; it does not
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
  | "invalid" // corrupt catalog record, or an unusable `now` (D-16, D-20, D-21, D-23)
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
  /** subtotal в€’ tierDiscount в€’ couponDiscount + shipping. Never negative. */
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
 * A catalog row is matchable only if its `code` is actually a string (D-21).
 *
 * The catalog is external data (§2), so a row may be `null` or carry a `code`
 * of the wrong type despite what `Coupon` promises — and `normalizeCode` would
 * throw on it, taking down the whole checkout including every valid coupon
 * beside it. Such a row is skipped during lookup rather than rejected: it
 * cannot equal any code the customer typed, so it is not the coupon they
 * entered. If nothing else matches, the entered code is `unknown` (D-10); a
 * usable row elsewhere in the catalog still matches and still applies.
 */
function hasMatchableCode(coupon: Coupon): boolean {
  return typeof coupon?.code === "string";
}

/**
 * A coupon `value` is valid only if it is a non-negative integer вЂ” and for
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
 * `kind` must be one of the two kinds the engine implements (D-24).
 *
 * An allow-list, not a negation, for the same reason as `isValidValue`: the
 * discount step is a `kind === "percent" ? ... : ...` ternary, so every value
 * other than `"percent"` is silently treated as `"fixed"`. Left unchecked, a
 * record with a kind that does not exist still pays out a full fixed discount.
 */
function isSupportedKind(coupon: Coupon): boolean {
  return coupon.kind === "percent" || coupon.kind === "fixed";
}

/**
 * `expiresAt` must denote an unambiguous instant (D-20). Two shapes qualify:
 * date-only (`YYYY-MM-DD`, which the standard reads as UTC) and date-time
 * carrying an offset (`Z` or `В±HH:MM`).
 *
 * Date-time without an offset is rejected: `new Date` would read it in the
 * local zone, so the same catalog would price differently per machine.
 */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}[Tt].+([Zz]|[+-]\d{2}:\d{2})$/;

/**
 * Both shapes above constrain digits, not the calendar, and `Date.parse` rolls
 * a day-of-month overflow silently forward: `"2026-02-31"` becomes 2026-03-03.
 * The record would then carry an expiry it never declared вЂ” `expired`, or
 * applied, where the answer is `invalid` (D-20). Month 13 and day 32 already
 * yield NaN; day 29-31 inside a short month is the case that slips through.
 *
 * Judged on the literal Y-M-D digits rather than on the parsed instant: with a
 * date-time the offset may legitimately move the UTC day (`2026-02-28T23:00-05:00`
 * is 2026-03-01 in UTC), so comparing UTC days would reject real dates.
 */
function isRealCalendarDate(expiresAt: string): boolean {
  const [year, month, day] = expiresAt.slice(0, 10).split("-").map(Number) as [number, number, number];
  if (month < 1 || month > 12 || day < 1) return false;
  // Month lengths are computed rather than read off a `Date`: `Date.UTC` maps
  // years 0-99 onto 1900-1999, which would misjudge leap years for those.
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const lengths = [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= lengths[month - 1]!;
}

function parseUnambiguousInstant(expiresAt: string): number | null {
  if (typeof expiresAt !== "string") return null;
  if (!DATE_ONLY.test(expiresAt) && !DATE_TIME_WITH_OFFSET.test(expiresAt)) return null;
  if (!isRealCalendarDate(expiresAt)) return null;
  const parsed = Date.parse(expiresAt);
  return Number.isNaN(parsed) ? null : parsed;
}

/** A threshold, when present, must be a non-negative integer (D-20). */
function isValidMinSubtotal(coupon: Coupon): boolean {
  if (coupon.minSubtotalKopecks === undefined) return true;
  return Number.isInteger(coupon.minSubtotalKopecks) && coupon.minSubtotalKopecks >= 0;
}

/**
 * The largest subtotal this engine will price (D-22).
 *
 * A merely safe subtotal is not enough: the arithmetic downstream both adds to
 * it and multiplies it, and either can leave the exact range while staying
 * finite — silently, which is the dangerous part.
 *
 *   - `subtotal + shipping` must stay exact, or the §5 identity between the
 *     fields breaks: at MAX_SAFE_INTEGER, adding 4 900 kopecks of shipping
 *     moves the total by 4 901.
 *   - `subtotal × percent` (tier, and the coupon steps) happens BEFORE the
 *     ÷100, so the product must stay exact too. Past 2^53 it does not, and the
 *     floor lands a kopeck low — verified: a subtotal of 8 304 332 205 561 060
 *     at Gold discounts one kopeck less than the exact answer.
 *
 * Dividing the safe range by the largest multiplier (100, the percent divisor)
 * covers both: the product of the largest allowed subtotal and any percentage
 * up to 100 stays inside 2^53, and so does any shipping fee added to it.
 *
 * ≈ 900 трильйонів гривень — far above any real order, so this bounds corrupt
 * data, not commerce.
 */
const MAX_SUBTOTAL_KOPECKS = Math.floor(Number.MAX_SAFE_INTEGER / 100);

/**
 * The one place this engine throws (D-22).
 *
 * Every other kind of bad input leaves the order computable, so it becomes data:
 * a corrupt coupon or an unusable `now` still lets us show a subtotal, shipping
 * and a rejection reason. A corrupt line item leaves nothing — "what does an
 * item priced NaN cost" has no answer, and any number returned would be
 * invented. Silently dropping the item would show the customer a total their
 * goods are missing from, which is worse than failing loudly.
 *
 * `TypeError` because a corrupt `Order` is a caller bug, not a business event:
 * it belongs in a developer's logs, not in front of a customer.
 *
 * `customerTier` and `country` are deliberately not checked — `tierPercent` and
 * `shippingKopecks` are total functions over any value (`default: 0`, "not UA
 * means international"), so a bogus value there yields a real number, not NaN.
 */
function assertComputableOrder(order: Order): void {
  if (!Array.isArray(order?.items)) throw new TypeError("priceOrder: order.items must be an array");
  if (!Array.isArray(order.coupons)) throw new TypeError("priceOrder: order.coupons must be an array");

  let runningSubtotal = 0;
  order.items.forEach((item, index) => {
    if (typeof item !== "object" || item === null) {
      throw new TypeError(`priceOrder: order.items[${index}] must be an object`);
    }
    // Whole non-negative kopecks, matching the money contract in types.ts. The
    // allow-list also rejects NaN, Infinity and fractions such as 10.5, which a
    // `< 0` deny-list would let through into the subtotal (same reason as D-16).
    //
    // `isSafeInteger`, not `isInteger`: the latter accepts Number.MAX_VALUE and
    // every other integral float above 2^53, where arithmetic silently stops
    // being exact. Such a value is not a real kopeck amount — no order costs
    // 9·10^307 — so it is a corrupt field, judged here rather than downstream.
    for (const field of ["unitPriceKopecks", "quantity"] as const) {
      const value = item[field];
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(
          `priceOrder: order.items[${index}].${field} must be a non-negative safe integer, got ${String(value)}`,
        );
      }
    }
    // Individually safe values can still overflow once multiplied and summed,
    // and the loss is silent. Checked here because `pricing.ts` is a fixed
    // contract that cannot carry the guard itself; the accumulated total is
    // then held to MAX_SUBTOTAL_KOPECKS, which also keeps the later `+ shipping`
    // and `× percent` steps exact.
    const lineTotal = item.unitPriceKopecks * item.quantity;
    if (!Number.isSafeInteger(lineTotal)) {
      throw new TypeError(
        `priceOrder: order.items[${index}] total ${item.unitPriceKopecks}×${item.quantity} exceeds the safe integer range`,
      );
    }
    runningSubtotal += lineTotal;
    if (runningSubtotal > MAX_SUBTOTAL_KOPECKS) {
      throw new TypeError(
        `priceOrder: order subtotal exceeds the safe integer range at order.items[${index}]`,
      );
    }
  });

  order.coupons.forEach((code, index) => {
    if (typeof code !== "string") {
      throw new TypeError(`priceOrder: order.coupons[${index}] must be a string, got ${String(code)}`);
    }
  });
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
 * @throws TypeError if `order` is not computable at all — a non-array `items`
 *   or `coupons`, a non-object line item, or a line item whose
 *   `unitPriceKopecks`/`quantity` is not a whole non-negative number (D-22).
 *   This is the only input that does not produce a `PriceBreakdown`.
 *
 * @param catalog known coupons; treated as unvalidated external data (D-10, D-16, D-20, D-21)
 * @param now instant to judge expiry against; required, no default (D-9).
 *   Unvalidated like the catalog: an `Invalid Date` rejects every coupon that
 *   reaches the expiry check, but never throws (D-23)
 */
export function priceOrder(order: Order, catalog: Coupon[], now: Date): PriceBreakdown {
  // Step 0: a corrupt order is the one input with no meaningful answer (D-22).
  assertComputableOrder(order);

  // Step 1-3 of the normative order: subtotal, tier discount, running base.
  const subtotal = subtotalKopecks(order);
  const tierDiscount = Math.min(Math.floor((subtotal * tierPercent(order)) / 100), subtotal);
  let base = subtotal - tierDiscount;

  let couponDiscount = 0;
  const appliedCoupons: string[] = [];
  const rejectedCoupons: RejectedCoupon[] = [];
  const seen = new Set<string>();
  // `now` carries no more guarantees than the catalog does (D-23). An
  // `Invalid Date` yields NaN, and NaN fails every comparison, so an unchecked
  // clock would silently make each coupon eternal вЂ” the D-20 trap from the
  // other side. Judged once here; the per-coupon effect happens at step (Рґ).
  const nowMs = now.getTime();
  const nowIsUsable = Number.isFinite(nowMs);

  // Step 4: one pass, in entry order. Checks (Р±)вЂ¦(С”) run as an early-exit
  // chain вЂ” the first that trips decides the reason, the rest never run.
  for (const rawCode of order.coupons) {
    const code = normalizeCode(rawCode);

    // (Р±) Deduplication counts every code already seen, not just applied ones (D-12).
    if (seen.has(code)) {
      rejectedCoupons.push({ code: rawCode, reason: "duplicate" });
      continue;
    }
    seen.add(code);

    // (РІ) Catalog lookup normalises both sides; a collision is corrupt data (D-11, D-21).
    const matches = catalog.filter((c) => hasMatchableCode(c) && normalizeCode(c.code) === code);
    if (matches.length === 0) {
      rejectedCoupons.push({ code: rawCode, reason: "unknown" });
      continue;
    }
    if (matches.length > 1) {
      rejectedCoupons.push({ code: rawCode, reason: "invalid" });
      continue;
    }
    const coupon = matches[0]!;

    // (Рі) Record validity precedes expiry: a corrupt date cannot be compared at all (D-20).
    const expiresAtMs = parseUnambiguousInstant(coupon.expiresAt);
    if (
      !isSupportedKind(coupon) ||
      !isValidValue(coupon) ||
      expiresAtMs === null ||
      !isValidMinSubtotal(coupon)
    ) {
      rejectedCoupons.push({ code: rawCode, reason: "invalid" });
      continue;
    }

    // (Рґ) An unusable `now` makes expiry unjudgeable, so the coupon is invalid
    // rather than expired вЂ” the same "cannot be compared at all" class as a
    // corrupt date in (Рі) (D-23). Placed here, not earlier, so that reasons
    // which do not depend on `now` keep their priority.
    if (!nowIsUsable) {
      rejectedCoupons.push({ code: rawCode, reason: "invalid" });
      continue;
    }

    // Invalid on or after the expiry instant (D-9).
    if (nowMs >= expiresAtMs) {
      rejectedCoupons.push({ code: rawCode, reason: "expired" });
      continue;
    }

    // (Рµ) The threshold is judged against the ORIGINAL subtotal (D-6).
    if (coupon.minSubtotalKopecks !== undefined && subtotal < coupon.minSubtotalKopecks) {
      rejectedCoupons.push({ code: rawCode, reason: "below_minimum" });
      continue;
    }

    // (С”) A category coupon needs items of that category to exist at all (D-19).
    const categoryItems =
      coupon.category === undefined ? null : categorySubtotalKopecks(order, coupon.category);
    if (coupon.category !== undefined && !order.items.some((i) => i.category === coupon.category)) {
      rejectedCoupons.push({ code: rawCode, reason: "category_absent" });
      continue;
    }

    // (Р¶) Coupon base: category coupons shrink proportionally with the discounts
    // already granted, so the same kopecks are never discounted twice (D-5).
    let couponBase: number;
    if (categoryItems === null) {
      couponBase = base;
    } else if (subtotal === 0) {
      couponBase = 0;
    } else {
      // Computed in BigInt: `categoryItems × base` is a product of two kopeck
      // amounts, so it can reach ~10^27 even though each factor is well inside
      // the safe range — the subtotal bound covers `subtotal × percent`, but
      // nothing bounds the product of two independent money values. Rounded to
      // double before the divide, the result lands a kopeck off in either
      // direction, and a 100% coupon carries that straight into the discount.
      //
      // This is also what D-5 asks for literally: the ratio is exact and the
      // only rounding is the outer floor, which BigInt division gives for free
      // (both operands are non-negative, so truncation is floor).
      couponBase = Number((BigInt(categoryItems) * BigInt(base)) / BigInt(subtotal));
    }

    // (Р·) Discount off that base вЂ” then (Рё) clamped again to the running base.
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
