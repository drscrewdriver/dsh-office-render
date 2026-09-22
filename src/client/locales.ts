/**
 * Plugin-owned dictionaries, registered through the DSH locale service under our
 * own namespace. `en` is the fallback; a missing key renders the key itself,
 * never a blank, so a translation gap is visible instead of silent.
 */

/** Namespace for every key below. */
export const NS = 'dsh-office-render'

/** The two built-in languages this plugin ships. */
export const dictionaries: Record<string, Record<string, string>> = {
  en: {
    'viewer.docx': 'Document (faithful)',
    'viewer.pptx': 'Presentation (faithful)',
    'badge': 'faithful layout · rendered as PDF',
    'state.converting': 'Rendering with the Office suite on this machine…',
    'state.convertingHint': 'The first look at a file takes a few seconds; the result is cached afterwards.',
    'state.error': 'Could not render this file faithfully',
    'state.retry': 'Try again',
    'state.openPdf': 'Open the PDF in a new tab',
    'meta.units': '{size} · PDF',
    'meta.engine': 'engine {engine}',
    'hint.why': 'This plugin converts the file with an Office-compatible suite installed on the host machine (WPS Office or Microsoft Office) and shows the PDF, so the layout is the real one.',
    'hint.fallback': 'Disable dsh-office-render to go back to the structured reading view, which needs no converter.',
  },
  zh: {
    'viewer.docx': '文档（版式还原）',
    'viewer.pptx': '演示文稿（版式还原）',
    'badge': '版式还原 · 以 PDF 呈现',
    'state.converting': '正在用本机 Office 渲染…',
    'state.convertingHint': '首次打开需要几秒，结果会被缓存，之后立即显示。',
    'state.error': '无法完成版式渲染',
    'state.retry': '重试',
    'state.openPdf': '在新标签页打开 PDF',
    'meta.units': '{size} · PDF',
    'meta.engine': '引擎 {engine}',
    'hint.why': '本插件用宿主机上已安装的 Office 兼容套件（WPS Office 或 Microsoft Office）把文件转成 PDF 再显示，所以版式是真实的。',
    'hint.fallback': '停用 dsh-office-render 即可回到结构化阅读视图 —— 那条路不需要任何转换器。',
  },
}

/** Values substituted into a `{placeholder}` template. */
export type TVars = Record<string, string | number>

/** A translate function bound to the plugin namespace. */
export type T = (key: string, vars?: TVars) => string

/** Substitute `{name}` placeholders; unknown placeholders stay literal. */
export function interpolate(template: string, vars?: TVars): string {
  if (vars === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name]
    return value === undefined ? match : String(value)
  })
}

/** Build a `T` from a raw dictionary — used when no locale service exists. */
export function translatorFrom(dict: Record<string, string>): T {
  return (key, vars) => interpolate(dict[key] ?? key, vars)
}
