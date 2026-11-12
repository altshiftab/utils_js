import {updateWithViewTransition} from "./view_transition.js";

/**
 * What an intercepted navigation was: a link followed (`push`) or a step back or forward through
 * history (`traverse`), and the keys of the history entries it left and reached. A push's entry is
 * made as it commits, so only a traversal knows the key of where it goes.
 */
export interface SpaNavigation {
    navigationType: "push" | "traverse";
    fromKey?: string;
    destinationKey?: string;
}

/**
 * Where a SPA's pages scroll, for a layout whose content scrolls in an element of its own rather
 * than as the document.
 */
export interface SpaRoutingOptions {
    /**
     * The element the pages scroll in. The Navigation API puts the viewport at the top on a push and
     * back where it was on a traversal, but only the viewport: content that scrolls in an element of
     * its own -- a fixed header and side panel around a scrolling section -- would keep that element's
     * position from page to page, so an item opened from far down a list opens far down too. Given
     * it, the router does for this element what the browser does for the viewport.
     */
    scrollContainer?: () => {scrollTop: number; scrollLeft: number} | null | undefined;
}

/**
 * Turns the navigations a SPA answers for into calls of `navigate`, leaving every other navigation
 * to the browser. `handlesUrl` says which destinations are the SPA's; the URL handed to `navigate`
 * is the destination, query string and all, and with it what kind of navigation it was.
 */
export function interceptSpaNavigation(
    handlesUrl: (url: URL) => boolean,
    navigate: (url: URL, navigation: SpaNavigation) => void | Promise<void>,
) {
    // Browsers without the Navigation API (Firefox ESR, older Safari) get full-page navigations instead.
    (window as {navigation?: Navigation}).navigation?.addEventListener("navigate", event => {
        // Left to the browser: navigations that cannot be intercepted (cross-origin or
        // cross-document-only), downloads, fragment scrolling, and form submissions.
        if (!event.canIntercept || event.hashChange || event.downloadRequest !== null || event.formData !== null)
            return;

        // Only handle pushes and history traversals: `replace` is URL state syncing
        // (e.g. filter params) and `reload` should fetch a fresh document.
        if (event.navigationType !== "push" && event.navigationType !== "traverse")
            return;

        const destinationUrl = new URL(event.destination.url);

        // Non-SPA destination
        if (!handlesUrl(destinationUrl))
            return;

        // Navigating to the current URL should neither reload nor re-render.
        if (event.cancelable && destinationUrl.href === location.href)
            return void event.preventDefault();

        const spaNavigation: SpaNavigation = {
            navigationType: event.navigationType,
            fromKey: (window as {navigation?: Navigation}).navigation?.currentEntry?.key || undefined,
            destinationKey: event.destination.key || undefined,
        };

        // The viewport's scrolling is left to intercept(): to the top on push, restored on traverse.
        event.intercept({handler: async () => void await navigate(destinationUrl, spaNavigation)});
    });
}

export function setUpSpaRouting(
    paths: string[],
    getRenderableValue: (name: string) => Promise<any>,
    render: (renderableValue: unknown) => void,
    options: SpaRoutingOptions = {},
) {
    const rootPath = paths.at(0)
    if (!rootPath)
        throw new Error("No root path");

    const readinessBudgetMs = 200;

    async function getPageModule(name: string, path: string): Promise<any> {
        const reloadMarkerKey = `spa-page-import-reload:${path}`;
        try {
            const pageModule = await getRenderableValue(name);
            sessionStorage.removeItem(reloadMarkerKey);
            return pageModule;
        } catch (error) {
            // A failed page import most likely means a deploy replaced the hashed
            // chunks this document references; a reload fetches the fresh document.
            // The marker stops a reload loop when the failure is persistent.
            if (sessionStorage.getItem(reloadMarkerKey) !== null)
                throw error;
            sessionStorage.setItem(reloadMarkerKey, "");
            window.location.reload();
            return new Promise<never>(() => {});
        }
    }

    // Where the scroll container was when each history entry was left, for a traversal back to it.
    const scrollPositions = new Map<string, {top: number; left: number}>();

    // scrollFor puts the scroll container where a navigation leaves it: at the top for a push, and
    // for a traversal where the entry reached was left, or the top where that is not known.
    function scrollFor(navigation: SpaNavigation) {
        const container = options.scrollContainer?.();
        if (!container)
            return;

        const position = navigation.navigationType === "traverse" && navigation.destinationKey !== undefined
            ? scrollPositions.get(navigation.destinationKey)
            : undefined;
        container.scrollTop = position?.top ?? 0;
        container.scrollLeft = position?.left ?? 0;
    }

    async function renderSpa(path: string, transition = true, afterRender?: () => void) {
        const name = path === rootPath
            ? "root"
            : path.split("/").filter(Boolean).join("_").replace(/-/g, "_")
        ;
        // Import before the transition starts; rendering is frozen while the transition callback runs.
        const renderableValue = new (await getPageModule(name, path)).default();

        if (!transition) {
            render(renderableValue);
            return void afterRender?.();
        }

        await updateWithViewTransition(async () => {
            render(renderableValue);

            // Fade to a content-complete page: pages may expose `ready` (initial data rendered);
            // Lit elements expose `updateComplete` (first shadow render). Rendering stays frozen
            // on the old view while this callback runs, so the wait is capped.
            const {ready, updateComplete} = renderableValue as {ready?: unknown; updateComplete?: unknown};
            await Promise.race([
                Promise.allSettled([ready, updateComplete]),
                new Promise(resolve => setTimeout(resolve, readinessBudgetMs)),
            ]);

            // Scrolled once the page is there to scroll, and before the new view is shown.
            afterRender?.();
        });
    }

    // The initial render is not a navigation; a transition would just cross-fade the loading state.
    addEventListener("DOMContentLoaded", () => renderSpa(location.pathname, false));

    interceptSpaNavigation(
        url => paths.includes(url.pathname),
        (url, navigation) => {
            // Taken before the page is replaced, while it is still where the reader left it.
            const container = options.scrollContainer?.();
            if (container && navigation.fromKey !== undefined)
                scrollPositions.set(navigation.fromKey, {top: container.scrollTop, left: container.scrollLeft});

            return renderSpa(url.pathname, true, () => scrollFor(navigation));
        },
    );
}
