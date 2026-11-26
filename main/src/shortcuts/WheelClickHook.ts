import { Worker } from 'node:worker_threads'
import type { Logger } from '../RemoteLogger'
import type { GameWindow } from '../windowing/GameWindow'
import { WheelHookFlag, type WheelHookMessage, type WheelHookWorkerData } from './wheel-hook-protocol'

/**
 * "Mouse wheel sends left click": while enabled and the game window is active,
 * each vertical wheel notch is swallowed and replaced by a left click.
 * Windows only; the hook itself lives in wheel-hook-worker.ts.
 */
export class WheelClickHook {
  private worker: Worker | null = null
  private flags: Int32Array | null = null

  constructor (
    private logger: Logger,
    private poeWindow: GameWindow
  ) {
    this.poeWindow.on('active-change', (isActive) => {
      if (this.flags) {
        Atomics.store(this.flags, WheelHookFlag.GameActive, isActive ? 1 : 0)
      }
    })
  }

  get isEnabled () {
    return this.worker != null
  }

  setEnabled (enabled: boolean) {
    if (process.platform !== 'win32') return
    if (enabled && !this.worker) {
      this.start()
    } else if (!enabled && this.worker) {
      this.stop()
    }
  }

  private start () {
    const flags = new Int32Array(new SharedArrayBuffer(WheelHookFlag._length * Int32Array.BYTES_PER_ELEMENT))
    Atomics.store(flags, WheelHookFlag.GameActive, this.poeWindow.isActive ? 1 : 0)

    const workerData: WheelHookWorkerData = { flags }
    const worker = new Worker(__dirname + '/wheel-hook.js', { workerData })
    worker.on('message', (msg: WheelHookMessage) => {
      if (msg.type === 'installed') {
        this.logger.write('info [WheelClick] Mouse hook installed.')
      } else {
        this.logger.write(`error [WheelClick] ${msg.message}`)
      }
    })
    worker.on('error', (err) => {
      this.logger.write(`error [WheelClick] ${String(err)}`)
    })
    worker.on('exit', () => {
      if (this.worker === worker) {
        this.worker = null
        this.flags = null
      }
      this.logger.write('info [WheelClick] Mouse hook removed.')
    })

    this.worker = worker
    this.flags = flags
  }

  private stop () {
    // the worker is blocked in its native message pump, so it can't receive
    // postMessage; it polls this flag at least every 100ms and exits on its own
    Atomics.store(this.flags!, WheelHookFlag.Stop, 1)
    this.worker = null
    this.flags = null
  }
}
