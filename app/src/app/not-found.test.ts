// Renders the 404 page the way a request does: the component is turned into
// markup, since it takes no props and touches neither session nor database.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { APP_NAME } from "@correu-agent/shared";
import { DASHBOARD_PATH } from "../lib/routes";
import NotFound from "./not-found";

const render = (): string => renderToStaticMarkup(NotFound());

describe("NotFound", () => {
  // As the heading of the page, not a card label: `h2` is the small uppercase
  // section label of the design, and a page with no `h1` starts its outline
  // mid-way down.
  it("explains in Catalan that the page does not exist", () => {
    expect(render()).toContain("<h1>Aquesta pàgina no existeix</h1>");
  });

  it("wears the dashboard's visual identity", () => {
    const markup = render();

    expect(markup).toContain("app-shell");
    expect(markup).toContain("airmail-stripe");
    expect(markup).toContain(APP_NAME);
  });

  it("offers a way back to the dashboard", () => {
    expect(render()).toContain(`href="${DASHBOARD_PATH}"`);
  });
});
