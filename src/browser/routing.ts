import {updateWithViewTransition} from "./view_transition.js";

/**
 * Turns the navigations a SPA answers for into calls of `navigate`, leaving every other navigation
 * to the browser. `handlesUrl` says which destinations are the SPA's; the URL handed to `navigate`
 * is the destination, query string and all.
 */
export function interceptSpaNavigation(
    handlesUrl: (url: URL) => boolean,
    navigate: (url: URL) => void | Promise<void>,
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

        // Scrolling is left to intercept(): to the top on push, restored on traverse.
        event.intercept({handler: async () => void await navigate(destinationUrl)});
    });
}

export function setUpSpaRouting(
    paths: string[],
    getRenderableValue: (name: string) => Promise<any>,
    render: (renderableValue: unknown) => void,
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

    async function renderSpa(path: string, transition = true) {
        const name = path === rootPath
            ? "root"
            : path.split("/").filter(Boolean).join("_").replace(/-/g, "_")
        ;
        // Import before the transition starts; rendering is frozen while the transition callback runs.
        const renderableValue = new (await getPageModule(name, path)).default();

        if (!transition)
            return void render(renderableValue);

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
        });
    }

    // The initial render is not a navigation; a transition would just cross-fade the loading state.
    addEventListener("DOMContentLoaded", () => renderSpa(location.pathname, false));

    interceptSpaNavigation(
        url => paths.includes(url.pathname),
        url => renderSpa(url.pathname),
    );
}
