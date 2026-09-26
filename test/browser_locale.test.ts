import assert from "node:assert/strict";
import {test} from "node:test";

import {applyPreferredLocale, withFallbacks} from "../src/browser/locale.js";

// lit-localize rejects for a locale the bundle was not built with, which is the only thing
// the module reads a decision out of. A stub stands in for it, recording what it was asked
// for so a case can assert on the order the languages were tried in as well as the winner.
function bundleWith(available: readonly string[]) {
    const asked: string[] = [];

    return {
        asked,
        setLocale: async (locale: string) => {
            asked.push(locale);
            if (!available.includes(locale))
                throw new Error(`no translation for ${locale}`);
        },
    };
}

test("the first of the browser's languages the bundle can serve is the one applied", async () => {
    const testCases = [
        {name: "the only language asked for", languages: ["sv"], available: ["sv"], expected: "sv"},
        {name: "the first, when both are available", languages: ["sv", "en"], available: ["en", "sv"], expected: "sv"},
        {
            name: "a later one, when the preferred language has no translation",
            languages: ["de", "fr", "sv"],
            available: ["sv"],
            expected: "sv",
        },
        {
            name: "the source locale, where the browser asks for it second",
            languages: ["nb", "en"],
            available: ["en", "sv"],
            expected: "en",
        },
    ];

    for (const testCase of testCases) {
        const bundle = bundleWith(testCase.available);

        assert.equal(
            await applyPreferredLocale(bundle.setLocale, testCase.languages),
            testCase.expected,
            testCase.name,
        );
    }
});

test("a browser asking only for languages we do not have leaves the source locale in place", async () => {
    const testCases = [
        {name: "one language we do not have", languages: ["de"], available: ["en", "sv"]},
        {name: "several, none of them ours", languages: ["de", "fr", "es"], available: ["en", "sv"]},
        // A browser reporting no preference at all is not a reason to throw; the page is
        // already rendered in the source locale and stays that way.
        {name: "no preference at all", languages: [], available: ["en", "sv"]},
    ];

    for (const testCase of testCases) {
        const bundle = bundleWith(testCase.available);

        assert.equal(
            await applyPreferredLocale(bundle.setLocale, testCase.languages),
            null,
            testCase.name,
        );
    }
});

test("the languages are tried in the order the browser gave them, and stop at the first hit", async () => {
    const bundle = bundleWith(["sv"]);

    await applyPreferredLocale(bundle.setLocale, ["de", "sv", "en"]);

    // "en" is never reached: the browser preferred "sv" to it, and asking afterwards would
    // undo the choice the browser had already made for us.
    assert.deepEqual(bundle.asked, ["de", "sv"]);
});

// A regional tag is passed through as it stands. lit-localize matches on the exact locale
// code it was built with, so "sv-SE" finds a translation only if the build declares it --
// which is why targetLocales, not this module, is what decides the set.
test("a regional tag is offered to the bundle unchanged", async () => {
    const testCases = [
        {name: "declared with the region", languages: ["sv-SE"], available: ["sv-SE"], expected: "sv-SE"},
        {name: "declared without it", languages: ["sv-SE", "sv"], available: ["sv"], expected: "sv"},
    ];

    for (const testCase of testCases) {
        const bundle = bundleWith(testCase.available);

        assert.equal(
            await applyPreferredLocale(bundle.setLocale, testCase.languages),
            testCase.expected,
            testCase.name,
        );
    }
});

test("a regional tag falls back to its language, ahead of the browser's next choice", async () => {
    const testCases = [
        {name: "the region alone", languages: ["sv-SE"], available: ["en", "sv"], expected: "sv", asked: ["sv-SE", "sv"]},
        {
            name: "before a later language the bundle also has",
            languages: ["sv-SE", "en-US"],
            available: ["en", "sv"],
            expected: "sv",
            asked: ["sv-SE", "sv"],
        },
        {
            name: "a regional tag the bundle has exactly wins as it is",
            languages: ["pt-BR"],
            available: ["pt-BR", "pt"],
            expected: "pt-BR",
            asked: ["pt-BR"],
        },
        {
            name: "a fallback with no translation moves on to the next language",
            languages: ["de-DE", "sv"],
            available: ["sv"],
            expected: "sv",
            asked: ["de-DE", "de", "sv"],
        },
    ];

    for (const testCase of testCases) {
        const bundle = bundleWith(testCase.available);

        assert.equal(
            await applyPreferredLocale(bundle.setLocale, testCase.languages),
            testCase.expected,
            testCase.name,
        );
        assert.deepEqual(bundle.asked, testCase.asked, testCase.name);
    }
});

test("withFallbacks", () => {
    const testCases = [
        {name: "a regional tag", languages: ["sv-SE"], expected: ["sv-SE", "sv"]},
        {name: "each tag's fallbacks follow it", languages: ["sv-SE", "en-US"], expected: ["sv-SE", "sv", "en-US", "en"]},
        {name: "a tag already reached is not repeated", languages: ["sv-SE", "sv", "en"], expected: ["sv-SE", "sv", "en"]},
        {name: "several subtags", languages: ["zh-Hant-TW"], expected: ["zh-Hant-TW", "zh-Hant", "zh"]},
        {name: "an empty tag is skipped", languages: ["", "sv"], expected: ["sv"]},
        {name: "no languages", languages: [], expected: []},
    ];

    for (const testCase of testCases)
        assert.deepEqual(withFallbacks(testCase.languages), testCase.expected, testCase.name);
});
