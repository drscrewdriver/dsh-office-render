import type { OfficeKind } from './types';
import type { T } from './locales';
interface OfficePdfViewerProps {
    path: string;
    title?: string;
    /** The original document's bytes, from the registered `custom` loader. */
    customData?: unknown;
    t: T;
    /** Where the host accepts a conversion POST (from `/health`). */
    convertPath: string;
    kind: OfficeKind;
    /** The engine the host reported, shown so a wrong-looking render is traceable. */
    engine?: string;
}
export declare function OfficePdfViewer({ path, title, customData, t, convertPath, kind, engine }: OfficePdfViewerProps): import("react").JSX.Element;
export {};
