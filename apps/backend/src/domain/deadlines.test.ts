import { describe, expect, it } from "vitest";
import { computeDeadlines } from "./deadlines";

describe("computeDeadlines", () => {
  it("clamps leap February", () => {
    const result = computeDeadlines(new Date("2028-01-31T00:00:00Z"), [
      { id: "r1", delay: { amount: 1, unit: "months" } },
    ]);
    expect(result[0].dueAt.toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });

  it("clamps non-leap February", () => {
    const result = computeDeadlines(new Date("2027-01-31T00:00:00Z"), [
      { id: "r1", delay: { amount: 1, unit: "months" } },
    ]);
    expect(result[0].dueAt.toISOString()).toBe("2027-02-28T00:00:00.000Z");
  });

  it("anchors later rounds to scheduled deadlines", () => {
    const result = computeDeadlines(new Date("2028-01-31T13:14:15Z"), [
      { id: "r1", delay: { amount: 1, unit: "months" } },
      { id: "r2", delay: { amount: 1, unit: "weeks" } },
    ]);
    expect(result.map(({ dueAt }) => dueAt.toISOString())).toEqual([
      "2028-02-29T13:14:15.000Z",
      "2028-03-07T13:14:15.000Z",
    ]);
  });

  it("rejects nonpositive delays", () => {
    for (const amount of [0, -1]) {
      expect(() => computeDeadlines(new Date(), [
        { id: "r1", delay: { amount, unit: "days" } },
      ])).toThrow();
    }
  });
});
