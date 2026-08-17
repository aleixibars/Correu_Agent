import { describe, expect, it } from "vitest";
import { loginErrorMessage } from "./login-errors";

describe("loginErrorMessage", () => {
  it("explains an allowlist rejection in Catalan", () => {
    expect(loginErrorMessage("AccessDenied")).toBe(
      "Aquest compte no té accés al tauler.",
    );
  });

  it("falls back to a generic message for an unknown code", () => {
    expect(loginErrorMessage("Whatever")).toBe(
      "No s'ha pogut iniciar la sessió. Torneu-ho a provar.",
    );
  });

  it("shows nothing when the visitor simply opened the login page", () => {
    expect(loginErrorMessage(undefined)).toBeNull();
    expect(loginErrorMessage("")).toBeNull();
  });

  it("takes the first value when the parameter is repeated", () => {
    expect(loginErrorMessage(["AccessDenied", "Configuration"])).toBe(
      "Aquest compte no té accés al tauler.",
    );
  });
});
