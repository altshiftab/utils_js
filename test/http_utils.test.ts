import assert from "node:assert/strict";
import {afterEach, test} from "node:test";

import {BadStatusCodeError, FetchError} from "../src/http/errors.js";
import type {RequestInitEx, UnauthorizedHandler} from "../src/http/types.js";
import {
    fetchEx,
    fetchWithRequest,
    getBadStatusCodeErrorMessage,
    problemDetailFromResponseText,
    setUnauthorizedHandler,
} from "../src/http/utils.js";
import {tick} from "./browser_stubs.js";

type Respond = (request: Request) => Response | Promise<Response>;

let restore: (() => void) | null = null;

afterEach(() => {
    restore?.();
    restore = null;
    setUnauthorizedHandler(null);
});

function installFetch(respond: Respond) {
    const calls: Request[] = [];
    const saved = Object.getOwnPropertyDescriptor(globalThis, "fetch");

    (globalThis as unknown as Record<string, unknown>).fetch = (request: Request) => {
        calls.push(request);
        return Promise.resolve(respond(request));
    };

    restore = () => {
        if (saved) {
            Object.defineProperty(globalThis, "fetch", saved);
        } else {
            delete (globalThis as unknown as Record<string, unknown>).fetch;
        }
    };

    return calls;
}

test("a successful response is returned with its body", async () => {
    const calls = installFetch(() => new Response("hello", {status: 200}));

    const {response, responseText} = await fetchEx("https://example.test/thing");

    assert.equal(response.status, 200);
    assert.equal(responseText, "hello");
    assert.equal(calls[0]!.method, "GET");
});

test("a bad status code throws with the body captured in the context", async () => {
    installFetch(() => new Response("nope", {status: 503}));

    await assert.rejects(fetchEx("https://example.test/thing"), (error: unknown) => {
        assert.ok(error instanceof BadStatusCodeError);
        assert.equal(error.statusCode, 503);
        assert.equal(error.context.responseBody, "nope");
        return true;
    });
});

test("skipErrorOnStatusCode is forwarded", async () => {
    // Regression: fetchEx accepted RequestInitEx but dropped it, so this threw.
    installFetch(() => new Response("nope", {status: 503}));

    const {response} = await fetchEx("https://example.test/thing", {skipErrorOnStatusCode: true});

    assert.equal(response.status, 503);
});

test("skipReadResponseBody is forwarded", async () => {
    const response = new Response("unread", {status: 200});
    installFetch(() => response);

    const result = await fetchEx("https://example.test/thing", {skipReadResponseBody: true});

    assert.equal(result.responseText, "");
    assert.equal(response.bodyUsed, false);
});

test("both flags together leave a failing response to the caller", async () => {
    const response = new Response("unread", {status: 401});
    installFetch(() => response);

    const result = await fetchEx(new URL("https://example.test/thing"), {
        method: "POST",
        skipReadResponseBody: true,
        skipErrorOnStatusCode: true,
    });

    assert.equal(result.response.status, 401);
    assert.equal(response.bodyUsed, false);
});

test("a transport failure becomes a FetchError", async () => {
    installFetch(() => {throw new TypeError("offline");});

    await assert.rejects(fetchEx("https://example.test/thing"), (error: unknown) => {
        assert.ok(error instanceof FetchError);
        assert.ok(error.cause instanceof TypeError);
        return true;
    });
});

test("problem details are recognised only when title and status are present", () => {
    const testCases = [
        {name: "complete", text: '{"title":"Nope","status":403,"detail":"Not allowed"}', expected: true},
        {name: "missing status", text: '{"title":"Nope"}', expected: false},
        {name: "missing title", text: '{"status":403}', expected: false},
        {name: "not json", text: "plain text", expected: false},
        {name: "empty", text: "", expected: false},
    ];

    for (const testCase of testCases)
        assert.equal(problemDetailFromResponseText(testCase.text) !== null, testCase.expected, testCase.name);
});

test("the bad status code message prefers the problem detail", async () => {
    installFetch(() => new Response('{"title":"Nope","status":403,"detail":"Not allowed"}', {status: 403}));

    const error = await fetchEx("https://example.test/thing").catch((error: unknown) => error);
    assert.ok(error instanceof BadStatusCodeError);
    assert.equal(getBadStatusCodeErrorMessage(error), "Not allowed");
});

test("the bad status code message falls back to the raw body, then the error itself", async () => {
    installFetch(() => new Response("something went wrong", {status: 500}));

    const withBody = await fetchEx("https://example.test/thing").catch((error: unknown) => error);
    assert.ok(withBody instanceof BadStatusCodeError);
    assert.equal(getBadStatusCodeErrorMessage(withBody), "something went wrong");

    restore?.();
    installFetch(() => new Response(null, {status: 500}));

    const withoutBody = await fetchEx("https://example.test/thing").catch((error: unknown) => error);
    assert.ok(withoutBody instanceof BadStatusCodeError);
    assert.match(getBadStatusCodeErrorMessage(withoutBody), /bad status code/);
});

/**
 * A fetch that reads each request's body as a real send does, so that a request sent twice must
 * have been cloned before its first send: the original's body is gone by the second.
 */
function installConsumingFetch(statuses: number[]) {
    const bodies: string[] = [];
    const saved = Object.getOwnPropertyDescriptor(globalThis, "fetch");

    (globalThis as unknown as Record<string, unknown>).fetch = async (request: Request) => {
        bodies.push(await request.text());
        const status = statuses[bodies.length - 1] ?? 200;
        return new Response(status === 401 ? "expired" : "done", {status});
    };

    restore = () => {
        if (saved) {
            Object.defineProperty(globalThis, "fetch", saved);
        } else {
            delete (globalThis as unknown as Record<string, unknown>).fetch;
        }
    };

    return bodies;
}

test("a 401 is offered to the unauthorized handler, and the request sent again when it says so", async () => {
    const testCases: {
        name: string;
        statuses: number[];
        answer: boolean | "throws" | null;
        options?: RequestInitEx;
        wantSends: number;
        wantAsked: number;
        wantStatus: number;
        wantThrown: boolean;
    }[] = [
        {name: "renewed, then answered", statuses: [401, 200], answer: true, wantSends: 2, wantAsked: 1, wantStatus: 200, wantThrown: false},
        {name: "not renewed", statuses: [401], answer: false, wantSends: 1, wantAsked: 1, wantStatus: 401, wantThrown: true},
        {name: "a handler that throws is not renewed", statuses: [401], answer: "throws", wantSends: 1, wantAsked: 1, wantStatus: 401, wantThrown: true},
        {name: "refused again after renewing", statuses: [401, 401], answer: true, wantSends: 2, wantAsked: 1, wantStatus: 401, wantThrown: true},
        {name: "no handler set", statuses: [401], answer: null, wantSends: 1, wantAsked: 0, wantStatus: 401, wantThrown: true},
        {name: "another failure", statuses: [403], answer: true, wantSends: 1, wantAsked: 0, wantStatus: 403, wantThrown: true},
        {
            name: "a caller reading the status itself",
            statuses: [401],
            answer: true,
            options: {skipErrorOnStatusCode: true},
            wantSends: 1,
            wantAsked: 0,
            wantStatus: 401,
            wantThrown: false,
        },
        {
            name: "a caller that keeps its 401",
            statuses: [401],
            answer: true,
            options: {skipUnauthorizedRetry: true},
            wantSends: 1,
            wantAsked: 0,
            wantStatus: 401,
            wantThrown: true,
        },
    ];

    for (const testCase of testCases) {
        const bodies = installConsumingFetch(testCase.statuses);

        const asked: Request[] = [];
        if (testCase.answer !== null) {
            const answer = testCase.answer;
            setUnauthorizedHandler(async request => {
                asked.push(request);
                if (answer === "throws")
                    throw new Error("broken handler");
                return answer;
            });
        }

        const body = JSON.stringify({name: "a record"});
        const outcome = await fetchEx("https://example.test/thing", {method: "PUT", body, ...testCase.options})
            .then(result => ({status: result.response.status, thrown: false, responseBody: result.responseText}))
            .catch((error: unknown) => {
                assert.ok(error instanceof BadStatusCodeError, testCase.name);
                return {status: error.statusCode, thrown: true, responseBody: error.context.responseBody};
            });

        assert.equal(bodies.length, testCase.wantSends, testCase.name);
        // What is sent again is the request as it was, body included.
        for (const sent of bodies)
            assert.equal(sent, body, testCase.name);
        assert.equal(asked.length, testCase.wantAsked, testCase.name);
        if (asked.length > 0)
            assert.equal(asked[0]!.url, "https://example.test/thing", testCase.name);
        assert.equal(outcome.status, testCase.wantStatus, testCase.name);
        assert.equal(outcome.thrown, testCase.wantThrown, testCase.name);
        // A 401 that is thrown still says why, read from the response that was refused.
        if (outcome.thrown && outcome.status === 401)
            assert.equal(outcome.responseBody, "expired", testCase.name);

        restore?.();
        restore = null;
        setUnauthorizedHandler(null);
    }
});

test("a handler that never settles leaves the call pending", async () => {
    installConsumingFetch([401]);
    const never: UnauthorizedHandler = () => new Promise(() => {});
    setUnauthorizedHandler(never);

    let settled = false;
    void fetchEx("https://example.test/thing").finally(() => {
        settled = true;
    });
    await tick(4);

    assert.equal(settled, false);
});

test("the refused response is let go of when another takes its place", async () => {
    const responses: Response[] = [];
    const saved = Object.getOwnPropertyDescriptor(globalThis, "fetch");
    (globalThis as unknown as Record<string, unknown>).fetch = async () => {
        const response = new Response(responses.length === 0 ? "expired" : "done", {status: responses.length === 0 ? 401 : 200});
        responses.push(response);
        return response;
    };
    restore = () => {
        if (saved) {
            Object.defineProperty(globalThis, "fetch", saved);
        } else {
            delete (globalThis as unknown as Record<string, unknown>).fetch;
        }
    };
    setUnauthorizedHandler(async () => true);

    await fetchEx("https://example.test/thing");

    assert.equal(responses.length, 2);
    assert.equal(responses[0]!.bodyUsed, true);
});

test("a request whose body is gone already is sent as it was, and fails in the send", async () => {
    installConsumingFetch([401]);
    let asked = 0;
    setUnauthorizedHandler(async () => {
        asked++;
        return true;
    });

    const request = new Request("https://example.test/thing", {method: "PUT", body: "spent"});
    await request.text();

    await assert.rejects(fetchWithRequest(request), FetchError);
    assert.equal(asked, 0);
});
