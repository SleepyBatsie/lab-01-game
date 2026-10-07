import { createInput } from "./input.js";
import { createLoop } from "./loop.js";
import { createShip, integrate } from "./physics.js";
import { interpolateState, render, setupCanvas } from "./renderer.js";

const WIDTH = 800;
const HEIGHT = 600;

const canvas = document.getElementById("canvas");
const ctx = setupCanvas(canvas, WIDTH, HEIGHT);

const fpsEl = document.getElementById("fps");
const spsEl = document.getElementById("sps");
const frameTimeEl = document.getElementById("frame-time");

const input = createInput();

let currentState = createShip(WIDTH / 2, HEIGHT / 2);
let previousState = { ...currentState };

const loop = createLoop({
  update(dt) {
    previousState = { ...currentState };
    currentState = integrate(currentState, input, dt, WIDTH, HEIGHT);
  },
  render(alpha) {
    const interpolated = interpolateState(previousState, currentState, alpha);
    render(ctx, interpolated, WIDTH, HEIGHT);
  },
  hudUpdate(metrics) {
    fpsEl.textContent = metrics.fps;
    spsEl.textContent = metrics.sps;
    frameTimeEl.textContent = metrics.frameTime;
  },
});

loop.start();
