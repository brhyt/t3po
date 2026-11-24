import { describe, expect, it } from "@effect/vitest";
import { leadNameFromTitle, leadNamingDue } from "./LeadNaming.ts";

describe("lead naming", () => {
  it("waits for enough user turns and backs off after a failed attempt", () => {
    expect(leadNamingDue(2, undefined)).toBe(false);
    expect(leadNamingDue(3, undefined)).toBe(true);
    expect(leadNamingDue(5, 3)).toBe(false);
    expect(leadNamingDue(6, 3)).toBe(true);
  });

  it("cleans generated titles and rejects ones that cannot name a lead", () => {
    expect(leadNameFromTitle(' "Brega Growth Lead". ')).toBe("Brega Growth Lead");
    expect(leadNameFromTitle("New thread")).toBeUndefined();
    expect(leadNameFromTitle("  ")).toBeUndefined();
  });
});
