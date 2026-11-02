import { describe, expect, it } from "vitest";
import { likeContains } from "../../src/lib/like.js";

describe("likeContains", () => {
  it("escapes LIKE wildcards and the escape character", () =>
    expect(likeContains(" 50%_off\\ ")).toBe("%50\\%\\_off\\\\%"));
  it("limits the search term length before escaping", () =>
    expect(likeContains("abcdef", 3)).toBe("%abc%"));
  it("treats missing input as an empty term", () =>
    expect(likeContains(undefined)).toBe("%%"));
});
