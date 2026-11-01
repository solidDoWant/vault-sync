import { describe, expect, it } from "vitest";
import { deviceNameProblem, maxDeviceNameBytes } from "./device-name";

describe("deviceNameProblem", () => {
  it.each([
    ["an ordinary name", "Work laptop"],
    ["an empty field, which uses the platform's name", ""],
    ["surrounding spaces, which are trimmed", "  Phone  "],
    ["a name of exactly the byte limit", "a".repeat(maxDeviceNameBytes)],
    ["a single emoji", "Phone 📱"],
  ])("accepts %s", (_, name) => {
    expect(deviceNameProblem(name)).toBeUndefined();
  });

  it.each([
    ["a line break", "Work\nlaptop"],
    ["a zero-width space", "Work​laptop"],
    ["a right-to-left override", "Work‮laptop"],
    ["an emoji joined with a zero-width joiner", "Dev 👩‍💻"],
  ])("refuses %s as hidden characters", (_, name) => {
    expect(deviceNameProblem(name)).toMatch(/hidden characters/u);
  });

  it("refuses a name over the byte limit", () => {
    expect(deviceNameProblem("a".repeat(maxDeviceNameBytes + 1))).toMatch(/too long/u);
    // Two bytes each in UTF-8: fewer characters than bytes.
    expect(deviceNameProblem("é".repeat(maxDeviceNameBytes / 2 + 1))).toMatch(/too long/u);
  });
});
