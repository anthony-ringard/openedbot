/*
  Toaster (Clean), cloné d'affectUI (https://www.affectui.com/components/toaster) :
  une pile qui se déploie au survol ou au focus, des toasts `promise` dont le
  spinner se referme en coche ou en croix, le balayage pour fermer, F8 pour
  rejoindre la pile, Échap pour fermer. Styles et mouvement sont ceux du
  composant d'origine (feuille `ui-toaster-clean` injectée par React 19,
  mode sombre par `.dark` ou `[data-theme="dark"]` sur un ancêtre).

  Ajouts locaux : le type `warning` (ambre, glyphe « ! » de `info`) ; surface,
  textes, couleurs et ombre lus sur les jetons du thème, l'original en repli.
*/
import {
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react"

export type ToastId = string | number

export type ToastType = "default" | "success" | "error" | "info" | "warning" | "loading"

export type ToastOptions = {
  id?: ToastId
  description?: ReactNode
  action?: { label: ReactNode; onClick: (event: MouseEvent<HTMLButtonElement>) => void }
  duration?: number
  icon?: ReactNode
  toaster?: string
  onDismiss?: (id: ToastId) => void
}

export type ToastPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right"

export type ToasterProps = {
  position?: ToastPosition
  inline?: boolean
  id?: string
  duration?: number
  visibleToasts?: number
  expand?: boolean
  offset?: number
  gap?: number
  hotkey?: string | null
  hairline?: boolean
  closeButton?: boolean
  label?: string
  className?: string
}

type ToastRecord = ToastOptions & {
  id: ToastId
  type: ToastType
  title: ReactNode
  version: number
  removing?: boolean
}

type PromiseMessage<T> = ReactNode | { title: ReactNode; description?: ReactNode } | ((value: T) => ReactNode | { title: ReactNode; description?: ReactNode })

type PromiseMessages<T> = {
  loading: ReactNode | { title: ReactNode; description?: ReactNode }
  success: PromiseMessage<T>
  error: PromiseMessage<unknown>
}

/* ---------------------------------------------------------------- store */

let toasts: ToastRecord[] = []
const listeners = new Set<() => void>()
const EMPTY: ToastRecord[] = []
let counter = 0
const REMOVE_DELAY = 420

const setToasts = (next: ToastRecord[]) => {
  toasts = next
  listeners.forEach((listener) => listener())
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const getSnapshot = () => toasts
const getServerSnapshot = () => EMPTY

function push(type: ToastType, title: ReactNode, options: ToastOptions = {}, updateOnly = false): ToastId {
  const { id, ...rest } = options
  const existing = id === undefined ? undefined : toasts.find((t) => t.id === id && !t.removing)
  if (existing) {
    setToasts(toasts.map((t) => (t === existing ? { ...t, ...rest, type, title, version: t.version + 1 } : t)))
    return existing.id
  }
  const nextId = id ?? `toast-${++counter}`
  if (!updateOnly) {
    setToasts([...toasts.filter((t) => t.id !== nextId), { ...rest, id: nextId, type, title, version: 0 }])
  }
  return nextId
}

function dismiss(id?: ToastId) {
  const targets = toasts.filter((t) => !t.removing && (id === undefined || t.id === id))
  if (!targets.length) return
  setToasts(toasts.map((t) => (targets.includes(t) ? { ...t, removing: true } : t)))
  targets.forEach((t) => t.onDismiss?.(t.id))
  window.setTimeout(() => {
    setToasts(toasts.filter((t) => !(t.removing && targets.some((target) => target.id === t.id))))
  }, REMOVE_DELAY)
}

const isMessageObject = (value: unknown): value is { title: ReactNode; description?: ReactNode } =>
  typeof value === "object" && !!value && !isValidElement(value) && !Array.isArray(value) && "title" in value

const toMessage = (value: ReactNode | { title: ReactNode; description?: ReactNode }) =>
  isMessageObject(value) ? value : { title: value, description: undefined }

function promise<T>(input: Promise<T> | (() => Promise<T>), messages: PromiseMessages<T>, options: ToastOptions = {}): Promise<T> {
  const pending = typeof input === "function" ? input() : input
  const loading = toMessage(messages.loading)
  const id = push("loading", loading.title, { ...options, description: loading.description })
  const settle = (type: ToastType, message: ReactNode | { title: ReactNode; description?: ReactNode }) => {
    const resolved = toMessage(message)
    push(type, resolved.title, { ...options, id, description: resolved.description }, true)
  }
  pending.then(
    (value) => settle("success", typeof messages.success === "function" ? messages.success(value) : messages.success),
    (error: unknown) => settle("error", typeof messages.error === "function" ? messages.error(error) : messages.error),
  )
  return pending
}

export const toast = Object.assign((title: ReactNode, options?: ToastOptions) => push("default", title, options), {
  success: (title: ReactNode, options?: ToastOptions) => push("success", title, options),
  error: (title: ReactNode, options?: ToastOptions) => push("error", title, options),
  info: (title: ReactNode, options?: ToastOptions) => push("info", title, options),
  warning: (title: ReactNode, options?: ToastOptions) => push("warning", title, options),
  loading: (title: ReactNode, options?: ToastOptions) => push("loading", title, options),
  promise,
  dismiss,
})

/* ----------------------------------------------------------------- icons */

function StatusIcon() {
  return (
    <svg viewBox="0 0 24 24" className="ui-tsc__status" aria-hidden="true">
      <g className="ui-tsc__spin">
        <circle className="ui-tsc__ring" cx="12" cy="12" r="9.25" pathLength={1} />
      </g>
      <path className="ui-tsc__mark ui-tsc__check" d="M8.3 12.4l2.5 2.5 4.9-5.3" pathLength={1} />
      <path className="ui-tsc__mark ui-tsc__x1" d="M9.5 9.5l5 5" pathLength={1} />
      <path className="ui-tsc__mark ui-tsc__x2" d="M14.5 9.5l-5 5" pathLength={1} />
      <path className="ui-tsc__info" d="M12 11.2v4.6M12 8.2h.01" />
    </svg>
  )
}

const CloseGlyph = () => (
  <svg viewBox="0 0 24 24" className="ui-tsc__glyph" aria-hidden="true">
    <path d="M7.5 7.5l9 9M16.5 7.5l-9 9" />
  </svg>
)

const keyOf = (t: ToastRecord) => String(t.id)

/* ----------------------------------------------------------------- toast */

type Layout = { y: number; scale: number; height: number; z: number; behind: boolean; hidden: boolean }

type Drag = { pointer: number; x: number; y: number; axis: "x" | "y" | null; samples: { v: number; at: number }[] }

type ToastItemProps = {
  t: ToastRecord
  layout: Layout
  edge: 1 | -1
  paused: boolean
  defaultDuration: number
  hairline: boolean
  closeButton: boolean
  onHeight: (key: string, height: number) => void
}

function ToastItem({ t, layout, edge, paused, defaultDuration, hairline, closeButton, onHeight }: ToastItemProps) {
  const [mounted, setMounted] = useState(false)
  const [swiping, setSwiping] = useState(false)
  const [ghost, setGhost] = useState<{ title: ReactNode; description?: ReactNode; version: number } | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const swipeRef = useRef<HTMLDivElement>(null)
  const lastCopy = useRef({ title: t.title, description: t.description, version: t.version })
  const ghostTimer = useRef(0)
  const remaining = useRef({ version: -1, left: 0 })
  const drag = useRef<Drag | null>(null)
  const swallowClick = useRef(false)
  const removing = !!t.removing

  useEffect(() => {
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => setMounted(true)))
    return () => cancelAnimationFrame(frame)
  }, [])

  useLayoutEffect(() => {
    const node = contentRef.current
    if (!node) return
    const key = keyOf(t)
    const measure = () => onHeight(key, node.offsetHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    const previous = lastCopy.current
    if (previous.version === t.version) return
    lastCopy.current = { title: t.title, description: t.description, version: t.version }
    if (previous.title !== t.title || previous.description !== t.description) {
      setGhost(previous)
      window.clearTimeout(ghostTimer.current)
      ghostTimer.current = window.setTimeout(() => setGhost(null), 320)
    }
  }, [t.version])

  useEffect(() => () => window.clearTimeout(ghostTimer.current), [])

  const duration = t.duration ?? defaultDuration
  const timed = t.type !== "loading" && Number.isFinite(duration)
  const running = timed && !paused && !swiping && !removing

  useEffect(() => {
    if (remaining.current.version !== t.version) remaining.current = { version: t.version, left: duration }
    if (!running) return
    const version = t.version
    const startedAt = Date.now()
    const timer = window.setTimeout(() => dismiss(t.id), Math.max(0, remaining.current.left))
    return () => {
      window.clearTimeout(timer)
      if (remaining.current.version === version) remaining.current.left -= Date.now() - startedAt
    }
  }, [running, t.version, duration, t.id])

  const onPointerDown = (event: PointerEvent<HTMLLIElement>) => {
    if (event.button !== 0 || removing) return
    if ((event.target as HTMLElement).closest("button, a, input, textarea, select")) return
    drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, axis: null, samples: [] }
    swallowClick.current = false
  }

  const onPointerMove = (event: PointerEvent<HTMLLIElement>) => {
    const state = drag.current
    const node = swipeRef.current
    if (!state || state.pointer !== event.pointerId || !node) return
    const dx = event.clientX - state.x
    const dy = event.clientY - state.y
    if (!state.axis) {
      if (Math.hypot(dx, dy) < 6) return
      state.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y"
      event.currentTarget.setPointerCapture(event.pointerId)
      swallowClick.current = true
      setSwiping(true)
      node.style.transition = "none"
    }
    let offset = state.axis === "x" ? dx : dy
    const outward = state.axis === "x" || offset * edge > 0
    if (!outward) offset = Math.sign(offset) * Math.abs(offset) ** 0.7 * 0.6
    const span = state.axis === "x" ? node.offsetWidth : node.offsetHeight * 2
    node.style.transform = state.axis === "x" ? `translateX(${offset}px)` : `translateY(${offset}px)`
    node.style.opacity = outward ? String(Math.max(0.25, 1 - Math.abs(offset) / (span * 1.1))) : ""
    state.samples.push({ v: offset, at: event.timeStamp })
    if (state.samples.length > 6) state.samples.shift()
  }

  const onPointerEnd = (event: PointerEvent<HTMLLIElement>) => {
    const state = drag.current
    const node = swipeRef.current
    if (!state || state.pointer !== event.pointerId) return
    drag.current = null
    if (!state.axis || !node) return
    setSwiping(false)
    const last = state.samples[state.samples.length - 1] ?? { v: 0, at: 0 }
    const first = state.samples[0] ?? last
    const velocity = last.at > first.at ? (last.v - first.v) / (last.at - first.at) : 0
    const outward = state.axis === "x" || last.v * edge > 0
    const flung = Math.abs(velocity) > 0.45 && Math.sign(velocity) === Math.sign(last.v)
    if (event.type === "pointerup" && outward && (Math.abs(last.v) > 64 || flung)) {
      const distance = (state.axis === "x" ? node.offsetWidth : node.offsetHeight) + 48
      node.style.transition = "transform 300ms cubic-bezier(0.22, 1, 0.36, 1), opacity 240ms ease"
      node.style.transform = `${state.axis === "x" ? "translateX" : "translateY"}(${Math.sign(last.v) * distance}px)`
      node.style.opacity = "0"
      dismiss(t.id)
    } else {
      node.style.transition = ""
      node.style.transform = ""
      node.style.opacity = ""
    }
  }

  const inward = -edge
  let transform = `translateY(${inward * layout.y}px) scale(${layout.scale})`
  if (!mounted) transform = `translateY(${edge * 100}%) scale(${layout.scale})`
  if (removing) transform = `translateY(${inward * layout.y + edge * 10}px) scale(${layout.scale * 0.96})`

  const icon = t.type === "loading" ? <StatusIcon /> : (t.icon ?? (t.type === "default" ? null : <StatusIcon />))
  const hasDescription = t.description != null && t.description !== ""

  return (
    <li
      className="ui-tsc__toast"
      data-toast-id={keyOf(t)}
      data-type={t.type}
      data-behind={layout.behind || undefined}
      data-removing={removing || undefined}
      data-swiping={swiping || undefined}
      tabIndex={0}
      inert={layout.hidden || removing}
      style={{
        transform,
        opacity: !mounted || removing || layout.hidden ? 0 : 1,
        height: layout.height ? `${layout.height}px` : undefined,
        zIndex: layout.z,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onClickCapture={(event) => {
        if (swallowClick.current) {
          swallowClick.current = false
          event.stopPropagation()
          event.preventDefault()
        }
      }}
    >
      <div ref={swipeRef} className="ui-tsc__swipe">
        <div className="ui-tsc__card">
          <div ref={contentRef} className="ui-tsc__content" data-action={t.action ? "" : undefined}>
            {icon && (
              <span className="ui-tsc__icon" data-type={t.icon && t.type !== "loading" ? "custom" : t.type}>
                {icon}
              </span>
            )}
            <div className="ui-tsc__text">
              <div key={t.version} className="ui-tsc__copy" data-changed={t.version > 0 || undefined}>
                <div className="ui-tsc__title">{t.title}</div>
                {hasDescription && <div className="ui-tsc__desc">{t.description}</div>}
              </div>
              {ghost && (
                <div key={`ghost-${ghost.version}`} className="ui-tsc__copy ui-tsc__ghost" aria-hidden="true">
                  <div className="ui-tsc__title">{ghost.title}</div>
                  {ghost.description != null && ghost.description !== "" && (
                    <div className="ui-tsc__desc">{ghost.description}</div>
                  )}
                </div>
              )}
            </div>
            {t.action && (
              <button
                type="button"
                className="ui-tsc__action"
                onClick={(event) => {
                  t.action?.onClick(event)
                  if (!event.defaultPrevented) dismiss(t.id)
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
          {hairline && timed && (
            <span
              key={t.version}
              className="ui-tsc__timer"
              aria-hidden="true"
              style={{ animationDuration: `${duration}ms`, animationPlayState: running ? "running" : "paused" }}
            />
          )}
        </div>
        {closeButton && (
          <button type="button" className="ui-tsc__close" aria-label="Dismiss notification" onClick={() => dismiss(t.id)}>
            <CloseGlyph />
          </button>
        )}
      </div>
    </li>
  )
}

/* --------------------------------------------------------------- toaster */

const PEEK = 10
const SHRINK = 0.05
const HIDDEN_LAYOUT: Layout = { y: 0, scale: 1, height: 0, z: 0, behind: false, hidden: true }

export function Toaster({
  position = "bottom-right",
  inline = false,
  id,
  duration = 4000,
  visibleToasts = 3,
  expand = false,
  offset,
  gap = 10,
  hotkey = "F8",
  hairline = true,
  closeButton = true,
  label = "Notifications",
  className,
}: ToasterProps) {
  const all = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  const [heights, setHeights] = useState<Record<string, number>>({})
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [tapped, setTapped] = useState(false)
  const [hiddenTab, setHiddenTab] = useState(false)
  const [polite, setPolite] = useState("")
  const [assertive, setAssertive] = useState("")
  const regionRef = useRef<HTMLElement>(null)
  const lastLayouts = useRef(new Map<string, Layout>())
  const lastFrontHeight = useRef(0)
  const returnFocus = useRef<Element | null>(null)
  const pointerType = useRef("mouse")
  const announced = useRef(new Map<string, number>())

  const [yEdge, xEdge] = position.split("-") as ["top" | "bottom", "left" | "center" | "right"]
  const edge: 1 | -1 = yEdge === "bottom" ? 1 : -1
  const mine = all.filter((t) => (t.toaster ?? null) === (id ?? null)).reverse()
  const live = mine.filter((t) => !t.removing)
  const expanded = expand || hovered || focused || tapped
  const paused = hovered || focused || tapped || hiddenTab
  const limit = Math.max(1, visibleToasts)

  const onHeight = useCallback((key: string, height: number) => {
    setHeights((prev) => (prev[key] === height ? prev : { ...prev, [key]: height }))
  }, [])

  const frontHeight = (live[0] && heights[keyOf(live[0])]) || lastFrontHeight.current
  if (frontHeight) lastFrontHeight.current = frontHeight

  const layouts = new Map<string, Layout>()
  let stacked = 0
  live.forEach((t, index) => {
    const height = heights[keyOf(t)] ?? 0
    const rank = Math.min(index, limit - 1)
    const layout: Layout = expanded
      ? { y: stacked, scale: 1, height, z: live.length - index, behind: false, hidden: index >= limit }
      : {
          y: rank * PEEK,
          scale: 1 - rank * SHRINK,
          height: index === 0 ? height : frontHeight,
          z: live.length - index,
          behind: index > 0,
          hidden: index >= limit,
        }
    if (index < limit) stacked += height + gap
    layouts.set(keyOf(t), layout)
    lastLayouts.current.set(keyOf(t), layout)
  })

  const shown = Math.min(live.length, limit)
  const listHeight = live.length ? (expanded ? Math.max(0, stacked - gap) : frontHeight + PEEK * (shown - 1)) : 0

  useEffect(() => {
    const keys = new Set(mine.map(keyOf))
    setHeights((prev) => {
      const stale = Object.keys(prev).filter((key) => !keys.has(key))
      if (!stale.length) return prev
      const next = { ...prev }
      stale.forEach((key) => delete next[key])
      return next
    })
    lastLayouts.current.forEach((_, key) => !keys.has(key) && lastLayouts.current.delete(key))
    if (!live.length) setTapped(false)
  }, [all])

  useEffect(() => {
    const region = regionRef.current
    if (!region) return
    live.forEach((t) => {
      const key = keyOf(t)
      if (announced.current.get(key) === t.version) return
      announced.current.set(key, t.version)
      const text = Array.from(region.querySelectorAll<HTMLElement>("[data-toast-id]"))
        .find((node) => node.dataset.toastId === key)
        ?.querySelector(".ui-tsc__copy:not(.ui-tsc__ghost)")
        ?.textContent?.trim()
      if (text) (t.type === "error" ? setAssertive : setPolite)((prev) => (prev === text ? `${text} ` : text))
    })
    announced.current.forEach((_, key) => !mine.some((t) => keyOf(t) === key) && announced.current.delete(key))
  }, [all])

  useEffect(() => {
    const sync = () => setHiddenTab(document.visibilityState === "hidden")
    sync()
    document.addEventListener("visibilitychange", sync)
    return () => document.removeEventListener("visibilitychange", sync)
  }, [])

  useEffect(() => {
    if (!tapped) return
    const onOutside = (event: Event) => {
      if (!regionRef.current?.contains(event.target as Node)) setTapped(false)
    }
    document.addEventListener("pointerdown", onOutside)
    return () => document.removeEventListener("pointerdown", onOutside)
  }, [tapped])

  const liveNodes = () =>
    Array.from(regionRef.current?.querySelectorAll<HTMLElement>("[data-toast-id]:not([data-removing])") ?? [])

  useEffect(() => {
    if (!hotkey) return
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== hotkey && event.code !== hotkey) return
      const target = liveNodes().find((node) => !node.inert)
      if (!target) return
      event.preventDefault()
      if (!regionRef.current?.contains(document.activeElement)) returnFocus.current = document.activeElement
      target.focus()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [hotkey])

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || !live.length) return
    event.preventDefault()
    event.stopPropagation()
    const node = (event.target as HTMLElement).closest<HTMLElement>("[data-toast-id]")
    const current = live.find((t) => keyOf(t) === node?.dataset.toastId) ?? live[0]
    if (!current) return
    const index = live.indexOf(current)
    dismiss(current.id)
    const next = live.filter((t) => t !== current)[Math.min(index, live.length - 2)]
    const nextNode = next && liveNodes().find((candidate) => candidate.dataset.toastId === keyOf(next))
    if (nextNode) nextNode.focus()
    else if (returnFocus.current?.isConnected) (returnFocus.current as HTMLElement).focus()
    else (document.activeElement as HTMLElement | null)?.blur()
  }

  const onFocus = (event: FocusEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).matches(":focus-visible")) setFocused(true)
  }
  const onBlur = (event: FocusEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false)
  }

  const style = { "--ui-tsc-offset": offset === undefined ? undefined : `${offset}px` } as CSSProperties

  return (
    <section
      ref={regionRef}
      className={["ui-tsc", className].filter(Boolean).join(" ")}
      data-y={yEdge}
      data-x={xEdge}
      data-inline={inline || undefined}
      data-expanded={expanded || undefined}
      data-empty={!live.length || undefined}
      aria-label={hotkey ? `${label} (${hotkey})` : label}
      tabIndex={-1}
      style={style}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onBlur={onBlur}
      onPointerDownCapture={(event) => {
        pointerType.current = event.pointerType
      }}
      onPointerEnter={(event) => event.pointerType === "mouse" && setHovered(true)}
      onPointerLeave={(event) => event.pointerType === "mouse" && setHovered(false)}
      onClick={() => pointerType.current !== "mouse" && live.length > 1 && setTapped(true)}
    >
      <style href="ui-toaster-clean" precedence="default">
        {STYLES}
      </style>
      <ol className="ui-tsc__list" style={{ height: `${listHeight}px` }}>
        {mine.map((t) => (
          <ToastItem
            key={keyOf(t)}
            t={t}
            layout={layouts.get(keyOf(t)) ?? lastLayouts.current.get(keyOf(t)) ?? HIDDEN_LAYOUT}
            edge={edge}
            paused={paused || (layouts.get(keyOf(t))?.hidden ?? false)}
            defaultDuration={duration}
            hairline={hairline}
            closeButton={closeButton}
            onHeight={onHeight}
          />
        ))}
      </ol>
      <div className="ui-tsc__sr" role="status" aria-live="polite">
        {polite}
      </div>
      <div className="ui-tsc__sr" role="alert">
        {assertive}
      </div>
    </section>
  )
}

/* ---------------------------------------------------------------- styles */

const STYLES = `.ui-tsc{--ui-tsc-card: var(--popover, #ffffff);--ui-tsc-strong: var(--popover-foreground, #0a0a0a);--ui-tsc-ink: var(--foreground, rgba(0, 0, 0, 0.88));--ui-tsc-text: var(--muted-foreground, rgba(0, 0, 0, 0.61));--ui-tsc-icon: rgba(0, 0, 0, 0.447);--ui-tsc-faint: rgba(0, 0, 0, 0.27);--ui-tsc-hairline: rgba(0, 0, 0, 0.1);--ui-tsc-success: var(--state-pos-fg, #1a9a52);--ui-tsc-danger: var(--destructive, #e5484d);--ui-tsc-warning: #d97706;--ui-tsc-accent: var(--state-info-fg, #1447e6);--ui-tsc-focus: color-mix(in oklab, var(--ring, #0060e2) 45%, transparent);--ui-tsc-radius: calc(var(--radius, 10px) * 1.2);--ui-tsc-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.06), 0 1px 1px -1px rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.05);--ui-tsc-shadow-hover: 0 0 0 0.5px rgba(0, 0, 0, 0.1), 0 1px 1px -1px rgba(0, 0, 0, 0.12), 0 1px 3px 0 rgba(0, 0, 0, 0.07);--ui-tsc-shadow-float: 0 0 0 1px var(--border, rgba(0, 0, 0, 0.08)), 0 1px 2px 0 rgba(0, 0, 0, 0.06), 0 16px 32px -16px rgba(0, 0, 0, 0.24);--ui-tsc-ease: cubic-bezier(0.22, 1, 0.36, 1);--ui-tsc-width: 356px;--ui-tsc-offset: 24px;position: fixed;z-index: 9999;box-sizing: border-box;container-type: inline-size;width: var(--ui-tsc-width);max-width: calc(100% - 2 * var(--ui-tsc-offset));margin: 0;padding: 0;font-family: var(--font-sans, "Inter", "InterVariable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);font-size: 13px;font-weight: 400;line-height: 20px;color: var(--ui-tsc-text);text-align: left;-webkit-font-smoothing: antialiased;outline: none}.ui-tsc[data-inline]{position: absolute;z-index: 20;--ui-tsc-offset: 20px}.ui-tsc[data-empty]{pointer-events: none}.ui-tsc *, .ui-tsc *::before, .ui-tsc *::after{box-sizing: border-box}:where(.ui-tsc) button{margin: 0;padding: 0;border: 0;background: none;font: inherit;color: inherit;cursor: pointer;-webkit-tap-highlight-color: transparent}:where(.ui-tsc) svg{display: block;flex: none}.ui-tsc button:focus-visible{outline: 2px solid var(--ui-tsc-focus);outline-offset: 1px}.ui-tsc[data-y="bottom"]{bottom: var(--ui-tsc-offset)}.ui-tsc[data-y="top"]{top: var(--ui-tsc-offset)}.ui-tsc[data-x="right"]{right: var(--ui-tsc-offset)}.ui-tsc[data-x="left"]{left: var(--ui-tsc-offset)}.ui-tsc[data-x="center"]{left: 50%;transform: translateX(-50%)}.ui-tsc:not([data-inline])[data-y="bottom"]{bottom: max(var(--ui-tsc-offset), env(safe-area-inset-bottom))}.ui-tsc__list{position: relative;margin: 0;padding: 0;list-style: none}.ui-tsc__toast{position: absolute;left: 0;right: 0;outline: none;touch-action: none;-webkit-user-select: none;user-select: none;transition: transform 440ms var(--ui-tsc-ease), opacity 320ms ease, height 380ms var(--ui-tsc-ease)}.ui-tsc[data-y="bottom"] .ui-tsc__toast{bottom: 0;transform-origin: 50% 0}.ui-tsc[data-y="top"] .ui-tsc__toast{top: 0;transform-origin: 50% 100%}.ui-tsc__toast[data-removing]{pointer-events: none;transition: transform 380ms var(--ui-tsc-ease), opacity 260ms ease, height 380ms var(--ui-tsc-ease)}.ui-tsc__swipe{position: relative;height: 100%;transition: transform 460ms cubic-bezier(0.34, 1.3, 0.64, 1), opacity 260ms ease}.ui-tsc__toast[data-swiping]{cursor: grabbing}.ui-tsc__card{position: relative;height: 100%;overflow: hidden;border-radius: var(--ui-tsc-radius);background: var(--ui-tsc-card);box-shadow: var(--ui-tsc-shadow-float)}.ui-tsc__toast:focus-visible .ui-tsc__card{outline: 2px solid var(--ui-tsc-focus);outline-offset: 2px}.ui-tsc__content{display: flex;align-items: flex-start;gap: 10px;padding: 12px 16px 12px 14px;transition: opacity 260ms ease}.ui-tsc__content[data-action]{padding-right: 12px}.ui-tsc__toast[data-behind] .ui-tsc__content, .ui-tsc__toast[data-behind] .ui-tsc__timer{opacity: 0}.ui-tsc__text{position: relative;flex: 1;min-width: 0}.ui-tsc__title{font-weight: 500;line-height: 20px;color: var(--ui-tsc-strong);overflow-wrap: anywhere}.ui-tsc__desc{font-size: 13px;line-height: 20px;color: var(--ui-tsc-text);overflow-wrap: anywhere}.ui-tsc__copy[data-changed]{animation: ui-tsc-text-in 300ms var(--ui-tsc-ease) both}.ui-tsc__ghost{position: absolute;top: 0;left: 0;right: 0;pointer-events: none;animation: ui-tsc-text-out 220ms ease both}.ui-tsc__icon{display: grid;place-items: center;flex: none;width: 24px;height: 24px;margin: -2px 0;border-radius: 999px;color: var(--ui-tsc-icon);transition: color 300ms ease, background-color 300ms ease}.ui-tsc__icon:is([data-type="success"], [data-type="error"], [data-type="info"], [data-type="warning"]){background: color-mix(in oklab, currentColor 13%, transparent)}.ui-tsc__icon[data-type="success"]{color: var(--ui-tsc-success)}.ui-tsc__icon[data-type="error"]{color: var(--ui-tsc-danger)}.ui-tsc__icon[data-type="info"]{color: var(--ui-tsc-accent)}.ui-tsc__icon[data-type="warning"]{color: var(--ui-tsc-warning)}.ui-tsc__icon[data-type="custom"] > *{width: 16px;height: 16px}.ui-tsc__status{width: 20px;height: 20px;overflow: visible;fill: none;stroke: currentColor;stroke-width: 2;stroke-linecap: round;stroke-linejoin: round}.ui-tsc__icon[data-type="loading"] .ui-tsc__status{width: 16px;height: 16px}.ui-tsc__icon[data-type="success"] .ui-tsc__status, .ui-tsc__icon[data-type="error"] .ui-tsc__status{animation: ui-tsc-pop 460ms cubic-bezier(0.34, 1.56, 0.64, 1) both}.ui-tsc__spin{transform-box: fill-box;transform-origin: center;animation: ui-tsc-spin 760ms linear infinite;animation-play-state: paused}.ui-tsc__icon[data-type="loading"] .ui-tsc__spin{animation-play-state: running}.ui-tsc__ring{stroke-dasharray: 1 0;stroke-opacity: 0;transition: stroke-dasharray 560ms var(--ui-tsc-ease), stroke-opacity 360ms ease}.ui-tsc__icon[data-type="loading"] .ui-tsc__ring{stroke-dasharray: 0.28 0.72;stroke-opacity: 1}.ui-tsc__mark{stroke-dasharray: 1;stroke-dashoffset: 1;opacity: 0}.ui-tsc__info{opacity: 0;transition: opacity 240ms ease}.ui-tsc__icon[data-type="success"] .ui-tsc__check, .ui-tsc__icon[data-type="error"] .ui-tsc__x1, .ui-tsc__icon[data-type="error"] .ui-tsc__x2{opacity: 1;stroke-dashoffset: 0;animation: ui-tsc-draw 340ms var(--ui-tsc-ease) 160ms both}.ui-tsc__icon[data-type="error"] .ui-tsc__x2{animation-delay: 260ms}.ui-tsc__icon[data-type="info"] .ui-tsc__info, .ui-tsc__icon[data-type="warning"] .ui-tsc__info{opacity: 1}.ui-tsc__action{flex: none;align-self: center;height: 28px;margin: -4px 0;padding: 0 10px;border-radius: 6px;font-size: 13px;font-weight: 500;line-height: 20px;white-space: nowrap;transition: background-color 140ms ease, box-shadow 140ms ease, transform 160ms var(--ui-tsc-ease)}:where(.ui-tsc) .ui-tsc__action{background: var(--ui-tsc-card);box-shadow: var(--ui-tsc-shadow);color: var(--ui-tsc-strong)}.ui-tsc__action:hover{box-shadow: var(--ui-tsc-shadow-hover)}.ui-tsc__action:active{transform: scale(0.97)}.ui-tsc__close{position: absolute;top: -7px;left: -7px;z-index: 1;display: grid;place-items: center;width: 20px;height: 20px;border-radius: 50%;opacity: 0;transform: scale(0.8);transition: opacity 160ms ease, transform 200ms var(--ui-tsc-ease), color 160ms ease, box-shadow 160ms ease}:where(.ui-tsc) .ui-tsc__close{background: var(--ui-tsc-card);box-shadow: var(--ui-tsc-shadow);color: var(--ui-tsc-icon)}.ui-tsc__close::before{content: "";position: absolute;inset: -6px}.ui-tsc__close:hover{color: var(--ui-tsc-ink);box-shadow: var(--ui-tsc-shadow-hover)}.ui-tsc__toast:not([data-behind]):hover .ui-tsc__close, .ui-tsc__toast:not([data-behind]):focus-within .ui-tsc__close{opacity: 1;transform: none}.ui-tsc__glyph{width: 10px;height: 10px;fill: none;stroke: currentColor;stroke-width: 2.2;stroke-linecap: round}.ui-tsc__timer{position: absolute;left: 12px;right: 12px;bottom: 0;height: 1px;background: var(--ui-tsc-hairline);transform-origin: left;animation-name: ui-tsc-timer;animation-timing-function: linear;animation-fill-mode: both;transition: opacity 260ms ease}.ui-tsc__toast[data-type="success"] .ui-tsc__timer{background: color-mix(in oklab, var(--ui-tsc-success) 55%, transparent)}.ui-tsc__toast[data-type="error"] .ui-tsc__timer{background: color-mix(in oklab, var(--ui-tsc-danger) 55%, transparent)}.ui-tsc__toast[data-type="info"] .ui-tsc__timer{background: color-mix(in oklab, var(--ui-tsc-accent) 55%, transparent)}.ui-tsc__toast[data-type="warning"] .ui-tsc__timer{background: color-mix(in oklab, var(--ui-tsc-warning) 55%, transparent)}.ui-tsc__sr{position: absolute;width: 1px;height: 1px;overflow: hidden;clip-path: inset(50%);white-space: nowrap}@keyframes ui-tsc-spin{to{transform: rotate(360deg)}}@keyframes ui-tsc-draw{from{stroke-dashoffset: 1}to{stroke-dashoffset: 0}}@keyframes ui-tsc-pop{0%{transform: scale(0.82)}55%{transform: scale(1.08)}100%{transform: scale(1)}}@keyframes ui-tsc-timer{from{transform: scaleX(1)}to{transform: scaleX(0)}}@keyframes ui-tsc-text-in{from{opacity: 0;transform: translateY(4px);filter: blur(3px)}to{opacity: 1;transform: none;filter: none}}@keyframes ui-tsc-text-out{from{opacity: 1}to{opacity: 0;transform: translateY(-4px);filter: blur(3px)}}@container (max-width: 300px){.ui-tsc__content{padding: 10px 12px 10px 10px}}@media (max-width: 600px){.ui-tsc, .ui-tsc[data-x]{left: 12px;right: 12px;width: auto;max-width: none;transform: none}.ui-tsc[data-y="bottom"]{bottom: 12px}.ui-tsc:not([data-inline])[data-y="bottom"]{bottom: max(12px, env(safe-area-inset-bottom))}.ui-tsc[data-y="top"]{top: 12px}}@media (hover: none) and (pointer: coarse){.ui-tsc__toast:not([data-behind]) .ui-tsc__close{opacity: 1;transform: none}.ui-tsc__close{width: 24px;height: 24px;top: -8px;left: -8px}.ui-tsc__close::before{inset: -8px}.ui-tsc__action{height: 36px;margin: -8px -2px -8px 0;padding: 0 14px}}@media (prefers-reduced-motion: reduce){.ui-tsc *:not(.ui-tsc__spin):not(.ui-tsc__timer), .ui-tsc *::before, .ui-tsc *::after{animation: none !important;transition: none !important}}:where(.dark, [data-theme="dark"]) .ui-tsc{--ui-tsc-card: var(--popover, #1c1c1e);--ui-tsc-strong: var(--popover-foreground, #ffffff);--ui-tsc-ink: var(--foreground, rgba(255, 255, 255, 0.9));--ui-tsc-text: var(--muted-foreground, rgba(255, 255, 255, 0.62));--ui-tsc-icon: rgba(255, 255, 255, 0.46);--ui-tsc-faint: rgba(255, 255, 255, 0.3);--ui-tsc-hairline: rgba(255, 255, 255, 0.14);--ui-tsc-success: var(--state-pos-fg, #3ec27a);--ui-tsc-danger: var(--destructive, #ff6369);--ui-tsc-warning: #f5a524;--ui-tsc-accent: var(--state-info-fg, #4d8dff);--ui-tsc-focus: color-mix(in oklab, var(--ring, #4d8dff) 55%, transparent);--ui-tsc-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.4);--ui-tsc-shadow-hover: 0 0 0 0.5px rgba(255, 255, 255, 0.16), 0 1px 2px 0 rgba(0, 0, 0, 0.4);--ui-tsc-shadow-float: 0 0 0 1px var(--border, rgba(255, 255, 255, 0.1)), 0 1px 2px 0 rgba(0, 0, 0, 0.4), 0 16px 32px -12px rgba(0, 0, 0, 0.7)}:where(.dark, [data-theme="dark"]) .ui-tsc .ui-tsc__action{background: rgba(255, 255, 255, 0.06)}:where(.dark, [data-theme="dark"]) .ui-tsc .ui-tsc__close{background: var(--control-active, #2a2a2d)}`
