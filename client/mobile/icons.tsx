/**
 * 移动端本地内联图标。
 *
 * 为什么不再用 `@deepseek-ai/dsh-client-ui-primitives` 的图标导出：该包的图标名随 DSH 版本
 * 变化（0.1.7-rc.2 里并不存在 `IconPanelLeftOutline16` 这类带 `16` 后缀的名字），引用不存在的
 * 导出会得到 `undefined`，React 渲染时抛 #130（element type is invalid），进而让整个槽位崩溃
 * —— 用户实测表现就是「工作区加载不出来」。自带 SVG 后与 DSH 内部实现彻底解耦，
 * 以后 DSH 改图标名也不会再打挂插件。
 */
export interface IconProps {
  /** 图标边长（px），默认 16。 */
  size?: number
}

function baseProps(size: number) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  }
}

/** 侧栏/面板图标。 */
export function IconPanelLeft({ size = 16 }: IconProps) {
  return (
    <svg {...baseProps(size)}>
      <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" />
      <path d="M6.5 3.5v9" />
    </svg>
  )
}

/** 文件夹（打开）图标。 */
export function IconFolderOpen({ size = 16 }: IconProps) {
  return (
    <svg {...baseProps(size)}>
      <path d="M2.5 5.2a1 1 0 0 1 1-1h2.9l1.2 1.5h4.9a1 1 0 0 1 1 1v.8" />
      <path d="M2.5 5.2v6.1a1 1 0 0 0 1 1h8.6a1 1 0 0 0 1-1l.9-4.3H4.3a1 1 0 0 0-1 .8z" />
    </svg>
  )
}

/** 下载图标。 */
export function IconDownload({ size = 16 }: IconProps) {
  return (
    <svg {...baseProps(size)}>
      <path d="M8 3v6.3" />
      <path d="M5.6 7.4 8 9.8l2.4-2.4" />
      <path d="M3.5 12.6h9" />
    </svg>
  )
}
