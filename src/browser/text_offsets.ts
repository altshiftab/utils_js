/**
 * The arithmetic behind putting something back where it was found: where a text occurs in a page
 * read as one string, and which segment an offset into that string falls in.
 *
 * Kept apart from the walking of the document, which needs a browser to be tested in. This is the
 * half where an off-by-one moves a highlight or underlines the wrong word, and it is worth pinning
 * down on its own.
 */

/**
 * Every occurrence of `substring` in `text`, overlapping ones included.
 *
 * All of them, rather than the first, because the caller is choosing between candidates: a
 * sentence that appears twice on a page has to be matched against the path and offsets it was
 * found at, and taking `indexOf` alone would silently pick the wrong instance.
 */
export function* allIndicesOfSubstring(text: string, substring: string): Generator<number> {
    // A search for nothing occurs nowhere rather than everywhere -- and would not terminate, the
    // empty string being found at every position.
    if (!substring)
        return;

    let index = text.indexOf(substring);
    while (index !== -1) {
        yield index;
        index = text.indexOf(substring, index + 1);
    }
}

/**
 * Which segment an offset falls in, given where each segment begins.
 *
 * An offset inside a segment falls to the one it began in; an offset before the first segment
 * belongs to none, which is -1. `segmentOffsets` must be ascending, as it is when it comes from
 * segmenting a string in order.
 */
export function segmentIndexAt(segmentOffsets: number[], target: number): number {
    let low = 0;
    let high = segmentOffsets.length - 1;
    let result = -1;

    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const midValue = segmentOffsets[mid];

        if (midValue === target) {
            return mid;
        } else if (midValue < target) {
            low = mid + 1;
            result = mid;
        } else {
            high = mid - 1;
        }
    }

    return result;
}
