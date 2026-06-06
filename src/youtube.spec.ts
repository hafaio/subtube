import { describe, expect, test } from "bun:test";
import { parseIsoDuration, uploadsPlaylistId } from "./youtube";

describe("uploadsPlaylistId", () => {
  test("swaps the UC channel prefix for UU", () => {
    expect(uploadsPlaylistId("UCabcdef12345")).toBe("UUabcdef12345");
  });
});

describe("parseIsoDuration", () => {
  test("parses hours, minutes, and seconds", () => {
    expect(parseIsoDuration("PT1H2M3S")).toBe(3723);
    expect(parseIsoDuration("PT45S")).toBe(45);
    expect(parseIsoDuration("PT3M")).toBe(180);
    expect(parseIsoDuration("PT2H")).toBe(7200);
  });

  test("parses a day component", () => {
    expect(parseIsoDuration("P1DT2H")).toBe(93600);
  });

  test("live/upcoming (P0D) and unparseable input yield 0", () => {
    expect(parseIsoDuration("P0D")).toBe(0);
    expect(parseIsoDuration("")).toBe(0);
    expect(parseIsoDuration("garbage")).toBe(0);
  });
});
