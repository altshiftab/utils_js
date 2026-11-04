import {Context, ProblemDetail, RequestInitEx, UnauthorizedHandler} from "./types.js";
import {BadStatusCodeError, FetchError} from "./errors.js";

// One for the whole page: the session a 401 says has lapsed is the page's, whichever client asked.
// It is module state, so a second copy of this package in a bundle would hold a second one.
let unauthorizedHandler: UnauthorizedHandler | null = null;

// Sets what a 401 is offered to before it is thrown, or, given null, offers it to nothing.
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null) {
    unauthorizedHandler = handler;
}

async function send(request: Request, context: Context): Promise<Response> {
    try {
        return await fetch(request);
    } catch (error) {
        throw new FetchError("fetch", context, {cause: error});
    }
}

export async function fetchWithRequest(request: Request, options: RequestInitEx= {}) {
    const context = {request, requestBody: request.body?.toString()} as Context;

    // A caller that reads the status itself is left to, the session's own refresh among them.
    const handler = unauthorizedHandler;
    const mayRetry = handler !== null && !options.skipErrorOnStatusCode && !options.skipUnauthorizedRetry;
    // Cloned before the first send, which consumes the body; a clone taken after has none to send.
    // A request whose body is gone already cannot be cloned, and goes as it did, to fail in the send.
    let replay: Request | null = null;
    if (mayRetry) {
        try {
            replay = request.clone();
        } catch {}
    }

    let response = await send(request, context);

    // Asked once: a 401 to the request sent again is thrown, however the handler would answer.
    if (handler && replay && response.status === 401) {
        let retry = false;
        try {
            retry = await handler(request);
        } catch {}

        // The refused response is only let go of when another takes its place; otherwise its body
        // is what the error reports.
        if (retry) {
            await response.body?.cancel().catch(() => {});
            response = await send(replay, context);
        }
    }

    context.response = response;

    let responseText = "";

    if (!options.skipReadResponseBody) {
        try {
            responseText = await response.text();
            context.responseBody = responseText;
        } catch (error) {
            throw new FetchError("response text", context, {cause: error});
        }
    }

    if (!options.skipErrorOnStatusCode && !response.ok)
        throw new BadStatusCodeError(response.status, context);

    return {response, responseText};
}

export async function fetchEx(url: string | URL, options: RequestInit & RequestInitEx = {}) {
    options.method ||= "GET";
    return fetchWithRequest(new Request(typeof url === "string" ? url : url.toString(), options), options);
}

export function problemDetailFromResponseText(responseText: string) {
    let problemDetail: ProblemDetail | null = null;
    try {
        const candidate = JSON.parse(responseText);
        if (candidate.title && candidate.status) {
            problemDetail = candidate;
        }
    } catch {}

    return problemDetail;
}

export function getBadStatusCodeErrorMessage(err: BadStatusCodeError): string {
    let message = String(err);
    const responseBody = err.context.responseBody;
    if (responseBody) {
        const problemDetail = problemDetailFromResponseText(responseBody);
        if (problemDetail && problemDetail.detail) {
            message = problemDetail.detail;
        } else {
            message = responseBody;
        }
    }

    return message;
}