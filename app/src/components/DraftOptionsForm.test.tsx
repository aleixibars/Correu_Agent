// @vitest-environment jsdom

// El compte enrere abans d'enviar (issue #80): "Aprova i envia" no crida mai el
// Server Action de seguida — obre un pop-up amb 7 segons per penedir-se'n. La
// prova munta el component de debò perquè tot el retard passa al navegador:
// només si el compte enrere arriba a zero surt la petició cap al proveïdor.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftOption } from "@correu-agent/shared/db/schema";
import { DraftOptionsForm } from "./DraftOptionsForm";

const DRAFT_ID = "77777777-7777-7777-7777-777777777777";

const options: DraftOption[] = [
  { label: "Afirmativa", body: "Sí, hi comptem." },
  { label: "Negativa", body: "Ara mateix no ens va bé." },
];

const approveDraft = vi.fn();

const show = (draftOptions: DraftOption[] = options): void => {
  render(
    <DraftOptionsForm
      draftId={DRAFT_ID}
      options={draftOptions}
      approveDraft={approveDraft}
    />,
  );
};

const approve = (): void => {
  fireEvent.click(screen.getByRole("button", { name: "Aprova i envia" }));
};

const tick = (seconds: number): void => {
  act(() => {
    vi.advanceTimersByTime(seconds * 1000);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  approveDraft.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("DraftOptionsForm", () => {
  it("does not send on the click: it opens a countdown of 7 seconds instead", () => {
    show();

    approve();

    expect(approveDraft).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveProperty("ariaModal", "true");
    expect(dialog.textContent).toContain("7");
  });

  // Enfocable des del primer moment: qui es penedeix amb el teclat no ha de
  // buscar el botó a mig compte enrere.
  it("focuses the cancel button as soon as the countdown opens", () => {
    show();

    approve();

    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Cancel·la" }),
    );
  });

  it("counts down second by second", () => {
    show();
    approve();

    tick(1);
    expect(screen.getByRole("dialog").textContent).toContain("6");

    tick(5);
    expect(screen.getByRole("dialog").textContent).toContain("1");
    expect(approveDraft).not.toHaveBeenCalled();
  });

  it("sends once the countdown reaches zero, with the text as edited", () => {
    show();
    fireEvent.change(screen.getByLabelText("Text de la resposta"), {
      target: { value: "Text meu" },
    });

    approve();
    tick(7);

    expect(approveDraft).toHaveBeenCalledTimes(1);
    const formData = approveDraft.mock.calls[0]?.[0] as FormData;
    expect(formData.get("draftId")).toBe(DRAFT_ID);
    expect(formData.get("body")).toBe("Text meu");
  });

  it("never sends when cancelled inside the countdown", () => {
    show();
    approve();

    tick(3);
    fireEvent.click(screen.getByRole("button", { name: "Cancel·la" }));
    tick(60);

    expect(approveDraft).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("cancels with Escape too", () => {
    show();
    approve();

    fireEvent.keyDown(document, { key: "Escape" });
    tick(60);

    expect(approveDraft).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("counts down again after a cancelled attempt, from seven", () => {
    show();
    approve();
    tick(3);
    fireEvent.click(screen.getByRole("button", { name: "Cancel·la" }));

    approve();

    expect(screen.getByRole("dialog").textContent).toContain("7");
  });

  it("still lets an option replace the editable text before approving", () => {
    show();

    fireEvent.click(screen.getByRole("radio", { name: "Negativa" }));

    expect(screen.getByLabelText("Text de la resposta")).toHaveProperty(
      "value",
      "Ara mateix no ens va bé.",
    );
  });
});
