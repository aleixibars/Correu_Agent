import { describe, expect, it } from "vitest";
import { formatAttachmentSize, isPreviewable, normaliseMimeType } from "./preview";

describe("isPreviewable", () => {
  it("accepts the types the browser paints without running them", () => {
    expect(isPreviewable("application/pdf")).toBe(true);
    expect(isPreviewable("image/png")).toBe(true);
    expect(isPreviewable("IMAGE/JPEG; charset=binary")).toBe(true);
  });

  it("refuses an SVG, which is a document that can carry a script", () => {
    expect(isPreviewable("image/svg+xml")).toBe(false);
  });

  it("refuses anything else, including mail the sender called HTML", () => {
    expect(isPreviewable("text/html")).toBe(false);
    expect(isPreviewable("application/octet-stream")).toBe(false);
    expect(isPreviewable(null)).toBe(false);
  });
});

describe("normaliseMimeType", () => {
  it("drops the parameters and the case", () => {
    expect(normaliseMimeType("Application/PDF; name=a.pdf")).toBe("application/pdf");
  });

  it("reads an empty type as none at all", () => {
    expect(normaliseMimeType("")).toBeNull();
    expect(normaliseMimeType(null)).toBeNull();
  });
});

describe("formatAttachmentSize", () => {
  it("reads in the unit the size deserves", () => {
    expect(formatAttachmentSize(512)).toBe("512 B");
    expect(formatAttachmentSize(20480)).toBe("20 kB");
    expect(formatAttachmentSize(1_572_864)).toBe("1,5 MB");
  });

  it("says nothing when the provider reported no size", () => {
    expect(formatAttachmentSize(null)).toBeNull();
  });
});
