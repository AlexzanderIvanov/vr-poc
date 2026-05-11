/**
 * Channel catalogue — declarative source of truth for what data channels
 * exist, their units/ranges, and which devices natively provide them.
 *
 * UI components consult `hasChannel(deviceId, channelId)` to decide whether
 * to render a channel-specific visualisation. The backend adapter consults
 * `DEVICE_CHANNELS` to know what to expose for each device class.
 *
 * Channel kinds:
 *   - `positional`  geometry / pose channels (position, quaternion, …)
 *   - `imu`         inertial channels (long-g, lat-g, gyro, …)
 *   - `vehicle`     CAN/ECU channels (throttle, brakes, RPM, steer, …)
 *
 * `derivable: true` means the channel can be computed from other channels
 * (typically positions). The mock backend currently derives the IMU and
 * GPS-speed channels from positional data; a future real backend may
 * provide them natively (e.g. from RaceBox's hardware IMU).
 */

export const CHANNEL_DEFS = {
  // ─── positional ────────────────────────────────────────────────────────
  position:   { kind: 'positional', shape: 'vec3', unit: 'm' },
  quaternion: { kind: 'positional', shape: 'vec4' },
  gps_speed:  { kind: 'positional', shape: 'scalar', unit: 'km/h', derivable: true },

  // ─── IMU ───────────────────────────────────────────────────────────────
  long_g: { kind: 'imu', shape: 'scalar', unit: 'g', signed: true,  derivable: true },
  lat_g:  { kind: 'imu', shape: 'scalar', unit: 'g', signed: true,  derivable: true },
  g_sum:  { kind: 'imu', shape: 'scalar', unit: 'g', signed: false, derivable: true },

  // ─── vehicle (CAN / ECU) ───────────────────────────────────────────────
  // Units are intrinsic to the channel: the data layer never converts
  // vehicle channels (they arrive in their raw AIM units from the
  // datalogger) so chart code can render them as-is. Anything that
  // displays a channel value should read its unit from `CHANNEL_DEFS`
  // rather than hardcode the suffix — keeps the unit consistent across
  // tooltips, axis labels, value readouts, and future printable reports.
  tps:   { kind: 'vehicle', shape: 'scalar', range: [0, 255],          unit: '' },     // raw AIM pedal position
  fbp:   { kind: 'vehicle', shape: 'scalar', range: [0, 150],          unit: 'bar' },  // front-brake pressure
  rbp:   { kind: 'vehicle', shape: 'scalar', range: [0, 150],          unit: 'bar' },  // rear-brake pressure
  rpm:   { kind: 'vehicle', shape: 'scalar', range: [0, 8000],         unit: 'rpm' },
  steer: { kind: 'vehicle', shape: 'scalar', range: [-250, 250],       unit: '°', signed: true },
}

/** Channels each device class natively provides or has derived for it. */
export const DEVICE_CHANNELS = {
  // AIM dataloggers (MXS, EVO5, MyChron, …) — vehicle telemetry
  aim:     ['tps', 'fbp', 'rbp', 'rpm', 'steer'],

  // RaceBox Mini / Mini S / Pro — GPS + IMU motion tracker
  racebox: ['position', 'quaternion', 'gps_speed', 'long_g', 'lat_g', 'g_sum'],

  // UM982 / UM981 — heading-capable RTK GNSS receivers (no IMU on-device,
  // g-forces are derived from positions in the data layer)
  um982:   ['position', 'quaternion', 'gps_speed', 'long_g', 'lat_g', 'g_sum'],
  um981:   ['position', 'quaternion', 'gps_speed', 'long_g', 'lat_g', 'g_sum'],
}

/** Returns true if the device is known to provide (or have derived) the channel. */
export function hasChannel(deviceId, channelId) {
  return DEVICE_CHANNELS[deviceId]?.includes(channelId) ?? false
}

/** Returns the list of channels available for a device id. */
export function listChannels(deviceId) {
  return DEVICE_CHANNELS[deviceId] ?? []
}

/** Returns all `vehicle`-kind channels — useful to gate brake/throttle UI. */
export function vehicleChannelsFor(deviceId) {
  return listChannels(deviceId).filter((c) => CHANNEL_DEFS[c]?.kind === 'vehicle')
}
