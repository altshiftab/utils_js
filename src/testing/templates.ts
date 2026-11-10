// What a Lit component renders, read without a DOM: the markup of its template, with each binding's value
// written where it is bound, and the bindings themselves, each with the opening tag of the element it is
// on. Text and attribute values are escaped as the browser would take them, so that the only angle
// brackets in the markup are the template's own.
//
// Node loads a component through Lit's own node build, which stands in for the few browser globals a
// component's class needs; nothing here needs a DOM, and a template is read rather than rendered. A
// directive the reader does not know is an error rather than something skipped, so that a test cannot
// pass over markup it never saw.

import {noChange, nothing, type LitElement, type TemplateResult} from "lit";
import {keyed} from "lit/directives/keyed.js";
import {live} from "lit/directives/live.js";
import {repeat} from "lit/directives/repeat.js";

interface DirectiveResult {
    _$litDirective$: unknown;
    values: unknown[];
}

const keyedDirective = (keyed("", "") as unknown as DirectiveResult)._$litDirective$;
const liveDirective = (live("") as unknown as DirectiveResult)._$litDirective$;
const repeatDirective = (repeat([], () => "") as unknown as DirectiveResult)._$litDirective$;

function isTemplate(value: unknown): value is TemplateResult {
    return typeof value === "object" && value !== null && "_$litType$" in value;
}

function isDirective(value: unknown): value is DirectiveResult {
    return typeof value === "object" && value !== null && "_$litDirective$" in value;
}

function escapeText(text: string): string {
    return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttribute(text: string): string {
    return escapeText(text).replaceAll("\"", "&quot;").replaceAll("'", "&#39;");
}

// attributeValue is what an attribute binding writes: nothing for a listener, a property's object, or
// nothing itself, which removes the attribute.
function attributeValue(value: unknown): string {
    if (isDirective(value)) {
        if (value._$litDirective$ !== liveDirective) {
            throw new Error("a directive the template reader does not know");
        }
        return attributeValue(value.values[0]);
    }
    if (value === nothing || value === noChange || value === null || value === undefined) {
        return "";
    }
    if (typeof value === "object" || typeof value === "function") {
        return "";
    }
    return String(value);
}

export interface Binding {
    // name is the attribute bound, with its prefix: "@click", ".value", "?readonly", "aria-label".
    name: string;
    value: unknown;
    // tag is the opening tag of the element the binding is on, as rendered.
    tag: string;
}

export class Rendered {
    readonly html: string;
    readonly bindings: Binding[];
    // tags are the opening tags, in order, each with where in the markup it starts.
    private readonly tags: {at: number, tag: string}[] = [];
    private readonly host: unknown;

    constructor(value: unknown, host: unknown = undefined) {
        this.host = host;
        const bindings: Binding[] = [];
        let html = "";

        // Where the markup written so far ends: in text, in a tag, or in a value of one quoted with the
        // character. Only the template's own strings move it, as the values written in are escaped.
        let state: "text" | "tag" | "\"" | "'" = "text";
        let tagStart = 0;
        // The bindings of the tag being written, which get their tag once it is closed.
        let open: {name: string, value: unknown}[] = [];

        const write = (part: string): void => {
            const base = html.length;
            html += part;
            for (let i = 0; i < part.length; i++) {
                const character = part[i];
                if (state === "text") {
                    if (character === "<") {
                        state = "tag";
                        tagStart = base + i;
                    }
                } else if (state === "tag") {
                    if (character === "\"" || character === "'") {
                        state = character;
                    } else if (character === ">") {
                        const tag = html.slice(tagStart, base + i + 1);
                        this.tags.push({at: tagStart, tag});
                        bindings.push(...open.map(binding => ({...binding, tag})));
                        open = [];
                        state = "text";
                    }
                } else if (character === state) {
                    state = "tag";
                }
            }
        };

        const child = (value: unknown): void => {
            if (value === nothing || value === noChange || value === null || value === undefined || value === "") {
                return;
            }
            if (isTemplate(value)) {
                template(value);
            } else if (isDirective(value)) {
                if (value._$litDirective$ === repeatDirective) {
                    const [items, , render] = value.values.length === 3 ? value.values : [value.values[0], null, value.values[1]];
                    [...items as Iterable<unknown>].forEach((item, index) => child((render as (item: unknown, index: number) => unknown)(item, index)));
                } else if (value._$litDirective$ === keyedDirective) {
                    // keyed(key, value) renders the value, anew whenever the key changes.
                    child(value.values[1]);
                } else {
                    throw new Error("a directive the template reader does not know");
                }
            } else if (typeof value === "object" && Symbol.iterator in value) {
                for (const item of value as Iterable<unknown>) {
                    child(item);
                }
            } else {
                html += escapeText(String(value));
            }
        };

        const template = (result: TemplateResult): void => {
            result.strings.forEach((part, index) => {
                write(part);
                if (index === result.values.length) {
                    return;
                }
                const value = result.values[index];
                if (state === "text") {
                    child(value);
                    return;
                }
                // In a tag: an attribute's value, unquoted where the template leaves it so, or a part of
                // a quoted one.
                const attribute = /([.?@]?[^\s"'<>/=]+)=(?:"[^"]*|'[^']*|)$/.exec(html);
                if (!attribute) {
                    throw new Error(`a binding the template reader does not know, after: ${part}`);
                }
                const text = escapeAttribute(attributeValue(value));
                html += state === "tag" ? `"${text}"` : text;
                open.push({name: attribute[1], value});
            });
        };

        child(value);
        if (state !== "text") {
            throw new Error(`a tag left open: ${html.slice(tagStart)}`);
        }
        this.html = html;
        this.bindings = bindings;
    }

    // labels are the aria-labels of the buttons whose tags begin after the first place the text is, or of
    // all of them, in order.
    labels(after = ""): string[] {
        const start = this.html.indexOf(after);
        if (start === -1) {
            throw new Error(`not rendered: ${after}`);
        }
        return this.tags
            .filter(({at, tag}) => at >= start && /^<button\b/.test(tag))
            .flatMap(({tag}) => /\saria-label="([^"]*)"/.exec(tag)?.[1] ?? []);
    }

    // bound is the value bound to the attribute, with its prefix, on the one element whose opening tag has
    // the text.
    bound(name: string, tagHas: string): unknown {
        const found = this.bindings.filter(binding => binding.name === name && binding.tag.includes(tagHas));
        if (found.length !== 1) {
            throw new Error(`${found.length} elements bind ${name} with ${tagHas} in their tag`);
        }
        return found[0].value;
    }

    // fire calls the listener bound for the event on the one element whose opening tag has the text, as
    // Lit calls it: with the component, if one was read, as this.
    fire(type: string, tagHas: string, event: Event = new Event(type, {cancelable: true})): Event {
        (this.bound(`@${type}`, tagHas) as (event: Event) => void).call(this.host, event);
        return event;
    }
}

// rendered is what the component renders as it now is.
export function rendered(host: LitElement): Rendered {
    return new Rendered((host as unknown as {render(): unknown}).render(), host);
}

// renderedTemplate is what a template renders, for a template made outside a component, by a function
// that returns one.
export function renderedTemplate(value: unknown): Rendered {
    return new Rendered(value);
}

// withFields is an event of the type, with what a listener reads of it that a plain Event lacks.
export function withFields<T extends Event>(event: T, fields: Record<string, unknown>): T {
    for (const [name, value] of Object.entries(fields)) {
        Object.defineProperty(event, name, {value});
    }
    return event;
}
