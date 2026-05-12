import React from 'react'
import { DESKTOP_SHORTCUTS } from '../../hooks/useDesktopShortcuts'

/**
 * Modal-style overlay listing every keyboard shortcut the desktop
 * app honours. Triggered by `?` / `H` and dismissed by `Esc` /
 * click-outside / `×`. Renders a frosted-glass card centred on
 * screen with two-column rows (key chip + description).
 *
 * Data lives in `useDesktopShortcuts.DESKTOP_SHORTCUTS` so this and
 * the listener can't drift out of sync.
 */
export function ShortcutsHelp({ open, onClose }) {
  if (!open) return null
  return (
    <>
      <div className="shortcuts-help-backdrop" onClick={onClose} />
      <div className="shortcuts-help" role="dialog" aria-label="Keyboard shortcuts">
        <header className="shortcuts-help-header">
          <span>Keyboard shortcuts</span>
          <button
            type="button"
            className="shortcuts-help-close"
            onClick={onClose}
            aria-label="Close help"
          >
            ×
          </button>
        </header>
        <div className="shortcuts-help-body">
          {DESKTOP_SHORTCUTS.map((row) => (
            <div className="shortcuts-help-row" key={row.label}>
              <span className="shortcuts-help-keys">
                {row.keys.map((k) => (
                  <kbd key={k} className="shortcuts-help-kbd">{k}</kbd>
                ))}
              </span>
              <span className="shortcuts-help-label">{row.label}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}
