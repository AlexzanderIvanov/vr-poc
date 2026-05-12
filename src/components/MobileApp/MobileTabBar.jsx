import React from 'react'

/**
 * Mobile bottom-tab navigation. Each tab swaps the body panel by key
 * (matching an entry in `PANELS`), except `'settings'` which is a special
 * action the parent intercepts to open the bottom sheet instead.
 *
 * The keys here line up 1:1 with `PANELS` IDs so adding a new panel only
 * needs a registry entry + a tab below.
 */
export const MOBILE_TABS = [
  { key: 'viewer3d',  label: '3D',    icon: '🚗' },
  { key: 'trackmap',  label: 'Map',   icon: '🗺' },
  { key: 'telemetry', label: 'Speed & G', icon: '⚡' },
  { key: 'delta',     label: 'Δ',     icon: 'Δ'  },
  { key: 'settings',  label: 'More',  icon: '⚙'  },
]

export function MobileTabBar({ tabs, activeTab, onTab }) {
  return (
    <nav className="mobile-tabbar" role="tablist">
      {tabs.map((t) => {
        const isActive = t.key === activeTab
        return (
          <button
            key={t.key}
            role="tab"
            aria-selected={isActive}
            className={`mobile-tab ${isActive ? 'is-active' : ''}`}
            onClick={() => onTab(t.key)}
          >
            <span className="mobile-tab-icon" aria-hidden="true">{t.icon}</span>
            <span className="mobile-tab-label">{t.label}</span>
          </button>
        )
      })}
    </nav>
  )
}
