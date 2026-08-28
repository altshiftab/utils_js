/**
 * Splitting text into sentences and words, with the offsets they were found at.
 *
 * `Intl.Segmenter` does the work, which is why this is a few lines rather than a rules engine: the
 * browser already carries ICU's break rules for every locale it supports, and they know that a
 * full stop in "t.ex." does not end a sentence while the one in "gick hem." does. A hand-rolled
 * splitter on `/[.!?]/` gets Swedish abbreviations wrong on the first paragraph it meets.
 *
 * The offsets are the reason this returns objects rather than strings. Anything that acts on a
 * segment afterwards -- underlining it, replacing it, matching a correction back to it -- needs to
 * know where in the original it began, and recovering that with `indexOf` picks the wrong instance
 * as soon as a sentence repeats.
 */

export interface TextSegment {
    /** The segment as it appears in the source, trailing whitespace included. */
    text: string;
    /** Where the segment begins in the string it was taken from. */
    index: number;
}

function segment(text: string, locale: string | undefined, granularity: "sentence" | "word"): TextSegment[] {
    if (!text)
        return [];

    const segmenter = new Intl.Segmenter(locale, {granularity});

    const segments: TextSegment[] = [];
    for (const {segment: value, index} of segmenter.segment(text)) {
        // A segment that is only whitespace is a gap between sentences rather than one of them.
        if (!value.trim())
            continue;

        segments.push({text: value, index});
    }

    return segments;
}

/**
 * The sentences in `text`.
 *
 * `locale` decides the break rules and is worth passing: the rules differ by language, and the
 * abbreviations that must not end a sentence differ far more. Omitting it uses the runtime's
 * default locale, which is the browser's, which is not necessarily the language being typed.
 */
export function sentences(text: string, locale?: string): TextSegment[] {
    return segment(text, locale, "sentence");
}

/**
 * The words in `text`, punctuation and whitespace omitted.
 *
 * Word segmentation is where a naive split on spaces goes wrong quietly: it counts "don't" as one
 * word and "far-fetched" as one, which is right, but so is "1,5" as one number and CJK text as
 * many words with no spaces at all.
 */
export function words(text: string, locale?: string): TextSegment[] {
    if (!text)
        return [];

    const segmenter = new Intl.Segmenter(locale, {granularity: "word"});

    const segments: TextSegment[] = [];
    for (const {segment: value, index, isWordLike} of segmenter.segment(text)) {
        // `isWordLike` is what separates a word from the punctuation and spacing between words; it
        // is only defined for word granularity, which is why this does not go through `segment`.
        if (!isWordLike)
            continue;

        segments.push({text: value, index});
    }

    return segments;
}
