import {fetchEx} from "../http/utils.js";

// The session token is renewed once a third or less of its lifetime remains, so polling has to be
// frequent enough to land in that window; the default suits a fifteen-minute token. The cookie
// carrying the token is HttpOnly, so its expiry cannot be read here and scheduled against.
const defaultRefreshIntervalMs = 240_000;

export async function refreshSession(
    refreshUrl: URL,
    refreshRequestInit: RequestInit,
    redirectUrl: URL,
    intervalMs: number = defaultRefreshIntervalMs,
) {
    let lastRefresh = 0;

    async function doRefresh() {
        // The 401 is expected rather than exceptional, so the status is inspected here instead of
        // being raised as a BadStatusCodeError; the body is never read. A transport failure still
        // surfaces as a FetchError carrying the request context.
        const {response} = await fetchEx(
            refreshUrl,
            {...refreshRequestInit, skipReadResponseBody: true, skipErrorOnStatusCode: true},
        );

        if (response.status === 401) {
            const redirectUrlCopy = new URL(redirectUrl.toString());
            redirectUrlCopy.searchParams.set("redirect", window.location.href);
            return void (window.location.href = redirectUrlCopy.toString());
        } else if (!response.ok) {
            return;
        }

        lastRefresh = Date.now();
    }

    // Polling is fire-and-forget: a transient failure is retried on the next tick, and an
    // unhandled rejection here would reach addErrorEventListeners as an application error.
    function pollRefresh() {
        doRefresh().catch(error => {
            console.error("An error occurred when refreshing the session: ", error);
        });
    }

    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && Date.now() - lastRefresh >= intervalMs) {
            pollRefresh();
        }
    });

    // Scheduled before the first refresh is awaited: a failure at startup, an offline page load
    // above all, must not leave the page without polling for the rest of its life.
    setInterval(pollRefresh, intervalMs);

    await doRefresh();
}
