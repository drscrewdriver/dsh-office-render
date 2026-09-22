/**
 * The stylesheet is inlined by the bundler (`loader: { '.css': 'text' }`), so the
 * import resolves to a string at runtime. This declaration keeps `tsc` honest.
 */
declare module '*.css' {
  const css: string
  export default css
}
