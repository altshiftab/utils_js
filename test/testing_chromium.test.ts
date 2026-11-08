import assert from "node:assert/strict";
import {mkdir, mkdtemp, readdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {after, before, test} from "node:test";

import {Page, serveDirectory, type Served} from "../src/testing/chromium.js";

// The pages are written for the test into a directory of their own, served under a content security
// policy that refuses inline styles, as a page held to one would be.
const policy = "default-src 'self'";

let directory: string;
let served: Served;
let page: Page;

before(async () => {
    // The site is a directory beside a file it must not serve, so that a path out of it has something
    // to reach for.
    directory = await mkdtemp(join(tmpdir(), "chromium-test-"));
    const site = join(directory, "site");
    await mkdir(site);
    await writeFile(join(site, "index.html"), `<!doctype html>
<title>test</title>
<div id="styled" style="color: red">styled</div>
<script type="module" src="/app.js"></script>`);
    await writeFile(join(site, "app.js"), `
console.error("logged by the page");
// Ready only some time after loading, so that being waited for is something to be told apart.
addEventListener("load", () => setTimeout(() => { window.ready = true; }, 200));
setTimeout(() => { throw new Error("thrown by the page"); });`);
    await writeFile(join(directory, "secret.txt"), "not to be served from the site");
    await mkdir(join(site, "sub"));
    served = await serveDirectory(site, {headers: {"content-security-policy": policy}});
    page = await Page.open(`${served.origin}/index.html`, {ready: "window.ready === true"});
}, {timeout: 60_000});

after(async () => {
    await page?.close();
    await served?.close();
    await rm(directory, {recursive: true, force: true});
});

// eventually waits until the condition holds of what has been reported, as the browser reports it
// when it gets to it.
async function eventually(condition: () => boolean, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline)
            return;
        await new Promise(done => setTimeout(done, 50));
    }
}

test("an expression is evaluated in the page, and its value returned", async () => {
    const testCases = [
        {name: "arithmetic", expression: "1 + 1", expected: 2},
        {name: "the document", expression: "document.getElementById('styled').textContent", expected: "styled"},
        {name: "a promise, awaited", expression: "Promise.resolve('resolved')", expected: "resolved"},
        {name: "an object, by value", expression: "({a: [1, 2]})", expected: {a: [1, 2]}},
    ];
    for (const testCase of testCases)
        assert.deepEqual(await page.evaluate(testCase.expression), testCase.expected, testCase.name);

    await assert.rejects(page.evaluate("missing.property"), /missing is not defined/, "an exception is thrown");
});

test("what the page reports going wrong is kept", async () => {
    const testCases = [
        {name: "a console error", pattern: /logged by the page/},
        {name: "an uncaught exception", pattern: /thrown by the page/},
        {name: "the content security policy's refusal", pattern: /Content Security Policy/},
    ];
    await eventually(() => testCases.every(testCase => page.problems.some(problem => testCase.pattern.test(problem))));
    for (const testCase of testCases)
        assert.ok(page.problems.some(problem => testCase.pattern.test(problem)), `${testCase.name}: ${JSON.stringify(page.problems)}`);
});

test("goto loads the page anew, and waitFor gives up at its deadline", async () => {
    await page.evaluate("window.marker = 1");
    await page.goto(`${served.origin}/index.html`, {ready: "window.ready === true"});
    assert.equal(await page.evaluate("window.marker"), undefined, "a page loaded anew");
    assert.equal(await page.evaluate("window.ready"), true, "ready, waited for");

    await assert.rejects(page.waitFor("false", 200), /waited 200 ms for false/, "the deadline");
});

test("the viewport and the colour scheme are the test's to set", async () => {
    await page.resize(500, 700);
    assert.deepEqual(await page.evaluate("[innerWidth, innerHeight]"), [500, 700], "the viewport");

    for (const scheme of ["dark", "light"] as const) {
        await page.emulateColorScheme(scheme);
        assert.equal(await page.evaluate(`matchMedia("(prefers-color-scheme: ${scheme})").matches`), true, scheme);
    }
});

test("the files served are the directory's, with the headers asked for", async () => {
    const testCases = [
        {name: "a page", path: "/index.html", status: 200},
        {name: "a file missing", path: "/missing.html", status: 404},
        // An encoded slash, so that the path reaches the server as it is rather than resolved by the client.
        {name: "a path out of the directory", path: "/..%2fsecret.txt", status: 404},
        {name: "a directory", path: "/sub", status: 404},
        {name: "the directory itself", path: "/", status: 404},
        {name: "a path that does not decode", path: "/%", status: 400},
    ];
    for (const testCase of testCases) {
        // Within a time, so that a request the server never answers fails here rather than hangs.
        const response = await fetch(`${served.origin}${testCase.path}`, {signal: AbortSignal.timeout(5_000)});
        await response.arrayBuffer();
        assert.equal(response.status, testCase.status, testCase.name);
    }
    const response = await fetch(`${served.origin}/index.html`);
    await response.arrayBuffer();
    assert.equal(response.headers.get("content-security-policy"), policy, "the header");
});

test("cookies are set before the page is opened, and what closes with the page is closed", async () => {
    const own = await serveDirectory(join(directory, "site"));
    let closed = false;
    const withCookie = await Page.open(`${own.origin}/index.html`, {
        cookies: [{name: "session", value: "s1", url: own.origin}],
        ready: "window.ready === true",
        close: async () => {
            closed = true;
            await own.close();
        },
    });
    try {
        assert.equal(await withCookie.evaluate("document.cookie"), "session=s1", "the cookie");
    } finally {
        await withCookie.close();
    }
    assert.equal(closed, true, "closed with the page");
    await assert.rejects(fetch(`${own.origin}/index.html`), "the server is gone");
});

// profiles are the browsers' profile directories left in the temporary directory.
async function profiles(): Promise<string[]> {
    return (await readdir(tmpdir())).filter(name => name.startsWith("altshift-chromium-"));
}

test("a browser that cannot be had is an error at once, leaving nothing behind", async () => {
    const testCases = [
        {name: "CHROME_PATH naming nothing", chromePath: join(directory, "missing"), error: /does not exist/},
        {name: "CHROME_PATH naming a directory", chromePath: directory, error: /could not be started/},
    ];
    const original = process.env.CHROME_PATH;
    try {
        for (const testCase of testCases) {
            process.env.CHROME_PATH = testCase.chromePath;
            const before = await profiles();
            let closed = false;
            const started = Date.now();
            await assert.rejects(
                Page.open(`${served.origin}/index.html`, {close: async () => { closed = true; }}),
                testCase.error,
                testCase.name,
            );
            assert.ok(Date.now() - started < 5_000, `${testCase.name}: at once`);
            assert.equal(closed, true, `${testCase.name}: what closes with the page is closed`);
            assert.deepEqual(await profiles(), before, `${testCase.name}: no profile left`);
        }
    } finally {
        if (original === undefined)
            delete process.env.CHROME_PATH;
        else
            process.env.CHROME_PATH = original;
    }
});

test("a page that cannot be reached is an error, and leaves nothing waiting", async () => {
    // A port just given up, so that nothing listens on it.
    const gone = await serveDirectory(directory);
    await gone.close();
    await assert.rejects(Page.open(`${gone.origin}/`, {timeoutMs: 500}), /ERR_CONNECTION_REFUSED/);
    // Longer than the time it was given, so that a wait it left behind would have gone off by now.
    await new Promise(done => setTimeout(done, 800));
});

test("a call waiting on the page is answered once the page is gone", async () => {
    const gone = await Page.open(`${served.origin}/index.html`, {ready: "window.ready === true"});
    const testCases = [
        {name: "evaluate", call: gone.evaluate("new Promise(() => {})")},
        {name: "waitFor, long before its deadline", call: gone.waitFor("new Promise(() => {})", 60_000)},
    ];
    const answered = testCases.map(testCase => assert.rejects(testCase.call, /the page was closed/, testCase.name));
    await gone.close();
    await Promise.all(answered);
    await assert.rejects(gone.evaluate("1"), /the page was closed/, "a call after closing");
});
