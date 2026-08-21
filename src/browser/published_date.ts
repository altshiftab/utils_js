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
const metaNames: readonly string[] = [
    "article:published_time",
    "og:article:published_time",
    "datePublished",
    "date",
    "DC.date",
    "DC.date.issued",
    "pubdate",
    "publish_date",
    "publishdate",
    "sailthru.date",
    // Al Jazeera's spelling, the reverse of Schema.org's.
    "publishedDate",
    "article:modified_time",
    "lastDate",
];

// Each name is looked for under all three, rather than the one its vocabulary
// prescribes. Open Graph says property and Schema.org's microdata says itemprop,
// but publishers are not consistent about it -- Svenska Dagbladet writes
// article:published_time under name -- and a date stated under the wrong
// attribute is still the date the page is stating.
const metaAttributes: readonly string[] = ["property", "itemprop", "name"];

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

/** An ISO date or date-time stating no zone and no offset, which Date reads as local time. */
const zonelessPattern = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/;

function toIsoString(value: string | null | undefined): string {
    if (!value)
        return "";

    const trimmed = value.trim();
    // Read as UTC when the page names no zone. Date would otherwise read it as
    // the reader's local time, which moves the moment by the reader's offset and,
    // for anything published near midnight, reports the wrong day. Al Jazeera
    // writes its publishedDate this way.
    const date = new Date(zonelessPattern.test(trimmed) ? `${trimmed.replace(" ", "T")}Z` : trimmed);

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

    for (const name of metaNames) {
        for (const attribute of metaAttributes) {
            const iso = toIsoString(contents.get(`${attribute}:${name.toLowerCase()}`));
            if (iso)
                return iso;
        }
    }
    return "";
}

/**
 * Read only from the objects the block is about, never from what they contain. A live blog states
 * its updates as a nested array, each with a date of its own; the newest of those is a few minutes
 * old whatever the age of the page, and taking it reports a years-old feed as published today.
 */
function datePublishedOf(value: unknown): string {
    if (!value || typeof value !== "object")
        return "";

    for (const item of Array.isArray(value) ? value : [value]) {
        if (!item || typeof item !== "object")
            continue;
        const record = item as Record<string, unknown>;

        // A @graph names several things the page is about; its members are peers, not parts.
        for (const entry of [record, ...(Array.isArray(record["@graph"]) ? record["@graph"] : [])]) {
            if (!entry || typeof entry !== "object")
                continue;
            const fields = entry as Record<string, unknown>;
            for (const key of ["datePublished", "dateCreated"]) {
                const field = fields[key];
                const iso = typeof field === "string" ? toIsoString(field) : "";
                if (iso)
                    return iso;
            }
        }
    }
    return "";
}

function fromJsonLd(document: PublishedDateDocument): string {
    for (const element of document.getElementsByTagName("script")) {
        const type = element.getAttribute("type");
        if (!type || type.toLowerCase().trim() !== "application/ld+json")
            continue;

        let data: unknown;
        try {
            data = JSON.parse(element.textContent ?? "");
        } catch {
            // Invalid JSON, of which there is a great deal in the wild.
            continue;
        }

        const iso = datePublishedOf(data);
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
