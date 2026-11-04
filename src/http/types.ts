export interface RequestInitEx {
    skipReadResponseBody?: boolean;
    skipErrorOnStatusCode?: boolean;
    // Leaves a 401 to the caller rather than offering it to the unauthorized handler.
    skipUnauthorizedRetry?: boolean;
}

// Offered a request the server answered 401, before that is thrown. Resolving true sends the
// request once more; false throws the 401 as it would have been. A handler that never settles
// leaves the call pending, which is what a page that is about to be navigated away from wants.
export type UnauthorizedHandler = (request: Request) => Promise<boolean>;

export interface Context {
    request: Request;
    requestBody: string;
    response?: Response;
    responseBody?: string;
}

export interface ProblemDetail {
    type?: string;
    title?: string;
    status?: number;
    detail?: string;
    instance?: string;
    error?: string;
}