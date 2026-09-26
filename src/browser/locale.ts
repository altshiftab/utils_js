// Each language tag followed by its shorter forms, a subtag dropped from the end at a time, as RFC
// 4647 lookup falls back: sv-SE then sv. The shorter forms come straight after the tag they are cut
// from rather than at the end, so a browser preferring sv-SE to en is still answered in Swedish by
// a bundle that has sv. A tag already reached is not tried twice.
export function withFallbacks(languages: readonly string[]): string[] {
    const candidates: string[] = [];

    for (const language of languages) {
        const subtags = language.split("-");
        for (let length = subtags.length; length > 0; length--) {
            const candidate = subtags.slice(0, length).join("-");
            if (candidate !== "" && !candidates.includes(candidate))
                candidates.push(candidate);
        }
    }

    return candidates;
}

// Applies the first of the browser's preferred languages that the bundle carries a translation
// for, each tried with its fallbacks, and reports which one won so the caller can label the
// document with it. Where none of them match, nothing is applied and the source locale stands.
//
// setLocale is handed in rather than reached for. lit-localize's configureLocalization may be
// called only once per page, so each entry point owns that call; passing the result through
// leaves what is worth testing here -- which language wins, and what happens when none does --
// reachable without the generated locale modules, and this package without lit.
export async function applyPreferredLocale(
    setLocale: (locale: string) => Promise<void>,
    languages: readonly string[] = navigator.languages,
): Promise<string | null> {
    for (const locale of withFallbacks(languages)) {
        try {
            await setLocale(locale);
            return locale;
        } catch {
            // Not a locale the bundle was built with. Try the next one rather than giving up on
            // the whole list.
        }
    }

    return null;
}
