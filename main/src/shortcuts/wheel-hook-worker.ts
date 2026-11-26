// Runs in a dedicated worker thread (bundled to dist/wheel-hook.js), Windows only.
//
// Installs a low-level mouse hook (WH_MOUSE_LL) that swallows vertical mouse wheel
// events while the game window is active and replaces each one with a left click.
// uiohook-napi can't do this: it delivers events to JS asynchronously, after its own
// hook already passed them on, and it can't synthesize mouse input.
//
// Windows silently removes a low-level hook whose callback takes longer than
// LowLevelHooksTimeout (~1s), so the callback must stay trivial. Clicks are sent
// from the message pump, outside the callback.

import { parentPort, workerData } from 'node:worker_threads'
import * as koffi from 'koffi'
import { WheelHookFlag, type WheelHookWorkerData, type WheelHookMessage } from './wheel-hook-protocol'

const WH_MOUSE_LL = 14
const WM_MOUSEWHEEL = 0x020A
const LLMHF_INJECTED = 0x01
const QS_ALLINPUT = 0x04FF
const PM_REMOVE = 0x0001
const INPUT_MOUSE = 0
const MOUSEEVENTF_LEFTDOWN = 0x0002
const MOUSEEVENTF_LEFTUP = 0x0004
const PUMP_TIMEOUT_MS = 100

const POINT = koffi.struct('POINT', {
  x: 'int32',
  y: 'int32'
})

const MSLLHOOKSTRUCT = koffi.struct('MSLLHOOKSTRUCT', {
  pt: POINT,
  mouseData: 'uint32',
  flags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr'
})

const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
  dx: 'int32',
  dy: 'int32',
  mouseData: 'uint32',
  dwFlags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr'
})

// The real INPUT is { type; union { MOUSEINPUT; KEYBDINPUT; HARDWAREINPUT } }.
// MOUSEINPUT is the largest union member, so this has the same size and layout.
const INPUT = koffi.struct('INPUT', {
  type: 'uint32',
  mi: MOUSEINPUT
})

const LowLevelMouseProc = koffi.proto(
  'intptr __stdcall LowLevelMouseProc(int nCode, uintptr wParam, void *lParam)'
)

const user32 = koffi.load('user32.dll')
const kernel32 = koffi.load('kernel32.dll')

const SetWindowsHookExW = user32.func('void * __stdcall SetWindowsHookExW(int idHook, LowLevelMouseProc *lpfn, void *hmod, uint32 dwThreadId)')
const UnhookWindowsHookEx = user32.func('int __stdcall UnhookWindowsHookEx(void *hhk)')
const CallNextHookEx = user32.func('intptr __stdcall CallNextHookEx(void *hhk, int nCode, uintptr wParam, void *lParam)')
const MsgWaitForMultipleObjects = user32.func('uint32 __stdcall MsgWaitForMultipleObjects(uint32 nCount, void *pHandles, int fWaitAll, uint32 dwMilliseconds, uint32 dwWakeMask)')
const PeekMessageW = user32.func('int __stdcall PeekMessageW(void *lpMsg, void *hWnd, uint32 wMsgFilterMin, uint32 wMsgFilterMax, uint32 wRemoveMsg)')
const SendInput = user32.func('uint32 __stdcall SendInput(uint32 cInputs, INPUT *pInputs, int cbSize)')
const GetModuleHandleW = kernel32.func('void * __stdcall GetModuleHandleW(void *lpModuleName)')

const INPUT_SIZE = koffi.sizeof(INPUT)
const LEFT_DOWN = { type: INPUT_MOUSE, mi: { dx: 0, dy: 0, mouseData: 0, dwFlags: MOUSEEVENTF_LEFTDOWN, time: 0, dwExtraInfo: 0 } }
const LEFT_UP = { type: INPUT_MOUSE, mi: { dx: 0, dy: 0, mouseData: 0, dwFlags: MOUSEEVENTF_LEFTUP, time: 0, dwExtraInfo: 0 } }

const { flags } = workerData as WheelHookWorkerData
let pendingClicks = 0

function onMouseEvent (nCode: number, wParam: number | bigint, lParam: unknown): number | bigint {
  if (
    nCode >= 0 &&
    Number(wParam) === WM_MOUSEWHEEL &&
    Atomics.load(flags, WheelHookFlag.GameActive) === 1
  ) {
    const info = koffi.decode(lParam, MSLLHOOKSTRUCT) as { flags: number }
    // leave wheel events injected by other software (macros, mouse drivers) alone
    if ((info.flags & LLMHF_INJECTED) === 0) {
      pendingClicks += 1
      return 1 // swallow: neither the game nor later hooks see this scroll
    }
  }
  return CallNextHookEx(null, nCode, wParam, lParam)
}

function sendPendingClicks () {
  while (pendingClicks > 0) {
    pendingClicks -= 1
    SendInput(1, LEFT_DOWN, INPUT_SIZE)
    SendInput(1, LEFT_UP, INPUT_SIZE)
  }
}

function run () {
  const callback = koffi.register(onMouseEvent, koffi.pointer(LowLevelMouseProc))
  const hook = SetWindowsHookExW(WH_MOUSE_LL, callback, GetModuleHandleW(null), 0)
  if (!hook) {
    koffi.unregister(callback)
    post({ type: 'error', message: 'SetWindowsHookExW failed' })
    return
  }
  post({ type: 'installed' })

  // Low-level hook callbacks are delivered to this thread while it pumps messages
  // (inside PeekMessageW). MsgWaitForMultipleObjects wakes up as soon as one is pending.
  const msg = Buffer.alloc(64) // >= sizeof(MSG) on x64 (48)
  try {
    while (Atomics.load(flags, WheelHookFlag.Stop) === 0) {
      MsgWaitForMultipleObjects(0, null, 0, PUMP_TIMEOUT_MS, QS_ALLINPUT)
      while (PeekMessageW(msg, null, 0, 0, PM_REMOVE)) {
        // this thread owns no windows, so there is nothing to dispatch
      }
      sendPendingClicks()
    }
  } finally {
    UnhookWindowsHookEx(hook)
    koffi.unregister(callback)
  }
}

function post (msg: WheelHookMessage) {
  parentPort!.postMessage(msg)
}

try {
  run()
} catch (err) {
  post({ type: 'error', message: String(err) })
}
