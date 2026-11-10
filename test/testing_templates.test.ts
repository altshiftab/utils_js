import assert from "node:assert/strict";
import {test} from "node:test";

import {html, LitElement, nothing} from "lit";
import {keyed} from "lit/directives/keyed.js";
import {live} from "lit/directives/live.js";
import {createRef, ref} from "lit/directives/ref.js";
import {repeat} from "lit/directives/repeat.js";
import {styleMap} from "lit/directives/style-map.js";

import {rendered, renderedTemplate, withFields} from "../src/testing/templates.js";

// A component whose template is the one handed it, as a test needs to read one of its own making.
class Host extends LitElement {
    template: unknown = nothing;
    calls: {self: unknown, event: Event}[] = [];

    onClick(event: Event): void {
        this.calls.push({self: this, event});
    }

    render(): unknown {
        return this.template;
    }
}

function host(template: (host: Host) => unknown): Host {
    const subject = new Host();
    subject.template = template(subject);
    return subject;
}

test("the markup a template renders", () => {
    const testCases = [
        {name: "text and an attribute", value: html`<p class=${"note"}>${"a & <b>"}</p>`, want: `<p class="note">a &amp; &lt;b&gt;</p>`},
        {name: "a quoted attribute in parts", value: html`<a href="/orders/${"o 1"}?x=${"\"y\""}">x</a>`, want: `<a href="/orders/o 1?x=&quot;y&quot;">x</a>`},
        {name: "nothing, null, undefined and the empty string", value: html`<p>${nothing}${null}${undefined}${""}</p><i title=${nothing}></i>`, want: `<p></p><i title=""></i>`},
        {name: "numbers and booleans", value: html`<p>${1} ${false}</p>`, want: `<p>1 false</p>`},
        {name: "a nested template and a list", value: html`<ul>${["a", "b"].map(item => html`<li>${item}</li>`)}</ul>`, want: `<ul><li>a</li><li>b</li></ul>`},
        {name: "repeat with a key", value: html`<ul>${repeat(["a", "b"], item => item, item => html`<li>${item}</li>`)}</ul>`, want: `<ul><li>a</li><li>b</li></ul>`},
        {name: "repeat without a key", value: html`<ul>${repeat(["a"], (item, index) => html`<li>${index}${item}</li>`)}</ul>`, want: `<ul><li>0a</li></ul>`},
        {name: "keyed", value: html`<div>${keyed("k", html`<p>${"inside"}</p>`)}</div>`, want: `<div><p>inside</p></div>`},
        {name: "live", value: html`<input .value=${live("typed")}>`, want: `<input .value="typed">`},
        {name: "a property's object and a listener", value: html`<x-a .items=${[1]} @click=${() => {}}></x-a>`, want: `<x-a .items="" @click=""></x-a>`},
        {name: "a comment, with a quote and a tag in it", value: html`<!-- the user's <b> --><p>${"x"}</p>`, want: `<!-- the user's <b> --><p>x</p>`},
        {name: "a value bound in a comment", value: html`<!-- ${"gone"} --><p></p>`, want: `<!--  --><p></p>`},
        {name: "the shortest comment", value: html`<!----><p title="a'b"></p>`, want: `<!----><p title="a'b"></p>`},
        {name: "a directive bound to the element", value: html`<dialog ${ref(createRef())} @close=${() => {}}></dialog>`, want: `<dialog  @close=""></dialog>`},
        {name: "an object on an attribute, as its string", value: html`<a href=${new URL("https://example.com/a")}>x</a>`, want: `<a href="https://example.com/a">x</a>`},
        {name: "space around the equals sign", value: html`<input .value= ${"typed"} title = ${"t"}>`, want: `<input .value= "typed" title = "t">`},
    ];
    for (const testCase of testCases) {
        assert.equal(renderedTemplate(testCase.value).html, testCase.want, testCase.name);
    }
});

test("each binding with the opening tag of its element", () => {
    const listener = () => {};
    const subject = renderedTemplate(html`<form><input name="a" ?readonly=${true} .value=${"x"}><button @click=${listener}>Go</button></form>`);
    assert.deepEqual(subject.bindings, [
        {name: "?readonly", value: true, tag: `<input name="a" ?readonly="true" .value="x">`},
        {name: ".value", value: "x", tag: `<input name="a" ?readonly="true" .value="x">`},
        {name: "@click", value: listener, tag: `<button @click="">`},
    ]);
    assert.equal(subject.bound(".value", `name="a"`), "x");

    const testCases = [
        {name: "space around the equals sign", value: html`<input .value= ${"typed"}>`, want: [".value"]},
        {name: "text before the tag that looks like an attribute", value: html`<p>example="unfinished</p><button @click=${() => {}}></button>`, want: ["@click"]},
        {name: "a comment before the tag that looks like one", value: html`<!-- example='unfinished --><button @click=${() => {}}></button>`, want: ["@click"]},
        {name: "an equals sign in a quoted value", value: html`<a href="/orders?id=${"o1"}&x=${"y"}"></a>`, want: ["href", "href"]},
    ];
    for (const testCase of testCases) {
        assert.deepEqual(renderedTemplate(testCase.value).bindings.map(binding => binding.name), testCase.want, testCase.name);
    }

    const dialogRef = createRef();
    const withRef = renderedTemplate(html`<dialog ${ref(dialogRef)}></dialog>`);
    assert.deepEqual(withRef.bindings.map(binding => binding.name), [""], "the element's own binding has no name");
    assert.equal(withRef.bindings[0].tag, "<dialog >");
});

test("what the reader refuses rather than passes over", () => {
    const testCases = [
        {name: "a directive it does not know, as a child", value: html`<p>${styleMap({color: "red"})}</p>`, want: /does not know/},
        {name: "a directive it does not know, in an attribute", value: html`<p style=${styleMap({color: "red"})}></p>`, want: /does not know/},
        {name: "a tag left open", value: html`<p title="x`, want: /a tag left open/},
        {name: "a comment left open", value: html`<!-- <p>`, want: /a comment left open/},
    ];
    for (const testCase of testCases) {
        assert.throws(() => renderedTemplate(testCase.value), testCase.want, testCase.name);
    }
});

test("bound and fire find exactly one element", () => {
    const subject = renderedTemplate(html`<button @click=${() => {}}>a</button><button @click=${() => {}}>b</button>`);
    const testCases = [
        {name: "none", call: () => subject.bound("@click", "<a"), want: /0 elements bind @click/},
        {name: "two", call: () => subject.fire("click", "<button"), want: /2 elements bind @click/},
    ];
    for (const testCase of testCases) {
        assert.throws(testCase.call, testCase.want, testCase.name);
    }
});

test("a listener is called as Lit calls it, with the component as this", () => {
    const subject = host(self => html`<button aria-label="Save" @click=${self.onClick}>Save</button>`);
    const event = rendered(subject).fire("click", `aria-label="Save"`);
    assert.equal(subject.calls.length, 1);
    assert.equal(subject.calls[0].self, subject);
    assert.equal(subject.calls[0].event, event);
    assert.equal(event.type, "click");
});

test("a listener object is called as Lit calls it, through its handleEvent", () => {
    const events: Event[] = [];
    const listener = {handleEvent(event: Event): void {
        assert.equal(this, listener);
        events.push(event);
    }};
    const event = renderedTemplate(html`<button @click=${listener}>Go</button>`).fire("click", "<button");
    assert.deepEqual(events, [event]);
});

test("the labels of the buttons after a text, or of all of them", () => {
    const subject = rendered(host(() => html`
        <button aria-label="Pin"></button>
        <h2>Actions</h2>
        <button aria-label="Delete"></button><a aria-label="Link"></a><button>No label</button>
        <button aria-label='Single'></button><button aria-label=Bare></button><button aria-label='${"Bound"}'></button>
    `));
    const testCases = [
        {name: "all", after: "", want: ["Pin", "Delete", "Single", "Bare", "Bound"]},
        {name: "after a heading", after: "<h2>Actions", want: ["Delete", "Single", "Bare", "Bound"]},
    ];
    for (const testCase of testCases) {
        assert.deepEqual(subject.labels(testCase.after), testCase.want, testCase.name);
    }
    assert.throws(() => subject.labels("not there"), /not rendered/);
});

test("an event with the fields a listener reads", () => {
    const target = {};
    const event = withFields(new Event("keydown"), {key: "Enter", target});
    assert.equal((event as unknown as {key: string}).key, "Enter");
    assert.equal(event.target, target);
});
