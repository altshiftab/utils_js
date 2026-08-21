import assert from "node:assert/strict";
import {test} from "node:test";

import {
    extractPublishedDate,
    extractPublishedDateFromUrl,
    type PublishedDateDocument,
    type PublishedDateElement,
} from "../src/browser/published_date.js";

/**
 * A stand-in for the part of a document the extraction reads. Built from tag name to a list of
 * attribute maps, so a test states only the elements it is about.
 */
function documentOf(
    elements: Record<string, (Record<string, string> & {textContent?: string})[]>,
): PublishedDateDocument {
    return {
        getElementsByTagName(qualifiedName: string): Iterable<PublishedDateElement> {
            return (elements[qualifiedName] ?? []).map(attributes => ({
                getAttribute: (name: string) => attributes[name] ?? null,
                textContent: attributes.textContent ?? null,
            }));
        },
    };
}

const day = (iso: string) => iso.slice(0, 10);

test("a date is read from the meta names publishers use", () => {
    const testCases = [
        {
            name: "open graph article published time",
            meta: [{property: "article:published_time", content: "2026-08-14T16:01:43Z"}],
            want: "2026-08-14",
        },
        {
            name: "schema.org microdata",
            meta: [{itemprop: "datePublished", content: "2026-08-13T11:45:00Z"}],
            want: "2026-08-13",
        },
        {name: "dublin core", meta: [{name: "DC.date.issued", content: "2026-07-04T02:00:00Z"}], want: "2026-07-04"},
        {
            name: "al jazeera publishedDate",
            meta: [{"data-rh": "true", name: "publishedDate", content: "2026-06-09T08:37:36Z"}],
            want: "2026-06-09",
        },
        {name: "sailthru", meta: [{name: "sailthru.date", content: "2026-05-02T00:00:00Z"}], want: "2026-05-02"},
        {
            name: "a published time outranks a modified one whatever the order",
            meta: [
                {property: "article:modified_time", content: "2026-08-20T00:00:00Z"},
                {property: "article:published_time", content: "2026-08-14T16:01:43Z"},
            ],
            want: "2026-08-14",
        },
        {name: "a meta with no content is ignored", meta: [{name: "publishedDate"}], want: ""},
        {name: "nothing to read", meta: [{name: "author", content: "Someone"}], want: ""},
    ];

    for (const testCase of testCases) {
        const got = extractPublishedDate(documentOf({meta: testCase.meta}));
        assert.equal(testCase.want ? day(got) : got, testCase.want, testCase.name);
    }
});

test("a date is read from a JSON-LD block when the meta names carry none", () => {
    const document = documentOf({
        script: [
            {type: "text/javascript", textContent: `{"datePublished":"1999-01-01T00:00:00Z"}`},
            {type: "application/ld+json", textContent: `{"@type":"Article","datePublished":"2026-02-16T14:39:32Z"}`},
        ],
    });
    assert.equal(day(extractPublishedDate(document)), "2026-02-16");
});

test("a time element is read, preferring the one marked as the published date", () => {
    const document = documentOf({
        time: [
            {datetime: "2026-01-01T00:00:00Z"},
            {itemprop: "datePublished", datetime: "2026-03-09T09:00:00Z"},
        ],
    });
    assert.equal(day(extractPublishedDate(document)), "2026-03-09");
});

test("hacker news keeps its timestamp in the title of an age span", () => {
    const testCases = [
        {name: "timestamp followed by unix seconds", title: "2026-02-16T14:39:32Z 1771252772", want: "2026-02-16"},
        {name: "bare timestamp", title: "2026-08-14T09:00:00Z", want: "2026-08-14"},
        {name: "a title of only spaces", title: "   ", want: ""},
    ];

    for (const testCase of testCases) {
        const got = extractPublishedDate(documentOf({span: [{class: "age", title: testCase.title}]}));
        assert.equal(testCase.want ? day(got) : got, testCase.want, testCase.name);
    }

    // A span that is not an age is not read, whatever its title holds.
    assert.equal(extractPublishedDate(documentOf({span: [{class: "byline", title: "2026-08-14T09:00:00Z"}]})), "");
});

test("a date is read from the address, in the shapes publishers write it", () => {
    const testCases = [
        {name: "path segments", url: "https://www.nytimes.com/2026/08/14/world/asia/afghanistan.html", want: "2026-08-14"},
        {name: "single digit month and day", url: "https://www.aljazeera.com/video/newsfeed/2026/6/9/indian-crew", want: "2026-06-09"},
        {name: "single dated segment", url: "https://www.bloomberg.com/news/articles/2026-08-14/story", want: "2026-08-14"},
        {name: "trailing date on a slug", url: "https://www.reuters.com/world/some-headline-2026-08-14/", want: "2026-08-14"},
        {name: "an opaque address", url: "https://www.wsj.com/articles/some-slug-9a2f1c3d", want: ""},
        {name: "digits that are not a date", url: "https://example.com/1234/56/78/x", want: ""},
        {name: "not an address at all", url: "not a url", want: ""},
    ];

    for (const testCase of testCases) {
        const got = extractPublishedDateFromUrl(testCase.url);
        assert.equal(testCase.want ? day(got) : got, testCase.want, testCase.name);
    }
});

test("a timestamp naming no zone is read as UTC, not as the reader's local time", () => {
    // Al Jazeera writes 2026-08-04T01:43:51. Read as local time in a zone ahead of
    // UTC that becomes the third of August, which is the wrong day.
    const document = documentOf({meta: [{name: "publishedDate", content: "2026-08-04T01:43:51"}]});
    assert.equal(extractPublishedDate(document), "2026-08-04T01:43:51.000Z");

    // A stated zone or offset is honoured as given.
    const offset = documentOf({meta: [{name: "publishedDate", content: "2026-08-04T01:43:51+02:00"}]});
    assert.equal(extractPublishedDate(offset), "2026-08-03T23:43:51.000Z");

    // A bare date is midnight UTC, so that the day it names is the day it keeps.
    const bare = documentOf({meta: [{name: "publishedDate", content: "2026-08-04"}]});
    assert.equal(extractPublishedDate(bare), "2026-08-04T00:00:00.000Z");

    // And an address, which names a day and no time at all.
    assert.equal(extractPublishedDateFromUrl("https://www.aljazeera.com/news/2026/8/4/x"), "2026-08-04T00:00:00.000Z");
});

test("the address is consulted only after the document, and only when given", () => {
    const dated = documentOf({meta: [{property: "article:published_time", content: "2026-08-14T16:01:43Z"}]});
    const bare = documentOf({});

    // The document wins over an address that disagrees.
    assert.equal(day(extractPublishedDate(dated, "https://example.com/2001/01/01/x")), "2026-08-14");
    assert.equal(day(extractPublishedDate(bare, "https://example.com/2026/6/9/x")), "2026-06-09");
    assert.equal(extractPublishedDate(bare), "");
});
