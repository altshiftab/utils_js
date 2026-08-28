import test from "node:test";
import assert from "node:assert/strict";

import {sentences, words} from "../src/browser/segment.js";

test("sentences are split with their offsets", () => {
    const testCases = [
        {name: "empty text", text: "", expected: []},
        {name: "only whitespace", text: "   \n  ", expected: []},
        {name: "one sentence with no terminator", text: "Hej du", expected: ["Hej du"]},
        {name: "two sentences", text: "Hej! Hur mår du?", expected: ["Hej! ", "Hur mår du?"]},
        {
            name: "three terminators",
            text: "Hej! Hur mår du? Bra.",
            expected: ["Hej! ", "Hur mår du? ", "Bra."],
        },
    ];

    for (const testCase of testCases) {
        assert.deepEqual(
            sentences(testCase.text, "sv").map(segment => segment.text),
            testCase.expected,
            testCase.name,
        );
    }
});

// The reason for using Intl.Segmenter rather than splitting on punctuation. A Swedish abbreviation
// carries full stops that end nothing, and a splitter that broke on them would hand a model half a
// sentence and ask what was wrong with it.
test("an abbreviation does not end a sentence", () => {
    const testCases = [
        {
            name: "t.ex.",
            text: "Jag gillar frukt, t.ex. äpplen och päron. Sedan gick jag hem.",
            expected: 2,
        },
        {name: "bl.a.", text: "Vi köpte bl.a. mjölk. Det var dyrt.", expected: 2},
        // The counterpart: a full stop after a number really does end the sentence here, so the
        // rule is not simply "never break after a short token".
        {name: "a street number", text: "Han bor på Storgatan 5. Hon bor bredvid.", expected: 2},
    ];

    for (const testCase of testCases)
        assert.equal(sentences(testCase.text, "sv").length, testCase.expected, testCase.name);
});

// The offsets are the point of returning objects at all, so they are checked against the source
// rather than trusted: a segment must be exactly what its own index slices out.
test("every offset indexes the segment it belongs to", () => {
    const testCases = [
        {name: "swedish", text: "Hej! Hur mår du? Bra.", locale: "sv"},
        {name: "english", text: "One. Two. Three.", locale: "en"},
        {name: "leading whitespace", text: "\n\n  Först. Sedan.", locale: "sv"},
        {name: "repeated sentences", text: "Ja. Ja. Ja.", locale: "sv"},
    ];

    for (const testCase of testCases) {
        for (const segment of sentences(testCase.text, testCase.locale)) {
            assert.equal(
                testCase.text.slice(segment.index, segment.index + segment.text.length),
                segment.text,
                `${testCase.name}: segment at ${segment.index}`,
            );
        }
    }
});

test("words omit punctuation and spacing", () => {
    const testCases = [
        {name: "empty", text: "", expected: []},
        {name: "a plain sentence", text: "Hej du!", expected: ["Hej", "du"]},
        {name: "punctuation alone", text: "!? ...", expected: []},
        // Not a space-split: the apostrophe and hyphen stay inside their words.
        {name: "an apostrophe", text: "don't stop", expected: ["don't", "stop"]},
    ];

    for (const testCase of testCases) {
        assert.deepEqual(
            words(testCase.text, "en").map(segment => segment.text),
            testCase.expected,
            testCase.name,
        );
    }
});

test("word offsets index the source too", () => {
    const text = "Vi träffas imorgon, tror jag.";

    for (const segment of words(text, "sv")) {
        assert.equal(
            text.slice(segment.index, segment.index + segment.text.length),
            segment.text,
            `word at ${segment.index}`,
        );
    }
});
