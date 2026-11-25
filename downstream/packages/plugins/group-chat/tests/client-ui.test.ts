import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { en, zh, type GroupChatKey } from '../src/client/locales.ts'

/**
 * The client half's components are React and the repository ships no DOM test
 * environment, so what is checked here is the part that does not need one: the copy
 * contract. The data path is covered by `client.test.ts`, the shared store by
 * `store.test.ts`, and the built bundle's shape by `bundle.test.ts`.
 */
describe('copy', () => {
  const keys = Object.keys(en) as GroupChatKey[]

  it('covers every key in both locales', () => {
    // `zh` is declared `satisfies Record<GroupChatKey, string>`, so a missing key is a
    // compile error; this asserts the same thing at runtime for the reverse direction.
    expect(Object.keys(zh).sort()).toEqual(keys.slice().sort())
  })

  it('leaves no copy blank', () => {
    for (const key of keys) {
      expect(en[key].trim().length, `en.${key}`).toBeGreaterThan(0)
      expect(zh[key].trim().length, `zh.${key}`).toBeGreaterThan(0)
    }
  })

  it('names the three settings, so the third dimension is not left unlabelled', () => {
    for (const t of [en, zh]) {
      expect(t.policy).toBeTruthy()
      expect(t.discoverability).toBeTruthy()
      expect(t.trigger).toBeTruthy()
      // All three trigger options must be selectable, including the record-only one.
      expect(t.triggerMention).toBeTruthy()
      expect(t.triggerAlways).toBeTruthy()
      expect(t.triggerNever).toBeTruthy()
    }
  })

  it('describes every distinguishable failure, none of them generically', () => {
    for (const t of [en, zh]) {
      expect(t.notConfigured).toBeTruthy()
      expect(t.unreachable).toBeTruthy()
      expect(t.credentialMissing).toBeTruthy()
    }
    expect(new Set([en.notConfigured, en.unreachable, en.credentialMissing]).size).toBe(3)
  })
})

describe('房间复用官方的对话面板', () => {
  // 房间的每条消息就是该 Session 日志上的一条 `user/message`，所以 shell 自己的 Conversation
  // 已经会渲染它们：气泡、markdown、工具调用、流式、滚动都在。插件要做的只有一件事——打开
  // 那个 Session。任何自己画的第二套渲染器都得跟着第一套追，还会静默丢掉 Conversation 之后
  // 获得的每个特性。
  const CLIENT = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')

  it('打开房间就是打开它的 Session', () => {
    expect(CLIENT).toContain('ctx.uiWorkspace.openSession(roomSessionId(roomId))')
  })

  it('不注册自己的 main 面板或对话视图', () => {
    // 这两条都会让插件接管渲染，而不是复用 shell 的。
    expect(CLIENT).not.toContain("name: 'main'")
    expect(CLIENT).not.toContain("name: 'conversation.view'")
  })

  it('依赖 workspace 导航服务', () => {
    expect(CLIENT).toMatch(/inject = \[[^\]]*'uiWorkspace'/u)
  })

  it('服务按结构声明，不依赖服务当前所属的包', () => {
    expect(CLIENT).toContain('interface WorkspaceNavigation')
    expect(CLIENT).toContain('openSession(sessionId: string): void')
  })
})

describe('气泡左右分侧复用官方渲染器', () => {
  const CLIENT_SRC = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')

  it('从槽位注册表里取回官方渲染器，而不是重画气泡', () => {
    // The official `user` cell already renders markdown, images, file and skill references,
    // per-message actions and streaming. Re-drawing it here would mean tracking all of that
    // forever, so the wrapper renders the official component inside a placement layer.
    //
    // The lookup reads `entries`, not `entriesOfSlot`: that projection returns the shadowing
    // *winners*, and this plugin is about to become the winner of the very cell it needs to
    // read past, so it would hand back this plugin's own component.
    expect(CLIENT_SRC).toMatch(/ctx\.slots\.entries\('conversation\.chat\.node'\)/u)
    expect(CLIENT_SRC).not.toMatch(/entriesOfSlot\('conversation\.chat\.node'\)/u)
    expect(CLIENT_SRC).toMatch(/entry\.options\.key === key/u)
  })

  it('等官方渲染器注册后再认领，而不是只读一次账本', () => {
    // `slots.inject` re-runs on a *declaration* change, and the Chat node slot is declared by
    // the shell before any renderer registers. Reading the ledger once therefore finds no
    // official `user` view — and registering nothing is invisible, because the cells simply
    // keep their official alignment with no error to say why. Verified live: the ledger held
    // only `tool-call` at that moment. The subscription is what makes the claim happen
    // whenever the official renderers actually arrive.
    expect(CLIENT_SRC).toMatch(/ctx\.slots\.subscribe\('conversation\.chat\.node', reconcile\)/u)
  })

  it('官方渲染器取不到时不注册这一格', () => {
    // A wrapper without the official view renders nothing, which would blank every message of
    // that cell in every Session — far worse than leaving the bubble where it is. The
    // subscription gives it another chance once the renderer does arrive.
    expect(CLIENT_SRC).toMatch(/if \(official === undefined\) continue/u)
  })

  it('user 和 steering 两格都认领', () => {
    // A room message is `steering` once a turn has claimed it and `user` otherwise, and both
    // cells render the same official component. Claiming only `user` leaves exactly the
    // messages that arrived while the agent was working on the official (right) side.
    expect(CLIENT_SRC).toMatch(/CHAT_NODE_KEYS = \['user', 'steering'\]/u)
    expect(CLIENT_SRC).toMatch(/for \(const key of CHAT_NODE_KEYS\)/u)
  })

  it('用负优先级赢下 user 这一格（官方在 0）', () => {
    // The cell is chosen by priority: the renderer keeps the lowest live entry, and the
    // official one registers at the default `0`. The value is a named constant because the
    // occupancy guard has to compare against the same number.
    expect(CLIENT_SRC).toMatch(/const SHADOW_PRIORITY = -1/u)
    expect(CLIENT_SRC).toMatch(/priority: SHADOW_PRIORITY/u)
  })

  it('注册时声明官方 chat 命名空间', () => {
    // The seat synthesizes a component's `t` prop from the namespace its registration
    // declares, and the official bubble looks up `chat` keys. Omitting it leaves the bubble
    // translating against nothing and printing raw keys.
    expect(CLIENT_SRC).toMatch(/locale: 'chat'/u)
  })

  it('身份按快照读取，而不是注册时捕获', () => {
    // Identity is fetched after the first paint. A value captured when this renderer was
    // registered would stay undefined for the life of the page, leaving every message on the
    // unknown-author side with nothing left to correct it.
    expect(CLIENT_SRC).toMatch(/getSelfId: store\.selfId/u)
    expect(CLIENT_SRC).not.toMatch(/selfId: store\.selfId\(\)/u)
  })
})

describe('重复评估时不会因同优先级再注册而失败', () => {
  const SRC = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')

  it('占用按 key + priority 判定，而不是按组件身份', () => {
    // The client bundle can be evaluated more than once in one page (a reload, or the HMR
    // receiver re-running the factory). Each evaluation builds its own wrapper component, so
    // an identity comparison misses the previous evaluation's entry, `register` throws at the
    // same priority, and the whole contribution is lost.
    expect(SRC).toMatch(/entry\.options\.priority \?\? 0\) === SHADOW_PRIORITY/u)
    expect(SRC).not.toMatch(/entry\.component === OUR_VIEW/u)
  })

  it('注册被拒时只跳过该格，不放弃整份贡献', () => {
    // Letting the throw escape aborts the `inject` callback, which also drops the wiring the
    // room list needs. A skipped cell keeps the official placement, which is a visible-enough
    // degradation to diagnose from the console line.
    expect(SRC).toMatch(/try \{\s*dispose = ctx\.slots\.register/u)
    expect(SRC).toMatch(/catch \(error\) \{\s*logClaimFailure\(key, error\)/u)
  })

  it('失败时在控制台点名是哪一格', () => {
    expect(SRC).toMatch(/logClaimFailure/u)
    expect(SRC).toMatch(/console\.warn/u)
  })
})

describe('guide tile', () => {
  // The start guide's shared sheet addresses entries by `data-sidebar-right-guide-entry`; a
  // replacement that omits it keeps the shell's horizontal capsule instead of the square tile.
  const entry = readFileSync(new URL('../src/client/GuideEntry.tsx', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../src/client/GuideEntry.module.css', import.meta.url), 'utf8')

  it('marks the box with the guide entry attribute and a 22px glyph', () => {
    expect(entry).toContain('data-sidebar-right-guide-entry={props.kind}')
    expect(entry).toContain('<svg width="22" height="22"')
  })

  it('lays the box out as the tile: full cell, centered column, 12px padding', () => {
    expect(css).toMatch(/\.entry \{[^}]*flex-direction: column/u)
    expect(css).toMatch(/\.entry \{[^}]*width: 100%/u)
    expect(css).toMatch(/\.entry \{[^}]*height: 100%/u)
    expect(css).toMatch(/\.entry \{[^}]*padding: 12px/u)
    expect(css).toMatch(/\.icon \{[^}]*width: 22px/u)
  })
})

describe('native quote only', () => {
  // Quoting is the shell's own selection interaction (message-quotes): select message text, pick
  // 引用, and the official composer inserts the atomic quote. The room must not carry a second,
  // button-driven quote surface of its own.
  const side = readFileSync(new URL('../src/client/MessageSide.tsx', import.meta.url), 'utf8')
  const client = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')

  it('draws no reply button and registers no quote dock', () => {
    expect(side).not.toContain('data-group-chat-reply')
    expect(side).not.toContain('replyButton')
    expect(client).not.toContain('conversation.input.dock')
    expect(client).not.toContain('createQuoteStore')
  })
})
