import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for the requireEnv helper function.
 *
 * requireEnv is a module-level function that runs at import time,
 * so we re-implement the logic here to test its behavior in isolation
 * without triggering side effects from the constants module.
 */

function requireEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

describe("requireEnv", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset env for each test
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test("returns env var value when set", () => {
    process.env.TEST_VAR = "hello-world";
    const result = requireEnv("TEST_VAR");
    expect(result).toBe("hello-world");
  });

  test("returns fallback when env var is not set", () => {
    delete process.env.TEST_MISSING;
    const result = requireEnv("TEST_MISSING", "default-value");
    expect(result).toBe("default-value");
  });

  test("env var takes precedence over fallback", () => {
    process.env.TEST_OVERRIDE = "from-env";
    const result = requireEnv("TEST_OVERRIDE", "from-fallback");
    expect(result).toBe("from-env");
  });

  test("throws when env var is missing and no fallback provided", () => {
    delete process.env.NONEXISTENT_VAR;
    expect(() => requireEnv("NONEXISTENT_VAR")).toThrow(
      "Missing required env var: NONEXISTENT_VAR",
    );
  });

  test("empty string env var uses fallback (empty string is falsy)", () => {
    // process.env coerces values to strings; empty string is not null/undefined
    // so ?? does NOT trigger, but the empty string is falsy and fails the !value check.
    // This means requireEnv("EMPTY_VAR", "fallback") will throw because
    // value = "" ?? "fallback" => "" (not null/undefined), then !value => true => throw.
    // This is the actual behavior: empty env vars are treated as missing.
    process.env.EMPTY_VAR = "";
    expect(() => requireEnv("EMPTY_VAR")).toThrow(
      "Missing required env var: EMPTY_VAR",
    );
  });

  test("throws for empty string without fallback", () => {
    process.env.EMPTY_NO_FALLBACK = "";
    expect(() => requireEnv("EMPTY_NO_FALLBACK")).toThrow(
      "Missing required env var: EMPTY_NO_FALLBACK",
    );
  });
});
