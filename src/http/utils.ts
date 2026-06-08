import {Context, ProblemDetail, RequestInitEx} from "./types.js";
import {BadStatusCodeError, FetchError} from "./errors.js";

export async function fetchWithRequest(request: Request, options: RequestInitEx= {}) {
    const context = {request, requestBody: request.body?.toString()} as Context;

    let response: Response | null = null;
    try {
        response = await fetch(request);
    } catch (error) {
        throw new FetchError("fetch", context, {cause: error});
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
    return fetchWithRequest(new Request(typeof url === "string" ? url : url.toString(), options));
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