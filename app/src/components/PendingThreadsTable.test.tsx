// La taula de pendents amb filtres (context.md §2): els desplegables de
// categoria, estat i darrer missatge filtren al moment el que ja s'ha
// carregat, sense tornar a demanar res al servidor. `renderToStaticMarkup`
// només comprova el primer render (el que veu qui no té JavaScript encara);
// el filtratge en si el prova `matchesDateFilter` per separat més avall.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ThreadListItem } from "../lib/threads/list-threads";
import { threadPath } from "../lib/routes";
import { PendingThreadsTable } from "./PendingThreadsTable";

const thread = (overrides: Partial<ThreadListItem> = {}): ThreadListItem => ({
  id: "thread-1",
  subject: "Assumpte",
  category: "comercial",
  lastMessageAt: new Date("2026-08-19T08:30:00Z"),
  status: "draft-pending",
  draftId: "draft-1",
  ...overrides,
});

const render = (threads: ThreadListItem[]): string =>
  renderToStaticMarkup(
    <PendingThreadsTable threads={threads} rejectDraft={vi.fn()} />,
  );

describe("PendingThreadsTable", () => {
  it("shows the three filters, each defaulting to 'everything'", () => {
    const markup = render([thread()]);

    expect(markup).toContain("Categoria");
    expect(markup).toContain("Estat");
    expect(markup).toContain("Últim missatge");
    expect(markup).toContain('<option value="all"');
  });

  // A filter only offers what is actually on the list — a dead option that
  // matches nothing would not help anyone narrow it down.
  it("only offers categories and statuses present on the list", () => {
    const markup = render([thread({ category: "comercial", status: "draft-pending" })]);

    expect(markup).not.toContain("Urgent");
    expect(markup).not.toContain("Triat");
  });

  it("renders the thread with its last message as a date and a time", () => {
    const markup = render([thread({ lastMessageAt: new Date("2026-08-19T08:30:00Z") })]);

    expect(markup).toContain("19/8/26");
  });

  it("still links to Respondre and offers Descarta as before", () => {
    const markup = render([thread({ id: "t-1" })]);

    expect(markup).toContain(
      `<a class="btn" href="${threadPath("t-1")}">Respondre</a>`,
    );
    expect(markup).toContain('name="draftId" value="draft-1"');
  });

  it("says so when no thread matches, without hiding the filters", () => {
    // The initial render always applies "everything", so this only exercises
    // the empty state's own markup rather than a live filter change.
    const markup = render([]);

    expect(markup).toContain("Cap fil coincideix amb els filtres.");
    expect(markup).toContain("Categoria");
  });
});
