import * as THREE from 'three'
import { DDSLoader } from 'three/examples/jsm/loaders/DDSLoader.js'
import { assetUrl } from '../../config'
import { IS_MOBILE } from '../../utils/platform'
import { sampleLap, applySyncOffset } from '../../utils/sampleLap'
import { RED_TRACK_MESHES } from '../../trackRedMeshes'

/**
 * Shared helpers used by the Viewer3D components.
 *
 * - `cloneSceneWithMaterials` — deep clone a glTF scene with per-instance
 *   material clones (so palette / overrides don't bleed across cars).
 * - `classifyTrackMesh` — name-based bucket (road / kerb / barrier / …) for
 *   the track GLB, used to pick a palette material.
 * - `createTrackMaterialPalette` — build the per-category materials from the
 *   asphalt / curb / barrier / wall textures. Mobile path swaps in flat
 *   Lambert materials for everything except the road surface.
 * - `materialHasAuthoredAppearance` — heuristic: keep the GLB-authored
 *   material when it has its own textures or non-white tint.
 * - `enhanceTrackMaterial` — anisotropy + envMap tweaks for category-specific
 *   readability.
 * - `getOrthophotoPaletteKey` / `getTrackFallbackPaletteKey` — name-based
 *   palette overrides (orthophoto disabled; fallback handles the AC mesh
 *   naming conventions for track extensions and pit lane).
 * - `eventScenePosition` — sample a lap at an event time, apply the live
 *   sync offset, return the world-space position used by `<TrackMarkers>`.
 * - `sampleColor` / `PHASE_COLORS` / `PHASE_LABELS` — helpers for the
 *   speed-coloured trajectory polyline.
 */

export function cloneSceneWithMaterials(sourceScene) {
  const clone = sourceScene.clone(true)
  clone.traverse((node) => {
    if (node.isMesh && node.material) {
      if (Array.isArray(node.material)) {
        node.material = node.material.map((material) => material.clone())
      } else {
        node.material = node.material.clone()
      }
      node.castShadow = true
      node.receiveShadow = true
    }
  })
  return clone
}

export function classifyTrackMesh(name) {
  const lower = name.toLowerCase()
  if (lower === 'cube') return 'ignore'
  if (lower.includes('wall_pitlane') || lower.includes('banner')) return 'ignore'
  if (lower.includes('marking') || lower.includes('pitlane')) return 'markings'
  if (lower.startsWith('ks_start_light') || lower.includes('brakemark')) return 'structure'
  if (lower.includes('road') || lower.includes('asph') || lower.startsWith('1pit_') || lower.startsWith('1pit1')) return 'road'
  if (lower.includes('kerb') || lower.includes('curb')) return 'kerb'
  if (lower.includes('grass')) return 'grass'
  if (lower.includes('sand')) return 'sand'
  if (lower.includes('water')) return 'water'
  if (lower.includes('tyre') || lower.includes('tire')) return 'tyre'
  if (lower.includes('mreja') || lower.includes('fence') || lower.includes('net')) return 'fence'
  if (
    lower.includes('wall') || lower.includes('barrier') || lower.includes('armco') ||
    lower.includes('bariera') || lower.startsWith('kol4e') || lower.startsWith('vajeta')
  ) return 'barrier'
  if (
    lower.includes('box') || lower.includes('bridge') || lower.includes('tabela') ||
    lower.includes('tabla') || lower.includes('sign') || lower.includes('building') ||
    lower.includes('garage') || lower.includes('tribune') || lower.includes('grandstand') ||
    lower.includes('pillar') || lower.includes('tower') || lower.includes('light') ||
    lower.includes('lamp_post') || lower.includes('stulb')
  ) return 'structure'
  return 'default'
}

export function createTrackMaterialPalette() {
  if (IS_MOBILE) {
    const loader = new THREE.TextureLoader()
    const ddsLoader = new DDSLoader()
    const ANISO = 16
    const prep = (tex, colorSpace) => {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping
      tex.colorSpace = colorSpace
      tex.anisotropy = ANISO
      tex.minFilter = THREE.LinearMipmapLinearFilter
      tex.magFilter = THREE.LinearFilter
      tex.generateMipmaps = true
      return tex
    }
    const asphaltTex = prep(loader.load(assetUrl('/assets/textures/Asphalt5_4096_A.jpg')), THREE.SRGBColorSpace)
    const asphaltRoughnessTex = prep(loader.load(assetUrl('/assets/textures/Asphalt5_4096_ROUGHNESS.jpg')), THREE.NoColorSpace)
    const asphaltNormalTex = prep(ddsLoader.load(assetUrl('/assets/textures/asph8_NM.dds')), THREE.NoColorSpace)

    const asphalt = (color, extra = {}) => new THREE.MeshStandardMaterial({
      map: asphaltTex, normalMap: asphaltNormalTex, roughnessMap: asphaltRoughnessTex,
      color, roughness: 1.0, metalness: 0.0,
      normalScale: new THREE.Vector2(0.9, 0.9), envMapIntensity: 0.18,
      ...extra,
    })
    const flat = (color) => new THREE.MeshLambertMaterial({ color })
    return {
      road: asphalt('#9a9a9a'), markings: asphalt('#d4d4d4'),
      kerb: flat('#cc3333'), grass: flat('#4a6b3a'), sand: flat('#a8916b'),
      barrier: flat('#c8c8c8'), tyre: flat('#111111'),
      fence: flat('#8a8a8a'), structure: flat('#7a7a7a'), water: flat('#1a4d66'),
      roadMain: asphalt('#9a9a9a'),
      roadRed: asphalt('#b0322a', { map: null, roughness: 0.85 }),
      roadGreen: asphalt('#4a7a4a'),
      roadWhite: asphalt('#d6d6d6'),
      pitlane: flat('#b0b0b0'), default: flat('#5a5f66'),
    }
  }

  const loader = new THREE.TextureLoader()
  const ddsLoader = new DDSLoader()
  const loadTex = (path, repeat = null, colorSpace = THREE.SRGBColorSpace) => {
    const tex = loader.load(assetUrl(path))
    if (repeat) {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping
      tex.repeat.set(repeat[0], repeat[1])
    } else {
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
    }
    tex.colorSpace = colorSpace
    return tex
  }
  const loadDdsTex = (path, repeat = [1, 1], colorSpace = THREE.SRGBColorSpace) => {
    const tex = ddsLoader.load(assetUrl(path))
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping
    tex.repeat.set(repeat[0], repeat[1])
    tex.colorSpace = colorSpace
    return tex
  }

  const asphaltTex = loadTex('/assets/textures/Asphalt5_4096_A.jpg', [1, 1], THREE.SRGBColorSpace)
  const asphaltRoughnessTex = loadTex('/assets/textures/Asphalt5_4096_ROUGHNESS.jpg', [1, 1], THREE.NoColorSpace)
  const asphaltNormalTex = loadDdsTex('/assets/textures/asph8_NM.dds', [1, 1], THREE.NoColorSpace)
  const concreteTex = loadTex('/assets/textures/Concrete_detail.jpg', [30, 30])
  const barrierTex = loadTex('/assets/textures/f05bf7f6_Road_Barrier_Diff_3dh_srgb.jpg', [4, 4])
  const wallTex = loadTex('/assets/textures/wall_D.jpg', [10, 10])
  const kerbTex = loadDdsTex('/assets/textures/curb1_albedo.dds', [1, 1])
  const pitlaneTex = loadDdsTex('/assets/textures/concrete_box.dds', [8, 8])

  const makeAsphalt = (color, extra = {}) => new THREE.MeshStandardMaterial({
    map: asphaltTex,
    normalMap: asphaltNormalTex,
    roughnessMap: asphaltRoughnessTex,
    color,
    roughness: 1.0,
    metalness: 0.0,
    normalScale: new THREE.Vector2(0.6, 0.6),
    envMapIntensity: 0.15,
    ...extra,
  })

  return {
    road: makeAsphalt('#9a9a9a'),
    markings: makeAsphalt('#d4d4d4', { envMapIntensity: 0.2 }),
    kerb: new THREE.MeshStandardMaterial({ map: kerbTex, color: '#ffffff', roughness: 0.8, metalness: 0.0, envMapIntensity: 0.08 }),
    grass: new THREE.MeshStandardMaterial({ color: '#4a6b3a', roughness: 1.0, metalness: 0.0, envMapIntensity: 0.05 }),
    sand: new THREE.MeshStandardMaterial({ color: '#a8916b', roughness: 1.0, metalness: 0.0, envMapIntensity: 0.05 }),
    barrier: new THREE.MeshStandardMaterial({ map: barrierTex, roughness: 0.6, metalness: 0.15, envMapIntensity: 0.4 }),
    tyre: new THREE.MeshStandardMaterial({ color: '#111111', roughness: 0.98, metalness: 0.0, envMapIntensity: 0.05 }),
    fence: new THREE.MeshStandardMaterial({ map: wallTex, color: '#8a8a8a', roughness: 0.5, metalness: 0.35, envMapIntensity: 0.5 }),
    structure: new THREE.MeshStandardMaterial({ map: concreteTex, color: '#7a7a7a', roughness: 0.7, metalness: 0.1, envMapIntensity: 0.3 }),
    water: new THREE.MeshStandardMaterial({ color: '#1a4d66', roughness: 0.15, metalness: 0.05, envMapIntensity: 0.8 }),
    roadMain: makeAsphalt('#9a9a9a'),
    roadRed: makeAsphalt('#b0322a', { map: null, envMapIntensity: 0.15, roughness: 0.85 }),
    roadGreen: makeAsphalt('#4a7a4a', { envMapIntensity: 0.1 }),
    roadWhite: makeAsphalt('#d6d6d6'),
    pitlane: new THREE.MeshStandardMaterial({ map: pitlaneTex, color: '#b0b0b0', roughness: 0.9, metalness: 0.0, envMapIntensity: 0.08 }),
    default: new THREE.MeshStandardMaterial({ color: '#5a5f66', roughness: 0.8, metalness: 0.05, envMapIntensity: 0.2 }),
  }
}

export function materialHasAuthoredAppearance(material, geometry) {
  if (!material) return false
  if (material.map || material.normalMap || material.roughnessMap || material.metalnessMap || material.aoMap || material.emissiveMap || material.alphaMap) {
    return true
  }
  if (material.vertexColors || geometry?.getAttribute('color')) return true
  if ((material.transparent && (material.opacity ?? 1) < 1) || (material.emissive && material.emissive.getHex() !== 0x000000)) {
    return true
  }
  const colorHex = material.color?.getHex?.()
  return colorHex !== undefined && colorHex !== 0xffffff
}

export function enhanceTrackMaterial(material, category, maxAnisotropy) {
  if (!material) return
  material.toneMapped = true
  material.envMapIntensity = Math.max(material.envMapIntensity ?? 0, 0.35)

  for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap']) {
    const texture = material[key]
    if (texture) {
      texture.anisotropy = Math.max(texture.anisotropy ?? 1, maxAnisotropy)
    }
  }

  if (category === 'road' || category === 'markings') {
    material.roughness = THREE.MathUtils.clamp(material.roughness ?? 0.9, 0.55, 1)
    material.metalness = Math.min(material.metalness ?? 0, 0.08)
  }

  if (category === 'fence') {
    material.side = THREE.DoubleSide
  }

  material.needsUpdate = true
}

export function getOrthophotoPaletteKey() {
  // Orthophoto projection disabled — the exported GLB UVs are not aligned to the drone
  // aerial photo coordinates (multi-UV channels from AC aren't preserved when exporting
  // with materials="NONE"). Meshes that would have used the orthophoto now fall through
  // to grass/sand/category materials which gives a clean uniform look.
  return null
}

export function getTrackFallbackPaletteKey(name, category) {
  const lower = name.toLowerCase()
  if (lower.startsWith('1road_main_part')) return 'roadMain'
  if (lower === '1pit_0' || lower === '1pit1') return 'roadMain'
  if (lower.startsWith('1pit_0-1') || lower.startsWith('1pit1-1')) return 'pitlane'
  if (lower.startsWith('1pit_0-2') || lower.startsWith('1pit1-2')) return 'roadMain'
  if (RED_TRACK_MESHES.has(name)) return 'roadRed'
  if (/^1road_extra_part\d+-([2-9]|\d{2,})$/.test(lower)) return 'roadRed'
  if (lower.startsWith('1road_extra_part')) return 'roadMain'
  if (lower.startsWith('1road_006')) return 'roadMain'
  if (lower.startsWith('1road_10')) return 'roadMain'
  if (category === 'road') return 'roadMain'
  return null
}

export function eventScenePosition(event, lap, syncOffset) {
  if (event?.t != null && lap?.samples?.length) {
    const sampled = sampleLap(lap.samples, event.t)
    if (sampled) {
      const { position } = applySyncOffset(sampled.position, sampled.quaternion, syncOffset)
      return position.toArray()
    }
  }
  return event?.position ?? null
}

// Trajectory phase thresholds. Tuned for AIM brake-pressure (`fbp`, 0..~150 bar)
// and throttle (`tps`, 0..255 raw). The previous values (`fbp > 10 && tps < 200`)
// hid two real cases: light brake taps (fbp 1–10) read as coasting, and
// trail-braking with throttle co-applied (tps ≥ 200) read as throttle. Now
// brake takes priority whenever any brake pressure is present, and throttle
// kicks in just above ~10 % pedal so corner-exit throttle pickup colours the
// line right away instead of waiting for the half-pedal mark.
const BRAKE_MIN = 0    // any nonzero brake → braking
const TPS_MIN   = 25   // ~10 % pedal → throttle (above sensor / pedal-rest noise)

export function sampleColor(tel, idx) {
  if (!tel?.samples?.[idx]) return [0.38, 0.49, 0.55]
  const s = tel.samples[idx]
  // Brake takes priority over throttle so trail-braking and left-foot
  // braking both colour as braking instead of fighting throttle for the
  // sample.
  if (s.fbp > BRAKE_MIN) {
    const intensity = Math.min(s.fbp / 120, 1)
    return [0.6 + 0.4 * intensity, 0.1 * (1 - intensity), 0.1 * (1 - intensity)]
  }
  if (s.tps >= TPS_MIN) {
    const intensity = Math.min(s.tps / 255, 1)
    return [0.2 * (1 - intensity), 0.45 + 0.35 * intensity, 0.15 * (1 - intensity)]
  }
  return [0.38, 0.49, 0.55]
}
