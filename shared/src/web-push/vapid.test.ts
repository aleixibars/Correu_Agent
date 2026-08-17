import { describe, expect, it } from "vitest";
import { loadVapidConfig } from "./vapid";
import { TEST_VAPID_ENV } from "./test-fixtures";

describe("loadVapidConfig", () => {
  it("reads the three VAPID variables from the environment", () => {
    expect(loadVapidConfig(TEST_VAPID_ENV)).toEqual({
      publicKey: TEST_VAPID_ENV.VAPID_PUBLIC_KEY,
      privateKey: TEST_VAPID_ENV.VAPID_PRIVATE_KEY,
      subject: TEST_VAPID_ENV.VAPID_SUBJECT,
    });
  });

  it("throws when a variable is missing", () => {
    expect(() =>
      loadVapidConfig({ ...TEST_VAPID_ENV, VAPID_PRIVATE_KEY: undefined }),
    ).toThrow(/VAPID_PRIVATE_KEY/);
  });

  it("throws when a variable is empty", () => {
    expect(() =>
      loadVapidConfig({ ...TEST_VAPID_ENV, VAPID_PUBLIC_KEY: "  " }),
    ).toThrow(/VAPID_PUBLIC_KEY/);
  });

  it("rejects a subject that is not a mailto: or https: URL", () => {
    expect(() =>
      loadVapidConfig({ ...TEST_VAPID_ENV, VAPID_SUBJECT: "correu@example.com" }),
    ).toThrow(/VAPID_SUBJECT/);
  });

  it("rejects a scheme with no contact behind it", () => {
    expect(() =>
      loadVapidConfig({ ...TEST_VAPID_ENV, VAPID_SUBJECT: "mailto:" }),
    ).toThrow(/VAPID_SUBJECT/);
    expect(() =>
      loadVapidConfig({ ...TEST_VAPID_ENV, VAPID_SUBJECT: "https://" }),
    ).toThrow(/VAPID_SUBJECT/);
  });

  it("accepts an https: subject", () => {
    const config = loadVapidConfig({
      ...TEST_VAPID_ENV,
      VAPID_SUBJECT: "https://correu-agent.example",
    });
    expect(config.subject).toBe("https://correu-agent.example");
  });
});
