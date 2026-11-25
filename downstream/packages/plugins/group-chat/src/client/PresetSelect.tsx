/**
 * The agent-preset field, built on the platform's own menu.
 *
 * This is the same control the new-session screen shows beside the workspace picker: the
 * platform paints that one with `Menu` and draws each row as a name over its description.
 * Reproducing the choice as a text box — or as a differently-shaped list — would make the same
 * concept look like two things depending on where the operator met it, so the dialog borrows
 * the platform's materials instead:
 *
 * - `Menu` for the dropdown, so the keyboard walk, outside-click dismissal and the portaled
 *   list behave exactly as they do on the hero chip.
 * - The platform's `settings.agentPreset` locale namespace for the shipped presets' names and
 *   descriptions. That copy is owned by the platform; reprinting it here would freeze today's
 *   wording and drift the moment the platform rewords it.
 *
 * What this deliberately does not do is import the platform's preset component: its props are
 * bound to the `conversation.hero.agentPreset` slot and carry a session plus a staged-selection
 * store this dialog has neither of. The roster comes from the Host instead, which reads the
 * same registry that slot renders.
 *
 * @module @sparkelf/dsh-group-chat/client/PresetSelect
 */

import { useState, type ReactNode } from 'react'
import { Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PresetOption } from './api.ts'
import { presetDisplay } from './rows.ts'
import styles from './PresetSelect.module.css'

export interface PresetSelectProps {
  /** Roster rows as the Host reported them, in its order. */
  readonly presets: readonly PresetOption[]
  /** The chosen preset id, or `''` for "the deployment's default". */
  readonly value: string
  /** Lookup for the platform's `settings.agentPreset` namespace. */
  readonly t: (key: string) => string
  /** Copy for the row that clears the choice back to the deployment default. */
  readonly defaultLabel: string
  readonly onChange: (id: string) => void
}

/**
 * Render the preset trigger and its menu.
 * @param props - roster, current choice, and the platform copy lookup.
 * @returns the anchored dropdown.
 */
export const PresetSelect = (props: PresetSelectProps): ReactNode => {
  const { presets, value, t, defaultLabel, onChange } = props
  const [open, setOpen] = useState(false)

  const chosen = presets.find((preset) => preset.id === value)
  const trigger = chosen === undefined ? defaultLabel : presetDisplay(chosen, t).name

  // A row's label is the name over its description, which the platform's menu styles as one
  // cell. `MenuEntry.label` is ReactNode, so the two lines travel together inside it rather
  // than through a second field the menu does not have.
  const entryOf = (preset: PresetOption): MenuEntry => {
    const { name, description } = presetDisplay(preset, t)
    return {
      id: preset.id,
      // A broken preset stays listed and disabled: hiding it would leave the operator unable to
      // tell a preset the deployment never declared from one it declared and could not activate.
      disabled: preset.broken !== undefined,
      label: (
        <span className={styles['row']}>
          <span className={styles['name']}>{name}</span>
          {description !== undefined && (
            <span className={styles['description']}>{description}</span>
          )}
        </span>
      ),
    }
  }
  // Shipped presets publish no name, so the split is the one the platform draws: the rows whose
  // copy it owns come first, and rows that name themselves in YAML follow.
  const items: MenuEntry[] = [
    ...presets.filter((preset) => preset.name === undefined).map(entryOf),
    ...presets.filter((preset) => preset.name !== undefined).map(entryOf),
  ]

  return (
    <Menu
      open={open}
      // Portaled: the dialog body scrolls and clips, and an in-place list would be cut off at
      // the field's edge once the roster grows past a couple of rows.
      portal
      side="bottom"
      align="start"
      items={items}
      selectedId={value.length === 0 ? undefined : value}
      onSelect={(id) => { onChange(id); setOpen(false) }}
      onClose={() => { setOpen(false) }}
      // The empty choice stays a menu row rather than a separate control: a room that omits the
      // preset inherits whatever the deployment defaults to, which is a different decision from
      // pinning today's default into the room's own record. Its id is the empty string the
      // dialog already uses for "not set", and no preset can shadow it — the registry rejects an
      // id that is empty.
      footer={[{ id: '', label: defaultLabel }]}
      anchor={(
        <button
          type="button"
          className={styles['trigger']}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => { setOpen((current) => !current) }}
        >
          <span className={styles['triggerLabel']}>{trigger}</span>
        </button>
      )}
    />
  )
}
