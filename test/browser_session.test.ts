import assert from "node:assert/strict";
import {afterEach, mock, test} from "node:test";

import {refreshSession} from "../src/browser/session.js";
import {BadStatusCodeError, FetchError} from "../src/http/errors.js";
import {fetchEx, setUnauthorizedHandler} from "../src/http/utils.js";
import {installStubs, tick, type Stubs} from "./browser_stubs.js";

let stubs: Stubs | null = null;

afterEach(() => {
    stubs?.restore();
    stubs = null;
    mock.restoreAll();
    setUnauthorizedHandler(null);
});

const refreshUrl = new URL("https://example.test/api/session/refresh");
const redirectUrl = new URL("https://example.test/login");

test("a successful refresh leaves the location alone and schedules polling", async () => {
    stubs = installStubs({respond: () => new Response(null, {status: 200})});

    await refreshSession(refreshUrl, {method: "POST"}, redirectUrl, 60_000);

    assert.equal(stubs.fetchCalls.length, 1);

    // fetchEx builds a Request rather than passing url and init through.
    const request = stubs.fetchCalls[0]!.input as Request;
    assert.equal(request.url, refreshUrl.toString());
    assert.equal(request.method, "POST");

    assert.deepEqual(stubs.location.hrefAssignments, []);
    assert.deepEqual(stubs.intervals.map(interval => interval.ms), [60_000]);
});

test("the refresh response body is left unread", async () => {
    const response = new Response("irrelevant", {status: 200});
    stubs = installStubs({respond: () => response});

    await refreshSession(refreshUrl, {}, redirectUrl, 60_000);

    assert.equal(response.bodyUsed, false);
});

test("a transport failure surfaces as a FetchError carrying the request", async () => {
    stubs = installStubs({respond: () => {throw new TypeError("offline");}});

    await assert.rejects(refreshSession(refreshUrl, {}, redirectUrl, 60_000), (error: unknown) => {
        assert.ok(error instanceof FetchError);
        assert.equal(error.context.request.url, refreshUrl.toString());
        assert.ok(error.cause instanceof TypeError);
        return true;
    });
});

test("401 redirects, carrying the current location back", async () => {
    stubs = installStubs({href: "https://example.test/reports?page=2", respond: () => new Response(null, {status: 401})});

    await refreshSession(refreshUrl, {}, redirectUrl);

    assert.equal(stubs.location.hrefAssignments.length, 1);

    const assigned = new URL(stubs.location.hrefAssignments[0]!);
    assert.equal(assigned.origin + assigned.pathname, "https://example.test/login");
    assert.equal(assigned.searchParams.get("redirect"), "https://example.test/reports?page=2");
});

test("a non-401 failure neither redirects nor advances the refresh time", async () => {
    stubs = installStubs({respond: () => new Response(null, {status: 503})});

    await refreshSession(refreshUrl, {}, redirectUrl, 60_000);
    assert.deepEqual(stubs.location.hrefAssignments, []);

    // The failed attempt left `lastRefresh` at zero, so becoming visible refreshes immediately.
    await stubs.dispatchDocument("visibilitychange");
    assert.equal(stubs.fetchCalls.length, 2);
});

test("becoming visible refreshes only once the interval has elapsed", async () => {
    stubs = installStubs({respond: () => new Response(null, {status: 200})});

    await refreshSession(refreshUrl, {}, redirectUrl, 60_000);
    assert.equal(stubs.fetchCalls.length, 1);

    // Too soon after the initial refresh.
    stubs.now += 59_000;
    await stubs.dispatchDocument("visibilitychange");
    assert.equal(stubs.fetchCalls.length, 1);

    stubs.now += 1_000;
    await stubs.dispatchDocument("visibilitychange");
    assert.equal(stubs.fetchCalls.length, 2);
});

test("a hidden document does not refresh", async () => {
    stubs = installStubs({respond: () => new Response(null, {status: 200})});

    await refreshSession(refreshUrl, {}, redirectUrl, 60_000);

    stubs.visibilityState = "hidden";
    stubs.now += 600_000;
    await stubs.dispatchDocument("visibilitychange");

    assert.equal(stubs.fetchCalls.length, 1);
});

test("the scheduled poll refreshes", async () => {
    stubs = installStubs({respond: () => new Response(null, {status: 200})});

    await refreshSession(refreshUrl, {}, redirectUrl, 60_000);
    await stubs.intervals[0]!.callback();

    assert.equal(stubs.fetchCalls.length, 2);
});

/** Succeeds until `failing` is flipped, so that startup can be got past before a failure. */
function installFlakyStubs() {
    const state = {failing: false};
    const installed = installStubs({
        respond: () => {
            if (state.failing)
                throw new TypeError("offline");
            return new Response(null, {status: 200});
        },
    });

    return {state, stubs: installed};
}

test("a failing scheduled poll is logged rather than left unhandled", async () => {
    const flaky = installFlakyStubs();
    stubs = flaky.stubs;
    const errorLog = mock.method(console, "error", () => {});

    await refreshSession(refreshUrl, {}, redirectUrl, 60_000);

    flaky.state.failing = true;
    // The interval callback returns void; without the catch this rejection would be unhandled.
    await stubs.intervals[0]!.callback();
    await tick();

    assert.equal(stubs.fetchCalls.length, 2);
    assert.equal(errorLog.mock.callCount(), 1);
    assert.ok(errorLog.mock.calls[0]!.arguments[1] instanceof FetchError);
});

test("a failing visibility refresh is logged rather than left unhandled", async () => {
    const flaky = installFlakyStubs();
    stubs = flaky.stubs;
    const errorLog = mock.method(console, "error", () => {});

    await refreshSession(refreshUrl, {}, redirectUrl, 60_000);

    flaky.state.failing = true;
    stubs.now += 60_000;
    await stubs.dispatchDocument("visibilitychange");
    await tick();

    assert.equal(stubs.fetchCalls.length, 2);
    assert.equal(errorLog.mock.callCount(), 1);
});

test("polling is scheduled even when the first refresh fails", async () => {
    const flaky = installFlakyStubs();
    stubs = flaky.stubs;
    flaky.state.failing = true;
    mock.method(console, "error", () => {});

    // The caller still sees the startup failure.
    await assert.rejects(refreshSession(refreshUrl, {}, redirectUrl, 60_000), FetchError);

    // An offline page load must not disable session refresh for the life of the page.
    assert.equal(stubs.intervals.length, 1);

    flaky.state.failing = false;
    await stubs.intervals[0]!.callback();
    await tick();

    assert.equal(stubs.fetchCalls.length, 2);
    assert.deepEqual(stubs.location.hrefAssignments, []);
});

test("a failing poll does not stop later polls from succeeding", async () => {
    const flaky = installFlakyStubs();
    stubs = flaky.stubs;
    mock.method(console, "error", () => {});

    await refreshSession(refreshUrl, {}, redirectUrl, 60_000);

    flaky.state.failing = true;
    await stubs.intervals[0]!.callback();
    await tick();

    flaky.state.failing = false;
    stubs.now += 60_000;
    await stubs.intervals[0]!.callback();
    await tick();

    assert.equal(stubs.fetchCalls.length, 3);
    // The successful poll advanced lastRefresh, so becoming visible now is a no-op.
    await stubs.dispatchDocument("visibilitychange");
    assert.equal(stubs.fetchCalls.length, 3);
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(r => {
        resolve = r;
    });
    return {promise, resolve};
}

function isRefresh(input: unknown): boolean {
    return (input as Request).url === refreshUrl.toString();
}

test("refreshes asked for together are made once", async () => {
    const response = deferred<Response>();
    stubs = installStubs({respond: () => response.promise});

    const started = refreshSession(refreshUrl, {}, redirectUrl, 60_000);
    await tick();

    // The poll, the page becoming visible and the network coming back, all while the first is out.
    await stubs.intervals[0]!.callback();
    await stubs.dispatchDocument("visibilitychange");
    await stubs.dispatch("online");

    response.resolve(new Response(null, {status: 200}));
    await started;

    assert.equal(stubs.fetchCalls.length, 1);
});

test("a failed refresh is tried again sooner each time, up to the cap, and from the start after a success", async () => {
    const state = {failing: true};
    stubs = installStubs({
        respond: () => {
            if (state.failing)
                throw new TypeError("offline");
            return new Response(null, {status: 200});
        },
    });
    mock.method(console, "error", () => {});

    await assert.rejects(
        refreshSession(refreshUrl, {}, redirectUrl, 60_000, {retryDelayMs: 1_000, maxRetryDelayMs: 4_000}),
        FetchError,
    );

    // Each retry that fails schedules the next, doubling, and no more than one at a time.
    for (let i = 0; i < 3; i++) {
        await stubs.timeouts.at(-1)!.callback();
        await tick();
    }
    assert.deepEqual(stubs.timeouts.map(timeout => timeout.ms), [1_000, 2_000, 4_000, 4_000]);
    assert.equal(stubs.fetchCalls.length, 4);

    state.failing = false;
    await stubs.timeouts.at(-1)!.callback();
    await tick();
    assert.equal(stubs.fetchCalls.length, 5);
    assert.equal(stubs.timeouts.length, 4);

    // A failure after the success starts again from the first delay.
    state.failing = true;
    await stubs.intervals[0]!.callback();
    await tick();
    assert.equal(stubs.timeouts.at(-1)!.ms, 1_000);
});

test("a refused refresh that is not a 401 is tried again too", async () => {
    stubs = installStubs({respond: () => new Response(null, {status: 503})});

    await refreshSession(refreshUrl, {}, redirectUrl, 60_000);

    assert.deepEqual(stubs.timeouts.map(timeout => timeout.ms), [1_000]);
    assert.deepEqual(stubs.location.hrefAssignments, []);
});

test("offline, nothing is tried until the network is back, and then at once", async () => {
    const state = {failing: true};
    stubs = installStubs({
        onLine: false,
        respond: () => {
            if (state.failing)
                throw new TypeError("offline");
            return new Response(null, {status: 200});
        },
    });
    mock.method(console, "error", () => {});

    await assert.rejects(refreshSession(refreshUrl, {}, redirectUrl, 60_000), FetchError);
    assert.equal(stubs.timeouts.length, 0);

    stubs.onLine = true;
    state.failing = false;
    await stubs.dispatch("online");
    await tick();

    assert.equal(stubs.fetchCalls.length, 2);
    assert.deepEqual(stubs.location.hrefAssignments, []);
});

test("coming back online cancels the retry it makes needless", async () => {
    const state = {failing: true};
    stubs = installStubs({
        respond: () => {
            if (state.failing)
                throw new TypeError("offline");
            return new Response(null, {status: 200});
        },
    });
    mock.method(console, "error", () => {});

    await assert.rejects(refreshSession(refreshUrl, {}, redirectUrl, 60_000), FetchError);
    assert.equal(stubs.timeouts.length, 1);

    state.failing = false;
    await stubs.dispatch("online");
    await tick();

    assert.equal(stubs.timeouts[0]!.cleared, true);
    assert.equal(stubs.fetchCalls.length, 2);
});

test("the page is told the session ended before the browser is sent to sign in", async () => {
    const testCases = [
        {name: "a callback that settles", throws: false},
        // The page cannot stop the redirect by failing: it cannot be used either way.
        {name: "a callback that throws", throws: true},
    ];

    for (const testCase of testCases) {
        stubs = installStubs({respond: () => new Response(null, {status: 401})});
        const errorLog = mock.method(console, "error", () => {});

        const told = deferred<void>();
        let calls = 0;
        const started = refreshSession(refreshUrl, {}, redirectUrl, 60_000, {
            onSessionEnded: async () => {
                calls++;
                await told.promise;
                if (testCase.throws)
                    throw new Error("the page broke");
            },
        });
        await tick();

        assert.equal(calls, 1, testCase.name);
        assert.deepEqual(stubs.location.hrefAssignments, [], testCase.name);

        told.resolve();
        await started;

        assert.equal(stubs.location.hrefAssignments.length, 1, testCase.name);
        assert.equal(errorLog.mock.callCount(), testCase.throws ? 1 : 0, testCase.name);

        stubs.restore();
        stubs = null;
        mock.restoreAll();
    }
});

test("a session ends once, and is not refreshed while the browser is leaving", async () => {
    stubs = installStubs({respond: () => new Response(null, {status: 401})});
    let calls = 0;

    await refreshSession(refreshUrl, {}, redirectUrl, 60_000, {onSessionEnded: () => void calls++});

    stubs.now += 60_000;
    await stubs.intervals[0]!.callback();
    await stubs.dispatchDocument("visibilitychange");
    await stubs.dispatch("online");
    await tick();

    assert.equal(stubs.fetchCalls.length, 1);
    assert.equal(calls, 1);
    assert.equal(stubs.location.hrefAssignments.length, 1);
});

test("a request refused for an expired token is sent again once the session is renewed", async () => {
    const apiStatuses = [401, 200];
    stubs = installStubs({
        respond: call => isRefresh(call.input)
            ? new Response(null, {status: 200})
            : new Response("answered", {status: apiStatuses.shift() ?? 500}),
    });

    await refreshSession(refreshUrl, {}, redirectUrl, 60_000);

    const {response, responseText} = await fetchEx("https://example.test/api/accounts");

    assert.equal(response.status, 200);
    assert.equal(responseText, "answered");
    assert.deepEqual(
        stubs.fetchCalls.map(call => isRefresh(call.input) ? "refresh" : "api"),
        ["refresh", "api", "refresh", "api"],
    );
    assert.deepEqual(stubs.location.hrefAssignments, []);
});

test("a request refused once the session is gone waits for the sign-in instead of failing", async () => {
    const refreshStatuses = [200, 401];
    stubs = installStubs({
        respond: call => isRefresh(call.input)
            ? new Response(null, {status: refreshStatuses.shift() ?? 401})
            : new Response(null, {status: 401}),
    });
    let ended = 0;

    await refreshSession(refreshUrl, {}, redirectUrl, 60_000, {onSessionEnded: () => void ended++});

    let settled = false;
    void fetchEx("https://example.test/api/accounts").finally(() => {
        settled = true;
    });
    await tick(4);

    assert.equal(settled, false);
    assert.equal(ended, 1);
    assert.equal(stubs.location.hrefAssignments.length, 1);

    // A request refused after the session ended waits as well, without another refresh.
    let laterSettled = false;
    void fetchEx("https://example.test/api/customers").finally(() => {
        laterSettled = true;
    });
    await tick(4);

    assert.equal(laterSettled, false);
    assert.equal(stubs.fetchCalls.filter(call => isRefresh(call.input)).length, 2);
});

test("a request refused while the refresh cannot be made fails as it did", async () => {
    const state = {refreshFailing: false};
    stubs = installStubs({
        respond: call => {
            if (!isRefresh(call.input))
                return new Response("expired", {status: 401});
            if (state.refreshFailing)
                throw new TypeError("offline");
            return new Response(null, {status: 200});
        },
    });
    mock.method(console, "error", () => {});

    await refreshSession(refreshUrl, {}, redirectUrl, 60_000);
    state.refreshFailing = true;

    await assert.rejects(fetchEx("https://example.test/api/accounts"), (error: unknown) => {
        assert.ok(error instanceof BadStatusCodeError);
        assert.equal(error.statusCode, 401);
        return true;
    });
    assert.deepEqual(stubs.location.hrefAssignments, []);
});

/** A refresh that is answered only when told, and fails when its request is aborted. */
function stallingRefresh() {
    const answers: ((response: Response) => void)[] = [];
    const respond = (call: {input: unknown}) => new Promise<Response>((resolve, reject) => {
        const signal = (call.input as Request).signal;
        signal.addEventListener("abort", () => reject(signal.reason));
        answers.push(resolve);
    });
    return {answers, respond};
}

test("a page kept when it was sent to sign in carries on after a while", async () => {
    const refreshStatuses = [200, 401, 401];
    stubs = installStubs({
        respond: call => isRefresh(call.input)
            ? new Response(null, {status: refreshStatuses.shift() ?? 401})
            : new Response("expired", {status: 401}),
    });
    let ended = 0;

    await refreshSession(refreshUrl, {}, redirectUrl, 60_000, {onSessionEnded: () => void ended++, redirectGraceMs: 30_000});

    // Read rather than awaited, so that a request left waiting fails the test instead of hanging it.
    let refused: unknown = "waiting";
    void fetchEx("https://example.test/api/accounts").then(
        () => {
            refused = "answered";
        },
        (error: unknown) => {
            refused = error instanceof BadStatusCodeError ? error.statusCode : "other";
        },
    );
    await tick(4);
    assert.equal(refused, "waiting");
    assert.equal(ended, 1);
    assert.equal(stubs.location.hrefAssignments.length, 1);

    // The browser did not leave: a page that asked whether to, answered no. The request held for the
    // sign-in is let go of with its 401, and the session is looked at again when next asked.
    const grace = stubs.timeouts.find(timeout => timeout.ms === 30_000)!;
    await grace.callback();
    await tick(4);
    assert.equal(refused, 401);

    await stubs.intervals[0]!.callback();
    await tick();
    assert.equal(stubs.fetchCalls.filter(call => isRefresh(call.input)).length, 3);
    assert.equal(ended, 2);
    assert.equal(stubs.location.hrefAssignments.length, 2);
});

test("a page brought back from the cache looks at its session again, and sends what waited", async () => {
    const refreshStatuses = [200, 401, 200];
    const apiStatuses = [401, 200];
    stubs = installStubs({
        respond: call => isRefresh(call.input)
            ? new Response(null, {status: refreshStatuses.shift() ?? 500})
            : new Response("answered", {status: apiStatuses.shift() ?? 500}),
    });

    await refreshSession(refreshUrl, {}, redirectUrl, 60_000);

    let held: unknown = "waiting";
    void fetchEx("https://example.test/api/accounts").then(({responseText}) => {
        held = responseText;
    });
    await tick(4);
    assert.equal(held, "waiting");
    assert.equal(stubs.location.hrefAssignments.length, 1);

    // Back from the sign-in, after signing in elsewhere meanwhile: the session is there again.
    await stubs.dispatch("pageshow", {persisted: true});
    await tick(4);

    assert.equal(held, "answered");
    assert.equal(stubs.location.hrefAssignments.length, 1);
});

test("a page shown afresh rather than from the cache does not refresh for it", async () => {
    stubs = installStubs({respond: () => new Response(null, {status: 200})});

    await refreshSession(refreshUrl, {}, redirectUrl, 60_000);
    await stubs.dispatch("pageshow", {persisted: false});

    assert.equal(stubs.fetchCalls.length, 1);
});

test("coming back online sends again a refresh still waiting on the old network", async () => {
    const stalled = stallingRefresh();
    stubs = installStubs({respond: stalled.respond});

    const started = refreshSession(refreshUrl, {}, redirectUrl, 60_000);
    await tick();
    assert.equal(stubs.fetchCalls.length, 1);

    await stubs.dispatch("online");
    await tick();
    assert.equal(stubs.fetchCalls.length, 2);

    // Answered on the new network, the refresh that was asked for succeeds, and nothing is retried.
    stalled.answers[1]!(new Response(null, {status: 200}));
    await started;

    assert.equal(stubs.timeouts.length, 0);
    assert.deepEqual(stubs.location.hrefAssignments, []);
});

test("a refresh that is not answered in time fails, and is tried again", async () => {
    const stalled = stallingRefresh();
    stubs = installStubs({respond: stalled.respond});

    await assert.rejects(refreshSession(refreshUrl, {}, redirectUrl, 60_000, {timeoutMs: 20}), FetchError);

    assert.deepEqual(stubs.timeouts.map(timeout => timeout.ms), [1_000]);
});

test("a request refused while the refresh is refused for another reason fails as it did", async () => {
    stubs = installStubs({
        respond: call => isRefresh(call.input)
            ? new Response(null, {status: stubs!.fetchCalls.length === 1 ? 200 : 503})
            : new Response("expired", {status: 401}),
    });

    await refreshSession(refreshUrl, {}, redirectUrl, 60_000);

    await assert.rejects(fetchEx("https://example.test/api/accounts"), (error: unknown) => {
        assert.ok(error instanceof BadStatusCodeError);
        assert.equal(error.statusCode, 401);
        return true;
    });
});

test("a refresh that succeeds clears the retry another one left", async () => {
    const state = {failing: true};
    stubs = installStubs({
        respond: () => {
            if (state.failing)
                throw new TypeError("offline");
            return new Response(null, {status: 200});
        },
    });
    mock.method(console, "error", () => {});

    await assert.rejects(refreshSession(refreshUrl, {}, redirectUrl, 60_000), FetchError);
    assert.equal(stubs.timeouts[0]!.cleared, false);

    state.failing = false;
    await stubs.dispatchDocument("visibilitychange");
    await tick();

    assert.equal(stubs.timeouts[0]!.cleared, true);
});

test("coming back online starts the delays over", async () => {
    stubs = installStubs({respond: () => {throw new TypeError("offline");}});
    mock.method(console, "error", () => {});

    await assert.rejects(refreshSession(refreshUrl, {}, redirectUrl, 60_000), FetchError);
    await stubs.timeouts.at(-1)!.callback();
    await tick();
    assert.deepEqual(stubs.timeouts.map(timeout => timeout.ms), [1_000, 2_000]);

    await stubs.dispatch("online");
    await tick();

    assert.equal(stubs.timeouts.at(-1)!.ms, 1_000);
});
