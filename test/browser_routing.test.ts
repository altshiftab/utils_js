import assert from "node:assert/strict";
import {afterEach, test} from "node:test";

import {interceptSpaNavigation, setUpSpaRouting} from "../src/browser/routing.js";
import {installStubs, tick, type Stubs} from "./browser_stubs.js";

let stubs: Stubs | null = null;

afterEach(() => {
    stubs?.restore();
    stubs = null;
});

const paths = ["/", "/reports", "/reports/monthly-summary"];

interface Harness {
    requested: string[];
    rendered: unknown[];
    fail: boolean;
}

function setUp(options: {href?: string; navigation?: boolean; viewTransitions?: boolean} = {}) {
    stubs = installStubs({viewTransitions: true, ...options});

    const harness: Harness = {requested: [], rendered: [], fail: false};

    setUpSpaRouting(
        paths,
        async name => {
            harness.requested.push(name);
            if (harness.fail)
                throw new Error("chunk gone");
            return {default: class Page {constructor() {}}};
        },
        renderableValue => void harness.rendered.push(renderableValue),
    );

    return harness;
}

function navigateEvent(url: string, overrides: Record<string, unknown> = {}) {
    const intercepted: Promise<unknown>[] = [];
    const event = {
        canIntercept: true,
        hashChange: false,
        downloadRequest: null,
        formData: null,
        navigationType: "push",
        cancelable: true,
        destination: {url},
        preventDefaultCount: 0,
        intercepted,
        preventDefault() {
            event.preventDefaultCount++;
        },
        intercept({handler}: {handler: () => Promise<unknown>}) {
            intercepted.push(handler());
        },
        ...overrides,
    };

    return event;
}

test("an empty path list is rejected", () => {
    stubs = installStubs();
    assert.throws(() => setUpSpaRouting([], async () => ({default: class {}}), () => {}), /No root path/);
});

test("the initial render resolves the page name from the path", async () => {
    const testCases = [
        {name: "root", href: "https://example.test/", expected: "root"},
        {name: "single segment", href: "https://example.test/reports", expected: "reports"},
        {name: "hyphens and depth", href: "https://example.test/reports/monthly-summary", expected: "reports_monthly_summary"},
    ];

    for (const testCase of testCases) {
        const harness = setUp({href: testCase.href});

        await stubs!.dispatch("DOMContentLoaded");

        assert.deepEqual(harness.requested, [testCase.expected], testCase.name);
        assert.equal(harness.rendered.length, 1, testCase.name);
        // The first paint is not a navigation, so it is not wrapped in a transition.
        assert.equal(stubs!.transitionCount, 0, testCase.name);

        stubs!.restore();
        stubs = null;
    }
});

test("a navigation to a known path renders with a transition", async () => {
    const harness = setUp({navigation: true});

    const event = navigateEvent("https://example.test/reports");
    await stubs!.dispatchNavigate(event);
    await Promise.all(event.intercepted);

    assert.deepEqual(harness.requested, ["reports"]);
    assert.equal(harness.rendered.length, 1);
    assert.equal(stubs!.transitionCount, 1);
});

test("navigations left to the browser are not intercepted", async () => {
    const testCases = [
        {name: "not interceptable", overrides: {canIntercept: false}},
        {name: "fragment", overrides: {hashChange: true}},
        {name: "download", overrides: {downloadRequest: "report.pdf"}},
        {name: "form submission", overrides: {formData: new FormData()}},
        {name: "replace", overrides: {navigationType: "replace"}},
        {name: "reload", overrides: {navigationType: "reload"}},
    ];

    for (const testCase of testCases) {
        const harness = setUp({navigation: true});

        const event = navigateEvent("https://example.test/reports", testCase.overrides);
        await stubs!.dispatchNavigate(event);

        assert.deepEqual(harness.requested, [], testCase.name);
        assert.equal(event.intercepted.length, 0, testCase.name);

        stubs!.restore();
        stubs = null;
    }
});

test("a path outside the SPA is left to the browser", async () => {
    const harness = setUp({navigation: true});

    const event = navigateEvent("https://example.test/docs/manual.pdf");
    await stubs!.dispatchNavigate(event);

    assert.deepEqual(harness.requested, []);
    assert.equal(event.intercepted.length, 0);
});

test("navigating to the current URL is cancelled rather than re-rendered", async () => {
    const harness = setUp({href: "https://example.test/reports", navigation: true});

    const event = navigateEvent("https://example.test/reports");
    await stubs!.dispatchNavigate(event);

    assert.equal(event.preventDefaultCount, 1);
    assert.equal(event.intercepted.length, 0);
    assert.deepEqual(harness.requested, []);
});

test("a failed page import reloads once and does not loop", async () => {
    const harness = setUp({href: "https://example.test/reports"});
    harness.fail = true;

    // The reload path never settles its promise, so that nothing renders into a document that is
    // about to be replaced; racing a tick keeps the assertions from waiting on it forever.
    await Promise.race([stubs!.dispatch("DOMContentLoaded"), tick()]);

    assert.equal(stubs!.location.reloadCount, 1);
    assert.equal(harness.rendered.length, 0);
    // The marker survives the reload, so the retry after it propagates instead of reloading again.
    assert.equal(stubs!.sessionStorageData.get("spa-page-import-reload:/reports"), "");

    await assert.rejects(stubs!.dispatch("DOMContentLoaded"), /chunk gone/);
    assert.equal(stubs!.location.reloadCount, 1);
});

test("an intercepted navigation hands the destination to the app, query string and all", async () => {
    stubs = installStubs({navigation: true});
    const navigated: string[] = [];

    interceptSpaNavigation(url => url.pathname === "/unread", url => void navigated.push(url.href));

    const event = navigateEvent("https://example.test/unread?feed=abc");
    await stubs.dispatchNavigate(event);
    await Promise.all(event.intercepted);

    assert.deepEqual(navigated, ["https://example.test/unread?feed=abc"]);
});

test("navigations the app does not answer for are left to the browser", async () => {
    const testCases = [
        {name: "not interceptable", url: "https://example.test/unread", overrides: {canIntercept: false}},
        {name: "fragment", url: "https://example.test/unread", overrides: {hashChange: true}},
        {name: "download", url: "https://example.test/unread", overrides: {downloadRequest: "report.pdf"}},
        {name: "form submission", url: "https://example.test/unread", overrides: {formData: new FormData()}},
        {name: "replace", url: "https://example.test/unread", overrides: {navigationType: "replace"}},
        {name: "reload", url: "https://example.test/unread", overrides: {navigationType: "reload"}},
        {name: "unhandled destination", url: "https://example.test/docs/manual.pdf", overrides: {}},
    ];

    for (const testCase of testCases) {
        stubs = installStubs({navigation: true});
        const navigated: string[] = [];

        interceptSpaNavigation(url => url.pathname === "/unread", url => void navigated.push(url.href));

        const event = navigateEvent(testCase.url, testCase.overrides);
        await stubs.dispatchNavigate(event);

        assert.deepEqual(navigated, [], testCase.name);
        assert.equal(event.intercepted.length, 0, testCase.name);

        stubs.restore();
        stubs = null;
    }
});

test("an intercepted navigation to the current URL is cancelled rather than re-applied", async () => {
    stubs = installStubs({href: "https://example.test/unread", navigation: true});
    const navigated: string[] = [];

    interceptSpaNavigation(() => true, url => void navigated.push(url.href));

    const event = navigateEvent("https://example.test/unread");
    await stubs.dispatchNavigate(event);

    assert.equal(event.preventDefaultCount, 1);
    assert.equal(event.intercepted.length, 0);
    assert.deepEqual(navigated, []);
});

test("a successful import clears an earlier reload marker", async () => {
    const harness = setUp({href: "https://example.test/reports"});
    stubs!.sessionStorageData.set("spa-page-import-reload:/reports", "");

    await stubs!.dispatch("DOMContentLoaded");

    assert.equal(harness.rendered.length, 1);
    assert.equal(stubs!.sessionStorageData.has("spa-page-import-reload:/reports"), false);
});
