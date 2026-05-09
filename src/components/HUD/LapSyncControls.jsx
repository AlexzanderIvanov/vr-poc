import React, { useState } from 'react'

function SyncSlider({ label, value, onChange, min, max, step }) {
  return (
    <label className="sync-slider">
      <span className="sync-slider-label">{label} <span className="sync-slider-value">{value.toFixed(2)}</span></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  )
}

export function LapSyncControls({ lap, syncOffset, onSyncChange }) {
  const [expanded, setExpanded] = useState(false)
  const handleChange = (key, value) => onSyncChange(lap.id, { ...syncOffset, [key]: value })
  const handleReset = () => onSyncChange(lap.id, { forward: 0, left: 0, up: 0, yaw: 0 })
  const hasOffset = syncOffset.forward !== 0 || syncOffset.left !== 0 || syncOffset.up !== 0 || syncOffset.yaw !== 0
  return (
    <div className="sync-controls">
      <button className="sync-toggle" onClick={() => setExpanded((v) => !v)}>
        {expanded ? '▼' : '▶'} Sync{hasOffset ? ' *' : ''}
      </button>
      {expanded && (
        <div className="sync-sliders">
          <SyncSlider label="Forward" value={syncOffset.forward} onChange={(v) => handleChange('forward', v)} min={-10} max={10} step={0.1} />
          <SyncSlider label="Left" value={syncOffset.left} onChange={(v) => handleChange('left', v)} min={-10} max={10} step={0.1} />
          <SyncSlider label="Up" value={syncOffset.up} onChange={(v) => handleChange('up', v)} min={-5} max={5} step={0.05} />
          <SyncSlider label="Yaw" value={syncOffset.yaw} onChange={(v) => handleChange('yaw', v)} min={-15} max={15} step={0.1} />
          {hasOffset && <button className="sync-reset" onClick={handleReset}>Reset offsets</button>}
        </div>
      )}
    </div>
  )
}
