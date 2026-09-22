/**
 * Structural mirrors of the host services this plugin consumes.
 *
 * Declared locally rather than imported: the plugin must build and typecheck
 * without the DSH type packages present, and it only touches a handful of
 * members. `webServer` is the route registrar documented as
 * `register(route) -> disposer`; nothing else from the harness is used.
 */
/** A request as Node hands it to a route handler. */
export interface WebRequest {
    method?: string;
    url?: string;
    headers: Record<string, string | string[] | undefined>;
    on(event: 'data', listener: (chunk: Uint8Array) => void): void;
    on(event: 'end', listener: () => void): void;
    on(event: 'error', listener: (error: Error) => void): void;
}
/** A response as Node hands it to a route handler. */
export interface WebResponse {
    statusCode: number;
    setHeader(name: string, value: string | number): void;
    end(chunk?: Uint8Array | string): void;
}
/** One registered route. `exact` matches the path; `prefix` matches a subtree. */
export interface WebRoute {
    kind: 'exact' | 'prefix';
    path: string;
    handler: (request: WebRequest, response: WebResponse) => Promise<void> | void;
}
/** The route registrar provided as `ctx.webServer`. */
export interface WebServerLike {
    register(route: WebRoute): () => void;
}
/** The Cordis context, narrowed to what this plugin touches. */
export interface OfficeRenderContext {
    effect(factory: () => void | (() => void), label: string): void;
    webServer?: WebServerLike;
}
