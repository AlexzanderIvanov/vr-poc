/**
 * Mocked session catalogue for the session-browser drawer.
 *
 * Stand-in for the eventual backend `GET /sessions` endpoint. Each
 * session bundles a track + car + date + multiple laps; each lap has
 * a stable `id` (the same shape the manifest already uses, so when
 * the backend lands the `id`s can match without remapping every
 * consumer) plus display metadata for the drawer (lap number, lap
 * time, flag — `best`, `red`, …).
 *
 * IDs that overlap the currently-loaded manifest (`um982_…_lap3`,
 * `um982_…_lap4`) are intentional — the drawer marks "in use" laps
 * with a checkmark, lets the user toggle their visibility, and
 * keeps the rest visible as a browse-only list until the real
 * backend wire-up can fetch on demand.
 */

export const MOCK_SESSIONS = [
  {
    id: 2952670682,
    name: 'BMW E46 330 — Free practice 1',
    track: 'A1 Motorpark',
    car: 'BMW E46 330',
    date: '2026-04-08 14:30',
    deviceId: 'um982',
    laps: [
      { id: 'um982_2952670682_out',  number: 'OUT', time: '5:31.029' },
      { id: 'um982_2952670682_lap1', number: 1, time: '2:09.413' },
      { id: 'um982_2952670682_lap2', number: 2, time: '2:03.565', flag: 'red' },
      { id: 'um982_2952670682_lap3', number: 3, time: '1:56.370', flag: 'best' },
      { id: 'um982_2952670682_lap4', number: 4, time: '2:03.380' },
      { id: 'um982_2952670682_lap5', number: 5, time: '2:07.785' },
      { id: 'um982_2952670682_in',   number: 'IN',  time: '4:02.701' },
    ],
  },
  {
    id: 2998794026,
    name: 'BMW E46 330 — Free practice 2',
    track: 'A1 Motorpark',
    car: 'BMW E46 330',
    date: '2026-04-08 15:45',
    deviceId: 'um982',
    laps: [
      { id: 'um982_2998794026_out',  number: 'OUT', time: '4:12.500' },
      { id: 'um982_2998794026_lap1', number: 1, time: '2:05.310' },
      { id: 'um982_2998794026_lap2', number: 2, time: '1:58.840' },
      { id: 'um982_2998794026_lap3', number: 3, time: '1:57.610' },
      { id: 'um982_2998794026_lap4', number: 4, time: '1:57.080', flag: 'best' },
      { id: 'um982_2998794026_lap5', number: 5, time: '1:58.220' },
    ],
  },
  {
    id: 3024156788,
    name: 'BMW E46 330 — Wet test',
    track: 'A1 Motorpark',
    car: 'BMW E46 330',
    date: '2026-04-09 09:15',
    deviceId: 'um982',
    laps: [
      { id: 'mock_3024156788_lap1', number: 1, time: '2:18.300' },
      { id: 'mock_3024156788_lap2', number: 2, time: '2:14.500' },
      { id: 'mock_3024156788_lap3', number: 3, time: '2:12.110' },
      { id: 'mock_3024156788_lap4', number: 4, time: '2:10.780', flag: 'best' },
    ],
  },
  {
    id: 3037281449,
    name: 'BMW E46 330 — Qualifying sim',
    track: 'A1 Motorpark',
    car: 'BMW E46 330',
    date: '2026-04-10 11:00',
    deviceId: 'racebox',
    laps: [
      { id: 'mock_3037281449_lap1', number: 1, time: '2:01.220' },
      { id: 'mock_3037281449_lap2', number: 2, time: '1:55.640', flag: 'best' },
      { id: 'mock_3037281449_lap3', number: 3, time: '1:56.330' },
    ],
  },
]
