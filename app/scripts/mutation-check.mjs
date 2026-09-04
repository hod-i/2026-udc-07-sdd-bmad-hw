// Mutation check: does the test suite actually catch a WRONG implementation?
//
// A green suite proves the code passes its tests; it does not prove the tests
// would fail if a specification decision were implemented the other way. This
// script breaks one decision at a time and asserts that `npm test` goes red.
//
// Each mutation is the plausible alternative reading of an ambiguity the spec
// closes — the choice another engineer could have made from the same ticket.
// A SURVIVED line means the criterion for that decision is not really pinned
// down, and the traceability row for it is worth less than it looks.
//
// Usage: npm run mutation-check     (from app/)

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = join(APP_DIR, "src", "discounts.ts");

// Run vitest through Node directly rather than through `npm test`: no shell,
// no .cmd/.sh wrapper, so this behaves the same on Windows, macOS, Linux and CI.
const VITEST = createRequire(import.meta.url).resolve("vitest/vitest.mjs");

/** True when the suite fails — judged by exit code, not by parsing output. */
function suiteFails() {
  const run = spawnSync(process.execPath, [VITEST, "run"], {
    cwd: APP_DIR,
    encoding: "utf8",
    stdio: "ignore",
  });
  if (run.error) throw run.error;
  return run.status !== 0;
}

/** @type {{decision: string, what: string, from: string, to: string}[]} */
const MUTATIONS = [
  {
    decision: "D-4",
    what: "round half up instead of flooring the coupon discount",
    from: 'coupon.kind === "percent" ? Math.floor((couponBase * coupon.value) / 100)',
    to: 'coupon.kind === "percent" ? Math.round((couponBase * coupon.value) / 100)',
  },
  {
    decision: "D-5",
    what: "use the full category total instead of the proportionally reduced base",
    from: "couponBase = Math.floor((categoryItems * base) / subtotal);",
    to: "couponBase = categoryItems;",
  },
  {
    decision: "D-6",
    what: "check the threshold against the running base instead of the original subtotal",
    from: "subtotal < coupon.minSubtotalKopecks",
    to: "base < coupon.minSubtotalKopecks",
  },
  {
    decision: "D-9",
    what: "expire strictly after the instant instead of on or after it",
    from: "nowMs >= expiresAtMs",
    to: "nowMs > expiresAtMs",
  },
  {
    decision: "D-11",
    what: "strip all whitespace instead of trimming the edges",
    from: "return code.trim().toUpperCase();",
    to: 'return code.replace(/\\s/g, "").toUpperCase();',
  },
  {
    decision: "D-16",
    what: "validate value by deny-list, which lets NaN through",
    from: "if (!Number.isInteger(coupon.value) || coupon.value < 0) return false;",
    to: "if (coupon.value < 0) return false;",
  },
  {
    decision: "D-20 (expiresAt)",
    what: "accept any parseable date, including offset-less local times",
    from: "if (!DATE_ONLY.test(expiresAt) && !DATE_TIME_WITH_OFFSET.test(expiresAt)) return null;",
    to: "",
  },
  {
    decision: "D-20 (calendar)",
    what: "trust the shape check alone, so 2026-02-31 rolls forward to a real instant",
    from: "if (!isRealCalendarDate(expiresAt)) return null;",
    to: "",
  },
  {
    decision: "D-20 (minSubtotal)",
    what: "skip threshold validation, so a negative threshold always passes",
    from: "return Number.isInteger(coupon.minSubtotalKopecks) && coupon.minSubtotalKopecks >= 0;",
    to: "return true;",
  },
  {
    decision: "D-23",
    what: "trust `now`, so an Invalid Date makes every expired coupon eternal",
    from: "if (!nowIsUsable) {",
    to: "if (false) {",
  },
  {
    decision: "D-22",
    what: "trust the order, so a NaN price poisons the whole breakdown",
    from: "  assertComputableOrder(order);",
    to: "",
  },
  {
    decision: "D-24",
    what: "trust `kind`, so an unknown kind silently pays out as a fixed coupon",
    from: '  return coupon.kind === "percent" || coupon.kind === "fixed";',
    to: "  return true;",
  },
  {
    decision: "D-21 (code type)",
    what: "trust that every catalog row has a string code, so a malformed row throws",
    from: "hasMatchableCode(c) && normalizeCode(c.code) === code",
    to: "normalizeCode(c.code) === code",
  },
  {
    decision: "D-21",
    what: "let the first catalog record win instead of rejecting a collision",
    from: "if (matches.length > 1) {",
    to: "if (false) {",
  },
];

const original = readFileSync(TARGET, "utf8");
let survived = 0;

// The source is mutated in place, so restore it on every exit path — including
// Ctrl+C, which would otherwise leave a broken file behind.
const restore = () => writeFileSync(TARGET, original);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    restore();
    process.exit(130);
  });
}

try {
  for (const { decision, what, from, to } of MUTATIONS) {
    if (!original.includes(from)) {
      console.log(`STALE     ${decision}: pattern no longer in source — ${what}`);
      survived++;
      continue;
    }
    writeFileSync(TARGET, original.replace(from, to));
    const caught = suiteFails();
    console.log(`${caught ? "CAUGHT  " : "SURVIVED"}  ${decision}: ${what}`);
    if (!caught) survived++;
  }
} finally {
  restore();
}

console.log(
  survived === 0
    ? `\nAll ${MUTATIONS.length} mutations caught — every decision is pinned by a test.`
    : `\n${survived} of ${MUTATIONS.length} mutations SURVIVED — those decisions are not pinned.`,
);
process.exit(survived === 0 ? 0 : 1);
