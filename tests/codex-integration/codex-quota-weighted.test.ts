import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearPoolRotationState, parseAccountPoolStrategy, parseCodexAccountPoolStrategy, peekRoundRobinAccount, pickRoundRobinAccount, seedPoolRotationAccount } from "../../src/codex/pool-rotation";
import { clearThreadAccountMap, clearCodexUpstreamHealth, resolveCodexAccountForThread, previewCodexAccountForRequest } from "../../src/codex/routing";
import { clearAccountQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { OcxConfig } from "../../src/types";

let home: string;
let oldHome: string | undefined;
let oldCodexHome: string | undefined;
let config: OcxConfig;
beforeEach(() => {
  oldHome = process.env.OPENCODEX_HOME; oldCodexHome = process.env.CODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-quota-weighted-"));
  process.env.OPENCODEX_HOME = home; process.env.CODEX_HOME = home;
  clearPoolRotationState(); clearThreadAccountMap(); clearCodexUpstreamHealth(); clearAccountQuota();
  config = { providers: {}, accountPoolStrategy: "quota-weighted", activeCodexAccountId: "a", autoSwitchThreshold: 80,
    codexAccounts: ["a", "b"].map(id => ({ id, email: `${id}@example.test`, isMain: false })) } as OcxConfig;
  for (const id of ["a", "b"]) saveCodexAccountCredential(id, {
    accessToken: `fixture-${id}`, refreshToken: `fixture-refresh-${id}`, expiresAt: Date.now() + 60_000, chatgptAccountId: `fixture-account-${id}`,
  });
});
afterEach(() => {
  clearPoolRotationState(); clearThreadAccountMap(); clearCodexUpstreamHealth(); clearAccountQuota();
  if (oldHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = oldHome;
  if (oldCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodexHome;
  removeTreeWithRetry(home);
});

describe("quota-weighted new-session scheduling", () => {
  test("only Codex accepts the new opt-in strategy", () => {
    expect(parseCodexAccountPoolStrategy("quota-weighted")).toBe("quota-weighted");
    expect(parseAccountPoolStrategy("quota-weighted")).toBeNull();
  });
  test("smooth weighted rotation follows 1:3 and preview does not consume a slot", () => {
    const weights = new Map([["a", 1], ["b", 3]]);
    const picks: string[] = [];
    for (let i = 0; i < 40; i++) {
      const preview = peekRoundRobinAccount("weighted-test", ["a", "b"], 1, weights);
      expect(peekRoundRobinAccount("weighted-test", ["a", "b"], 1, weights)).toBe(preview);
      const pick = pickRoundRobinAccount("weighted-test", ["a", "b"], 1, weights)!;
      expect(pick).toBe(preview); picks.push(pick);
    }
    expect(picks.filter(id => id === "a")).toHaveLength(10);
    expect(picks.filter(id => id === "b")).toHaveLength(30);
  });
  test("the largest remaining share takes every new session without persisting active", () => {
    setAccountQuotaFromParsed("a", { weeklyPercent: 75 });
    setAccountQuotaFromParsed("b", { weeklyPercent: 25 });
    const picks = Array.from({ length: 12 }, (_, i) => resolveCodexAccountForThread(`task-${i}`, config));
    expect(new Set(picks)).toEqual(new Set(["b"]));
    expect(config.activeCodexAccountId).toBe("a");
  });
  test("equal remaining shares rotate evenly", () => {
    setAccountQuotaFromParsed("a", { weeklyPercent: 25 });
    setAccountQuotaFromParsed("b", { weeklyPercent: 25 });
    const picks = Array.from({ length: 10 }, (_, i) => resolveCodexAccountForThread(`tie-${i}`, config));
    expect(picks.filter(id => id === "a")).toHaveLength(5);
    expect(picks.filter(id => id === "b")).toHaveLength(5);
  });
  test("an unknown-quota account keeps its proportional probe share", () => {
    setAccountQuotaFromParsed("a", { weeklyPercent: 25 });
    const picks = Array.from({ length: 76 }, (_, i) => resolveCodexAccountForThread(`probe-${i}`, config));
    expect(picks.filter(id => id === "a")).toHaveLength(75);
    expect(picks.filter(id => id === "b")).toHaveLength(1);
  });
  test("healthy bindings stay even after quotas and reset preference change", () => {
    setAccountQuotaFromParsed("a", { weeklyPercent: 75 }); setAccountQuotaFromParsed("b", { weeklyPercent: 25 });
    const first = resolveCodexAccountForThread("bound", config);
    setAccountQuotaFromParsed(first!, { weeklyPercent: 85 });
    setAccountQuotaFromParsed(first === "a" ? "b" : "a", { weeklyPercent: 0, weeklyResetAt: Date.now() + 60_000 });
    expect(previewCodexAccountForRequest("bound", config)).toBe(first);
    expect(resolveCodexAccountForThread("bound", config)).toBe(first);
  });
  test("new assignments exclude threshold accounts even if reset is imminent", () => {
    setAccountQuotaFromParsed("a", { weeklyPercent: 80, weeklyResetAt: Date.now() + 60_000 });
    setAccountQuotaFromParsed("b", { weeklyPercent: 25 });
    for (let i = 0; i < 8; i++) expect(resolveCodexAccountForThread(`threshold-${i}`, config)).toBe("b");
  });
  test("all threshold accounts stop new assignments rather than fall through to active", () => {
    setAccountQuotaFromParsed("a", { weeklyPercent: 80 }); setAccountQuotaFromParsed("b", { weeklyPercent: 90 });
    expect(previewCodexAccountForRequest("all-drained", config)).toBeNull();
    expect(resolveCodexAccountForThread("all-drained", config)).toBeNull();
  });
  test("priority, pause and account-specific thresholds precede weighting", () => {
    setAccountQuotaFromParsed("a", { weeklyPercent: 20 }); setAccountQuotaFromParsed("b", { weeklyPercent: 0 });
    config.codexAccountPriorities = { a: 10 };
    expect(resolveCodexAccountForThread("priority", config)).toBe("a");
    config.pausedCodexAccountIds = ["a"];
    expect(resolveCodexAccountForThread("pause", config)).toBe("b");
    config.pausedCodexAccountIds = []; config.codexAccountAutoSwitchThresholds = { a: 20 };
    expect(resolveCodexAccountForThread("override", config)).toBe("b");
  });
});

import { codexQuotaSchedulingWeight } from "../../src/codex/routing/quota-weighted";
import { accountPoolStrategyForScope, pickAlternateCodexAccount, peekAlternateCodexAccount } from "../../src/codex/routing/selection";
import { setCodexAccountPin } from "../../src/codex/account-priority";
import { resetCodexRoutingForManualSelection, recordCodexUpstreamOutcome } from "../../src/codex/routing";
const now = 1_791_775_000_000;
const hour = 3_600_000;
describe("quota-weighted window scoring", () => {
  test("remaining share dominates and nearer long resets add at most +10%/+5%", () => {
    const base = { weeklyPercent: 25, updatedAt: now };
    expect(codexQuotaSchedulingWeight(base, "prolite", 80, now)).toBe(75);
    expect(codexQuotaSchedulingWeight({ ...base, weeklyResetAt: now + hour }, "prolite", 80, now)).toBe(82.5);
    expect(codexQuotaSchedulingWeight({ ...base, weeklyResetAt: now + 12 * hour }, "prolite", 80, now)).toBe(78.75);
    expect(codexQuotaSchedulingWeight({ ...base, weeklyResetAt: now + 25 * hour }, "prolite", 80, now)).toBe(75);
    // A near reset never outranks a clearly larger remaining share.
    expect(codexQuotaSchedulingWeight({ weeklyPercent: 60, weeklyResetAt: now + hour, updatedAt: now }, "prolite", 80, now))
      .toBeLessThan(codexQuotaSchedulingWeight(base, "prolite", 80, now));
  });
  test("short-reset urgency cannot overrule a tight unreset weekly window", () => {
    expect(codexQuotaSchedulingWeight({ weeklyPercent: 75, weeklyResetAt: now + 3 * 24 * hour,
      shortPercent: 50, shortResetAt: now + 10_000, updatedAt: now }, "prolite", 80, now)).toBe(25);
    expect(codexQuotaSchedulingWeight({ weeklyPercent: 10, shortPercent: 50,
      shortResetAt: now + 10_000, updatedAt: now }, "prolite", 80, now)).toBeCloseTo(55);
  });
  test("missing, elapsed and stale reset evidence has no boost, seconds and ms agree", () => {
    const base = { weeklyPercent: 25, updatedAt: now };
    expect(codexQuotaSchedulingWeight({ ...base, weeklyResetAt: now - 1 }, "prolite", 80, now)).toBe(75);
    expect(codexQuotaSchedulingWeight({ ...base, updatedAt: now - 301_000, weeklyResetAt: now + hour }, "prolite", 80, now)).toBe(75);
    expect(codexQuotaSchedulingWeight({ ...base, weeklyResetAt: (now + hour) / 1000 }, "prolite", 80, now)).toBe(82.5);
    expect(codexQuotaSchedulingWeight({ weeklyPercent: 0, shortPercent: 50, shortObservedAt: now - 301_000,
      shortResetAt: now + 10_000, updatedAt: now }, "prolite", 80, now)).toBe(50);
  });
  test("unknown is a small share, not an empty account; known spent/threshold is zero", () => {
    expect(codexQuotaSchedulingWeight(null, undefined, 80, now)).toBe(1);
    expect(codexQuotaSchedulingWeight({ shortPercent: 0, updatedAt: now }, undefined, 80, now)).toBe(1);
    expect(codexQuotaSchedulingWeight({ weeklyPercent: 80, updatedAt: now }, undefined, 80, now)).toBe(0);
    expect(codexQuotaSchedulingWeight({ weeklyPercent: 100, updatedAt: now }, undefined, 0, now)).toBe(0);
    expect(codexQuotaSchedulingWeight({ weeklyPercent: 95, updatedAt: now }, undefined, 0, now)).toBe(5);
  });
  test("monthly-only plans use their monthly budget and reset", () => {
    expect(codexQuotaSchedulingWeight({ monthlyPercent: 40, monthlyResetAt: now + hour, updatedAt: now }, "k12", 80, now)).toBe(66);
  });
  test("independent model quotas do not inherit shared account reset ordering", () => {
    expect(accountPoolStrategyForScope(config, "spark")).toBe("quota");
    expect(config.accountPoolStrategy).toBe("quota-weighted");
  });
  test("manual next-account seed is honored once, then weighted allocation resumes", () => {
    setAccountQuotaFromParsed("a", { weeklyPercent: 75 }); setAccountQuotaFromParsed("b", { weeklyPercent: 25 });
    setCodexAccountPin(config, "a"); resetCodexRoutingForManualSelection("a");
    expect(resolveCodexAccountForThread("manual-first", config)).toBe("a");
    expect(resolveCodexAccountForThread("manual-second", config)).toBe("b");
  });
  test("failure alternates skip the failed account and preview consumes no slots", () => {
    setAccountQuotaFromParsed("a", { weeklyPercent: 75 }); setAccountQuotaFromParsed("b", { weeklyPercent: 25 });
    for (let i = 0; i < 3; i++) expect(peekAlternateCodexAccount(config, "a", Date.now())).toBe("b");
    expect(pickAlternateCodexAccount(config, "a")).toBe("b");
    recordCodexUpstreamOutcome(config, "b", 429);
    expect(resolveCodexAccountForThread("after-429", config)).toBe("a");
  });
});

test("mode changes drop automatic sticky debt without consuming preview or manual seeds", () => {
  const weights = new Map([["a", 1], ["b", 3]]);
  expect(pickRoundRobinAccount("mode-change", ["a", "b"], 10)).toBe("a");
  expect(peekRoundRobinAccount("mode-change", ["a", "b"], 1, weights)).toBe("b");
  expect(pickRoundRobinAccount("mode-change", ["a", "b"], 1, weights)).toBe("b");
  seedPoolRotationAccount("mode-change", "a");
  expect(peekRoundRobinAccount("mode-change", ["a", "b"], 1, weights)).toBe("a");
  expect(pickRoundRobinAccount("mode-change", ["a", "b"], 1, weights)).toBe("a");
});
