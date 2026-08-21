/**
 * Reading the moment a page says it was published.
 *
 * There is no one way a page states this. Open Graph's article namespace and Dublin Core are
 * standards; `pubdate`, `sailthru.date` and Al Jazeera's `publishedDate` are conventions one
 * publisher or vendor settled on. What follows is a list of those conventions, tried in turn,
 * falling back on the address itself when a page carries nothing at all.
 *
 * The document is taken as an argument rather than reached for, so that this runs against a page
 * a content script is on, a document parsed from a fetch, or a stand-in in a test.
 */

/** The part of an element this reads. A DOM `Element` satisfies it. */
export interface PublishedDateElement {
    getAttribute(qualifiedName: string): string | null;
    readonly textContent: string | null;
}

/** The part of a document this reads. A DOM `Document` satisfies it. */
export interface PublishedDateDocument {
    getElementsByTagName(qualifiedName: string): Iterable<PublishedDateElement>;
}

/**
 * Meta names in the order they are trusted. The attribute the name appears under differs between
 * them, so both are matched: Open Graph writes `property`, Schema.org's microdata `itemprop`, and
 * the rest `name`. A modified time is last, being better than nothing but not a publication date.
 */
const metaKeys: readonly (readonly [attribute: string, value: string])[] = [
    ["property", "article:published_time"],
    ["property", "og:article:published_time"],
    ["itemprop", "datePublished"],
    ["name", "datePublished"],
    ["name", "date"],
    ["name", "DC.date"],
    ["name", "DC.date.issued"],
    ["name", "pubdate"],
    ["name", "publish_date"],
    ["name", "sailthru.date"],
    // Al Jazeera's spelling, the reverse of Schema.org's.
    ["name", "publishedDate"],
    ["property", "article:modified_time"],
    ["name", "lastDate"],
];

/** Attributes that mark a `<time>` as the publication one, most specific first. */
const timePreferences: readonly ((element: PublishedDateElement) => boolean)[] = [
    element => element.getAttribute("itemprop") === "datePublished",
    element => element.getAttribute("pubdate") !== null,
    element => (element.getAttribute("class") ?? "").includes("publish"),
    () => true,
];

/**
 * The shapes a date takes in an address. These are worth having because they survive a page being
 * refused outright, and because some publishers state the date nowhere else. Al Jazeera writes the
 * month and day without a leading zero, so both widths are accepted.
 */
const urlDatePatterns: readonly RegExp[] = [
    /\/(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\/|$|\?)/,
    /\/(\d{4})-(\d{2})-(\d{2})\//,
    /-(\d{4})-(\d{2})-(\d{2})\/?$/,
];

function toIsoString(value: string | null | undefined): string {
    if (!value)
        return "";
    const date = new Date(value.trim());
    return isNaN(date.getTime()) ? "" : date.toISOString();
}

function fromMeta(document: PublishedDateDocument): string {
    // Read once into a map, rather than searching the document for each of the names in turn.
    const contents = new Map<string, string>();
    for (const element of document.getElementsByTagName("meta")) {
        const content = element.getAttribute("content");
        if (!content)
            continue;
        for (const attribute of ["property", "itemprop", "name"]) {
            const value = element.getAttribute(attribute);
            if (value)
                contents.set(`${attribute}:${value.toLowerCase()}`, content);
        }
    }

    for (const [attribute, value] of metaKeys) {
        const iso = toIsoString(contents.get(`${attribute}:${value.toLowerCase()}`));
        if (iso)
            return iso;
    }
    return "";
}

const jsonLdDatePattern = /"date(?:Published|Created)"\s*:\s*"([^"]+)"/;

function fromJsonLd(document: PublishedDateDocument): string {
    for (const element of document.getElementsByTagName("script")) {
        const type = element.getAttribute("type");
        if (!type || type.toLowerCase().trim() !== "application/ld+json")
            continue;
        // Matched rather than parsed: the block may be large, may be invalid, and only one value
        // out of it is wanted.
        const match = jsonLdDatePattern.exec(element.textContent ?? "");
        const iso = toIsoString(match?.[1]);
        if (iso)
            return iso;
    }
    return "";
}

function fromTimeElement(document: PublishedDateDocument): string {
    const elements = [...document.getElementsByTagName("time")];
    for (const prefers of timePreferences) {
        for (const element of elements) {
            if (!prefers(element))
                continue;
            const iso = toIsoString(element.getAttribute("datetime"));
            if (iso)
                return iso;
        }
    }
    return "";
}

function fromAgeSpan(document: PublishedDateDocument): string {
    // Hacker News carries no metadata at all, keeping the submission time in the title of the span
    // that renders it as an age, followed by a count of unix seconds.
    for (const element of document.getElementsByTagName("span")) {
        if (!(element.getAttribute("class") ?? "").includes("age"))
            continue;
        const [timestamp] = (element.getAttribute("title") ?? "").trim().split(/\s+/);
        const iso = toIsoString(timestamp);
        if (iso)
            return iso;
    }
    return "";
}

/** The publication date an address states, as an ISO string, or `""` when it states none. */
export function extractPublishedDateFromUrl(url: string): string {
    let path: string;
    try {
        path = new URL(url).pathname;
    } catch {
        path = url;
    }

    for (const pattern of urlDatePatterns) {
        const match = pattern.exec(path);
        if (!match)
            continue;
        const iso = toIsoString(
            `${match[1]}-${match[2]!.padStart(2, "0")}-${match[3]!.padStart(2, "0")}`,
        );
        if (iso)
            return iso;
    }
    return "";
}

/**
 * The publication date a document states, as an ISO string, or `""` when none can be read. The
 * address is consulted last, and only when given.
 */
export function extractPublishedDate(document: PublishedDateDocument, url?: string): string {
    return fromMeta(document)
        || fromJsonLd(document)
        || fromTimeElement(document)
        || fromAgeSpan(document)
        || (url ? extractPublishedDateFromUrl(url) : "");
}
