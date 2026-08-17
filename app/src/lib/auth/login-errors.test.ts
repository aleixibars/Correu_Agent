import { describe, expect, it } from "vitest";
import { loginErrorMessage } from "./login-errors";

describe("loginErrorMessage", () => {
  it("explains an allowlist rejection in Catalan", () => {
    expect(loginErrorMessage("AccessDenied")).toBe(
      "Aquest compte no té accés al tauler.",
    );
  });

  it("tells a visitor whose address is already on the other provider which one to use", () => {
    // Both providers are on the login page for one allowlisted address, so
    // "try again" would be wrong advice: retrying the same provider never works.
    const message =
      "Aquesta adre\u00e7a ja est\u00e0 vinculada a l'altre prove\u00efdor. Inicieu la sessi\u00f3 amb el mateix prove\u00efdor que vau fer servir la primera vegada.";
    expect(loginErrorMessage("OAuthAccountNotLinked")).toBe(message);
    expect(loginErrorMessage("AccountNotLinked")).toBe(message);
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
