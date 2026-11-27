/**
 * 「数据资源」tab 的图标。
 *
 * 以**组件函数**形式提供：sidebar 的 tab 图标契约是
 * `typeof descriptor.icon === 'function' ? descriptor.icon(14) : descriptor.icon`，
 * 传函数可以让 sidebar 自己决定尺寸。用 JSX 而不是 createElement，是为了和同仓
 * 其它插件走同一套 React 运行时（跨运行时创建的元素不会被渲染）。
 */
export function ResourceTabIcon({ size = 14 }: { size?: number }): React.ReactElement {
  // 侧栏标签用 14；开始面板把它渲染成 22 的磁贴图标。超过磁贴规范（22）时收敛，避免插件图标
  // 在「更多」面板里比相邻磁贴大一号。
  const dimension = size >= 22 ? 22 : size
  return (
    <svg
      width={dimension}
      height={dimension}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <ellipse cx="12" cy="5.5" rx="7.5" ry="3" />
      <path d="M4.5 5.5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6" />
      <path d="M4.5 11.5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6" />
    </svg>
  )
}
