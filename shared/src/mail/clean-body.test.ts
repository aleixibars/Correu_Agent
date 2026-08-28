import { describe, expect, it } from "vitest";
import { cleanMessageBody } from "./clean-body";

describe("cleanMessageBody", () => {
  it("returns null for a body that retention has already purged", () => {
    expect(cleanMessageBody(null)).toBeNull();
  });

  it("returns null for a body that is only whitespace", () => {
    expect(cleanMessageBody("  \n\n \t \n")).toBeNull();
  });

  it("strips blank lines and spaces at the start and the end", () => {
    expect(cleanMessageBody("\n\n   Hola,\n\nte l'envio.   \n\n \n")).toBe(
      "Hola,\n\nte l'envio.",
    );
  });

  it("leaves a body with no quoted tail or signature untouched", () => {
    const body = "Hola,\n\nAdjunto la proposta revisada.\n\nGràcies!";

    expect(cleanMessageBody(body)).toBe(body);
  });

  it("cuts at the Catalan Gmail attribution line", () => {
    const body = [
      "D'acord, ho miro avui.",
      "",
      "El dt., 26 d'ag. 2026 a les 10:12, Aleix <aleix@example.com> va escriure:",
      "",
      "> Pots revisar la proposta?",
      "> Gràcies.",
    ].join("\n");

    expect(cleanMessageBody(body)).toBe("D'acord, ho miro avui.");
  });

  it("cuts at a Gmail attribution line wrapped over two lines", () => {
    const body = [
      "D'acord, ho miro avui.",
      "",
      "El dt., 26 d'ag. 2026 a les 10:12, Aleix Ibars <aleix@example.com> va",
      "escriure:",
      "",
      "> Pots revisar la proposta?",
    ].join("\n");

    expect(cleanMessageBody(body)).toBe("D'acord, ho miro avui.");
  });

  it("cuts at the Spanish attribution line", () => {
    const body = [
      "Perfecto, lo reviso.",
      "",
      "El mié, 26 ago 2026 a las 10:12, Aleix (<aleix@example.com>) escribió:",
      "> ¿Puedes revisar la propuesta?",
    ].join("\n");

    expect(cleanMessageBody(body)).toBe("Perfecto, lo reviso.");
  });

  it("cuts at the English attribution line", () => {
    const body = [
      "Sure, on it.",
      "",
      "On Wed, 26 Aug 2026 at 10:12, Aleix <aleix@example.com> wrote:",
      "> Can you review the proposal?",
    ].join("\n");

    expect(cleanMessageBody(body)).toBe("Sure, on it.");
  });

  it("cuts at the Outlook original-message separator", () => {
    const body = [
      "Rebut, gràcies.",
      "",
      "-----Original Message-----",
      "From: Aleix <aleix@example.com>",
      "Sent: Wednesday, 26 August 2026 10:12",
    ].join("\n");

    expect(cleanMessageBody(body)).toBe("Rebut, gràcies.");
  });

  it("cuts at a block of consecutive quoted lines with no attribution above", () => {
    const body = [
      "Confirmat.",
      "",
      "> Ens veiem dijous?",
      "> A les 10?",
    ].join("\n");

    expect(cleanMessageBody(body)).toBe("Confirmat.");
  });

  it("keeps a lone line starting with '>' — one line is not a quoted block", () => {
    const body = "El resultat és:\n\n> 42, sense cap dubte";

    expect(cleanMessageBody(body)).toBe(body);
  });

  it("cuts at the '--' signature delimiter", () => {
    const body = [
      "Ho tindràs demà.",
      "",
      "-- ",
      "Aleix Ibars",
      "Correu Agent SL · Tel. 600 000 000",
    ].join("\n");

    expect(cleanMessageBody(body)).toBe("Ho tindràs demà.");
  });

  it("cuts at a mobile client footer", () => {
    const body = "Vinga, quedem així.\n\nEnviat des del meu iPhone";

    expect(cleanMessageBody(body)).toBe("Vinga, quedem així.");
  });

  it("cuts at the earliest marker when several appear", () => {
    const body = [
      "Ok!",
      "",
      "-- ",
      "Aleix",
      "",
      "El dt., 26 d'ag. 2026 a les 10:12, Aleix <aleix@example.com> va escriure:",
      "> Res?",
    ].join("\n");

    expect(cleanMessageBody(body)).toBe("Ok!");
  });

  it("falls back to the whole trimmed body when the cut would leave nothing", () => {
    // A forward with no new text on top: cutting would blank the message, and
    // showing too much beats showing an empty article.
    const body = [
      "El dt., 26 d'ag. 2026 a les 10:12, Aleix <aleix@example.com> va escriure:",
      "",
      "> Pots revisar la proposta?",
    ].join("\n");

    expect(cleanMessageBody(body)).toBe(body);
  });

  it("normalises CRLF line endings before matching", () => {
    const body = "Rebut.\r\n\r\n-----Original Message-----\r\nFrom: Aleix\r\n";

    expect(cleanMessageBody(body)).toBe("Rebut.");
  });
});
