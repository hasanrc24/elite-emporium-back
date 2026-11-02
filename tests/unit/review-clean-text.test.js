import { describe, expect, it } from "vitest";
import { cleanText } from "../../src/modules/reviews/review.service.js";

describe("review text sanitizing", () => {
  it("strips markup but keeps ampersands and quotes readable", () => {
    expect(
      cleanText('<b>Fit & "feel"</b><script>x()</script> it\'s ok', 100),
    ).toBe('Fit & "feel" it\'s ok');
  });
  it("truncates", () => {
    expect(cleanText("abcdef", 3)).toBe("abc");
  });
});
