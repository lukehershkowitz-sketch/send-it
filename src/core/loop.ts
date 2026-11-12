import { TUNING } from '../tuning';

/**
 * Fixed-step simulation with interpolated rendering.
 *   frame(dt)  — once per animation frame, real time (input polling, UI)
 *   step(dt)   — 0..n times per frame at TUNING.physics.stepHz, scaled by timeScale
 *   render(a)  — once per frame, a = interpolation alpha between last two sim states
 */
export class GameLoop {
  readonly stepDt = 1 / TUNING.physics.stepHz;
  timeScale = 1;
  paused = false;
  private acc = 0;
  private last = 0;
  private running = false;

  constructor(
    private frame: (realDt: number) => void,
    private step: (dt: number) => void,
    private render: (alpha: number, realDt: number) => void,
  ) {}

  start(): void {
    this.running = true;
    this.last = performance.now();
    requestAnimationFrame(this.tick);
  }

  private tick = (now: number) => {
    if (!this.running) return;
    const realDt = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    this.frame(realDt);
    if (!this.paused) {
      this.acc += realDt * this.timeScale;
      let n = 0;
      while (this.acc >= this.stepDt && n < 12) {
        this.step(this.stepDt);
        this.acc -= this.stepDt;
        n++;
      }
      if (n === 12) this.acc = 0;
    }
    this.render(this.acc / this.stepDt, realDt);
    requestAnimationFrame(this.tick);
  };
}
