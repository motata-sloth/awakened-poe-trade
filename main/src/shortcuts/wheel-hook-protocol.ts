// Shared between WheelClickHook (main thread) and wheel-hook-worker (worker thread).
// Keep this file free of side effects: importing the worker module itself would load user32.dll.

export interface WheelHookWorkerData {
  // Int32Array over a SharedArrayBuffer, indexed by WheelHookFlag
  flags: Int32Array
}

export const WheelHookFlag = {
  GameActive: 0,
  Stop: 1,
  _length: 2
} as const

export type WheelHookMessage =
  { type: 'installed' } |
  { type: 'error', message: string }
