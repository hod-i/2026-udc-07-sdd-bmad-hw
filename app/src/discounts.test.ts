// Tests are named after the acceptance criteria in docs/spec/pricing-discounts.md,
// so `npm test` output shows the spec link without opening this file.

import { describe, it, expect } from "vitest";
import { priceOrder } from "./discounts.js";
import type { PriceBreakdown } from "./discounts.js";
import type { Order, LineItem, Coupon } from "./types.js";

// Amounts are whole kopecks. 25_000 = 250 грн.
const item = (over: Partial<LineItem> = {}): LineItem => ({
  sku: "AA-1",
  name: "Thing",
  unitPriceKopecks: 25_000,
  quantity: 1,
  category: "standard",
  ...over,
});

const order = (over: Partial<Order> = {}): Order => ({
  id: "o1",
  items: [item()],
  country: "UA",
  customerTier: "none",
  coupons: [],
  ...over,
});

const coupon = (over: Partial<Coupon> = {}): Coupon => ({
  code: "SAVE10",
  kind: "percent",
  value: 10,
  expiresAt: "2027-01-01T00:00:00Z",
  ...over,
});

/** An order worth 1 000 грн: 100 000 kopecks of standard goods. */
const thousandUah = (over: Partial<Order> = {}): Order =>
  order({ items: [item({ unitPriceKopecks: 100_000 })], ...over });

const NOW = new Date("2026-09-01T00:00:00Z");

/**
 * The six contract invariants from §5. Checked on the result of EVERY criterion
 * rather than in one dedicated test: an invariant holds everywhere by
 * definition, so verifying it at a single point would verify almost nothing.
 */
function expectInvariants(result: PriceBreakdown, input: Order): void {
  const amounts = [
    result.subtotalKopecks,
    result.tierDiscountKopecks,
    result.couponDiscountKopecks,
    result.shippingKopecks,
    result.totalKopecks,
  ];
  for (const amount of amounts) {
    expect(Number.isInteger(amount)).toBe(true);
    expect(amount).toBeGreaterThanOrEqual(0);
  }
  expect(result.totalKopecks).toBe(
    result.subtotalKopecks -
      result.tierDiscountKopecks -
      result.couponDiscountKopecks +
      result.shippingKopecks,
  );
  expect(result.totalKopecks).toBeGreaterThanOrEqual(result.shippingKopecks);
  expect(result.appliedCoupons.length + result.rejectedCoupons.length).toBe(input.coupons.length);
}

/** Runs priceOrder and asserts the invariants before handing the result back. */
function price(o: Order, catalog: Coupon[] = [], now: Date = NOW): PriceBreakdown {
  const result = priceOrder(o, catalog, now);
  expectInvariants(result, o);
  return result;
}

describe("priceOrder", () => {
  it("AC-1: Gold on 1000 грн, no coupons — tier discount only", () => {
    const result = price(thousandUah({ customerTier: "gold" }));
    expect(result.tierDiscountKopecks).toBe(10_000);
    expect(result.couponDiscountKopecks).toBe(0);
    expect(result.shippingKopecks).toBe(4_900);
    expect(result.totalKopecks).toBe(94_900);
  });

  it("AC-2: tier and coupon apply sequentially, not additively", () => {
    const o = thousandUah({ customerTier: "gold", coupons: ["SAVE15"] });
    const result = price(o, [coupon({ code: "SAVE15", value: 15 })]);
    expect(result.tierDiscountKopecks).toBe(10_000);
    // 15% of 90 000, not of 100 000.
    expect(result.couponDiscountKopecks).toBe(13_500);
    expect(result.totalKopecks).toBe(81_400);
  });

  it("AC-3: two coupons on the same category, both applied in entry order", () => {
    const o = order({
      items: [
        item({ unitPriceKopecks: 50_000, category: "fresh" }),
        item({ unitPriceKopecks: 50_000, category: "standard" }),
      ],
      coupons: ["FRESH10", "FRESH20"],
    });
    const result = price(o, [
      coupon({ code: "FRESH10", value: 10, category: "fresh" }),
      coupon({ code: "FRESH20", value: 20, category: "fresh" }),
    ]);
    // 5 000 off a 50 000 base, then 9 500 off a 47 500 base.
    expect(result.couponDiscountKopecks).toBe(14_500);
    expect(result.totalKopecks).toBe(90_400);
    expect(result.appliedCoupons).toEqual(["FRESH10", "FRESH20"]);
  });

  it("AC-4: a fixed coupon larger than the order clamps to the base", () => {
    const o = order({ coupons: ["BIG2000"] });
    const result = price(o, [coupon({ code: "BIG2000", kind: "fixed", value: 200_000 })]);
    expect(result.couponDiscountKopecks).toBe(25_000);
    // Total falls to shipping alone — never negative.
    expect(result.totalKopecks).toBe(4_900);
  });

  it("AC-5: a coupon is expired at exactly its expiry instant", () => {
    const o = thousandUah({ coupons: ["SAVE10"] });
    const result = price(
      o,
      [coupon({ expiresAt: "2026-01-01T00:00:00Z" })],
      new Date("2026-01-01T00:00:00Z"),
    );
    expect(result.rejectedCoupons).toEqual([{ code: "SAVE10", reason: "expired" }]);
    expect(result.couponDiscountKopecks).toBe(0);
    expect(result.totalKopecks).toBe(104_900);
  });

  it("AC-6: an empty order with a coupon prices to zero without throwing", () => {
    const o = order({ items: [], coupons: ["SAVE10"] });
    const result = price(o, [coupon()]);
    expect(result.subtotalKopecks).toBe(0);
    expect(result.tierDiscountKopecks).toBe(0);
    expect(result.couponDiscountKopecks).toBe(0);
    expect(result.shippingKopecks).toBe(0);
    expect(result.totalKopecks).toBe(0);
    // Valid coupon, zero discount — applied, not rejected (D-18).
    expect(result.appliedCoupons).toEqual(["SAVE10"]);
  });

  it("AC-7: half a kopeck rounds down, not up", () => {
    // 5% of 1 050 = 52.5 exactly.
    const o = order({ items: [item({ unitPriceKopecks: 1_050 })], customerTier: "silver" });
    const result = price(o);
    expect(result.tierDiscountKopecks).toBe(52);

    // The same boundary on the coupon step: floor is per-step (D-4), so a
    // coupon must round down too — not only the tier discount.
    const withCoupon = price(
      order({ items: [item({ unitPriceKopecks: 1_050 })], coupons: ["SAVE5"] }),
      [coupon({ code: "SAVE5", value: 5 })],
    );
    expect(withCoupon.couponDiscountKopecks).toBe(52);
  });

  it("AC-8: an unknown code is rejected and the rest still apply", () => {
    const o = thousandUah({ coupons: ["NOSUCHCODE", "SAVE10"] });
    const result = price(o, [coupon()]);
    expect(result.rejectedCoupons).toEqual([{ code: "NOSUCHCODE", reason: "unknown" }]);
    expect(result.appliedCoupons).toEqual(["SAVE10"]);
    expect(result.couponDiscountKopecks).toBe(10_000);
  });

  it("AC-9: the same code entered twice applies once", () => {
    const o = thousandUah({ coupons: ["SAVE10", "save10"] });
    const result = price(o, [coupon()]);
    expect(result.appliedCoupons).toEqual(["SAVE10"]);
    expect(result.rejectedCoupons).toEqual([{ code: "save10", reason: "duplicate" }]);
    expect(result.couponDiscountKopecks).toBe(10_000);
  });

  it("AC-10: the threshold is judged against the original subtotal", () => {
    const o = thousandUah({ customerTier: "gold", coupons: ["MIN1000"] });
    const result = price(o, [coupon({ code: "MIN1000", minSubtotalKopecks: 100_000 })]);
    // 100 000 >= 100 000 despite the base having fallen to 90 000.
    expect(result.appliedCoupons).toEqual(["MIN1000"]);
    expect(result.couponDiscountKopecks).toBe(9_000);
  });

  it("AC-11: an order below the threshold rejects the coupon", () => {
    const o = order({ items: [item({ unitPriceKopecks: 99_900 })], coupons: ["MIN1000"] });
    const result = price(o, [coupon({ code: "MIN1000", minSubtotalKopecks: 100_000 })]);
    expect(result.rejectedCoupons).toEqual([{ code: "MIN1000", reason: "below_minimum" }]);
    expect(result.couponDiscountKopecks).toBe(0);
  });

  it("AC-12: a percent coupon above 100 is invalid", () => {
    const o = thousandUah({ coupons: ["SAVE10"] });
    const result = price(o, [coupon({ value: 150 })]);
    expect(result.rejectedCoupons).toEqual([{ code: "SAVE10", reason: "invalid" }]);
    expect(result.couponDiscountKopecks).toBe(0);
  });

  it("AC-13: silver discounts 5%, none discounts 0", () => {
    expect(price(thousandUah({ customerTier: "silver" })).tierDiscountKopecks).toBe(5_000);
    expect(price(thousandUah({ customerTier: "none" })).tierDiscountKopecks).toBe(0);
  });

  it("AC-14: an all-digital order ships free and still discounts", () => {
    const o = thousandUah({
      items: [item({ unitPriceKopecks: 100_000, category: "digital" })],
      customerTier: "gold",
    });
    const result = price(o);
    expect(result.shippingKopecks).toBe(0);
    expect(result.totalKopecks).toBe(90_000);
  });

  it("AC-15: the category base shrinks proportionally with the tier discount", () => {
    const o = order({
      items: [
        item({ unitPriceKopecks: 50_000, category: "fresh" }),
        item({ unitPriceKopecks: 50_000, category: "standard" }),
      ],
      customerTier: "gold",
      coupons: ["FRESH10", "FRESH20"],
    });
    const result = price(o, [
      coupon({ code: "FRESH10", value: 10, category: "fresh" }),
      coupon({ code: "FRESH20", value: 20, category: "fresh" }),
    ]);
    expect(result.tierDiscountKopecks).toBe(10_000);
    // Bases 45 000 then 42 750 — not the untouched 50 000.
    expect(result.couponDiscountKopecks).toBe(13_050);
    expect(result.totalKopecks).toBe(81_850);
  });

  it("AC-16: a fixed category coupon clamps to the proportional category base", () => {
    const o = order({
      items: [
        item({ unitPriceKopecks: 10_000, category: "fresh" }),
        item({ unitPriceKopecks: 90_000, category: "standard" }),
      ],
      customerTier: "gold",
      coupons: ["FRESH500"],
    });
    const result = price(o, [
      coupon({ code: "FRESH500", kind: "fixed", value: 50_000, category: "fresh" }),
    ]);
    // Clamped to 9 000 — not to 10 000, and not to 50 000.
    expect(result.couponDiscountKopecks).toBe(9_000);
  });

  it("AC-17: the tier discount covers every category without exception", () => {
    const o = order({
      items: [
        item({ unitPriceKopecks: 50_000, category: "fresh" }),
        item({ unitPriceKopecks: 50_000, category: "digital" }),
      ],
      customerTier: "gold",
    });
    expect(price(o).tierDiscountKopecks).toBe(10_000);
  });

  it("AC-18: a negative percent value is invalid", () => {
    const o = thousandUah({ coupons: ["SAVE10"] });
    const result = price(o, [coupon({ value: -5 })]);
    expect(result.rejectedCoupons).toEqual([{ code: "SAVE10", reason: "invalid" }]);
  });

  it("AC-19: a coupon that discounts nothing is still applied", () => {
    const o = order({ coupons: ["BIG5000", "SAVE10"] });
    const result = price(o, [
      coupon({ code: "BIG5000", kind: "fixed", value: 50_000 }),
      coupon(),
    ]);
    expect(result.couponDiscountKopecks).toBe(25_000);
    // Base exhausted, yet the second coupon lands in applied, not rejected.
    expect(result.appliedCoupons).toEqual(["BIG5000", "SAVE10"]);
    expect(result.rejectedCoupons).toEqual([]);
  });

  it("AC-20: a category coupon on a cart without that category is rejected", () => {
    const o = thousandUah({ coupons: ["FRESH50"] });
    const result = price(o, [
      coupon({ code: "FRESH50", value: 50, category: "fresh" }),
    ]);
    expect(result.rejectedCoupons).toEqual([{ code: "FRESH50", reason: "category_absent" }]);
    expect(result.couponDiscountKopecks).toBe(0);
    expect(result.totalKopecks).toBe(104_900);
  });

  it("AC-21: a repeat of an already-rejected code reports duplicate, not the first reason", () => {
    const o = thousandUah({ coupons: ["FRESH50", "FRESH50"] });
    const result = price(o, [coupon({ code: "FRESH50", value: 50, category: "fresh" })]);
    expect(result.rejectedCoupons).toEqual([
      { code: "FRESH50", reason: "category_absent" },
      { code: "FRESH50", reason: "duplicate" },
    ]);
  });

  it("AC-22: entry order changes the total — coupons are never reordered", () => {
    const catalog = [
      coupon({ code: "SAVE20", value: 20 }),
      coupon({ code: "MINUS300", kind: "fixed", value: 30_000 }),
    ];
    const percentFirst = price(thousandUah({ coupons: ["SAVE20", "MINUS300"] }), catalog);
    expect(percentFirst.couponDiscountKopecks).toBe(50_000);

    const fixedFirst = price(thousandUah({ coupons: ["MINUS300", "SAVE20"] }), catalog);
    // 30 000 + 20% of the remaining 70 000 — 60 грн less than the other order.
    expect(fixedFirst.couponDiscountKopecks).toBe(44_000);
  });

  it("AC-23: edge whitespace and case are ignored, inner whitespace is not", () => {
    const found = price(thousandUah({ coupons: ["  save10  "] }), [coupon()]);
    expect(found.appliedCoupons).toEqual(["SAVE10"]);
    expect(found.couponDiscountKopecks).toBe(10_000);

    const notFound = price(thousandUah({ coupons: ["SAVE 10"] }), [coupon()]);
    // Rejected codes echo the raw input back.
    expect(notFound.rejectedCoupons).toEqual([{ code: "SAVE 10", reason: "unknown" }]);
  });

  it("AC-24: an unparseable expiry is invalid, not eternal", () => {
    const o = thousandUah({ coupons: ["SAVE10"] });
    const result = price(o, [coupon({ expiresAt: "31/12/2026" })]);
    expect(result.rejectedCoupons).toEqual([{ code: "SAVE10", reason: "invalid" }]);
    expect(result.couponDiscountKopecks).toBe(0);
  });

  it("AC-25: a date-time without an offset is invalid; with one, or date-only, it is not", () => {
    const o = thousandUah({ coupons: ["SAVE10"] });
    const ambiguous = price(o, [coupon({ expiresAt: "2026-01-01T00:00:00" })]);
    expect(ambiguous.rejectedCoupons).toEqual([{ code: "SAVE10", reason: "invalid" }]);

    // The same instant, unambiguously stated — expired rather than invalid.
    const withOffset = price(o, [coupon({ expiresAt: "2026-01-01T00:00:00Z" })]);
    expect(withOffset.rejectedCoupons).toEqual([{ code: "SAVE10", reason: "expired" }]);

    const dateOnly = price(o, [coupon({ expiresAt: "2026-01-01" })]);
    expect(dateOnly.rejectedCoupons).toEqual([{ code: "SAVE10", reason: "expired" }]);

    // Date-only in the future is simply valid.
    const future = price(o, [coupon({ expiresAt: "2027-01-01" })]);
    expect(future.appliedCoupons).toEqual(["SAVE10"]);
  });

  it("AC-26: a NaN value is invalid and poisons no field", () => {
    const o = thousandUah({ coupons: ["SAVE10"] });
    const result = price(o, [coupon({ value: Number.NaN })]);
    expect(result.rejectedCoupons).toEqual([{ code: "SAVE10", reason: "invalid" }]);
    expect(result.couponDiscountKopecks).toBe(0);
    expect(result.totalKopecks).toBe(104_900);

    // A `fixed` NaN has no upper bound to trip over, so only the allow-list
    // catches it — this is the case a deny-list would let through (D-16).
    const asFixed = price(o, [coupon({ kind: "fixed", value: Number.NaN })]);
    expect(asFixed.rejectedCoupons).toEqual([{ code: "SAVE10", reason: "invalid" }]);

    // Infinity and fractions are rejected by the same integer check.
    expect(price(o, [coupon({ kind: "fixed", value: Number.POSITIVE_INFINITY })]).rejectedCoupons)
      .toEqual([{ code: "SAVE10", reason: "invalid" }]);
    expect(price(o, [coupon({ value: 10.5 })]).rejectedCoupons)
      .toEqual([{ code: "SAVE10", reason: "invalid" }]);
  });

  it("AC-27: catalog codes are normalised too; a collision is invalid", () => {
    const found = price(thousandUah({ coupons: ["SAVE10"] }), [coupon({ code: "save10" })]);
    expect(found.appliedCoupons).toEqual(["SAVE10"]);
    expect(found.couponDiscountKopecks).toBe(10_000);

    const collision = price(thousandUah({ coupons: ["SAVE10"] }), [
      coupon({ code: "SAVE10" }),
      coupon({ code: " save10 ", value: 50 }),
    ]);
    // Neither record is chosen — the ambiguity itself is the defect.
    expect(collision.rejectedCoupons).toEqual([{ code: "SAVE10", reason: "invalid" }]);
    expect(collision.couponDiscountKopecks).toBe(0);
  });

  it("AC-28: a corrupt minimum threshold is invalid; an absent one is not", () => {
    const o = thousandUah({ coupons: ["SAVE10"] });

    // A negative threshold would otherwise pass check (е) for every order,
    // since any subtotal is >= -1.
    expect(price(o, [coupon({ minSubtotalKopecks: -1 })]).rejectedCoupons).toEqual([
      { code: "SAVE10", reason: "invalid" },
    ]);
    expect(price(o, [coupon({ minSubtotalKopecks: 10.5 })]).rejectedCoupons).toEqual([
      { code: "SAVE10", reason: "invalid" },
    ]);
    expect(price(o, [coupon({ minSubtotalKopecks: Number.NaN })]).rejectedCoupons).toEqual([
      { code: "SAVE10", reason: "invalid" },
    ]);

    // Absent means "no threshold", not "corrupt".
    const noThreshold = price(o, [coupon({ minSubtotalKopecks: undefined })]);
    expect(noThreshold.appliedCoupons).toEqual(["SAVE10"]);
    expect(noThreshold.couponDiscountKopecks).toBe(10_000);

    // Zero is a real threshold every order meets — valid, not corrupt.
    expect(price(o, [coupon({ minSubtotalKopecks: 0 })]).appliedCoupons).toEqual(["SAVE10"]);
  });

  it("AC-1..28: the calculation is pure — inputs are not mutated, no clock is read", () => {
    const o = thousandUah({ customerTier: "gold", coupons: ["SAVE15", "NOSUCHCODE"] });
    const catalog = [coupon({ code: "SAVE15", value: 15 })];
    const orderBefore = structuredClone(o);
    const catalogBefore = structuredClone(catalog);

    const first = priceOrder(o, catalog, NOW);
    expect(o).toEqual(orderBefore);
    expect(catalog).toEqual(catalogBefore);

    // Same input, same output — the clock plays no part.
    expect(priceOrder(o, catalog, NOW)).toEqual(first);
  });
});
