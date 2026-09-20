/** CSS Modules resolve to a class-name map at build time. */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
