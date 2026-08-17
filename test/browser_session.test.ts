import assert from "node:assert/strict";
import {afterEach, mock, test} from "node:test";

import {refreshSession} from "../src/browser/session.js";
import {FetchError} from "../src/http/errors.js";
import {installStubs, tick, type Stubs} from "./browser_stubs.js";

let stubs: Stubs | null = null;

afterEach(() => {
    stubs?.restore();
    stubs = null;
    mock.restoreAll();
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
