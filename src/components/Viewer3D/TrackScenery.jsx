import React from 'react'

// Ground plane that fills the void around the actual laser-scanned track geometry.
// No procedural scenery — the track itself is the single source of truth.
export const TrackScenery = React.memo(function TrackScenery() {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[475, 4, 290]} receiveShadow>
      <planeGeometry args={[2400, 2400]} />
      <meshStandardMaterial color="#4a6a3a" roughness={1} metalness={0} envMapIntensity={0.08} />
    </mesh>
  )
})
