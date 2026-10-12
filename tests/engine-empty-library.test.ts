import { describe, it, expect } from "vitest";
import { FormalizationEngine } from "../src/formalize/engine.js";
import type { FormalizationLibrary } from "../src/formalize/engine.js";
import { MockLLMAdapter } from "../src/llm/mock.js";

// SkillLibrary.create always seeds the starter templates, so a library with
// no templates has to be a stand-in. It is typed as the slice of
// SkillLibrary the engine uses, with no cast, so the rest of SkillLibrary
// can change freely. When that slice changes, an editor or a tsc pointed
// at tests flags this stand-in; no project command type-checks tests.
function makeEmptyLibrary(): FormalizationLibrary {
  return {
    search: () => [],
    list: () => [],
    getTemplateSearchText: () => "",
    recordUse: () => {},
  };
}

describe("FormalizationEngine", () => {
  it("returns null instead of crashing when library is empty", async () => {
    const library = makeEmptyLibrary();
    const llm = new MockLLMAdapter();
    const engine = new FormalizationEngine(library, llm);

    const result = await engine.formalize("find a contradiction in access policies");
    expect(result).toBeNull();
  });
});
