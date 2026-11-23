import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("the built lab retains its three labelled steps, form controls and history region", async () => {
  const html = await readFile(new URL("../dist/lab/index.html", import.meta.url), "utf8");
  for (const step of [1, 2, 3]) {
    assert.match(html, new RegExp(`<section class="lab-card" aria-labelledby="step-${step}">`));
    assert.match(html, new RegExp(`<h2 id="step-${step}">`));
  }
  assert.equal((html.match(/class="field-select field-dropdown"/g) ?? []).length, 6);
  assert.equal((html.match(/<fieldset class="fieldset" disabled=""/g) ?? []).length, 2);
  assert.match(html, /<section class="history-panel" aria-labelledby="history-title">/);
  const languages = [...html.matchAll(/data-locale="([a-z]+)"/g)].map(([, code]) => code).sort();
  assert.deepEqual(languages, ["ar", "de", "en", "es", "fr", "hi", "it", "ja", "pt"]);
});
