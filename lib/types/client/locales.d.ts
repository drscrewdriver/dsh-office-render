/**
 * Plugin-owned dictionaries, registered through the DSH locale service under our
 * own namespace. `en` is the fallback; a missing key renders the key itself,
 * never a blank, so a translation gap is visible instead of silent.
 */
/** Namespace for every key below. */
export declare const NS = "dsh-office-render";
/** The two built-in languages this plugin ships. */
export declare const dictionaries: Record<string, Record<string, string>>;
/** Values substituted into a `{placeholder}` template. */
export type TVars = Record<string, string | number>;
/** A translate function bound to the plugin namespace. */
export type T = (key: string, vars?: TVars) => string;
/** Substitute `{name}` placeholders; unknown placeholders stay literal. */
export declare function interpolate(template: string, vars?: TVars): string;
/** Build a `T` from a raw dictionary — used when no locale service exists. */
export declare function translatorFrom(dict: Record<string, string>): T;
