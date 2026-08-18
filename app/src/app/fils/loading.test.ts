// The loading screen is the fallback Next renders while the thread list query
// runs, so it has to stand on its own: no session, no database. Reaching for
// either would suspend on the very work the fallback is covering for.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../auth", () => ({
  auth: () => {
    throw new Error("the loading screen must not read the session");
  },
}));
vi.mock("../../lib/db", () => ({
  get db(): never {
    throw new Error("the loading screen must not query the database");
  },
}));
vi.mock("../../lib/threads/list-threads", () => ({
  listThreads: () => {
    throw new Error("the loading screen must not list threads");
  },
}));

const { default: ThreadsLoading } = await import("./loading");

const render = (): string => renderToStaticMarkup(ThreadsLoading());

describe("ThreadsLoading", () => {
  it("renders without a session, a database or any thread", () => {
    expect(render).not.toThrow();
  });

  it("says in Catalan what is being waited for", () => {
    expect(render()).toContain("Carregant els fils");
  });

  it("keeps the shape of the loaded list so the screen does not jump", () => {
    const markup = render();

    expect(markup).toContain("thread-table");
    expect(markup).toContain("skeleton");
  });

  it("keeps the real column headers of the table", () => {
    const markup = render();

    for (const column of ["Assumpte", "Categoria", "Estat", "Últim missatge"]) {
      expect(markup).toContain(column);
    }
  });

  // The nav needs no query either, so a slow list never traps the reader on a
  // screen of bars.
  it("still leads to the other sections, with the list marked as current", () => {
    const markup = render();

    expect(markup).toContain('href="/digest"');
    expect(markup).toContain('href="/auto-resposta"');
    expect(markup).toContain('aria-current="page" href="/fils"');
  });

  // Bars stand in for content the reader cannot act on yet, so a screen reader
  // should hear the waiting message and not a table of empty cells.
  it("hides the placeholder shapes from assistive technology", () => {
    expect(render()).toContain('aria-hidden="true"');
  });
});
