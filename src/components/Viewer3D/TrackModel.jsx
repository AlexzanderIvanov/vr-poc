import React, { useMemo } from 'react'
import { useGLTF } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import {
  cloneSceneWithMaterials,
  classifyTrackMesh,
  createTrackMaterialPalette,
  materialHasAuthoredAppearance,
  enhanceTrackMaterial,
  getOrthophotoPaletteKey,
  getTrackFallbackPaletteKey,
} from './helpers'
import { IS_MOBILE } from '../../utils/platform'
import { RED_TRACK_MESHES } from '../../trackRedMeshes'

export const TrackModel = React.memo(function TrackModel({ url }) {
  const { scene } = useGLTF(url)
  const { gl } = useThree()
  const track = useMemo(() => cloneSceneWithMaterials(scene), [scene])
  useMemo(() => {
    const palette = createTrackMaterialPalette()
    const categoryCount = {}
    const maxAnisotropy = Math.min(gl.capabilities.getMaxAnisotropy?.() ?? 1, 8)
    let preservedMaterialMeshes = 0
    let fallbackMaterialMeshes = 0

    // On mobile, drop the heavy mesh categories. Together these are ~918 of 1038
    // meshes; leaving just road / kerb / grass / markings keeps the track readable.
    const MOBILE_HIDDEN = new Set(['structure', 'fence', 'tyre', 'barrier', 'default'])
    const isAlwaysVisibleTrackSurface = (name) =>
      RED_TRACK_MESHES.has(name) || /^1nnnn_/i.test(name)

    track.traverse((node) => {
      if (!node.isMesh) return
      const category = classifyTrackMesh(node.name)
      categoryCount[category] = (categoryCount[category] || 0) + 1
      const keepOnMobile = isAlwaysVisibleTrackSurface(node.name)
      const hideOnMobile = IS_MOBILE && MOBILE_HIDDEN.has(category) && !keepOnMobile
      node.visible = category !== 'ignore' && !hideOnMobile
      if (category === 'ignore' || hideOnMobile) {
        if (hideOnMobile) {
          node.geometry?.dispose?.()
        }
        return
      }

      const originalMaterials = Array.isArray(node.material) ? node.material : [node.material]
      const keepOriginalMaterials = originalMaterials.length > 0 && originalMaterials.every((mat) => materialHasAuthoredAppearance(mat, node.geometry))
      const orthophotoPaletteKey = getOrthophotoPaletteKey(node.name)
      const explicitFallbackPaletteKey = getTrackFallbackPaletteKey(node.name, category)

      if (keepOriginalMaterials) {
        preservedMaterialMeshes += 1
        for (const mat of originalMaterials) {
          enhanceTrackMaterial(mat, category, maxAnisotropy)
        }
      } else if (orthophotoPaletteKey) {
        fallbackMaterialMeshes += 1
        node.material = palette[orthophotoPaletteKey]
      } else if (explicitFallbackPaletteKey) {
        fallbackMaterialMeshes += 1
        node.material = palette[explicitFallbackPaletteKey] ?? palette.default
      } else {
        fallbackMaterialMeshes += 1
        node.material = palette[category] ?? palette.default
      }

      node.castShadow = false
      node.receiveShadow = true
    })
    console.log('[TrackModel] categories:', JSON.stringify(categoryCount), 'preservedMaterialMeshes:', preservedMaterialMeshes, 'fallbackMaterialMeshes:', fallbackMaterialMeshes)
  }, [gl, track])
  return <primitive object={track} />
})
