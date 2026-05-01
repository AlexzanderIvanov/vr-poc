import React, { Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Environment, Html, Line, OrbitControls, PerspectiveCamera, useGLTF, useProgress } from '@react-three/drei'
import * as THREE from 'three'
import { DDSLoader } from 'three/examples/jsm/loaders/DDSLoader.js'
import { usePlayback } from './hooks/usePlayback'
import { ORTHOPHOTO_GROUPS } from './trackOrthophotoGroups'
import { RED_TRACK_MESHES } from './trackRedMeshes'
import { computeCornerAnalysis, pairCorners, addSectorArcLengths, totalLapArcLength } from './utils/cornerAnalysis'
import { assetUrl } from './config'


function cloneSceneWithMaterials(sourceScene) {
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


function classifyTrackMesh(name) {
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


// Detected once at load. Used to strip textures / heavy meshes on mobile GPUs
// which crash under the full desktop asset load (1038 meshes + 65MB textures).
const IS_MOBILE = typeof navigator !== 'undefined' && (
  /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (typeof window !== 'undefined' && window.location?.search?.includes('mobile=1'))
)

function createTrackMaterialPalette() {
  // On mobile, load ONLY the asphalt texture stack (road surface — the bit users
  // actually look at) and render everything else as flat Lambert colors. That
  // preserves the race-surface look while keeping GPU memory and texture upload
  // cost ~1/10 of the desktop load.
  if (IS_MOBILE) {
    const loader = new THREE.TextureLoader()
    const ddsLoader = new DDSLoader()
    // Max anisotropic filtering kills the shimmering/stretched look at grazing
    // angles where the asphalt tiles meet the horizon. Mobile GPUs typically
    // support 16x; three.js clamps to what the HW reports.
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
      // Stronger normal than desktop to make up for the lack of shadow contrast.
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

  // Road mesh UVs already span multi-unit ranges (e.g. U[-40..33] V[-76..2]) — they carry
  // built-in tiling from the AC source. Load asphalt textures with repeat=[1,1] and
  // let mesh UVs drive the tile density. Setting repeat > 1 multiplies that and produces
  // aliased grey. Kerb/grass meshes have 0..1 UVs so they respect repeat naturally.
  const asphaltTex = loadTex('/assets/textures/Asphalt5_4096_A.jpg', [1, 1], THREE.SRGBColorSpace)
  const asphaltRoughnessTex = loadTex('/assets/textures/Asphalt5_4096_ROUGHNESS.jpg', [1, 1], THREE.NoColorSpace)
  const asphaltNormalTex = loadDdsTex('/assets/textures/asph8_NM.dds', [1, 1], THREE.NoColorSpace)
  const concreteTex = loadTex('/assets/textures/Concrete_detail.jpg', [30, 30])
  const barrierTex = loadTex('/assets/textures/f05bf7f6_Road_Barrier_Diff_3dh_srgb.jpg', [4, 4])
  const wallTex = loadTex('/assets/textures/wall_D.jpg', [10, 10])
  const kerbTex = loadDdsTex('/assets/textures/curb1_albedo.dds', [1, 1])
  const pitlaneTex = loadDdsTex('/assets/textures/concrete_box.dds', [8, 8])

  // Main asphalt PBR material — used for all road variants
  const makeAsphalt = (color, extra = {}) => new THREE.MeshStandardMaterial({
    map: asphaltTex,
    normalMap: asphaltNormalTex,
    roughnessMap: asphaltRoughnessTex,
    color,
    roughness: 1.0,  // scaled by roughness map
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
    // Road variants — share the same PBR asphalt with color tint hints
    roadMain: makeAsphalt('#9a9a9a'),
    // Painted red run-off: drop albedo map (grey stones × dark red tint → muddy grey),
    // keep normal + roughness maps for asphalt texture detail, use a pure saturated red.
    roadRed: makeAsphalt('#b0322a', { map: null, envMapIntensity: 0.15, roughness: 0.85 }),
    roadGreen: makeAsphalt('#4a7a4a', { envMapIntensity: 0.1 }),
    roadWhite: makeAsphalt('#d6d6d6'),
    pitlane: new THREE.MeshStandardMaterial({ map: pitlaneTex, color: '#b0b0b0', roughness: 0.9, metalness: 0.0, envMapIntensity: 0.08 }),
    default: new THREE.MeshStandardMaterial({ color: '#5a5f66', roughness: 0.8, metalness: 0.05, envMapIntensity: 0.2 }),
  }
}


function materialHasAuthoredAppearance(material, geometry) {
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


function enhanceTrackMaterial(material, category, maxAnisotropy) {
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


function getOrthophotoPaletteKey() {
  // Orthophoto projection disabled — the exported GLB UVs are not aligned to the drone
  // aerial photo coordinates (multi-UV channels from AC aren't preserved when exporting
  // with materials="NONE"). Meshes that would have used the orthophoto now fall through
  // to grass/sand/category materials which gives a clean uniform look.
  return null
}


function getTrackFallbackPaletteKey(name, category) {
  const lower = name.toLowerCase()

  if (lower.startsWith('1road_main_part')) return 'roadMain'

  if (lower === '1pit_0' || lower === '1pit1') return 'roadMain'
  if (lower.startsWith('1pit_0-1') || lower.startsWith('1pit1-1')) return 'pitlane'
  if (lower.startsWith('1pit_0-2') || lower.startsWith('1pit1-2')) return 'roadMain'

  // Red track edging — exact mesh list dumped from Blender scene (material "4ERWENO").
  // See src/trackRedMeshes.js. Uses original case-sensitive mesh name.
  if (RED_TRACK_MESHES.has(name)) return 'roadRed'
  // Fallback: AC-standard suffix convention for road extension reds.
  if (/^1road_extra_part\d+-([2-9]|\d{2,})$/.test(lower)) return 'roadRed'
  if (lower.startsWith('1road_extra_part')) return 'roadMain'
  if (lower.startsWith('1road_006')) return 'roadMain'
  if (lower.startsWith('1road_10')) return 'roadMain'

  if (category === 'road') return 'roadMain'
  return null
}


// Cardinal spline with tension parameter — damps Catmull-Rom overshoot in tight corners
// tension 0 = standard Catmull-Rom (can overshoot), tension 1 = linear (no overshoot)
function catmullRom(p0, p1, p2, p3, t, tension = 0.5) {
  // tension 0 = standard CR, tension 1 = linear (no overshoot)
  const k = (1 - tension) * 0.5
  const t2 = t * t
  const t3 = t2 * t
  const m1 = k * (p2 - p0)
  const m2 = k * (p3 - p1)
  const h00 = 2*t3 - 3*t2 + 1
  const h10 = t3 - 2*t2 + t
  const h01 = -2*t3 + 3*t2
  const h11 = t3 - t2
  return h00 * p1 + h10 * m1 + h01 * p2 + h11 * m2
}

// Apply a 2D rigid map-fit upgrade to freshly-loaded lap/telemetry payloads,
// in-place. The transform is a rotation around web +Y axis (right-hand rule,
// matching three.js setFromAxisAngle) plus a horizontal translation:
//
//     pos_new.x = cos(angle) * pos.x + sin(angle) * pos.z + tx
//     pos_new.z = -sin(angle) * pos.x + cos(angle) * pos.z + tz
//     pos_new.y = pos.y                       (altitude unchanged)
//     quat_new  = Q(angle, axis = +Y) * quat   (heading rotates the same way)
//
// Note the cross-term signs: this is the standard three.js Y-rotation
// (`right-hand rule`), NOT the textbook 2D rotation matrix. The two differ
// in handedness because the Blender→Web exporter flips one axis sign
// (web.z = -blender.y); a textbook rotation here would rotate position in
// one direction while the quaternion (which uses Three's convention via
// setFromAxisAngle) rotates in the opposite — they would visibly diverge.
//
// Used when a manifest carries a ``consensus_delta`` field. Mutates the
// payloads directly to avoid copying ~2300 samples per lap.
const _consensusDeltaY = new THREE.Vector3(0, 1, 0)
function consensusDeltaParams(delta, includeQuaternion = false) {
  if (!delta) return null
  const angleRad = (delta.angle_deg || 0) * Math.PI / 180
  const tx = delta.tx || 0
  const tz = delta.tz || 0
  if (Math.abs(angleRad) < 1e-9 && Math.abs(tx) < 1e-9 && Math.abs(tz) < 1e-9) return null
  return {
    c: Math.cos(angleRad),
    s: Math.sin(angleRad),
    tx,
    tz,
    qDelta: includeQuaternion ? new THREE.Quaternion().setFromAxisAngle(_consensusDeltaY, angleRad) : null,
  }
}

function applyConsensusDeltaToPosition(position, params) {
  if (!params || !Array.isArray(position) || position.length < 3) return
  const x = position[0]
  const z = position[2]
  position[0] = params.c * x + params.s * z + params.tx
  position[2] = -params.s * x + params.c * z + params.tz
}

function applyConsensusDelta(samples, delta) {
  if (!samples || !samples.length) return
  const params = consensusDeltaParams(delta, true)
  if (!params) return
  const tmpQ = new THREE.Quaternion()
  const outQ = new THREE.Quaternion()
  for (const sample of samples) {
    applyConsensusDeltaToPosition(sample.position, params)
    tmpQ.fromArray(sample.quaternion)
    outQ.copy(params.qDelta).multiply(tmpQ)
    sample.quaternion[0] = outQ.x
    sample.quaternion[1] = outQ.y
    sample.quaternion[2] = outQ.z
    sample.quaternion[3] = outQ.w
  }
}


// Ensure neighbour quaternions are in the same hemisphere (avoid sign flips that look jittery)
function alignQuat(ref, q) {
  // Dot product < 0 means q is in opposite hemisphere → negate for shorter interpolation path
  const dot = ref[0]*q[0] + ref[1]*q[1] + ref[2]*q[2] + ref[3]*q[3]
  return dot < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q
}

// ---------------------------------------------------------------------------
// Hot-path Catmull-Rom evaluation that writes its result into caller-owned
// Vector3 / Quaternion objects. The legacy ``sampleLap`` (below) returns a
// freshly-allocated bag and is kept for the cold callers (buildPositionLookup,
// Trajectory). The CarEntity useFrame uses this in-place variant so the 60 Hz
// render path doesn't allocate two three.js objects per car per frame —
// previously ~720 throwaway objects/sec just from sampleLap, which forced a GC
// pause every few seconds on mid-tier mobile and produced visible micro-
// stutter even when the rest of the path was smooth.
function sampleLapInto(samples, t, outPos, outQuat) {
  if (!samples?.length) return false
  const n = samples.length
  if (t <= samples[0].t) {
    outPos.fromArray(samples[0].position)
    outQuat.fromArray(samples[0].quaternion)
    return true
  }
  if (t >= samples[n - 1].t) {
    outPos.fromArray(samples[n - 1].position)
    outQuat.fromArray(samples[n - 1].quaternion)
    return true
  }
  let lo = 0, hi = n - 1
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1
    if (samples[mid].t <= t) lo = mid; else hi = mid
  }
  const p1 = samples[lo], p2 = samples[hi]
  const p0 = samples[Math.max(0, lo - 1)]
  const p3 = samples[Math.min(n - 1, hi + 1)]
  const span = Math.max(p2.t - p1.t, 1e-6)
  const alpha = THREE.MathUtils.clamp((t - p1.t) / span, 0, 1)
  outPos.set(
    catmullRom(p0.position[0], p1.position[0], p2.position[0], p3.position[0], alpha),
    catmullRom(p0.position[1], p1.position[1], p2.position[1], p3.position[1], alpha),
    catmullRom(p0.position[2], p1.position[2], p2.position[2], p3.position[2], alpha),
  )
  const q1 = p1.quaternion
  const q0 = alignQuat(q1, p0.quaternion)
  const q2 = alignQuat(q1, p2.quaternion)
  const q3 = alignQuat(q1, p3.quaternion)
  let qx = catmullRom(q0[0], q1[0], q2[0], q3[0], alpha)
  let qy = catmullRom(q0[1], q1[1], q2[1], q3[1], alpha)
  let qz = catmullRom(q0[2], q1[2], q2[2], q3[2], alpha)
  let qw = catmullRom(q0[3], q1[3], q2[3], q3[3], alpha)
  const qLen = Math.sqrt(qx*qx + qy*qy + qz*qz + qw*qw) || 1
  outQuat.set(qx / qLen, qy / qLen, qz / qLen, qw / qLen)
  return true
}

// In-place sync-offset application — mutates the passed position + quaternion
// rather than allocating new ones. Module-level scratch vectors avoid GC
// pressure on the 60 Hz hot path. The legacy ``applySyncOffset`` below stays
// for cold callers that prefer the immutable signature.
const _syncForward = new THREE.Vector3()
const _syncUp = new THREE.Vector3(0, 1, 0)
const _syncLeft = new THREE.Vector3()
const _syncYawQuat = new THREE.Quaternion()
function applySyncOffsetInPlace(position, quaternion, offset) {
  if (!offset) return
  _syncForward.set(0, 0, 1).applyQuaternion(quaternion)
  _syncLeft.crossVectors(_syncUp, _syncForward).normalize()
  position.addScaledVector(_syncForward, offset.forward || 0)
  position.addScaledVector(_syncLeft, offset.left || 0)
  position.y += offset.up || 0
  if (Math.abs(offset.yaw || 0) > 0.001) {
    _syncYawQuat.setFromAxisAngle(_syncUp, THREE.MathUtils.degToRad(offset.yaw))
    quaternion.premultiply(_syncYawQuat)
  }
}

function sampleLap(samples, t) {
  if (!samples?.length) return null
  const toSample = (sample, time = sample.t) => ({
    t: time,
    position: new THREE.Vector3().fromArray(sample.position),
    quaternion: new THREE.Quaternion().fromArray(sample.quaternion),
  })
  if (t <= samples[0].t) return toSample(samples[0], t)
  if (t >= samples[samples.length - 1].t) return toSample(samples[samples.length - 1], t)

  // Binary search for the right segment
  let lo = 0, hi = samples.length - 1
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1
    if (samples[mid].t <= t) lo = mid; else hi = mid
  }

  // 4 samples for Catmull-Rom: p0 (lo-1), p1 (lo), p2 (hi), p3 (hi+1)
  const p1 = samples[lo], p2 = samples[hi]
  const p0 = samples[Math.max(0, lo - 1)]
  const p3 = samples[Math.min(samples.length - 1, hi + 1)]
  const span = Math.max(p2.t - p1.t, 1e-6)
  const alpha = THREE.MathUtils.clamp((t - p1.t) / span, 0, 1)

  // Cubic spline position for smooth direction changes
  const px = catmullRom(p0.position[0], p1.position[0], p2.position[0], p3.position[0], alpha)
  const py = catmullRom(p0.position[1], p1.position[1], p2.position[1], p3.position[1], alpha)
  const pz = catmullRom(p0.position[2], p1.position[2], p2.position[2], p3.position[2], alpha)

  // Cubic quaternion interpolation: component-wise Catmull-Rom + renormalize.
  // This gives C¹ continuity at sample boundaries (matching tangent vectors), eliminating the jitter
  // from slerp's linear velocity discontinuities. Align neighbours to same hemisphere first.
  const q1 = p1.quaternion
  const q0 = alignQuat(q1, p0.quaternion)
  const q2 = alignQuat(q1, p2.quaternion)
  const q3 = alignQuat(q1, p3.quaternion)
  let qx = catmullRom(q0[0], q1[0], q2[0], q3[0], alpha)
  let qy = catmullRom(q0[1], q1[1], q2[1], q3[1], alpha)
  let qz = catmullRom(q0[2], q1[2], q2[2], q3[2], alpha)
  let qw = catmullRom(q0[3], q1[3], q2[3], q3[3], alpha)
  const qLen = Math.sqrt(qx*qx + qy*qy + qz*qz + qw*qw) || 1
  qx /= qLen; qy /= qLen; qz /= qLen; qw /= qLen

  return {
    t,
    position: new THREE.Vector3(px, py, pz),
    quaternion: new THREE.Quaternion(qx, qy, qz, qw),
  }
}


function sampleTelemetry(samples, t) {
  if (!samples?.length) return null
  if (t <= samples[0].t) return samples[0]
  if (t >= samples[samples.length - 1].t) return samples[samples.length - 1]
  const idx = Math.min(Math.floor(t * 20), samples.length - 1)
  return samples[idx]
}


function estimateSteerFromLap(samples, t) {
  if (!samples?.length || samples.length < 5) return 0

  let lo = 0
  let hi = samples.length - 1
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1
    if (samples[mid].t <= t) lo = mid
    else hi = mid
  }

  const i0 = Math.max(0, lo - 2)
  const i1 = Math.max(0, lo - 1)
  const i2 = Math.min(samples.length - 1, hi + 1)
  const i3 = Math.min(samples.length - 1, hi + 2)

  const p0 = samples[i0].position
  const p1 = samples[i1].position
  const p2 = samples[i2].position
  const p3 = samples[i3].position

  const heading1 = Math.atan2(p2[0] - p0[0], p2[2] - p0[2])
  const heading2 = Math.atan2(p3[0] - p1[0], p3[2] - p1[2])
  let deltaHeading = heading2 - heading1
  while (deltaHeading > Math.PI) deltaHeading -= Math.PI * 2
  while (deltaHeading < -Math.PI) deltaHeading += Math.PI * 2

  const ds0 = Math.hypot(p1[0] - p0[0], p1[2] - p0[2])
  const ds1 = Math.hypot(p2[0] - p1[0], p2[2] - p1[2])
  const distance = Math.max((ds0 + ds1) * 0.5, 1e-4)
  const curvature = deltaHeading / distance
  const steerDeg = THREE.MathUtils.radToDeg(Math.atan(STEER_CURVATURE_WHEELBASE_M * curvature))
  return THREE.MathUtils.clamp(steerDeg, -32, 32)
}


/**
 * Build a fast "find the t_s where this lap passed closest to (x, z)" lookup.
 *
 * Precomputes the final rendered ground-plane XY for each sample (applying the
 * live sync-offset exactly as the ``CarEntity`` does at runtime). Search is:
 *
 * 1. Narrow scan in a ±windowSize neighbourhood around the caller's last match
 *    index (fast, O(1) amortised when the car advances smoothly).
 * 2. Fall back to a full scan if the window was exhausted at either edge, or
 *    if no hint was supplied (first frame / big jump after a sector click).
 * 3. Once the nearest vertex is found, project the query point onto the
 *    two adjacent segments to get sub-sample precision — identical to
 *    ``racebox_loader.py::_segment_closest_point``.
 *
 * Cheap to keep memoised per-lap; O(N) storage with two Float32Arrays and
 * O(1) per-frame query for the common case.
 */
function buildPositionLookup(samples, syncOffset) {
  if (!samples?.length) return null
  const n = samples.length
  const xs = new Float32Array(n)
  const zs = new Float32Array(n)
  const ts = new Float32Array(n)
  const tmpPos = new THREE.Vector3()
  const tmpQuat = new THREE.Quaternion()
  for (let i = 0; i < n; i++) {
    tmpPos.fromArray(samples[i].position)
    tmpQuat.fromArray(samples[i].quaternion)
    const { position } = applySyncOffset(tmpPos, tmpQuat, syncOffset)
    xs[i] = position.x
    zs[i] = position.z
    ts[i] = samples[i].t
  }

  const WINDOW = 30

  function scanRange(refX, refZ, start, end) {
    let bestI = start
    let bestD2 = Infinity
    for (let i = start; i < end; i++) {
      const dx = xs[i] - refX
      const dz = zs[i] - refZ
      const d2 = dx * dx + dz * dz
      if (d2 < bestD2) { bestD2 = d2; bestI = i }
    }
    return { bestI, bestD2 }
  }

  return {
    size: n,
    /**
     * Return ``{ t, idx, distance }`` — the ghost-lap time-stamp at which the
     * lap was physically closest to (refX, refZ). ``idx`` is the segment
     * start index, usable as the next frame's ``hintIdx`` for O(1) search.
     */
    findTime(refX, refZ, hintIdx) {
      let bestI, bestD2
      if (hintIdx != null) {
        const lo = Math.max(0, hintIdx - WINDOW)
        const hi = Math.min(n, hintIdx + WINDOW + 1)
        ;({ bestI, bestD2 } = scanRange(refX, refZ, lo, hi))
        // Escape the window if the minimum landed on either edge — the real
        // optimum is probably further out (big jump).
        if (bestI === lo || bestI === hi - 1) {
          ;({ bestI, bestD2 } = scanRange(refX, refZ, 0, n))
        }
      } else {
        ;({ bestI, bestD2 } = scanRange(refX, refZ, 0, n))
      }

      // Project onto the two segments adjacent to bestI for sub-sample match.
      let segIdx = bestI
      let bestAlpha = 0
      let bestProjD2 = bestD2
      for (const [a, b] of [[Math.max(0, bestI - 1), bestI], [bestI, Math.min(n - 1, bestI + 1)]]) {
        if (a === b) continue
        const ax = xs[a], az = zs[a]
        const bx = xs[b], bz = zs[b]
        const vx = bx - ax
        const vz = bz - az
        const vv = vx * vx + vz * vz
        if (vv === 0) continue
        let alpha = ((refX - ax) * vx + (refZ - az) * vz) / vv
        if (alpha < 0) alpha = 0
        else if (alpha > 1) alpha = 1
        const px = ax + vx * alpha
        const pz = az + vz * alpha
        const d2 = (px - refX) * (px - refX) + (pz - refZ) * (pz - refZ)
        if (d2 < bestProjD2) { bestProjD2 = d2; segIdx = a; bestAlpha = alpha }
      }
      const tA = ts[segIdx]
      const tB = ts[Math.min(segIdx + 1, n - 1)]
      return { t: tA + (tB - tA) * bestAlpha, idx: segIdx, distance: Math.sqrt(bestProjD2) }
    },
  }
}


function applySyncOffset(position, quaternion, offset) {
  if (!offset) return { position, quaternion }
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion)
  const up = new THREE.Vector3(0, 1, 0)
  const left = new THREE.Vector3().crossVectors(up, forward).normalize()
  const newPosition = position.clone()
  newPosition.addScaledVector(forward, offset.forward)
  newPosition.addScaledVector(left, offset.left)
  newPosition.y += offset.up
  let newQuaternion = quaternion.clone()
  if (Math.abs(offset.yaw) > 0.001) {
    const yawQuat = new THREE.Quaternion().setFromAxisAngle(up, THREE.MathUtils.degToRad(offset.yaw))
    newQuaternion = yawQuat.multiply(newQuaternion)
  }
  return { position: newPosition, quaternion: newQuaternion }
}


// Ground plane that fills the void around the actual laser-scanned track geometry.
// No procedural scenery — the track itself is the single source of truth.
const TrackScenery = React.memo(function TrackScenery() {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[475, 4, 290]} receiveShadow>
      <planeGeometry args={[2400, 2400]} />
      <meshStandardMaterial color="#4a6a3a" roughness={1} metalness={0} envMapIntensity={0.08} />
    </mesh>
  )
})


const TrackModel = React.memo(function TrackModel({ url }) {
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
    // meshes; leaving just road / kerb / grass / markings keeps the track readable
    // while bringing GPU draw + memory into phone-friendly range.
    // Exceptions — always keep these even if they classify as 'default'/'structure':
    //   - RED_TRACK_MESHES: 62 painted-red run-off pieces continuing the kerbs.
    //   - 1NNNN_* prefix : track-surface markings / numbers (grey asphalt strips
    //     around start-finish, pit entry, etc).
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
          // Free the geometry/material so hidden meshes don't consume GPU memory.
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


const PHASE_COLORS = {
  full_throttle: '#4caf50',
  braking: '#f44336',
  trail_braking: '#ff9800',
  coasting: '#607d8b',
}

const PHASE_LABELS = {
  full_throttle: 'THROTTLE',
  braking: 'BRAKE',
  trail_braking: 'TRAIL',
  coasting: 'COAST',
}


function sampleColor(tel, idx) {
  if (!tel?.samples?.[idx]) return [0.38, 0.49, 0.55] // grey coast
  const s = tel.samples[idx]
  const braking = s.fbp > 10 && s.tps < 200
  const throttle = s.tps >= 50
  if (braking) {
    const intensity = Math.min(s.fbp / 120, 1)
    return [0.6 + 0.4 * intensity, 0.1 * (1 - intensity), 0.1 * (1 - intensity)] // dark red → bright red
  }
  if (throttle) {
    const intensity = Math.min(s.tps / 255, 1)
    return [0.2 * (1 - intensity), 0.45 + 0.35 * intensity, 0.15 * (1 - intensity)] // dim green → bright green
  }
  return [0.38, 0.49, 0.55] // grey coast
}


const Trajectory = React.memo(function Trajectory({ lap, visible, syncOffset, telemetry }) {
  const points = useMemo(() => {
    if (!syncOffset || (syncOffset.forward === 0 && syncOffset.left === 0 && syncOffset.up === 0 && syncOffset.yaw === 0)) {
      return lap.samples.map((sample) => sample.position)
    }
    return lap.samples.map((sample) => {
      const pos = new THREE.Vector3().fromArray(sample.position)
      const quat = new THREE.Quaternion().fromArray(sample.quaternion)
      const { position: adjusted } = applySyncOffset(pos, quat, syncOffset)
      return [adjusted.x, adjusted.y, adjusted.z]
    })
  }, [lap.samples, syncOffset])

  const vertexColors = useMemo(() => {
    if (!telemetry?.samples?.length) return null
    return lap.samples.map((_, i) => sampleColor(telemetry, i))
  }, [telemetry, lap.samples])

  if (!visible) return null

  if (vertexColors) {
    return <Line points={points} vertexColors={vertexColors} lineWidth={3.5} transparent opacity={0.92} />
  }

  return <Line points={points} color={lap.color} lineWidth={2.2} transparent opacity={lap.ghost ? 0.55 : 0.95} />
})


/**
 * 3D overlay that marks corner key-points on the track. Renders up to four
 * coloured dots per brake zone per lap:
 *
 *   blue    — brake start
 *   red     — brake end (release)
 *   green   — throttle-on
 *   yellow  — full throttle
 *
 * When both laps have a matching corner, a small metres-delta badge is drawn
 * at the midpoint between brake-start points and another between
 * full-throttle points — showing how far apart on track the drivers hit
 * those events.
 */
const CornerMarkers = React.memo(function CornerMarkers({ cornerData, lap1Color, lap2Color }) {
  if (!cornerData) return null
  const { refCorners = [], ghostCorners = [], pairs = [] } = cornerData

  const dot = (pos, color, key, size = '10px') => (
    <Html key={key} position={[pos.x, pos.y + 0.5, pos.z]} center distanceFactor={24} style={{ pointerEvents: 'none' }}>
      <div className="corner-dot" style={{ background: color, width: size, height: size }} />
    </Html>
  )

  // Apex markers use a distinct "ring" style — hollow centre, thick
  // coloured border — lifted 2 m above the track so they're never hidden
  // behind overlapping brake / throttle dots. The label chip spells out
  // which apex it is ("GA" = geometric, "SA" = speed) so the markers read
  // cleanly from a fast scrub.
  const apexMarker = (pos, color, keyBase, label) => (
    <Html key={keyBase} position={[pos.x, pos.y + 2.0, pos.z]} center distanceFactor={22} style={{ pointerEvents: 'none' }}>
      <div className="corner-apex-marker">
        <div className="corner-apex-ring" style={{ borderColor: color }} />
        <div className="corner-apex-label" style={{ color }}>{label}</div>
      </div>
    </Html>
  )

  const cornerMarkersFor = (corners, prefix, brakeStartColor) => corners.flatMap((c) => {
    const out = []
    if (c.brakeStart?.pos) out.push(dot(c.brakeStart.pos, brakeStartColor, `${prefix}-${c.cornerNumber}-bs`))
    if (c.brakeEnd?.pos) out.push(dot(c.brakeEnd.pos, '#f44336', `${prefix}-${c.cornerNumber}-be`))
    if (c.throttleOn?.pos) out.push(dot(c.throttleOn.pos, '#4caf50', `${prefix}-${c.cornerNumber}-ton`))
    if (c.fullThrottle?.pos) out.push(dot(c.fullThrottle.pos, '#ffeb3b', `${prefix}-${c.cornerNumber}-ft`))
    // Geometric apex = tightest curvature of the driven trajectory.
    // Speed apex   = lowest ground-plane speed in the corner window.
    if (c.geomApex?.pos) out.push(apexMarker(c.geomApex.pos, '#ff9800', `${prefix}-${c.cornerNumber}-ga`, 'GA'))
    if (c.speedApex?.pos) out.push(apexMarker(c.speedApex.pos, '#ba68c8', `${prefix}-${c.cornerNumber}-sa`, 'SA'))
    return out
  })

  const deltaBadges = pairs.flatMap((p) => {
    const badges = []
    if (p.brakeStartDistanceM != null && p.ref?.brakeStart?.pos && p.ghost?.brakeStart?.pos) {
      const mid = {
        x: (p.ref.brakeStart.pos.x + p.ghost.brakeStart.pos.x) / 2,
        y: Math.max(p.ref.brakeStart.pos.y, p.ghost.brakeStart.pos.y) + 1.2,
        z: (p.ref.brakeStart.pos.z + p.ghost.brakeStart.pos.z) / 2,
      }
      badges.push(
        <Html key={`bs-delta-${p.cornerNumber}`} position={[mid.x, mid.y, mid.z]} center distanceFactor={22} style={{ pointerEvents: 'none' }}>
          <div className="corner-delta-badge corner-delta-brake">
            <span className="corner-delta-label">BRK</span>
            <span className="corner-delta-value">{p.brakeStartDistanceM.toFixed(1)}m</span>
          </div>
        </Html>,
      )
    }
    if (p.fullThrottleDistanceM != null && p.ref?.fullThrottle?.pos && p.ghost?.fullThrottle?.pos) {
      const mid = {
        x: (p.ref.fullThrottle.pos.x + p.ghost.fullThrottle.pos.x) / 2,
        y: Math.max(p.ref.fullThrottle.pos.y, p.ghost.fullThrottle.pos.y) + 1.2,
        z: (p.ref.fullThrottle.pos.z + p.ghost.fullThrottle.pos.z) / 2,
      }
      badges.push(
        <Html key={`ft-delta-${p.cornerNumber}`} position={[mid.x, mid.y, mid.z]} center distanceFactor={22} style={{ pointerEvents: 'none' }}>
          <div className="corner-delta-badge corner-delta-throttle">
            <span className="corner-delta-label">FT</span>
            <span className="corner-delta-value">{p.fullThrottleDistanceM.toFixed(1)}m</span>
          </div>
        </Html>,
      )
    }
    return badges
  })

  return (
    <>
      {cornerMarkersFor(refCorners, 'ref', lap1Color || '#4dd0e1')}
      {cornerMarkersFor(ghostCorners, 'ghost', lap2Color || '#ff6b6b')}
      {deltaBadges}
    </>
  )
})


function eventScenePosition(event, lap, syncOffset) {
  if (event?.t != null && lap?.samples?.length) {
    const sampled = sampleLap(lap.samples, event.t)
    if (sampled) {
      const { position } = applySyncOffset(sampled.position, sampled.quaternion, syncOffset)
      return position.toArray()
    }
  }
  return event?.position ?? null
}


const TrackMarkers = React.memo(function TrackMarkers({ telemetry, telemetry2, visible, lap, lap2, syncOffset, syncOffset2, lap1Color, lap2Color }) {
  // All hooks must run unconditionally — move early-return check after hooks
  const brakePairs = useMemo(() => {
    if (!telemetry?.events?.length) return []
    const brakeEvents1 = telemetry.events
      .filter(e => e.type === 'brake_start')
      .map(e => ({ ...e, position: eventScenePosition(e, lap, syncOffset) }))
      .filter(e => e.position)
    const brakeEvents2 = (telemetry2?.events || [])
      .filter(e => e.type === 'brake_start')
      .map(e => ({ ...e, position: eventScenePosition(e, lap2, syncOffset2) }))
      .filter(e => e.position)
    const pairs = []
    const used2 = new Set()
    for (let i = 0; i < brakeEvents1.length; i++) {
      const e1 = brakeEvents1[i]
      let bestDist = 60, bestIdx = -1
      for (let j = 0; j < brakeEvents2.length; j++) {
        if (used2.has(j)) continue
        const d = Math.hypot(e1.position[0] - brakeEvents2[j].position[0], e1.position[2] - brakeEvents2[j].position[2])
        if (d < bestDist) { bestDist = d; bestIdx = j }
      }
      const e2 = bestIdx >= 0 ? brakeEvents2[bestIdx] : null
      if (bestIdx >= 0) used2.add(bestIdx)
      pairs.push({ number: i + 1, e1, e2, distance: e2 ? Math.round(bestDist) : null })
    }
    return pairs
  }, [telemetry, telemetry2, lap, lap2, syncOffset, syncOffset2])

  if (!visible || !telemetry?.events?.length) return null

  return (
    <>
      {brakePairs.map((pair) => (
        <group key={`brake-pair-${pair.number}`}>
          {/* Lap 1 brake marker */}
          <Html
            position={[pair.e1.position[0], pair.e1.position[1] + 4, pair.e1.position[2]]}
            center distanceFactor={25} style={{ pointerEvents: 'none' }}
          >
            <div className="brake-pair-marker" style={{ borderColor: lap1Color || '#4dd0e1' }}>
              <span className="brake-pair-icon">{'\u25C6'}</span>
              <span className="brake-pair-num">#{pair.number}</span>
            </div>
          </Html>
          {/* Lap 2 brake marker */}
          {pair.e2 && (
            <Html
              position={[pair.e2.position[0], pair.e2.position[1] + 4, pair.e2.position[2]]}
              center distanceFactor={25} style={{ pointerEvents: 'none' }}
            >
              <div className="brake-pair-marker" style={{ borderColor: lap2Color || '#ff6b6b' }}>
                <span className="brake-pair-icon">{'\u25C6'}</span>
              </div>
            </Html>
          )}
          {/* Distance label at midpoint */}
          {pair.e2 && pair.distance != null && (
            <Html
              position={[
                (pair.e1.position[0] + pair.e2.position[0]) / 2,
                pair.e1.position[1] + 5.5,
                (pair.e1.position[2] + pair.e2.position[2]) / 2,
              ]}
              center distanceFactor={20} style={{ pointerEvents: 'none' }}
            >
              <div className="brake-diff-badge">{pair.distance}m</div>
            </Html>
          )}
        </group>
      ))}
    </>
  )
})


const WHEEL_PATTERNS = {
  fl: /frontwheelleft|wheel.*fl|fl.*wheel|front.*left|wheel_fl/i,
  fr: /frontwheelright|wheel.*fr|fr.*wheel|front.*right|wheel_fr/i,
  rl: /wheel.*rl|rl.*wheel|rear.*left|wheel_rl/i,
  rr: /wheel.*rr|rr.*wheel|rear.*right|wheel_rr/i,
}

const SPIN_VISUAL_GAIN = 1.0
// Steering visual ratio — lower = more visible wheel turn (real BMW E46 is ~16:1, exaggerated for clarity)
const STEERING_RATIO = 8.0


function computeSteerCenter(telemetry) {
  if (!telemetry?.samples?.length) return 0
  // Find the straight-ahead center: use steering wheel values from first 8s (typically on a straight)
  const straightSamples = telemetry.samples
    .filter(s => s.t <= 8)
    .map(s => s.steer)
    .filter(v => typeof v === 'number')
  if (!straightSamples.length) return 0
  // Median of straight section
  const sorted = [...straightSamples].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}


const CarEntity = React.memo(function CarEntity({ carUrl, lap, currentTimeRef, lapTimeOffset, otherLapTimeOffset, visible, onTargetReady, syncOffset, telemetry, deltaData, isRefLap, sectorStartTime, otherLap, hideDelta, showCarHuds, compareMode, refLap, refSyncOffset, ownPositionLookup }) {
  // Note: ``currentTime`` (the 15 Hz React-state UI clock) is intentionally NOT
  // a prop — keeping it out lets React.memo actually memoise away the per-tick
  // re-render. Per-tick HUD updates (TPS / BRK / RPM / delta) are pushed via
  // refs from inside useFrame, which runs at display FPS but never triggers
  // React reconciliation. Without this, the component re-rendered 15 ×/sec
  // per car (memo defeated by changing currentTime), drei's <Html> portals
  // re-reconciled their DOM, and sampleTelemetry / sampleLap allocated fresh
  // objects on every render — the dominant cause of the residual stutter
  // after the smoothing-filter and per-frame-allocation work.
  const { scene } = useGLTF(carUrl)
  const groupRef = useRef(null)
  const steerCenterRef = useRef(0)
  const hudRef = useRef(null)
  // HUD inner refs — useFrame writes textContent / style.width directly,
  // bypassing React.
  const tpsBarRef = useRef(null)
  const brkBarRef = useRef(null)
  const rpmTextRef = useRef(null)
  const deltaBadgeRef = useRef(null)
  // Tracks last-applied class on the HUD wrapper so we don't poke className
  // every frame when the braking/throttle/coast state didn't actually change.
  const hudLastClassRef = useRef('')

  // Compute straight-ahead steering center from telemetry on load
  useEffect(() => {
    steerCenterRef.current = computeSteerCenter(telemetry)
  }, [telemetry])

  const wheelsRef = useRef({
    fl: null,
    fr: null,
    rl: null,
    rr: null,
    baseX: { fl: 0, fr: 0, rl: 0, rr: 0 },
    baseY: { fl: 0, fr: 0 },
  })
  const carScene = useMemo(() => cloneSceneWithMaterials(scene), [scene])

  // Bump texture anisotropy on every car material — makes the body paint,
  // wheel rims and badges read crisply at grazing angles instead of going
  // blurry-Mip. Cheap (no extra texture memory) and visibly improves quality.
  useEffect(() => {
    const ANISO = 16
    carScene.traverse((node) => {
      if (!node.isMesh || !node.material) return
      const mats = Array.isArray(node.material) ? node.material : [node.material]
      for (const m of mats) {
        for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']) {
          if (m[key]) m[key].anisotropy = Math.max(m[key].anisotropy ?? 1, ANISO)
        }
      }
    })
  }, [carScene])

  // Find wheel objects by name pattern
  useEffect(() => {
    const wheels = { fl: null, fr: null, rl: null, rr: null }
    carScene.traverse((node) => {
      if (!node.name) return
      for (const [key, pattern] of Object.entries(WHEEL_PATTERNS)) {
        if (pattern.test(node.name)) {
          wheels[key] = node
        }
      }
    })
    wheelsRef.current = {
      ...wheels,
      baseX: {
        fl: wheels.fl ? wheels.fl.rotation.x : 0,
        fr: wheels.fr ? wheels.fr.rotation.x : 0,
        rl: wheels.rl ? wheels.rl.rotation.x : 0,
        rr: wheels.rr ? wheels.rr.rotation.x : 0,
      },
      baseY: {
        fl: wheels.fl ? wheels.fl.rotation.y : 0,
        fr: wheels.fr ? wheels.fr.rotation.y : 0,
      },
    }
    if (wheels.fl) wheels.fl.rotation.order = 'YXZ'
    if (wheels.fr) wheels.fr.rotation.order = 'YXZ'
    if (wheels.rl) wheels.rl.rotation.order = 'YXZ'
    if (wheels.rr) wheels.rr.rotation.order = 'YXZ'
    const found = Object.entries(wheels).filter(([, v]) => v).map(([k]) => k)
    if (found.length > 0) {
      console.log(`[${lap.id}] Found wheels:`, found.join(', '))
    }
  }, [carScene, lap.id])

  useEffect(() => {
    carScene.traverse((node) => {
      if (node.name === 'Cube') {
        node.visible = false
      }
      if (!node.isMesh || !node.material) return
      const materials = Array.isArray(node.material) ? node.material : [node.material]
      for (const material of materials) {
        if (lap.ghost) {
          material.transparent = true
          material.opacity = 0.35
          if (material.color) material.color.lerp(new THREE.Color(lap.color), 0.5)
          if ('emissive' in material) {
            material.emissive = new THREE.Color(lap.color)
            material.emissiveIntensity = 0.25
          }
        }
      }
    })
  }, [carScene, lap.color, lap.ghost])

  useEffect(() => {
    onTargetReady(lap.id, groupRef.current)
    return () => onTargetReady(lap.id, null)
  }, [lap.id, onTargetReady])

  // Temporal smoothing state — low-pass filter to remove residual 20Hz-source jitter
  const smoothedPosRef = useRef(null)
  const smoothedQuatRef = useRef(null)

  // Last matched index for position-mode lookup — gives O(1) search amortised.
  const positionHintIdxRef = useRef(null)

  // Per-instance scratch — preallocated once, reused every frame so the hot
  // path doesn't churn the GC. Three-vector + two-quaternion per car covers
  // sampling this lap, sampling the ref lap (position mode), sampling the
  // other lap (delta computation), plus one for the in-place sync offset.
  const scratchPos1Ref = useRef(new THREE.Vector3())
  const scratchPos2Ref = useRef(new THREE.Vector3())
  const scratchPos3Ref = useRef(new THREE.Vector3())
  const scratchQuat1Ref = useRef(new THREE.Quaternion())
  const scratchQuat2Ref = useRef(new THREE.Quaternion())
  const scratchForwardRef = useRef(new THREE.Vector3())

  // HUD updates run at ~15 Hz inside useFrame (this accumulator counts
  // wall-clock seconds since the last HUD pass). Doing them every frame
  // (60 Hz) thrashes the CSSOM inside drei's <Html> portals — a real
  // measurable regression over the previous 15 Hz React-driven path.
  const hudAccumRef = useRef(0)

  // Stable values derived from props — recomputed only when the relevant
  // prop changes (i.e. on a real re-render, not 15 ×/sec).
  const hasTelemetry = !!telemetry?.samples?.length
  // hideDelta: route-level opt-out (e.g. /um-racebox where the two cars are
  // the same drive recorded by two devices, so a per-frame time delta would
  // be misleading — the spatial gap is the only signal that matters).
  const showDeltaBadge = !hideDelta && isRefLap && !!otherLap?.samples?.length

  useFrame(({ camera }, delta) => {
    if (!groupRef.current) return
    // Read the live clock from the shared ref (updated every RAF frame by
    // usePlayback). currentTime React-state is no longer a prop — we don't
    // want this component re-rendering 15 ×/sec.
    const playheadTime = currentTimeRef?.current ?? 0

    // Resolve this car's own lap-time. In time mode it's simply playhead +
    // per-lap offset. In position mode the ghost follows the ref's physical
    // (x, z) on the track: sample the ref at the playhead, apply its
    // sync-offset to get its scene XY, then ask this ghost's polyline
    // lookup what t_s it was at that point.
    let liveTime
    const refScratchPos = scratchPos2Ref.current
    const refScratchQuat = scratchQuat2Ref.current
    if (compareMode === 'position' && !isRefLap && refLap?.samples?.length && ownPositionLookup) {
      if (sampleLapInto(refLap.samples, playheadTime, refScratchPos, refScratchQuat)) {
        applySyncOffsetInPlace(refScratchPos, refScratchQuat, refSyncOffset)
        const match = ownPositionLookup.findTime(refScratchPos.x, refScratchPos.z, positionHintIdxRef.current)
        positionHintIdxRef.current = match.idx
        liveTime = match.t
      } else {
        liveTime = playheadTime + (lapTimeOffset ?? 0)
      }
    } else {
      liveTime = playheadTime + (lapTimeOffset ?? 0)
    }

    const targetPos = scratchPos1Ref.current
    const targetQuat = scratchQuat1Ref.current
    if (!sampleLapInto(lap.samples, liveTime, targetPos, targetQuat)) return
    applySyncOffsetInPlace(targetPos, targetQuat, syncOffset)

    // First frame: initialize smoothed state to current target
    if (!smoothedPosRef.current) {
      smoothedPosRef.current = targetPos.clone()
      smoothedQuatRef.current = targetQuat.clone()
    }

    // Exponential smoothing with time-independent cutoff at 8 Hz — matches
    // the source's residual jitter band (20 Hz GPS / IMU samples carry sub-
    // sample-period noise that's still visible after Catmull-Rom). Tried
    // fc=15 to cut the steady-state lag (~12 ms → ~5 ms) but it let too
    // much of the source noise through and visibly degraded the motion;
    // staying at fc=8.
    const fc = 8 // cutoff Hz
    const alpha = 1 - Math.exp(-delta * 2 * Math.PI * fc)
    smoothedPosRef.current.lerp(targetPos, alpha)
    smoothedQuatRef.current.slerp(targetQuat, alpha)

    groupRef.current.position.copy(smoothedPosRef.current)
    groupRef.current.quaternion.copy(smoothedQuatRef.current)

    // Animate front wheel steering ONLY from CAN bus steering angle. Also
    // drives the per-tick HUD updates below — sampleTelemetry returns the
    // sample object reference (no allocation).
    const tel = telemetry ? sampleTelemetry(telemetry.samples, liveTime) : null
    const steerCenter = steerCenterRef.current
    const roadWheelDeg = tel && typeof tel.steer === 'number'
      ? (tel.steer - steerCenter) / STEERING_RATIO
      : 0
    const steerRad = THREE.MathUtils.degToRad(roadWheelDeg)
    if (Number.isFinite(steerRad)) {
      const { fl, fr, rl, rr, baseX } = wheelsRef.current
      if (fl) {
        fl.rotation.y = steerRad
        fl.rotation.x = baseX.fl + ((tel?.spin_fl_rad ?? 0) * SPIN_VISUAL_GAIN)
      }
      if (fr) {
        fr.rotation.y = steerRad
        fr.rotation.x = baseX.fr + ((tel?.spin_fr_rad ?? 0) * SPIN_VISUAL_GAIN)
      }
      if (rl) rl.rotation.x = baseX.rl + ((tel?.spin_rl_rad ?? 0) * SPIN_VISUAL_GAIN)
      if (rr) rr.rotation.x = baseX.rr + ((tel?.spin_rr_rad ?? 0) * SPIN_VISUAL_GAIN)
    }

    // HUD scale (camera distance) — runs every frame because ``transform:
    // scale(...)`` is composited (no layout invalidation, very cheap).
    if (hudRef.current) {
      const dist = camera.position.distanceTo(smoothedPosRef.current)
      const HUD_MIN_DIST = 3
      const HUD_FULL_DIST = 10
      const tDist = THREE.MathUtils.clamp((dist - HUD_MIN_DIST) / (HUD_FULL_DIST - HUD_MIN_DIST), 0, 1)
      const scale = 0.45 + tDist * 0.55
      hudRef.current.style.transform = `scale(${scale.toFixed(3)})`
    }

    // Throttle the rest of the HUD writes to ~15 Hz (matches the previous
    // React-driven cadence). Bar widths trigger layout, text writes trigger
    // re-layout of the parent flex row — doing those at 60 Hz across two
    // <Html> portals is a measurable mobile regression over the previous
    // 15 Hz path even though it eliminates React reconciliation.
    hudAccumRef.current += delta
    const HUD_INTERVAL = 1 / 15
    if (hudAccumRef.current >= HUD_INTERVAL) {
      hudAccumRef.current = 0

      if (tel && showCarHuds && hasTelemetry && hudRef.current) {
        if (tpsBarRef.current) tpsBarRef.current.style.width = `${(tel.tps / 255) * 100}%`
        if (brkBarRef.current) brkBarRef.current.style.width = `${Math.min(tel.fbp / 150 * 100, 100)}%`
        if (rpmTextRef.current) {
          const rpmStr = `${Math.round(tel.rpm)} RPM`
          if (rpmTextRef.current.textContent !== rpmStr) rpmTextRef.current.textContent = rpmStr
        }
        const isBraking = tel.fbp > 10
        const isThrottle = tel.tps >= 240
        const cls = `car-telemetry-hud ${isBraking ? 'hud-braking' : isThrottle ? 'hud-throttle' : 'hud-coast'}`
        if (hudLastClassRef.current !== cls) {
          hudRef.current.className = cls
          hudLastClassRef.current = cls
        }
      }

      // Delta badge — same throttle. Only the ref lap renders this.
      if (showDeltaBadge && deltaBadgeRef.current && otherLap?.samples?.length) {
        const refPos = scratchPos1Ref.current     // (alias targetPos — already
                                                   // holds this car's pose)
        const refQuat = scratchQuat1Ref.current
        const otherPos = scratchPos3Ref.current
        const otherQuat = scratchQuat2Ref.current  // reuse — refLap path above
                                                    // is exclusive with this
                                                    // (delta is only on ref lap)
        const otherTime = playheadTime + (otherLapTimeOffset ?? 0)
        if (sampleLapInto(otherLap.samples, otherTime, otherPos, otherQuat)) {
          const forward = scratchForwardRef.current.set(0, 0, 1).applyQuaternion(refQuat)
          const dx = otherPos.x - refPos.x
          const dy = otherPos.y - refPos.y
          const dz = otherPos.z - refPos.z
          const signedDist = dx * forward.x + dy * forward.y + dz * forward.z
          const refIdx = Math.max(1, Math.min(Math.floor(playheadTime * 20), lap.samples.length - 1))
          const p0 = lap.samples[refIdx - 1].position, p1 = lap.samples[refIdx].position
          const speedMs = Math.max(1, Math.hypot(p1[0] - p0[0], p1[2] - p0[2]) * 20)
          const deltaTime = signedDist / speedMs
          const label = (deltaTime >= 0 ? '+' : '') + deltaTime.toFixed(3) + 's'
          if (deltaBadgeRef.current.textContent !== label) deltaBadgeRef.current.textContent = label
          const aheadOrBehind = deltaTime >= 0 ? 'hud-delta-behind' : 'hud-delta-ahead'
          const cls = `car-delta-badge ${aheadOrBehind}`
          if (deltaBadgeRef.current.dataset.cls !== cls) {
            deltaBadgeRef.current.className = cls
            deltaBadgeRef.current.dataset.cls = cls
          }
          if (deltaBadgeRef.current.style.display !== '') deltaBadgeRef.current.style.display = ''
        } else if (deltaBadgeRef.current.style.display !== 'none') {
          deltaBadgeRef.current.style.display = 'none'
        }
      }
    }
  })

  return (
    <group ref={groupRef} visible={visible}>
      <primitive object={carScene} />
      {visible && (
        <Html position={[0, isRefLap ? 2.1 : 2.6, 0]} center distanceFactor={26} style={{ pointerEvents: 'none' }}>
          <div className={`car-dot ${lap.ghost ? 'car-dot-ghost' : ''}`} style={{ background: lap.color, boxShadow: `0 0 6px ${lap.color}` }} />
        </Html>
      )}
      {/* Stable HUD shell — content is filled in by useFrame via refs above.
          Rendered once per real prop change (visibility, lap focus etc.)
          rather than 15 ×/sec on currentTime ticks. */}
      {visible && hasTelemetry && showCarHuds && (
        <Html
          position={[0, isRefLap ? 3.2 : 4.5, 0]}
          center
          distanceFactor={14}
          style={{ pointerEvents: 'none' }}
          className="car-telemetry-hud-wrap"
        >
          <div ref={hudRef} className="car-telemetry-hud hud-coast" style={{ transformOrigin: 'center top' }}>
            <div className="hud-bar-row">
              <span className="hud-bar-label">TPS</span>
              <div className="hud-bar"><div ref={tpsBarRef} className="hud-bar-fill hud-bar-tps" /></div>
            </div>
            <div className="hud-bar-row">
              <span className="hud-bar-label">BRK</span>
              <div className="hud-bar"><div ref={brkBarRef} className="hud-bar-fill hud-bar-brake" /></div>
            </div>
            <div ref={rpmTextRef} className="hud-rpm">— RPM</div>
          </div>
        </Html>
      )}
      {/* Delta badge — only rendered when this is the ref lap and there is a
          ghost to compare against. Text and class are set imperatively in
          useFrame; display is toggled when the sample lookup succeeds. */}
      {visible && showCarHuds && showDeltaBadge && (
        <Html position={[0, isRefLap ? 2.6 : 3.1, 0]} center distanceFactor={16} style={{ pointerEvents: 'none' }}>
          <div ref={deltaBadgeRef} className="car-delta-badge" style={{ display: 'none' }} />
        </Html>
      )}
    </group>
  )
})


// Chase / hood / side / top camera smoothing factor.
// exp-filter cutoff ≈ CAMERA_SMOOTHING / (2π) Hz — k=14 gives ~2.2 Hz, which
// matches the chase-cam "snap" feel of modern racing games. Old value k=5
// was ~0.8 Hz, which produced a visible ~100-150 ms lag on sharp corner
// transitions.
const CAMERA_SMOOTHING = 14

function CameraRig({ cameraMode, focusRef, controlsRef, cameraInitRef, laps, snapRequestRef, liftView }) {
  const camera = useThree((state) => state.camera)
  const gl = useThree((state) => state.gl)
  const lastFreeTargetRef = useRef(null)
  // Smooth the look-at target too, not just the camera position. Previously
  // position lerped but lookAt snapped per frame — mismatch produced a
  // subtle "rotation is sharper than translation" jitter on tight zooms.
  const smoothedLookAtRef = useRef(null)
  const lastSnapSeenRef = useRef(0)

  // ----- Fixed-view zoom (chase / hood / side / top) --------------------
  //
  // Free mode delegates zoom to OrbitControls. The fixed views had no zoom at
  // all — touch users especially had no way to bring the cars closer or pull
  // out for a wider view. We add wheel + pinch listeners on the canvas, gate
  // them on cameraMode !== 'free', and apply the resulting zoom multiplier:
  //
  //   * chase / side / top   → scale ``localCameraOffset`` (camera moves
  //                              closer to / further from the car)
  //   * hood                  → adjust ``camera.fov`` instead (the camera is
  //                              already inside the cockpit; moving it back
  //                              would punch through the seat)
  //
  // Zoom resets on cameraMode change so each view starts at its calibrated
  // 1.0 default. baseFovRef captures the original FOV so we can restore it
  // when the user leaves hood mode.
  const zoomRef = useRef(1.0)
  const baseFovRef = useRef(null)

  useEffect(() => {
    if (baseFovRef.current == null) baseFovRef.current = camera.fov
    zoomRef.current = 1.0
    // If we just left hood mode, FOV may still be the zoomed value — restore.
    if (baseFovRef.current && Math.abs(camera.fov - baseFovRef.current) > 0.01) {
      camera.fov = baseFovRef.current
      camera.updateProjectionMatrix()
    }
  }, [cameraMode, camera])

  useEffect(() => {
    if (cameraMode === 'free') return undefined
    const dom = gl.domElement
    const clamp = (z) => Math.max(0.35, Math.min(3.0, z))

    const onWheel = (e) => {
      e.preventDefault()
      // 10% per notch — scroll wheels emit deltaY ≈ ±100 per notch.
      const factor = e.deltaY > 0 ? 1.1 : 0.9
      zoomRef.current = clamp(zoomRef.current * factor)
    }

    let initDist = 0
    let initZoom = 1.0
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
    const onTouchStart = (e) => {
      if (e.touches.length === 2) {
        initDist = dist(e.touches)
        initZoom = zoomRef.current
      }
    }
    const onTouchMove = (e) => {
      if (e.touches.length === 2 && initDist > 0) {
        e.preventDefault()
        // Pinch out (fingers spread) → ratio > 1 → zoom in (smaller offset).
        const ratio = dist(e.touches) / initDist
        zoomRef.current = clamp(initZoom / ratio)
      }
    }
    const onTouchEnd = () => { initDist = 0 }

    dom.addEventListener('wheel', onWheel, { passive: false })
    dom.addEventListener('touchstart', onTouchStart, { passive: true })
    dom.addEventListener('touchmove', onTouchMove, { passive: false })
    dom.addEventListener('touchend', onTouchEnd, { passive: true })
    return () => {
      dom.removeEventListener('wheel', onWheel)
      dom.removeEventListener('touchstart', onTouchStart)
      dom.removeEventListener('touchmove', onTouchMove)
      dom.removeEventListener('touchend', onTouchEnd)
    }
  }, [cameraMode, gl])


  useFrame((_, delta) => {
    if (!focusRef.current) return
    const targetPosition = new THREE.Vector3()
    const targetQuaternion = new THREE.Quaternion()
    focusRef.current.getWorldPosition(targetPosition)
    focusRef.current.getWorldQuaternion(targetQuaternion)

    // Car mesh hasn't been placed yet (still at scene origin). Don't override the
    // initialCamera pose with a chase computed from (0,0,0).
    if (targetPosition.lengthSq() < 1) return

    // Handle one-shot snap requests (e.g. sector click) — always place the camera
    // behind the car at a chase pose, regardless of the current camera mode.
    // For free mode, also re-anchor OrbitControls so subsequent orbit starts
    // from the new position rather than jumping back.
    if (snapRequestRef && snapRequestRef.current !== lastSnapSeenRef.current) {
      lastSnapSeenRef.current = snapRequestRef.current
      // Free-mode vantage: same chase direction (behind the car) but pulled
      // further back and higher up than the tight chase offset, so the user
      // gets an overview of the sector entry with both cars in frame.
      const snapOffset = new THREE.Vector3(0, 10.0, -30.0).applyQuaternion(targetQuaternion).add(targetPosition)
      camera.position.copy(snapOffset)
      camera.lookAt(targetPosition)
      if (controlsRef.current) {
        controlsRef.current.target.copy(targetPosition)
        controlsRef.current.update()
      }
      lastFreeTargetRef.current = targetPosition.clone()
      // Reset the smoothed lookAt so the next chase-mode frame doesn't lerp
      // from the old vantage — otherwise you see a swoop after sector jump.
      smoothedLookAtRef.current = targetPosition.clone()
      // Skip the rest of this frame's mode-specific logic so the snap isn't
      // immediately overwritten.
      return
    }

    // First-frame init: sync the free-camera anchor + orbit controls target to the
    // car, but do NOT move the camera — it was already placed in chase pose by the
    // <PerspectiveCamera> initial props (computed from the first-lap samples).
    if (cameraInitRef && !cameraInitRef.current) {
      if (controlsRef.current) {
        controlsRef.current.target.copy(targetPosition)
        controlsRef.current.update()
      }
      lastFreeTargetRef.current = targetPosition.clone()
      cameraInitRef.current = true
      if (cameraMode === 'free') return
    }

    if (cameraMode === 'free') {
      const controls = controlsRef.current
      if (!controls) return
      if (lastFreeTargetRef.current) {
        camera.position.add(targetPosition.clone().sub(lastFreeTargetRef.current))
      }
      controls.target.copy(targetPosition)
      controls.update()
      lastFreeTargetRef.current = targetPosition.clone()
      return
    }
    lastFreeTargetRef.current = targetPosition.clone()
    let localCameraOffset = new THREE.Vector3(0, 2.4, -8.0)
    let localLookOffset = new THREE.Vector3(0, 1.2, 10.0)
    if (cameraMode === 'hood') {
      localCameraOffset = new THREE.Vector3(0, 1.2, 1.7)
      localLookOffset = new THREE.Vector3(0, 1.1, 25.0)
    } else if (cameraMode === 'top') {
      localCameraOffset = new THREE.Vector3(0, 22.0, -0.1)
      localLookOffset = new THREE.Vector3(0, 0.0, 0.0)
    } else if (cameraMode === 'side') {
      localCameraOffset = new THREE.Vector3(8.0, 2.0, 0.0)
      localLookOffset = new THREE.Vector3(0.0, 1.0, 4.0)
    }
    // Apply user zoom: distance scaling for the exterior chases (camera
    // moves further from / closer to the car), FOV adjustment for hood
    // (where the camera is *inside* the cockpit and can't sensibly move).
    const zoom = zoomRef.current
    if (cameraMode === 'hood') {
      const targetFov = baseFovRef.current ? baseFovRef.current / zoom : camera.fov
      // Smooth the FOV change so wheel-flicks feel like a zoom, not a jolt.
      camera.fov = THREE.MathUtils.lerp(camera.fov, targetFov, 1 - Math.exp(-delta * 6))
      camera.updateProjectionMatrix()
    } else {
      localCameraOffset.multiplyScalar(zoom)
    }
    const desiredPosition = localCameraOffset.applyQuaternion(targetQuaternion).add(targetPosition)
    const desiredLookAt = localLookOffset.applyQuaternion(targetQuaternion).add(targetPosition)
    // When the lap-video PIP is visible (bottom-right of the viewport), shift
    // the lookAt point downward in world-space so the cars project into the
    // upper portion of the frame and don't get covered by the overlay.
    // Lowering lookAt.y tilts the camera further toward ground; whatever was
    // at the screen center moves toward the upper half. Skip on hood (already
    // a cockpit POV) and top (already straight-down). 2.5 m is enough lift to
    // clear a 180×102 PIP without making the chase view feel weird.
    if (liftView && cameraMode !== 'hood' && cameraMode !== 'top') {
      desiredLookAt.y -= 2.5
    }
    const alpha = 1 - Math.exp(-delta * CAMERA_SMOOTHING)
    camera.position.lerp(desiredPosition, alpha)
    if (!smoothedLookAtRef.current) smoothedLookAtRef.current = desiredLookAt.clone()
    else smoothedLookAtRef.current.lerp(desiredLookAt, alpha)
    camera.lookAt(smoothedLookAtRef.current)
  })
  return null
}


const TelemetryPanel = React.memo(function TelemetryPanel({ telemetry, currentTime, duration }) {
  const bgCanvasRef = useRef(null)
  const playheadCanvasRef = useRef(null)

  // Draw static chart ONLY when telemetry changes (not on every currentTime change)
  useEffect(() => {
    const canvas = bgCanvasRef.current
    if (!canvas || !telemetry?.samples?.length) return
    const ctx = canvas.getContext('2d')
    const w = canvas.width, h = canvas.height
    const samples = telemetry.samples
    const n = samples.length

    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = 'rgba(9, 11, 16, 0.85)'
    ctx.fillRect(0, 0, w, h)

    const chartH = Math.floor(h / 4)
    // Signed chart for steering (zero-centered), unsigned for others
    const charts = [
      { key: 'tps',   min: 0,    max: 255,  color: '#4caf50', label: 'TPS',   signed: false },
      { key: 'fbp',   min: 0,    max: 150,  color: '#f44336', label: 'BRAKE', signed: false },
      { key: 'rpm',   min: 0,    max: 8000, color: '#42a5f5', label: 'RPM',   signed: false },
      { key: 'steer', min: -250, max: 250,  color: '#ffb74d', label: 'STEER', signed: true  },
    ]

    charts.forEach((chart, ci) => {
      const y0 = ci * chartH
      ctx.strokeStyle = 'rgba(255,255,255,0.06)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, y0 + chartH)
      ctx.lineTo(w, y0 + chartH)
      ctx.stroke()

      // Zero line for signed charts
      if (chart.signed) {
        const zeroY = y0 + chartH / 2
        ctx.strokeStyle = 'rgba(255,255,255,0.12)'
        ctx.beginPath()
        ctx.moveTo(0, zeroY)
        ctx.lineTo(w, zeroY)
        ctx.stroke()
      }

      ctx.fillStyle = 'rgba(255,255,255,0.4)'
      ctx.font = '10px monospace'
      ctx.fillText(chart.label, 4, y0 + 12)

      ctx.strokeStyle = chart.color
      ctx.lineWidth = 1.5
      ctx.beginPath()
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * w
        const v = samples[i][chart.key] ?? 0
        let y
        if (chart.signed) {
          const norm = Math.max(-1, Math.min(1, v / chart.max))
          y = y0 + chartH / 2 - norm * (chartH / 2 - 2)
        } else {
          const val = Math.min(Math.max(v, 0) / chart.max, 1)
          y = y0 + chartH - val * (chartH - 4) - 2
        }
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
      }
      ctx.stroke()

      // Fill
      ctx.globalAlpha = 0.12
      ctx.fillStyle = chart.color
      if (chart.signed) {
        const zeroY = y0 + chartH / 2
        ctx.lineTo(w, zeroY)
        ctx.lineTo(0, zeroY)
      } else {
        ctx.lineTo(w, y0 + chartH)
        ctx.lineTo(0, y0 + chartH)
      }
      ctx.closePath()
      ctx.fill()
      ctx.globalAlpha = 1.0
    })
  }, [telemetry])

  // Draw only the playhead on the overlay canvas (cheap redraw each frame)
  useEffect(() => {
    const canvas = playheadCanvasRef.current
    if (!canvas || duration <= 0) return
    const ctx = canvas.getContext('2d')
    const w = canvas.width, h = canvas.height
    ctx.clearRect(0, 0, w, h)
    const px = (currentTime / duration) * w
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 1.5
    ctx.setLineDash([4, 3])
    ctx.beginPath()
    ctx.moveTo(px, 0)
    ctx.lineTo(px, h)
    ctx.stroke()
    ctx.setLineDash([])
  }, [currentTime, duration])

  if (!telemetry) return null
  return (
    <div className="telemetry-panel">
      <canvas ref={bgCanvasRef} width={400} height={200} className="telemetry-canvas" />
      <canvas ref={playheadCanvasRef} width={400} height={200} className="telemetry-playhead" />
    </div>
  )
})


function computeLapDelta(laps, telemetryData) {
  if (laps.length < 2) return null
  const lap1 = laps[0], lap2 = laps[1]
  if (!lap1?.samples?.length || !lap2?.samples?.length) return null

  // Cumulative distance for each lap
  function cumDist(samples) {
    const d = [0]
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1].position, b = samples[i].position
      d.push(d[i - 1] + Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2 + (b[2] - a[2]) ** 2))
    }
    return d
  }

  const d1 = cumDist(lap1.samples), d2 = cumDist(lap2.samples)
  const totalDist = Math.min(d1[d1.length - 1], d2[d2.length - 1])

  // Sample at regular distance intervals
  const step = 2 // every 2 meters
  const points = []
  let idx1 = 0, idx2 = 0

  for (let dist = 0; dist <= totalDist; dist += step) {
    while (idx1 + 1 < d1.length && d1[idx1 + 1] < dist) idx1++
    while (idx2 + 1 < d2.length && d2[idx2 + 1] < dist) idx2++
    if (idx1 + 1 >= d1.length || idx2 + 1 >= d2.length) break

    const span1 = d1[idx1 + 1] - d1[idx1]
    const span2 = d2[idx2 + 1] - d2[idx2]
    const alpha1 = span1 > 0 ? Math.min(1, (dist - d1[idx1]) / span1) : 0
    const alpha2 = span2 > 0 ? Math.min(1, (dist - d2[idx2]) / span2) : 0

    const ni1 = Math.min(idx1 + 1, lap1.samples.length - 1)
    const ni2 = Math.min(idx2 + 1, lap2.samples.length - 1)
    const t1 = lap1.samples[idx1].t + (lap1.samples[ni1].t - lap1.samples[idx1].t) * alpha1
    const t2 = lap2.samples[idx2].t + (lap2.samples[ni2].t - lap2.samples[idx2].t) * alpha2

    const s1 = lap1.samples[idx1], s2 = lap1.samples[ni1]
    const px = s1.position[0] + (s2.position[0] - s1.position[0]) * alpha1
    const py = s1.position[1] + (s2.position[1] - s1.position[1]) * alpha1
    const pz = s1.position[2] + (s2.position[2] - s1.position[2]) * alpha1

    points.push({ dist, t1, t2, delta: t2 - t1, position: [px, py, pz] })
  }

  // Build sectors from brake events, offset start before the braking point
  const tel = telemetryData?.[lap1.id]
  const brakeStarts = tel?.events?.filter(e => e.type === 'brake_start').map(e => e.t) || []
  const MIN_SECTOR_TIME = 5.0
  const SECTOR_LEAD_TIME = 3.0 // start sector 3 seconds before brake point

  // Convert brake times to distance indices, offset backwards, skip close ones
  const sectorBoundaries = [0]
  let lastBoundaryTime = -Infinity
  for (const bt of brakeStarts) {
    const leadTime = Math.max(0, bt - SECTOR_LEAD_TIME)
    if (leadTime - lastBoundaryTime < MIN_SECTOR_TIME) continue
    const idx = points.findIndex(p => p.t1 >= leadTime)
    if (idx > 0 && idx < points.length - 1) {
      sectorBoundaries.push(idx)
      lastBoundaryTime = leadTime
    }
  }
  sectorBoundaries.push(points.length - 1)

  const sectors = []
  for (let s = 0; s < sectorBoundaries.length - 1; s++) {
    const idxStart = sectorBoundaries[s]
    const idxEnd = sectorBoundaries[s + 1]
    if (idxEnd <= idxStart) continue
    const sectorPts = points.slice(idxStart, idxEnd + 1)
    const avgDelta = sectorPts.reduce((sum, p) => sum + p.delta, 0) / sectorPts.length
    const midIdx = Math.floor((idxStart + idxEnd) / 2)
    // Find where lap2 crosses the perpendicular line at ref car's sector start
    // Perpendicular = plane normal to ref car's heading direction at this point
    const refPos = points[idxStart].position
    const refIdx1 = Math.min(idxStart + 1, points.length - 1)
    const refNext = points[refIdx1].position
    // Forward tangent of ref trajectory at sector start (XZ plane)
    const fwdX = refNext[0] - refPos[0], fwdZ = refNext[2] - refPos[2]
    const fwdLen = Math.hypot(fwdX, fwdZ) || 1

    // For each consecutive pair of lap2 samples, check if they cross the perpendicular plane
    let bestLap2Time = points[idxStart].t2
    let bestCrossDist = Infinity
    for (let j = 1; j < lap2.samples.length; j++) {
      const a = lap2.samples[j - 1], b = lap2.samples[j]
      // Signed distance from perpendicular plane: dot(pos - refPos, forward)
      const da = (a.position[0] - refPos[0]) * fwdX / fwdLen + (a.position[2] - refPos[2]) * fwdZ / fwdLen
      const db = (b.position[0] - refPos[0]) * fwdX / fwdLen + (b.position[2] - refPos[2]) * fwdZ / fwdLen
      // Check if they cross the plane (sign change)
      if (da * db <= 0 && (Math.abs(da) + Math.abs(db)) > 0.01) {
        const alpha = Math.abs(da) / (Math.abs(da) + Math.abs(db))
        const crossX = a.position[0] + (b.position[0] - a.position[0]) * alpha
        const crossZ = a.position[2] + (b.position[2] - a.position[2]) * alpha
        // Lateral distance from ref point
        const latDist = Math.hypot(crossX - refPos[0], crossZ - refPos[2])
        if (latDist < bestCrossDist) {
          bestCrossDist = latDist
          bestLap2Time = a.t + (b.t - a.t) * alpha
        }
      }
    }

    // Analyze sector telemetry for race engineer tips
    const tel1 = telemetryData?.[lap1.id]
    const tel2 = telemetryData?.[lap2.id]
    const tips = []
    if (tel1?.samples && tel2?.samples) {
      const t1s = points[idxStart].t1, t1e = points[idxEnd].t1
      const t2s = bestLap2Time, t2e = t2s + (t1e - t1s) // approximate same duration
      const s1 = tel1.samples.filter(s => s.t >= t1s && s.t <= t1e)
      const s2 = tel2.samples.filter(s => s.t >= t2s && s.t <= t2e)
      if (s1.length > 5 && s2.length > 5) {
        // 1. Braking analysis
        const brakeStart1 = s1.findIndex(s => s.fbp > 10 && s.tps < 200)
        const brakeStart2 = s2.findIndex(s => s.fbp > 10 && s.tps < 200)
        const maxBrake1 = Math.max(...s1.map(s => s.fbp))
        const maxBrake2 = Math.max(...s2.map(s => s.fbp))
        if (brakeStart1 >= 0 && brakeStart2 >= 0) {
          const brakeDiffFrames = brakeStart1 - brakeStart2
          if (Math.abs(brakeDiffFrames) > 2) {
            const later = brakeDiffFrames > 0 ? 'Lap 3' : 'Lap 4'
            const meters = Math.abs(brakeDiffFrames) * 2 // ~2m per sample at speed
            tips.push({ icon: '\u{1F6D1}', text: `${later} brakes ${meters}m later — ${brakeDiffFrames > 0 ? 'more aggressive entry' : 'earlier, safer entry'}` })
          }
          if (Math.abs(maxBrake1 - maxBrake2) > 15) {
            const harder = maxBrake1 > maxBrake2 ? 'Lap 3' : 'Lap 4'
            tips.push({ icon: '\u{1F4AA}', text: `${harder} brakes harder (${Math.max(maxBrake1, maxBrake2)} vs ${Math.min(maxBrake1, maxBrake2)}) — ${harder === 'Lap 3' ? 'more confidence' : 'smoother decel'}` })
          }
        } else if (brakeStart1 < 0 && brakeStart2 < 0) {
          tips.push({ icon: '\u26A1', text: 'Full throttle sector — no braking in either lap' })
        }

        // 2. Throttle application
        const ftFrames1 = s1.filter(s => s.tps >= 240).length
        const ftFrames2 = s2.filter(s => s.tps >= 240).length
        const ftPct1 = Math.round(ftFrames1 / s1.length * 100)
        const ftPct2 = Math.round(ftFrames2 / s2.length * 100)
        if (Math.abs(ftPct1 - ftPct2) > 8) {
          const more = ftPct1 > ftPct2 ? 'Lap 3' : 'Lap 4'
          tips.push({ icon: '\u{1F3CE}\uFE0F', text: `${more} has ${Math.max(ftPct1, ftPct2)}% throttle vs ${Math.min(ftPct1, ftPct2)}% — better traction on exit` })
        }

        // 3. Trail braking / coasting
        const trailFrames1 = s1.filter(s => s.fbp > 10 && s.tps > 50).length
        const trailFrames2 = s2.filter(s => s.fbp > 10 && s.tps > 50).length
        const coastFrames1 = s1.filter(s => s.fbp <= 10 && s.tps < 240).length
        const coastFrames2 = s2.filter(s => s.fbp <= 10 && s.tps < 240).length
        if (Math.abs(coastFrames1 - coastFrames2) > 5) {
          const lessCoast = coastFrames1 < coastFrames2 ? 'Lap 3' : 'Lap 4'
          tips.push({ icon: '\u{1F3AF}', text: `${lessCoast} coasts less — smoother transition from brake to throttle` })
        }
        if (trailFrames1 > 3 || trailFrames2 > 3) {
          const moreTrail = trailFrames1 > trailFrames2 ? 'Lap 3' : 'Lap 4'
          tips.push({ icon: '\u{1F525}', text: `${moreTrail} uses trail braking — better corner rotation` })
        }

        // 4. RPM / momentum
        const avgRpm1 = s1.reduce((sum, s) => sum + s.rpm, 0) / s1.length
        const avgRpm2 = s2.reduce((sum, s) => sum + s.rpm, 0) / s2.length
        if (Math.abs(avgRpm1 - avgRpm2) > 300) {
          const higher = avgRpm1 > avgRpm2 ? 'Lap 3' : 'Lap 4'
          tips.push({ icon: '\u2699\uFE0F', text: `${higher} carries ${Math.round(Math.abs(avgRpm1 - avgRpm2))} RPM more — better gear choice or momentum` })
        }
      }
    }
    // Keep top 3 tips
    const sectorTips = tips.slice(0, 3)

    sectors.push({
      number: sectors.length + 1,
      idxStart,
      idxEnd,
      avgDelta,
      sectorDelta: points[idxEnd].delta - points[idxStart].delta,
      winner: avgDelta > 0 ? lap1.id : lap2.id,
      midPosition: points[midIdx].position,
      t1Start: points[idxStart].t1,
      t2Start: bestLap2Time,
      distStart: points[idxStart].dist,
      distEnd: points[idxEnd].dist,
      tips: sectorTips,
    })
  }

  return { points, sectors, totalDist, lap1Id: lap1.id, lap2Id: lap2.id, lap1Color: lap1.color, lap2Color: lap2.color }
}


const DeltaChart = React.memo(function DeltaChart({ deltaData, currentTime, duration, laps }) {
  const bgCanvasRef = useRef(null)
  const playheadCanvasRef = useRef(null)

  // Cache the maxDelta so the playhead effect doesn't recompute
  const maxDelta = useMemo(() => {
    if (!deltaData?.points?.length) return 0.5
    return Math.max(0.5, ...deltaData.points.map(p => Math.abs(p.delta)))
  }, [deltaData])

  // Background: draw chart only when deltaData/laps change (not every frame)
  useEffect(() => {
    const canvas = bgCanvasRef.current
    if (!canvas || !deltaData?.points?.length) return
    const ctx = canvas.getContext('2d')
    const w = canvas.width, h = canvas.height
    const pts = deltaData.points
    const midY = h / 2

    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = 'rgba(9, 11, 16, 0.85)'
    ctx.fillRect(0, 0, w, h)

    ctx.strokeStyle = 'rgba(255,255,255,0.15)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, midY)
    ctx.lineTo(w, midY)
    ctx.stroke()

    ctx.fillStyle = 'rgba(255,255,255,0.35)'
    ctx.font = '9px monospace'
    ctx.fillText('TIME DELTA', 4, 11)
    ctx.fillText('+' + maxDelta.toFixed(1) + 's', w - 35, 11)
    ctx.fillText('-' + maxDelta.toFixed(1) + 's', w - 35, h - 3)

    ctx.fillStyle = deltaData.lap2Color
    ctx.fillText(laps[1]?.label || 'Lap 2', 70, 11)
    ctx.fillStyle = deltaData.lap1Color
    ctx.fillText(laps[0]?.label || 'Lap 1', 70, h - 3)

    ctx.beginPath()
    for (let i = 0; i < pts.length; i++) {
      const x = (pts[i].dist / deltaData.totalDist) * w
      const y = midY - (pts[i].delta / maxDelta) * (midY - 4)
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
    }
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 1.5
    ctx.stroke()

    for (let i = 1; i < pts.length; i++) {
      const x0 = (pts[i - 1].dist / deltaData.totalDist) * w
      const x1 = (pts[i].dist / deltaData.totalDist) * w
      const y0 = midY - (pts[i - 1].delta / maxDelta) * (midY - 4)
      const y1 = midY - (pts[i].delta / maxDelta) * (midY - 4)
      ctx.globalAlpha = 0.25
      ctx.fillStyle = pts[i].delta > 0 ? '#4caf50' : '#f44336'
      ctx.beginPath()
      ctx.moveTo(x0, midY)
      ctx.lineTo(x0, y0)
      ctx.lineTo(x1, y1)
      ctx.lineTo(x1, midY)
      ctx.closePath()
      ctx.fill()
      ctx.globalAlpha = 1.0
    }
  }, [deltaData, laps, maxDelta])

  // Playhead overlay (cheap redraws each frame)
  useEffect(() => {
    const canvas = playheadCanvasRef.current
    if (!canvas || !deltaData?.points?.length || duration <= 0) return
    const ctx = canvas.getContext('2d')
    const w = canvas.width, h = canvas.height
    const midY = h / 2
    const pts = deltaData.points

    ctx.clearRect(0, 0, w, h)
    const px = (currentTime / duration) * w
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 1.5
    ctx.setLineDash([4, 3])
    ctx.beginPath()
    ctx.moveTo(px, 0)
    ctx.lineTo(px, h)
    ctx.stroke()
    ctx.setLineDash([])

    const distIdx = Math.floor((currentTime / duration) * pts.length)
    if (distIdx >= 0 && distIdx < pts.length) {
      const d = pts[distIdx].delta
      ctx.fillStyle = '#ffffff'
      ctx.font = 'bold 12px monospace'
      ctx.fillText((d > 0 ? '+' : '') + d.toFixed(3) + 's', px + 4, midY - 2)
    }
  }, [deltaData, currentTime, duration])

  if (!deltaData) return null
  return (
    <div className="delta-panel">
      <canvas ref={bgCanvasRef} width={400} height={80} className="delta-canvas" />
      <canvas ref={playheadCanvasRef} width={400} height={80} className="delta-playhead" />
    </div>
  )
})


function TrackMap({ deltaData, currentTime, duration, laps, onSectorClick }) {
  const canvasRef = useRef(null)
  const [hoveredSector, setHoveredSector] = useState(null)
  const transformRef = useRef(null)

  // Compute transform once from samples
  const transform = useMemo(() => {
    if (!laps.length || !laps[0]?.samples?.length) return null
    const samples = laps[0].samples
    const W = 280, H = 280
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
    for (const s of samples) {
      minX = Math.min(minX, s.position[0]); maxX = Math.max(maxX, s.position[0])
      minZ = Math.min(minZ, s.position[2]); maxZ = Math.max(maxZ, s.position[2])
    }
    const rangeX = maxX - minX || 1, rangeZ = maxZ - minZ || 1
    const scale = Math.min((W - 20) / rangeX, (H - 20) / rangeZ)
    const offX = (W - rangeX * scale) / 2, offZ = (H - rangeZ * scale) / 2
    return { minX, minZ, scale, offX, offZ, W, H, toX: (x) => offX + (x - minX) * scale, toY: (z) => offZ + (z - minZ) * scale }
  }, [laps])

  useEffect(() => { transformRef.current = transform }, [transform])

  const dotCanvasRef = useRef(null)

  // Static draw: track, sectors, legend (only redraws when structure changes)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !transform || !laps[0]?.samples?.length) return
    try {
    const ctx = canvas.getContext('2d')
    const { W: w, H: h, toX, toY } = transform
    const samples = laps[0].samples
    const sectors = deltaData?.sectors || []

    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = 'rgba(9, 11, 16, 0.9)'
    ctx.fillRect(0, 0, w, h)

    ctx.strokeStyle = 'rgba(255,255,255,0.08)'
    ctx.lineWidth = 8
    ctx.lineCap = 'round'
    ctx.beginPath()
    for (let i = 0; i < samples.length; i += 3) {
      const x = toX(samples[i].position[0]), y = toY(samples[i].position[2])
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
    }
    ctx.stroke()

    if (deltaData?.points?.length && sectors.length) {
      const pts = deltaData.points
      for (const sector of sectors) {
        const isHovered = hoveredSector === sector.number
        const color = sector.avgDelta > 0 ? (isHovered ? '#66ff66' : '#4caf50') : (isHovered ? '#ff6666' : '#f44336')
        ctx.strokeStyle = color
        ctx.lineWidth = isHovered ? 6 : 3.5
        ctx.lineCap = 'round'
        ctx.beginPath()
        for (let i = sector.idxStart; i <= sector.idxEnd; i += 2) {
          if (i >= pts.length) break
          const x = toX(pts[i].position[0]), y = toY(pts[i].position[2])
          if (i === sector.idxStart) ctx.moveTo(x, y); else ctx.lineTo(x, y)
        }
        ctx.stroke()

        const midIdx = Math.min(Math.floor((sector.idxStart + sector.idxEnd) / 2), pts.length - 1)
        const mx = toX(pts[midIdx].position[0]), my = toY(pts[midIdx].position[2])
        ctx.fillStyle = isHovered ? '#ffffff' : 'rgba(255,255,255,0.7)'
        ctx.font = isHovered ? 'bold 11px monospace' : '9px monospace'
        ctx.textAlign = 'center'
        ctx.fillText('S' + sector.number, mx, my - 6)
        const deltaStr = (sector.avgDelta > 0 ? '+' : '') + sector.avgDelta.toFixed(2) + 's'
        ctx.fillStyle = sector.avgDelta > 0 ? '#4caf50' : '#f44336'
        ctx.font = isHovered ? 'bold 10px monospace' : '8px monospace'
        ctx.fillText(deltaStr, mx, my + 6)
        ctx.textAlign = 'left'
      }
    }

    ctx.fillStyle = 'rgba(255,255,255,0.3)'
    ctx.font = '8px monospace'
    ctx.fillText('TRACK MAP — click sector to jump', 4, h - 4)
    if (laps.length >= 2) {
      ctx.fillStyle = '#4caf50'
      ctx.fillRect(4, 3, 8, 8)
      ctx.fillStyle = 'rgba(255,255,255,0.5)'
      ctx.font = '9px monospace'
      ctx.fillText(laps[0]?.label || '', 16, 11)
      ctx.fillStyle = '#f44336'
      ctx.fillRect(4, 14, 8, 8)
      ctx.fillStyle = 'rgba(255,255,255,0.5)'
      ctx.fillText(laps[1]?.label || '', 16, 22)
    }
    } catch (e) { console.error('[TrackMap]', e) }
  }, [deltaData, laps, transform, hoveredSector])

  // Car dot overlay (cheap redraws on currentTime changes)
  useEffect(() => {
    const canvas = dotCanvasRef.current
    if (!canvas || !transform || !laps[0]?.samples?.length || duration <= 0) return
    const ctx = canvas.getContext('2d')
    const { W: w, H: h, toX, toY } = transform
    const samples = laps[0].samples
    ctx.clearRect(0, 0, w, h)
    const idx = Math.max(0, Math.min(Math.floor(currentTime / duration * samples.length), samples.length - 1))
    if (!samples[idx]?.position) return
    const cx = toX(samples[idx].position[0]), cy = toY(samples[idx].position[2])
    ctx.fillStyle = '#ffffff'
    ctx.shadowColor = '#ffffff'
    ctx.shadowBlur = 6
    ctx.beginPath()
    ctx.arc(cx, cy, 4, 0, Math.PI * 2)
    ctx.fill()
    ctx.shadowBlur = 0
  }, [currentTime, duration, laps, transform])

  // Hit-test sectors on mouse move/click
  const findSector = useCallback((e) => {
    const t = transformRef.current
    if (!t || !deltaData?.sectors?.length || !deltaData?.points?.length) return null
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    const scaleX = canvas.width / rect.width, scaleY = canvas.height / rect.height
    const mx = (e.clientX - rect.left) * scaleX, my = (e.clientY - rect.top) * scaleY
    const pts = deltaData.points

    let bestSector = null, bestDist = 15 // threshold pixels
    for (const sector of deltaData.sectors) {
      for (let i = sector.idxStart; i <= sector.idxEnd && i < pts.length; i += 4) {
        const sx = t.toX(pts[i].position[0]), sy = t.toY(pts[i].position[2])
        const d = Math.hypot(mx - sx, my - sy)
        if (d < bestDist) { bestDist = d; bestSector = sector }
      }
    }
    return bestSector
  }, [deltaData])

  const handleMouseMove = useCallback((e) => {
    const sector = findSector(e)
    setHoveredSector(sector ? sector.number : null)
    e.target.style.cursor = sector ? 'pointer' : 'default'
  }, [findSector])

  const handleClick = useCallback((e) => {
    const sector = findSector(e)
    if (sector && onSectorClick) onSectorClick(sector)
  }, [findSector, onSectorClick])

  if (!laps.length) return null
  return (
    <div className="track-map-panel">
      <canvas
        ref={canvasRef}
        width={280}
        height={280}
        className="track-map-canvas"
      />
      <canvas
        ref={dotCanvasRef}
        width={280}
        height={280}
        className="track-map-dot"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoveredSector(null)}
        onClick={handleClick}
      />
    </div>
  )
}


const GamificationStats = React.memo(function GamificationStats({ telemetry, currentTime }) {
  if (!telemetry?.stats) return null
  const { stats } = telemetry

  // Find active brake zone score popup
  const activeZone = stats.brake_zone_scores?.find(
    z => currentTime >= z.t_end && currentTime < z.t_end + 2.5
  )

  return (
    <div className="gamification-panel">
      <div className="gami-rating">
        <span className={`gami-grade gami-grade-${stats.rating}`}>{stats.rating}</span>
        <span className="gami-score">{stats.total_score} pts</span>
      </div>
      <div className="gami-bars">
        <div className="gami-stat">
          <span className="gami-stat-label">Throttle</span>
          <div className="gami-bar"><div className="gami-bar-fill gami-bar-throttle" style={{ width: `${stats.full_throttle_pct}%` }} /></div>
          <span className="gami-stat-val">{stats.full_throttle_pct}%</span>
        </div>
        <div className="gami-stat">
          <span className="gami-stat-label">Braking</span>
          <div className="gami-bar"><div className="gami-bar-fill gami-bar-brake" style={{ width: `${stats.braking_pct}%` }} /></div>
          <span className="gami-stat-val">{stats.braking_pct}%</span>
        </div>
        <div className="gami-stat">
          <span className="gami-stat-label">Coast</span>
          <div className="gami-bar"><div className="gami-bar-fill gami-bar-coast" style={{ width: `${stats.coasting_pct}%` }} /></div>
          <span className="gami-stat-val">{stats.coasting_pct}%</span>
        </div>
      </div>
      <div className="gami-details">
        <span>Brake zones: {stats.brake_zones}</span>
        <span>Max RPM: {stats.max_rpm}</span>
      </div>
      {activeZone && (
        <div className={`zone-popup zone-popup-${activeZone.label === 'Late Brake!' ? 'great' : activeZone.label === 'Good' ? 'good' : 'early'}`}>
          <div className="zone-popup-label">{activeZone.label}</div>
          <div className="zone-popup-score">+{activeZone.score} pts</div>
        </div>
      )}
    </div>
  )
})


/**
 * DOM overlay (right-side column, above the data-panels) listing each
 * paired corner with:
 *   - Brake-point separation between ref and ghost (metres).
 *   - Full-throttle-point separation (metres).
 *   - Oscillation count per lap (and the Δ).
 *   - Peak brake pressure per lap.
 * Plus a compact per-sector arc-length table at the top.
 */
function CornerAnalysisPanel({ cornerData, laps }) {
  const { pairs = [], sectorsWithArc = [] } = cornerData
  const refColor = laps?.[0]?.color || '#4dd0e1'
  const ghostColor = laps?.[1]?.color || '#ff6b6b'
  const refTotal = laps?.[0] ? totalLapArcLength(laps[0]) : 0
  const ghostTotal = laps?.[1] ? totalLapArcLength(laps[1]) : 0
  const totalDelta = refTotal - ghostTotal
  const legendItems = [
    { color: refColor, label: 'Brake start — ref' },
    { color: ghostColor, label: 'Brake start — ghost' },
    { color: '#f44336', label: 'Brake end (release)' },
    { color: '#4caf50', label: 'Throttle on' },
    { color: '#ffeb3b', label: 'Full throttle' },
    { color: '#ff9800', label: 'Geometric apex (peak |steer|)' },
    { color: '#ba68c8', label: 'Speed apex (min speed)' },
  ]
  return (
    <div className="corner-analysis-panel">
      <div className="corner-analysis-header">CORNER ANALYSIS</div>

      {/* Legend — one compact vertical list of every marker type + colour
          used on the 3D track. Doubles as documentation when sharing the
          app with someone new. */}
      <div className="corner-analysis-legend">
        <div className="corner-analysis-subhead">Legend</div>
        <div className="corner-analysis-legend-grid">
          {legendItems.map((it) => (
            <div key={it.label} className="corner-analysis-legend-item">
              <span className="corner-analysis-legend-dot" style={{ background: it.color }} />
              <span>{it.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Total lap distance comparison. Sum of ground-plane arc length over
          all samples of each lap. Non-zero delta means drivers drove
          different amounts of metres around the same lap (different
          racing lines / wider runs / off-line excursions). */}
      {refTotal > 0 && ghostTotal > 0 && (
        <div className="corner-analysis-totals">
          <div className="corner-analysis-subhead">Lap distance</div>
          <div className="corner-analysis-totals-row">
            <span className="corner-analysis-lap-swatch" style={{ background: refColor }} />
            <span className="corner-analysis-totals-value">{Math.round(refTotal)} m</span>
          </div>
          <div className="corner-analysis-totals-row">
            <span className="corner-analysis-lap-swatch" style={{ background: ghostColor }} />
            <span className="corner-analysis-totals-value">{Math.round(ghostTotal)} m</span>
          </div>
          <div className="corner-analysis-totals-delta">
            Δ {totalDelta >= 0 ? '+' : ''}{totalDelta.toFixed(1)} m
          </div>
        </div>
      )}

      {sectorsWithArc.length > 0 && (
        <div className="corner-analysis-sectors">
          <div className="corner-analysis-subhead">Sector distances</div>
          <div className="corner-analysis-sector-grid">
            {sectorsWithArc.map((s) => (
              <div key={s.number} className="corner-analysis-sector">
                <span className="corner-analysis-sector-num">S{s.number}</span>
                <span className="corner-analysis-sector-arc">{s.arcLengthM != null ? `${Math.round(s.arcLengthM)} m` : '—'}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="corner-analysis-subhead">Per corner</div>
      <div className="corner-analysis-rows">
        {pairs.length === 0 && (
          <div className="corner-analysis-empty">No brake events yet — waiting for telemetry.</div>
        )}
        {pairs.map((p) => (
          <div key={p.cornerNumber} className="corner-analysis-row">
            <div className="corner-analysis-row-header">
              <span className="corner-analysis-row-num">#{p.cornerNumber}</span>
              <span className="corner-analysis-row-delta">
                {p.brakeStartDistanceM != null && <span className="ca-brk-delta" title="Distance between brake-start points">BRK Δ {p.brakeStartDistanceM.toFixed(1)}m</span>}
                {p.fullThrottleDistanceM != null && <span className="ca-ft-delta" title="Distance between full-throttle points">FT Δ {p.fullThrottleDistanceM.toFixed(1)}m</span>}
                {p.geomApexDistanceM != null && <span className="ca-ga-delta" title="Distance between geometric-apex points (peak steer)">GA Δ {p.geomApexDistanceM.toFixed(1)}m</span>}
                {p.speedApexDistanceM != null && <span className="ca-sa-delta" title="Distance between speed-apex points (min speed)">SA Δ {p.speedApexDistanceM.toFixed(1)}m</span>}
                {p.speedApexDeltaKph != null && <span className="ca-sa-delta" title="Min-speed delta (ref − ghost) in km/h">{p.speedApexDeltaKph >= 0 ? '+' : ''}{p.speedApexDeltaKph.toFixed(1)} kph</span>}
              </span>
            </div>
            {p.arcToBrakeStartDeltaM != null && (
              <div className="corner-analysis-row-arc" title="Cumulative lap distance at brake-start — ref minus ghost">
                arc Δ at brake-start: {p.arcToBrakeStartDeltaM >= 0 ? '+' : ''}{p.arcToBrakeStartDeltaM.toFixed(1)} m
              </div>
            )}
            <div className="corner-analysis-row-body">
              <div className="corner-analysis-lap">
                <span className="corner-analysis-lap-swatch" style={{ background: refColor }} />
                <span>osc {p.ref?.oscillations ?? 0}</span>
                <span>max {p.ref?.maxBrake != null ? p.ref.maxBrake.toFixed(0) : '—'}</span>
                {p.ref?.brakingDistanceM != null && <span>brake {p.ref.brakingDistanceM.toFixed(0)}m</span>}
                {p.ref?.speedApex?.speedMps != null && <span>min {(p.ref.speedApex.speedMps * 3.6).toFixed(0)} kph</span>}
              </div>
              <div className="corner-analysis-lap">
                <span className="corner-analysis-lap-swatch" style={{ background: ghostColor }} />
                <span>osc {p.ghost?.oscillations ?? 0}</span>
                <span>max {p.ghost?.maxBrake != null ? p.ghost.maxBrake.toFixed(0) : '—'}</span>
                {p.ghost?.brakingDistanceM != null && <span>brake {p.ghost.brakingDistanceM.toFixed(0)}m</span>}
                {p.ghost?.speedApex?.speedMps != null && <span>min {(p.ghost.speedApex.speedMps * 3.6).toFixed(0)} kph</span>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}


function Viewer({ manifest, laps, currentTime, currentTimeRef, cameraMode, compareMode, cornerAnalysisMode, cornerData, focusLapId, visibility, onTargetReady, syncOffsets, telemetryData, lapTimeOffset, deltaData, sectorStartTime, showCarHuds, cameraSnapRequestRef, liftViewForVideo, hideDelta }) {
  // Build a per-lap polyline lookup for position-mode comparison. Re-runs
  // when samples or the live sync-offset change; Float32Arrays keep it cheap.
  const positionLookups = useMemo(() => {
    const out = {}
    for (const lap of laps) {
      out[lap.id] = buildPositionLookup(lap.samples, syncOffsets[lap.id])
    }
    return out
  }, [laps, syncOffsets])

  const targetMapRef = useRef(new Map())
  const orbitControlsRef = useRef(null)
  const [, forceRerender] = useReducer(x => x + 1, 0)
  const handleTargetReady = (lapId, object) => {
    if (object) targetMapRef.current.set(lapId, object)
    else targetMapRef.current.delete(lapId)
    onTargetReady?.(targetMapRef.current)
    forceRerender()  // Re-render so focusRef picks up the new target object
  }
  const focusRef = useRef(null)
  focusRef.current = targetMapRef.current.get(focusLapId) ?? null
  const focusLap = laps.find(l => l.id === focusLapId) ?? laps[0]
  const focusTelemetry = telemetryData[focusLapId]
  const otherLap = laps.find(l => l.id !== focusLapId)
  const otherTelemetry = otherLap ? telemetryData[otherLap.id] : null

  // Set camera to chase position on first lap load
  const cameraInitRef = useRef(false)

  // Compute initial chase-camera position behind the car at t=0. Forward direction
  // is derived from the positional delta over the first ~2m of travel (more robust
  // than the raw quaternion which may carry sync-yaw corrections). Chase offset
  // matches CameraRig: 8m behind + 2.4m up, looking 10m ahead + 1.2m up.
  const initialCamera = useMemo(() => {
    const samples = focusLap?.samples
    if (!samples || samples.length < 2) return { pos: [475, 120, 150], look: [475, 5, 350] }
    const p0 = new THREE.Vector3().fromArray(samples[0].position)
    let p1 = new THREE.Vector3().fromArray(samples[1].position)
    for (let i = 2; i < samples.length && p1.distanceTo(p0) < 2; i++) {
      p1 = new THREE.Vector3().fromArray(samples[i].position)
    }
    const forward = p1.clone().sub(p0).setY(0)
    if (forward.lengthSq() < 1e-6) return { pos: [475, 120, 150], look: [475, 5, 350] }
    forward.normalize()
    // Slightly elevated & pulled back for a clear pre-play view of the car on the track.
    const camPos = p0.clone().addScaledVector(forward, -12.0).add(new THREE.Vector3(0, 5.0, 0))
    const lookAt = p0.clone().add(new THREE.Vector3(0, 0.8, 0))
    return { pos: camPos.toArray(), look: lookAt.toArray() }
  }, [focusLap])

  // Mobile GPUs have strict VRAM budgets and tab-crash under heavy load. Detect
  // mobile once and drop every optional feature: shadows, MSAA, high DPR, and the
  // preserve-drawing-buffer flag that recording needs (~doubles VRAM use).
  const isMobile = typeof navigator !== 'undefined' && /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)

  return (
    <Canvas
      shadows={!isMobile}
      // Mobile: respect the screen's device pixel ratio (capped at 2) for crisp
      // rendering. We freed up enough VRAM by stripping buildings/textures that
      // we can afford native-resolution draws + MSAA on the remaining ~120 meshes.
      dpr={isMobile ? [1, 2] : [1, 1.5]}
      gl={{
        antialias: true,
        preserveDrawingBuffer: !isMobile,  // needed for <canvas>.toBlob() recording; off on mobile
        powerPreference: isMobile ? 'high-performance' : 'high-performance',
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 1.1,
      }}
    >
      <color attach="background" args={["#b8ccd8"]} />
      <fog attach="fog" args={["#b8ccd8", 400, 2400]} />
      {/* Initial chase-camera: behind the car at the focus lap's first sample, so the
          user starts in the same view the chase cam gives once the car model loads. */}
      <PerspectiveCamera makeDefault position={initialCamera.pos} fov={48} ref={(c) => { if (c) { c.lookAt(...initialCamera.look); c.updateMatrixWorld(true) } }} />
      <OrbitControls ref={orbitControlsRef} enabled={cameraMode === 'free'} enableDamping dampingFactor={0.08} />
      <CameraRig cameraMode={cameraMode} focusRef={focusRef} controlsRef={orbitControlsRef} cameraInitRef={cameraInitRef} laps={laps} snapRequestRef={cameraSnapRequestRef} liftView={liftViewForVideo} />
      <ambientLight intensity={isMobile ? 0.55 : 0.35} />
      <directionalLight
        position={[120, 180, 60]}
        intensity={1.4}
        castShadow={!isMobile}
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-300}
        shadow-camera-right={300}
        shadow-camera-top={300}
        shadow-camera-bottom={-300}
        shadow-camera-near={1}
        shadow-camera-far={600}
        shadow-bias={-0.0005}
        shadow-normalBias={0.2}
      />
      <hemisphereLight args={["#b8d7ff", "#1f2126", 0.5]} />
      <Environment preset="park" background={false} environmentIntensity={0.9} />
      <Suspense fallback={null}>
        <TrackScenery />
        <TrackModel url={assetUrl(manifest.track)} />
        {laps.map((lap) => (
          <Trajectory key={`${lap.id}-line`} lap={lap} visible={visibility[lap.id] ?? true} syncOffset={syncOffsets[lap.id]} telemetry={telemetryData[lap.id]} />
        ))}
        {laps.map((lap, lapIdx) => (
          <CarEntity
            key={lap.id}
            carUrl={assetUrl(manifest.car)}
            lap={lap}
            // ``currentTime`` and ``otherCurrentTime`` deliberately removed —
            // see the CarEntity comment. The component reads the live clock
            // from ``currentTimeRef`` inside useFrame; the per-tick HUD
            // updates run there too. This lets React.memo actually memoise
            // CarEntity across the 15 Hz UI clock ticks.
            currentTimeRef={currentTimeRef}
            lapTimeOffset={lapIdx > 0 ? lapTimeOffset : 0}
            otherLapTimeOffset={lapIdx === 0 ? lapTimeOffset : 0}
            visible={visibility[lap.id] ?? true}
            onTargetReady={handleTargetReady}
            syncOffset={syncOffsets[lap.id]}
            telemetry={telemetryData[lap.id]}
            deltaData={deltaData}
            isRefLap={lapIdx === 0}
            sectorStartTime={sectorStartTime}
            otherLap={lapIdx === 0 ? laps[1] : null}
            hideDelta={hideDelta}
            showCarHuds={showCarHuds}
            compareMode={compareMode}
            refLap={lapIdx > 0 ? laps[0] : null}
            refSyncOffset={lapIdx > 0 ? syncOffsets[laps[0].id] : null}
            ownPositionLookup={positionLookups[lap.id]}
          />
        ))}
        {focusTelemetry && (
          <TrackMarkers telemetry={focusTelemetry} telemetry2={otherTelemetry} visible={true}
            lap={focusLap} lap2={otherLap}
            syncOffset={focusLap ? syncOffsets[focusLap.id] : null}
            syncOffset2={otherLap ? syncOffsets[otherLap.id] : null}
            lap1Color={focusLap?.color} lap2Color={otherLap?.color} />
        )}
        {cornerAnalysisMode && cornerData && (
          <CornerMarkers cornerData={cornerData}
            lap1Color={laps[0]?.color} lap2Color={laps[1]?.color} />
        )}
      </Suspense>
    </Canvas>
  )
}


const MODE_LABELS = { standard: 'Standard', compare_projected_um981: 'Projected', compare_projected_raw: 'Raw Projected' }
const DEVICE_COLORS = { um982: '#4dd0e1', um981: '#9b7bff', um981raw: '#ffd166' }

function groupLapsBySession(laps) {
  const groups = new Map()
  for (const lap of laps) {
    const sid = lap.session_id ?? 'unknown'
    if (!groups.has(sid)) groups.set(sid, [])
    groups.get(sid).push(lap)
  }
  return groups
}

function getRefWarnings(laps, visibility) {
  const warnings = []
  for (const lap of laps) {
    if (!lap.reference_lap_id) continue
    if ((visibility[lap.id]) && visibility[lap.reference_lap_id] === false) {
      warnings.push({ lapId: lap.id, message: `Reference lap hidden for "${lap.label}"` })
    }
  }
  return warnings
}


function SyncSlider({ label, value, onChange, min, max, step }) {
  return (
    <label className="sync-slider">
      <span className="sync-slider-label">{label} <span className="sync-slider-value">{value.toFixed(2)}</span></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  )
}

function LapSyncControls({ lap, syncOffset, onSyncChange }) {
  const [expanded, setExpanded] = useState(false)
  const handleChange = (key, value) => onSyncChange(lap.id, { ...syncOffset, [key]: value })
  const handleReset = () => onSyncChange(lap.id, { forward: 0, left: 0, up: 0, yaw: 0 })
  const hasOffset = syncOffset.forward !== 0 || syncOffset.left !== 0 || syncOffset.up !== 0 || syncOffset.yaw !== 0
  return (
    <div className="sync-controls">
      <button className="sync-toggle" onClick={() => setExpanded((v) => !v)}>
        {expanded ? '\u25BC' : '\u25B6'} Sync{hasOffset ? ' *' : ''}
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


function LoadingOverlay() {
  const { active, progress, loaded, total, item } = useProgress()
  if (!active && progress >= 100) return null
  // Extract short name from URL
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


/**
 * Picture-in-picture HTML5 video overlay synced to the lap playhead.
 *
 * Activates only on the ``/video`` route — laps in that manifest carry
 * ``video_path`` (and optional ``video_lap_start_sec`` / ``video_label``)
 * which other routes' manifests don't. When neither lap has a video, the
 * component returns ``null`` and the toggle button doesn't render either.
 *
 * Sync model — the same two-tier clock that drives ``CarEntity``:
 *
 *   - ``playing``  → ``video.play() / pause()``
 *   - ``speed``    → ``video.playbackRate``
 *   - scrubber drag / sector jump → ``video.currentTime = currentTime +
 *                                       video_lap_start_sec``
 *   - drift watchdog every ~1 s while playing — re-snaps if video clock
 *     and playhead diverge by more than ``DRIFT_TOLERANCE_S * 2``.
 *
 * Reads the live clock from ``currentTimeRef`` (RAF-updated, 60 Hz) for the
 * watchdog so it doesn't add per-frame React re-renders. State-tier
 * ``currentTime`` (~15 Hz) drives the user-action useEffect — that's coarse
 * enough that we don't seek the video on every render but fine enough that
 * drag and sector jumps feel instant.
 *
 * Why scoped to /video and not auto-on everywhere: most laps don't have
 * paired video. A toggle that's always present but inert is noise; gating
 * on ``lap.video_path`` from the manifest keeps the toolbar clean for
 * non-video routes.
 */
const VIDEO_DRIFT_TOLERANCE_S = 0.08

function VideoOverlay({ visible, lap, currentTimeRef, currentTime, playing, speed, sectorStartTime, onClose }) {
  const videoRef = useRef(null)
  const [muted, setMuted] = useState(true)
  const [size, setSize] = useState('normal') // 'normal' | 'large'
  const [error, setError] = useState(null)
  // ``status`` mirrors the underlying media element so we can show a spinner
  // while the network buffers and a clear error if the source fails to load.
  // Values: 'loading' (initial fetch / waiting for metadata) | 'seeking' |
  // 'ready' (canplay or playing) | 'error'.
  const [status, setStatus] = useState('loading')

  // ----- WebAudio audio pipeline (mobile only) ---------------------------
  //
  // We tried two earlier approaches for the separate audio file:
  //   1. <audio src=cdn-url>             — choppy from streaming underruns
  //   2. <audio src=blob:url-from-fetch> — still choppy on this device,
  //      apparently the <audio> element itself adds startup/seek latency
  //
  // Bypass the element entirely. The audio file is fetched once, decoded
  // once into an AudioBuffer (PCM in RAM), and played via an
  // AudioBufferSourceNode. That has no streaming, no decoder warmup, no
  // pause/resume click, and play/seek are sample-accurate. The trade-off
  // is that AudioBufferSourceNode rate changes affect pitch (we don't get
  // time-stretching for free) — fine here because we already pause the
  // video at speed > 1× via the speed clamp, and 0.5× / 0.25× chipmunk
  // pitching is acceptable for cockpit-cam.
  const audioCtxRef = useRef(null)
  const audioGainRef = useRef(null)
  const audioBufferRef = useRef(null)
  const audioSourceRef = useRef(null)
  // We compute the audio's logical playback position from
  //   audioStartOffsetRef.current + (ctx.currentTime - audioStartCtxTimeRef.current) * rate
  // since AudioBufferSourceNode doesn't expose its own currentTime.
  const audioStartCtxTimeRef = useRef(0)
  const audioStartOffsetRef = useRef(0)
  // True once the AudioBuffer has been decoded and is ready to schedule.
  const [audioReady, setAudioReady] = useState(false)

  // Resolve through the active asset profile (CDN on non-localhost). If the
  // focused lap doesn't carry a video, the toggle button isn't rendered, but
  // we still guard here in case the focus changes mid-session.
  //
  // Three paths can be supplied per lap:
  //   - video_path        : the desktop variant (e.g. 720p High profile,
  //                         audio in-band)
  //   - video_path_mobile : optional decoder-friendly *video-only* variant
  //                         (baseline, no B-frames, lower res, no audio).
  //                         Mobile-only — having the audio track inside the
  //                         same MP4 forces a single media element to demux
  //                         A+V on one thread, which on mid-tier phones
  //                         pushes the decoder over budget.
  //   - audio_path_mobile : optional audio-only m4a delivered via WebAudio
  //                         (decoded once into an AudioBuffer, scheduled
  //                         via AudioBufferSourceNode). Decoded on its own
  //                         pipeline so it can't stall the video decoder.
  // Falls through to video_path on any device without the mobile variants
  // declared, so the schema stays backward-compatible.
  const useMobileVariants = IS_MOBILE && lap?.video_path_mobile
  const preferredPath = useMobileVariants ? lap.video_path_mobile : lap?.video_path
  const videoSrc = preferredPath ? assetUrl(preferredPath) : null
  // Separate audio is only meaningful when we're using the video-only mobile
  // variant. Desktop's video_path already has audio in-band on the same
  // <video> element.
  const audioSrc = (useMobileVariants && lap?.audio_path_mobile)
    ? assetUrl(lap.audio_path_mobile)
    : null
  const videoStartSec = Number(lap?.video_lap_start_sec ?? 0)

  // ----- WebAudio helpers (closures over the refs above) ----------------
  //
  // These imperative helpers wrap the AudioBufferSourceNode lifecycle. They
  // intentionally aren't useCallback-wrapped — the useEffects below depend
  // on the refs and explicit deps, not on these functions, so a stable
  // identity isn't needed.
  const ensureAudioCtx = () => {
    if (!audioCtxRef.current) {
      const Ctor = window.AudioContext || window.webkitAudioContext
      if (!Ctor) return null
      audioCtxRef.current = new Ctor()
      audioGainRef.current = audioCtxRef.current.createGain()
      audioGainRef.current.gain.value = muted ? 0 : 1
      audioGainRef.current.connect(audioCtxRef.current.destination)
    }
    return audioCtxRef.current
  }
  const stopAudio = () => {
    if (audioSourceRef.current) {
      try { audioSourceRef.current.stop() } catch {}
      try { audioSourceRef.current.disconnect() } catch {}
      audioSourceRef.current = null
    }
  }
  const startAudioAt = (offsetSec, rate) => {
    const ctx = audioCtxRef.current
    const buffer = audioBufferRef.current
    const gain = audioGainRef.current
    if (!ctx || !buffer || !gain) return
    stopAudio()
    const safeOffset = Math.max(0, Math.min(offsetSec, buffer.duration - 0.01))
    if (safeOffset >= buffer.duration) return
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.playbackRate.value = rate
    src.connect(gain)
    src.start(0, safeOffset)
    audioSourceRef.current = src
    audioStartCtxTimeRef.current = ctx.currentTime
    audioStartOffsetRef.current = safeOffset
  }
  const getAudioPosition = () => {
    const ctx = audioCtxRef.current
    const src = audioSourceRef.current
    if (!ctx || !src) return null
    const elapsedReal = ctx.currentTime - audioStartCtxTimeRef.current
    const elapsedAudio = elapsedReal * src.playbackRate.value
    return audioStartOffsetRef.current + elapsedAudio
  }

  // External-edit sync (paused only) — re-seeks the video to match a
  // user-driven currentTime change (scrubber drag, sector jump, lap focus
  // swap). Skipped during playback so the 15 Hz state tick doesn't re-seek
  // every render. The watchdog handles drift during playback. Audio doesn't
  // need a seek here because it's stopped while paused; the next play()
  // schedules from the live playhead.
  useEffect(() => {
    if (playing) return
    const target = currentTime + videoStartSec
    const v = videoRef.current
    if (v && videoSrc && Math.abs(v.currentTime - target) > VIDEO_DRIFT_TOLERANCE_S) {
      try { v.currentTime = Math.max(0, target) } catch { /* before metadata loaded */ }
    }
  }, [currentTime, videoSrc, videoStartSec, playing])

  // Sector jump — reseek video, and if currently playing, restart the
  // audio source at the new offset.
  useEffect(() => {
    if (sectorStartTime == null) return
    const target = sectorStartTime + videoStartSec
    const v = videoRef.current
    if (v && videoSrc) { try { v.currentTime = Math.max(0, target) } catch {} }
    if (playing && speed <= 1.0 && audioSrc && audioReady) {
      startAudioAt(target, Math.min(speed, 1.0))
    }
  }, [sectorStartTime, videoSrc, audioSrc, audioReady, videoStartSec, playing, speed])

  // Play / pause + speed mirror.
  //
  // VIDEO: same as before — we mirror playing/speed onto the <video>
  // element, clamp playbackRate at 1.0, and pause when speed > 1×
  // (mobile decoders can't keep up; cars race ahead instead).
  //
  // AUDIO: WebAudio path. shouldPlay → start a fresh AudioBufferSourceNode
  // at the live playhead. shouldPlay false → stop the current source.
  // No <audio> element involved, so no decoder warmup, no pause/resume
  // click, no streaming buffer.
  //
  // Visibility is intentionally NOT a gate. The video element keeps its
  // decoder warm while CSS-hidden so the re-show is just a class change;
  // and stopping/restarting the audio source on every visibility flip
  // would re-introduce the click we're trying to avoid.
  useEffect(() => {
    const v = videoRef.current
    const rate = Math.min(speed, 1.0)
    const shouldPlay = playing && speed <= 1.0
    if (v && videoSrc) {
      v.playbackRate = rate
      if (shouldPlay) v.play().catch(() => {})
      else v.pause()
    }
    // Audio (WebAudio path)
    const ctx = audioCtxRef.current
    if (ctx && ctx.state === 'suspended' && shouldPlay) {
      // iOS unlock — needs a recent user gesture. The play button click
      // that flips ``playing`` to true counts; we resume here on the same
      // commit so the gesture token is still valid.
      ctx.resume().catch(() => {})
    }
    if (audioSrc && audioReady) {
      if (shouldPlay) {
        const offset = (currentTimeRef?.current ?? 0) + videoStartSec
        startAudioAt(offset, rate)
      } else {
        stopAudio()
      }
    }
  }, [playing, speed, videoSrc, audioSrc, audioReady, currentTimeRef, videoStartSec])

  // Periodic drift watchdog while playing.
  //
  // VIDEO chases the playhead (0.4 s tolerance) — the same loose tolerance
  // we used before. ~half a second is invisible while cars are moving.
  //
  // AUDIO chases the *video element* directly (0.2 s tolerance). With two
  // independent decoder pipelines, comparing each to the playhead can
  // allow up to 0.8 s of A/V offset; comparing audio to video bounds the
  // perceptual A/V drift directly. When audio falls out of sync we restart
  // the AudioBufferSourceNode at video's currentTime — instant under
  // WebAudio (no decoder warmup, no buffering).
  useEffect(() => {
    if (!playing || (!videoSrc && !audioSrc)) return undefined
    const id = setInterval(() => {
      const liveT = (currentTimeRef?.current ?? 0) + videoStartSec
      const v = videoRef.current
      if (v && videoSrc && Math.abs(v.currentTime - liveT) > 0.4) {
        try { v.currentTime = Math.max(0, liveT) } catch {}
      }
      const audioPos = getAudioPosition()
      if (audioPos != null) {
        if (v && videoSrc) {
          const drift = audioPos - v.currentTime
          if (Math.abs(drift) > 0.2) {
            startAudioAt(v.currentTime, Math.min(speed, 1.0))
          }
        } else if (Math.abs(audioPos - liveT) > 0.4) {
          startAudioAt(liveT, Math.min(speed, 1.0))
        }
      }
    }, 500)
    return () => clearInterval(id)
  }, [playing, videoSrc, audioSrc, currentTimeRef, videoStartSec, speed])

  // Mute toggle. WebAudio uses the gain node (no element-level mute); the
  // <video> element gets muted={true} when we're using the WebAudio path
  // (its file has no audio track anyway). Desktop case (no audioSrc) keeps
  // using the <video>'s built-in muted attribute via the videoMuted local.
  useEffect(() => {
    if (audioGainRef.current) {
      audioGainRef.current.gain.value = muted ? 0 : 1
    }
  }, [muted])

  // Reset status when source changes (e.g. focus lap swap).
  useEffect(() => {
    setStatus('loading')
    setError(null)
  }, [videoSrc])

  // Load + decode the audio file once per audioSrc. Decoded PCM lives in
  // the AudioBuffer (~20 MB for a 2-minute lap at 48 kHz stereo) and is
  // reused for the entire lap. The decode happens once, off the main path,
  // so playback start is instant.
  useEffect(() => {
    if (!audioSrc) {
      audioBufferRef.current = null
      setAudioReady(false)
      return undefined
    }
    let cancelled = false
    const ctx = ensureAudioCtx()
    if (!ctx) {
      // No WebAudio support — silent fallback.
      return undefined
    }
    fetch(audioSrc, { credentials: 'omit' })
      .then((r) => {
        if (!r.ok) throw new Error(`audio fetch ${r.status}`)
        return r.arrayBuffer()
      })
      .then((buf) => ctx.decodeAudioData(buf))
      .then((decoded) => {
        if (cancelled) return
        audioBufferRef.current = decoded
        setAudioReady(true)
      })
      .catch((e) => {
        console.warn('Audio decode failed', e)
        if (!cancelled) setAudioReady(false)
      })
    return () => {
      cancelled = true
      stopAudio()
      audioBufferRef.current = null
      setAudioReady(false)
    }
  }, [audioSrc])

  // Cleanup AudioContext on unmount. (Source change re-decodes into the
  // existing context; we only tear down on full unmount.)
  useEffect(() => {
    return () => {
      stopAudio()
      if (audioCtxRef.current) {
        try { audioCtxRef.current.close() } catch {}
        audioCtxRef.current = null
        audioGainRef.current = null
      }
    }
  }, [])

  // We intentionally do NOT early-return on !visible — that would unmount
  // the <video> element and force a cold restart on the next show (fresh
  // element at currentTime=0, watchdog seeks to playhead in a not-yet-
  // buffered region → visible choppy). Instead we keep it mounted and
  // toggle wrapper visibility via CSS.
  if (!videoSrc) return null
  // When the mobile variant is in use the video MP4 has no audio track —
  // muting the <video> is a no-op. The WebAudio gain node handles muting.
  // On desktop (no audio_path_mobile) the <video>'s in-band audio is what
  // the mute attribute controls, same as before.
  const videoMuted = audioSrc ? true : muted
  return (
    <div className={`video-overlay video-overlay-${size}${visible ? '' : ' video-overlay-hidden'}`}>
      <video
        ref={videoRef}
        src={videoSrc}
        muted={videoMuted}
        playsInline
        // ``metadata`` fetches just the moov atom + a few keyframes so the
        // overlay can render the first frame and seek without pulling all
        // ~150 MB on page load. Requires the source MP4 to have its moov
        // atom at the file start (``-movflags +faststart``); without that,
        // setting metadata is a lie — Chrome / Safari still fetch the whole
        // file before any seek. See README "Lap video overlay".
        preload="metadata"
        className="video-overlay-element"
        onLoadedMetadata={() => setStatus('ready')}
        onCanPlay={() => setStatus('ready')}
        onWaiting={() => setStatus('loading')}
        onSeeking={() => setStatus('seeking')}
        onSeeked={() => setStatus('ready')}
        onError={() => { setError('Video failed to load'); setStatus('error') }}
      />
      {/* Audio for the mobile path is handled by WebAudio, not an <audio>
          element — see the load/decode + start/stop useEffects above. */}
      {(status === 'loading' || status === 'seeking') && !error && (
        <div className="video-overlay-spinner" aria-label={status}>
          <div className="video-overlay-spinner-dot" />
        </div>
      )}
      {error && <div className="video-overlay-error">{error}</div>}
      <div className="video-overlay-controls">
        <button onClick={() => setMuted(m => !m)} title={muted ? 'Unmute' : 'Mute'}>
          {muted ? '🔇' : '🔊'}
        </button>
        <button onClick={() => setSize(s => s === 'normal' ? 'large' : 'normal')} title={size === 'normal' ? 'Enlarge' : 'Shrink'} aria-label={size === 'normal' ? 'Enlarge video' : 'Shrink video'}>
          {/* Plus / minus are universally supported and the meaning is
              obvious. ⤢ / ⛶ render as fallback boxes on a number of
              mobile platforms. */}
          {size === 'normal' ? '+' : '−'}
        </button>
        <button onClick={onClose} title="Hide video">{'✕'}</button>
      </div>
      {lap?.video_label && <div className="video-overlay-label">{lap.video_label}</div>}
    </div>
  )
}


/**
 * Mobile-only telemetry cards anchored to the top of the screen. Two compact cards
 * side-by-side, each outlined in its lap's color (e.g. cyan for ref / red for ghost).
 * Hidden on desktop — the 3D Html cards above each car are used there instead.
 */
function MobileTelemetryCards({ laps, telemetryData, currentTime, lapTimeOffset, visibility, show }) {
  if (!show || !laps.length) return null
  return (
    <div className="mobile-telemetry-cards">
      {laps.slice(0, 2).map((lap, idx) => {
        if (!(visibility[lap.id] ?? true)) return null
        const tel = telemetryData[lap.id]
        if (!tel) return null
        const t = currentTime + (idx > 0 ? lapTimeOffset : 0)
        const s = sampleTelemetry(tel.samples, t)
        if (!s) return null
        const isBraking = s.fbp > 10
        const isThrottle = s.tps > 200 && !isBraking
        const phase = isBraking ? 'hud-braking' : isThrottle ? 'hud-throttle' : 'hud-coast'
        return (
          <div key={lap.id} className={`mobile-tel-card ${phase}`} style={{ borderColor: lap.color, '--accent': lap.color }}>
            <div className="mobile-tel-card-header" style={{ background: lap.color }} />
            <div className="hud-bar-row">
              <span className="hud-bar-label">TPS</span>
              <div className="hud-bar"><div className="hud-bar-fill hud-bar-tps" style={{ width: `${(s.tps / 255) * 100}%` }} /></div>
            </div>
            <div className="hud-bar-row">
              <span className="hud-bar-label">BRK</span>
              <div className="hud-bar"><div className="hud-bar-fill hud-bar-brake" style={{ width: `${Math.min(s.fbp / 150 * 100, 100)}%` }} /></div>
            </div>
            <div className="hud-rpm">{Math.round(s.rpm)} RPM</div>
          </div>
        )
      })}
    </div>
  )
}


export default function App() {
  const [manifest, setManifest] = useState(null)
  const [laps, setLaps] = useState([])
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  // Dual-clock setup. See `hooks/usePlayback.js` for rationale.
  // * `currentTimeRef` — authoritative clock, updated every RAF frame; read by
  //   the 3D hot path (CarEntity / CameraRig useFrame) at display FPS.
  // * `currentTime`    — React state, updated at ~15 Hz only; read by UI
  //   widgets (scrubber label, chart playheads, HUD numerics) that don't need
  //   per-frame precision.
  // The wrapper `setCurrentTime` writes both synchronously so external edits
  // (scrubber drag, sector jump) reach the hot path immediately.
  const currentTimeRef = useRef(0.01)
  const [currentTime, _setCurrentTimeState] = useState(0.01)
  const setCurrentTime = useCallback((v) => {
    const next = typeof v === 'function' ? v(currentTimeRef.current) : v
    currentTimeRef.current = next
    _setCurrentTimeState(next)
  }, [])
  const [lapTimeOffset, setLapTimeOffset] = useState(0) // offset for lap2 to align at sector start
  const [_sectorEndUnused] = useState(null) // preserve hook count for HMR
  const sectorEndRef = useRef(null)
  const [sectorStartTime, setSectorStartTime] = useState(null)
  const [selectedSector, setSelectedSector] = useState(null)
  // Default camera: free orbit on the regular routes, chase on /video so the
  // car is centred in the (lifted) viewport from the moment the page loads.
  // On /video any other default would force the user to immediately switch
  // modes — the PIP overlay only makes sense relative to a chase / hood /
  // side / top view of the car the lap is recorded from.
  const [cameraMode, setCameraMode] = useState(() =>
    (typeof window !== 'undefined' && window.location?.pathname === '/video') ? 'chase' : 'free'
  )
  const [focusLapId, setFocusLapId] = useState(null)
  const [visibility, setVisibility] = useState({})
  const [syncOffsets, setSyncOffsets] = useState({})
  const [telemetryData, setTelemetryData] = useState({})
  const [recording, setRecording] = useState(false)
  const recorderRef = useRef(null)
  const chunksRef = useRef([])
  // Mobile UI state
  const [showCarHuds, setShowCarHuds] = useState(true)
  const [mobileDrawer, setMobileDrawer] = useState(null) // null | 'menu' | 'map'

  // Comparison mode.
  //  'time'     — both cars driven by same clock (original behaviour).
  //  'position' — ghost's clock is derived from ref's current scene position:
  //               for each frame, find the ghost sample whose final (x,z)
  //               is closest to the ref's current (x,z) and use that sample's
  //               time. Cars overlap on the track; the delta HUD shows how
  //               many seconds behind/ahead the ghost was at that spot.
  const [compareMode, setCompareMode] = useState('time')

  // Corner analysis mode. When on, a <CornerMarkers> overlay appears on the
  // 3D track showing brake start / end, throttle-on and full-throttle
  // key-points for both laps, and a side panel lists per-corner meter deltas
  // and oscillation counts. See utils/cornerAnalysis.js.
  const [cornerAnalysisMode, setCornerAnalysisMode] = useState(false)

  // Lap video overlay — only relevant on the /video route. Auto-on when the
  // manifest carries ``video_path`` for at least one lap; user can hide / re-
  // open via the toolbar button. Off-route this state and the toggle button
  // are inert (the gating condition ``laps.some(l => l.video_path)`` is false).
  const [videoOverlayOn, setVideoOverlayOn] = useState(true)

  // Cycle helpers for mobile shortcut buttons (iterate through the same options
  // offered by the dropdowns inside the side-menu drawer).
  const CAMERA_MODES = ['chase', 'hood', 'side', 'top', 'free']
  const CAMERA_LABELS = { chase: 'CHS', hood: 'HOOD', side: 'SIDE', top: 'TOP', free: 'FREE' }
  const SPEED_OPTIONS = [0.25, 0.5, 1, 2]
  const cycleCamera = () => {
    const i = CAMERA_MODES.indexOf(cameraMode)
    setCameraMode(CAMERA_MODES[(i + 1) % CAMERA_MODES.length])
  }
  const cycleSpeed = () => {
    const i = SPEED_OPTIONS.indexOf(speed)
    setSpeed(SPEED_OPTIONS[(i + 1) % SPEED_OPTIONS.length])
  }

  useEffect(() => {
    async function loadAssets() {
      // URL-based manifest routing:
      //   /                    → main comparison (manifest.json)
      //   /slow-and-slower     → UM vs RaceBox race-off (manifest_slow_and_slower.json)
      //   /um-racebox          → same-session UM982/RaceBox start-matched comparison
      // New routes can be added to this map without installing react-router.
      const routeManifests = {
        '/um-racebox': '/assets/laps/manifest_um_racebox.json',
        '/slow-and-slower': '/assets/laps/manifest_slow_and_slower.json',
        '/slow-vs-master': '/assets/laps/manifest_slow_vs_master.json',
        '/video': '/assets/laps/manifest_video.json',
      }
      const manifestPath = routeManifests[window.location.pathname] || '/assets/laps/manifest.json'
      const manifestResponse = await fetch(assetUrl(manifestPath))
      const manifestJson = await manifestResponse.json()
      // Optional load-time map-fit upgrade. The production lap JSONs can be
      // baked with an older rigid fit plus manual sync offsets; route manifests
      // may carry per-lap deltas that move those baked samples into the latest
      // video-adjusted A1 placement. Falls back to a manifest-level field for
      // forward compatibility.
      const consensusDeltaFor = (lapInfo) => lapInfo.consensus_delta || manifestJson.consensus_delta
      const lapPayloads = await Promise.all(
        manifestJson.laps.map(async (lapInfo) => {
          const lapResponse = await fetch(assetUrl(lapInfo.path))
          const lapJson = await lapResponse.json()
          const lapDelta = consensusDeltaFor(lapInfo)
          if (lapDelta && lapJson.samples) {
            applyConsensusDelta(lapJson.samples, lapDelta)
          }
          return { ...lapInfo, ...lapJson }
        }),
      )
      setManifest(manifestJson)
      setLaps(lapPayloads)
      setFocusLapId(lapPayloads[0]?.id ?? null)
      setVisibility(Object.fromEntries(lapPayloads.map((lap) => [lap.id, true])))
      setSyncOffsets(Object.fromEntries(lapPayloads.map((lap) => {
        // Compensate for baked-in heading correction by applying inverse yaw
        const headingCorrection = lap.sync?.car_heading_left_correction_deg ?? 0
        return [lap.id, { forward: 0, left: 0, up: 0, yaw: -headingCorrection }]
      })))

      // Load telemetry data
      const telemetry = {}
      for (const lapInfo of manifestJson.laps) {
        if (lapInfo.telemetry_path) {
          try {
            const resp = await fetch(assetUrl(lapInfo.telemetry_path))
            if (resp.ok) {
              const telemetryJson = await resp.json()
              telemetry[lapInfo.id] = telemetryJson
            }
          } catch (e) { /* telemetry optional */ }
        }
      }
      setTelemetryData(telemetry)
    }
    loadAssets().catch(console.error)
  }, [])

  const duration = useMemo(() => laps.length ? Math.max(...laps.map((l) => l.duration)) : 0, [laps])

  usePlayback({ playing, speed, duration, currentTimeRef, setCurrentTime, setPlaying, sectorEndRef })

  const deltaData = useMemo(() => computeLapDelta(laps, telemetryData), [laps, telemetryData])

  // Corner analysis — lifted to the App level so both the Viewer (3D markers)
  // and the side-panel overlay below can share one memoised result.
  const cornerData = useMemo(() => {
    if (!cornerAnalysisMode) return null
    const refLap = laps[0]
    const ghostLap = laps[1]
    const refCorners = refLap ? computeCornerAnalysis(refLap, telemetryData[refLap.id], syncOffsets[refLap.id]) : []
    const ghostCorners = ghostLap ? computeCornerAnalysis(ghostLap, telemetryData[ghostLap.id], syncOffsets[ghostLap.id]) : []
    const pairs = pairCorners(refCorners, ghostCorners)
    const sectorsWithArc = deltaData?.sectors && refLap
      ? addSectorArcLengths(deltaData.sectors.map((s) => ({ ...s })), refLap)
      : []
    return { refCorners, ghostCorners, pairs, sectorsWithArc }
  }, [cornerAnalysisMode, laps, telemetryData, syncOffsets, deltaData])

  const toggleLap = (lapId) => setVisibility((s) => ({ ...s, [lapId]: !s[lapId] }))
  const handleSyncChange = useCallback((lapId, offset) => setSyncOffsets((prev) => ({ ...prev, [lapId]: offset })), [])
  // Bumped whenever a sector click should trigger a one-shot camera reposition.
  // The CameraRig reads this via ref and snaps the camera behind the car on its
  // next frame, regardless of the current camera mode (including free).
  const cameraSnapRequestRef = useRef(0)

  const handleSectorClick = useCallback((sector) => {
    setCurrentTime(sector.t1Start)
    setLapTimeOffset(sector.t2Start - sector.t1Start)
    setPlaying(false)
    setSectorStartTime(sector.t1Start)
    setSelectedSector(sector.number)
    // One-shot: ask the camera rig to snap behind the car next frame, without
    // changing the camera mode. In free mode this also updates OrbitControls.
    cameraSnapRequestRef.current += 1
    const sectors = deltaData?.sectors
    if (sectors) {
      const nextSector = sectors.find(s => s.number === sector.number + 1)
      sectorEndRef.current = nextSector ? nextSector.t1Start : null
    }
  }, [deltaData])

  const toggleRecording = useCallback(() => {
    if (recording) {
      recorderRef.current?.stop()
      return
    }
    const canvas = document.querySelector('.viewer-shell canvas')
    if (!canvas) return
    const stream = canvas.captureStream(30)
    const recorder = new MediaRecorder(stream, {
      mimeType: MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm',
      videoBitsPerSecond: 8_000_000,
    })
    chunksRef.current = []
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `lap-recording-${Date.now()}.webm`
      a.click()
      URL.revokeObjectURL(url)
      setRecording(false)
    }
    recorderRef.current = recorder
    recorder.start()
    setRecording(true)
  }, [recording])

  const sessionGroups = useMemo(() => groupLapsBySession(laps), [laps])
  const warnings = useMemo(() => getRefWarnings(laps, visibility), [laps, visibility])
  const focusTelemetry = telemetryData[focusLapId]

  if (!manifest) return <div className="app-shell"><div className="loading">Loading assets...</div></div>

  return (
    <div className={`app-shell ${mobileDrawer ? `drawer-${mobileDrawer}-open` : ''}`}>
      {/* Mobile toolbar — only visible on small screens (CSS-gated). */}
      <div className="mobile-toolbar">
        <button className="mtb-btn" aria-label="Menu" onClick={() => setMobileDrawer(d => d === 'menu' ? null : 'menu')}>{'\u2630'}</button>
        <button className="mtb-btn" aria-label={playing ? 'Pause' : 'Play'} onClick={() => setPlaying(v => !v)}>{playing ? '\u23F8' : '\u25B6'}</button>
        <button className="mtb-btn mtb-btn-text" aria-label={`Speed ${speed}x — tap to cycle`} onClick={cycleSpeed}>{speed}x</button>
        <button className="mtb-btn mtb-btn-text" aria-label={`Camera ${cameraMode} — tap to cycle`} onClick={cycleCamera}>{CAMERA_LABELS[cameraMode] || cameraMode.toUpperCase().slice(0, 4)}</button>
        <button className="mtb-btn mtb-btn-text" aria-label={`Compare by ${compareMode} — tap to toggle`} onClick={() => setCompareMode(m => m === 'time' ? 'position' : 'time')}>{compareMode === 'time' ? 'T' : 'P'}</button>
        <button className={`mtb-btn mtb-btn-text ${cornerAnalysisMode ? 'mtb-btn-active' : ''}`} aria-label="Corner analysis" onClick={() => setCornerAnalysisMode(v => !v)}>{'\u25CE'}</button>
        {laps.some(l => l.video_path) && (
          <button className={`mtb-btn ${videoOverlayOn ? 'mtb-btn-active' : ''}`} aria-label="Lap video" onClick={() => setVideoOverlayOn(v => !v)}>{'\uD83C\uDFA5'}</button>
        )}
        <button className="mtb-btn" aria-label="Map" onClick={() => setMobileDrawer(d => d === 'map' ? null : 'map')}>{'\uD83D\uDDFA'}</button>
        <button className="mtb-btn" aria-label="Charts" onClick={() => setMobileDrawer(d => d === 'data' ? null : 'data')}>{'\uD83D\uDCC8'}</button>
        <button className={`mtb-btn ${showCarHuds ? 'mtb-btn-active' : ''}`} aria-label="Toggle car data" onClick={() => setShowCarHuds(v => !v)}>{'\uD83D\uDCCA'}</button>
      </div>

      {/* Mobile top-of-screen telemetry cards — shown on mobile only, toggled
          by the same 📊 button that also shows/hides the desktop car HUDs. */}
      <MobileTelemetryCards laps={laps} telemetryData={telemetryData} currentTime={currentTime}
        lapTimeOffset={lapTimeOffset} visibility={visibility} show={showCarHuds} />

      {/* Lap video overlay — only renders when the focused lap's manifest entry
          carries ``video_path`` (i.e. the /video route). PIP-style bottom-right
          on desktop; can be hidden / re-opened via the toolbar toggle. */}
      <VideoOverlay
        visible={videoOverlayOn}
        lap={laps.find(l => l.id === focusLapId) ?? laps[0]}
        currentTimeRef={currentTimeRef}
        currentTime={currentTime}
        playing={playing}
        speed={speed}
        sectorStartTime={sectorStartTime}
        onClose={() => setVideoOverlayOn(false)}
      />

      {/* Mobile scrubber overlay — always visible at bottom on mobile. */}
      <div className="mobile-scrubber">
        <div className="mobile-scrubber-time">{currentTime.toFixed(2)} / {duration.toFixed(2)}s</div>
        <input type="range" min={0} max={duration || 0} step={0.01}
          value={Math.min(currentTime, duration)}
          onChange={(e) => { setCurrentTime(Number(e.target.value)); setLapTimeOffset(0); sectorEndRef.current = null; setSelectedSector(null); setSectorStartTime(null) }} />
      </div>

      {/* Drawer backdrop — closes the active drawer on tap. */}
      {mobileDrawer && <div className="mobile-drawer-backdrop" onClick={() => setMobileDrawer(null)} />}

      <div className={`hud ${mobileDrawer === 'menu' ? 'hud-open' : ''}`}>
        <div className="hud-section">
          <h1>Virtualization Web POC</h1>
          <p>Track + M3 + lap playback with ghost comparisons and camera presets.</p>
        </div>

        <div className="hud-section controls-grid">
          <div className="controls-row">
            <button onClick={() => setPlaying((v) => !v)}>{playing ? 'Pause' : 'Play'}</button>
            <button className={`rec-btn ${recording ? 'rec-btn-active' : ''}`} onClick={toggleRecording}>
              {recording ? '\u25A0 Stop Rec' : '\u25CF Rec'}
            </button>
          </div>
          <label>Speed<select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
            <option value={0.25}>0.25x</option><option value={0.5}>0.5x</option><option value={1}>1x</option><option value={2}>2x</option>
          </select></label>
          <label>Camera<select value={cameraMode} onChange={(e) => setCameraMode(e.target.value)}>
            <option value="chase">Chase</option><option value="hood">Hood</option><option value="side">Side</option><option value="top">Top</option><option value="free">Free</option>
          </select></label>
          <label>Follow<select value={focusLapId ?? ''} onChange={(e) => setFocusLapId(e.target.value)}>
            {laps.map((lap) => <option key={lap.id} value={lap.id}>{lap.label}</option>)}
          </select></label>
          <label>Compare<select value={compareMode} onChange={(e) => setCompareMode(e.target.value)}>
            <option value="time">Time</option>
            <option value="position">Position</option>
          </select></label>
          <button
            className={cornerAnalysisMode ? 'active-toggle' : ''}
            onClick={() => setCornerAnalysisMode(v => !v)}
            aria-pressed={cornerAnalysisMode}
            title="Mark brake / throttle key-points on track + per-corner meter deltas"
          >
            {cornerAnalysisMode ? '\u25C9' : '\u25CE'} Corner analysis
          </button>
          {laps.some(l => l.video_path) && (
            <button
              className={videoOverlayOn ? 'active-toggle' : ''}
              onClick={() => setVideoOverlayOn(v => !v)}
              aria-pressed={videoOverlayOn}
              title="Show / hide synchronised lap video overlay"
            >
              {videoOverlayOn ? '\u25C9' : '\u25CE'} Lap video
            </button>
          )}
        </div>

        <div className="hud-section scrubber">
          <label>
            Time {currentTime.toFixed(2)} / {duration.toFixed(2)} s
            <input type="range" min={0} max={duration || 0} step={0.01} value={Math.min(currentTime, duration)} onChange={(e) => { setCurrentTime(Number(e.target.value)); setLapTimeOffset(0); sectorEndRef.current = null; setSelectedSector(null); setSectorStartTime(null) }} />
          </label>
        </div>

        {warnings.length > 0 && (
          <div className="hud-section warnings">
            {warnings.map((w) => <div key={w.lapId} className="warning-row">{w.message}</div>)}
          </div>
        )}

        {focusTelemetry && <GamificationStats telemetry={focusTelemetry} currentTime={currentTime} />}

        <div className="hud-section lap-list">
          {Array.from(sessionGroups.entries()).map(([sessionId, sessionLaps]) => (
            <div key={sessionId} className="session-group">
              <div className="session-header">Session {sessionId}</div>
              {sessionLaps.map((lap) => (
                <div key={lap.id} className="lap-entry">
                  <label className="lap-row">
                    <input type="checkbox" checked={visibility[lap.id] ?? true} onChange={() => toggleLap(lap.id)} />
                    <span className="lap-swatch" style={{ background: lap.color }} />
                    <span className="lap-info">
                      <span className="lap-name">{lap.label}</span>
                      <span className="lap-tags">
                        <span className="device-badge" style={{ borderColor: DEVICE_COLORS[lap.device_id] || '#888' }}>{(lap.device_id || '?').toUpperCase()}</span>
                        <span className="mode-badge">{MODE_LABELS[lap.mode] || lap.mode || '?'}</span>
                      </span>
                    </span>
                  </label>
                  {syncOffsets[lap.id] && <LapSyncControls lap={lap} syncOffset={syncOffsets[lap.id]} onSyncChange={handleSyncChange} />}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="viewer-shell">
        <Viewer
          manifest={manifest} laps={laps} currentTime={currentTime} currentTimeRef={currentTimeRef} cameraMode={cameraMode} compareMode={compareMode} cornerAnalysisMode={cornerAnalysisMode} cornerData={cornerData}
          focusLapId={focusLapId} visibility={visibility} syncOffsets={syncOffsets} telemetryData={telemetryData}
          lapTimeOffset={lapTimeOffset} deltaData={deltaData} sectorStartTime={sectorStartTime}
          cameraSnapRequestRef={cameraSnapRequestRef}
          showCarHuds={showCarHuds}
          liftViewForVideo={videoOverlayOn && laps.some(l => l.video_path)}
          hideDelta={!!manifest?.hide_delta}
        />
        <LoadingOverlay />
        {/* Map panel — interactive track map with sectors. Hidden on mobile unless
            the 'map' drawer is active; overlays the viewer on desktop. */}
        <div className={`map-panels ${mobileDrawer === 'map' ? 'map-panels-open' : ''}`}>
          <TrackMap deltaData={deltaData} currentTime={currentTime} duration={duration} laps={laps} onSectorClick={handleSectorClick} />
        </div>
        {/* Data panels — telemetry traces + lap delta chart. Separate mobile drawer.
            On routes where the manifest sets ``hide_delta`` (e.g. /um-racebox,
            where both laps are the same physical drive recorded by two devices
            and a time delta would be misleading), the chart is suppressed. */}
        <div className={`data-panels ${mobileDrawer === 'data' ? 'data-panels-open' : ''}`}>
          <TelemetryPanel telemetry={focusTelemetry} currentTime={currentTime} duration={duration} />
          {!manifest?.hide_delta && (
            <DeltaChart deltaData={deltaData} currentTime={currentTime} duration={duration} laps={laps} />
          )}
        </div>
        {(() => {
          const sec = selectedSector != null && deltaData?.sectors?.find(s => s.number === selectedSector)
          if (!sec?.tips?.length) return null
          return (
            <div className="sector-tips-panel">
              <div className="sector-tips-header">S{sec.number} Engineer Notes</div>
              {sec.tips.map((tip, i) => (
                <div key={i} className="sector-tip">
                  <span className="sector-tip-icon">{tip.icon}</span>
                  <span className="sector-tip-text">{tip.text}</span>
                </div>
              ))}
            </div>
          )
        })()}
        {cornerAnalysisMode && cornerData && <CornerAnalysisPanel cornerData={cornerData} laps={laps} />}
      </div>
    </div>
  )
}
