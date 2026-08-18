// The loading screen is the fallback Next renders while the thread detail query
// runs, so it has to stand on its own: no session, no database, and no thread
// id — the fallback is rendered before the page reads its params.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../auth", () => ({
  auth: () => {
    throw new Error("the loading screen must not read the session");
  },
}));
vi.mock("../../../lib/db", () => ({
  get db(): never {
    throw new Error("the loading screen must not query the database");
  },
}));
vi.mock("../../../lib/threads/thread-detail", () => ({
  loadThreadDetail: () => {
    throw new Error("the loading screen must not load the thread");
  },
}));

const { default: ThreadLoading } = await import("./loading");

const render = (): string => renderToStaticMarkup(ThreadLoading());

describe("ThreadLoading", () => {
  it("renders without a session, a database or a thread", () => {
    expect(render).not.toThrow();
  });

  it("says in Catalan what is being waited for", () => {
    expect(render()).toContain("Carregant el fil");
  });

  it("keeps the shape of the loaded thread so the screen does not jump", () => {
    const markup = render();

    expect(markup).toContain("message");
    expect(markup).toContain("card");
    expect(markup).toContain("skeleton");
  });

  it("hides the placeholder shapes from assistive technology", () => {
    expect(render()).toContain('aria-hidden="true"');
  });

  // The list is one click away and needs no query, so waiting for a slow thread
  // never traps the reader on a screen of bars.
  it("still leads back to the thread list", () => {
    expect(render()).toContain('href="/fils"');
  });
});
