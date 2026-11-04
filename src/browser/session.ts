import {fetchEx, setUnauthorizedHandler} from "../http/utils.js";

// The session token is renewed once a third or less of its lifetime remains, so polling has to be
// frequent enough to land in that window; the default suits a fifteen-minute token. The cookie
// carrying the token is HttpOnly, so its expiry cannot be read here and scheduled against.
const defaultRefreshIntervalMs = 240_000;

// A failed refresh is tried again soon rather than at the next poll, minutes away: a laptop woken from
// sleep asks before its network is back, and the page has to know where it stands before it is used.
// Doubling from a second, so that a service that is down is not asked a few times a second.
const defaultRetryDelayMs = 1_000;
const defaultMaxRetryDelayMs = 60_000;

// A refresh is answered in well under a second. One sent as the network went may never be, and
// waiting for the system to give up on it would hold every request that needs it for minutes.
const defaultTimeoutMs = 10_000;

// How long the page waits to be left once it has sent the browser to sign in. Still here after
// that, it was kept -- a page asking whether to leave, answered no -- and has to carry on.
const defaultRedirectGraceMs = 30_000;

export type RefreshOutcome = "ok" | "unauthorized" | "failed";

export interface RefreshSessionOptions {
    // Run when the session is found to have ended, before the browser is sent to sign in; the
    // redirect waits for what it returns to settle. Where a page keeps what it has not saved, and
    // says so before it is left.
    onSessionEnded?: () => Promise<void> | void;
    retryDelayMs?: number;
    maxRetryDelayMs?: number;
    timeoutMs?: number;
    redirectGraceMs?: number;
}

export async function refreshSession(
    refreshUrl: URL,
    refreshRequestInit: RequestInit,
    redirectUrl: URL,
    intervalMs: number = defaultRefreshIntervalMs,
    options: RefreshSessionOptions = {},
) {
    const {
        onSessionEnded,
        retryDelayMs = defaultRetryDelayMs,
        maxRetryDelayMs = defaultMaxRetryDelayMs,
        timeoutMs = defaultTimeoutMs,
        redirectGraceMs = defaultRedirectGraceMs,
    } = options;

    let lastRefresh = 0;
    // One refresh at a time, whoever asks for it: the poll, the page becoming visible, the network
    // coming back, a retry and a refused request can all land together after a sleep.
    let inFlight: Promise<RefreshOutcome> | null = null;
    // The request the refresh in flight is waiting on, and whether the network coming back has asked
    // for it to be sent again: the one sent before may be on a connection that is gone.
    let attempt: AbortController | null = null;
    let superseded = false;
    let retryDelay = retryDelayMs;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // From sending the browser to sign in until the page is found to be still here. Nothing is
    // refreshed meanwhile: the answer is known, and the page is going.
    let redirected = false;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let ending: Promise<void> | null = null;
    // Requests refused while the session was gone, each waiting to be sent again once it is back.
    let waiting: ((retry: boolean) => void)[] = [];

    function releaseWaiting(retry: boolean) {
        const released = waiting;
        waiting = [];
        for (const resolve of released)
            resolve(retry);
    }

    function cancelGrace() {
        if (graceTimer !== null) {
            clearTimeout(graceTimer);
            graceTimer = null;
        }
    }

    // Once at a time: refreshes that find the session gone together end it together.
    function endSession(): Promise<void> {
        ending ??= (async () => {
            // The browser is sent to sign in whatever the page's callback does: a page that cannot be
            // used is not kept because it failed to say goodbye.
            try {
                await onSessionEnded?.();
            } catch (error) {
                console.error("An error occurred when ending the session: ", error);
            }

            const redirectUrlCopy = new URL(redirectUrl.toString());
            redirectUrlCopy.searchParams.set("redirect", window.location.href);
            redirected = true;
            window.location.href = redirectUrlCopy.toString();

            // Kept here, the page carries on: the session is looked at again the next time anything
            // asks, and the requests left waiting are let go of with the 401 they had.
            cancelGrace();
            graceTimer = setTimeout(() => {
                graceTimer = null;
                redirected = false;
                releaseWaiting(false);
            }, redirectGraceMs);
        })().finally(() => {
            ending = null;
        });

        return ending;
    }

    function cancelRetry() {
        if (retryTimer !== null) {
            clearTimeout(retryTimer);
            retryTimer = null;
        }
    }

    function scheduleRetry() {
        // Offline, nothing is tried until the network says it is back: the online event does it.
        if (redirected || retryTimer !== null || navigator.onLine === false)
            return;

        const delay = retryDelay;
        retryDelay = Math.min(retryDelay * 2, maxRetryDelayMs);
        retryTimer = setTimeout(() => {
            retryTimer = null;
            pollRefresh();
        }, delay);
    }

    async function send(): Promise<Response> {
        for (;;) {
            const controller = new AbortController();
            attempt = controller;

            const signals = [controller.signal, AbortSignal.timeout(timeoutMs)];
            if (refreshRequestInit.signal)
                signals.push(refreshRequestInit.signal);

            try {
                // The 401 is expected rather than exceptional, so the status is inspected by the
                // caller instead of being raised as a BadStatusCodeError; the body is never read. A
                // transport failure still surfaces as a FetchError carrying the request context.
                const {response} = await fetchEx(refreshUrl, {
                    ...refreshRequestInit,
                    signal: AbortSignal.any(signals),
                    skipReadResponseBody: true,
                    skipErrorOnStatusCode: true,
                });
                superseded = false;
                return response;
            } catch (error) {
                if (superseded) {
                    superseded = false;
                    continue;
                }
                throw error;
            } finally {
                if (attempt === controller)
                    attempt = null;
            }
        }
    }

    async function doRefresh(): Promise<RefreshOutcome> {
        let response: Response;
        try {
            response = await send();
        } catch (error) {
            scheduleRetry();
            throw error;
        }

        if (response.status === 401) {
            await endSession();
            return "unauthorized";
        } else if (!response.ok) {
            scheduleRetry();
            return "failed";
        }

        lastRefresh = Date.now();
        retryDelay = retryDelayMs;
        cancelRetry();
        releaseWaiting(true);
        return "ok";
    }

    function refresh(): Promise<RefreshOutcome> {
        if (redirected)
            return Promise.resolve("unauthorized");

        if (!inFlight) {
            const started: Promise<RefreshOutcome> = doRefresh().finally(() => {
                if (inFlight === started)
                    inFlight = null;
            });
            inFlight = started;
        }
        return inFlight;
    }

    // Polling is fire-and-forget: a transient failure is retried, and an unhandled rejection here
    // would reach addErrorEventListeners as an application error.
    function pollRefresh() {
        refresh().catch(error => {
            console.error("An error occurred when refreshing the session: ", error);
        });
    }

    // A request refused for an expired token is answered with a refresh rather than an error: sent
    // again once the session is renewed, and, when it cannot be, held while the browser is sent to
    // sign in, as an error shown for it would only be shown beside the sign-in. One that fails for any
    // other reason is the caller's, as it was.
    setUnauthorizedHandler(async () => {
        let outcome: RefreshOutcome;
        try {
            outcome = await refresh();
        } catch {
            return false;
        }

        if (outcome === "unauthorized")
            return new Promise<boolean>(resolve => waiting.push(resolve));
        return outcome === "ok";
    });

    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && Date.now() - lastRefresh >= intervalMs) {
            pollRefresh();
        }
    });

    // Back online, the refresh owed since the network went is made now rather than at the next poll,
    // and one still waiting for an answer on the old network is sent again.
    addEventListener("online", () => {
        cancelRetry();
        retryDelay = retryDelayMs;
        if (attempt) {
            superseded = true;
            attempt.abort();
        } else {
            pollRefresh();
        }
    });

    // A page brought back from the browser's cache -- Back, from the sign-in it was sent to -- is
    // still here, and looks again at where its session stands.
    addEventListener("pageshow", (event: PageTransitionEvent) => {
        if (!event.persisted)
            return;
        cancelGrace();
        redirected = false;
        pollRefresh();
    });

    // Scheduled before the first refresh is awaited: a failure at startup, an offline page load
    // above all, must not leave the page without polling for the rest of its life.
    setInterval(pollRefresh, intervalMs);

    await refresh();
}
