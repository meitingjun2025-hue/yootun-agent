/** CSS Modules 类名映射声明（client 构建环境）。 */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
