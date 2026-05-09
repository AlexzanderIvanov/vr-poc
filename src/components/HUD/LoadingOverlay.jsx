import React from 'react'
import { useProgress } from '@react-three/drei'

export function LoadingOverlay() {
  const { active, progress, loaded, total, item } = useProgress()
  if (!active && progress >= 100) return null
  const shortItem = item ? item.split('/').pop()?.split('?')[0] : ''
  return (
    <div className="loading-overlay">
      <div className="loading-content">
        <div className="loading-title">Loading track & car assets</div>
        <div className="loading-bar">
          <div className="loading-bar-fill" style={{ width: `${progress}%` }} />
        </div>
        <div className="loading-progress">{progress.toFixed(0)}%</div>
        <div className="loading-detail">
          {shortItem ? `${shortItem} • ${loaded}/${total}` : 'Preparing scene...'}
        </div>
      </div>
    </div>
  )
}
