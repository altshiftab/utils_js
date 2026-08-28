import test from "node:test";
import assert from "node:assert/strict";

import {allIndicesOfSubstring, segmentIndexAt} from "../src/browser/text_offsets.js";

test("every occurrence is found", () => {
    const testCases = [
        {name: "no occurrence", text: "abc", substring: "d", expected: []},
        {name: "one occurrence", text: "abc", substring: "b", expected: [1]},
        {name: "two occurrences", text: "abcabc", substring: "bc", expected: [1, 4]},
        {name: "at both ends", text: "aXa", substring: "a", expected: [0, 2]},
        // Overlapping ones included: the caller is choosing among candidates, and the one that fits
        // may be the second of a pair that share characters.
        {name: "overlapping", text: "aaaa", substring: "aa", expected: [0, 1, 2]},
        {name: "the whole string", text: "abc", substring: "abc", expected: [0]},
        {name: "longer than the text", text: "ab", substring: "abc", expected: []},
        // Searching for nothing must terminate, which it would not if the empty string were found
        // at every position.
        {name: "the empty substring", text: "abc", substring: "", expected: []},
        {name: "the empty text", text: "", substring: "a", expected: []},
        {name: "non-ascii", text: "vår höst vår", substring: "vår", expected: [0, 9]},
    ];

    for (const testCase of testCases) {
        assert.deepEqual(
            [...allIndicesOfSubstring(testCase.text, testCase.substring)],
            testCase.expected,
            testCase.name,
        );
    }
});

test("an offset falls to the segment it began in", () => {
    // Segments beginning at 0, 5 and 12 -- as they would from segmenting a string in order.
    const offsets = [0, 5, 12];

    const testCases = [
        {name: "before the first segment", offsets: [3, 8], target: 0, expected: -1},
        {name: "exactly on the first", offsets, target: 0, expected: 0},
        {name: "inside the first", offsets, target: 3, expected: 0},
        {name: "exactly on the second", offsets, target: 5, expected: 1},
        {name: "inside the second", offsets, target: 9, expected: 1},
        {name: "exactly on the last", offsets, target: 12, expected: 2},
        {name: "past the last", offsets, target: 400, expected: 2},
        {name: "no segments at all", offsets: [], target: 0, expected: -1},
        {name: "one segment, before it", offsets: [4], target: 1, expected: -1},
        {name: "one segment, inside it", offsets: [4], target: 7, expected: 0},
    ];

    for (const testCase of testCases)
        assert.equal(segmentIndexAt(testCase.offsets, testCase.target), testCase.expected, testCase.name);
});

// The binary search has to agree with the obvious linear answer at every position, which is the
// kind of thing an off-by-one in the midpoint would break for exactly one input.
//
// Strictly ascending, as segmenting a string in order produces. Two segments beginning at the same
// offset is not a case this answers meaningfully -- the linear rule would take the later and the
// search takes whichever it lands on -- so it is left out rather than pinned to an accident.
test("the search agrees with a linear scan everywhere", () => {
    const offsets = [0, 4, 9, 15, 23];

    for (let target = 0; target <= 30; target++) {
        let expected = -1;
        for (let index = 0; index < offsets.length; index++) {
            if (offsets[index] <= target)
                expected = index;
        }

        assert.equal(segmentIndexAt(offsets, target), expected, `offset ${target}`);
    }
});
