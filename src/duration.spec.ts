import { describe, expect, test } from "bun:test";
import { formatDuration } from "./duration";

describe("formatDuration", () => {
  test("under a minute pads the seconds", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(5)).toBe("0:05");
    expect(formatDuration(59)).toBe("0:59");
  });

  test("minutes and seconds", () => {
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(600)).toBe("10:00");
  });

  test("an hour or more switches to H:MM:SS", () => {
    expect(formatDuration(3600)).toBe("1:00:00");
    expect(formatDuration(3661)).toBe("1:01:01");
    expect(formatDuration(36000)).toBe("10:00:00");
  });
});
