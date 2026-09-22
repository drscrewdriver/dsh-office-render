/** Stable Cordis plugin name; must match `cordis.patch.yml` and `package.json#name`. */
export declare const name = "dsh-office-render";
/** The only service required: the route registrar. */
export declare const inject: readonly ["webServer"];
/**
 * Host-side apply.
 *
 * @param rawCtx - the host context, narrowed structurally in `dsh-seams.ts`.
 */
export declare function apply(rawCtx: unknown): void;
