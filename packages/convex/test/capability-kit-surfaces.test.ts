import { describe, expect, it } from "vitest";
import {
  assertSurfaceAllowed,
  denyAllSurfaces,
  exposeSurfaces,
} from "../confect/capabilities/_kit/surfaces";

describe("capability surface policy", () => {
  it("defaults to no exposure", () => {
    expect(assertSurfaceAllowed(denyAllSurfaces, "api")).toBe(false);
    expect(assertSurfaceAllowed(denyAllSurfaces, "web")).toBe(false);
  });

  it("exposes only listed surfaces", () => {
    const policy = exposeSurfaces(["web", "mcp"]);
    expect(assertSurfaceAllowed(policy, "web")).toBe(true);
    expect(assertSurfaceAllowed(policy, "mcp")).toBe(true);
    expect(assertSurfaceAllowed(policy, "api")).toBe(false);
    expect(assertSurfaceAllowed(policy, "cli")).toBe(false);
  });
});
